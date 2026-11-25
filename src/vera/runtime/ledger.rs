//! Every `speak` Core sent, until it ends, so that each one ends exactly
//! once whatever happens to the audio engine or to Core (the bug that left
//! Shawn's Vera silent: an engine restart dropped a playing utterance, its
//! end never came, and Core waited 35 s while his next replies piled up).
//!
//! - Ids are scoped to the Core that asked: the engine plays
//!   `"<core generation>.<speak_id>"`, so a restarted Core's `s1` never
//!   collides with the old one's, and the old one's ends are never sent to
//!   the new one.
//! - Deadlines come from the text: the voice's first audio within
//!   [`START_DEADLINE`], the whole line within [`play_deadline`] of it.
//! - When the engine goes away, [`Ledger::drain`] ends everything at once.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long the voice service may take to start a line. It starts one in
/// well under a second; a loading service answers 503 at once.
pub(super) const START_DEADLINE: Duration = Duration::from_secs(12);

/// How long a line may play once started: twice its expected length (Vera
/// speaks about 14 characters a second), plus room for a slow stream.
pub(super) fn play_deadline(chars: usize) -> Duration {
    let millis = 6_000 + chars as u64 * 150;
    Duration::from_millis(millis.min(180_000))
}

struct Speech {
    core_id: String,
    core_generation: u64,
    chars: usize,
    sent_at: Instant,
    started_at: Option<Instant>,
}

/// How an utterance ended, for Core.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Ended {
    pub engine_id: String,
    pub core_id: String,
    /// It had started playing (`interrupted`), or never had (`failed`).
    pub started: bool,
    /// It belongs to the Core running now (so Core is told).
    pub current: bool,
}

#[derive(Default)]
pub(super) struct Ledger {
    core_generation: u64,
    items: HashMap<String, Speech>,
}

impl Ledger {
    /// A new Core: what the old one asked for is forgotten (the caller
    /// stops it playing). Returns how many were forgotten.
    pub(super) fn new_core(&mut self) -> usize {
        self.core_generation += 1;
        let forgotten = self.items.len();
        self.items.clear();
        forgotten
    }

    /// The engine id to play `core_id` as.
    pub(super) fn sent(&mut self, core_id: &str, text: &str, now: Instant) -> String {
        let engine_id = format!("{}.{core_id}", self.core_generation);
        self.items.insert(
            engine_id.clone(),
            Speech {
                core_id: core_id.to_owned(),
                core_generation: self.core_generation,
                chars: text.chars().count(),
                sent_at: now,
                started_at: None,
            },
        );
        engine_id
    }

    /// Core's id for `engine_id`, and whether it's the current Core's;
    /// `None` once it has ended.
    pub(super) fn core_id(&self, engine_id: &str) -> Option<(String, bool)> {
        let speech = self.items.get(engine_id)?;
        Some((
            speech.core_id.clone(),
            speech.core_generation == self.core_generation,
        ))
    }

    /// `engine_id` started playing; false if it already ended.
    pub(super) fn started(&mut self, engine_id: &str, now: Instant) -> bool {
        match self.items.get_mut(engine_id) {
            Some(speech) => {
                if speech.started_at.is_none() {
                    speech.started_at = Some(now);
                }
                true
            }
            None => false,
        }
    }

    /// `engine_id` ended; `None` if it already had (its end was sent).
    pub(super) fn ended(&mut self, engine_id: &str) -> Option<Ended> {
        let speech = self.items.remove(engine_id)?;
        Some(Ended {
            engine_id: engine_id.to_owned(),
            core_id: speech.core_id,
            started: speech.started_at.is_some(),
            current: speech.core_generation == self.core_generation,
        })
    }

    /// Removes and returns every utterance past its deadline.
    pub(super) fn overdue(&mut self, now: Instant) -> Vec<Ended> {
        let late: Vec<String> = self
            .items
            .iter()
            .filter(|(_, speech)| match speech.started_at {
                None => now.saturating_duration_since(speech.sent_at) >= START_DEADLINE,
                Some(at) => now.saturating_duration_since(at) >= play_deadline(speech.chars),
            })
            .map(|(id, _)| id.clone())
            .collect();
        late.iter().filter_map(|id| self.ended(id)).collect()
    }

    /// The engine is gone: everything ends now.
    pub(super) fn drain(&mut self) -> Vec<Ended> {
        let ids: Vec<String> = self.items.keys().cloned().collect();
        let mut ended: Vec<Ended> = ids.iter().filter_map(|id| self.ended(id)).collect();
        ended.sort_by(|a, b| a.engine_id.cmp(&b.engine_id));
        ended
    }

    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_utterance_ends_exactly_once() {
        let now = Instant::now();
        let mut ledger = Ledger::default();
        ledger.new_core();
        let a = ledger.sent("s1", "Hello there.", now);
        assert_eq!(a, "1.s1");
        assert!(ledger.started(&a, now));
        let ended = ledger.ended(&a).unwrap();
        assert_eq!(ended.core_id, "s1");
        assert!(ended.started && ended.current);
        assert_eq!(ledger.ended(&a), None, "a second end is never sent");
        assert!(!ledger.started(&a, now), "nor a late start");
    }

    #[test]
    fn deadlines_follow_the_text() {
        let now = Instant::now();
        let mut ledger = Ledger::default();
        ledger.new_core();
        let silent = ledger.sent("s1", "Never starts.", now);
        let long = ledger.sent("s2", &"word ".repeat(40), now);
        ledger.started(&long, now);
        assert!(ledger.overdue(now + Duration::from_secs(5)).is_empty());
        let late = ledger.overdue(now + START_DEADLINE);
        assert_eq!(late.len(), 1);
        assert_eq!(late[0].engine_id, silent);
        assert!(!late[0].started);
        // 200 characters: 6 s + 30 s.
        assert!(ledger.overdue(now + Duration::from_secs(35)).is_empty());
        let late = ledger.overdue(now + Duration::from_secs(36));
        assert_eq!(late[0].engine_id, long);
        assert!(late[0].started);
        assert!(ledger.is_empty());
    }

    #[test]
    fn a_new_core_never_hears_the_old_ones_ends() {
        let now = Instant::now();
        let mut ledger = Ledger::default();
        ledger.new_core();
        let old = ledger.sent("s1", "From the first Core.", now);
        assert_eq!(ledger.new_core(), 1);
        assert_eq!(ledger.ended(&old), None);
        let new = ledger.sent("s1", "From the second Core.", now);
        assert_ne!(old, new, "the same speak id never collides");
        assert_eq!(ledger.core_id(&new), Some(("s1".into(), true)));
    }

    #[test]
    fn an_engine_that_goes_away_ends_everything() {
        let now = Instant::now();
        let mut ledger = Ledger::default();
        ledger.new_core();
        let playing = ledger.sent("s1", "Playing.", now);
        ledger.started(&playing, now);
        ledger.sent("s2", "Queued.", now);
        let ended = ledger.drain();
        assert_eq!(ended.len(), 2);
        assert!(ended[0].started && !ended[1].started);
        assert!(ledger.is_empty());
    }
}
