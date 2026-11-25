//! The app: Rune's loop on the main thread (Settings window, HUD, card) and
//! a controller thread that owns everything else and routes between them:
//!
//! - Core's commands (`speak`, `stop_speaking`, `hud`, `chime`, `show`,
//!   `hide`, `set_volume`, `badge`, `error`) to the audio engine, HUD, card,
//!   and tray.
//! - The audio engine's events to Core (`ready`, `speech_start`, `partial`,
//!   `final`, `speech_cancel`, `barge_in`, `playback`).
//! - The tray, the Stop talking hotkey, and Settings to both (`ui` events).
//!
//! Nothing is ever left hanging: every `speak` gets exactly one end
//! ([`ledger`]), whatever happens to the engine or to Core; every
//! `speech_start` gets its `final` or `speech_cancel`; the HUD leaves every
//! look within a bound; and every failure is heard and seen ([`alerts`]).
//! Settings never restart the engine: a voice applies to the next line, a
//! volume at once, and a microphone reopens only the input.

mod actions;
mod alerts;
mod hud;
mod launch;
mod ledger;
mod show;

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use color_eyre::Result;
use color_eyre::eyre::eyre;
use serde_json::json;

use super::audio::{self as engine, AudioEvent, PlaybackState, VeraAudio};
use super::child::{Supervisor, Tick};
use super::config::Config;
use super::protocol::{self, AppEvent, ChimeKind, CoreCommand, HudState};
use super::trace;
use super::tray::{Tray, TrayEvent, TrayState};
use crate::app_settings::IndicatorPosition;
use crate::dictation::indicator::VeraLook;
use crate::rune_hud::{HudEvent, HudSender};
use crate::rune_ui::vera::card::{CardHandle, CardView};
use crate::rune_ui::vera::settings::VeraUi;
use crate::rune_ui::vera::{SettingsView, UiAction};
use alerts::Alerts;
use launch::{apply_start_at_login, audio_config, core_spec};
use ledger::{Ended, Ledger};

/// How long the HUD stays after Core says `idle`, so a quick next turn
/// doesn't flicker it.
const LINGER: Duration = Duration::from_millis(700);
/// How often the controller turns while a meter moves the HUD.
const METER_TICK: Duration = Duration::from_millis(30);
const IDLE_TICK: Duration = Duration::from_millis(120);
const RECENT: usize = 6;
/// A raw microphone peak at or under this (about -120 dBFS) is digital
/// silence: a muted or dead device, not a quiet room.
const SILENT_PEAK: f32 = 1e-6;
/// How long an open microphone may send only silence before Settings and
/// the tray say so.
const SILENT_FOR: Duration = Duration::from_secs(4);
/// The longest each HUD look may stay up without a change, whatever Core
/// says: listening covers the barge-in window (20 s), thinking the brain's
/// own timeout (Core gives up at 90 s), speaking a line's deadline once
/// nothing plays.
const LISTENING_CAP: Duration = Duration::from_secs(30);
const THINKING_CAP: Duration = Duration::from_secs(100);
const SPEAKING_CAP: Duration = Duration::from_secs(180);
const SPEAKING_IDLE_CAP: Duration = Duration::from_secs(4);
/// How long the HUD's error look holds before any other look shows.
const ERROR_HOLD: Duration = Duration::from_millis(1700);
/// How soon a stopped audio engine comes back: 1, 2, 5, 10, then 30 s.
const ENGINE_BACKOFF: [u64; 5] = [1, 2, 5, 10, 30];

pub(crate) enum Msg {
    CoreLine(String),
    /// An event from the audio engine of that generation.
    Audio(u64, AudioEvent),
    /// The audio engine of that generation stopped sending (it ended).
    AudioGone(u64),
    Tray(TrayEvent),
    Ui(UiAction),
    StopHotkey,
    OpenSettings,
    Voice(super::voice::Status),
    /// Rune's loop ended (logoff, or Quit already handled).
    Shutdown,
}

pub(crate) fn run(hidden: bool) -> Result<()> {
    // Rune would `_exit` at the end of its loop; Vera has children to stop
    // and a tray icon to take down after it.
    rune::orderly_exit();
    let Some(instance) = super::instance::Instance::claim(hidden)? else {
        return Ok(());
    };
    let config = Config::load();
    apply_start_at_login(&config);
    let (messages, inbox) = mpsc::channel::<Msg>();
    let (actions, ui_actions) = mpsc::channel::<UiAction>();
    {
        let messages = messages.clone();
        std::thread::Builder::new()
            .name("vera-ui-actions".into())
            .spawn(move || {
                for action in ui_actions {
                    if messages.send(Msg::Ui(action)).is_err() {
                        return;
                    }
                }
            })?;
    }
    super::sim::start(messages.clone());
    let app = crate::rune_ui::vera::settings::app(actions.clone())
        .args(crate::rune_ui::window_args())
        .on_window(|window| {
            let _ = window.with_raw_handle(|handle| {
                if let rune::raw_window_handle::RawWindowHandle::Win32(handle) = handle.as_raw() {
                    let hwnd = handle.hwnd.get() as windows_sys::Win32::Foundation::HWND;
                    crate::windows::rune::apply_window_icon(hwnd);
                    crate::windows::rune::blend_title_bar(hwnd);
                }
            });
        });
    let mut app = if hidden {
        app.windowless()
    } else {
        app.keep_running()
    }
    .release_gpu_when_closed();
    let hud = crate::rune_hud::install(&mut app);
    hud.set_position(if config.hud_bottom {
        IndicatorPosition::Bottom
    } else {
        IndicatorPosition::Top
    });
    let card = crate::rune_ui::vera::card::install(&mut app, actions);
    let window = app.handle();
    {
        let relaunch = messages.clone();
        instance.forward_launches(move || {
            let _ = relaunch.send(Msg::OpenSettings);
        });
        let messages = messages.clone();
        super::instance::forward_quit(move || {
            let _ = messages.send(Msg::Tray(TrayEvent::Quit));
        });
    }
    let controller = {
        let messages = messages.clone();
        let window = window.clone();
        std::thread::Builder::new()
            .name("vera-runtime".into())
            .spawn(move || {
                let mut controller = Controller::new(config, messages, window.clone(), hud, card);
                controller.run(inbox);
                window.quit();
            })?
    };
    let result = app.try_run();
    let _ = messages.send(Msg::Shutdown);
    // The controller stops the children and takes the tray icon down; don't
    // let a stuck child hold the process past a few seconds.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !controller.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if controller.is_finished() {
        let _ = controller.join();
    } else {
        tracing::warn!("the controller didn't stop in time; exiting anyway");
    }
    tracing::info!("Vera quit");
    result.map_err(|error| eyre!("Vera's window failed: {error}"))
}

/// Starts the HUD's GPU device and pipelines off the UI thread; cheap when
/// they're already up.
fn warm_hud() {
    rune::warm_gpu_with(
        crate::rune_hud::Painter::FEATURES,
        crate::rune_hud::prepare_gpu,
    );
}

fn look_name(look: Option<VeraLook>) -> &'static str {
    match look {
        None | Some(VeraLook::Idle) => "hidden",
        Some(VeraLook::Listening) => "listening",
        Some(VeraLook::Thinking) => "thinking",
        Some(VeraLook::Speaking) => "speaking",
        Some(VeraLook::Error) => "error",
    }
}

struct Controller {
    config: Config,
    messages: Sender<Msg>,
    window: rune::AppHandle<VeraUi>,
    hud: HudSender,
    card: CardHandle,
    tray: Option<Tray>,
    hotkey: Option<super::hotkey::Hotkey>,
    hotkey_note: Option<String>,
    core: Supervisor,
    voice_service: Supervisor,
    voice: super::voice::Status,
    /// The voice service has answered ready since it last started.
    voice_was_ready: bool,
    voice_probe: Arc<AtomicBool>,
    audio: Option<VeraAudio>,
    generation: u64,
    /// When a stopped engine starts again, and how many times in a row it
    /// has stopped.
    audio_restart_at: Option<Instant>,
    audio_failures: u32,
    /// Every `speak` until it ends.
    ledger: Ledger,
    /// A `speech_start` went to Core and its `final` or `speech_cancel`
    /// hasn't yet.
    utterance_open: bool,
    /// The engine's `Ready`: the microphone and engine it named.
    ready: Option<(String, String)>,
    /// The audio engine's last problem: (message, fatal).
    audio_error: Option<(String, bool)>,
    /// The microphone can't be opened (the engine keeps retrying).
    mic_unavailable: bool,
    /// When the open microphone last delivered anything but digital silence.
    mic_heard_at: Instant,
    /// The open microphone has sent only digital silence for `SILENT_FOR`.
    mic_silent: bool,
    muted: bool,
    /// The utterance playing now (the engine's id).
    speaking: Option<String>,
    badge: u32,
    /// Core's last `hud` state.
    core_hud: HudState,
    /// What the HUD shows; `None` while hidden.
    look: Option<VeraLook>,
    look_since: Instant,
    idle_at: Option<Instant>,
    /// The error look holds until then; other looks wait.
    error_until: Option<Instant>,
    alerts: Alerts,
    recent: VecDeque<(bool, String, Instant)>,
    /// The last transcript, until Core acts on it (thinks or speaks): only
    /// then is it a turn worth listing, not speech Vera overheard.
    heard: Option<(String, Instant)>,
    /// Whether the Run key starts Vera, as last read.
    at_login: bool,
    /// When Settings and the tray were last sent the state.
    checked_at: Instant,
    microphones: Vec<String>,
    published: Option<SettingsView>,
    published_at: Instant,
    traced_tray: Option<TrayState>,
    watched: Instant,
}

impl Controller {
    fn new(
        config: Config,
        messages: Sender<Msg>,
        window: rune::AppHandle<VeraUi>,
        hud: HudSender,
        card: CardHandle,
    ) -> Self {
        let core = {
            let messages = messages.clone();
            Supervisor::new("core", core_spec(&config), move |line| {
                let _ = messages.send(Msg::CoreLine(line));
            })
        };
        let voice_service = Supervisor::new("voice-service", super::voice::spec(&config), |line| {
            tracing::debug!(%line, "voice service");
        });
        let voice_probe = Arc::new(AtomicBool::new(false));
        {
            let messages = messages.clone();
            super::voice::probe(config.voice_url(), voice_probe.clone(), move |status| {
                let _ = messages.send(Msg::Voice(status));
            });
        }
        let tray = {
            let messages = messages.clone();
            Tray::new(
                TrayState {
                    tooltip: "Vera \u{00b7} starting".into(),
                    ..TrayState::default()
                },
                move |event| {
                    let _ = messages.send(Msg::Tray(event));
                },
            )
            .inspect_err(|error| tracing::error!(error = %format!("{error:#}"), "no tray icon"))
            .ok()
        };
        let (hotkey, hotkey_note) = {
            let messages = messages.clone();
            match super::hotkey::Hotkey::register(&config.stop_hotkey, move || {
                let _ = messages.send(Msg::StopHotkey);
            }) {
                Ok(hotkey) => (Some(hotkey), None),
                Err(error) => {
                    tracing::warn!(error = %format!("{error:#}"), "no Stop talking hotkey");
                    (None, Some(format!("{error:#}")))
                }
            }
        };
        let microphones = crate::audio::input_device_names().unwrap_or_default();
        let mut controller = Self {
            config,
            messages,
            window,
            hud,
            card,
            tray,
            hotkey,
            hotkey_note,
            core,
            voice_service,
            voice: Default::default(),
            voice_was_ready: false,
            voice_probe,
            audio: None,
            generation: 0,
            audio_restart_at: None,
            audio_failures: 0,
            ledger: Ledger::default(),
            utterance_open: false,
            ready: None,
            audio_error: None,
            mic_unavailable: false,
            mic_heard_at: Instant::now(),
            mic_silent: false,
            muted: false,
            speaking: None,
            badge: 0,
            core_hud: HudState::Idle,
            look: None,
            look_since: Instant::now(),
            idle_at: None,
            error_until: None,
            alerts: Alerts::default(),
            recent: VecDeque::new(),
            heard: None,
            at_login: super::login::registered().is_some(),
            checked_at: Instant::now(),
            microphones,
            published: None,
            published_at: Instant::now(),
            traced_tray: None,
            watched: Instant::now(),
        };
        controller.start_audio();
        controller
    }

    fn run(&mut self, inbox: Receiver<Msg>) {
        loop {
            let wait = if matches!(self.look, Some(VeraLook::Listening | VeraLook::Speaking)) {
                METER_TICK
            } else {
                IDLE_TICK
            };
            let mut next = match inbox.recv_timeout(wait) {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            let mut stop = false;
            while let Some(message) = next {
                stop |= self.handle(message);
                next = inbox.try_recv().ok();
            }
            if stop {
                break;
            }
            self.tick();
        }
        self.shutdown();
    }

    fn shutdown(&mut self) {
        tracing::info!("Vera stopping");
        self.voice_probe.store(true, Ordering::Relaxed);
        self.card.hide(None);
        self.hud.send(HudEvent::Vera(VeraLook::Idle));
        self.stop_audio("Vera is quitting");
        self.core.stop(Duration::from_millis(1500));
        self.voice_service.stop(Duration::from_millis(500));
        self.hotkey = None;
        self.tray = None;
    }

    // --- the audio engine ---------------------------------------------------

    fn start_audio(&mut self) {
        self.stop_audio("restarting the audio engine");
        self.audio_restart_at = None;
        self.ready = None;
        self.audio_error = None;
        self.mic_unavailable = false;
        self.mic_silent = false;
        self.mic_heard_at = Instant::now();
        self.generation += 1;
        let generation = self.generation;
        let (audio, events) = match VeraAudio::start(audio_config(&self.config)) {
            Ok(started) => started,
            Err(error) => {
                let message = format!("{error:#}");
                tracing::error!(%message, "the audio engine didn't start");
                self.audio_error = Some((message.clone(), true));
                self.problem("Vera can't listen", &message);
                self.schedule_audio_restart();
                return;
            }
        };
        trace::record(
            "engine",
            json!({"event": "started", "generation": generation}),
        );
        if self.muted {
            audio.set_mic_muted(true);
        }
        let messages = self.messages.clone();
        let _ = std::thread::Builder::new()
            .name("vera-audio-events".into())
            .spawn(move || {
                for event in events {
                    if messages.send(Msg::Audio(generation, event)).is_err() {
                        return;
                    }
                }
                let _ = messages.send(Msg::AudioGone(generation));
            });
        self.audio = Some(audio);
    }

    /// Stops the engine, if one runs, ending everything it had: every
    /// utterance Core is waiting on, and an utterance Shawn was in the
    /// middle of.
    fn stop_audio(&mut self, why: &str) {
        // Its last events (and its `AudioGone`) are of an old generation now.
        self.generation += 1;
        if let Some(audio) = self.audio.take() {
            trace::record("engine", json!({"event": "stopped", "why": why}));
            drop(audio);
        }
        self.end_everything(why);
    }

    /// The engine (or what it was doing) is gone: Core hears the end of
    /// every utterance it's waiting on, and of Shawn's open one.
    fn end_everything(&mut self, why: &str) {
        for ended in self.ledger.drain() {
            self.tell_ended(
                &ended,
                if ended.started {
                    "interrupted"
                } else {
                    "failed"
                },
            );
        }
        self.speaking = None;
        if self.utterance_open {
            self.utterance_open = false;
            self.tell_core(AppEvent::SpeechCancel {
                t: crate::desktop::events::now_ms(),
                reason: why.to_owned(),
            });
        }
    }

    fn schedule_audio_restart(&mut self) {
        let delay = ENGINE_BACKOFF[(self.audio_failures as usize).min(ENGINE_BACKOFF.len() - 1)];
        self.audio_failures += 1;
        self.audio_restart_at = Some(Instant::now() + Duration::from_secs(delay));
    }

    fn tell_core(&mut self, event: AppEvent) {
        let line = event.line();
        trace::record("to_core", json!({"line": line}));
        if !self.core.send_line(&line) {
            tracing::debug!(?event, "Core isn't running; dropped an event");
        }
    }

    /// Tells Core how an utterance ended (if it's this Core's).
    fn tell_ended(&mut self, ended: &Ended, state: &'static str) {
        if ended.current {
            self.tell_core(AppEvent::Playback {
                speak_id: ended.core_id.clone(),
                state,
            });
        }
        if self.speaking.as_deref() == Some(ended.engine_id.as_str()) {
            self.speaking = None;
        }
    }

    // --- problems -----------------------------------------------------------

    /// Something broke: Shawn hears it (the soft error chime), sees it (the
    /// HUD's coral look, the tray's dot), and reads it at the top of
    /// Settings.
    fn problem(&mut self, title: &str, detail: &str) {
        if self.alerts.raise(title, detail, Instant::now()) {
            self.play_chime(engine::ChimeKind::Error);
            self.flash_error();
        }
        self.publish(true);
    }

    fn play_chime(&mut self, kind: engine::ChimeKind) {
        trace::record(
            "chime",
            json!({"sound": format!("{kind:?}").to_lowercase()}),
        );
        if let Some(audio) = &self.audio {
            audio.chime(kind);
        }
    }

    // --- messages -----------------------------------------------------------

    /// Returns true to quit.
    fn handle(&mut self, message: Msg) -> bool {
        match message {
            Msg::CoreLine(line) => {
                trace::record("from_core", json!({"line": line}));
                if let Some(command) = protocol::parse(&line) {
                    self.command(command);
                }
            }
            Msg::Audio(generation, event) if generation == self.generation => {
                self.audio_event(event)
            }
            Msg::Audio(..) => {}
            Msg::AudioGone(generation) if generation == self.generation => {
                // The engine thread ended without being asked: it crashed.
                tracing::error!("the audio engine stopped");
                self.audio = None;
                self.stop_audio("the audio engine stopped");
                self.ready = None;
                self.problem(
                    "Vera's audio stopped",
                    "Starting it again; she can't hear or speak until it's back",
                );
                self.schedule_audio_restart();
            }
            Msg::AudioGone(_) => {}
            Msg::Tray(event) => return self.tray_event(event),
            Msg::Ui(action) => return self.ui_action(action),
            Msg::StopHotkey => self.stop_talking(),
            Msg::OpenSettings => self.open_settings(),
            Msg::Voice(status) => self.voice_status(status),
            Msg::Shutdown => return true,
        }
        false
    }

    fn voice_status(&mut self, status: super::voice::Status) {
        tracing::info!(
            ready = status.ready,
            voices = status.voices.len(),
            "voice service"
        );
        trace::record("voice", json!({"ready": status.ready}));
        if status.ready {
            if !self.voice.ready && self.voice_was_ready {
                tracing::info!("the voice service is back");
            }
            self.voice_was_ready = true;
            self.alerts.resolve("Vera's voice stopped");
        } else if self.voice.ready
            && matches!(self.voice_service.state, super::child::State::Running)
        {
            self.problem(
                "Vera's voice stopped",
                "The voice service stopped answering; Vera can't speak until it's back",
            );
        }
        self.voice = status;
    }

    fn command(&mut self, command: CoreCommand) {
        match command {
            CoreCommand::Speak { speak_id, text } => self.speak(speak_id, text),
            CoreCommand::StopSpeaking => {
                if let Some(audio) = &self.audio {
                    audio.stop_playback();
                }
            }
            CoreCommand::Hud { state } => self.core_hud(state),
            CoreCommand::Chime { kind } => {
                let chime = match kind {
                    ChimeKind::Notify | ChimeKind::Other => engine::ChimeKind::Notify,
                    ChimeKind::Listening => engine::ChimeKind::Listening,
                    ChimeKind::Done => engine::ChimeKind::Done,
                    ChimeKind::Error => {
                        self.problem("Something went wrong", "Core reported an error");
                        return;
                    }
                };
                self.play_chime(chime);
            }
            CoreCommand::Show {
                card_id,
                title,
                markdown,
            } => self.card.show(CardView {
                card_id,
                title,
                markdown,
            }),
            CoreCommand::Hide { card_id } => self.card.hide(card_id),
            CoreCommand::SetVolume { level } => self.set_volume(level, true, true),
            CoreCommand::Badge { count } => self.badge = count,
            CoreCommand::Error { what, message } => {
                let title = match what.as_str() {
                    "brain" => "Vera's brain failed",
                    "brain_timeout" => "Vera's brain didn't answer",
                    _ => "Something went wrong",
                };
                self.problem(title, &message);
            }
        }
    }

    fn speak(&mut self, speak_id: String, text: String) {
        self.commit_heard();
        self.remember(false, &text);
        let Some(audio) = &self.audio else {
            // No engine right now: this line ends at once, and Shawn knows.
            self.tell_core(AppEvent::Playback {
                speak_id,
                state: "failed",
            });
            self.problem(
                "Vera couldn't speak",
                "Her audio is restarting; try again in a moment",
            );
            return;
        };
        let engine_id = self.ledger.sent(&speak_id, &text, Instant::now());
        trace::record(
            "speak",
            json!({"id": engine_id, "voice": self.config.voice, "chars": text.chars().count()}),
        );
        audio.speak(&engine_id, &text);
    }

    fn audio_event(&mut self, event: AudioEvent) {
        match event {
            AudioEvent::Ready {
                mic,
                engine,
                backend,
            } => {
                tracing::info!(%mic, %engine, %backend, "audio ready");
                self.audio_failures = 0;
                self.ready = Some((mic.clone(), engine.clone()));
                self.audio_error = None;
                if self.mic_unavailable {
                    self.mic_unavailable = false;
                    self.alerts.resolve("The microphone isn't available");
                }
                self.mic_heard_at = Instant::now();
                self.alerts.resolve("Vera's audio stopped");
                self.tell_core(AppEvent::Ready {
                    mic,
                    engine,
                    volume: self.config.volume,
                });
            }
            AudioEvent::Error { message, fatal } => {
                tracing::warn!(%message, fatal, "audio engine");
                self.audio_error = Some((message.clone(), fatal));
                if fatal {
                    self.problem("Vera can't listen", &message);
                } else if message.starts_with("could not open the microphone") {
                    if !self.mic_unavailable {
                        self.mic_unavailable = true;
                        self.problem("The microphone isn't available", &message);
                    }
                } else if message.starts_with("could not play audio")
                    || message.starts_with("the output failed")
                {
                    self.problem("Vera can't play sound", &message);
                }
            }
            AudioEvent::SpeechStart { t } => {
                // The HUD may show soon: start its GPU device and pipelines
                // on a thread now, so it appears at once (as Hex does on a
                // shortcut press).
                warm_hud();
                self.utterance_open = true;
                self.tell_core(AppEvent::SpeechStart { t });
            }
            AudioEvent::Partial { text, t } => self.tell_core(AppEvent::Partial { text, t }),
            AudioEvent::Final {
                text,
                start,
                end,
                during_playback,
            } => {
                self.utterance_open = false;
                self.heard = Some((text.clone(), Instant::now()));
                self.tell_core(AppEvent::Final {
                    text,
                    start,
                    end,
                    during_playback,
                });
            }
            AudioEvent::SpeechCancel { t, reason } => {
                self.utterance_open = false;
                self.tell_core(AppEvent::SpeechCancel { t, reason })
            }
            AudioEvent::BargeIn { speak_id } => {
                // Shawn talked over her: show him at once.
                self.speaking = None;
                self.show(VeraLook::Listening);
                match self.ledger.core_id(&speak_id) {
                    Some((core_id, true)) => {
                        self.tell_core(AppEvent::BargeIn { speak_id: core_id })
                    }
                    Some((_, false)) => {}
                    None => self.tell_core(AppEvent::BargeIn {
                        speak_id: String::new(),
                    }),
                }
            }
            AudioEvent::Playback { speak_id, state } => self.playback(speak_id, state),
        }
    }

    fn playback(&mut self, engine_id: String, state: PlaybackState) {
        if state == PlaybackState::Started {
            let Some((core_id, current)) = self.ledger.core_id(&engine_id) else {
                return; // already ended (it was overdue)
            };
            self.ledger.started(&engine_id, Instant::now());
            self.speaking = Some(engine_id);
            self.show(VeraLook::Speaking);
            if current {
                self.tell_core(AppEvent::Playback {
                    speak_id: core_id,
                    state: "started",
                });
            }
            return;
        }
        let Some(ended) = self.ledger.ended(&engine_id) else {
            return;
        };
        let name = match state {
            PlaybackState::Finished => "finished",
            PlaybackState::Interrupted => "interrupted",
            PlaybackState::Failed | PlaybackState::Started => "failed",
        };
        self.tell_ended(&ended, name);
        if state == PlaybackState::Failed {
            // Vera meant to say something and couldn't.
            let detail = match &self.audio_error {
                Some((message, false)) if message.starts_with("speech ") => message.clone(),
                _ => "The voice service didn't answer".to_owned(),
            };
            self.problem("Vera couldn't speak", &detail);
        }
        // Back to what Core last said, unless it says speaking.
        if self.speaking.is_none()
            && self.look == Some(VeraLook::Speaking)
            && self.core_hud != HudState::Speaking
        {
            let state = self.core_hud;
            self.core_hud(state);
        }
    }

    /// Lists what Shawn said last, now that Core answered it.
    fn commit_heard(&mut self) {
        if let Some((text, at)) = self.heard.take()
            && at.elapsed() < Duration::from_secs(10)
        {
            self.remember(true, &text);
        }
    }

    fn remember(&mut self, you: bool, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        self.recent
            .push_back((you, text.to_owned(), Instant::now()));
        while self.recent.len() > RECENT {
            self.recent.pop_front();
        }
    }

    // --- the clock ----------------------------------------------------------

    fn tick(&mut self) {
        self.watch_children();
        if self.audio.is_none() && self.audio_restart_at.is_some_and(|at| Instant::now() >= at) {
            tracing::info!("starting the audio engine again");
            self.start_audio();
        }
        // Lines past their deadline end now, and the engine drops them.
        for ended in self.ledger.overdue(Instant::now()) {
            tracing::warn!(
                speak_id = ended.engine_id,
                started = ended.started,
                "a line ran past its deadline"
            );
            if let Some(audio) = &self.audio {
                audio.drop_speech(&ended.engine_id);
            }
            self.tell_ended(
                &ended,
                if ended.started {
                    "interrupted"
                } else {
                    "failed"
                },
            );
            self.problem(
                "Vera couldn't speak",
                if ended.started {
                    "Her voice stalled partway through a line"
                } else {
                    "Her voice didn't start in time"
                },
            );
        }
        self.keep_hud_honest();
        self.watch_microphone();
        if let Some(audio) = &self.audio {
            let engine::Levels { mic, out } = audio.levels();
            let level = match self.look {
                Some(VeraLook::Listening) => Some(mic),
                Some(VeraLook::Speaking) => Some(out),
                _ => None,
            };
            if let Some(level) = level {
                self.hud.send(HudEvent::Meter {
                    average: level,
                    peak: level,
                });
            }
        }
        if self.watched.elapsed() >= Duration::from_millis(250) {
            self.watched = Instant::now();
            // Windows' first-frame watch for the HUD; it logs its own failures.
            let _ = self.hud.failure();
        }
        self.publish(false);
    }

    fn watch_children(&mut self) {
        match self.core.tick() {
            Tick::Started => {
                // A (re)started Core starts from nothing: it hears where
                // things stand, and nothing of the old one's plays on.
                if self.ledger.new_core() > 0
                    && let Some(audio) = &self.audio
                {
                    audio.stop_playback();
                }
                self.alerts.resolve("Core stopped");
                if let Some((mic, engine)) = self.ready.clone() {
                    self.tell_core(AppEvent::Ready {
                        mic,
                        engine,
                        volume: self.config.volume,
                    });
                }
                if self.muted {
                    self.tell_core(AppEvent::ui("mute"));
                }
            }
            Tick::Exited => {
                // What the dead Core asked to say is cut, and the HUD stops
                // showing a turn nobody is running.
                if let Some(audio) = &self.audio {
                    audio.stop_playback();
                }
                self.ledger.new_core();
                self.speaking = None;
                self.core_hud = HudState::Idle;
                self.hide("core exited");
                self.problem(
                    "Core stopped",
                    "Starting it again; Vera is back in a few seconds",
                );
            }
            Tick::Nothing => {}
        }
        if self.voice_service.tick() == Tick::Exited {
            self.problem(
                "Vera's voice stopped",
                "The voice service stopped; starting it again (about 20 s)",
            );
        }
    }

    /// Notices an open microphone that sends only digital silence (muted at
    /// the device, or dead), so Settings and the tray can say so.
    fn watch_microphone(&mut self) {
        let Some(audio) = &self.audio else {
            return;
        };
        let peak = audio.take_raw_peak();
        if self.muted || self.ready.is_none() || peak > SILENT_PEAK {
            self.mic_heard_at = Instant::now();
        }
        let silent = self.mic_heard_at.elapsed() >= SILENT_FOR;
        if silent != self.mic_silent {
            self.mic_silent = silent;
            let mic = self
                .ready
                .as_ref()
                .map_or(String::new(), |(mic, _)| mic.clone());
            if silent {
                tracing::warn!(mic, "the microphone sends only silence (muted?)");
                self.problem(
                    "No sound from the microphone",
                    &format!("{mic} sends only silence. Is it muted?"),
                );
            } else {
                tracing::info!(mic, "the microphone hears sound again");
                self.alerts.resolve("No sound from the microphone");
            }
        }
    }

    /// Sends Settings and the tray what changed; Settings' relative times
    /// once a minute anyway, or now when `force`.
    fn publish(&mut self, force: bool) {
        if !force && self.checked_at.elapsed() < Duration::from_millis(200) {
            return;
        }
        self.checked_at = Instant::now();
        let view = self.view();
        let stale = self.published_at.elapsed() >= Duration::from_secs(60);
        if self.published.as_ref().map(|old| &old.status) != Some(&view.status) {
            trace::record(
                "status",
                json!({
                    "tone": format!("{:?}", view.status.tone).to_lowercase(),
                    "title": view.status.title,
                    "detail": view.status.detail,
                }),
            );
        }
        if force || stale || self.published.as_ref() != Some(&view) {
            self.published = Some(view.clone());
            self.published_at = Instant::now();
            self.window.update(move |ui, _| ui.view = view);
        }
        let tray = self.tray_state();
        if trace::enabled() && self.traced_tray.as_ref() != Some(&tray) {
            trace::record(
                "tray",
                json!({"tooltip": tray.tooltip, "problem": tray.problem, "speaking": tray.speaking}),
            );
            self.traced_tray = Some(tray.clone());
        }
        if let Some(tray_icon) = &self.tray {
            tray_icon.set(tray);
        }
    }
}
