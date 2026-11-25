//! What Settings and the tray show of the controller's state.

use std::time::Instant;

use super::super::child::State;
use super::super::protocol::HudState;
use super::super::tray::TrayState;
use super::Controller;
use crate::rune_ui::vera::{Recent, SettingsView, Status, Tone};

fn ago(at: Instant) -> String {
    let seconds = at.elapsed().as_secs();
    match seconds {
        0..45 => "just now".into(),
        45..3600 => format!("{} min ago", (seconds + 30) / 60),
        _ => format!("{} h ago", seconds / 3600),
    }
}

impl Controller {
    pub(super) fn status(&self) -> Status {
        let problem = |title: &str, detail: String| Status {
            tone: Tone::Problem,
            title: title.into(),
            detail,
        };
        match &self.core.state {
            State::Missing(why) => return problem("Core isn't set up", why.clone()),
            State::Restarting { why } => {
                return problem("Core stopped", format!("Starting it again \u{00b7} {why}"));
            }
            State::Starting | State::Running | State::Stopped => {}
        }
        if self.ready.is_none() {
            return Status {
                tone: Tone::Quiet,
                title: "Starting".into(),
                detail: "Opening the microphone and loading speech".into(),
            };
        }
        if self.muted {
            return Status {
                tone: Tone::Quiet,
                title: "Microphone muted".into(),
                detail: "Vera can't hear you until you unmute".into(),
            };
        }
        match &self.voice_service.state {
            State::Missing(why) => return problem("Vera can listen but not speak", why.clone()),
            State::Restarting { why } => {
                return problem(
                    "Voice service stopped",
                    format!("Starting it again \u{00b7} {why}"),
                );
            }
            _ => {}
        }
        Status {
            tone: Tone::Ready,
            title: "Listening".into(),
            detail: format!(
                "Say \u{201c}Vera\u{201d} to start \u{00b7} {} stops her talking",
                self.config.stop_hotkey
            ),
        }
    }

    pub(super) fn view(&self) -> SettingsView {
        let mut voices: Vec<(String, String)> = self
            .voice
            .voices
            .iter()
            .map(|voice| (voice.id.clone(), voice.name.clone()))
            .collect();
        if let Some(voice) = &self.config.voice
            && !voices.iter().any(|(id, _)| id == voice)
        {
            voices.insert(0, (voice.clone(), voice.clone()));
        }
        SettingsView {
            status: self.status(),
            muted: self.muted,
            microphones: self.microphones.clone(),
            microphone: self.config.microphone.clone(),
            volume: self.config.volume,
            voices,
            voice: self
                .config
                .voice
                .clone()
                .or_else(|| self.voice.voice.clone()),
            brain: self.config.brain,
            model: self
                .config
                .model
                .clone()
                .unwrap_or_else(|| self.config.brain.models()[0].to_string()),
            wake: self.config.wake,
            start_at_login: self.at_login,
            stop_hotkey: self.config.stop_hotkey.clone(),
            stop_hotkey_note: self.hotkey_note.clone(),
            recent: self
                .recent
                .iter()
                .rev()
                .map(|(you, text, at)| Recent {
                    you: *you,
                    text: text.clone(),
                    when: ago(*at),
                })
                .collect(),
        }
    }

    pub(super) fn tray_state(&self) -> TrayState {
        let doing = if self.speaking.is_some() {
            "speaking"
        } else if self.muted {
            "microphone muted"
        } else if self.core_hud == HudState::Working {
            "working on a job"
        } else if matches!(
            self.core.state,
            State::Missing(_) | State::Restarting { .. }
        ) {
            "Core isn't running"
        } else if self.ready.is_none() {
            "starting"
        } else {
            "listening"
        };
        let mut tooltip = format!("Vera \u{00b7} {doing}");
        if self.badge > 0 {
            tooltip.push_str(&format!(" \u{00b7} {} new", self.badge));
        }
        TrayState {
            muted: self.muted,
            speaking: self.speaking.is_some(),
            badge: self.badge,
            tooltip,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn ago_reads_like_a_person() {
        assert_eq!(ago(Instant::now()), "just now");
        let earlier = Instant::now() - Duration::from_secs(150);
        assert_eq!(ago(earlier), "3 min ago");
    }
}
