//! Vera's in-process audio engine: full duplex, always interruptible.
//!
//! One engine owns the microphone, the speakers, and the link between them.
//! The microphone is never paused: everything it hears is echo-cancelled
//! against what Vera herself is playing (WebRTC AEC3, `echo`), so while she
//! talks, the user's voice still gets through. When the user starts talking
//! over her, she ducks within ~60 ms and stops within ~300 ms once it is
//! clearly speech (`barge`), and what the user said becomes an ordinary
//! final with `during_playback: true`. Speech to text is v1 Ears (Parakeet
//! through Hex's engine, Silero, the 700 ms pause) on the cancelled signal.
//!
//! Vera has her own volume ([`AssistantAudio::set_volume`]); nothing here ever
//! touches the system's. `docs/assistant-audio.md` has the design, the numbers,
//! and how the App wires it.
//!
//! ```ignore
//! let (audio, events) = AssistantAudio::start(AudioConfig::default())?;
//! audio.speak("s1", "On it. I'll ping you.");
//! for event in events {
//!     match event {
//!         AudioEvent::Final { text, during_playback, .. } => { /* to Core */ }
//!         AudioEvent::BargeIn { speak_id } => { /* to Core */ }
//!         _ => {}
//!     }
//! }
//! ```

mod align;
mod bands;
mod barge;
mod chime;
pub(crate) mod cli;
mod duplex;
mod echo;
mod engine;
mod gate;
mod mixer;
mod output;
mod resample;
pub(crate) mod sim;
pub(crate) mod simdev;
mod voice;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;

use color_eyre::eyre::{Result, WrapErr};
use serde::Serialize;

pub(crate) use chime::ChimeKind;
pub(crate) use duplex::SttSource;

use crate::assistant_ears::EarsSettings;

/// Vera's default volume: 0.7 is -12 dB under the voice service's level
/// (about -32 LUFS), roughly half as loud as v1, which played at full
/// level and was far too loud. Each 0.1 is 4 dB (`mixer::volume_gain`).
pub(crate) const DEFAULT_VOLUME: f32 = 0.7;

/// Where the voice service listens unless the config says otherwise.
pub(crate) const DEFAULT_VOICE_URL: &str = "http://127.0.0.1:7314";

#[derive(Clone, Debug)]
pub(crate) struct AudioConfig {
    /// Microphone by name fragment; `None` is the system default, followed
    /// live.
    pub microphone: Option<String>,
    /// Output device by name fragment; `None` is the default output,
    /// looked up again each time the output opens.
    pub output: Option<String>,
    /// The voice service's base URL (`DESIGN.md`, "Voice service contract").
    pub voice_url: String,
    pub voice: Option<String>,
    pub preset: Option<String>,
    /// Vera's volume, 0..=1.
    pub volume: f32,
    /// Whether the user's voice interrupts Vera.
    pub barge_in: bool,
    /// Which cancelled signal speech to text hears.
    pub stt_source: SttSource,
    pub ears: EarsSettings,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            microphone: None,
            output: None,
            voice_url: std::env::var("ASSISTANT_VOICE_URL")
                .unwrap_or_else(|_| DEFAULT_VOICE_URL.into()),
            voice: None,
            preset: None,
            volume: DEFAULT_VOLUME,
            barge_in: true,
            stt_source: SttSource::Hybrid,
            ears: EarsSettings::default(),
        }
    }
}

/// What the engine reports, in order. Serializes as the App ⇄ Core lines
/// (`DESIGN.md`), so the App can forward most of them as they are.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum AudioEvent {
    /// Speech to text is loaded and the microphone delivers audio.
    Ready {
        mic: String,
        engine: String,
        /// Where the model runs.
        backend: String,
    },
    /// An utterance began at `t` (Unix ms). Exactly one `Final` or
    /// `SpeechCancel` follows.
    SpeechStart {
        t: u64,
    },
    /// The utterance so far; each replaces the last.
    Partial {
        text: String,
        t: u64,
    },
    Final {
        text: String,
        start: u64,
        end: u64,
        /// The user said it over Vera: the turn that barged in.
        during_playback: bool,
    },
    SpeechCancel {
        t: u64,
        reason: String,
    },
    /// The user talked over `speak_id`, which has stopped. `Playback`
    /// `interrupted` follows for it and anything queued behind it.
    BargeIn {
        speak_id: String,
    },
    Playback {
        speak_id: String,
        state: PlaybackState,
    },
    /// Something went wrong. `fatal` means the engine stopped (speech to
    /// text could not load); everything else recovers on its own.
    Error {
        message: String,
        fatal: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PlaybackState {
    /// The first audio went to the speakers.
    Started,
    /// The last audio has been heard.
    Finished,
    /// Stopped before the end: a barge-in, `stop_playback`, or a failed
    /// output.
    Interrupted,
    /// The voice service failed; an `Error` says why.
    Failed,
}

/// Smoothed RMS levels (linear, 0..=1) for the HUD.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Levels {
    /// The user's voice: the microphone after echo cancellation, so Vera's
    /// own voice doesn't move it.
    pub mic: f32,
    /// Vera's output before her volume, so the HUD looks the same at any
    /// volume.
    pub out: f32,
}

/// State the handle reads without asking the engine thread.
#[derive(Default)]
pub(crate) struct Shared {
    pub volume: AtomicU32,
    pub mic_level: Arc<AtomicU32>,
    pub out_level: Arc<AtomicU32>,
    /// The loudest raw microphone sample since the App last looked, before
    /// echo cancellation: zero for a muted or dead microphone.
    pub raw_peak: AtomicU32,
    pub speaking: AtomicBool,
    pub muted: AtomicBool,
    /// The user has the floor (talking, or his words on their way): the
    /// mixer starts nothing new.
    pub floor: Arc<AtomicBool>,
}

pub(crate) enum Request {
    Speak {
        id: String,
        text: String,
    },
    SpeakPcm {
        id: String,
        samples: Vec<f32>,
        rate: u32,
    },
    Stop,
    /// Drops one utterance (it ends `failed`).
    Drop(String),
    Volume(f32),
    /// The voice for the next `speak`s; what's playing finishes as it was.
    Voice(Option<String>),
    /// Another microphone (`None`: the system default). Only the input
    /// reopens: playback and speech to text go on.
    Microphone(Option<String>),
    Mute(bool),
    /// The words speech to text leans toward (the assistant's name).
    Vocabulary(Vec<String>),
    Chime(ChimeKind),
    Shutdown,
}

/// The running engine. Dropping it stops the engine and closes the
/// devices.
pub(crate) struct AssistantAudio {
    requests: Sender<Request>,
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl AssistantAudio {
    /// Starts the engine. Playback works at once; speech to text loads in
    /// the background and `Ready` says when it listens. A model that isn't
    /// installed fails here.
    pub(crate) fn start(config: AudioConfig) -> Result<(Self, Receiver<AudioEvent>)> {
        config.ears.selection()?;
        let shared = Arc::new(Shared::default());
        shared
            .volume
            .store(config.volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        let (requests, receiver) = mpsc::channel();
        let (events, events_receiver) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("assistant-audio".into())
            .spawn({
                let shared = shared.clone();
                move || engine::run(config, receiver, events, shared)
            })
            .wrap_err("could not start the audio engine")?;
        Ok((
            Self {
                requests,
                shared,
                thread: Some(thread),
            },
            events_receiver,
        ))
    }

    /// Says `text` (through the voice service), after anything already
    /// queued. `Playback` events follow for `speak_id`.
    pub(crate) fn speak(&self, speak_id: impl Into<String>, text: impl Into<String>) {
        let _ = self.requests.send(Request::Speak {
            id: speak_id.into(),
            text: text.into(),
        });
    }

    /// Says `text` in `voice` (`None`: the service's default). The voice
    /// holds for later `speak`s until another is set.
    pub(crate) fn speak_as(&self, speak_id: &str, text: &str, voice: Option<String>) {
        let _ = self.requests.send(Request::Voice(voice));
        self.speak(speak_id, text);
    }

    /// Plays mono PCM at `rate` as an utterance, without the voice service.
    pub(crate) fn speak_pcm(&self, speak_id: impl Into<String>, samples: Vec<f32>, rate: u32) {
        let _ = self.requests.send(Request::SpeakPcm {
            id: speak_id.into(),
            samples,
            rate,
        });
    }

    /// Stops talking now: what plays fades out in a few ms, the queue is
    /// dropped, and each utterance gets `interrupted`. Chimes go on.
    pub(crate) fn stop_playback(&self) {
        let _ = self.requests.send(Request::Stop);
    }

    /// Drops one utterance, playing or queued: it ends `failed`.
    pub(crate) fn drop_speech(&self, speak_id: impl Into<String>) {
        let _ = self.requests.send(Request::Drop(speak_id.into()));
    }

    /// The voice for every `speak` from now on (`None`: the service's
    /// default). Nothing restarts and nothing playing is cut.
    pub(crate) fn set_voice(&self, voice: Option<String>) {
        let _ = self.requests.send(Request::Voice(voice));
    }

    /// Listens through another microphone (`None` follows the system
    /// default). Only the input reopens; `Ready` comes again naming it.
    pub(crate) fn set_microphone(&self, microphone: Option<String>) {
        let _ = self.requests.send(Request::Microphone(microphone));
    }

    /// Vera's own volume, 0..=1; it ramps there over ~60 ms. The system
    /// volume is never touched.
    pub(crate) fn set_volume(&self, level: f32) {
        let level = if level.is_finite() {
            level.clamp(0.0, 1.0)
        } else {
            DEFAULT_VOLUME
        };
        self.shared.volume.store(level.to_bits(), Ordering::Relaxed);
        let _ = self.requests.send(Request::Volume(level));
    }

    pub(crate) fn volume(&self) -> f32 {
        f32::from_bits(self.shared.volume.load(Ordering::Relaxed))
    }

    /// The words speech to text leans toward from the next utterance on
    /// (the assistant's name, so her wake word is heard); nothing reloads.
    pub(crate) fn set_vocabulary(&self, terms: Vec<String>) {
        let _ = self.requests.send(Request::Vocabulary(terms));
    }

    /// Muting closes the microphone (the system's in-use indicator goes
    /// out); an utterance in progress is cancelled with reason `muted`.
    pub(crate) fn set_mic_muted(&self, muted: bool) {
        self.shared.muted.store(muted, Ordering::Relaxed);
        let _ = self.requests.send(Request::Mute(muted));
    }

    pub(crate) fn mic_muted(&self) -> bool {
        self.shared.muted.load(Ordering::Relaxed)
    }

    pub(crate) fn chime(&self, kind: ChimeKind) {
        let _ = self.requests.send(Request::Chime(kind));
    }

    pub(crate) fn levels(&self) -> Levels {
        Levels {
            mic: f32::from_bits(self.shared.mic_level.load(Ordering::Relaxed)),
            out: f32::from_bits(self.shared.out_level.load(Ordering::Relaxed)),
        }
    }

    /// The loudest raw microphone sample (linear, 0..=1) since the last
    /// call, before echo cancellation. A microphone that is open but keeps
    /// reporting 0 is muted at the device or dead.
    pub(crate) fn take_raw_peak(&self) -> f32 {
        f32::from_bits(self.shared.raw_peak.swap(0, Ordering::Relaxed))
    }

    /// Whether Vera is talking or about to.
    pub(crate) fn speaking(&self) -> bool {
        self.shared.speaking.load(Ordering::Relaxed)
    }

    /// Whether the user has the floor: nothing of Vera's starts while he
    /// talks or his words are being transcribed.
    pub(crate) fn user_has_floor(&self) -> bool {
        self.shared.floor.load(Ordering::Relaxed)
    }
}

impl Drop for AssistantAudio {
    fn drop(&mut self) {
        let _ = self.requests.send(Request::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The clock both device streams stamp their audio on, in ns: WASAPI's
/// QPC on Windows, as cpal reports it.
pub(crate) fn now_ns() -> u64 {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Performance::{
            QueryPerformanceCounter, QueryPerformanceFrequency,
        };
        let mut counter = 0i64;
        let mut frequency = 0i64;
        // SAFETY: both write one i64 through valid pointers.
        unsafe {
            QueryPerformanceCounter(&mut counter);
            QueryPerformanceFrequency(&mut frequency);
        }
        if frequency <= 0 {
            return 0;
        }
        // In 100 ns units first, as cpal converts, so stamps compare exactly.
        let units = counter as u128 * 10_000_000 / frequency as u128;
        u64::try_from(units * 100).unwrap_or(u64::MAX)
    }
    #[cfg(not(target_os = "windows"))]
    {
        crate::audio::CaptureInstant::now().as_nanos()
    }
}
