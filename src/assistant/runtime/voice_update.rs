//! Updates by voice (DESIGN.md): Core's `update_*` tools send an `update`
//! command, and the app runs its own updater for it, exactly as Settings ›
//! Updates does (the same check, the same install, the same supervised
//! switch). Each command gets one answer with its `id`; an install answers
//! `started` as soon as the download begins. After that the app tells Core
//! only what really happened: `failed` (with the updater's reason) if the
//! install she started fails, `back` once a new version confirms it
//! started cleanly, and `rolled_back` once if one didn't.

use std::time::{Duration, Instant};

use super::{Controller, Msg};
use crate::assistant::protocol::{AppEvent, UpdateAction};
use crate::assistant::update::{self, Channel, Offer, Phase, install, stamp};
use crate::rune_ui::assistant::UiAction;

/// Her "updating" line gets this long to start and finish before the app
/// quits for the switch...
const SAY_IT_FOR: Duration = Duration::from_secs(3);
/// ...but the switch never waits longer than this.
const HAND_OVER_WITHIN: Duration = Duration::from_secs(15);
/// The rollback notice waits for Core and the voice, as the confirm does.
const CORE_UP: Duration = Duration::from_secs(8);
const VOICE_UP: Duration = Duration::from_secs(25);

/// A command Core is waiting on.
struct Request {
    id: Option<String>,
    action: UpdateAction,
}

pub(super) struct VoiceUpdates {
    request: Option<Request>,
    /// An install she asked for is running (since then).
    installing: Option<Instant>,
    /// Ready, waiting for her line to finish.
    hand_over: Option<(Offer, Instant)>,
    /// A rollback this version hasn't said yet.
    rollback: Option<install::Failure>,
}

impl VoiceUpdates {
    pub(super) fn new() -> Self {
        let rollback = install::layout()
            .root()
            .and_then(|root| install::State::load(root).ok())
            .filter(|state| state.current == stamp::LABEL)
            .and_then(|state| state.failed)
            .filter(|failed| !failed.told);
        Self {
            request: None,
            installing: None,
            hand_over: None,
            rollback,
        }
    }
}

impl Controller {
    /// Core's `update` command.
    pub(super) fn voice_update(
        &mut self,
        id: Option<String>,
        action: UpdateAction,
        channel: Option<String>,
    ) {
        tracing::info!(?action, ?channel, "update by voice");
        // A newer question replaces one still waiting (Core gave up on it).
        if let Some(old) = self.voice_updates.request.take() {
            self.tell_update(old.id, "superseded", None, None);
        }
        let channel = match channel.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(key) => match Channel::parse(&key.to_ascii_lowercase()) {
                Some(channel) => Some(channel),
                None => {
                    let message = format!("the channel is stable or nightly, not {key}");
                    self.tell_update(id, "failed", None, Some(message));
                    return;
                }
            },
        };
        match action {
            UpdateAction::Status => {
                let phase = self.updates.snapshot().phase;
                self.answer(id, &phase);
                return;
            }
            UpdateAction::Channel => {
                let Some(channel) = channel else {
                    let message = "which channel: stable or nightly".to_string();
                    self.tell_update(id, "failed", None, Some(message));
                    return;
                };
                self.ui_action(UiAction::SetUpdateChannel(channel));
            }
            UpdateAction::Install if !update::can_apply() => {
                let message = "this is a development build run from the repo, not an \
                               installed Assistant, so it can't update itself"
                    .to_string();
                self.tell_update(id, "unavailable", None, Some(message));
                return;
            }
            UpdateAction::Install | UpdateAction::Check => {
                if let Some(channel) = channel {
                    self.ui_action(UiAction::SetUpdateChannel(channel));
                }
            }
        }
        let phase = self.updates.snapshot().phase;
        if phase.installing() {
            // Already on its way (Settings, or an earlier ask).
            let latest = phase.offer().map(|offer| offer.label.clone());
            let state = if action == UpdateAction::Install {
                self.voice_updates
                    .installing
                    .get_or_insert_with(Instant::now);
                "started"
            } else {
                "installing"
            };
            self.tell_update(id, state, latest, None);
            return;
        }
        // Always a fresh check, so she never installs (or reports) a stale
        // offer. A check already in flight answers for this one too.
        if phase != Phase::Checking {
            self.updates.check();
        }
        self.voice_updates.request = Some(Request { id, action });
        self.voice_update_changed();
    }

    /// The updater's state changed: answers a waiting command once it can,
    /// and reports an install she started that failed.
    pub(super) fn voice_update_changed(&mut self) {
        let phase = self.updates.snapshot().phase;
        if let Some(request) = self.voice_updates.request.take() {
            match (&phase, request.action) {
                (Phase::Idle | Phase::Checking, _) => {
                    self.voice_updates.request = Some(request);
                }
                (Phase::Available(offer), UpdateAction::Install) => {
                    let messages = self.messages.clone();
                    let latest = Some(offer.label.clone());
                    if self.updates.install(move |offer| {
                        let _ = messages.send(Msg::UpdateReady(offer));
                    }) {
                        self.voice_updates.installing = Some(Instant::now());
                        self.tell_update(request.id, "started", latest, None);
                    } else {
                        let message = "the updater didn't start the install".to_string();
                        self.tell_update(request.id, "failed", latest, Some(message));
                    }
                }
                (phase, _) => self.answer(request.id, phase),
            }
            return;
        }
        if self.voice_updates.installing.is_some()
            && let Phase::Failed { message, offer } = &phase
        {
            self.voice_updates.installing = None;
            let latest = offer.as_ref().map(|offer| offer.label.clone());
            self.tell_update(None, "failed", latest, Some(message.clone()));
        }
    }

    /// An install she asked for is ready: true if the switch waits for her
    /// "updating" line (`release_held_hand_over` starts it).
    pub(super) fn hold_hand_over(&mut self, offer: &Offer) -> bool {
        let Some(since) = self.voice_updates.installing.take() else {
            return false;
        };
        self.voice_updates.hand_over = Some((offer.clone(), since));
        true
    }

    pub(super) fn release_held_hand_over(&mut self) {
        let Some((_, since)) = &self.voice_updates.hand_over else {
            return;
        };
        let quiet = self.speaking.is_none() && self.held.is_empty() && self.ledger.is_empty();
        if (quiet && since.elapsed() >= SAY_IT_FOR) || since.elapsed() >= HAND_OVER_WITHIN {
            let (offer, _) = self.voice_updates.hand_over.take().expect("checked");
            let _ = self.messages.send(Msg::HandOver(offer));
        }
    }

    /// Once, in the version a failed update rolled back to: Core says so,
    /// with the reason `install.json` records.
    pub(super) fn tell_rollback(&mut self) {
        if self.voice_updates.rollback.is_none() {
            return;
        }
        let core = self.core.running_for().is_some_and(|up| up >= CORE_UP);
        let voice = self.voice.ready
            || self
                .voice_service
                .running_for()
                .is_some_and(|up| up >= VOICE_UP);
        if !(core && voice) {
            return;
        }
        let failed = self.voice_updates.rollback.take().expect("checked");
        if let Some(root) = install::layout().root() {
            let _ = install::State::edit(root, |state| {
                if let Some(f) = state.failed.as_mut().filter(|f| f.label == failed.label) {
                    f.told = true;
                }
            });
        }
        self.tell_update(None, "rolled_back", Some(failed.label), Some(failed.reason));
    }

    /// Answers with the updater's phase as it stands.
    fn answer(&mut self, id: Option<String>, phase: &Phase) {
        let latest = phase.offer().map(|offer| offer.label.clone());
        let message = match phase {
            Phase::Failed { message, .. } => Some(message.clone()),
            _ => None,
        };
        self.tell_update(id, phase.key(), latest, message);
    }

    pub(super) fn tell_update(
        &mut self,
        id: Option<String>,
        state: &'static str,
        latest: Option<String>,
        message: Option<String>,
    ) {
        let snapshot = self.updates.snapshot();
        tracing::info!(state, ?latest, ?message, "update: told Core");
        self.tell_core(AppEvent::Update {
            id,
            state,
            running: stamp::LABEL.to_string(),
            channel: snapshot.channel.key(),
            latest,
            message,
            installed: update::can_apply(),
        });
    }
}
