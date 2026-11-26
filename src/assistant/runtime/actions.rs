//! What the tray, the Settings window, and the Stop talking hotkey ask for.
//! None of it restarts the audio engine: a voice applies to the next line, a
//! volume at once, and a microphone reopens only the input.

use std::time::Instant;

use serde_json::json;

use super::Controller;
use crate::assistant::config::{self, Config};
use crate::assistant::protocol::AppEvent;
use crate::assistant::trace;
use crate::assistant::tray::TrayEvent;
use crate::dictation::indicator::AssistantLook;
use crate::rune_ui::assistant::UiAction;

impl Controller {
    pub(super) fn tray_event(&mut self, event: TrayEvent) -> bool {
        match event {
            TrayEvent::Settings => self.open_settings(),
            TrayEvent::ToggleMute => self.set_muted(!self.muted),
            TrayEvent::StopTalking => self.stop_talking(),
            TrayEvent::Quit => return true,
        }
        false
    }

    pub(super) fn ui_action(&mut self, action: UiAction) -> bool {
        trace::record("ui", json!({"action": format!("{action:?}")}));
        match action {
            UiAction::SetUpdateChannel(channel) => {
                if self.config.updates.channel != Some(channel) {
                    self.save(|root| {
                        *config::slot(root, &["app", "updates", "channel"]) = json!(channel.key())
                    });
                }
                self.updates.set_channel(channel);
                self.publish(true);
            }
            UiAction::CheckForUpdates => self.updates.check(),
            UiAction::InstallUpdate => {
                let messages = self.messages.clone();
                self.updates.install(move |offer| {
                    let _ = messages.send(super::Msg::UpdateReady(offer));
                });
            }
            UiAction::SetMicrophone(microphone) => {
                if microphone != self.config.microphone {
                    self.save(|root| {
                        *config::slot(root, &["app", "microphone"]) = json!(microphone)
                    });
                    // Only the input reopens; Vera keeps talking.
                    self.mic_silent = false;
                    self.mic_heard_at = Instant::now();
                    match &self.audio {
                        Some(audio) => audio.set_microphone(microphone),
                        None => self.start_audio(),
                    }
                }
            }
            UiAction::SetVolume { level, done } => self.set_volume(level, done, false),
            UiAction::SetPersonas(personas) => self.set_personas(personas),
            UiAction::SetPersonaVoice { index, voice } => {
                let mut personas = self.config.personas.clone();
                if let Some(persona) = personas.get_mut(index) {
                    persona.voice = voice;
                    self.set_personas(personas);
                }
            }
            UiAction::SetVoice(voice) => {
                if voice != self.config.voice {
                    self.save(|root| *config::slot(root, &["app", "voice"]) = json!(voice));
                    // The next line uses it; nothing restarts.
                    if let Some(audio) = &self.audio {
                        audio.set_voice(voice);
                    }
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
                if let Err(error) = crate::assistant::login::apply(enabled) {
                    tracing::warn!(error = %format!("{error:#}"), "could not change start at login");
                }
                self.at_login = crate::assistant::login::registered().is_some();
            }
            UiAction::SetMuted(muted) => self.set_muted(muted),
            UiAction::CardClosed(card_id) => self.tell_core(AppEvent::Ui {
                action: "card_closed",
                card_id,
                volume: None,
            }),
            UiAction::Quit => return true,
        }
        false
    }

    /// Saves her names (the first is `assistant.name` too); the vocabulary,
    /// tray and Settings follow, and Core rereads them.
    fn set_personas(&mut self, personas: Vec<crate::assistant::config::Persona>) {
        if personas.is_empty() || personas == self.config.personas {
            self.publish(true);
            return;
        }
        let list: Vec<serde_json::Value> = personas.iter().map(|p| p.to_json()).collect();
        let first = personas[0].name.clone();
        self.save(|root| {
            *config::slot(root, &["assistant", "personas"]) = json!(list);
            *config::slot(root, &["assistant", "name"]) = json!(first);
        });
        self.apply_name();
        self.tell_core(AppEvent::settings_changed(self.config.volume));
    }

    fn save(&mut self, edit: impl FnOnce(&mut serde_json::Value)) {
        if let Err(error) = config::save(edit) {
            tracing::error!(error = %format!("{error:#}"), "could not save config.json");
        }
        self.config = Config::load();
    }

    pub(super) fn set_volume(&mut self, level: f32, persist: bool, from_core: bool) {
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
        if muted && self.look == Some(AssistantLook::Listening) {
            self.idle_at = Some(Instant::now());
        }
    }

    pub(super) fn stop_talking(&mut self) {
        if let Some(audio) = &self.audio {
            audio.stop_playback();
        }
        self.tell_core(AppEvent::ui("stop_talking"));
    }

    pub(super) fn open_settings(&mut self) {
        self.microphones = crate::audio::input_device_names().unwrap_or_default();
        self.at_login = crate::assistant::login::registered().is_some();
        self.publish(true);
        self.window.open();
        self.window.focus();
    }
}
