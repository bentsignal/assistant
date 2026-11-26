//! The engine thread: real devices around the duplex core. It keeps the
//! microphone open (Hex's recovering input, which follows the default
//! device and survives unplugs), opens the output when there is something
//! to play and closes it after `OUTPUT_LINGER` (three minutes) of silence, loads speech to
//! text in the background, and turns the App's requests into mixer
//! commands and voice fetches.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use super::duplex::{Core, Epoch};
use super::mixer::{self, Mixer, SpeakId, volume_gain};
use super::output::{self, Output};
use super::voice::{Fetched, VoiceClient};
use super::{AudioConfig, AudioEvent, PlaybackState, Request, Shared, chime, now_ns};
use crate::assistant_ears::Stt;
use crate::assistant_ears::utterances::{Backend, Finished};
use crate::audio::{RecoveringAudioInput, RecoveringAudioInputEvent};
use crate::desktop::events::now_ms;

/// The output closes after this long with nothing to play: long enough to
/// stay open through a whole conversation, so no line of hers waits on a
/// device opening (a wireless headset fades in on every open, which sounded
/// like her voice dipping) and the echo canceller keeps what it learned.
const OUTPUT_LINGER: Duration = Duration::from_secs(180);
/// How often the engine logs its echo canceller and barge-in counters
/// while the output is open.
const STATS_EVERY: Duration = Duration::from_secs(2);
/// How long the loop waits for audio before looking at everything else.
const POLL: Duration = Duration::from_millis(5);

/// The microphone: Hex's recovering input, or the simulated one
/// (`simdev`, `ASSISTANT_AUDIO_SIM`).
enum Input {
    Real(Box<RecoveringAudioInput>),
    Sim(super::simdev::SimInput),
}

impl Input {
    fn close(self) {
        if let Self::Real(mut input) = self {
            input.close();
        }
    }
}

/// Speech to text, once loaded.
pub(crate) enum SttBackend {
    Loading,
    Ready(crate::assistant_ears::EngineBackend),
}

impl Backend for SttBackend {
    fn heard_speech(&mut self, samples: &[f32]) -> Option<bool> {
        match self {
            Self::Loading => None,
            Self::Ready(backend) => backend.heard_speech(samples),
        }
    }

    fn transcribe(&mut self, id: u64, clip: Vec<f32>, verified: bool) {
        if let Self::Ready(backend) = self {
            backend.transcribe(id, clip, verified);
        }
    }
}

struct Engine {
    config: AudioConfig,
    events: Sender<AudioEvent>,
    shared: Arc<Shared>,
    core: Core<SttBackend>,
    mixer: Arc<Mutex<Mixer>>,
    commands: Sender<mixer::Command>,
    reports: Receiver<mixer::Report>,
    output: Option<Output>,
    idle_since: Option<Instant>,
    voice: VoiceClient,
    fetches: HashMap<String, Arc<AtomicBool>>,
    fetched: (Sender<Fetched>, Receiver<Fetched>),
    input: Option<Input>,
    device: Option<String>,
    stt: Option<(String, String)>,
    ready: bool,
}

pub(super) fn run(
    config: AudioConfig,
    requests: Receiver<Request>,
    events: Sender<AudioEvent>,
    shared: Arc<Shared>,
) {
    let (commands, command_receiver) = mpsc::channel();
    let (report_sender, reports) = mpsc::channel();
    let volume = f32::from_bits(shared.volume.load(Ordering::Relaxed));
    let mixer = Arc::new(Mutex::new(Mixer::new(
        48_000,
        volume_gain(volume),
        command_receiver,
        report_sender,
        shared.out_level.clone(),
    )));
    let epoch = Epoch {
        clock_ns: now_ns(),
        unix_ms: now_ms(),
    };
    let mut core = Core::new(
        SttBackend::Loading,
        &config.ears,
        commands.clone(),
        epoch,
        shared.mic_level.clone(),
    );
    core.set_barge_in(config.barge_in);
    core.set_stt_source(config.stt_source);
    // Nothing of hers starts while he has the floor.
    mixer
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .hold_while(shared.floor.clone());
    core.hold_playback_with(shared.floor.clone());
    // `ASSISTANT_AUDIO_DUMP=<folder>`: keep this run's microphone, reference,
    // and cancelled audio (16 kHz) and write them there on shutdown.
    let dump = std::env::var_os("ASSISTANT_AUDIO_DUMP").map(std::path::PathBuf::from);
    if dump.is_some() {
        core.audio_dump = Some(Default::default());
    }
    let device = match &config.microphone {
        Some(query) => match crate::assistant_ears::resolve_device(query) {
            Ok(device) => Some(device),
            Err(error) => {
                let _ = events.send(AudioEvent::Error {
                    message: format!("{error:#}; using the default microphone"),
                    fatal: false,
                });
                None
            }
        },
        None => None,
    };
    let (stt_sender, stt_loaded) = mpsc::channel();
    let ears = config.ears.clone();
    let _ = std::thread::Builder::new()
        .name("assistant-stt-load".into())
        .spawn(move || {
            let loaded = crate::assistant_ears::ensure_model(&ears).and_then(|()| Stt::load(&ears));
            let _ = stt_sender.send(loaded.map_err(|error| format!("{error:#}")));
        });
    let (results, transcribed) = mpsc::channel::<Finished>();
    let mut engine = Engine {
        voice: VoiceClient::new(
            &config.voice_url,
            config.voice.clone(),
            config.preset.clone(),
        ),
        config,
        events,
        shared,
        core,
        mixer,
        commands,
        reports,
        output: None,
        idle_since: None,
        fetches: HashMap::new(),
        fetched: mpsc::channel(),
        input: None,
        device,
        stt: None,
        ready: false,
    };
    let mut results = Some(results);
    let mut reported = Instant::now();
    loop {
        if engine.output.is_some() && reported.elapsed() >= STATS_EVERY {
            reported = Instant::now();
            let stats = engine.core.stats;
            let (microphone_peak_db, cancelled_peak_db) = engine.core.take_peaks();
            let (echo_return_db, headset) = engine.core.echo_return();
            tracing::info!(
                microphone_peak_db,
                echo_return_db = echo_return_db.map(|db| format!("{db:.1}")),
                headset,
                cancelled_peak_db,
                aec_delay_ms = engine.core.delay_ms(),
                blocks = stats.blocks,
                ducks = stats.ducks,
                restores = stats.restores,
                suspicions = stats.suspicions,
                dismissed = stats.dismissed,
                barge_ins = stats.barge_ins,
                late_blocks = stats.late_blocks,
                resyncs = engine.core.reference_resyncs(),
                "assistant audio: duplex"
            );
        }
        match requests.try_recv() {
            Ok(Request::Shutdown) | Err(TryRecvError::Disconnected) => break,
            Ok(request) => {
                engine.request(request);
                continue;
            }
            Err(TryRecvError::Empty) => {}
        }
        if let Some(sender) = results.take_if(|_| engine.stt.is_none()) {
            match stt_loaded.try_recv() {
                Ok(Ok(stt)) => {
                    engine.stt = Some((
                        stt.selection.model.as_str().to_owned(),
                        stt.backend_label.clone(),
                    ));
                    *engine.core.backend() = SttBackend::Ready(stt.backend(sender));
                    if !engine.shared.muted.load(Ordering::Relaxed) {
                        engine.open_input();
                    }
                }
                Ok(Err(message)) => {
                    tracing::error!(%message, "assistant audio: speech to text failed to load");
                    engine.emit(AudioEvent::Error {
                        message: format!("speech to text could not load: {message}"),
                        fatal: true,
                    });
                }
                Err(_) => results = Some(sender),
            }
        }
        engine.service();
        while let Ok(finished) = transcribed.try_recv() {
            engine.core.transcribed(finished);
        }
        engine.listen();
        engine.core.tick(
            now_ns(),
            &mut crate::transcription::speech_detector::contains_speech,
        );
        engine.flush();
    }
    engine.core.stop_playback();
    engine.flush();
    for cancel in engine.fetches.values() {
        cancel.store(true, Ordering::Relaxed);
    }
    if let Some(input) = engine.input.take() {
        input.close();
    }
    drop(engine.output.take());
    if let (Some(folder), Some(audio)) = (dump, engine.core.audio_dump.take()) {
        super::sim::write_dump(&folder, "live", &audio);
    }
    tracing::info!("assistant audio: stopped");
}

impl Engine {
    fn emit(&self, event: AudioEvent) {
        let _ = self.events.send(event);
    }

    fn request(&mut self, request: Request) {
        match request {
            Request::Speak { id, text } => {
                let id: SpeakId = id.into();
                if !self.ensure_output(&id) {
                    return;
                }
                let _ = self.commands.send(mixer::Command::Begin { id: id.clone() });
                self.core.speech_queued(id.clone());
                let cancel = Arc::new(AtomicBool::new(false));
                self.fetches.insert(id.to_string(), cancel.clone());
                self.voice.speak(
                    id,
                    text,
                    self.commands.clone(),
                    self.fetched.0.clone(),
                    cancel,
                );
            }
            Request::SpeakPcm { id, samples, rate } => {
                let id: SpeakId = id.into();
                if !self.ensure_output(&id) {
                    return;
                }
                let _ = self.commands.send(mixer::Command::Begin { id: id.clone() });
                let _ = self.commands.send(mixer::Command::Pcm {
                    id: id.clone(),
                    rate,
                    samples,
                });
                let _ = self.commands.send(mixer::Command::End { id: id.clone() });
                self.core.speech_queued(id);
            }
            Request::Stop => self.core.stop_playback(),
            Request::Drop(id) => {
                let id: SpeakId = id.into();
                if let Some(cancel) = self.fetches.remove(&*id) {
                    cancel.store(true, Ordering::Relaxed);
                }
                let _ = self.commands.send(mixer::Command::Drop { id: id.clone() });
                self.core.speech_failed(&id, "dropped: it took too long");
            }
            Request::Volume(level) => {
                let _ = self.commands.send(mixer::Command::Gain(volume_gain(level)));
            }
            Request::Voice(voice) => {
                tracing::info!(
                    voice = voice.as_deref().unwrap_or("(default)"),
                    "assistant audio: voice"
                );
                self.voice.set_voice(voice);
            }
            Request::Microphone(query) => self.switch_microphone(query),
            Request::Vocabulary(terms) => {
                tracing::info!(?terms, "assistant audio: vocabulary");
                self.config.ears.vocabulary = terms;
                crate::assistant_ears::apply_vocabulary(&self.config.ears);
            }
            Request::Mute(muted) => {
                self.core.set_muted(muted, now_ms());
                if muted {
                    if let Some(input) = self.input.take() {
                        input.close();
                    }
                } else if self.stt.is_some() && self.input.is_none() {
                    self.open_input();
                }
            }
            Request::Chime(kind) => {
                if self.ensure_output("chime") {
                    let rate = self.output.as_ref().map_or(48_000, |output| output.rate);
                    let _ = self
                        .commands
                        .send(mixer::Command::Chime(chime::render(kind, rate)));
                }
            }
            Request::Shutdown => {}
        }
        self.idle_since = None;
    }

    /// Opens the output if needed; on failure, `id` fails.
    fn ensure_output(&mut self, id: &str) -> bool {
        if self.output.is_some() {
            return true;
        }
        match output::open(self.config.output.as_deref(), self.mixer.clone()) {
            Ok(output) => {
                self.output = Some(output);
                true
            }
            Err(error) => {
                let message = format!("{error:#}");
                tracing::warn!(%message, "assistant audio: no output");
                self.emit(AudioEvent::Error {
                    message: format!("could not play audio: {message}"),
                    fatal: false,
                });
                if id != "chime" {
                    self.emit(AudioEvent::Playback {
                        speak_id: id.to_owned(),
                        state: PlaybackState::Failed,
                    });
                }
                false
            }
        }
    }

    fn open_input(&mut self) {
        self.input = Some(match super::simdev::sim() {
            Some(sim) => Input::Sim(super::simdev::SimInput::open(sim)),
            None => Input::Real(Box::new(RecoveringAudioInput::open(
                self.device.as_deref(),
                0,
                None,
            ))),
        });
    }

    /// Another microphone: only the input reopens (playback, speech to
    /// text, and the echo canceller go on), and `Ready` names it again.
    fn switch_microphone(&mut self, query: Option<String>) {
        let device = match &query {
            Some(query) => match crate::assistant_ears::resolve_device(query) {
                Ok(device) => Some(device),
                Err(error) => {
                    self.emit(AudioEvent::Error {
                        message: format!("{error:#}; using the default microphone"),
                        fatal: false,
                    });
                    None
                }
            },
            None => None,
        };
        self.config.microphone = query;
        if device == self.device && self.input.is_some() {
            return;
        }
        self.device = device;
        tracing::info!(
            microphone = self.device.as_deref().unwrap_or("(default)"),
            "assistant audio: switching microphone"
        );
        if let Some(input) = self.input.take() {
            input.close();
            self.core.mic_interrupted("microphone changed");
        }
        self.ready = false;
        if self.stt.is_some() && !self.shared.muted.load(Ordering::Relaxed) {
            self.open_input();
        }
    }

    /// Mixer reports, fetch outcomes, output failures, and the linger.
    fn service(&mut self) {
        let rate = self.output.as_ref().map_or(48_000, |output| output.rate);
        let now = now_ns();
        while let Ok(report) = self.reports.try_recv() {
            self.core.report(report, rate, now);
        }
        while let Ok(fetched) = self.fetched.1.try_recv() {
            match fetched {
                Fetched::Done { id } => {
                    self.fetches.remove(&*id);
                }
                Fetched::Failed { id, message } => {
                    self.fetches.remove(&*id);
                    tracing::warn!(%message, speak_id = &*id, "assistant audio: speech failed");
                    let _ = self.commands.send(mixer::Command::Drop { id: id.clone() });
                    self.core.speech_failed(&id, &message);
                }
            }
        }
        if let Some(output) = &self.output
            && let Ok(error) = output.errors.try_recv()
        {
            tracing::warn!(%error, device = output.name, "assistant audio: output failed");
            self.emit(AudioEvent::Error {
                message: format!("the output failed: {error}"),
                fatal: false,
            });
            self.output = None;
            self.core.stop_playback();
            self.core.output_closed();
        }
        let busy = self.core.speaking()
            || self
                .mixer
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .busy();
        self.shared
            .speaking
            .store(self.core.speaking(), Ordering::Relaxed);
        if busy || self.output.is_none() {
            self.idle_since = None;
        } else {
            let since = *self.idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= OUTPUT_LINGER {
                tracing::debug!("assistant audio: output idle; closing");
                self.output = None;
                self.idle_since = None;
                // Reports the stream sent before closing.
                while let Ok(report) = self.reports.try_recv() {
                    self.core.report(report, rate, now);
                }
                self.core.output_closed();
            }
        }
    }

    /// Takes what the microphone delivered (waiting up to `POLL`).
    fn listen(&mut self) {
        let input = match &mut self.input {
            None => {
                std::thread::sleep(POLL);
                return;
            }
            Some(Input::Sim(input)) => {
                if let Some((samples, captured_through)) = input.recv(POLL) {
                    let rate = super::simdev::RATE;
                    self.heard(&samples, rate, captured_through, "Simulated microphone");
                }
                return;
            }
            Some(Input::Real(input)) => input,
        };
        let idle = !self.core.listening_busy();
        match input.recv_timeout(POLL, idle) {
            RecoveringAudioInputEvent::Chunk {
                samples,
                captured_through,
            } => {
                let rate = input.sample_rate();
                let mic = input.device_name().to_owned();
                self.heard(&samples, rate, captured_through.as_nanos(), &mic);
            }
            RecoveringAudioInputEvent::Timeout => {}
            RecoveringAudioInputEvent::Interrupted | RecoveringAudioInputEvent::Reopened => {
                self.core.mic_interrupted("microphone interrupted");
            }
            RecoveringAudioInputEvent::OpenFailed(error) => {
                self.core.mic_interrupted("microphone unavailable");
                self.emit(AudioEvent::Error {
                    message: format!("could not open the microphone (retrying): {error}"),
                    fatal: false,
                });
            }
        }
    }

    /// A microphone chunk, from either input.
    fn heard(&mut self, samples: &[f32], rate: u32, captured_through_ns: u64, mic: &str) {
        let peak = samples.iter().fold(0f32, |peak, s| peak.max(s.abs()));
        // Non-negative floats order like their bits.
        self.shared
            .raw_peak
            .fetch_max(peak.to_bits(), Ordering::Relaxed);
        self.core.mic(samples, rate, captured_through_ns, now_ns());
        if !self.ready
            && let Some((model, backend)) = &self.stt
        {
            self.ready = true;
            tracing::info!(mic, rate, "assistant audio: listening");
            let event = AudioEvent::Ready {
                mic: mic.to_owned(),
                engine: model.clone(),
                backend: backend.clone(),
            };
            self.emit(event);
        }
    }

    /// Sends the core's events, cancelling fetches for utterances that
    /// ended early.
    fn flush(&mut self) {
        for event in self.core.take_events() {
            if let AudioEvent::Playback {
                speak_id,
                state: PlaybackState::Interrupted | PlaybackState::Failed,
            } = &event
                && let Some(cancel) = self.fetches.remove(speak_id)
            {
                cancel.store(true, Ordering::Relaxed);
            }
            let _ = self.events.send(event);
        }
    }
}
