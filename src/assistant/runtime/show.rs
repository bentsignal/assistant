//! What Settings and the tray show of the controller's state.

use std::time::Instant;

use super::super::child::State;
use super::super::protocol::HudState;
use super::super::tray::TrayState;
use super::Controller;
use crate::assistant::update::{self, Phase, Snapshot};
use crate::rune_ui::assistant::{
    MicrophoneNote, Recent, SettingsView, Status, Tone, UpdateButton, UpdatesView,
};

fn ago(at: Instant) -> String {
    let seconds = at.elapsed().as_secs();
    match seconds {
        0..45 => "just now".into(),
        45..3600 => format!("{} min ago", (seconds + 30) / 60),
        _ => format!("{} h ago", seconds / 3600),
    }
}

fn ago_system(at: std::time::SystemTime) -> String {
    let seconds = at.elapsed().map_or(0, |d| d.as_secs());
    match seconds {
        0..45 => "just now".into(),
        45..3600 => format!("{} min ago", (seconds + 30) / 60),
        3600..86_400 => format!("{} h ago", seconds / 3600),
        _ => format!("{} d ago", seconds / 86_400),
    }
}

fn megabytes(bytes: u64) -> String {
    format!("{:.0} MB", bytes as f64 / 1_000_000.0)
}

/// What's new, as a few short lines: the notes' first non-heading lines.
fn note_lines(notes: &str) -> Vec<String> {
    notes
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.trim_start_matches(['-', '*', ' ']).trim().to_string())
        .filter(|line| !line.is_empty())
        .take(5)
        .map(|line| {
            if line.chars().count() > 96 {
                let cut: String = line.chars().take(95).collect();
                format!("{}\u{2026}", cut.trim_end())
            } else {
                line
            }
        })
        .collect()
}

/// Settings › Updates, from the updater's state. `can_apply`: this is an
/// installed copy (a development build can check but not switch).
pub(super) fn updates_view(snapshot: &Snapshot, can_apply: bool) -> UpdatesView {
    let check = Some(("Check for updates".to_string(), UpdateButton::Check));
    let mut view = UpdatesView {
        current: update::stamp::describe(),
        channel: snapshot.channel,
        line: String::new(),
        problem: false,
        button: check.clone(),
        progress: None,
        notes: Vec::new(),
    };
    let checked = snapshot
        .checked_at
        .map(|at| format!(" \u{00b7} checked {}", ago_system(at)))
        .unwrap_or_default();
    match &snapshot.phase {
        Phase::Idle => view.line = "Not checked yet".into(),
        Phase::Checking => {
            view.line = "Checking\u{2026}".into();
            view.button = None;
        }
        Phase::UpToDate => view.line = format!("Up to date{checked}"),
        Phase::NoRelease => {
            view.line = format!("No {} release yet{checked}", snapshot.channel.name());
        }
        Phase::Available(offer) => {
            let day = update::stamp::day(&offer.date)
                .map(|day| format!(" ({day})"))
                .unwrap_or_default();
            let switching = offer.channel != update::stamp::CHANNEL;
            view.line = format!(
                "{} is available{day} \u{00b7} {}",
                offer.title(),
                megabytes(offer.size)
            );
            view.notes = note_lines(&offer.notes);
            if can_apply {
                let label = if switching && offer.channel == "stable" {
                    format!("Switch to {}", offer.title())
                } else {
                    "Update".to_string()
                };
                view.button = Some((label, UpdateButton::Install));
            } else {
                view.line
                    .push_str(" \u{00b7} a development build doesn't update itself");
            }
        }
        Phase::Downloading { offer, got, total } => {
            let fraction = if *total > 0 {
                (*got as f32 / *total as f32).clamp(0.0, 1.0)
            } else {
                0.0
            };
            view.line = format!(
                "Downloading {} \u{00b7} {:.0}% of {}",
                offer.title(),
                fraction * 100.0,
                megabytes(*total)
            );
            view.progress = Some(fraction);
            view.notes = note_lines(&offer.notes);
            view.button = None;
        }
        Phase::Preparing { offer, what } => {
            view.line = format!("{} \u{00b7} {what}\u{2026}", offer.title());
            view.notes = note_lines(&offer.notes);
            view.button = None;
        }
        Phase::Ready(offer) => {
            view.line = format!("Restarting into {}\u{2026}", offer.title());
            view.button = None;
        }
        Phase::Failed { message, offer } => {
            view.problem = true;
            match offer {
                Some(offer) => {
                    view.line = format!("Couldn't update to {}: {message}", offer.title());
                    if can_apply {
                        view.button = Some(("Try again".to_string(), UpdateButton::Install));
                    }
                }
                None => view.line = format!("Couldn't check for updates: {message}"),
            }
        }
    }
    // A switch that was rolled back in the last day, said while it's quiet.
    if let Some(failed) = &snapshot.rolled_back
        && matches!(
            snapshot.phase,
            Phase::Idle | Phase::UpToDate | Phase::NoRelease | Phase::Available(_)
        )
        && update::install::now().saturating_sub(failed.at) < 86_400
        && failed.label != update::stamp::LABEL
    {
        view.notes.insert(
            0,
            format!(
                "{} didn't start ({}), so this version stayed",
                failed.label, failed.reason
            ),
        );
    }
    view
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
                title: "Not listening".into(),
                detail: "{name} is off: nothing wakes her. Turn Listening back on from the tray"
                    .into(),
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
                "Say \u{201c}{}\u{201d} to start \u{00b7} {} stops her talking",
                self.config
                    .personas
                    .iter()
                    .find(|p| p.enabled)
                    .and_then(|p| p.phrases().into_iter().next())
                    .unwrap_or_else(|| format!("hey {}", self.config.name)),
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
            updates: updates_view(&self.updates.snapshot(), update::can_apply()),
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
            "not listening".into()
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
        let snapshot = self.updates.snapshot();
        let update = match &snapshot.phase {
            Phase::Available(offer) if update::can_apply() => Some(offer.title()),
            _ => None,
        };
        if let Some(title) = &update {
            tooltip.push_str(&format!(" \u{00b7} {title} available"));
        }
        TrayState {
            update_dot: update.is_some() && self.config.updates.tray_badge,
            update,
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
