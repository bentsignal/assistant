//! The app ⇄ Core protocol (VERA.md): JSON lines on Core's stdin and stdout.

use serde::{Deserialize, Serialize};

/// What Core asks of the app.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub(crate) enum CoreCommand {
    Speak {
        speak_id: String,
        text: String,
    },
    StopSpeaking,
    Hud {
        state: HudState,
    },
    Chime {
        kind: ChimeKind,
    },
    Show {
        #[serde(default)]
        card_id: Option<String>,
        #[serde(default)]
        title: String,
        #[serde(default)]
        markdown: String,
    },
    Hide {
        #[serde(default)]
        card_id: Option<String>,
    },
    SetVolume {
        level: f32,
    },
    Badge {
        count: u32,
    },
    /// Something failed on Core's side (the brain errored or timed out):
    /// the app chimes, flashes the HUD, and says so in Settings and the
    /// tray. `what` is a short name for it ("brain").
    Error {
        #[serde(default)]
        what: String,
        #[serde(default)]
        message: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HudState {
    Idle,
    Listening,
    Thinking,
    Speaking,
    Working,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChimeKind {
    Notify,
    Listening,
    Done,
    Error,
    #[serde(other)]
    Other,
}

/// What the app tells Core.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum AppEvent {
    /// `volume` is Vera's own level (Core starts its steps from it).
    Ready {
        mic: String,
        engine: String,
        volume: f32,
    },
    SpeechStart {
        t: u64,
    },
    Partial {
        text: String,
        t: u64,
    },
    Final {
        text: String,
        start: u64,
        end: u64,
        during_playback: bool,
    },
    SpeechCancel {
        t: u64,
        reason: String,
    },
    BargeIn {
        speak_id: String,
    },
    Playback {
        speak_id: String,
        state: &'static str,
    },
    Ui {
        action: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        card_id: Option<String>,
        /// With `settings_changed`: Vera's volume now.
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<f32>,
    },
}

impl AppEvent {
    pub(crate) fn ui(action: &'static str) -> Self {
        Self::Ui {
            action,
            card_id: None,
            volume: None,
        }
    }

    /// `settings_changed`, with the volume so Core's steps start from it.
    pub(crate) fn settings_changed(volume: f32) -> Self {
        Self::Ui {
            action: "settings_changed",
            card_id: None,
            volume: Some((volume * 100.0).round() / 100.0),
        }
    }

    pub(crate) fn line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// One of Core's stdout lines; `None` (logged) for anything else.
pub(crate) fn parse(line: &str) -> Option<CoreCommand> {
    let line = line.trim();
    if !line.starts_with('{') {
        tracing::debug!(%line, "Core printed a line that isn't a command");
        return None;
    }
    match serde_json::from_str(line) {
        Ok(command) => Some(command),
        Err(error) => {
            tracing::warn!(%error, %line, "ignored a line from Core");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_command() {
        assert_eq!(
            parse(r#"{"cmd":"speak","speak_id":"s12","text":"On it."}"#),
            Some(CoreCommand::Speak {
                speak_id: "s12".into(),
                text: "On it.".into()
            })
        );
        assert_eq!(
            parse(r#"{"cmd":"hud","state":"thinking"}"#),
            Some(CoreCommand::Hud {
                state: HudState::Thinking
            })
        );
        assert_eq!(
            parse(r#"{"cmd":"show","card_id":"c3","title":"T","markdown":"- a"}"#),
            Some(CoreCommand::Show {
                card_id: Some("c3".into()),
                title: "T".into(),
                markdown: "- a".into()
            })
        );
        assert_eq!(
            parse(r#"{"cmd":"chime","kind":"sparkle"}"#),
            Some(CoreCommand::Chime {
                kind: ChimeKind::Other
            })
        );
        assert_eq!(
            parse(r#"{"cmd":"stop_speaking"}"#),
            Some(CoreCommand::StopSpeaking)
        );
        assert_eq!(
            parse(r#"{"cmd":"error","what":"brain","message":"timed out"}"#),
            Some(CoreCommand::Error {
                what: "brain".into(),
                message: "timed out".into()
            })
        );
        assert_eq!(parse("Core v2 ready"), None);
        assert_eq!(parse(r#"{"cmd":"dance"}"#), None);
    }

    #[test]
    fn events_serialize_as_the_contract_says() {
        assert_eq!(
            AppEvent::Final {
                text: "hi".into(),
                start: 1,
                end: 2,
                during_playback: false
            }
            .line(),
            r#"{"type":"final","text":"hi","start":1,"end":2,"during_playback":false}"#
        );
        assert_eq!(
            AppEvent::ui("stop_talking").line(),
            r#"{"type":"ui","action":"stop_talking"}"#
        );
        assert_eq!(
            AppEvent::settings_changed(0.7).line(),
            r#"{"type":"ui","action":"settings_changed","volume":0.7}"#
        );
        assert_eq!(
            AppEvent::Playback {
                speak_id: "s1".into(),
                state: "interrupted"
            }
            .line(),
            r#"{"type":"playback","speak_id":"s1","state":"interrupted"}"#
        );
    }
}
