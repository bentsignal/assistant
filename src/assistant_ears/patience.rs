//! How long Ears waits, after the speaker stops, before an utterance is
//! final: by how its transcript ends, so a thought broken by "um" or "and…"
//! is never answered half-said, while a clear question still gets a quick
//! answer.
//!
//! - [`Reading::Finished`]: a question or an exclamation ("What's new?"):
//!   `finished` (700 ms), which is also the endpointer's own pause.
//! - [`Reading::Open`]: anything else that ends cleanly ("Check the hex
//!   thread.", "Vera"): `pause` (1.2 s). Parakeet puts a full stop after
//!   most clips and can drop a spoken filler, so a statement's period alone
//!   is not proof he's done.
//! - [`Reading::Unfinished`]: a filler ("um", "uh", "hmm", "like"), a
//!   conjunction, article, preposition, or possessive ("and", "the", "to",
//!   "my"), or a trailing comma, dash, or ellipsis, with or without the
//!   model's full stop: `unfinished` (5 s), long enough to find the next
//!   word. Every wait is capped at `max` (8 s, never past [`HARD_MAX`]).
//!
//! Speech that resumes inside the wait continues the same utterance.

use std::time::Duration;

/// No wait is ever longer than this, whatever the config says.
pub(crate) const HARD_MAX: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reading {
    Finished,
    Open,
    Unfinished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Patience {
    pub finished: Duration,
    pub pause: Duration,
    pub unfinished: Duration,
    pub max: Duration,
}

impl Default for Patience {
    fn default() -> Self {
        Self {
            finished: Duration::from_millis(700),
            pause: Duration::from_millis(1_200),
            unfinished: Duration::from_millis(5_000),
            max: Duration::from_millis(8_000),
        }
    }
}

impl Patience {
    /// No waiting past the endpointer's pause: every transcript is final as
    /// soon as it arrives.
    pub(crate) fn none() -> Self {
        Self {
            finished: Duration::ZERO,
            pause: Duration::ZERO,
            unfinished: Duration::ZERO,
            max: Duration::ZERO,
        }
    }

    /// Each wait under `max`, and `max` under [`HARD_MAX`]; the finished
    /// wait (the endpointer's pause) is at least 200 ms.
    pub(crate) fn clamped(self) -> Self {
        let max = self.max.min(HARD_MAX);
        Self {
            finished: self.finished.clamp(
                Duration::from_millis(200),
                max.max(Duration::from_millis(200)),
            ),
            pause: self.pause.min(max),
            unfinished: self.unfinished.min(max),
            max,
        }
    }

    /// How long after its speech ended `text` waits for more.
    pub(crate) fn wait(&self, text: &str) -> Duration {
        match reading(text) {
            Reading::Finished => self.finished,
            Reading::Open => self.pause,
            Reading::Unfinished => self.unfinished,
        }
        .min(self.max)
    }

    /// The longest any transcript waits.
    pub(crate) fn longest(&self) -> Duration {
        self.finished
            .max(self.pause)
            .max(self.unfinished)
            .min(self.max)
    }
}

/// Sounds people make while they find the next word.
const FILLERS: &[&str] = &[
    "um", "umm", "uhm", "uh", "uhh", "er", "erm", "ah", "ahh", "hmm", "hm", "mm", "mhm", "like",
];

/// Words a sentence can't end on, whatever the model's punctuation says.
const DANGLING: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "nor", "so", "because", "cause", "since", "if", "than",
    "that's", "whether", "although", "though", "unless", "while", "plus", "to", "of", "for",
    "with", "without", "from", "into", "onto", "about", "my", "your", "our", "their", "his", "its",
    "also", "and/or",
];

/// Of those, the ones a question can't end on either.
const DANGLING_IN_QUESTIONS: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "nor", "so", "because", "cause", "my", "your", "our",
    "their", "his", "its",
];

/// Words that only leave a phrase open when nothing closes it: "Turn it
/// on." and "What's it for?" are whole.
const OPEN_WITHOUT_PUNCTUATION: &[&str] = &[
    "in",
    "on",
    "at",
    "by",
    "this",
    "that",
    "is",
    "are",
    "was",
    "be",
    "can",
    "could",
    "would",
    "should",
    "will",
    "please",
    "then",
    "when",
    "what",
    "which",
    "who",
    "where",
    "how",
    "why",
    "her",
    "just",
    "really",
    "actually",
    "basically",
];

/// How `text` ends.
pub(crate) fn reading(text: &str) -> Reading {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return Reading::Open;
    }
    if trimmed.ends_with([',', '-', '–', '—', '…', ';', ':']) || trimmed.ends_with("..") {
        return Reading::Unfinished;
    }
    let last = trimmed
        .rsplit(char::is_whitespace)
        .next()
        .unwrap_or("")
        .trim_matches(|character: char| {
            !character.is_alphanumeric() && character != '\'' && character != '/'
        })
        .trim_matches('\'')
        .to_lowercase();
    let word = last.as_str();
    if trimmed.ends_with(['?', '!']) {
        // "What's it for?" is whole; "And the, um?" is not.
        let open =
            (FILLERS.contains(&word) && word != "like") || DANGLING_IN_QUESTIONS.contains(&word);
        return if open {
            Reading::Unfinished
        } else {
            Reading::Finished
        };
    }
    if FILLERS.contains(&word) || DANGLING.contains(&word) {
        return Reading::Unfinished;
    }
    if !trimmed.ends_with('.') && OPEN_WITHOUT_PUNCTUATION.contains(&last.as_str()) {
        return Reading::Unfinished;
    }
    Reading::Open
}

/// `text` ready to be continued: an unfinished phrase loses the full stop
/// the model put after it ("Check the." + "hex thread" reads as one).
pub(crate) fn to_continue(text: &str) -> String {
    let trimmed = text.trim_end();
    if reading(trimmed) == Reading::Unfinished && trimmed.ends_with('.') && !trimmed.ends_with("..")
    {
        trimmed[..trimmed.len() - 1].to_owned()
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fillers_and_dangling_words_are_unfinished_even_with_a_full_stop() {
        for text in [
            "Vera, can you check the",
            "Vera,",
            "open my",
            "So I was thinking about the, um",
            "So I was thinking about the um.",
            "I want to.",
            "Check the tests and.",
            "Look at the build, uh...",
            "Then we'll need to…",
            "Hmm.",
            "and",
            "I was going to say that",
        ] {
            assert_eq!(reading(text), Reading::Unfinished, "{text}");
        }
    }

    #[test]
    fn questions_are_finished_and_statements_open() {
        assert_eq!(
            reading("Vera, what's the status of my T3 threads?"),
            Reading::Finished
        );
        assert_eq!(reading("What's it for?"), Reading::Finished);
        assert_eq!(reading("What's it like?"), Reading::Finished);
        assert_eq!(reading("Stop!"), Reading::Finished);
        assert_eq!(reading("And the weather, um?"), Reading::Unfinished);
        assert_eq!(reading("check the hex thread"), Reading::Open);
        assert_eq!(reading("Check the hex thread."), Reading::Open);
        assert_eq!(reading("Turn it on."), Reading::Open);
        assert_eq!(reading("Vera"), Reading::Open);
        assert_eq!(reading("Hey Vera."), Reading::Open);
        assert_eq!(reading(""), Reading::Open);
    }

    #[test]
    fn waits_follow_the_reading_and_stay_under_the_bound() {
        let patience = Patience::default();
        assert_eq!(patience.wait("What's new?"), Duration::from_millis(700));
        assert_eq!(
            patience.wait("Check the hex thread."),
            Duration::from_millis(1_200)
        );
        assert_eq!(
            patience.wait("I was thinking, um"),
            Duration::from_millis(5_000)
        );
        let wild = Patience {
            unfinished: Duration::from_secs(60),
            max: Duration::from_secs(60),
            ..patience
        }
        .clamped();
        assert_eq!(wild.wait("and"), HARD_MAX);
        assert_eq!(Patience::none().wait("and"), Duration::ZERO);
    }

    #[test]
    fn an_unfinished_phrase_loses_its_full_stop_to_be_continued() {
        assert_eq!(to_continue("Check the."), "Check the");
        assert_eq!(
            to_continue("Check the hex thread."),
            "Check the hex thread."
        );
        assert_eq!(to_continue("Wait..."), "Wait...");
    }
}
