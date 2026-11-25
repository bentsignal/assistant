//! `hex ears`: Vera's always-on ears. Opens the microphone, listens
//! hands-free, cuts speech into utterances at pauses, transcribes each one
//! on Hex's local model, and prints the Ears JSON-lines contract from
//! `VERA.md` on stdout (`ready`, `speech_start`, `partial`, `final`,
//! `error`), reading `pause`/`resume`/`shutdown` commands on stdin. Logs go
//! to stderr. There is no shortcut, paste, History, or HUD: whatever is said
//! is transcribed, and the caller (Vera Core) gates on the wake word.
//!
//! It shares nothing writable with the installed Hex: the data folder is its
//! own (`~/.vera/ears/hex` unless `HEX_APPLICATION_SUPPORT_DIR` says
//! otherwise, see [`isolate`]), it takes no instance lock, and it only reads
//! the models the installed Hex downloaded (`%LOCALAPPDATA%\hex\models`).
//! The microphone is shared: WASAPI lets both processes capture at once.
//!
//! Each utterance streams on the engine as it is spoken (Parakeet on the
//! GPU) for `partial` lines, and is finished with its complete clip the
//! moment the pause is reached, so `final` follows the pause by tens of ms.
//! A pause after words that trail off mid-phrase ([`endpointer::trails_off`])
//! is held up to `--hesitation-ms`: speech that resumes in time joins the
//! same utterance, and the joined clip is transcribed whole.

mod endpointer;
mod protocol;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Args;
use color_eyre::Result;
use color_eyre::eyre::{WrapErr, eyre};

use crate::audio::{RecoveringAudioInput, RecoveringAudioInputEvent};
use crate::desktop::events::now_ms;
use crate::dictation::StreamingResampler;
use crate::transcription::engine::{LiveStream, TranscriptionEngine};
use crate::transcription::local_transcriber::LocalTranscriber;
use crate::transcription::models::{TranscriptionModelId, TranscriptionSelection, validate};
use endpointer::{Endpointer, SAMPLE_RATE, samples, trails_off};
use protocol::{Command, Event, Output};

#[derive(Args, Clone, Debug)]
pub(crate) struct EarsArgs {
    /// Microphone by case-insensitive name fragment; the system default
    /// input (followed live) otherwise.
    #[arg(long)]
    device: Option<String>,
    /// Model id, for example parakeet_unified_en or parakeet_v3.
    #[arg(long, default_value = "parakeet_unified_en")]
    model: String,
    /// BCP-47 language the model supports.
    #[arg(long, default_value = "en")]
    language: String,
    /// Silence after speech that ends an utterance, in ms.
    #[arg(long, default_value_t = 700)]
    pause_ms: u64,
    /// How long a pause after words that trail off mid-phrase ("…and the")
    /// is held before the utterance ends, in ms; speech that resumes inside
    /// it joins the same utterance. 0 turns it off.
    #[arg(long, default_value_t = 1_400)]
    hesitation_ms: u64,
    /// Speech needed before an utterance starts, in ms.
    #[arg(long, default_value_t = 120)]
    min_speech_ms: u64,
    /// Audio kept from before the detected onset, in ms.
    #[arg(long, default_value_t = 300)]
    pre_roll_ms: u64,
    /// Utterances longer than this end at the next short pause, in ms.
    #[arg(long, default_value_t = 30_000)]
    max_utterance_ms: u64,
    /// Don't stream partial transcripts.
    #[arg(long)]
    no_partials: bool,
    /// Vocabulary terms the model is biased toward (Parakeet), comma
    /// separated. "Vera" helps the wake word come out spelled right.
    #[arg(long, default_value = "Vera", value_delimiter = ',')]
    vocabulary: Vec<String>,
    /// Keep the speech detector's verdict out: transcribe every clip the
    /// level endpointer cuts.
    #[arg(long)]
    no_speech_check: bool,
}

/// Gives `hex ears` its own data folder before anything reads one, keeping
/// the installed Hex's models. Called from `main` before the Windows startup
/// checks, which read and may delete markers in the data folder.
pub(crate) fn isolate() {
    if std::env::var_os("HEX_APPLICATION_SUPPORT_DIR").is_some() {
        return;
    }
    let models = std::env::var_os("HEX_EARS_MODELS_DIR")
        .map(PathBuf::from)
        .or_else(|| crate::app_paths::models_dir().ok());
    let data = std::env::var_os("HEX_EARS_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| crate::app_paths::home_dir().map(|home| home.join(".vera").join("ears").join("hex")));
    if let Some(models) = models {
        crate::app_paths::use_models_dir(models);
    }
    if let Some(data) = data {
        // SAFETY: called from `main` before any other thread exists.
        unsafe { std::env::set_var("HEX_APPLICATION_SUPPORT_DIR", &data) };
    }
}

pub(crate) fn run(args: EarsArgs, shutdown: &'static AtomicBool) -> Result<()> {
    init_logging();
    let _ = ctrlc::set_handler(move || shutdown.store(true, Ordering::Relaxed));
    let output = Arc::new(Output::new(std::io::stdout()));
    match listen(&args, shutdown, &output) {
        Ok(()) => Ok(()),
        Err(error) => {
            let message = format!("{error:#}");
            tracing::error!(%message, "ears stopped");
            output.emit(&Event::Error { message: &message });
            Err(error)
        }
    }
}

fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("HEX_EARS_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("hex=info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
}

fn listen(args: &EarsArgs, shutdown: &'static AtomicBool, output: &Arc<Output<std::io::Stdout>>) -> Result<()> {
    let selection = TranscriptionSelection {
        model: args
            .model
            .parse::<TranscriptionModelId>()
            .wrap_err_with(|| format!("invalid model id: {}", args.model))?,
        language: args.language.clone(),
    };
    validate(&selection)?;
    let terms: Vec<_> = args
        .vocabulary
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
        .map(|term| crate::dictation::vocabulary::VocabularyEntry {
            term: term.to_owned(),
            sounds_like: Vec::new(),
        })
        .collect();
    crate::dictation::vocabulary::apply(
        &terms,
        crate::dictation::vocabulary::VocabularyBoost::Normal,
    );

    let commands = spawn_stdin_reader();
    let loading = Instant::now();
    let transcriber = LocalTranscriber::load(&selection)?;
    let backend = transcriber.device_label().to_owned();
    tracing::info!(
        model = selection.model.as_str(),
        backend,
        load_ms = loading.elapsed().as_millis() as u64,
        "ears model ready"
    );
    // Silero loads on the CPU now, so the first utterance doesn't pay for it.
    if !args.no_speech_check {
        let _ = crate::transcription::speech_detector::contains_speech(&vec![0.0; 8_000]);
    }
    let engine = Arc::new(TranscriptionEngine::start(transcriber)?);
    let partials = !args.no_partials && engine.streams();
    let _demand = partials.then(crate::dictation::live_text::client_demand);

    let device = match &args.device {
        Some(query) => Some(resolve_device(query)?),
        None => None,
    };
    let mut input = RecoveringAudioInput::open(device.as_deref(), 0, None);
    let (results, finished) = mpsc::channel();
    let finisher = spawn_finisher(engine.clone(), results, !args.no_speech_check);

    let mut ears = Ears::new(args, output.clone(), engine.clone(), finisher, partials);
    let mut resampler: Option<(u32, StreamingResampler)> = None;
    let mut ready = false;
    let opened = Instant::now();
    let mut warned_silent = false;
    while !shutdown.load(Ordering::Relaxed) && !output.closed() {
        match commands.try_recv() {
            Ok(Command::Shutdown) | Err(TryRecvError::Disconnected) => break,
            Ok(Command::Pause) => ears.pause(),
            Ok(Command::Resume) => ears.resume(),
            Err(TryRecvError::Empty) => {}
        }
        ears.collect(&finished);
        match input.recv_timeout(Duration::from_millis(20), !ears.endpointer.speaking()) {
            RecoveringAudioInputEvent::Chunk { samples, .. } => {
                let rate = input.sample_rate();
                if resampler.as_ref().is_none_or(|(at, _)| *at != rate) {
                    resampler = Some((
                        rate,
                        StreamingResampler::new(rate).map_err(|error| eyre!(error))?,
                    ));
                }
                let block = resampler.as_mut().expect("set above").1.push(&samples);
                if !ready {
                    ready = true;
                    output.emit(&Event::Ready {
                        engine: "hex",
                        model: selection.model.as_str(),
                        language: &selection.language,
                        device: input.device_name(),
                        backend: &backend,
                        partials,
                        pause_ms: args.pause_ms,
                    });
                    tracing::info!(device = input.device_name(), rate, "ears listening");
                }
                ears.audio(&block);
            }
            RecoveringAudioInputEvent::Timeout => {}
            RecoveringAudioInputEvent::Interrupted | RecoveringAudioInputEvent::Reopened => {
                resampler = None;
                ears.interrupted("microphone interrupted");
            }
            RecoveringAudioInputEvent::OpenFailed(error) => {
                ears.interrupted("microphone unavailable");
                output.emit(&Event::Error {
                    message: &format!("could not open the microphone (retrying): {error}"),
                });
            }
        }
        if !ready && !warned_silent && opened.elapsed() > Duration::from_secs(5) {
            warned_silent = true;
            output.emit(&Event::Error {
                message: "the microphone has delivered no audio for 5 s; still waiting",
            });
        }
    }
    ears.close(&finished);
    tracing::info!("ears stopped");
    Ok(())
}

fn resolve_device(query: &str) -> Result<String> {
    let lower = query.to_lowercase();
    crate::audio::input_device_names()?
        .into_iter()
        .find(|name| name.to_lowercase().contains(&lower))
        .ok_or_else(|| eyre!("no microphone matches {query:?}"))
}

fn spawn_stdin_reader() -> Receiver<Command> {
    let (sender, receiver) = mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("ears-stdin".into())
        .spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match std::io::stdin().read_line(&mut line) {
                    // The parent closed our stdin: it is gone or wants us gone.
                    Ok(0) | Err(_) => return,
                    Ok(_) => match protocol::parse_command(&line) {
                        Some(Ok(command)) => {
                            if sender.send(command).is_err() {
                                return;
                            }
                        }
                        Some(Err(error)) => tracing::warn!(%error, "ignoring stdin line"),
                        None => {}
                    },
                }
            }
        });
    receiver
}

/// One ended utterance on its way through the engine.
struct Job {
    id: u64,
    stream: Option<LiveStream>,
    clip: Vec<f32>,
    /// When the pause was reached.
    ended_at: Instant,
}

struct Finished {
    id: u64,
    text: Result<String, String>,
    speech: bool,
    ended_at: Instant,
}

/// The thread that finishes utterances in order: the engine's transcript
/// and, beside it on the CPU, Silero's verdict on whether the clip holds
/// speech at all.
fn spawn_finisher(
    engine: Arc<TranscriptionEngine>,
    results: Sender<Finished>,
    check_speech: bool,
) -> Sender<Job> {
    let (jobs, receiver) = mpsc::channel::<Job>();
    let _ = std::thread::Builder::new()
        .name("ears-finisher".into())
        .spawn(move || {
            for job in receiver {
                let mut clip = job.clip;
                let speech = !check_speech
                    || crate::transcription::speech_detector::contains_speech(&clip)
                        .unwrap_or(true);
                let text = if speech {
                    crate::dictation::pad_for_parakeet(&mut clip);
                    engine
                        .finish(job.stream, clip)
                        .map_err(|error| format!("{error:#}"))
                        .and_then(|pending| pending.wait())
                        .map(|transcribed| {
                            tracing::info!(
                                finish_ms = transcribed.finish_ms,
                                source = transcribed.source.label(),
                                "utterance transcribed"
                            );
                            transcribed.text.trim().to_owned()
                        })
                } else {
                    drop(job.stream);
                    Ok(String::new())
                };
                if results
                    .send(Finished {
                        id: job.id,
                        text,
                        speech,
                        ended_at: job.ended_at,
                    })
                    .is_err()
                {
                    return;
                }
            }
        });
    jobs
}

/// The 16 kHz audio of the last `RING_SECONDS`, addressed by absolute
/// position.
struct Ring {
    samples: VecDeque<f32>,
    first: usize,
}

const RING_SECONDS: usize = 120;

impl Ring {
    fn push(&mut self, block: &[f32]) {
        self.samples.extend(block);
        let excess = self.samples.len().saturating_sub(RING_SECONDS * SAMPLE_RATE);
        self.samples.drain(..excess);
        self.first += excess;
    }

    fn end(&self) -> usize {
        self.first + self.samples.len()
    }

    fn slice(&self, from: usize, to: usize) -> Vec<f32> {
        let from = from.clamp(self.first, self.end()) - self.first;
        let to = to.clamp(self.first, self.end()) - self.first;
        self.samples.range(from..to.max(from)).copied().collect()
    }
}

/// The utterance being spoken.
struct Current {
    clip_start: usize,
    onset_ms: u64,
    stream: Option<LiveStream>,
    fed_until: usize,
    /// Text of an earlier, held utterance this one continues.
    prefix: String,
    /// The `speech_start` waits for an earlier utterance's transcript, which
    /// decides whether this one continues it.
    after: Option<u64>,
    last_partial: String,
}

/// An ended utterance whose transcript is still coming.
struct Pending {
    id: u64,
    clip_start: usize,
    speech_end: usize,
    onset_ms: u64,
    end_ms: u64,
    /// Transcript of earlier utterances this one continues.
    prefix: String,
    /// The earlier utterance whose transcript decides whether this one
    /// continues it; its `speech_start` waits until then.
    after: Option<u64>,
}

/// A transcript that trailed off, held for the hesitation pause.
struct Held {
    pending: Pending,
    text: String,
    ended_at: Instant,
}

struct Ears {
    output: Arc<Output<std::io::Stdout>>,
    engine: Arc<TranscriptionEngine>,
    endpointer: Endpointer,
    ring: Ring,
    finisher: Sender<Job>,
    streams: bool,
    hesitation: usize,
    /// Wall-clock ms of ring position 0, refreshed with each block.
    epoch_base_ms: f64,
    paused: bool,
    current: Option<Current>,
    pending: VecDeque<Pending>,
    held: Option<Held>,
    next_id: u64,
}

impl Ears {
    fn new(
        args: &EarsArgs,
        output: Arc<Output<std::io::Stdout>>,
        engine: Arc<TranscriptionEngine>,
        finisher: Sender<Job>,
        streams: bool,
    ) -> Self {
        let settings = endpointer::Settings {
            pause: Duration::from_millis(args.pause_ms),
            min_speech: Duration::from_millis(args.min_speech_ms),
            pre_roll: Duration::from_millis(args.pre_roll_ms),
            max_utterance: Duration::from_millis(args.max_utterance_ms),
        };
        Self {
            output,
            engine,
            endpointer: Endpointer::new(settings),
            ring: Ring {
                samples: VecDeque::new(),
                first: 0,
            },
            finisher,
            streams,
            hesitation: samples(Duration::from_millis(args.hesitation_ms)),
            epoch_base_ms: now_ms() as f64,
            paused: false,
            current: None,
            pending: VecDeque::new(),
            held: None,
            next_id: 0,
        }
    }

    /// Unix ms of an absolute position, on the wall clock of the last block.
    fn epoch_ms(&self, position: usize) -> u64 {
        (self.epoch_base_ms + position as f64 * 1_000.0 / SAMPLE_RATE as f64).round() as u64
    }

    fn audio(&mut self, block: &[f32]) {
        self.ring.push(block);
        let end = self.ring.end();
        // The block's last sample was captured about now.
        self.epoch_base_ms = now_ms() as f64 - end as f64 * 1_000.0 / SAMPLE_RATE as f64;
        if self.paused {
            self.endpointer.skip(block.len());
            return;
        }
        for event in self.endpointer.push(block) {
            match event {
                endpointer::Event::Started { clip_start, onset } => self.started(clip_start, onset),
                endpointer::Event::Ended {
                    speech_end,
                    clip_end,
                    ..
                } => self.ended(speech_end, clip_end),
            }
        }
        self.feed();
        self.expire_held();
    }

    fn started(&mut self, clip_start: usize, onset: usize) {
        let mut current = Current {
            clip_start,
            onset_ms: self.epoch_ms(onset),
            stream: None,
            fed_until: clip_start,
            prefix: String::new(),
            after: None,
            last_partial: String::new(),
        };
        let hesitation = self.hesitation;
        let within = |speech_end: usize| hesitation > 0 && onset.saturating_sub(speech_end) <= hesitation;
        if let Some(held) = self.held.take_if(|held| within(held.pending.speech_end)) {
            // Speech resumed after words that trailed off: one utterance,
            // whose joined clip is finished whole (no stream).
            tracing::info!(held = %held.text, "speech resumed after a hesitation; joining");
            current.clip_start = held.pending.clip_start;
            current.onset_ms = held.pending.onset_ms;
            current.prefix = held.text;
            self.current = Some(current);
            return;
        }
        if self.streams {
            current.stream = self.engine.begin_ignoring_head(0);
        }
        if let Some(last) = self.pending.back()
            && within(last.speech_end)
        {
            // Whether this continues the last utterance depends on its
            // transcript, which is still coming; `resolve` decides.
            current.after = Some(last.id);
        } else {
            self.output.emit(&Event::SpeechStart {
                t: current.onset_ms,
            });
        }
        self.current = Some(current);
    }

    fn ended(&mut self, speech_end: usize, clip_end: usize) {
        let Some(mut current) = self.current.take() else {
            return;
        };
        if current.after.is_some() {
            // The earlier transcript is still out; it decides this one's
            // fate when it lands, so keep listening as one utterance.
            tracing::debug!("utterance ended before the one it may continue resolved");
        }
        let id = self.next_id;
        self.next_id += 1;
        let clip = self.ring.slice(current.clip_start, clip_end);
        if let Some(stream) = &mut current.stream {
            stream.feed(&self.ring.slice(current.fed_until, clip_end));
        }
        self.pending.push_back(Pending {
            id,
            clip_start: current.clip_start,
            speech_end,
            onset_ms: current.onset_ms,
            end_ms: self.epoch_ms(speech_end),
            prefix: current.prefix,
            after: current.after,
        });
        let _ = self.finisher.send(Job {
            id,
            stream: current.stream,
            clip,
            ended_at: Instant::now(),
        });
    }

    /// Feeds the utterance's stream and reports its partial text.
    fn feed(&mut self) {
        let end = self.ring.end();
        let t = self.epoch_ms(end);
        let Some(current) = &mut self.current else {
            return;
        };
        let Some(stream) = &mut current.stream else {
            return;
        };
        if current.fed_until < end {
            stream.feed(&self.ring.slice(current.fed_until, end));
            current.fed_until = end;
        }
        if current.after.is_some() {
            return;
        }
        if let Some(partial) = stream.take_partial() {
            let text = join(
                &current.prefix,
                &format!("{}{}", partial.stable, partial.tentative),
            );
            if !text.is_empty() && text != current.last_partial {
                self.output.emit(&Event::Partial { text: &text, t });
                current.last_partial = text;
            }
        }
    }

    /// Takes finished transcripts in order and decides what each becomes.
    fn collect(&mut self, finished: &Receiver<Finished>) {
        while let Ok(result) = finished.try_recv() {
            self.resolve(result);
        }
        self.expire_held();
    }

    fn resolve(&mut self, result: Finished) {
        let Some(index) = self.pending.iter().position(|pending| pending.id == result.id) else {
            return;
        };
        let pending = self.pending.remove(index).expect("found above");
        let text = match result.text {
            Ok(text) => join(&pending.prefix, &text),
            Err(error) => {
                self.output.emit(&Event::Error {
                    message: &format!("transcription failed: {error}"),
                });
                pending.prefix.clone()
            }
        };
        if text.is_empty() {
            let reason = if result.speech { "no words" } else { "no speech" };
            tracing::info!(reason, "utterance dropped");
            if pending.after.is_none() {
                self.output.emit(&Event::SpeechCancel {
                    t: pending.onset_ms,
                    reason,
                });
            }
            self.release_waiting(pending.id);
            return;
        }
        // An utterance that ended while it waited on this one: its own
        // transcript joins this one's when this trails off.
        let follower = self
            .pending
            .iter()
            .position(|next| next.after == Some(pending.id));
        let trailing = self.hesitation > 0 && trails_off(&text);
        if trailing {
            if let Some(index) = follower {
                // Both ended already: the follower's transcript continues
                // this one. Its clip was transcribed alone, so the joined
                // text is the two transcripts in order.
                let next = &mut self.pending[index];
                next.after = None;
                next.clip_start = pending.clip_start;
                next.onset_ms = pending.onset_ms;
                next.prefix = join(&text, &next.prefix);
                tracing::info!(held = %text, "a later utterance continues this one; joining");
                return;
            }
            if let Some(current) = self
                .current
                .as_mut()
                .filter(|current| current.after == Some(pending.id))
            {
                tracing::info!(held = %text, "speech resumed after a hesitation; joining");
                current.after = None;
                current.clip_start = pending.clip_start;
                current.onset_ms = pending.onset_ms;
                current.prefix = text;
                current.stream = None;
                return;
            }
            if self.current.is_none() {
                self.held = Some(Held {
                    pending,
                    text,
                    ended_at: result.ended_at,
                });
                return;
            }
        }
        if pending.after.is_some() {
            // It waited on an utterance that was final on its own, so its
            // `speech_start` was never sent.
            self.output.emit(&Event::SpeechStart {
                t: pending.onset_ms,
            });
        }
        self.emit_final(&pending, &text, result.ended_at);
        if let Some(index) = follower {
            let next = &mut self.pending[index];
            next.after = None;
            self.output.emit(&Event::SpeechStart { t: next.onset_ms });
        }
        self.release_waiting(pending.id);
    }

    /// The utterance being spoken that waited on `id` is its own: it starts.
    fn release_waiting(&mut self, id: u64) {
        if let Some(current) = &mut self.current
            && current.after == Some(id)
        {
            current.after = None;
            self.output.emit(&Event::SpeechStart {
                t: current.onset_ms,
            });
        }
        for next in &mut self.pending {
            if next.after == Some(id) {
                next.after = None;
                self.output.emit(&Event::SpeechStart { t: next.onset_ms });
            }
        }
    }

    fn emit_final(&self, pending: &Pending, text: &str, ended_at: Instant) {
        let latency_ms = ended_at.elapsed().as_millis() as u64;
        tracing::info!(latency_ms, text, "final");
        self.output.emit(&Event::Final {
            text,
            start: pending.onset_ms,
            end: pending.end_ms,
            latency_ms,
        });
    }

    /// A held transcript whose hesitation passed with no more speech ends as
    /// it is.
    fn expire_held(&mut self) {
        let position = self.endpointer.position();
        if self
            .held
            .as_ref()
            .is_some_and(|held| position >= held.pending.speech_end + self.hesitation)
        {
            self.flush_held();
        }
    }

    fn flush_held(&mut self) {
        if let Some(held) = self.held.take() {
            self.emit_final(&held.pending, &held.text, held.ended_at);
        }
    }

    /// Drops the utterance being spoken, reporting why.
    fn cancel_current(&mut self, reason: &str) {
        self.endpointer.reset();
        if let Some(current) = self.current.take() {
            if current.after.is_none() {
                self.output.emit(&Event::SpeechCancel {
                    t: current.onset_ms,
                    reason,
                });
            } else if !current.prefix.is_empty() {
                tracing::debug!("dropped a continuation");
            }
        }
    }

    fn pause(&mut self) {
        if self.paused {
            return;
        }
        self.paused = true;
        self.cancel_current("paused");
        self.flush_held();
        self.output.emit(&Event::Paused { t: now_ms() });
    }

    fn resume(&mut self) {
        if !self.paused {
            return;
        }
        self.paused = false;
        self.endpointer.reset();
        self.output.emit(&Event::Resumed { t: now_ms() });
    }

    fn interrupted(&mut self, reason: &str) {
        self.cancel_current(reason);
        self.flush_held();
    }

    /// Lets transcripts already on their way arrive, briefly, then ends.
    fn close(&mut self, finished: &Receiver<Finished>) {
        self.cancel_current("shutdown");
        let deadline = Instant::now() + Duration::from_secs(3);
        while !self.pending.is_empty() && Instant::now() < deadline {
            match finished.recv_timeout(Duration::from_millis(50)) {
                Ok(result) => self.resolve(result),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            // Nothing can continue a held transcript now.
            self.flush_held();
        }
        self.flush_held();
    }
}

/// `prefix` and `text` as one transcript.
fn join(prefix: &str, text: &str) -> String {
    match (prefix.trim(), text.trim()) {
        ("", text) => text.to_owned(),
        (prefix, "") => prefix.to_owned(),
        (prefix, text) => format!("{prefix} {text}"),
    }
}
