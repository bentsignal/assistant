//! Vera's windows (VERA.md), drawn with Hex's pieces: the Settings window
//! ([`settings`]) and the card Vera opens and closes ([`card`]). Their state
//! types are their own; the runtime (`crate::vera::runtime`) publishes a
//! [`SettingsView`] into the window and hears [`UiAction`]s back.

pub(crate) mod card;
mod markdown;
pub(crate) mod settings;

use std::sync::mpsc::Sender;

use crate::vera::config::{Brain, Wake};

/// What the Settings window and the card ask of the runtime.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum UiAction {
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
    EditPersonality,
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

/// Everything Settings shows, as the runtime last published it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SettingsView {
    pub(crate) status: Status,
    pub(crate) muted: bool,
    pub(crate) microphones: Vec<String>,
    pub(crate) microphone: Option<String>,
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
}

impl Default for SettingsView {
    fn default() -> Self {
        Self {
            status: Status {
                tone: Tone::Quiet,
                title: "Starting".into(),
                detail: "Vera is getting ready".into(),
            },
            muted: false,
            microphones: Vec::new(),
            microphone: None,
            volume: crate::vera::config::DEFAULT_VOLUME,
            voices: Vec::new(),
            voice: None,
            brain: Brain::ClaudeCode,
            model: "sonnet".into(),
            wake: Wake::Normal,
            start_at_login: true,
            stop_hotkey: crate::vera::config::DEFAULT_STOP_HOTKEY.into(),
            stop_hotkey_note: None,
            recent: Vec::new(),
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
