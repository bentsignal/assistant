//! The HUD as the controller drives it: Core's `hud` states, Vera's own
//! playback, the error look (which other looks wait for), and the caps that
//! make every look end, whatever Core last said.

use std::time::Instant;

use super::{
    Controller, ERROR_HOLD, LINGER, LISTENING_CAP, SPEAKING_CAP, SPEAKING_IDLE_CAP, THINKING_CAP,
    look_name, warm_hud,
};
use crate::dictation::indicator::VeraLook;
use crate::rune_hud::HudEvent;
use crate::vera::protocol::HudState;
use crate::vera::trace;
use serde_json::json;

impl Controller {
    pub(super) fn show(&mut self, look: VeraLook) {
        if self.error_until.is_some() {
            return; // `tick` shows what's wanted once the error look is done
        }
        self.idle_at = None;
        if self.look.is_none() {
            warm_hud();
        }
        if self.look != Some(look) {
            self.look = Some(look);
            self.look_since = Instant::now();
            trace::record("hud", json!({"look": look_name(Some(look))}));
            self.hud.send(HudEvent::Vera(look));
        }
    }

    pub(super) fn hide(&mut self, why: &str) {
        self.idle_at = None;
        if self.look.take().is_some() {
            trace::record("hud", json!({"look": "hidden", "why": why}));
            self.hud.send(HudEvent::Vera(VeraLook::Idle));
        }
    }

    /// Hex's coral failed look for a moment; it hides by itself.
    pub(super) fn flash_error(&mut self) {
        warm_hud();
        self.idle_at = None;
        self.look = None;
        self.error_until = Some(Instant::now() + ERROR_HOLD);
        trace::record("hud", json!({"look": "error"}));
        self.hud.send(HudEvent::Vera(VeraLook::Error));
    }

    /// The look Vera's state calls for now, if any.
    pub(super) fn wanted_look(&self) -> Option<VeraLook> {
        if self.speaking.is_some() {
            return Some(VeraLook::Speaking);
        }
        match self.core_hud {
            HudState::Listening => Some(VeraLook::Listening),
            HudState::Thinking => Some(VeraLook::Thinking),
            HudState::Speaking => Some(VeraLook::Speaking),
            HudState::Idle | HudState::Working => None,
        }
    }

    pub(super) fn core_hud(&mut self, state: HudState) {
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

    /// Every look ends: after the error look, what's wanted shows; a look
    /// that outstays its cap hides, whatever Core last said.
    pub(super) fn keep_hud_honest(&mut self) {
        let now = Instant::now();
        if self.error_until.is_some_and(|until| now >= until) {
            self.error_until = None;
            match self.wanted_look() {
                Some(look) => self.show(look),
                // The error look hid the HUD by itself.
                None => trace::record("hud", json!({"look": "hidden", "why": "error look done"})),
            }
        }
        if self.idle_at.is_some_and(|at| now >= at) {
            self.hide("idle");
        }
        let Some(look) = self.look else {
            return;
        };
        let cap = match look {
            VeraLook::Listening => LISTENING_CAP,
            VeraLook::Thinking => THINKING_CAP,
            VeraLook::Speaking if self.speaking.is_some() => SPEAKING_CAP,
            VeraLook::Speaking => SPEAKING_IDLE_CAP,
            VeraLook::Idle | VeraLook::Error => return,
        };
        if self.look_since.elapsed() >= cap {
            tracing::warn!(
                look = look_name(Some(look)),
                "the HUD outstayed its look; hiding it"
            );
            self.hide("timeout");
        }
    }
}
