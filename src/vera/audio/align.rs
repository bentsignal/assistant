//! Puts Vera's playback and the microphone on one clock, so the echo
//! canceller gets, beside each 4 ms of microphone audio, the reference that
//! was playing just then.
//!
//! Both device streams stamp their audio on the same clock (WASAPI's QPC:
//! cpal's capture instants and its playback estimates). A [`Timeline`] maps
//! each stream's sample positions to that clock, smoothing the per-callback
//! jitter and following drift between the two devices' crystals. The
//! reference read for a microphone block captured at `t` is the playback at
//! `t + LOOKAHEAD`: the canceller needs the reference to lead its echo, and
//! that lead absorbs timestamps that overstate latency. Latency they don't
//! report (Bluetooth, USB buffering) only makes the echo later, which the
//! canceller's own delay estimator finds (up to about 500 ms).
//!
//! A read moves its cursor at most one sample per block toward where the
//! timestamps say it should be, so jitter never makes the reference jump
//! (which would make the canceller relearn); only an error past `RESYNC`
//! jumps it.

use std::collections::VecDeque;

use super::resample::Resampler;

/// The canceller's rate.
pub(crate) const RATE: u32 = 16_000;
/// The canceller's block: 4 ms.
pub(crate) const BLOCK: usize = 64;
/// How far the reference leads the microphone audio it is paired with.
pub(crate) const LOOKAHEAD_NS: f64 = 30e6;
/// A timeline further off than this from a new stamp starts over.
const TIMELINE_RESET_NS: f64 = 50e6;
/// How much of each stamp's error a timeline takes: ~200 ms smoothing at
/// 10 ms chunks.
const TIMELINE_GAIN: f64 = 0.05;
/// A read cursor further than this from its target jumps (16 kHz samples).
const RESYNC: i64 = 240;
/// Reference audio kept, in 16 kHz samples (2 s).
const KEEP: usize = 32_000;

/// A stream's sample positions on the shared clock (ns).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Timeline {
    rate: f64,
    anchor_pos: f64,
    anchor_ns: f64,
}

impl Timeline {
    pub(crate) fn new(rate: u32, pos: u64, ns: u64) -> Self {
        Self {
            rate: rate as f64,
            anchor_pos: pos as f64,
            anchor_ns: ns as f64,
        }
    }

    /// A chunk ending at sample `pos` was stamped `ns`. Returns false when
    /// the stamp was so far off that the timeline started over.
    pub(crate) fn observe(&mut self, pos: u64, ns: u64) -> bool {
        let error = ns as f64 - self.ns_at(pos as f64);
        if error.abs() > TIMELINE_RESET_NS {
            *self = Self::new(self.rate as u32, pos, ns);
            return false;
        }
        // Re-anchor at the newest position, moved part way to the stamp.
        self.anchor_ns = self.ns_at(pos as f64) + error * TIMELINE_GAIN;
        self.anchor_pos = pos as f64;
        true
    }

    pub(crate) fn ns_at(&self, pos: f64) -> f64 {
        self.anchor_ns + (pos - self.anchor_pos) / self.rate * 1e9
    }

    pub(crate) fn pos_at(&self, ns: f64) -> f64 {
        self.anchor_pos + (ns - self.anchor_ns) * self.rate / 1e9
    }
}

/// One stretch of playback: an output stream from open to close.
struct Session {
    device_rate: u32,
    resampler: Resampler,
    /// Device-rate positions on the clock.
    timeline: Timeline,
    device_pos: u64,
    /// 16 kHz reference and the duck gain each sample carried.
    ring: VecDeque<f32>,
    duck: VecDeque<f32>,
    /// 16 kHz index of `ring[0]`.
    ring_first: u64,
    /// The next 16 kHz index a read starts at.
    cursor: Option<i64>,
}

impl Session {
    fn ring_end(&self) -> u64 {
        self.ring_first + self.ring.len() as u64
    }

    fn ns_at_16k(&self, index: f64) -> f64 {
        self.timeline
            .ns_at(index * self.device_rate as f64 / RATE as f64)
    }

    fn index_at_ns(&self, ns: f64) -> f64 {
        self.timeline.pos_at(ns) * RATE as f64 / self.device_rate as f64
    }
}

/// Vera's playback as the canceller sees it.
#[derive(Default)]
pub(crate) struct Reference {
    session: Option<Session>,
    resyncs: u64,
}

impl Reference {
    /// A block the mixer rendered: mono `samples` at `device_rate` whose
    /// first plays at `playback_ns`, ducked by `duck`.
    pub(crate) fn push(&mut self, device_rate: u32, playback_ns: u64, samples: &[f32], duck: f32) {
        let fresh = self.session.as_ref().is_none_or(|session| {
            session.device_rate != device_rate
                || (session.timeline.ns_at(session.device_pos as f64) - playback_ns as f64).abs()
                    > 500e6
        });
        if fresh {
            self.session = Some(Session {
                device_rate,
                resampler: Resampler::new(device_rate, RATE),
                timeline: Timeline::new(device_rate, 0, playback_ns),
                device_pos: 0,
                ring: VecDeque::new(),
                duck: VecDeque::new(),
                ring_first: 0,
                cursor: None,
            });
        }
        let session = self.session.as_mut().expect("set above");
        let start = session.device_pos;
        session.device_pos += samples.len() as u64;
        // Stamp the chunk's end, as the capture side does.
        let end_ns = playback_ns + samples.len() as u64 * 1_000_000_000 / device_rate as u64;
        if start > 0 && !session.timeline.observe(session.device_pos, end_ns) {
            tracing::debug!("vera audio: playback clock jumped; reference timeline restarted");
        }
        let resampled = session.resampler.push(samples);
        session.duck.extend(std::iter::repeat_n(duck, resampled.len()));
        session.ring.extend(resampled);
        let excess = session.ring.len().saturating_sub(KEEP);
        session.ring.drain(..excess);
        session.duck.drain(..excess);
        session.ring_first += excess as u64;
    }

    /// The output stream closed: the reference is silence until the next.
    pub(crate) fn end_session(&mut self) {
        self.session = None;
    }

    /// Whether audio playing at `ns` is known: the ring reaches it, or no
    /// stream is open (silence).
    pub(crate) fn covers(&self, ns: f64) -> bool {
        self.session
            .as_ref()
            .is_none_or(|session| session.ns_at_16k(session.ring_end() as f64) >= ns)
    }

    /// Times the read cursor had to jump.
    pub(crate) fn resyncs(&self) -> u64 {
        self.resyncs
    }

    /// Fills `out` with the reference that played from `at_ns` on, and
    /// returns the duck gain it carried.
    pub(crate) fn read(&mut self, at_ns: f64, out: &mut [f32]) -> f32 {
        out.fill(0.0);
        let Some(session) = &mut self.session else {
            return 1.0;
        };
        let target = session.index_at_ns(at_ns).round() as i64;
        let cursor = match session.cursor {
            Some(cursor) if (target - cursor).abs() <= RESYNC => {
                // Slew toward the target one sample at a time.
                match target - cursor {
                    difference if difference >= 2 => cursor + 1,
                    difference if difference <= -2 => cursor - 1,
                    _ => cursor,
                }
            }
            previous => {
                if previous.is_some() {
                    self.resyncs += 1;
                    tracing::debug!(
                        off = previous.map(|cursor| target - cursor),
                        "vera audio: reference cursor resynced"
                    );
                }
                target
            }
        };
        session.cursor = Some(cursor + out.len() as i64);
        let mut duck_sum = 0.0;
        let mut duck_count = 0usize;
        for (offset, sample) in out.iter_mut().enumerate() {
            let index = cursor + offset as i64 - session.ring_first as i64;
            if index >= 0
                && let Some(&value) = session.ring.get(index as usize)
            {
                *sample = value;
                duck_sum += session.duck[index as usize];
                duck_count += 1;
            }
        }
        if duck_count == 0 {
            1.0
        } else {
            duck_sum / duck_count as f32
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_timeline_smooths_jitter_and_follows_drift() {
        // 48 kHz stamped every 10 ms with ±1 ms jitter, on a clock 100 ppm fast.
        let mut timeline = Timeline::new(48_000, 0, 0);
        let mut worst: f64 = 0.0;
        for chunk in 1..3_000u64 {
            let pos = chunk * 480;
            let truth = pos as f64 / 48_000.0 * 1e9 * (1.0 + 100e-6);
            let jitter = if chunk % 2 == 0 { 1e6 } else { -1e6 };
            assert!(timeline.observe(pos, (truth + jitter) as u64));
            if chunk > 500 {
                worst = worst.max((timeline.ns_at(pos as f64) - truth).abs());
            }
        }
        // Within 0.2 ms of the truth, jitter of 1 ms notwithstanding.
        assert!(worst < 0.2e6, "{worst}");
    }

    #[test]
    fn reads_follow_the_playback_clock_without_jumps() {
        let mut reference = Reference::default();
        // A 48 kHz ramp (seconds) so positions are recognizable after
        // resampling.
        for chunk in 0..200u64 {
            let samples: Vec<f32> = (0..480)
                .map(|n| (chunk * 480 + n) as f32 / 48_000.0)
                .collect();
            reference.push(48_000, 1_000_000_000 + chunk * 10_000_000, &samples, 1.0);
        }
        let mut out = vec![0.0; BLOCK];
        // At 1.5 s into playback the ramp reads ~1.5 (it counts seconds).
        reference.read(2_500_000_000.0, &mut out);
        assert!((out[0] - 1.5).abs() < 0.001, "{}", out[0]);
        let mut previous = out[BLOCK - 1];
        for block in 1..50u64 {
            reference.read(2_500_000_000.0 + block as f64 * 4e6, &mut out);
            let step = out[0] - previous;
            assert!((step - 1.0 / 16_000.0).abs() < 1e-5, "{step}");
            previous = out[BLOCK - 1];
        }
        assert_eq!(reference.resyncs(), 0);
        assert!(reference.covers(2_900_000_000.0));
        assert!(!reference.covers(3_100_000_000.0));
    }

    #[test]
    fn without_playback_the_reference_is_silence() {
        let mut reference = Reference::default();
        let mut out = vec![1.0; BLOCK];
        assert_eq!(reference.read(5e9, &mut out), 1.0);
        assert!(out.iter().all(|s| *s == 0.0));
        assert!(reference.covers(9e18));
    }
}
