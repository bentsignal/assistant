//! The duplex core: microphone audio in, echo cancelled against Vera's
//! playback, barge-in judged, utterances found and transcribed, events out.
//! It owns no device and no thread: the engine thread (`engine`) feeds it
//! from real devices, the simulator (`sim`) from a simulated room, and both
//! drive the same mixer through its command channel.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::Sender;

use super::align::{BLOCK, LOOKAHEAD_NS, RATE, Reference, Timeline};
use super::barge::{self, Action, Detector};
use super::echo::EchoCanceller;
use super::gate::{Collected, Gate, Heard};
use super::mixer::{self, SpeakId};
use super::resample::Resampler;
use super::{AudioEvent, PlaybackState};
use crate::vera_ears::EarsSettings;
use crate::vera_ears::utterances::{Backend, Finished, Utterances};

/// A microphone block waits at most this long for its reference.
const MAX_REFERENCE_WAIT_NS: f64 = 80e6;
/// The first final after a barge-in, if it begins within this of the
/// barge-in, is the user's interrupting turn.
const BARGE_IN_TURN_MS: u64 = 2_500;

/// Which echo-cancelled signal Ears listens to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SttSource {
    /// AEC3's suppressed output: least echo, but it clips the user while
    /// both talk.
    Suppressed,
    /// The linear output: the user intact, a residual of Vera's voice.
    Linear,
    /// Suppressed, except linear from a suspected barge-in until Vera's
    /// echo is gone, so the interrupting words arrive whole.
    Hybrid,
}

/// The canceller's clock (QPC ns) against Unix time, for event stamps.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Epoch {
    pub clock_ns: u64,
    pub unix_ms: u64,
}

impl Epoch {
    fn unix_ms(&self, clock_ns: f64) -> u64 {
        (self.unix_ms as f64 + (clock_ns - self.clock_ns as f64) / 1e6).max(0.0) as u64
    }
}

struct Capture {
    rate: u32,
    resampler: Resampler,
    timeline: Option<Timeline>,
    /// Device-rate samples received.
    received: u64,
    /// 16 kHz samples not processed yet, and the index of the first.
    pending: VecDeque<f32>,
    pending_index: u64,
}

impl Capture {
    fn new(rate: u32) -> Self {
        Self {
            rate,
            resampler: Resampler::new(rate, RATE),
            timeline: None,
            received: 0,
            pending: VecDeque::new(),
            pending_index: 0,
        }
    }

    /// When the 16 kHz sample `index` was captured.
    fn ns_at(&self, index: u64) -> Option<f64> {
        let timeline = self.timeline.as_ref()?;
        Some(timeline.ns_at(index as f64 * self.rate as f64 / RATE as f64))
    }
}

/// One utterance Vera was asked to say, until it is over.
struct Speech {
    id: SpeakId,
    playing: bool,
}

/// Per-run counters the simulator and logs report.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Stats {
    pub blocks: u64,
    pub ducks: u64,
    pub restores: u64,
    pub barge_ins: u64,
    pub waited_blocks: u64,
    pub late_blocks: u64,
}

pub(crate) struct Core<B: Backend> {
    mixer: Sender<mixer::Command>,
    capture: Option<Capture>,
    reference: Reference,
    aec: EchoCanceller,
    detector: Detector,
    utterances: Utterances<B, Collected>,
    gate: Gate,
    stt_source: SttSource,
    epoch: Epoch,
    speeches: Vec<Speech>,
    finishing: Vec<(SpeakId, u64)>,
    /// When the last barge-in was confirmed (epoch ms), until its turn's
    /// final arrives.
    barge_in_turn: Option<u64>,
    /// When the suspicion being probed began (epoch ms).
    suspected_at: Option<u64>,
    muted: bool,
    events: Vec<AudioEvent>,
    mic_level: Arc<AtomicU32>,
    mic_level_value: f32,
    /// Every block's trace, when the simulator asks for them.
    pub(crate) traces: Option<Vec<BlockTrace>>,
    /// Every block's audio (microphone, reference, linear, suppressed),
    /// when the simulator dumps it.
    pub(crate) audio_dump: Option<[Vec<f32>; 4]>,
    pub(crate) stats: Stats,
}

/// What one block looked like inside the core.
#[derive(Clone, Copy, Debug)]
pub(crate) struct BlockTrace {
    /// Capture time of the block's first sample.
    pub ns: f64,
    pub probe: barge::Probe,
    pub action: Option<Action>,
    /// Mean square of the microphone, the reference, and both outputs.
    pub microphone: f32,
    pub reference: f32,
    pub linear: f32,
    pub suppressed: f32,
}

impl<B: Backend> Core<B> {
    pub(crate) fn new(
        backend: B,
        settings: &EarsSettings,
        mixer: Sender<mixer::Command>,
        epoch: Epoch,
        mic_level: Arc<AtomicU32>,
    ) -> Self {
        Self {
            mixer,
            capture: None,
            reference: Reference::default(),
            aec: EchoCanceller::new(),
            detector: Detector::new(),
            utterances: Utterances::new(
                backend,
                Collected::default(),
                settings.endpointer(),
                settings.hesitation,
                settings.partials,
            ),
            gate: Gate::default(),
            stt_source: SttSource::Hybrid,
            epoch,
            speeches: Vec::new(),
            finishing: Vec::new(),
            barge_in_turn: None,
            suspected_at: None,
            muted: false,
            events: Vec::new(),
            mic_level,
            mic_level_value: 0.0,
            traces: None,
            audio_dump: None,
            stats: Stats::default(),
        }
    }

    pub(crate) fn set_stt_source(&mut self, source: SttSource) {
        self.stt_source = source;
    }

    pub(crate) fn set_barge_in(&mut self, enabled: bool) {
        self.detector.set_enabled(enabled);
    }

    pub(crate) fn take_events(&mut self) -> Vec<AudioEvent> {
        std::mem::take(&mut self.events)
    }

    pub(crate) fn backend(&mut self) -> &mut B {
        self.utterances.backend()
    }

    pub(crate) fn detector(&self) -> &Detector {
        &self.detector
    }

    pub(crate) fn delay_ms(&self) -> i32 {
        self.aec.delay_ms()
    }

    pub(crate) fn reference_resyncs(&self) -> u64 {
        self.reference.resyncs()
    }

    /// Whether Vera is speaking or about to.
    pub(crate) fn speaking(&self) -> bool {
        !self.speeches.is_empty()
    }

    /// Whether an utterance is being spoken or transcribed (device
    /// switches wait for neither).
    pub(crate) fn listening_busy(&self) -> bool {
        self.utterances.speaking() || self.utterances.waiting()
    }

    // --- playback bookkeeping -------------------------------------------

    /// `id` was queued with the mixer.
    pub(crate) fn speech_queued(&mut self, id: SpeakId) {
        self.speeches.push(Speech { id, playing: false });
    }

    /// `id` could not be fetched: it is dropped from the mixer and over.
    pub(crate) fn speech_failed(&mut self, id: &str, message: &str) {
        if let Some(index) = self.speeches.iter().position(|speech| &*speech.id == id) {
            let speech = self.speeches.remove(index);
            self.events.push(AudioEvent::Error {
                message: format!("speech {id} failed: {message}"),
                fatal: false,
            });
            self.events.push(AudioEvent::Playback {
                speak_id: speech.id.to_string(),
                state: PlaybackState::Failed,
            });
        }
    }

    /// Stops every utterance: each one not finished is interrupted.
    pub(crate) fn stop_playback(&mut self) {
        let _ = self.mixer.send(mixer::Command::Stop);
        for speech in self.speeches.drain(..) {
            self.events.push(AudioEvent::Playback {
                speak_id: speech.id.to_string(),
                state: PlaybackState::Interrupted,
            });
        }
    }

    /// A mixer report from the output callback.
    pub(crate) fn report(&mut self, report: mixer::Report, device_rate: u32, now_ns: u64) {
        match report {
            mixer::Report::Reference {
                playback_ns,
                samples,
                duck,
            } => {
                // A stamp that isn't on our clock (no device timestamps):
                // assume the block plays 20 ms from now.
                let plausible = playback_ns + 10_000_000 >= now_ns && playback_ns < now_ns + 2_000_000_000;
                let playback_ns = if plausible { playback_ns } else { now_ns + 20_000_000 };
                self.reference.push(device_rate, playback_ns, &samples, duck);
            }
            mixer::Report::Started { id } => {
                if let Some(speech) = self.speeches.iter_mut().find(|speech| speech.id == id) {
                    speech.playing = true;
                    self.events.push(AudioEvent::Playback {
                        speak_id: id.to_string(),
                        state: PlaybackState::Started,
                    });
                }
            }
            mixer::Report::Finished { id, ends_at_ns } => {
                if let Some(index) = self.speeches.iter().position(|speech| speech.id == id) {
                    self.speeches.remove(index);
                    self.finishing.push((id, ends_at_ns.max(now_ns)));
                }
            }
        }
    }

    /// The output stream closed.
    pub(crate) fn output_closed(&mut self) {
        self.reference.end_session();
    }

    // --- microphone -------------------------------------------------------

    /// A microphone chunk: mono `samples` at `rate`, the last captured at
    /// `captured_through_ns`, handled at `now_ns`.
    pub(crate) fn mic(&mut self, samples: &[f32], rate: u32, captured_through_ns: u64, now_ns: u64) {
        if self.muted {
            return;
        }
        if self.capture.as_ref().is_none_or(|capture| capture.rate != rate) {
            self.capture = Some(Capture::new(rate));
        }
        let capture = self.capture.as_mut().expect("set above");
        capture.received += samples.len() as u64;
        let plausible = captured_through_ns <= now_ns + 5_000_000
            && captured_through_ns + 1_000_000_000 > now_ns;
        // Without device stamps, audio delivered now was captured ~10 ms ago.
        let stamp = if plausible { captured_through_ns } else { now_ns - 10_000_000 };
        match &mut capture.timeline {
            Some(timeline) => {
                timeline.observe(capture.received, stamp);
            }
            None => capture.timeline = Some(Timeline::new(rate, capture.received, stamp)),
        }
        let resampled = capture.resampler.push(samples);
        capture.pending.extend(resampled);
    }

    /// The microphone stopped or changed: what was being said is lost.
    pub(crate) fn mic_interrupted(&mut self, reason: &str) {
        self.capture = None;
        self.utterances.interrupted(reason);
        self.drain_heard();
    }

    pub(crate) fn set_muted(&mut self, muted: bool, now_ms: u64) {
        if muted == self.muted {
            return;
        }
        self.muted = muted;
        self.capture = None;
        if muted {
            self.utterances.pause(now_ms);
        } else {
            self.utterances.resume(now_ms);
        }
        self.drain_heard();
    }

    pub(crate) fn transcribed(&mut self, finished: Finished) {
        self.utterances.finished(finished);
        self.drain_heard();
    }

    /// Processes every microphone block whose reference is in, and emits
    /// the playback events that are due.
    pub(crate) fn tick(&mut self, now_ns: u64, speech: &mut dyn FnMut(&[f32]) -> Option<bool>) {
        self.finishing.retain(|(id, ends_at)| {
            if *ends_at <= now_ns {
                self.events.push(AudioEvent::Playback {
                    speak_id: id.to_string(),
                    state: PlaybackState::Finished,
                });
                false
            } else {
                true
            }
        });
        loop {
            let Some(capture) = &self.capture else {
                break;
            };
            if capture.pending.len() < BLOCK {
                break;
            }
            let Some(at_ns) = capture.ns_at(capture.pending_index) else {
                break;
            };
            let wanted = at_ns + LOOKAHEAD_NS + 4e6;
            if !self.reference.covers(wanted) {
                if (now_ns as f64) < at_ns + MAX_REFERENCE_WAIT_NS {
                    self.stats.waited_blocks += 1;
                    break;
                }
                self.stats.late_blocks += 1;
            }
            let capture = self.capture.as_mut().expect("checked above");
            let microphone: Vec<f32> = capture.pending.drain(..BLOCK).collect();
            capture.pending_index += BLOCK as u64;
            self.block(&microphone, at_ns, speech);
        }
    }

    fn block(&mut self, microphone: &[f32], at_ns: f64, speech: &mut dyn FnMut(&[f32]) -> Option<bool>) {
        self.stats.blocks += 1;
        let mut reference = [0.0f32; BLOCK];
        let duck = self.reference.read(at_ns + LOOKAHEAD_NS, &mut reference);
        let cancelled = self.aec.process(microphone, &reference);
        let (action, probe) = self.detector.push(
            &barge::Block {
                linear: &cancelled.linear,
                suppressed: &cancelled.suppressed,
                reference: &reference,
                duck,
                delay_ms: self.aec.delay_ms(),
            },
            speech,
        );
        let end_ms = self.epoch.unix_ms(at_ns + BLOCK as f64 * 1e9 / RATE as f64);
        if let Some(action) = action {
            self.act(action, end_ms);
        }
        if let Some(dump) = &mut self.audio_dump {
            dump[0].extend_from_slice(microphone);
            dump[1].extend_from_slice(&reference);
            dump[2].extend_from_slice(&cancelled.linear);
            dump[3].extend_from_slice(&cancelled.suppressed);
        }
        if let Some(traces) = &mut self.traces {
            let energy = |samples: &[f32]| samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
            traces.push(BlockTrace {
                ns: at_ns,
                probe,
                action,
                microphone: energy(microphone),
                reference: energy(&reference),
                linear: energy(&cancelled.linear),
                suppressed: energy(&cancelled.suppressed),
            });
        }
        let barge_audio = self.detector.suspecting() || self.detector.confirmed();
        let heard: &[f32] = match self.stt_source {
            SttSource::Suppressed => &cancelled.suppressed,
            SttSource::Linear => &cancelled.linear,
            SttSource::Hybrid if barge_audio => &cancelled.linear,
            SttSource::Hybrid => &cancelled.suppressed,
        };
        self.level(heard);
        // While Vera's voice is in the room and nobody is suspected of
        // talking over it, nothing new starts: her echo is not an utterance.
        self.utterances
            .set_inhibited(self.detector.active() && !barge_audio);
        self.utterances.audio(heard, end_ms);
        self.drain_heard();
    }

    fn act(&mut self, action: Action, now_ms: u64) {
        match action {
            Action::Duck => {
                self.stats.ducks += 1;
                self.suspected_at = Some(now_ms.saturating_sub(100));
                let _ = self.mixer.send(mixer::Command::Duck(true));
            }
            Action::Restore => {
                self.stats.restores += 1;
                let _ = self.mixer.send(mixer::Command::Duck(false));
                let from = self.suspected_at.take().unwrap_or(now_ms).saturating_sub(400);
                tracing::debug!("vera audio: false alarm, volume restored");
                // An utterance the false alarm started is echo; one the user
                // began before it goes on.
                if self
                    .utterances
                    .current_onset_ms()
                    .is_some_and(|onset| onset >= from)
                {
                    self.utterances.drop_current("echo");
                    self.drain_heard_into_gate_only();
                }
                self.gate.drop_held(from, now_ms);
            }
            Action::Confirm { .. } => {
                self.suspected_at = None;
                let _ = self.mixer.send(mixer::Command::Duck(false));
                if let Some(speech) = self
                    .speeches
                    .iter()
                    .find(|speech| speech.playing)
                    .or(self.speeches.first())
                {
                    self.stats.barge_ins += 1;
                    let speak_id = speech.id.to_string();
                    tracing::info!(speak_id, "vera audio: barge-in");
                    self.events.push(AudioEvent::BargeIn {
                        speak_id: speak_id.clone(),
                    });
                    self.stop_playback();
                    self.barge_in_turn = Some(now_ms);
                }
                let released = self.gate.release();
                self.forward(released);
            }
        }
    }

    fn level(&mut self, samples: &[f32]) {
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
        let release = (-(BLOCK as f32 / RATE as f32) / 0.2).exp();
        self.mic_level_value = if rms > self.mic_level_value {
            rms
        } else {
            rms + (self.mic_level_value - rms) * release
        };
        self.mic_level
            .store(self.mic_level_value.to_bits(), Ordering::Relaxed);
    }

    /// Passes Ears' new events through the gate.
    fn drain_heard(&mut self) {
        let heard = std::mem::take(&mut self.utterances.sink_mut().0);
        let holding = self.detector.suspecting();
        let mut out = Vec::new();
        for event in heard {
            out.extend(self.gate.admit(event, holding));
        }
        self.forward(out);
    }

    /// Ears' new events go to the gate, which still holds the false
    /// alarm's utterance: they are dropped with it.
    fn drain_heard_into_gate_only(&mut self) {
        let heard = std::mem::take(&mut self.utterances.sink_mut().0);
        for event in heard {
            let _ = self.gate.admit(event, true);
        }
    }

    fn forward(&mut self, heard: Vec<Heard>) {
        for event in heard {
            let event = match event {
                Heard::SpeechStart { t } => AudioEvent::SpeechStart { t },
                Heard::Partial { text, t } => AudioEvent::Partial { text, t },
                Heard::Final { text, start, end } => {
                    let during_playback = self
                        .barge_in_turn
                        .take_if(|at| start + BARGE_IN_TURN_MS >= *at && start <= *at + BARGE_IN_TURN_MS)
                        .is_some();
                    AudioEvent::Final {
                        text,
                        start,
                        end,
                        during_playback,
                    }
                }
                Heard::SpeechCancel { t, reason } => AudioEvent::SpeechCancel { t, reason },
                Heard::Error { message } => AudioEvent::Error {
                    message,
                    fatal: false,
                },
            };
            self.events.push(event);
        }
    }
}
