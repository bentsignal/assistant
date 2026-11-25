//! Per-band near-end evidence on the echo canceller's linear output.
//!
//! Vera's echo in a band is bounded by her playback in that band over the
//! last 160 ms (the canceller's filter covers 128 ms; reverberation past it
//! is not cancelled and does not fall when she ducks), decaying after that
//! at 75 dB/s, slower than any ordinary room. So when Vera ducks, the bounds
//! hold for 160 ms and then fall, and the user, whose voice doesn't fall,
//! shows in more and more bands while Vera's own reverberation never can.
//!
//! Broadband, the user's voice can sit only a few dB over the residual of
//! Vera's: it is quieter than her echo at the microphone, and the residual
//! follows her level. Band by band it stands out much more, because at any
//! moment Vera's voice fills some bands and leaves others nearly empty, and
//! the user's different pitch and formants land in those. Every 8 ms this
//! compares 16 bands (150 Hz to 7 kHz) of the linear output with Vera's
//! reference in the same bands, delayed by the canceller's delay and
//! stretched by a reverberant decay, plus the leak each band has shown in
//! echo-only stretches. A small speaker's distortion also spreads Vera's
//! loudest syllables into bands her reference barely touches, so each band
//! also learns its leak against her total level. A frame is evidence of the
//! user when at least `MIN_BANDS` bands clear all three: their own leak,
//! the cross-band leak, and the band's noise floor.
//!
//! In the simulator this catches about 75% of the user's first 300 ms where
//! the broadband test caught 48%, with a third of the false alarms.

use std::collections::VecDeque;
use std::sync::Arc;

use realfft::num_complex::Complex32;
use realfft::{RealFftPlanner, RealToComplex};

use super::align::RATE;

const WINDOW: usize = 256;
const HOP: usize = 128;
const BANDS: usize = 14;
const LOW_HZ: f32 = 200.0;
const HIGH_HZ: f32 = 7_000.0;
/// No band narrower than this many FFT bins, so noise in it doesn't
/// fluctuate much.
const MIN_BINS: usize = 3;
/// Bands that must clear their bounds.
const MIN_BANDS: usize = 4;
/// Margin over the band's noise floor, and over its explained residual.
const FLOOR_MARGIN_DB: f32 = 10.0;
const MARGIN_DB: f32 = 6.0;
/// The reference envelope holds the loudest of the last 160 ms (20 frames),
/// then decays 0.6 dB a frame (75 dB/s, an RT60 of 0.8 s).
const HOLD_FRAMES: usize = 20;
const DECAY_DB: f32 = 0.6;
/// Each band's leak: the 90th percentile of the last 250 echo-only frames
/// (2 s), recomputed every 4 frames. Until 20 are in it is 20 dB, so a
/// cold canceller (the first half second Vera ever speaks) never reads as
/// the user.
const LEAK_HISTORY: usize = 250;
const LEAK_MIN: usize = 20;
const LEAK_INITIAL_DB: f32 = 20.0;
const LEAK_EVERY: u64 = 4;
/// Each band's noise floor: the 10th percentile of the last 2 s.
const FLOOR_HISTORY: usize = 250;
/// Reference audio kept for the delayed analysis (1 s).
const KEEP: usize = RATE as usize;
/// Frames a ratio waits before it is learned, so a user's onset that
/// hasn't triggered yet never teaches the leak.
const SETTLE_FRAMES: usize = 8;

/// One frame's verdict.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Frame {
    /// Bands that cleared their bounds.
    pub hits: usize,
}

impl Frame {
    pub(crate) fn user(&self) -> bool {
        self.hits >= MIN_BANDS
    }
}

pub(crate) struct Bands {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    ranges: Vec<std::ops::Range<usize>>,
    linear: VecDeque<f32>,
    reference: VecDeque<f32>,
    scratch: Vec<f32>,
    spectrum: Vec<Complex32>,
    envelope: [f32; BANDS],
    /// The last `HOLD_FRAMES` frames of reference band energies.
    held: VecDeque<[f32; BANDS]>,
    /// The previous frame's band energies, for two-frame smoothing.
    previous_linear: [f32; BANDS],
    previous_reference: [f32; BANDS],
    leak_history: Vec<VecDeque<f32>>,
    leak_db: [f32; BANDS],
    /// The leak against Vera's total level in all bands.
    cross_history: Vec<VecDeque<f32>>,
    cross_db: [f32; BANDS],
    floor_history: Vec<VecDeque<f32>>,
    floor_db: [f32; BANDS],
    /// Ratios (own band, cross-band) waiting to be learned.
    pending: VecDeque<([f32; BANDS], [f32; BANDS])>,
    /// The latest frame's ratios.
    last_ratios: ([f32; BANDS], [f32; BANDS]),
    frames: u64,
    since_frame: usize,
    latest: Frame,
}

impl Default for Bands {
    fn default() -> Self {
        Self::new()
    }
}

impl Bands {
    pub(crate) fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(WINDOW);
        let window = (0..WINDOW)
            .map(|n| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / WINDOW as f32).cos())
            .collect();
        let bin_hz = RATE as f32 / WINDOW as f32;
        let ratio = (HIGH_HZ / LOW_HZ).powf(1.0 / BANDS as f32);
        // Log-spaced, each at least `MIN_BINS` wide, ending at `HIGH_HZ`.
        let mut ranges = Vec::with_capacity(BANDS);
        let mut start = (LOW_HZ / bin_hz).round() as usize;
        let last = (HIGH_HZ / bin_hz).round() as usize;
        for band in 0..BANDS {
            let high = LOW_HZ * ratio.powi(band as i32 + 1);
            let end = ((high / bin_hz).round() as usize)
                .max(start + MIN_BINS)
                .min(last);
            ranges.push(start..end.max(start + 1));
            start = end;
        }
        Self {
            spectrum: fft.make_output_vec(),
            scratch: vec![0.0; WINDOW],
            fft,
            window,
            ranges,
            linear: VecDeque::new(),
            reference: VecDeque::new(),
            envelope: [0.0; BANDS],
            held: VecDeque::new(),
            previous_linear: [0.0; BANDS],
            previous_reference: [0.0; BANDS],
            leak_history: vec![VecDeque::new(); BANDS],
            leak_db: [LEAK_INITIAL_DB; BANDS],
            cross_history: vec![VecDeque::new(); BANDS],
            cross_db: [LEAK_INITIAL_DB; BANDS],
            floor_history: vec![VecDeque::new(); BANDS],
            floor_db: [-120.0; BANDS],
            pending: VecDeque::new(),
            last_ratios: ([f32::NAN; BANDS], [f32::NAN; BANDS]),
            frames: 0,
            since_frame: 0,
            latest: Frame::default(),
        }
    }

    pub(crate) fn latest(&self) -> Frame {
        self.latest
    }

    /// Takes one 4 ms block of the linear output and of the reference fed
    /// beside it; every `HOP` samples complete a frame, which is returned.
    /// `delay` is the canceller's delay in samples. `learn` says this frame
    /// may teach the leak (Vera alone in the room, as far as anyone knows).
    pub(crate) fn push(
        &mut self,
        linear: &[f32],
        reference: &[f32],
        delay: usize,
        learn: bool,
    ) -> Option<Frame> {
        self.linear.extend(linear);
        let excess = self.linear.len().saturating_sub(WINDOW);
        self.linear.drain(..excess);
        self.reference.extend(reference);
        let excess = self.reference.len().saturating_sub(KEEP);
        self.reference.drain(..excess);
        self.since_frame += linear.len();
        if self.since_frame < HOP {
            return None;
        }
        self.since_frame -= HOP;
        Some(self.frame(delay, learn))
    }

    /// Analyses a frame: the last `WINDOW` samples of the linear output
    /// against the reference `delay` samples earlier.
    fn frame(&mut self, delay: usize, learn: bool) -> Frame {
        self.frames += 1;
        if self.linear.len() < WINDOW {
            return Frame::default();
        }
        let now_linear = self.band_energies_of(true, 0);
        let reference_end = self
            .reference
            .len()
            .saturating_sub(delay.min(KEEP - WINDOW));
        let now_reference = if reference_end >= WINDOW {
            self.band_energies_of(false, self.reference.len() - reference_end)
        } else {
            [1e-12; BANDS]
        };
        let mut linear = [0.0f32; BANDS];
        let mut reference = [0.0f32; BANDS];
        for band in 0..BANDS {
            linear[band] = 0.5 * (now_linear[band] + self.previous_linear[band]);
            reference[band] = 0.5 * (now_reference[band] + self.previous_reference[band]);
        }
        self.previous_linear = now_linear;
        self.previous_reference = now_reference;
        let decay = 10f32.powf(-DECAY_DB / 10.0);
        push_capped(&mut self.held, reference, HOLD_FRAMES);
        let mut hits = 0;
        let mut ratios = [0.0f32; BANDS];
        let mut cross = [0.0f32; BANDS];
        for band in 0..BANDS {
            let held = self
                .held
                .iter()
                .map(|frame| frame[band])
                .fold(0.0f32, f32::max);
            self.envelope[band] = held.max(self.envelope[band] * decay);
        }
        let total_db = 10.0 * (self.envelope.iter().sum::<f32>() + 1e-12).log10();
        for band in 0..BANDS {
            let level_db = 10.0 * (linear[band] + 1e-12).log10();
            let envelope_db = 10.0 * (self.envelope[band] + 1e-12).log10();
            ratios[band] = level_db - envelope_db;
            cross[band] = level_db - total_db;
            push_capped(&mut self.floor_history[band], level_db, FLOOR_HISTORY);
            let bound = (self.floor_db[band] + FLOOR_MARGIN_DB)
                .max(envelope_db + self.leak_db[band] + MARGIN_DB)
                .max(total_db + self.cross_db[band] + MARGIN_DB);
            if level_db > bound {
                hits += 1;
            }
        }
        if self.frames.is_multiple_of(LEAK_EVERY) {
            for band in 0..BANDS {
                let mut sorted: Vec<f32> = self.floor_history[band].iter().copied().collect();
                sorted.sort_by(f32::total_cmp);
                self.floor_db[band] = sorted[sorted.len() / 10];
                for (history, leak) in [
                    (&self.leak_history[band], &mut self.leak_db[band]),
                    (&self.cross_history[band], &mut self.cross_db[band]),
                ] {
                    if history.len() >= LEAK_MIN {
                        let mut sorted: Vec<f32> = history.iter().copied().collect();
                        sorted.sort_by(f32::total_cmp);
                        *leak = sorted[sorted.len() * 9 / 10];
                    }
                }
            }
        }
        let frame = Frame { hits };
        self.last_ratios = (ratios, cross);
        if learn {
            self.pending.push_back((ratios, cross));
            if self.pending.len() > SETTLE_FRAMES && !frame.user() {
                let settled = self.pending.pop_front().expect("longer than settle");
                self.learn(&settled);
            }
        }
        self.latest = frame;
        frame
    }

    fn learn(&mut self, (ratios, cross): &([f32; BANDS], [f32; BANDS])) {
        for band in 0..BANDS {
            if ratios[band].is_finite() {
                push_capped(&mut self.leak_history[band], ratios[band], LEAK_HISTORY);
            }
            if cross[band].is_finite() {
                push_capped(&mut self.cross_history[band], cross[band], LEAK_HISTORY);
            }
        }
    }

    /// What triggered a false alarm was Vera's leak: learn it at once, and
    /// what waited to be learned with it.
    pub(crate) fn learn_false_alarm(&mut self) {
        let pending: Vec<([f32; BANDS], [f32; BANDS])> = self.pending.drain(..).collect();
        for ratios in &pending {
            self.learn(ratios);
        }
        let last = self.last_ratios;
        for _ in 0..LEAK_HISTORY / 10 {
            self.learn(&last);
        }
        for band in 0..BANDS {
            if last.0[band].is_finite() {
                self.leak_db[band] = self.leak_db[band].max(last.0[band]);
            }
            if last.1[band].is_finite() {
                self.cross_db[band] = self.cross_db[band].max(last.1[band]);
            }
        }
    }

    /// The user is talking: what waited to be learned was not echo.
    pub(crate) fn forget_pending(&mut self) {
        self.pending.clear();
    }

    /// Band energies of the last `WINDOW` samples of the linear output, or
    /// of the reference ending `back` samples from its newest.
    fn band_energies_of(&mut self, linear: bool, back: usize) -> [f32; BANDS] {
        let source = if linear {
            &self.linear
        } else {
            &self.reference
        };
        let end = source.len() - back;
        for (index, (into, sample)) in self
            .scratch
            .iter_mut()
            .zip(source.range(end - WINDOW..end))
            .enumerate()
        {
            *into = sample * self.window[index];
        }
        let _ = self.fft.process(&mut self.scratch, &mut self.spectrum);
        let mut energies = [0.0f32; BANDS];
        for (band, range) in self.ranges.iter().enumerate() {
            energies[band] = self.spectrum[range.clone()]
                .iter()
                .map(Complex32::norm_sqr)
                .sum::<f32>()
                + 1e-12;
        }
        energies
    }
}

fn push_capped<T>(ring: &mut VecDeque<T>, value: T, cap: usize) {
    ring.push_back(value);
    while ring.len() > cap {
        ring.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vera::audio::sim::room::Noise;

    fn tone(hz: f32, at: usize, amplitude: f32) -> f32 {
        (2.0 * std::f32::consts::PI * hz * at as f32 / RATE as f32).sin() * amplitude
    }

    #[test]
    fn a_voice_in_bands_vera_leaves_empty_is_the_user() {
        let mut bands = Bands::new();
        let mut noise = Noise(3);
        let mut frames = Vec::new();
        // Vera: low tones (300 and 600 Hz); her residual in the linear
        // output is 20 dB under her reference, with a little noise.
        for n in (0..RATE as usize * 4).step_by(HOP) {
            let reference: Vec<f32> = (n..n + HOP)
                .map(|at| tone(300.0, at, 0.1) + tone(600.0, at, 0.05))
                .collect();
            let user = n >= RATE as usize * 3;
            let linear: Vec<f32> = (n..n + HOP)
                .map(|at| {
                    let residual = (tone(300.0, at, 0.1) + tone(600.0, at, 0.05)) * 0.1;
                    // The user: bright noise, 6 dB under Vera's echo overall.
                    let voice = if user { noise.gauss() * 0.02 } else { 0.0 };
                    residual + voice + noise.gauss() * 1e-4
                })
                .collect();
            let frame = bands
                .push(&linear, &reference, 0, !user)
                .expect("a frame per hop");
            frames.push((user, frame.user()));
        }
        let echo_alarms = frames[100..]
            .iter()
            .filter(|(user, hit)| !user && *hit)
            .count();
        let caught = frames.iter().filter(|(user, hit)| *user && *hit).count();
        let user_frames = frames.iter().filter(|(user, _)| *user).count();
        assert_eq!(echo_alarms, 0);
        assert!(caught * 10 >= user_frames * 9, "{caught} of {user_frames}");
    }
}
