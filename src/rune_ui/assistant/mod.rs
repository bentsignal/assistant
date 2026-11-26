//! Vera's windows (DESIGN.md), drawn with Hex's pieces: the Settings window
//! ([`settings`]) and the card Vera opens and closes ([`card`]). Their state
//! types are their own; the runtime (`crate::assistant::runtime`) publishes a
//! [`SettingsView`] into the window and hears [`UiAction`]s back.

pub(crate) mod card;
mod markdown;
pub(crate) mod settings;
pub(crate) mod shots;

use std::sync::mpsc::Sender;

use crate::assistant::config::{Brain, Persona, Wake};
use crate::assistant::update::Channel;

/// What the Settings window and the card ask of the runtime.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum UiAction {
    /// Her names as Settings lists them (renamed, added, or one removed).
    SetPersonas(Vec<Persona>),
    /// One persona's voice.
    SetPersonaVoice {
        index: usize,
        voice: String,
    },
    SetMicrophone(Option<String>),
    /// `done` once the drag ends: only then is it saved.
    SetVolume {
        level: f32,
        done: bool,
    },
    SetVoice(Option<String>),
    SetBrain(Brain),
    SetModel(String),
    SetWake(Wake),
    SetStartAtLogin(bool),
    SetMuted(bool),
    /// Settings › Updates: the channel to follow (checks it at once).
    SetUpdateChannel(Channel),
    CheckForUpdates,
    /// Download, verify, and switch to the offered release.
    InstallUpdate,
    /// The card's close button: the card it showed.
    CardClosed(Option<String>),
    Quit,
}

/// The status line at the top of Settings, like Hex's.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum Tone {
    /// Green: listening.
    Ready,
    /// Grey: starting, or muted.
    #[default]
    Quiet,
    /// Red: something Vera needs isn't running.
    Problem,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Status {
    pub(crate) tone: Tone,
    pub(crate) title: String,
    pub(crate) detail: String,
}

/// One line of recent activity: what Shawn said or what Vera said.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Recent {
    pub(crate) you: bool,
    pub(crate) text: String,
    /// Such as "2 min ago", made when published.
    pub(crate) when: String,
}

/// The line under Microphone: the device Vera hears, or a quiet hint that
/// it has sent only silence for minutes (muted at the device?).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MicrophoneNote {
    pub(crate) text: String,
}

/// What Settings › Updates offers to do now.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UpdateButton {
    Check,
    Install,
}

/// Settings › Updates.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct UpdatesView {
    /// This build: "2.0.0 · Nightly abc1234".
    pub(crate) current: String,
    pub(crate) channel: Channel,
    /// "Up to date · checked 2 min ago", "Nightly abc1234 is available",
    /// "Downloading 45%", …
    pub(crate) line: String,
    /// The line is a failure (its colour).
    pub(crate) problem: bool,
    /// What the button does; `None` while busy.
    pub(crate) button: Option<(String, UpdateButton)>,
    /// Download progress, 0 to 1.
    pub(crate) progress: Option<f32>,
    /// What's new in the offered release: a few short lines.
    pub(crate) notes: Vec<String>,
}

impl Default for UpdatesView {
    fn default() -> Self {
        Self {
            current: "2.0.0".into(),
            channel: Channel::Stable,
            line: "Not checked yet".into(),
            problem: false,
            button: Some(("Check for updates".into(), UpdateButton::Check)),
            progress: None,
            notes: Vec::new(),
        }
    }
}

/// Everything Settings shows, as the runtime last published it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SettingsView {
    pub(crate) status: Status,
    /// The assistant's name (`assistant.name`): the first persona's.
    pub(crate) name: String,
    /// Her names, each with its voice (`assistant.personas`).
    pub(crate) personas: Vec<Persona>,
    pub(crate) muted: bool,
    pub(crate) microphones: Vec<String>,
    pub(crate) microphone: Option<String>,
    pub(crate) microphone_note: Option<MicrophoneNote>,
    pub(crate) volume: f32,
    /// (id, name).
    pub(crate) voices: Vec<(String, String)>,
    pub(crate) voice: Option<String>,
    pub(crate) brain: Brain,
    pub(crate) model: String,
    pub(crate) wake: Wake,
    pub(crate) start_at_login: bool,
    pub(crate) stop_hotkey: String,
    /// Why the hotkey isn't registered, if it isn't.
    pub(crate) stop_hotkey_note: Option<String>,
    pub(crate) recent: Vec<Recent>,
    pub(crate) updates: UpdatesView,
}

impl Default for SettingsView {
    fn default() -> Self {
        Self {
            status: Status {
                tone: Tone::Quiet,
                title: "Starting".into(),
                detail: "Getting ready".into(),
            },
            name: crate::assistant::config::DEFAULT_NAME.into(),
            personas: crate::assistant::config::default_personas(
                crate::assistant::config::DEFAULT_NAME,
            ),
            muted: false,
            microphones: Vec::new(),
            microphone: None,
            microphone_note: None,
            volume: crate::assistant::config::DEFAULT_VOLUME,
            voices: Vec::new(),
            voice: None,
            brain: Brain::ClaudeCode,
            model: "sonnet".into(),
            wake: Wake::Normal,
            start_at_login: true,
            stop_hotkey: crate::assistant::config::DEFAULT_STOP_HOTKEY.into(),
            stop_hotkey_note: None,
            recent: Vec::new(),
            updates: UpdatesView::default(),
        }
    }
}

/// Where a window's actions go; `None` in renders.
pub(crate) type Actions = Option<Sender<UiAction>>;

fn send(actions: &Actions, action: UiAction) {
    if let Some(actions) = actions {
        let _ = actions.send(action);
    }
}
