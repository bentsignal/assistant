//! What Vera plays: queued speech, chimes, her own volume, and the duck
//! barge-in asks for, mixed to one mono signal at the device rate. It runs
//! inside the output callback (or the simulator's), takes [`Command`]s from
//! a channel, and reports every block it rendered as the echo canceller's
//! reference, plus when each utterance started and finished.
//!
//! Gains never jump: volume moves over ~60 ms, a duck falls in ~8 ms and
//! recovers in ~150 ms, and a stop fades the voice out over ~20 ms before
//! its audio is dropped, so nothing clicks.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender};

use super::resample::Resampler;

/// Attenuation while barge-in suspects the user is talking: -20 dB.
pub(crate) const DUCK_GAIN: f32 = 0.1;
/// Speech that starts playing only once this much is buffered (or its
/// stream ended), so a slow first chunk doesn't stutter.
const PREBUFFER_SECONDS: f32 = 0.08;
/// Silence between consecutive utterances.
const GAP_SECONDS: f32 = 0.1;

const VOLUME_TAU: f32 = 0.06;
const DUCK_DOWN_TAU: f32 = 0.008;
const DUCK_UP_TAU: f32 = 0.15;
const STOP_TAU: f32 = 0.006;
/// A stopped voice is dropped once its fade reaches this.
const SILENT: f32 = 1e-4;

pub(crate) type SpeakId = Arc<str>;

#[derive(Debug)]
pub(crate) enum Command {
    /// A new utterance, queued behind any others; its audio comes as `Pcm`.
    Begin {
        id: SpeakId,
    },
    /// More of `id`'s audio, mono at `rate`.
    Pcm {
        id: SpeakId,
        rate: u32,
        samples: Vec<f32>,
    },
    /// No more audio is coming for `id`.
    End {
        id: SpeakId,
    },
    /// Stops (fades out) and drops every utterance; chimes go on.
    Stop,
    /// Drops one utterance (fading it out if it is playing).
    Drop {
        id: SpeakId,
    },
    Duck(bool),
    /// Vera's volume as a linear gain.
    Gain(f32),
    /// A chime at the device rate, mixed in at once.
    Chime(Vec<f32>),
}

#[derive(Debug)]
pub(crate) enum Report {
    /// One rendered block: the mono signal sent to the speakers (after
    /// every gain) and when its first sample plays, plus the duck gain it
    /// carried (1 when not ducked).
    Reference {
        playback_ns: u64,
        samples: Vec<f32>,
        duck: f32,
    },
    Started {
        id: SpeakId,
    },
    /// The last sample of `id` was rendered; it is heard at `ends_at_ns`.
    Finished {
        id: SpeakId,
        ends_at_ns: u64,
    },
}

struct Item {
    id: SpeakId,
    /// From the audio's rate to the device's, made at the first audio.
    resampler: Option<(u32, Resampler)>,
    buffer: VecDeque<f32>,
    ended: bool,
    started: bool,
}

/// One-pole smoothing toward a target.
#[derive(Clone, Copy)]
struct Ramp {
    value: f32,
    target: f32,
    coefficient: f32,
}

impl Ramp {
    fn new(value: f32) -> Self {
        Self {
            value,
            target: value,
            coefficient: 0.0,
        }
    }

    fn set(&mut self, target: f32, tau: f32, rate: u32) {
        self.target = target;
        self.coefficient = (-1.0 / (tau * rate as f32)).exp();
    }

    fn next(&mut self) -> f32 {
        self.value = self.target + (self.value - self.target) * self.coefficient;
        if (self.value - self.target).abs() < 1e-6 {
            self.value = self.target;
        }
        self.value
    }
}

pub(crate) struct Mixer {
    rate: u32,
    commands: Receiver<Command>,
    reports: Sender<Report>,
    queue: VecDeque<Item>,
    /// The utterance being faded out by a stop, and its fade.
    stopping: Option<(Item, Ramp)>,
    chimes: Vec<(Vec<f32>, usize)>,
    volume: Ramp,
    duck: Ramp,
    /// Silence still to play before the next utterance.
    gap: usize,
    /// Smoothed program level (before volume), for the HUD, as f32 bits.
    level: Arc<AtomicU32>,
    level_value: f32,
    scratch: Vec<f32>,
}

impl Mixer {
    pub(crate) fn new(
        rate: u32,
        volume: f32,
        commands: Receiver<Command>,
        reports: Sender<Report>,
        level: Arc<AtomicU32>,
    ) -> Self {
        Self {
            rate,
            commands,
            reports,
            queue: VecDeque::new(),
            stopping: None,
            chimes: Vec::new(),
            volume: Ramp::new(volume),
            duck: Ramp::new(1.0),
            gap: 0,
            level,
            level_value: 0.0,
            scratch: Vec::new(),
        }
    }

    /// A new output stream at `rate`: queued audio is resampled for it.
    pub(crate) fn set_rate(&mut self, rate: u32) {
        if rate == self.rate {
            return;
        }
        let from = self.rate;
        for item in &mut self.queue {
            let buffered: Vec<f32> = item.buffer.drain(..).collect();
            item.buffer
                .extend(super::resample::resample(&buffered, from, rate));
            item.resampler = item
                .resampler
                .take()
                .map(|(source, _)| (source, Resampler::new(source, rate)));
        }
        self.chimes.clear();
        self.stopping = None;
        self.rate = rate;
        let volume = self.volume.target;
        self.volume = Ramp::new(volume);
        self.duck = Ramp::new(1.0);
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Begin { id } => self.queue.push_back(Item {
                id,
                resampler: None,
                buffer: VecDeque::new(),
                ended: false,
                started: false,
            }),
            Command::Pcm { id, rate, samples } => {
                let device_rate = self.rate;
                if let Some(item) = self.queue.iter_mut().find(|item| item.id == id) {
                    if item.resampler.as_ref().is_none_or(|(at, _)| *at != rate) {
                        if let Some((_, mut previous)) = item.resampler.take() {
                            item.buffer.extend(previous.flush());
                        }
                        item.resampler = Some((rate, Resampler::new(rate, device_rate)));
                    }
                    let (_, resampler) = item.resampler.as_mut().expect("set above");
                    item.buffer.extend(resampler.push(&samples));
                }
            }
            Command::End { id } => {
                if let Some(item) = self.queue.iter_mut().find(|item| item.id == id) {
                    if let Some((_, resampler)) = &mut item.resampler {
                        let flushed = resampler.flush();
                        item.buffer.extend(flushed);
                    }
                    item.ended = true;
                }
            }
            Command::Stop => {
                let current = self.queue.pop_front().filter(|item| item.started);
                self.queue.clear();
                self.gap = 0;
                if let Some(item) = current {
                    let mut fade = Ramp::new(1.0);
                    fade.set(0.0, STOP_TAU, self.rate);
                    self.stopping = Some((item, fade));
                }
            }
            Command::Drop { id } => {
                if let Some(index) = self.queue.iter().position(|item| item.id == id) {
                    let item = self.queue.remove(index).expect("found above");
                    if index == 0 && item.started {
                        let mut fade = Ramp::new(1.0);
                        fade.set(0.0, STOP_TAU, self.rate);
                        self.stopping = Some((item, fade));
                    }
                }
            }
            Command::Duck(on) => {
                let (target, tau) = if on {
                    (DUCK_GAIN, DUCK_DOWN_TAU)
                } else {
                    (1.0, DUCK_UP_TAU)
                };
                self.duck.set(target, tau, self.rate);
            }
            Command::Gain(gain) => self.volume.set(gain.max(0.0), VOLUME_TAU, self.rate),
            Command::Chime(samples) => self.chimes.push((samples, 0)),
        }
    }

    /// Whether anything is playing or waiting to.
    pub(crate) fn busy(&self) -> bool {
        !self.queue.is_empty() || self.stopping.is_some() || !self.chimes.is_empty()
    }

    /// Fills `out` (mono, the device rate) and reports it as the reference
    /// that plays at `playback_ns`.
    pub(crate) fn render(&mut self, out: &mut [f32], playback_ns: u64) {
        while let Ok(command) = self.commands.try_recv() {
            self.command(command);
        }
        let frame_ns = 1e9 / self.rate as f64;
        let mut program_energy = 0.0f32;
        let mut duck_sum = 0.0f32;
        for (index, sample) in out.iter_mut().enumerate() {
            let mut program = self.next_speech(playback_ns, index, frame_ns);
            if let Some((item, fade)) = &mut self.stopping {
                let voice = item.buffer.pop_front().unwrap_or(0.0);
                program += voice * fade.next();
                if fade.value < SILENT || item.buffer.is_empty() {
                    self.stopping = None;
                }
            }
            for (chime, at) in &mut self.chimes {
                program += chime.get(*at).copied().unwrap_or(0.0);
                *at += 1;
            }
            program_energy += program * program;
            let duck = self.duck.next();
            duck_sum += duck;
            *sample = program * self.volume.next() * duck;
        }
        self.chimes.retain(|(chime, at)| *at < chime.len());
        if !out.is_empty() {
            let rms = (program_energy / out.len() as f32).sqrt();
            // Fast attack, ~200 ms release, per block.
            let seconds = out.len() as f32 / self.rate as f32;
            let release = (-seconds / 0.2).exp();
            self.level_value = if rms > self.level_value {
                rms
            } else {
                rms + (self.level_value - rms) * release
            };
            self.level
                .store(self.level_value.to_bits(), Ordering::Relaxed);
        }
        self.scratch.clear();
        self.scratch.extend_from_slice(out);
        let _ = self.reports.send(Report::Reference {
            playback_ns,
            samples: std::mem::take(&mut self.scratch),
            duck: if out.is_empty() {
                1.0
            } else {
                duck_sum / out.len() as f32
            },
        });
    }

    /// The next sample of the utterance at the head of the queue.
    fn next_speech(&mut self, playback_ns: u64, index: usize, frame_ns: f64) -> f32 {
        if self.gap > 0 {
            self.gap -= 1;
            return 0.0;
        }
        let prebuffer = (PREBUFFER_SECONDS * self.rate as f32) as usize;
        let Some(item) = self.queue.front_mut() else {
            return 0.0;
        };
        if !item.started {
            if !item.ended && item.buffer.len() < prebuffer {
                return 0.0;
            }
            item.started = true;
            let _ = self.reports.send(Report::Started {
                id: item.id.clone(),
            });
        }
        let sample = item.buffer.pop_front().unwrap_or(0.0);
        if item.ended && item.buffer.is_empty() {
            let ends_at_ns = playback_ns + ((index + 1) as f64 * frame_ns) as u64;
            let _ = self.reports.send(Report::Finished {
                id: item.id.clone(),
                ends_at_ns,
            });
            self.queue.pop_front();
            if !self.queue.is_empty() {
                self.gap = (GAP_SECONDS * self.rate as f32) as usize;
            }
        }
        sample
    }
}

/// Vera's volume (0..=1) as a linear gain: 40 dB of range, linear in dB,
/// so each 0.1 is 4 dB; 0 is silent and 1 is the voice service's own level
/// (about -20 LUFS, v1's loudness).
pub(crate) fn volume_gain(level: f32) -> f32 {
    let level = level.clamp(0.0, 1.0);
    if level <= 0.0 {
        return 0.0;
    }
    10f32.powf(40.0 * (level - 1.0) / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct Rig {
        mixer: Mixer,
        commands: Sender<Command>,
        reports: Receiver<Report>,
        at_ns: u64,
    }

    fn rig(volume: f32) -> Rig {
        let (commands, receiver) = mpsc::channel();
        let (sender, reports) = mpsc::channel();
        Rig {
            mixer: Mixer::new(
                48_000,
                volume,
                receiver,
                sender,
                Arc::new(AtomicU32::new(0)),
            ),
            commands,
            reports,
            at_ns: 1_000_000_000,
        }
    }

    impl Rig {
        /// Renders `ms` in 10 ms blocks; returns the output.
        fn render(&mut self, ms: usize) -> Vec<f32> {
            let mut all = Vec::new();
            for _ in 0..ms / 10 {
                let mut block = vec![0.0; 480];
                self.mixer.render(&mut block, self.at_ns);
                self.at_ns += 10_000_000;
                all.extend(block);
            }
            all
        }

        fn reports(&mut self) -> Vec<Report> {
            self.reports.try_iter().collect()
        }
    }

    fn speak(rig: &Rig, id: &str, seconds: f32) {
        let id: SpeakId = id.into();
        let _ = rig.commands.send(Command::Begin { id: id.clone() });
        let samples = vec![0.5; (24_000.0 * seconds) as usize];
        let _ = rig.commands.send(Command::Pcm {
            id: id.clone(),
            rate: 24_000,
            samples,
        });
        let _ = rig.commands.send(Command::End { id });
    }

    #[test]
    fn utterances_play_in_order_with_start_and_finish_reports() {
        let mut rig = rig(1.0);
        speak(&rig, "a", 0.2);
        speak(&rig, "b", 0.1);
        let out = rig.render(600);
        let reports = rig.reports();
        let order: Vec<String> = reports
            .iter()
            .filter_map(|report| match report {
                Report::Started { id } => Some(format!("start {id}")),
                Report::Finished { id, .. } => Some(format!("end {id}")),
                Report::Reference { .. } => None,
            })
            .collect();
        assert_eq!(order, ["start a", "end a", "start b", "end b"]);
        // a: 200 ms of audio, then the 100 ms gap, then b.
        let loud = out.iter().filter(|s| s.abs() > 0.25).count();
        assert!((14_000..=14_600).contains(&loud), "{loud}");
        let ends: Vec<u64> = reports
            .iter()
            .filter_map(|report| match report {
                Report::Finished { ends_at_ns, .. } => Some(*ends_at_ns),
                _ => None,
            })
            .collect();
        let a_ms = (ends[0] - 1_000_000_000) / 1_000_000;
        assert!((199..=202).contains(&a_ms), "{a_ms}");
    }

    #[test]
    fn a_stop_fades_out_within_a_few_ms_and_drops_the_queue() {
        let mut rig = rig(1.0);
        speak(&rig, "a", 2.0);
        speak(&rig, "b", 1.0);
        rig.render(300);
        let _ = rig.commands.send(Command::Stop);
        let out = rig.render(300);
        // Silent after ~40 ms, with no jump at the stop itself.
        assert!(out[480 * 4..].iter().all(|s| s.abs() < 1e-3));
        assert!((out[0] - 0.5).abs() < 0.05, "{}", out[0]);
        let max_step = out
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0f32, f32::max);
        assert!(max_step < 0.1, "{max_step}");
        assert!(!rig.mixer.busy());
        assert!(
            !rig.reports()
                .iter()
                .any(|report| matches!(report, Report::Started { id } if &**id == "b"))
        );
    }

    #[test]
    fn ducking_drops_twenty_db_fast_and_recovers_smoothly() {
        let mut rig = rig(1.0);
        speak(&rig, "a", 3.0);
        rig.render(200);
        let _ = rig.commands.send(Command::Duck(true));
        let out = rig.render(100);
        // Within 50 ms the voice is at -20 dB.
        assert!((out[480 * 5] - 0.05).abs() < 0.003, "{}", out[480 * 5]);
        let _ = rig.commands.send(Command::Duck(false));
        let out = rig.render(800);
        assert!((out[480 * 10] - 0.5).abs() > 0.05, "recovers gradually");
        assert!((out.last().unwrap() - 0.5).abs() < 0.01);
        let reference = rig
            .reports()
            .into_iter()
            .filter_map(|report| match report {
                Report::Reference { duck, .. } => Some(duck),
                _ => None,
            })
            .next_back()
            .unwrap();
        assert!((reference - 1.0).abs() < 0.01);
    }

    #[test]
    fn volume_is_vera_own_and_linear_in_db() {
        assert_eq!(volume_gain(0.0), 0.0);
        assert!((volume_gain(1.0) - 1.0).abs() < 1e-6);
        let db = |level| 20.0 * volume_gain(level).log10();
        assert!((db(0.7) + 12.0).abs() < 0.01);
        assert!((db(0.5) + 20.0).abs() < 0.01);
        let mut rig = rig(volume_gain(0.5));
        speak(&rig, "a", 0.5);
        let out = rig.render(300);
        assert!((out[480 * 20] - 0.05).abs() < 0.002, "{}", out[480 * 20]);
    }

    #[test]
    fn chimes_mix_over_speech_and_survive_a_stop() {
        let mut rig = rig(1.0);
        speak(&rig, "a", 1.0);
        rig.render(200);
        let _ = rig.commands.send(Command::Chime(vec![0.25; 4_800]));
        let _ = rig.commands.send(Command::Stop);
        let out = rig.render(100);
        assert!((out[480 * 8] - 0.25).abs() < 0.01, "{}", out[480 * 8]);
    }
}
