//! The app: Rune's loop on the main thread (Settings window, HUD, card) and
//! a controller thread that owns everything else and routes between them:
//!
//! - Core's commands (`speak`, `stop_speaking`, `hud`, `chime`, `show`,
//!   `hide`, `set_volume`, `badge`) to the audio engine, HUD, card, and tray.
//! - The audio engine's events to Core (`ready`, `speech_start`, `partial`,
//!   `final`, `speech_cancel`, `barge_in`, `playback`).
//! - The tray, the Stop talking hotkey, and Settings to both (`ui` events).
//!
//! The HUD follows Core's `hud` state, lingers a moment after `idle`, and
//! takes Vera's own playback and barge-ins into account at once, before
//! Core says so. `working` keeps the HUD hidden (the tray says it).

mod launch;
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
use super::child::Supervisor;
use super::config::{self, Config};
use super::protocol::{self, AppEvent, ChimeKind, CoreCommand, HudState};
use super::tray::{Tray, TrayEvent, TrayState};
use crate::app_settings::IndicatorPosition;
use crate::dictation::indicator::VeraLook;
use crate::rune_hud::{HudEvent, HudSender};
use crate::rune_ui::vera::card::{CardHandle, CardView};
use crate::rune_ui::vera::settings::VeraUi;
use crate::rune_ui::vera::{SettingsView, UiAction};
use launch::{apply_start_at_login, audio_config, core_spec, edit_personality};

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

pub(crate) enum Msg {
    CoreLine(String),
    /// An event from the audio engine of that generation.
    Audio(u64, AudioEvent),
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
    voice_probe: Arc<AtomicBool>,
    audio: Option<VeraAudio>,
    generation: u64,
    /// The engine's `Ready`: the microphone and engine it named.
    ready: Option<(String, String)>,
    /// The audio engine's last problem: (message, fatal).
    audio_error: Option<(String, bool)>,
    /// When the open microphone last delivered anything but digital silence.
    mic_heard_at: Instant,
    /// The open microphone has sent only digital silence for `SILENT_FOR`.
    mic_silent: bool,
    muted: bool,
    /// The utterance playing now.
    speaking: Option<String>,
    badge: u32,
    /// Core's last `hud` state.
    core_hud: HudState,
    /// What the HUD shows; `None` while hidden.
    look: Option<VeraLook>,
    idle_at: Option<Instant>,
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
            voice_probe,
            audio: None,
            generation: 0,
            ready: None,
            audio_error: None,
            mic_heard_at: Instant::now(),
            mic_silent: false,
            muted: false,
            speaking: None,
            badge: 0,
            core_hud: HudState::Idle,
            look: None,
            idle_at: None,
            recent: VecDeque::new(),
            heard: None,
            at_login: super::login::registered().is_some(),
            checked_at: Instant::now(),
            microphones,
            published: None,
            published_at: Instant::now(),
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
        self.audio = None;
        self.core.stop(Duration::from_millis(1500));
        self.voice_service.stop(Duration::from_millis(500));
        self.hotkey = None;
        self.tray = None;
    }

    fn start_audio(&mut self) {
        self.audio = None;
        self.ready = None;
        self.audio_error = None;
        self.mic_silent = false;
        self.mic_heard_at = Instant::now();
        self.generation += 1;
        let generation = self.generation;
        let (audio, events) = match VeraAudio::start(audio_config(&self.config)) {
            Ok(started) => started,
            Err(error) => {
                let message = format!("{error:#}");
                tracing::error!(%message, "the audio engine didn't start");
                self.audio_error = Some((message, true));
                return;
            }
        };
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
            });
        self.audio = Some(audio);
    }

    fn tell_core(&mut self, event: AppEvent) {
        if !self.core.send_line(&event.line()) {
            tracing::debug!(?event, "Core isn't running; dropped an event");
        }
    }

    /// Returns true to quit.
    fn handle(&mut self, message: Msg) -> bool {
        match message {
            Msg::CoreLine(line) => {
                if let Some(command) = protocol::parse(&line) {
                    self.command(command);
                }
            }
            Msg::Audio(generation, event) if generation == self.generation => {
                self.audio_event(event)
            }
            Msg::Audio(..) => {}
            Msg::Tray(event) => return self.tray_event(event),
            Msg::Ui(action) => return self.ui_action(action),
            Msg::StopHotkey => self.stop_talking(),
            Msg::OpenSettings => self.open_settings(),
            Msg::Voice(status) => {
                tracing::info!(
                    ready = status.ready,
                    voices = status.voices.len(),
                    "voice service"
                );
                self.voice = status;
            }
            Msg::Shutdown => return true,
        }
        false
    }

    fn command(&mut self, command: CoreCommand) {
        match command {
            CoreCommand::Speak { speak_id, text } => {
                self.commit_heard();
                self.remember(false, &text);
                if let Some(audio) = &self.audio {
                    audio.speak(&speak_id, &text);
                }
            }
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
                    ChimeKind::Error => engine::ChimeKind::Error,
                };
                if let Some(audio) = &self.audio {
                    audio.chime(chime);
                }
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
        }
    }

    fn core_hud(&mut self, state: HudState) {
        self.core_hud = state;
        if matches!(state, HudState::Thinking | HudState::Speaking) {
            self.commit_heard();
        }
        match state {
            HudState::Listening => self.show(VeraLook::Listening),
            HudState::Thinking => self.show(VeraLook::Thinking),
            HudState::Speaking => self.show(VeraLook::Speaking),
            HudState::Idle | HudState::Working => {
                // Vera's own voice still playing keeps the speaking look.
                if self.speaking.is_none() && self.look.is_some() && self.idle_at.is_none() {
                    self.idle_at = Some(Instant::now() + LINGER);
                }
            }
        }
    }

    fn show(&mut self, look: VeraLook) {
        self.idle_at = None;
        if self.look.is_none() {
            warm_hud();
        }
        if self.look != Some(look) {
            self.look = Some(look);
            self.hud.send(HudEvent::Vera(look));
        }
    }

    fn audio_event(&mut self, event: AudioEvent) {
        match event {
            AudioEvent::Ready {
                mic,
                engine,
                backend,
            } => {
                tracing::info!(%mic, %engine, %backend, "audio ready");
                self.ready = Some((mic.clone(), engine.clone()));
                self.audio_error = None;
                self.mic_heard_at = Instant::now();
                self.tell_core(AppEvent::Ready {
                    mic,
                    engine,
                    volume: self.config.volume,
                });
            }
            AudioEvent::Error { message, fatal } => {
                tracing::warn!(%message, fatal, "audio engine");
                self.audio_error = Some((message, fatal));
            }
            AudioEvent::SpeechStart { t } => {
                // The HUD may show soon: start its GPU device and pipelines
                // on a thread now, so it appears at once (as Hex does on a
                // shortcut press).
                warm_hud();
                self.tell_core(AppEvent::SpeechStart { t });
            }
            AudioEvent::Partial { text, t } => self.tell_core(AppEvent::Partial { text, t }),
            AudioEvent::Final {
                text,
                start,
                end,
                during_playback,
            } => {
                self.heard = Some((text.clone(), Instant::now()));
                self.tell_core(AppEvent::Final {
                    text,
                    start,
                    end,
                    during_playback,
                });
            }
            AudioEvent::SpeechCancel { t, reason } => {
                self.tell_core(AppEvent::SpeechCancel { t, reason })
            }
            AudioEvent::BargeIn { speak_id } => {
                // Shawn talked over her: show him at once.
                self.speaking = None;
                self.show(VeraLook::Listening);
                self.tell_core(AppEvent::BargeIn { speak_id });
            }
            AudioEvent::Playback { speak_id, state } => {
                match state {
                    PlaybackState::Started => {
                        self.speaking = Some(speak_id.clone());
                        self.show(VeraLook::Speaking);
                    }
                    PlaybackState::Finished
                    | PlaybackState::Interrupted
                    | PlaybackState::Failed => {
                        if state == PlaybackState::Failed
                            && let Some(audio) = &self.audio
                        {
                            // Vera meant to say something and couldn't.
                            audio.chime(engine::ChimeKind::Error);
                        }
                        if self.speaking.as_deref() == Some(speak_id.as_str()) {
                            self.speaking = None;
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
                }
                let state = match state {
                    PlaybackState::Started => "started",
                    PlaybackState::Finished => "finished",
                    PlaybackState::Interrupted => "interrupted",
                    PlaybackState::Failed => "failed",
                };
                self.tell_core(AppEvent::Playback { speak_id, state });
            }
        }
    }

    fn tray_event(&mut self, event: TrayEvent) -> bool {
        match event {
            TrayEvent::Settings => self.open_settings(),
            TrayEvent::ToggleMute => self.set_muted(!self.muted),
            TrayEvent::StopTalking => self.stop_talking(),
            TrayEvent::Quit => return true,
        }
        false
    }

    fn ui_action(&mut self, action: UiAction) -> bool {
        match action {
            UiAction::SetMicrophone(microphone) => {
                if microphone != self.config.microphone {
                    self.save(|root| {
                        *config::slot(root, &["app", "microphone"]) = json!(microphone)
                    });
                    self.start_audio();
                }
            }
            UiAction::SetVolume { level, done } => self.set_volume(level, done, false),
            UiAction::SetVoice(voice) => {
                if voice != self.config.voice {
                    self.save(|root| *config::slot(root, &["app", "voice"]) = json!(voice));
                    self.start_audio();
                }
            }
            UiAction::SetBrain(brain) => {
                let has_model = self.config.brain == brain && self.config.model.is_some();
                let model = brain.models()[0];
                self.save(|root| {
                    *config::slot(root, &["brain", "harness"]) = json!(brain.key());
                    let slot = config::slot(root, &["brain", brain.key(), "model"]);
                    if slot.is_null() && !has_model {
                        *slot = json!(model);
                    }
                });
                self.tell_core(AppEvent::settings_changed(self.config.volume));
            }
            UiAction::SetModel(model) => {
                let brain = self.config.brain;
                self.save(|root| {
                    *config::slot(root, &["brain", brain.key(), "model"]) = json!(model)
                });
                self.tell_core(AppEvent::settings_changed(self.config.volume));
            }
            UiAction::SetWake(wake) => {
                self.save(|root| *config::slot(root, &["wake", "sensitivity"]) = json!(wake.key()));
                self.tell_core(AppEvent::settings_changed(self.config.volume));
            }
            UiAction::SetStartAtLogin(enabled) => {
                self.save(|root| *config::slot(root, &["app", "startAtLogin"]) = json!(enabled));
                if let Err(error) = super::login::apply(enabled) {
                    tracing::warn!(error = %format!("{error:#}"), "could not change start at login");
                }
                self.at_login = super::login::registered().is_some();
            }
            UiAction::SetMuted(muted) => self.set_muted(muted),
            UiAction::EditPersonality => edit_personality(&self.config),
            UiAction::CardClosed(card_id) => self.tell_core(AppEvent::Ui {
                action: "card_closed",
                card_id,
                volume: None,
            }),
            UiAction::Quit => return true,
        }
        false
    }

    fn save(&mut self, edit: impl FnOnce(&mut serde_json::Value)) {
        if let Err(error) = config::save(edit) {
            tracing::error!(error = %format!("{error:#}"), "could not save config.json");
        }
        self.config = Config::load();
    }

    fn set_volume(&mut self, level: f32, persist: bool, from_core: bool) {
        let level = level.clamp(0.0, 1.0);
        if let Some(audio) = &self.audio {
            audio.set_volume(level);
        }
        self.config.volume = level;
        if persist {
            self.save(|root| {
                *config::slot(root, &["app", "volume"]) =
                    json!((f64::from(level) * 100.0).round() / 100.0);
            });
        }
        // Core works out "quieter" from Vera's level; a change it didn't
        // make (the Settings slider) is news to it.
        if persist && !from_core {
            self.tell_core(AppEvent::settings_changed(level));
        }
    }

    fn set_muted(&mut self, muted: bool) {
        if muted == self.muted {
            return;
        }
        self.muted = muted;
        if let Some(audio) = &self.audio {
            audio.set_mic_muted(muted);
        }
        self.tell_core(AppEvent::ui(if muted { "mute" } else { "unmute" }));
        if muted && self.look == Some(VeraLook::Listening) {
            self.idle_at = Some(Instant::now());
        }
    }

    fn stop_talking(&mut self) {
        if let Some(audio) = &self.audio {
            audio.stop_playback();
        }
        self.tell_core(AppEvent::ui("stop_talking"));
    }

    fn open_settings(&mut self) {
        self.microphones = crate::audio::input_device_names().unwrap_or_default();
        self.at_login = super::login::registered().is_some();
        self.publish(true);
        self.window.open();
        self.window.focus();
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

    fn tick(&mut self) {
        if self.core.tick() {
            // A (re)started Core hears where things stand.
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
        self.voice_service.tick();
        if self.idle_at.is_some_and(|at| Instant::now() >= at) {
            self.idle_at = None;
            if self.look.take().is_some() {
                self.hud.send(HudEvent::Vera(VeraLook::Idle));
            }
        }
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
            let mic = self.ready.as_ref().map_or("", |(mic, _)| mic.as_str());
            if silent {
                tracing::warn!(mic, "the microphone sends only silence (muted?)");
            } else {
                tracing::info!(mic, "the microphone hears sound again");
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
        if force || stale || self.published.as_ref() != Some(&view) {
            self.published = Some(view.clone());
            self.published_at = Instant::now();
            self.window.update(move |ui, _| ui.view = view);
        }
        if let Some(tray) = &self.tray {
            tray.set(self.tray_state());
        }
    }
}
