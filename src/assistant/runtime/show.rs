//! What Settings and the tray show of the controller's state.

use std::time::Instant;

use super::super::child::State;
use super::super::protocol::HudState;
use super::super::tray::TrayState;
use super::Controller;
use crate::rune_ui::assistant::{MicrophoneNote, Recent, SettingsView, Status, Tone};

fn ago(at: Instant) -> String {
    let seconds = at.elapsed().as_secs();
    match seconds {
        0..45 => "just now".into(),
        45..3600 => format!("{} min ago", (seconds + 30) / 60),
        _ => format!("{} h ago", seconds / 3600),
    }
}

impl Controller {
    /// What the status line says, in the assistant's name.
    pub(super) fn status(&self) -> Status {
        let status = self.status_template();
        Status {
            title: self.named(&status.title),
            detail: self.named(&status.detail),
            ..status
        }
    }

    /// `text` with `{name}` as the assistant's name.
    pub(super) fn named(&self, text: &str) -> String {
        text.replace("{name}", &self.config.name)
    }

    fn status_template(&self) -> Status {
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
        if let Some((message, true)) = &self.audio_error {
            return problem("{name} can't listen", message.clone());
        }
        if self.audio.is_none() && self.audio_restart_at.is_some() {
            return problem(
                "{name}'s audio stopped",
                "Starting it again \u{00b7} she can't hear or speak until it's back".into(),
            );
        }
        if self.ready.is_none() {
            if self.mic_unavailable
                && let Some((message, false)) = &self.audio_error
            {
                return problem("The microphone isn't available", message.clone());
            }
            if let Some((message, false)) = &self.audio_error {
                return problem("Starting", message.clone());
            }
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
                detail: "{name} can't hear you until you unmute".into(),
            };
        }
        match &self.voice_service.state {
            State::Missing(why) => return problem("{name} can listen but not speak", why.clone()),
            State::Restarting { why } => {
                return problem(
                    "Voice service stopped",
                    format!("Starting it again \u{00b7} {why}"),
                );
            }
            _ => {}
        }
        if !self.voice.ready {
            if self.voice_was_ready {
                return problem(
                    "{name}'s voice stopped",
                    "Starting it again \u{00b7} she can listen, but can't speak until it's back"
                        .into(),
                );
            }
            return Status {
                tone: Tone::Quiet,
                title: "Listening".into(),
                detail: "{name}'s voice is still loading".into(),
            };
        }
        // A problem that passed stays here a minute, so it's never missed.
        if let Some(alert) = self.alerts.recent(Instant::now()) {
            return problem(
                &alert.title,
                format!("{} \u{00b7} {}", alert.detail, ago(alert.at)),
            );
        }
        Status {
            tone: Tone::Ready,
            title: "Listening".into(),
            detail: format!(
                "Say \u{201c}{{name}}\u{201d} to start \u{00b7} {} stops her talking",
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
            name: self.config.name.clone(),
            personas: self.config.personas.clone(),
            muted: self.muted,
            microphones: self.microphones.clone(),
            microphone: self.config.microphone.clone(),
            microphone_note: self.microphone_note(),
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

    /// Which microphone Vera hears through, and whether it sends only
    /// silence.
    fn microphone_note(&self) -> Option<MicrophoneNote> {
        let (mic, _) = self.ready.as_ref()?;
        Some(if self.mic_silent {
            MicrophoneNote {
                text: self.named(&format!(
                    "{mic} has sent no sound yet. If {{name}} can't hear you, check it isn't muted"
                )),
            }
        } else {
            MicrophoneNote {
                text: format!("Hearing {mic}"),
            }
        })
    }

    pub(super) fn tray_state(&self) -> TrayState {
        let status = self.status();
        let problem = status.tone == Tone::Problem;
        let doing = if problem {
            status.title.clone()
        } else if self.speaking.is_some() {
            "speaking".into()
        } else if self.muted {
            "microphone muted".into()
        } else if self.core_hud == HudState::Working {
            "working on a job".into()
        } else if self.ready.is_none() {
            "starting".into()
        } else {
            "listening".into()
        };
        let names: Vec<&str> = self
            .config
            .personas
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        let mut tooltip = format!("{} \u{00b7} {doing}", names.join(", "));
        if self.badge > 0 {
            tooltip.push_str(&format!(" \u{00b7} {} new", self.badge));
        }
        TrayState {
            muted: self.muted,
            speaking: self.speaking.is_some(),
            badge: self.badge,
            problem,
            name: self.config.name.clone(),
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
