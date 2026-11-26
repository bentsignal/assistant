//! What Ears says about the audio: the utterance state machine between the
//! endpointer and the JSON lines.
//!
//! - `speech_start` waits until the speech detector agrees the audio holds
//!   speech (checked every `CHECK_EVERY` while it doesn't), so a fan, a door,
//!   or music never announces an utterance. Its `t` is still the onset.
//! - Once the speaker has been quiet for the endpointer's `Quiet` stretch,
//!   the clip is sent for transcription speculatively: if the pause runs out
//!   with no more speech, the transcript is usually already there, and
//!   `final` follows the pause at once. Speech that resumes makes it stale.
//! - A transcript is then held until its [`Patience`] wait after its speech
//!   ended: short for a question, longer for a plain statement, several
//!   seconds for one that trails off on "um" or "and". Speech that starts
//!   inside that window continues the same utterance, and the texts are
//!   joined; nothing is said to the caller in between, so it keeps showing
//!   him listening.
//! - While an announced utterance goes on, its clip so far is transcribed
//!   every `PARTIAL_EVERY` (one run in flight at most) for `partial` lines,
//!   prefixed with any held text being continued. A whole-clip run of a few
//!   seconds takes tens of ms on the GPU, and unlike a live stream it never
//!   competes with the final for the model.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use super::endpointer::{self, Endpointer, SAMPLE_RATE, samples};
use super::patience::{self, Patience};
use super::protocol::{Event, Sink};

/// How often unconfirmed speech is put to the speech detector.
const CHECK_EVERY: Duration = Duration::from_millis(160);
/// The most recent audio each check looks at.
const CHECK_WINDOW: Duration = Duration::from_millis(1_500);
/// Audio kept for clips; longer than any utterance the endpointer allows.
const RING: Duration = Duration::from_secs(120);
/// New audio between partial transcriptions.
const PARTIAL_EVERY: Duration = Duration::from_millis(400);
/// Partials stop for utterances longer than this; the final still comes.
const PARTIAL_LIMIT: Duration = Duration::from_secs(20);

/// The transcription side, behind a seam so tests can drive the state
/// machine without a model.
pub(crate) trait Backend {
    /// Whether 16 kHz `samples` hold speech, or `None` when unknown.
    fn heard_speech(&mut self, samples: &[f32]) -> Option<bool>;
    /// Queues `clip` for transcription, in order; its [`Finished`] comes
    /// back through [`Utterances::finished`]. An unverified clip is checked
    /// for speech first.
    fn transcribe(&mut self, id: u64, clip: Vec<f32>, verified: bool);
}

/// A transcription the backend completed.
#[derive(Debug)]
pub(crate) struct Finished {
    pub id: u64,
    pub text: Result<String, String>,
    /// False when the speech detector found no speech in an unverified clip.
    pub speech: bool,
}

struct Current {
    clip_start: usize,
    onset: usize,
    onset_ms: u64,
    /// The partial transcription in flight, and the position of the last
    /// one asked for.
    partial: Option<u64>,
    partial_at: usize,
    /// Text of earlier utterances this one continues.
    prefix: String,
    /// The earlier utterance whose transcript decides whether this one
    /// continues it; nothing is announced until it does.
    after: Option<u64>,
    confirmed: bool,
    announced: bool,
    checked_at: usize,
    last_partial: String,
    /// The speculative transcription in flight: its id and the speech end
    /// it assumed.
    speculation: Option<(u64, usize)>,
}

struct Pending {
    id: u64,
    onset: usize,
    speech_end: usize,
    onset_ms: u64,
    end_ms: u64,
    prefix: String,
    after: Option<u64>,
    announced: bool,
    /// When the pause ran out.
    ended_at: Instant,
}

struct Held {
    pending: Pending,
    text: String,
    /// The position its wait runs out at.
    until: usize,
}

pub(crate) struct Utterances<B: Backend, S: Sink> {
    backend: B,
    output: S,
    endpointer: Endpointer,
    ring: VecDeque<f32>,
    ring_first: usize,
    patience: Patience,
    /// Wall-clock ms of position 0, refreshed with each block.
    epoch_base_ms: f64,
    paused: bool,
    /// Whether `partial` lines are wanted.
    partials: bool,
    current: Option<Current>,
    pending: VecDeque<Pending>,
    held: Option<Held>,
    /// Speculative transcripts that arrived before their pause ran out.
    early: HashMap<u64, Finished>,
    /// Speculations that speech made stale; their transcripts are dropped.
    stale: HashSet<u64>,
    next_id: u64,
}

impl<B: Backend, S: Sink> Utterances<B, S> {
    pub(crate) fn new(
        backend: B,
        output: S,
        settings: endpointer::Settings,
        patience: Patience,
        partials: bool,
    ) -> Self {
        Self {
            backend,
            output,
            endpointer: Endpointer::new(settings),
            ring: VecDeque::new(),
            ring_first: 0,
            patience,
            epoch_base_ms: 0.0,
            paused: false,
            partials,
            current: None,
            pending: VecDeque::new(),
            held: None,
            early: HashMap::new(),
            stale: HashSet::new(),
            next_id: 0,
        }
    }

    /// Whether an utterance is being spoken (device switches wait for one
    /// to end).
    pub(crate) fn speaking(&self) -> bool {
        self.endpointer.speaking()
    }

    /// Whether transcripts are still on their way.
    pub(crate) fn waiting(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Holds new onsets while set (see [`Endpointer::set_inhibited`]).
    pub(crate) fn set_inhibited(&mut self, inhibited: bool) {
        self.endpointer.set_inhibited(inhibited);
    }

    /// Where events go.
    pub(crate) fn sink_mut(&mut self) -> &mut S {
        &mut self.output
    }

    /// Drops the utterance being spoken (`speech_cancel` with `reason` if
    /// it was announced); transcripts of ended ones still arrive.
    pub(crate) fn drop_current(&mut self, reason: &str) {
        self.cancel_current(reason);
    }

    fn epoch_ms(&self, position: usize) -> u64 {
        (self.epoch_base_ms + position as f64 * 1_000.0 / SAMPLE_RATE as f64).round() as u64
    }

    fn slice(&self, from: usize, to: usize) -> Vec<f32> {
        let end = self.ring_first + self.ring.len();
        let from = from.clamp(self.ring_first, end) - self.ring_first;
        let to = to.clamp(self.ring_first, end) - self.ring_first;
        self.ring.range(from..to.max(from)).copied().collect()
    }

    /// The next 16 kHz block of the microphone, whose last sample was
    /// captured at `now_ms`.
    pub(crate) fn audio(&mut self, block: &[f32], now_ms: u64) {
        self.ring.extend(block);
        let excess = self.ring.len().saturating_sub(samples(RING));
        self.ring.drain(..excess);
        self.ring_first += excess;
        let end = self.ring_first + self.ring.len();
        self.epoch_base_ms = now_ms as f64 - end as f64 * 1_000.0 / SAMPLE_RATE as f64;
        if self.paused {
            self.endpointer.skip(block.len());
            return;
        }
        for event in self.endpointer.push(block) {
            match event {
                endpointer::Event::Started { clip_start, onset } => self.started(clip_start, onset),
                endpointer::Event::Quiet {
                    speech_end,
                    clip_end,
                    ..
                } => self.quiet(speech_end, clip_end),
                endpointer::Event::Ended {
                    speech_end,
                    clip_end,
                    ..
                } => self.ended(speech_end, clip_end),
            }
        }
        self.confirm();
        self.ask_partial();
        self.expire_held();
    }

    fn started(&mut self, clip_start: usize, onset: usize) {
        let mut current = Current {
            clip_start,
            onset,
            onset_ms: self.epoch_ms(onset),
            partial: None,
            partial_at: onset,
            prefix: String::new(),
            after: None,
            confirmed: false,
            announced: false,
            checked_at: 0,
            last_partial: String::new(),
            speculation: None,
        };
        let longest = samples(self.patience.longest());
        if let Some(held) = self.held.take_if(|held| onset <= held.until) {
            tracing::info!(held = %held.text, "speech resumed after a hesitation; joining");
            current.onset_ms = held.pending.onset_ms;
            current.prefix = held.text;
            current.announced = held.pending.announced;
        } else if let Some(last) = self.pending.back()
            && longest > 0
            && onset.saturating_sub(last.speech_end) <= longest
        {
            current.after = Some(last.id);
        }
        self.current = Some(current);
        self.confirm_now();
    }

    /// Puts unconfirmed speech to the detector every `CHECK_EVERY`.
    fn confirm(&mut self) {
        let position = self.endpointer.position();
        if self.current.as_ref().is_some_and(|current| {
            !current.confirmed && position >= current.checked_at + samples(CHECK_EVERY)
        }) {
            self.confirm_now();
        }
    }

    fn confirm_now(&mut self) {
        let position = self.endpointer.position();
        let Some(current) = &self.current else {
            return;
        };
        let from = current
            .clip_start
            .max(position.saturating_sub(samples(CHECK_WINDOW)));
        let heard = self.backend.heard_speech(&self.slice(from, position));
        let current = self.current.as_mut().expect("checked above");
        current.checked_at = position;
        if heard != Some(false) {
            current.confirmed = true;
        }
        self.announce();
    }

    /// Sends `speech_start` once the utterance is confirmed and its own.
    fn announce(&mut self) {
        if let Some(current) = &mut self.current
            && current.confirmed
            && current.after.is_none()
            && !current.announced
        {
            current.announced = true;
            self.output.emit(&Event::SpeechStart {
                t: current.onset_ms,
            });
        }
    }

    fn quiet(&mut self, speech_end: usize, clip_end: usize) {
        let Some(current) = &self.current else {
            return;
        };
        let clip = self.slice(current.clip_start, clip_end);
        let verified = current.confirmed;
        let id = self.take_id();
        if let Some((previous, _)) = self
            .current
            .as_mut()
            .and_then(|current| current.speculation.replace((id, speech_end)))
        {
            self.stale.insert(previous);
        }
        self.backend.transcribe(id, clip, verified);
    }

    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn ended(&mut self, speech_end: usize, clip_end: usize) {
        let Some(current) = self.current.take() else {
            return;
        };
        let id = match current.speculation {
            Some((id, assumed)) if assumed == speech_end => id,
            speculation => {
                if let Some((id, _)) = speculation {
                    self.stale.insert(id);
                }
                let id = self.take_id();
                let clip = self.slice(current.clip_start, clip_end);
                self.backend.transcribe(id, clip, current.confirmed);
                id
            }
        };
        if let Some(id) = current.partial {
            self.stale.insert(id);
        }
        self.pending.push_back(Pending {
            id,
            onset: current.onset,
            speech_end,
            onset_ms: current.onset_ms,
            end_ms: self.epoch_ms(speech_end),
            prefix: current.prefix,
            after: current.after,
            announced: current.announced,
            ended_at: Instant::now(),
        });
        if let Some(early) = self.early.remove(&id) {
            self.resolve(early);
        }
    }

    /// Asks for the clip so far to be transcribed for a `partial` line.
    fn ask_partial(&mut self) {
        let position = self.endpointer.position();
        let Some(current) = &self.current else {
            return;
        };
        if !self.partials
            || !current.announced
            || current.partial.is_some()
            || position < current.partial_at + samples(PARTIAL_EVERY)
            || position - current.clip_start > samples(PARTIAL_LIMIT)
        {
            return;
        }
        let clip = self.slice(current.clip_start, position);
        let id = self.take_id();
        let current = self.current.as_mut().expect("checked above");
        current.partial = Some(id);
        current.partial_at = position;
        self.backend.transcribe(id, clip, true);
    }

    /// A partial transcription came back for the utterance being spoken.
    fn partial(&mut self, finished: Finished) {
        let t = self.epoch_ms(self.endpointer.position());
        let Some(current) = &mut self.current else {
            return;
        };
        current.partial = None;
        let Ok(text) = finished.text else {
            return;
        };
        let text = join(&current.prefix, &text);
        if !text.is_empty() && text != current.last_partial {
            self.output.emit(&Event::Partial { text: &text, t });
            current.last_partial = text;
        }
    }

    /// A transcription the backend completed.
    pub(crate) fn finished(&mut self, finished: Finished) {
        if self.stale.remove(&finished.id) {
            return;
        }
        if self
            .current
            .as_ref()
            .is_some_and(|current| current.partial == Some(finished.id))
        {
            self.partial(finished);
            return;
        }
        if self.pending.iter().any(|pending| pending.id == finished.id) {
            self.resolve(finished);
        } else {
            // A speculation whose pause has not run out yet.
            self.early.insert(finished.id, finished);
        }
        self.expire_held();
    }

    fn resolve(&mut self, finished: Finished) {
        let Some(index) = self
            .pending
            .iter()
            .position(|pending| pending.id == finished.id)
        else {
            return;
        };
        let pending = self.pending.remove(index).expect("found above");
        let text = match finished.text {
            Ok(text) => join(&pending.prefix, &text),
            Err(error) => {
                self.output.emit(&Event::Error {
                    message: &format!("transcription failed: {error}"),
                });
                pending.prefix.clone()
            }
        };
        if text.is_empty() {
            let reason = if finished.speech {
                "no words"
            } else {
                "no speech"
            };
            tracing::info!(reason, "utterance dropped");
            if pending.announced {
                self.output.emit(&Event::SpeechCancel {
                    t: pending.onset_ms,
                    reason,
                });
            }
            self.release(pending.id);
            return;
        }
        let wait = self.patience.wait(&text);
        let until = pending.speech_end + samples(wait);
        if !wait.is_zero() {
            let text = patience::to_continue(&text);
            if let Some(next) = self
                .pending
                .iter_mut()
                .find(|next| next.after == Some(pending.id) && next.onset <= until)
            {
                tracing::info!(held = %text, "a later utterance continues this one; joining");
                next.after = None;
                next.onset_ms = pending.onset_ms;
                next.prefix = join(&text, &next.prefix);
                next.announced |= pending.announced;
                return;
            }
            if let Some(current) = self
                .current
                .as_mut()
                .filter(|current| current.after == Some(pending.id) && current.onset <= until)
            {
                tracing::info!(held = %text, "speech resumed after a hesitation; joining");
                current.after = None;
                current.onset_ms = pending.onset_ms;
                current.prefix = text;
                current.announced |= pending.announced;
                current.last_partial.clear();
                self.announce();
                return;
            }
            if self.current.is_none() && self.endpointer.position() < until {
                tracing::info!(
                    held = %text,
                    wait_ms = wait.as_millis() as u64,
                    "waiting in case he goes on"
                );
                self.held = Some(Held {
                    pending,
                    text,
                    until,
                });
                return;
            }
        }
        self.emit_final(&pending, &text);
        self.release(pending.id);
    }

    /// Utterances that waited on `id` are their own.
    fn release(&mut self, id: u64) {
        for next in &mut self.pending {
            if next.after == Some(id) {
                next.after = None;
            }
        }
        if let Some(current) = &mut self.current
            && current.after == Some(id)
        {
            current.after = None;
            self.announce();
        }
    }

    fn emit_final(&mut self, pending: &Pending, text: &str) {
        if !pending.announced {
            // It waited on an earlier utterance, or was confirmed only by
            // its whole clip.
            self.output.emit(&Event::SpeechStart {
                t: pending.onset_ms,
            });
        }
        let latency_ms = pending.ended_at.elapsed().as_millis() as u64;
        tracing::info!(latency_ms, text, "final");
        self.output.emit(&Event::Final {
            text,
            start: pending.onset_ms,
            end: pending.end_ms,
            latency_ms,
        });
    }

    fn expire_held(&mut self) {
        let position = self.endpointer.position();
        if self
            .held
            .as_ref()
            .is_some_and(|held| position >= held.until)
        {
            self.flush_held();
        }
    }

    fn flush_held(&mut self) {
        if let Some(held) = self.held.take() {
            self.emit_final(&held.pending, &held.text);
        }
    }

    /// Drops the utterance being spoken, reporting why when it was
    /// announced.
    fn cancel_current(&mut self, reason: &str) {
        self.endpointer.reset();
        if let Some(current) = self.current.take() {
            let in_flight = current.speculation.map(|(id, _)| id);
            for id in in_flight.into_iter().chain(current.partial) {
                self.stale.insert(id);
            }
            if current.announced {
                self.output.emit(&Event::SpeechCancel {
                    t: current.onset_ms,
                    reason,
                });
            }
        }
    }

    pub(crate) fn pause(&mut self, now_ms: u64) {
        if self.paused {
            return;
        }
        self.paused = true;
        self.cancel_current("paused");
        self.flush_held();
        self.output.emit(&Event::Paused { t: now_ms });
    }

    pub(crate) fn resume(&mut self, now_ms: u64) {
        if !self.paused {
            return;
        }
        self.paused = false;
        self.endpointer.reset();
        self.output.emit(&Event::Resumed { t: now_ms });
    }

    /// The microphone stopped or changed: what was being said is lost.
    pub(crate) fn interrupted(&mut self, reason: &str) {
        self.cancel_current(reason);
        self.flush_held();
    }

    /// Ends listening: drops the utterance in progress; transcripts already
    /// on their way still arrive through `finished`, and nothing can
    /// continue a held one.
    pub(crate) fn stop(&mut self) {
        self.cancel_current("shutdown");
        self.flush_held();
        self.patience = Patience::none();
    }

    pub(crate) fn backend(&mut self) -> &mut B {
        &mut self.backend
    }

    /// Samples pushed so far (the position the next sample gets).
    pub(crate) fn position(&self) -> usize {
        self.endpointer.position()
    }

    /// Replaces kept audio from `from` on with `samples` (the duplex engine
    /// swaps in a cleaner signal once it knows the user was talking).
    pub(crate) fn overwrite(&mut self, from: usize, samples: &[f32]) {
        for (offset, sample) in samples.iter().enumerate() {
            let position = from + offset;
            if position >= self.ring_first
                && let Some(into) = self.ring.get_mut(position - self.ring_first)
            {
                *into = *sample;
            }
        }
    }

    /// Starts an utterance whose speech began at `onset` (a position),
    /// replacing one that started after it, which is dropped silently (the
    /// caller held its events). One that began before it goes on.
    pub(crate) fn force_start(&mut self, onset: usize) {
        let onset_ms = self.epoch_ms(onset);
        if self
            .current
            .as_ref()
            .is_some_and(|current| current.onset_ms <= onset_ms)
        {
            return;
        }
        if let Some(current) = self.current.take() {
            let in_flight = current.speculation.map(|(id, _)| id);
            for id in in_flight.into_iter().chain(current.partial) {
                self.stale.insert(id);
            }
        }
        if let endpointer::Event::Started { clip_start, onset } = self.endpointer.force_start(onset)
        {
            self.started(clip_start.max(self.ring_first), onset);
        }
    }

    /// When the utterance being spoken began (epoch ms).
    pub(crate) fn current_onset_ms(&self) -> Option<u64> {
        self.current.as_ref().map(|current| current.onset_ms)
    }
}

/// `prefix` and `text` as one transcript. The model capitalizes the start
/// of every clip, so a continuation of a sentence the prefix left open gets
/// its first word lowered ("Vera, check the" + "Hex thread" stays, "Vera" +
/// "What's new?" becomes "Vera what's new?"); "I" and words in capitals
/// keep theirs.
pub(crate) fn join(prefix: &str, text: &str) -> String {
    match (prefix.trim(), text.trim()) {
        ("", text) => text.to_owned(),
        (prefix, "") => prefix.to_owned(),
        (prefix, text) => {
            let first = text.split_whitespace().next().unwrap_or("");
            let mut letters = first.chars().filter(|character| character.is_alphabetic());
            let lower_rest = letters.next().is_some_and(char::is_uppercase)
                && letters.next().is_some_and(char::is_lowercase);
            let pronoun = first == "I" || first.starts_with("I'");
            if prefix.ends_with(['.', '?', '!']) || !lower_rest || pronoun {
                return format!("{prefix} {text}");
            }
            let mut chars = text.chars();
            let head: String = chars
                .next()
                .into_iter()
                .flat_map(char::to_lowercase)
                .collect();
            format!("{prefix} {head}{}", chars.as_str())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant_ears::protocol::Output;
    use crate::transcription::pause_segmenter::tests::{noise, utterance};
    use std::sync::Arc;

    #[derive(Default)]
    struct Fake {
        speech: bool,
        /// Transcriptions asked for: id, clip length, verified.
        asked: Vec<(u64, usize, bool)>,
    }

    impl Backend for Fake {
        fn heard_speech(&mut self, _: &[f32]) -> Option<bool> {
            Some(self.speech)
        }
        fn transcribe(&mut self, id: u64, clip: Vec<f32>, verified: bool) {
            self.asked.push((id, clip.len(), verified));
        }
    }

    type Ears = Utterances<Fake, Arc<Output<Vec<u8>>>>;

    fn ears(speech: bool) -> (Ears, Arc<Output<Vec<u8>>>) {
        let output = Arc::new(Output::new(Vec::new()));
        let ears = Utterances::new(
            Fake {
                speech,
                ..Fake::default()
            },
            output.clone(),
            endpointer::Settings::default(),
            Patience::default(),
            false,
        );
        (ears, output)
    }

    /// Plays `audio` in 10 ms blocks, answering each transcription request
    /// as `reply` says when it is asked.
    fn play(ears: &mut Ears, audio: &[f32], reply: &mut dyn FnMut(u64) -> Option<Finished>) {
        let mut answered = 0;
        for (index, block) in audio.chunks(160).enumerate() {
            ears.audio(block, 1_000_000 + index as u64 * 10);
            while answered < ears.backend().asked.len() {
                let (id, ..) = ears.backend().asked[answered];
                answered += 1;
                if let Some(finished) = reply(id) {
                    ears.finished(finished);
                }
            }
        }
    }

    fn lines(output: &Output<Vec<u8>>) -> Vec<serde_json::Value> {
        // The output is only read once the test is done writing.
        let bytes = output.snapshot();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn kinds(lines: &[serde_json::Value]) -> Vec<String> {
        lines
            .iter()
            .map(|line| line["type"].as_str().unwrap().to_owned())
            .collect()
    }

    fn said(text: &str) -> impl FnMut(u64) -> Option<Finished> + '_ {
        move |id| {
            Some(Finished {
                id,
                text: Ok(text.to_owned()),
                speech: true,
            })
        }
    }

    fn room(duration_ms: usize) -> Vec<f32> {
        let mut seed = 3;
        noise(duration_ms, -70.0, &mut seed)
    }

    #[test]
    fn an_utterance_is_announced_then_final_once_the_pause_runs_out() {
        let (mut ears, output) = ears(true);
        let mut audio = room(500);
        audio.extend(utterance(&[(1_500, 1_500)], -70.0));
        play(&mut ears, &audio, &mut said("Vera, what's new?"));
        let lines = lines(&output);
        assert_eq!(kinds(&lines), ["speech_start", "final"]);
        assert_eq!(lines[1]["text"], "Vera, what's new?");
        assert_eq!(lines[0]["t"], lines[1]["start"]);
        // Onset at 500 ms after the first block's clock; speech ends 1.5 s later.
        let start = lines[1]["start"].as_u64().unwrap();
        let end = lines[1]["end"].as_u64().unwrap();
        assert!((1_480..=1_560).contains(&(end - start)), "{}", end - start);
        // The speculation during the pause was the one used.
        assert_eq!(ears.backend().asked.len(), 1);
        assert!(
            ears.backend().asked[0].2,
            "confirmed speech skips the check"
        );
    }

    #[test]
    fn noise_the_detector_rejects_says_nothing() {
        let (mut ears, output) = ears(false);
        let mut seed = 1;
        let mut audio = room(300);
        audio.extend(noise(1_000, -20.0, &mut seed));
        audio.extend(room(1_500));
        play(&mut ears, &audio, &mut |id| {
            Some(Finished {
                id,
                text: Ok(String::new()),
                speech: false,
            })
        });
        assert!(lines(&output).is_empty());
        assert!(
            !ears.backend().asked[0].2,
            "unconfirmed clips are checked again"
        );
    }

    #[test]
    fn a_breath_after_words_that_trail_off_joins_one_request() {
        let (mut ears, output) = ears(true);
        let mut audio = room(300);
        // "Vera, can you check the" … 1 s … "hex thread."
        audio.extend(utterance(&[(1_200, 1_000), (900, 2_000)], -70.0));
        let mut replies = ["Vera, can you check the", "hex thread."].into_iter();
        play(&mut ears, &audio, &mut |id| {
            Some(Finished {
                id,
                text: Ok(replies.next().unwrap_or("").to_owned()),
                speech: true,
            })
        });
        let lines = lines(&output);
        assert_eq!(kinds(&lines), ["speech_start", "final"], "{lines:?}");
        assert_eq!(lines[1]["text"], "Vera, can you check the hex thread.");
        assert_eq!(lines[0]["t"], lines[1]["start"]);
    }

    #[test]
    fn a_complete_sentence_is_not_held_for_what_follows() {
        let (mut ears, output) = ears(true);
        let mut audio = room(300);
        audio.extend(utterance(&[(1_200, 1_000), (900, 2_000)], -70.0));
        let mut replies = ["Vera, what's new?", "Also the weather."].into_iter();
        play(&mut ears, &audio, &mut |id| {
            Some(Finished {
                id,
                text: Ok(replies.next().unwrap_or("").to_owned()),
                speech: true,
            })
        });
        let lines = lines(&output);
        assert_eq!(
            kinds(&lines),
            ["speech_start", "final", "speech_start", "final"],
            "{lines:?}"
        );
        assert_eq!(lines[1]["text"], "Vera, what's new?");
        assert_eq!(lines[3]["text"], "Also the weather.");
    }

    #[test]
    fn trailing_words_alone_end_after_the_hesitation() {
        let (mut ears, output) = ears(true);
        let mut audio = room(300);
        audio.extend(utterance(&[(600, 0)], -70.0));
        let speech_end = audio.len();
        audio.extend(room(2_000));
        let mut at = None;
        let mut answered = 0;
        for (index, block) in audio.chunks(160).enumerate() {
            ears.audio(block, index as u64 * 10);
            while answered < ears.backend().asked.len() {
                let (id, ..) = ears.backend().asked[answered];
                answered += 1;
                ears.finished(Finished {
                    id,
                    text: Ok("Vera".into()),
                    speech: true,
                });
            }
            if at.is_none() && kinds(&lines(&output)).contains(&"final".to_owned()) {
                at = Some((index + 1) * 160);
            }
        }
        let waited_ms = (at.expect("a final") - speech_end) / 16;
        assert!((1_180..=1_240).contains(&waited_ms), "{waited_ms}");
    }

    /// How long after its speech ends a lone utterance transcribed as
    /// `text` takes to become final.
    fn wait_for(text: &str) -> usize {
        let (mut ears, output) = ears(true);
        let mut audio = room(300);
        audio.extend(utterance(&[(900, 0)], -70.0));
        let speech_end = audio.len();
        audio.extend(room(9_000));
        let mut answered = 0;
        for (index, block) in audio.chunks(160).enumerate() {
            ears.audio(block, index as u64 * 10);
            while answered < ears.backend().asked.len() {
                let (id, ..) = ears.backend().asked[answered];
                answered += 1;
                ears.finished(Finished {
                    id,
                    text: Ok(text.into()),
                    speech: true,
                });
            }
            if kinds(&lines(&output)).contains(&"final".to_owned()) {
                return ((index + 1) * 160 - speech_end) / 16;
            }
        }
        panic!("no final for {text:?}");
    }

    #[test]
    fn a_clear_question_is_final_quickly_and_a_trailing_um_waits() {
        let question = wait_for("Vera, what's new?");
        assert!((680..=760).contains(&question), "{question}");
        let statement = wait_for("Check the hex thread.");
        assert!((1_180..=1_240).contains(&statement), "{statement}");
        let um = wait_for("So I was thinking about the, um.");
        assert!((4_980..=5_040).contains(&um), "{um}");
        let and = wait_for("Check the build and");
        assert!((4_980..=5_040).contains(&and), "{and}");
    }

    fn one_request(first: &str, pause_ms: usize, second: &str) -> Vec<serde_json::Value> {
        let (mut ears, output) = ears(true);
        let mut audio = room(300);
        audio.extend(utterance(&[(1_200, pause_ms), (900, 2_000)], -70.0));
        let mut replies = [first, second].into_iter();
        play(&mut ears, &audio, &mut |id| {
            Some(Finished {
                id,
                text: Ok(replies.next().unwrap_or("").to_owned()),
                speech: true,
            })
        });
        lines(&output)
    }

    #[test]
    fn three_seconds_on_an_um_mid_sentence_stays_one_request() {
        let lines = one_request("So I was thinking about the, um.", 3_000, "Hex thread.");
        assert_eq!(kinds(&lines), ["speech_start", "final"], "{lines:?}");
        assert_eq!(
            lines[1]["text"],
            "So I was thinking about the, um hex thread."
        );
    }

    #[test]
    fn three_seconds_after_a_trailing_and_stays_one_request() {
        let lines = one_request("Check the build and.", 3_000, "Run the tests.");
        assert_eq!(kinds(&lines), ["speech_start", "final"], "{lines:?}");
        assert_eq!(lines[1]["text"], "Check the build and run the tests.");
    }

    #[test]
    fn a_question_then_a_long_pause_is_its_own_request() {
        let lines = one_request("What's new?", 3_000, "Also the weather.");
        assert_eq!(
            kinds(&lines),
            ["speech_start", "final", "speech_start", "final"],
            "{lines:?}"
        );
    }

    fn ears_with_partials() -> (Ears, Arc<Output<Vec<u8>>>) {
        let output = Arc::new(Output::new(Vec::new()));
        let ears = Utterances::new(
            Fake {
                speech: true,
                ..Fake::default()
            },
            output.clone(),
            endpointer::Settings::default(),
            Patience::default(),
            true,
        );
        (ears, output)
    }

    #[test]
    fn a_partial_that_lands_after_its_utterance_ended_is_dropped() {
        let (mut ears, output) = ears_with_partials();
        let mut audio = room(300);
        audio.extend(utterance(&[(2_000, 1_500)], -70.0));
        play(&mut ears, &audio, &mut |_| None);
        // One partial in flight at a time, then the speculation.
        let requests = ears.backend().asked.clone();
        assert_eq!(requests.len(), 2, "{requests:?}");
        let (partial, speculation) = (requests[0].0, requests[1].0);
        ears.finished(Finished {
            id: partial,
            text: Ok("Vera, what's".into()),
            speech: true,
        });
        ears.finished(Finished {
            id: speculation,
            text: Ok("Vera, what's new?".into()),
            speech: true,
        });
        let lines = lines(&output);
        assert_eq!(kinds(&lines), ["speech_start", "final"], "{lines:?}");
    }

    #[test]
    fn partials_follow_the_clip_while_it_is_spoken() {
        let (mut ears, output) = ears_with_partials();
        let mut audio = room(300);
        audio.extend(utterance(&[(2_000, 1_500)], -70.0));
        let mut replies = 0;
        play(&mut ears, &audio, &mut |id| {
            replies += 1;
            let text = if replies < 4 {
                format!("word {replies}")
            } else {
                "Done.".into()
            };
            Some(Finished {
                id,
                text: Ok(text),
                speech: true,
            })
        });
        let kinds = kinds(&lines(&output));
        assert_eq!(kinds.first().map(String::as_str), Some("speech_start"));
        assert_eq!(kinds.last().map(String::as_str), Some("final"));
        let partials = kinds.iter().filter(|kind| *kind == "partial").count();
        assert!(partials >= 3, "{kinds:?}");
    }

    #[test]
    fn joined_continuations_read_as_one_sentence() {
        assert_eq!(join("Vera", "What's new?"), "Vera what's new?");
        assert_eq!(
            join("Vera, open the browser and", "Search."),
            "Vera, open the browser and search."
        );
        assert_eq!(join("Vera, ask", "I think so."), "Vera, ask I think so.");
        assert_eq!(join("Check the", "T3 threads."), "Check the T3 threads.");
        assert_eq!(join("Stop.", "Thanks."), "Stop. Thanks.");
        assert_eq!(join("", "Hello."), "Hello.");
        assert_eq!(join("Hello.", " "), "Hello.");
    }

    #[test]
    fn pausing_drops_the_utterance_in_progress() {
        let (mut ears, output) = ears(true);
        let mut audio = room(300);
        audio.extend(utterance(&[(800, 0)], -70.0));
        play(&mut ears, &audio, &mut said("never"));
        ears.pause(5);
        play(
            &mut ears,
            &utterance(&[(800, 1_500)], -70.0),
            &mut said("unheard"),
        );
        ears.resume(6);
        assert_eq!(
            kinds(&lines(&output)),
            ["speech_start", "speech_cancel", "paused", "resumed"]
        );
    }
}
