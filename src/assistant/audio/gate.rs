//! Holds what Ears says about an utterance that began while barge-in was
//! still deciding whether the user is talking, so Vera's own echo never
//! reaches Core as speech. A confirmation releases the held events in
//! order; a false alarm drops them. Everything else passes straight
//! through.
//!
//! An utterance whose start reaches back into a false alarm but which Ears
//! announced only after it was decided is held to its end, not dropped: one
//! that goes on well past the false alarm is the user, who had started
//! talking as her voice ended (2026-11-26, four of Shawn's sentences lost
//! that way), and it reaches Core whole. One that ends with it is her echo.

use crate::assistant_ears::protocol::{Event, Sink};

/// A late utterance that ends more than this after its false alarm was
/// decided is the user's, not her echo's.
const LATE_SPEECH_MS: u64 = 1_200;

/// An Ears event, owned.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Heard {
    SpeechStart { t: u64 },
    Partial { text: String, t: u64 },
    Final { text: String, start: u64, end: u64 },
    SpeechCancel { t: u64, reason: String },
    Error { message: String },
}

impl Heard {
    /// The onset of the utterance an event belongs to, when it says.
    fn onset(&self) -> Option<u64> {
        match self {
            Self::SpeechStart { t } | Self::SpeechCancel { t, .. } => Some(*t),
            Self::Final { start, .. } => Some(*start),
            Self::Partial { .. } | Self::Error { .. } => None,
        }
    }
}

/// [`Sink`] that keeps Ears' events for the engine to read.
#[derive(Default)]
pub(crate) struct Collected(pub Vec<Heard>);

impl Sink for Collected {
    fn emit(&mut self, event: &Event<'_>) {
        let heard = match *event {
            Event::SpeechStart { t } => Heard::SpeechStart { t },
            Event::Partial { text, t } => Heard::Partial {
                text: text.to_owned(),
                t,
            },
            Event::Final {
                text, start, end, ..
            } => Heard::Final {
                text: text.to_owned(),
                start,
                end,
            },
            Event::SpeechCancel { t, reason } => Heard::SpeechCancel {
                t,
                reason: reason.to_owned(),
            },
            Event::Error { message } => Heard::Error {
                message: message.to_owned(),
            },
            Event::Ready { .. } | Event::Paused { .. } | Event::Resumed { .. } => return,
        };
        self.0.push(heard);
    }
}

struct Held {
    onset: u64,
    events: Vec<Heard>,
}

#[derive(Default)]
pub(crate) struct Gate {
    held: Vec<Held>,
    /// The utterance partials belong to: the last one started.
    current: Option<u64>,
    /// Onsets at or after this, up to `dropping_until`, belong to a false
    /// alarm and are dropped when they arrive late.
    dropping_from: Option<u64>,
    dropping_until: u64,
    /// Utterances held when the false alarm was decided: echo, dropped.
    doomed: Vec<u64>,
    /// An utterance announced after the false alarm was decided, whose
    /// onset reaches back into it: held until its end shows whose it is.
    late: Option<Held>,
}

impl Gate {
    /// Passes `event` on, or holds it when `holding` (a suspicion is being
    /// probed) or it belongs to an utterance already held.
    pub(crate) fn admit(&mut self, event: Heard, holding: bool) -> Vec<Heard> {
        let onset = match &event {
            Heard::Partial { .. } => self.current,
            other => other.onset(),
        };
        if let Heard::SpeechStart { t } = event {
            self.current = Some(t);
        }
        let Some(onset) = onset else {
            return vec![event];
        };
        if let Some(late) = self.late.as_mut().filter(|late| late.onset == onset) {
            late.events.push(event);
            let last = late.events.last().expect("just pushed");
            return match last {
                Heard::Final { end, .. } if *end > self.dropping_until + LATE_SPEECH_MS => {
                    tracing::info!(
                        onset,
                        "an utterance begun in a false alarm went on past it; it's the user's"
                    );
                    self.late.take().map(|late| late.events).unwrap_or_default()
                }
                Heard::Final { .. } | Heard::SpeechCancel { .. } => {
                    self.late = None;
                    Vec::new()
                }
                _ => Vec::new(),
            };
        }
        if let Some(from) = self.dropping_from
            && onset >= from
            && onset <= self.dropping_until
        {
            if matches!(event, Heard::SpeechStart { .. }) && !self.doomed.contains(&onset) {
                self.late = Some(Held {
                    onset,
                    events: vec![event],
                });
            }
            return Vec::new();
        }
        if let Some(held) = self.held.iter_mut().find(|held| held.onset == onset) {
            held.events.push(event);
            return Vec::new();
        }
        if holding && matches!(event, Heard::SpeechStart { .. }) {
            self.held.push(Held {
                onset,
                events: vec![event],
            });
            return Vec::new();
        }
        vec![event]
    }

    /// The user is talking: everything held, in order.
    pub(crate) fn release(&mut self) -> Vec<Heard> {
        self.held.drain(..).flat_map(|held| held.events).collect()
    }

    /// A false alarm that began at `from` (epoch ms) and was decided at
    /// `until`: drops what is held, and what arrives late for it.
    pub(crate) fn drop_held(&mut self, from: u64, until: u64) {
        self.doomed = self.held.drain(..).map(|held| held.onset).collect();
        self.late = None;
        self.dropping_from = Some(from);
        self.dropping_until = until;
    }

    #[cfg(test)]
    fn holding(&self) -> bool {
        !self.held.is_empty()
    }

    /// Forgets what is held without dropping anything that comes later
    /// (the utterance it belonged to was replaced).
    pub(crate) fn discard_held(&mut self) {
        self.held.clear();
    }

    /// The last false alarm was the user after all: nothing of it is
    /// dropped any more.
    pub(crate) fn forgive(&mut self) {
        self.dropping_from = None;
        self.doomed.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(t: u64) -> Heard {
        Heard::SpeechStart { t }
    }

    fn final_(text: &str, start: u64) -> Heard {
        Heard::Final {
            text: text.into(),
            start,
            end: start + 500,
        }
    }

    #[test]
    fn unguarded_events_pass_and_held_ones_wait_for_the_verdict() {
        let mut gate = Gate::default();
        assert_eq!(gate.admit(start(100), false), [start(100)]);
        assert_eq!(gate.admit(final_("hi", 100), false), [final_("hi", 100)]);
        assert!(gate.admit(start(900), true).is_empty());
        let partial = Heard::Partial {
            text: "stop".into(),
            t: 950,
        };
        assert!(gate.admit(partial.clone(), false).is_empty());
        assert!(gate.holding());
        assert_eq!(gate.release(), [start(900), partial]);
        assert_eq!(
            gate.admit(final_("Stop.", 900), false),
            [final_("Stop.", 900)]
        );
    }

    #[test]
    fn a_false_alarm_drops_its_utterance_even_when_it_ends_later() {
        let mut gate = Gate::default();
        assert!(gate.admit(start(900), true).is_empty());
        gate.drop_held(850, 1_200);
        assert!(!gate.holding());
        let cancel = Heard::SpeechCancel {
            t: 900,
            reason: "echo".into(),
        };
        assert!(gate.admit(cancel, false).is_empty());
        assert!(gate.admit(final_("late", 1_000), false).is_empty());
        assert_eq!(gate.admit(start(2_000), false), [start(2_000)]);
    }

    #[test]
    fn an_utterance_announced_after_a_false_alarm_is_his_when_it_goes_on() {
        let mut gate = Gate::default();
        gate.drop_held(850, 1_200);
        // Her echo: announced late, ends with the false alarm.
        assert!(gate.admit(start(1_000), false).is_empty());
        assert!(gate.admit(final_("you", 1_000), false).is_empty());
        // Him, starting as her voice ended and going on for seconds.
        let late = Heard::Final {
            text: "Just turn off the living room".into(),
            start: 1_100,
            end: 4_000,
        };
        let partial = Heard::Partial {
            text: "just turn".into(),
            t: 2_000,
        };
        assert!(gate.admit(start(1_100), false).is_empty());
        assert!(gate.admit(partial.clone(), false).is_empty());
        assert_eq!(
            gate.admit(late.clone(), false),
            [start(1_100), partial, late]
        );
    }
}
