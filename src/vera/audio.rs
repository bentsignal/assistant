//! The audio engine's seam: STUB. The duplex engine (`vera/duplex`: mic,
//! echo cancellation against Vera's own playback, VAD and Parakeet, TTS
//! playback at Vera's volume, barge-in) replaces this one file; the app
//! uses nothing else from it. Swap it for the real module and keep these
//! names:
//!
//! ```ignore
//! VeraAudio::start(cfg) -> (VeraAudio, Receiver<AudioEvent>)
//! .speak(speak_id, text)   // the engine fetches PCM from the voice service and plays it
//! .stop_playback() .set_volume(f32) .set_mic_muted(bool) .chime(kind) .levels() -> (mic, out)
//! ```
//!
//! The app restarts the engine (drops it and starts another) when the
//! microphone or voice changes in Settings, since `AudioConfig` carries
//! both.
//!
//! This stub opens no device and hears nothing. It reports `Ready` at once,
//! and plays each `speak` as silence for about as long as the words would
//! take, with a synthetic output level so the HUD moves, reporting
//! `Playback` started, then finished or interrupted.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What the engine starts with.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AudioConfig {
    /// A microphone by name fragment; `None` follows the system default.
    pub(crate) microphone: Option<String>,
    /// Vera's own output gain, 0–1. Never the system volume.
    pub(crate) volume: f32,
    pub(crate) mic_muted: bool,
    /// The voice service, such as `http://127.0.0.1:7314` (VERA.md, "Voice
    /// service contract").
    pub(crate) voice_url: String,
    /// The voice to ask the service for; its default when `None`.
    pub(crate) voice: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Chime {
    Notify,
    Listening,
    Done,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlaybackState {
    Started,
    Finished,
    Interrupted,
}

impl PlaybackState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Finished => "finished",
            Self::Interrupted => "interrupted",
        }
    }
}

/// What the engine reports. Times are milliseconds since the Unix epoch.
// The stub hears nothing, so it never builds the speech events.
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum AudioEvent {
    /// The microphone is open and the speech model loaded.
    Ready { mic: String, engine: String },
    SpeechStart { t: u64 },
    Partial { text: String, t: u64 },
    Final {
        text: String,
        start: u64,
        end: u64,
        during_playback: bool,
    },
    SpeechCancel { reason: String },
    /// The user talked over Vera; playback stopped.
    BargeIn { speak_id: String },
    Playback {
        speak_id: String,
        state: PlaybackState,
    },
}

enum Command {
    Speak(String, String),
    Stop,
    Quit,
}

pub(crate) struct VeraAudio {
    commands: Sender<Command>,
    /// The output level's RMS as f32 bits, 0 while silent.
    out: Arc<AtomicU32>,
    muted: Arc<AtomicBool>,
    volume: Arc<Mutex<f32>>,
}

impl VeraAudio {
    pub(crate) fn start(cfg: AudioConfig) -> (VeraAudio, Receiver<AudioEvent>) {
        tracing::warn!(?cfg, "audio engine STUB: no microphone, no playback");
        let (events, receiver) = mpsc::channel();
        let (commands, inbox) = mpsc::channel();
        let out = Arc::new(AtomicU32::new(0));
        let level = out.clone();
        let _ = events.send(AudioEvent::Ready {
            mic: cfg
                .microphone
                .clone()
                .unwrap_or_else(|| "System default".into()),
            engine: "stub".into(),
        });
        let _ = std::thread::Builder::new()
            .name("vera-audio-stub".into())
            .spawn(move || play(inbox, events, level));
        (
            VeraAudio {
                commands,
                out,
                muted: Arc::new(AtomicBool::new(cfg.mic_muted)),
                volume: Arc::new(Mutex::new(cfg.volume)),
            },
            receiver,
        )
    }

    pub(crate) fn speak(&self, speak_id: &str, text: &str) {
        let _ = self
            .commands
            .send(Command::Speak(speak_id.into(), text.into()));
    }

    pub(crate) fn stop_playback(&self) {
        let _ = self.commands.send(Command::Stop);
    }

    pub(crate) fn set_volume(&self, level: f32) {
        *self.volume.lock().unwrap_or_else(|e| e.into_inner()) = level.clamp(0.0, 1.0);
    }

    pub(crate) fn set_mic_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    pub(crate) fn chime(&self, kind: Chime) {
        tracing::info!(?kind, "audio stub: chime");
    }

    /// The microphone's and the output's RMS over the last few
    /// milliseconds, linear 0–1 (the output before Vera's volume).
    pub(crate) fn levels(&self) -> (f32, f32) {
        (0.0, f32::from_bits(self.out.load(Ordering::Relaxed)))
    }
}

impl Drop for VeraAudio {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Quit);
    }
}

/// Plays the queue as timed silence with a speech-like level.
fn play(inbox: Receiver<Command>, events: Sender<AudioEvent>, out: Arc<AtomicU32>) {
    let mut queue: VecDeque<(String, String)> = VecDeque::new();
    let mut current: Option<(String, Instant, Duration)> = None;
    loop {
        let wait = if current.is_some() {
            Duration::from_millis(15)
        } else {
            Duration::from_secs(3600)
        };
        match inbox.recv_timeout(wait) {
            Ok(Command::Speak(id, text)) => queue.push_back((id, text)),
            Ok(Command::Stop) => {
                queue.clear();
                if let Some((id, ..)) = current.take() {
                    out.store(0, Ordering::Relaxed);
                    let _ = events.send(AudioEvent::Playback {
                        speak_id: id,
                        state: PlaybackState::Interrupted,
                    });
                }
            }
            Ok(Command::Quit) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if let Some((id, started, length)) = &current {
            let elapsed = started.elapsed();
            if elapsed >= *length {
                out.store(0, Ordering::Relaxed);
                let _ = events.send(AudioEvent::Playback {
                    speak_id: id.clone(),
                    state: PlaybackState::Finished,
                });
                current = None;
            } else {
                let level = crate::rune_hud::dot_scope::demo_level(elapsed.as_secs_f32());
                let rms = 10f32.powf((-58.0 + 28.0 * level) / 20.0);
                out.store(rms.to_bits(), Ordering::Relaxed);
            }
        }
        if current.is_none()
            && let Some((id, text)) = queue.pop_front()
        {
            let words = text.split_whitespace().count().max(1) as f32;
            let length = Duration::from_secs_f32((words * 0.3).clamp(1.0, 30.0));
            let _ = events.send(AudioEvent::Playback {
                speak_id: id.clone(),
                state: PlaybackState::Started,
            });
            current = Some((id, Instant::now(), length));
        }
    }
}
