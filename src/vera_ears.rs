//! `hex ears`: Vera's always-on ears. Opens the microphone, listens
//! hands-free, cuts speech into utterances at pauses, transcribes each one
//! on Hex's local model, and prints the Ears JSON-lines contract from
//! `VERA.md` on stdout (`ready`, `speech_start`, `partial`, `final`,
//! `error`, plus `speech_cancel`, `paused`, `resumed`), reading
//! `pause`/`resume`/`shutdown` commands on stdin. Logs go to stderr. There
//! is no shortcut, paste, History, or HUD: whatever is said is transcribed,
//! and the caller (Vera Core) gates on the wake word. `docs/vera-ears.md`
//! has the details and measurements.
//!
//! It shares nothing writable with the installed Hex: the data folder is its
//! own (`~/.vera/ears/hex` unless `HEX_APPLICATION_SUPPORT_DIR` says
//! otherwise, see [`isolate`]), it takes no instance lock, and it only reads
//! the models the installed Hex downloaded (`%LOCALAPPDATA%\hex\models`).
//! The microphone is shared: WASAPI lets both processes capture at once.
//!
//! The pieces: [`endpointer`] finds utterances in the 16 kHz audio,
//! [`utterances`] turns them into events (speech-detector confirmation,
//! speculative transcription during the pause, hesitation joins), and this
//! file runs the microphone, the engine, and stdin/stdout.

pub(crate) mod endpointer;
pub(crate) mod protocol;
pub(crate) mod utterances;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::{Duration, Instant};

use clap::Args;
use color_eyre::Result;
use color_eyre::eyre::{WrapErr, eyre};

use crate::audio::{RecoveringAudioInput, RecoveringAudioInputEvent};
use crate::desktop::events::now_ms;
use crate::dictation::StreamingResampler;
use crate::transcription::engine::TranscriptionEngine;
use crate::transcription::local_transcriber::LocalTranscriber;
use crate::transcription::models::{TranscriptionModelId, TranscriptionSelection, validate};
use protocol::{Command, Event, Output};
use utterances::{Backend, Finished, Utterances};

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
    /// How long after its speech a transcript that trails off mid-phrase
    /// ("…check the") waits for more, in ms; speech that resumes inside it
    /// joins the same utterance. 0 turns it off.
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
    /// separated; an empty value turns biasing off.
    #[arg(long, default_value = "Vera", value_delimiter = ',')]
    vocabulary: Vec<String>,
    /// How readily a vocabulary term replaces the words heard: off, light,
    /// normal, or strong.
    #[arg(long, default_value = "normal", value_parser = parse_boost)]
    vocabulary_boost: crate::dictation::vocabulary::VocabularyBoost,
    /// Skip the speech detector (Silero): announce and transcribe every
    /// clip the level endpointer cuts.
    #[arg(long)]
    no_speech_check: bool,
    /// Print the microphones `--device` can name, one per line, and exit.
    #[arg(long)]
    list_devices: bool,
}

/// Gives `hex ears` its own data folder before anything reads one, keeping
/// the installed Hex's models. Called from `main` before the Windows startup
/// checks, which read (and may delete) markers in the data folder.
/// `HEX_EARS_MODELS_DIR` and `HEX_EARS_DATA_DIR` override the two folders.
pub(crate) fn isolate() {
    if std::env::var_os("HEX_APPLICATION_SUPPORT_DIR").is_some() {
        return;
    }
    let models = std::env::var_os("HEX_EARS_MODELS_DIR")
        .map(PathBuf::from)
        .or_else(|| crate::app_paths::models_dir().ok());
    let data = std::env::var_os("HEX_EARS_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            crate::app_paths::home_dir().map(|home| home.join(".vera").join("ears").join("hex"))
        });
    if let Some(models) = models {
        crate::app_paths::use_models_dir(models);
    }
    if let Some(data) = data {
        // SAFETY: called from `main` before any other thread exists.
        unsafe { std::env::set_var("HEX_APPLICATION_SUPPORT_DIR", &data) };
    }
    // Ears never opens a live stream (partials are whole-clip runs, which
    // never contend with the final for the model), so skip the stream probe
    // and its prewarm: about 4.5 s of startup.
    if std::env::var_os("HEX_STREAMING").is_none() {
        // SAFETY: as above.
        unsafe { std::env::set_var("HEX_STREAMING", "0") };
    }
}

pub(crate) fn run(args: EarsArgs, shutdown: &'static AtomicBool) -> Result<()> {
    init_logging();
    if args.list_devices {
        for name in crate::audio::input_device_names()? {
            println!("{name}");
        }
        return Ok(());
    }
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

pub(crate) fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("HEX_EARS_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("hex=info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
}

/// What Vera's ears are tuned to, shared by `hex ears` and the duplex
/// engine (`vera::audio`). [`Default`] matches the `hex ears` flags.
#[derive(Clone, Debug)]
pub(crate) struct EarsSettings {
    pub model: String,
    pub language: String,
    pub pause: Duration,
    pub hesitation: Duration,
    pub min_speech: Duration,
    pub pre_roll: Duration,
    pub max_utterance: Duration,
    pub partials: bool,
    pub vocabulary: Vec<String>,
    pub vocabulary_boost: crate::dictation::vocabulary::VocabularyBoost,
    pub check_speech: bool,
}

impl Default for EarsSettings {
    fn default() -> Self {
        Self {
            model: "parakeet_unified_en".into(),
            language: "en".into(),
            pause: Duration::from_millis(700),
            hesitation: Duration::from_millis(1_400),
            min_speech: Duration::from_millis(120),
            pre_roll: Duration::from_millis(300),
            max_utterance: Duration::from_millis(30_000),
            partials: true,
            vocabulary: vec!["Vera".into()],
            vocabulary_boost: crate::dictation::vocabulary::VocabularyBoost::Normal,
            check_speech: true,
        }
    }
}

impl EarsSettings {
    pub(crate) fn endpointer(&self) -> endpointer::Settings {
        endpointer::Settings {
            pause: self.pause,
            min_speech: self.min_speech,
            pre_roll: self.pre_roll,
            max_utterance: self.max_utterance,
        }
    }

    pub(crate) fn selection(&self) -> Result<TranscriptionSelection> {
        let selection = TranscriptionSelection {
            model: self
                .model
                .parse::<TranscriptionModelId>()
                .wrap_err_with(|| format!("invalid model id: {}", self.model))?,
            language: self.language.clone(),
        };
        validate(&selection)?;
        Ok(selection)
    }
}

impl EarsArgs {
    fn settings(&self) -> EarsSettings {
        EarsSettings {
            model: self.model.clone(),
            language: self.language.clone(),
            pause: Duration::from_millis(self.pause_ms),
            hesitation: Duration::from_millis(self.hesitation_ms),
            min_speech: Duration::from_millis(self.min_speech_ms),
            pre_roll: Duration::from_millis(self.pre_roll_ms),
            max_utterance: Duration::from_millis(self.max_utterance_ms),
            partials: !self.no_partials,
            vocabulary: self.vocabulary.clone(),
            vocabulary_boost: self.vocabulary_boost,
            check_speech: !self.no_speech_check,
        }
    }
}

/// Hex's transcription, loaded for Vera: the model on its engine thread,
/// the vocabulary bias applied, and the speech detector warmed up.
pub(crate) struct Stt {
    pub engine: Arc<TranscriptionEngine>,
    pub selection: TranscriptionSelection,
    /// Where the model runs, for example "NVIDIA GeForce RTX 5070 Ti (vulkan)".
    pub backend_label: String,
    pub check_speech: bool,
}

impl Stt {
    pub(crate) fn load(settings: &EarsSettings) -> Result<Self> {
        let selection = settings.selection()?;
        let terms: Vec<_> = settings
            .vocabulary
            .iter()
            .map(|term| term.trim())
            .filter(|term| !term.is_empty())
            .map(|term| crate::dictation::vocabulary::VocabularyEntry {
                term: term.to_owned(),
                sounds_like: Vec::new(),
            })
            .collect();
        crate::dictation::vocabulary::apply(&terms, settings.vocabulary_boost);
        let loading = Instant::now();
        let transcriber = LocalTranscriber::load(&selection)?;
        let backend_label = transcriber.device_label().to_owned();
        tracing::info!(
            model = selection.model.as_str(),
            backend = backend_label,
            load_ms = loading.elapsed().as_millis() as u64,
            "ears model ready"
        );
        // Silero loads on the CPU now, so the first utterance doesn't pay for it.
        let check_speech = settings.check_speech;
        if check_speech
            && crate::transcription::speech_detector::contains_speech(&vec![0.0; 8_000]).is_none()
        {
            tracing::warn!(
                "the speech detector is unavailable; every level-cut clip is transcribed"
            );
        }
        let engine = Arc::new(TranscriptionEngine::start(transcriber)?);
        Ok(Self {
            engine,
            selection,
            backend_label,
            check_speech,
        })
    }

    /// The [`Backend`] Utterances transcribes through; each transcript
    /// comes back on `results`.
    pub(crate) fn backend(&self, results: Sender<Finished>) -> EngineBackend {
        EngineBackend {
            jobs: spawn_finisher(self.engine.clone(), results),
            check_speech: self.check_speech,
        }
    }
}

fn listen(
    args: &EarsArgs,
    shutdown: &'static AtomicBool,
    output: &Arc<Output<std::io::Stdout>>,
) -> Result<()> {
    let settings = args.settings();
    settings.selection()?;
    let commands = spawn_stdin_reader();
    let stt = Stt::load(&settings)?;
    let partials = settings.partials;
    let selection = stt.selection.clone();
    let backend_label = stt.backend_label.clone();

    let device = match &args.device {
        Some(query) => Some(resolve_device(query)?),
        None => None,
    };
    let mut input = RecoveringAudioInput::open(device.as_deref(), 0, None);
    let (results, finished) = mpsc::channel();
    let backend = stt.backend(results);
    let mut ears = Utterances::new(
        backend,
        output.clone(),
        settings.endpointer(),
        settings.hesitation,
        partials,
    );
    let mut resampler: Option<(u32, StreamingResampler)> = None;
    let mut ready = false;
    let opened = Instant::now();
    let mut warned_silent = false;
    while !shutdown.load(Ordering::Relaxed) && !output.closed() {
        match commands.try_recv() {
            Ok(Command::Shutdown) | Err(TryRecvError::Disconnected) => break,
            Ok(Command::Pause) => ears.pause(now_ms()),
            Ok(Command::Resume) => ears.resume(now_ms()),
            Err(TryRecvError::Empty) => {}
        }
        while let Ok(result) = finished.try_recv() {
            ears.finished(result);
        }
        match input.recv_timeout(Duration::from_millis(10), !ears.speaking()) {
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
                        backend: &backend_label,
                        partials,
                        pause_ms: args.pause_ms,
                    });
                    tracing::info!(device = input.device_name(), rate, "ears listening");
                }
                ears.audio(&block, now_ms());
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
    drop(input);
    // Transcripts already on their way still arrive, briefly.
    ears.stop();
    let deadline = Instant::now() + Duration::from_secs(3);
    while ears.waiting() && Instant::now() < deadline {
        match finished.recv_timeout(Duration::from_millis(50)) {
            Ok(result) => ears.finished(result),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    tracing::info!("ears stopped");
    Ok(())
}

fn parse_boost(value: &str) -> Result<crate::dictation::vocabulary::VocabularyBoost, String> {
    use crate::dictation::vocabulary::VocabularyBoost;
    match value {
        "off" => Ok(VocabularyBoost::Off),
        "light" => Ok(VocabularyBoost::Light),
        "normal" => Ok(VocabularyBoost::Normal),
        "strong" => Ok(VocabularyBoost::Strong),
        _ => Err(format!("{value:?} is not off, light, normal, or strong")),
    }
}

pub(crate) fn resolve_device(query: &str) -> Result<String> {
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

/// [`Backend`] on Hex's transcription engine: whole-clip runs for partials
/// and finals, Silero for speech checks.
pub(crate) struct EngineBackend {
    jobs: Sender<Job>,
    check_speech: bool,
}

struct Job {
    id: u64,
    clip: Vec<f32>,
    verified: bool,
}

impl Backend for EngineBackend {
    fn heard_speech(&mut self, samples: &[f32]) -> Option<bool> {
        if !self.check_speech {
            return None;
        }
        crate::transcription::speech_detector::contains_speech(samples)
    }

    fn transcribe(&mut self, id: u64, clip: Vec<f32>, verified: bool) {
        let _ = self.jobs.send(Job {
            id,
            clip,
            verified: verified || !self.check_speech,
        });
    }
}

/// The thread that runs clips through the engine in order (after Silero
/// for clips not yet known to hold speech) and reports each transcript.
fn spawn_finisher(engine: Arc<TranscriptionEngine>, results: Sender<Finished>) -> Sender<Job> {
    let (jobs, receiver) = mpsc::channel::<Job>();
    let _ = std::thread::Builder::new()
        .name("ears-finisher".into())
        .spawn(move || {
            for job in receiver {
                let mut clip = job.clip;
                let speech = job.verified
                    || crate::transcription::speech_detector::contains_speech(&clip)
                        .unwrap_or(true);
                let text = if speech {
                    crate::dictation::pad_for_parakeet(&mut clip);
                    let started = Instant::now();
                    engine
                        .finish(None, clip)
                        .map_err(|error| format!("{error:#}"))
                        .and_then(|pending| pending.wait())
                        .map(|transcribed| {
                            tracing::debug!(
                                id = job.id,
                                run_ms = started.elapsed().as_millis() as u64,
                                "clip transcribed"
                            );
                            transcribed.text.trim().to_owned()
                        })
                } else {
                    Ok(String::new())
                };
                let finished = Finished {
                    id: job.id,
                    text,
                    speech,
                };
                if results.send(finished).is_err() {
                    return;
                }
            }
        });
    jobs
}
