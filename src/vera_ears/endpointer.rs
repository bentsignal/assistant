//! Hands-free utterance endpointing over 16 kHz mono audio: where speech
//! starts, and where a pause long enough to end the request falls.
//!
//! Frames are 20 ms and judged by Hex's adaptive-noise-floor classifier
//! (`transcription::pause_segmenter::SpeechFrames`), so a steady room hum or
//! fan never reads as speech. An utterance starts once `min_speech` of speech
//! frames arrive with no gap longer than `ONSET_GAP` between them; its clip
//! reaches back `pre_roll` before the first of them, so a soft opening
//! consonant is kept. It ends once `pause` of non-speech frames follows the
//! last speech frame. A clip that runs past `max_utterance` ends at the next
//! `LONG_UTTERANCE_PAUSE`, and at `2 × max_utterance` regardless.
//!
//! The endpointer only reports positions; the caller keeps the audio, checks
//! an ended clip holds real speech (Silero), and decides from its transcript
//! whether a pause was only a breath mid-sentence ([`trails_off`]).

use std::time::Duration;

use crate::transcription::pause_segmenter::{FRAME_SAMPLES, SpeechFrames};

pub(crate) const SAMPLE_RATE: usize = 16_000;
const FRAME_MS: usize = FRAME_SAMPLES * 1_000 / SAMPLE_RATE;
/// Non-speech frames an onset run may contain before it starts over: the
/// dips between syllables.
const ONSET_GAP: Duration = Duration::from_millis(100);
/// The pause that ends an utterance already longer than `max_utterance`.
const LONG_UTTERANCE_PAUSE: Duration = Duration::from_millis(300);
/// Silence kept after the last speech frame, so the model hears the word end.
const TAIL: Duration = Duration::from_millis(240);
/// Silence after which the clip is final unless speech resumes: the tail is
/// in hand, so the caller can start transcribing while the pause runs out.
const QUIET: Duration = Duration::from_millis(280);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Settings {
    pub pause: Duration,
    pub min_speech: Duration,
    pub pre_roll: Duration,
    pub max_utterance: Duration,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            pause: Duration::from_millis(700),
            min_speech: Duration::from_millis(120),
            pre_roll: Duration::from_millis(300),
            max_utterance: Duration::from_secs(30),
        }
    }
}

/// What a pushed frame changed. Positions are absolute sample offsets from
/// the first sample ever pushed (or skipped).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Event {
    /// Speech began at `onset`; the clip starts at `clip_start`, pre-roll
    /// included.
    Started { clip_start: usize, onset: usize },
    /// The speaker has been quiet long enough that the clip, should the
    /// pause run out, is already complete: the same bounds `Ended` will
    /// carry unless speech resumes first. Sent once per quiet stretch, and
    /// only when `pause` is longer than this.
    Quiet {
        clip_start: usize,
        speech_end: usize,
        clip_end: usize,
    },
    /// The pause ended the utterance. `speech_end` is the end of the last
    /// speech frame, and the clip runs to `clip_end`, a short tail later.
    Ended {
        clip_start: usize,
        speech_end: usize,
        clip_end: usize,
    },
}

pub(crate) struct Endpointer {
    settings: Settings,
    speech: SpeechFrames,
    /// Samples of the frame being filled.
    filled: usize,
    frame: Vec<f32>,
    /// Absolute position of the next frame's first sample.
    position: usize,
    /// The earliest position a clip may reach back to: nothing from before
    /// the last reset.
    earliest: usize,
    state: State,
}

enum State {
    Idle {
        /// The onset run in progress: its first speech frame, speech frames
        /// counted, and non-speech frames since the last speech frame.
        run: Option<(usize, usize, usize)>,
    },
    Speaking {
        clip_start: usize,
        /// End of the last speech frame.
        speech_end: usize,
        silent_frames: usize,
    },
}

impl Endpointer {
    pub(crate) fn new(settings: Settings) -> Self {
        Self {
            settings,
            speech: SpeechFrames::default(),
            filled: 0,
            frame: Vec::with_capacity(FRAME_SAMPLES),
            position: 0,
            earliest: 0,
            state: State::Idle { run: None },
        }
    }

    /// Samples pushed so far, which is where the next sample sits.
    pub(crate) fn position(&self) -> usize {
        self.position + self.filled
    }

    pub(crate) fn speaking(&self) -> bool {
        matches!(self.state, State::Speaking { .. })
    }

    /// Drops any utterance in progress, keeping the noise floor: nothing
    /// heard before now reaches the next clip. Returns whether an utterance
    /// was dropped.
    pub(crate) fn reset(&mut self) -> bool {
        let was_speaking = self.speaking();
        self.state = State::Idle { run: None };
        self.earliest = self.position();
        was_speaking
    }

    /// Passes over `samples` without judging them (audio heard while paused),
    /// so positions stay on the capture's timeline.
    pub(crate) fn skip(&mut self, samples: usize) {
        self.position += self.filled + samples;
        self.filled = 0;
        self.frame.clear();
        self.reset();
    }

    pub(crate) fn push(&mut self, mut samples: &[f32]) -> Vec<Event> {
        let mut events = Vec::new();
        while !samples.is_empty() {
            let take = samples.len().min(FRAME_SAMPLES - self.frame.len());
            self.frame.extend_from_slice(&samples[..take]);
            self.filled = self.frame.len();
            samples = &samples[take..];
            if self.frame.len() == FRAME_SAMPLES {
                let speech = self.speech.is_speech(&self.frame);
                self.frame.clear();
                self.filled = 0;
                if let Some(event) = self.complete_frame(speech) {
                    events.push(event);
                }
                self.position += FRAME_SAMPLES;
            }
        }
        events
    }

    fn complete_frame(&mut self, speech: bool) -> Option<Event> {
        let start = self.position;
        let end = start + FRAME_SAMPLES;
        let settings = self.settings;
        match &mut self.state {
            State::Idle { run } => {
                let next = match (*run, speech) {
                    (None, false) => None,
                    (None, true) => Some((start, 1, 0)),
                    (Some((onset, count, _)), true) => Some((onset, count + 1, 0)),
                    (Some((onset, count, gap)), false) => {
                        (frames(ONSET_GAP) > gap + 1).then_some((onset, count, gap + 1))
                    }
                };
                *run = next;
                let (onset, count, _) = next?;
                if count < frames(settings.min_speech).max(1) {
                    return None;
                }
                let clip_start = onset
                    .saturating_sub(samples(settings.pre_roll))
                    .max(self.earliest);
                self.state = State::Speaking {
                    clip_start,
                    speech_end: end,
                    silent_frames: 0,
                };
                Some(Event::Started { clip_start, onset })
            }
            State::Speaking {
                clip_start,
                speech_end,
                silent_frames,
            } => {
                if speech {
                    *speech_end = end;
                    *silent_frames = 0;
                } else {
                    *silent_frames += 1;
                }
                let length = end - *clip_start;
                let pause = if length >= samples(settings.max_utterance) {
                    LONG_UTTERANCE_PAUSE
                } else {
                    settings.pause
                };
                let forced = length >= samples(settings.max_utterance) * 2;
                let quiet_ms = *silent_frames * FRAME_MS;
                if quiet_ms < pause.as_millis() as usize && !forced {
                    return (!speech
                        && quiet_ms == frames(QUIET) * FRAME_MS
                        && pause > QUIET)
                        .then(|| Event::Quiet {
                            clip_start: *clip_start,
                            speech_end: *speech_end,
                            clip_end: *speech_end + samples(TAIL),
                        });
                }
                let event = Event::Ended {
                    clip_start: *clip_start,
                    speech_end: *speech_end,
                    clip_end: (*speech_end + samples(TAIL)).min(end),
                };
                self.state = State::Idle { run: None };
                Some(event)
            }
        }
    }
}

const fn frames(duration: Duration) -> usize {
    duration.as_millis() as usize / FRAME_MS
}

pub(crate) const fn samples(duration: Duration) -> usize {
    duration.as_millis() as usize * SAMPLE_RATE / 1_000
}

/// Whether a transcript stops mid-phrase: no closing punctuation and a last
/// word that needs more after it, or a trailing comma. A pause after such
/// text is treated as a breath, so "Vera, can you check the … hex thread"
/// stays one request.
pub(crate) fn trails_off(text: &str) -> bool {
    const OPEN_ENDED: &[&str] = &[
        "a", "an", "the", "and", "or", "but", "so", "to", "of", "for", "with", "in", "on", "at",
        "from", "into", "about", "my", "your", "our", "their", "his", "her", "its", "this", "that",
        "is", "are", "was", "be", "can", "could", "would", "should", "will", "please", "um", "uh",
        "er", "hmm", "like", "then", "if", "because", "when", "what", "which", "who", "where",
        "how", "why", "hey", "vera",
    ];
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.ends_with([',', '-', '…', ';', ':']) {
        return true;
    }
    if trimmed.ends_with(['.', '?', '!']) {
        return false;
    }
    let last = trimmed
        .rsplit(char::is_whitespace)
        .next()
        .unwrap_or("")
        .trim_matches(|character: char| !character.is_alphanumeric())
        .to_lowercase();
    OPEN_ENDED.contains(&last.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::pause_segmenter::tests::{noise, utterance};

    fn ms(samples: usize) -> usize {
        samples * 1_000 / SAMPLE_RATE
    }

    fn run(endpointer: &mut Endpointer, audio: &[f32], chunk: usize) -> Vec<Event> {
        audio
            .chunks(chunk)
            .flat_map(|chunk| endpointer.push(chunk))
            .collect()
    }

    /// (onset, speech end, clip length) of each ended utterance, in ms.
    fn utterances(events: &[Event]) -> Vec<(usize, usize, usize)> {
        let mut onset = None;
        let mut found = Vec::new();
        for event in events {
            match *event {
                Event::Started { onset: at, .. } => onset = Some(at),
                Event::Quiet { .. } => {}
                Event::Ended {
                    clip_start,
                    speech_end,
                    clip_end,
                } => {
                    assert!(clip_start <= speech_end && speech_end <= clip_end);
                    found.push((
                        ms(onset.take().expect("started before it ended")),
                        ms(speech_end),
                        ms(clip_end - clip_start),
                    ));
                }
            }
        }
        found
    }

    fn quiet(duration_ms: usize) -> Vec<f32> {
        let mut seed = 11;
        noise(duration_ms, -70.0, &mut seed)
    }

    #[test]
    fn one_request_with_a_short_breath_stays_one_utterance() {
        // 1 s of room, 1.5 s of speech, a 400 ms breath, 1 s more, then quiet.
        let mut audio = quiet(1_000);
        audio.extend(utterance(&[(1_500, 400), (1_000, 1_500)], -70.0));
        let found = utterances(&run(&mut Endpointer::new(Settings::default()), &audio, 160));
        assert_eq!(found.len(), 1, "{found:?}");
        let (onset, end, _) = found[0];
        assert!((990..=1_030).contains(&onset), "{onset}");
        assert!((3_880..=3_920).contains(&end), "{end}");
    }

    #[test]
    fn a_pause_past_the_threshold_splits_two_requests() {
        let mut audio = quiet(500);
        audio.extend(utterance(&[(1_200, 1_000), (1_200, 1_000)], -70.0));
        let found = utterances(&run(&mut Endpointer::new(Settings::default()), &audio, 480));
        assert_eq!(found.len(), 2, "{found:?}");
    }

    #[test]
    fn the_utterance_ends_once_the_pause_is_heard() {
        let mut audio = quiet(300);
        audio.extend(utterance(&[(1_000, 0)], -70.0));
        let speech_end = audio.len();
        audio.extend(quiet(2_000));
        let mut endpointer = Endpointer::new(Settings::default());
        let mut ended_at = None;
        for chunk in audio.chunks(160) {
            let events = endpointer.push(chunk);
            if events
                .iter()
                .any(|event| matches!(event, Event::Ended { .. }))
            {
                ended_at = Some(endpointer.position());
                break;
            }
        }
        let waited = ms(ended_at.expect("the utterance ended") - speech_end);
        assert!((690..=730).contains(&waited), "{waited}");
    }

    #[test]
    fn the_clip_starts_with_the_pre_roll_and_ends_with_a_tail() {
        let mut audio = quiet(1_000);
        audio.extend(utterance(&[(1_000, 1_000)], -70.0));
        let events = run(&mut Endpointer::new(Settings::default()), &audio, 333);
        let Event::Started { clip_start, onset } = events[0] else {
            panic!("{events:?}");
        };
        assert_eq!(ms(onset - clip_start), 300);
        let (_, _, clip_ms) = utterances(&events)[0];
        // Pre-roll, a second of speech, and the tail.
        assert!((1_520..=1_560).contains(&clip_ms), "{clip_ms}");
    }

    #[test]
    fn quiet_comes_before_the_end_with_the_same_clip_unless_speech_resumes() {
        let mut audio = quiet(300);
        // A breath of 400 ms (quiet, but no end), then the real pause.
        audio.extend(utterance(&[(1_000, 400), (800, 1_000)], -70.0));
        let events = run(&mut Endpointer::new(Settings::default()), &audio, 160);
        let quiets: Vec<_> = events
            .iter()
            .filter_map(|event| match *event {
                Event::Quiet {
                    clip_start,
                    speech_end,
                    clip_end,
                } => Some((clip_start, speech_end, clip_end)),
                _ => None,
            })
            .collect();
        let ended = events.iter().find_map(|event| match *event {
            Event::Ended {
                clip_start,
                speech_end,
                clip_end,
            } => Some((clip_start, speech_end, clip_end)),
            _ => None,
        });
        assert_eq!(quiets.len(), 2, "{events:?}");
        assert_ne!(Some(quiets[0]), ended, "the breath's speculation is stale");
        assert_eq!(Some(quiets[1]), ended);
    }

    #[test]
    fn room_noise_and_silence_never_start_an_utterance() {
        let mut seed = 5;
        let mut audio = noise(5_000, -45.0, &mut seed);
        audio.extend(vec![0.0; SAMPLE_RATE * 3]);
        let events = run(&mut Endpointer::new(Settings::default()), &audio, 160);
        assert!(events.is_empty(), "{events:?}");
    }

    #[test]
    fn a_click_is_too_short_to_start() {
        let mut seed = 9;
        let mut audio = quiet(500);
        audio.extend(noise(60, -15.0, &mut seed));
        audio.extend(quiet(1_500));
        let events = run(&mut Endpointer::new(Settings::default()), &audio, 160);
        assert!(events.is_empty(), "{events:?}");
    }

    #[test]
    fn audio_from_before_a_skip_never_reaches_the_next_clip() {
        let mut endpointer = Endpointer::new(Settings::default());
        let mut audio = quiet(300);
        audio.extend(utterance(&[(600, 0)], -70.0));
        let events = run(&mut endpointer, &audio, 160);
        assert!(matches!(events.first(), Some(Event::Started { .. })));
        let resumed = endpointer.position() + 1_600;
        endpointer.skip(1_600);
        assert!(!endpointer.speaking());
        let events = run(&mut endpointer, &utterance(&[(600, 1_000)], -70.0), 160);
        let Some(Event::Started { clip_start, .. }) = events.first().copied() else {
            panic!("{events:?}");
        };
        assert_eq!(clip_start, resumed);
    }

    #[test]
    fn transcripts_that_trail_off_mark_a_breath() {
        assert!(trails_off("Vera, can you check the"));
        assert!(trails_off("Vera,"));
        assert!(trails_off("open my"));
        assert!(trails_off("Hey Vera"));
        assert!(!trails_off("Vera, what's the status of my T3 threads?"));
        assert!(!trails_off("check the hex thread"));
        assert!(!trails_off(""));
    }
}
