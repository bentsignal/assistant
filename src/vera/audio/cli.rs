//! `hex vera-audio`: the duplex engine from the command line, to measure
//! and try it without the App. `sim` runs the simulated room, `live` a
//! short real speaker-and-microphone loop, `say` speaks through the voice
//! service, and `chime` plays a chime. Logs go to stderr, results to
//! stdout.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use clap::{Args, Subcommand};
use color_eyre::eyre::{Result, eyre};

use super::sim::{self, Plan, RoomSpec, SimStt};
use super::{AudioConfig, AudioEvent, ChimeKind, SttSource, VeraAudio};
use crate::vera_ears::{EarsSettings, Stt};

#[derive(Args, Clone, Debug)]
pub(crate) struct VeraAudioArgs {
    #[command(subcommand)]
    command: VeraAudioCommand,
}

#[derive(Subcommand, Clone, Debug)]
enum VeraAudioCommand {
    /// Measure echo cancellation and barge-in in simulated rooms.
    Sim {
        /// Voices folder with voices.json (scripts/vera-audio/make-voices.ps1).
        #[arg(long)]
        voices: PathBuf,
        /// Rooms to run (desk, laptop, kitchen, bluetooth, headset); all by default.
        #[arg(long, value_delimiter = ',')]
        room: Vec<String>,
        /// Plans to run: echo, barge, after, clean.
        #[arg(long, value_delimiter = ',', default_value = "echo,barge,after,clean")]
        plan: Vec<Plan>,
        /// Skip speech to text (detection only; finals read "(speech)").
        #[arg(long)]
        no_stt: bool,
        /// What speech to text hears: hybrid, linear, or suppressed.
        #[arg(long, default_value = "hybrid", value_parser = parse_source)]
        stt_source: SttSource,
        /// Vera's volume.
        #[arg(long, default_value_t = super::DEFAULT_VOLUME)]
        volume: f32,
        /// Write the full report as JSON here.
        #[arg(long)]
        json: Option<PathBuf>,
    },
    /// A short real loop: Vera's lines through the speakers, the
    /// microphone listening, events printed as they happen.
    Live {
        /// Voices folder with voices.json.
        #[arg(long)]
        voices: PathBuf,
        /// How many of Vera's lines to play.
        #[arg(long, default_value_t = 2)]
        lines: usize,
        #[arg(long, default_value_t = 0.45)]
        volume: f32,
        /// A WAV to play as "the user" on a stream of its own while Vera
        /// talks: it is not in Vera's reference, so it should barge in.
        #[arg(long)]
        user_wav: Option<PathBuf>,
        /// The user's level against the WAV's own, dB.
        #[arg(long, default_value_t = -20.0)]
        user_gain_db: f32,
        /// When to start it, seconds into Vera's first line.
        #[arg(long, default_value_t = 2.5)]
        user_at: f64,
        #[arg(long)]
        mic: Option<String>,
        #[arg(long)]
        output: Option<String>,
    },
    /// Speak through the voice service and print the events.
    Say {
        text: String,
        #[arg(long)]
        voice_url: Option<String>,
        #[arg(long, default_value_t = super::DEFAULT_VOLUME)]
        volume: f32,
        /// Stop talking this many seconds in (`stop_playback`).
        #[arg(long)]
        stop_after: Option<f64>,
        /// Keep listening this long after speaking, seconds.
        #[arg(long, default_value_t = 4.0)]
        listen: f64,
    },
    /// Play a chime: notify, listening, done, or error.
    Chime {
        kind: ChimeKind,
        #[arg(long, default_value_t = super::DEFAULT_VOLUME)]
        volume: f32,
    },
    /// List the output devices.
    Outputs,
    /// Transcribe WAV files with Vera's speech to text (Parakeet), one
    /// line each: `<file>\t<text>`. The pronunciation check
    /// (`vera/voice/scripts/pronunciation_check.py`) runs the voice's
    /// output through this.
    Transcribe { files: Vec<PathBuf> },
}

/// Each WAV as Vera's ears hear it: mono, 16 kHz, through Parakeet.
fn transcribe(files: &[PathBuf]) -> Result<()> {
    let stt = Stt::load(&EarsSettings::default())?;
    for file in files {
        let mut reader = hound::WavReader::open(file)
            .map_err(|error| eyre!("could not read {}: {error}", file.display()))?;
        let spec = reader.spec();
        let channels = usize::from(spec.channels.max(1));
        let samples: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => reader.samples::<f32>().filter_map(Result::ok).collect(),
            hound::SampleFormat::Int => {
                let scale = 1.0 / (1u64 << (spec.bits_per_sample.max(1) - 1)) as f32;
                reader
                    .samples::<i32>()
                    .filter_map(Result::ok)
                    .map(|sample| sample as f32 * scale)
                    .collect()
            }
        };
        let mono: Vec<f32> = samples
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect();
        let mut clip = super::resample::resample(&mono, spec.sample_rate, 16_000);
        crate::dictation::pad_for_parakeet(&mut clip);
        let text = stt
            .engine
            .finish(None, clip)
            .map_err(|error| eyre!("{error:#}"))
            .and_then(|pending| pending.wait().map_err(|error| eyre!("{error}")))?
            .text;
        println!("{}\t{}", file.display(), text.trim());
    }
    Ok(())
}

fn parse_source(value: &str) -> Result<SttSource, String> {
    match value {
        "hybrid" => Ok(SttSource::Hybrid),
        "linear" => Ok(SttSource::Linear),
        "suppressed" => Ok(SttSource::Suppressed),
        _ => Err(format!("{value:?} is not hybrid, linear, or suppressed")),
    }
}

pub(crate) fn run(args: VeraAudioArgs, shutdown: &'static AtomicBool) -> Result<()> {
    crate::vera_ears::init_logging();
    let _ = ctrlc::set_handler(move || shutdown.store(true, Ordering::Relaxed));
    match args.command {
        VeraAudioCommand::Transcribe { files } => transcribe(&files),
        VeraAudioCommand::Sim {
            voices,
            room,
            plan,
            no_stt,
            stt_source,
            volume,
            json,
        } => simulate(&voices, &room, &plan, no_stt, stt_source, volume, json),
        VeraAudioCommand::Live {
            voices,
            lines,
            volume,
            user_wav,
            user_gain_db,
            user_at,
            mic,
            output,
        } => live(
            &voices,
            lines,
            volume,
            user_wav.map(|path| (path, user_gain_db)),
            user_at,
            mic,
            output,
            shutdown,
        ),
        VeraAudioCommand::Say {
            text,
            voice_url,
            volume,
            stop_after,
            listen,
        } => {
            let mut config = AudioConfig {
                volume,
                ..AudioConfig::default()
            };
            if let Some(url) = voice_url {
                config.voice_url = url;
            }
            match super::voice::VoiceClient::new(&config.voice_url, None, None).ready() {
                Ok(ready) => println!("voice service at {}: ready {ready}", config.voice_url),
                Err(error) => println!("voice service at {}: {error}", config.voice_url),
            }
            let (audio, events) = VeraAudio::start(config)?;
            println!("volume {:.2}", audio.volume());
            audio.speak("say", text);
            let started = Instant::now();
            let mut stopped = false;
            while !shutdown.load(Ordering::Relaxed) {
                if !stopped && stop_after.is_some_and(|at| started.elapsed().as_secs_f64() >= at) {
                    stopped = true;
                    audio.stop_playback();
                }
                if let Ok(event) = events.recv_timeout(Duration::from_millis(20)) {
                    print_event(started, &event);
                    if matches!(&event, AudioEvent::Playback { state, .. } if *state != super::PlaybackState::Started)
                    {
                        break;
                    }
                }
            }
            print_for(&events, Duration::from_secs_f64(listen), shutdown);
            Ok(())
        }
        VeraAudioCommand::Chime { kind, volume } => {
            let (audio, events) = VeraAudio::start(AudioConfig {
                volume,
                ..AudioConfig::default()
            })?;
            audio.chime(kind);
            print_for(&events, Duration::from_millis(1_500), shutdown);
            Ok(())
        }
        VeraAudioCommand::Outputs => {
            for name in super::output::output_names() {
                println!("{name}");
            }
            Ok(())
        }
    }
}

fn print_event(started: Instant, event: &AudioEvent) {
    let line = serde_json::to_string(event).unwrap_or_default();
    println!("{:>7.3}s {line}", started.elapsed().as_secs_f64());
}

fn print_for(events: &mpsc::Receiver<AudioEvent>, duration: Duration, shutdown: &AtomicBool) {
    let started = Instant::now();
    while started.elapsed() < duration && !shutdown.load(Ordering::Relaxed) {
        if let Ok(event) = events.recv_timeout(Duration::from_millis(50)) {
            print_event(started, &event);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn simulate(
    voices: &std::path::Path,
    rooms: &[String],
    plans: &[Plan],
    no_stt: bool,
    source: SttSource,
    volume: f32,
    json: Option<PathBuf>,
) -> Result<()> {
    let voices = sim::load_voices(voices)?;
    let all = RoomSpec::all();
    let rooms: Vec<RoomSpec> = if rooms.is_empty() {
        all
    } else {
        rooms
            .iter()
            .map(|name| {
                all.iter()
                    .find(|room| room.name == name)
                    .cloned()
                    .ok_or_else(|| eyre!("no room {name:?}"))
            })
            .collect::<Result<_>>()?
    };
    let stt = if no_stt {
        None
    } else {
        let settings = EarsSettings::default();
        Some(Stt::load(&settings)?)
    };
    let mut reports = Vec::new();
    for room in &rooms {
        for plan in plans {
            let started = Instant::now();
            let (backend, results) = match &stt {
                Some(stt) => {
                    let (sender, receiver) = mpsc::channel();
                    (SimStt::Engine(stt.backend(sender)), Some(receiver))
                }
                None => (SimStt::Fake, None),
            };
            let report = sim::run(
                room,
                *plan,
                &voices,
                backend,
                results.as_ref(),
                source,
                volume,
            )?;
            tracing::info!(
                room = room.name,
                plan = ?plan,
                took_ms = started.elapsed().as_millis() as u64,
                "simulated"
            );
            print_report(&report);
            reports.push(report);
        }
    }
    print_summary(&reports);
    if let Some(path) = json {
        std::fs::write(&path, serde_json::to_string_pretty(&reports)?)?;
        println!("wrote {}", path.display());
    }
    Ok(())
}

fn print_report(report: &sim::RunReport) {
    println!(
        "\n== {} / {}: {:.0} s simulated, echo at mic {:.0} dBFS, AEC delay {} ms, resyncs {}",
        report.room, report.plan, report.seconds, report.echo_dbfs, report.delay_ms, report.resyncs
    );
    println!(
        "   echo-only {:.0} s: ERLE linear {:.1} dB, suppressed {:.1} dB | ducks {} (false {}), barge-ins {} (false {}), echo finals {}",
        report.echo_only_s,
        report.erle_linear_db,
        report.erle_suppressed_db,
        report.ducks,
        report.false_ducks,
        report.barge_ins,
        report.false_barge_ins,
        report.echo_finals.len()
    );
    for text in &report.echo_finals {
        println!("   ECHO FINAL: {text:?}");
    }
    for case in &report.cases {
        let ms = |value: Option<f64>| value.map_or("   -".into(), |ms| format!("{ms:4.0}"));
        println!(
            "   {:<10} at {:>4.1}s  duck {} ms  barge-in {} ms  wer {:>4.2}  {}  {:?}",
            case.phrase,
            case.into_vera_s,
            ms(case.duck_ms),
            ms(case.barge_in_ms),
            case.word_error_rate,
            if case.during_playback { "dp" } else { "  " },
            case.heard.as_deref().unwrap_or("(nothing)")
        );
    }
}

fn percentile(values: &mut [f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    values.sort_by(f64::total_cmp);
    values[((values.len() - 1) as f64 * fraction).round() as usize]
}

fn print_summary(reports: &[sim::RunReport]) {
    println!("\n== summary");
    for plan in ["echo", "barge", "after", "clean"] {
        let runs: Vec<&sim::RunReport> = reports.iter().filter(|r| r.plan == plan).collect();
        if runs.is_empty() {
            continue;
        }
        let cases: Vec<&sim::BargeCase> = runs.iter().flat_map(|r| &r.cases).collect();
        let echo_s: f64 = runs.iter().map(|r| r.echo_only_s).sum();
        let false_ducks: u64 = runs.iter().map(|r| r.false_ducks).sum();
        let false_barge: u64 = runs.iter().map(|r| r.false_barge_ins).sum();
        let echo_finals: usize = runs.iter().map(|r| r.echo_finals.len()).sum();
        let mut ducks: Vec<f64> = cases.iter().filter_map(|c| c.duck_ms).collect();
        let mut barges: Vec<f64> = cases.iter().filter_map(|c| c.barge_in_ms).collect();
        let detected = barges.len();
        let wer: f64 =
            cases.iter().map(|c| c.word_error_rate).sum::<f64>() / cases.len().max(1) as f64;
        println!(
            "   {plan:<6} echo-only {echo_s:.0} s, false ducks {false_ducks} ({:.1}/min), false barge-ins {false_barge}, echo finals {echo_finals}",
            false_ducks as f64 / (echo_s / 60.0).max(1e-9)
        );
        if !cases.is_empty() {
            println!(
                "          user phrases {}: barge-ins {detected}, duck median {:.0} ms p90 {:.0} ms, barge-in median {:.0} ms p90 {:.0} ms, mean WER {:.3}",
                cases.len(),
                percentile(&mut ducks, 0.5),
                percentile(&mut ducks, 0.9),
                percentile(&mut barges, 0.5),
                percentile(&mut barges, 0.9),
                wer
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn live(
    voices: &std::path::Path,
    lines: usize,
    volume: f32,
    user_wav: Option<(PathBuf, f32)>,
    user_at: f64,
    mic: Option<String>,
    output: Option<String>,
    shutdown: &AtomicBool,
) -> Result<()> {
    let voices = sim::load_voices(voices)?;
    let user_clip = match &user_wav {
        Some((path, _)) => Some(sim::Clip::load(path, "")?),
        None => None,
    };
    let user_output = output.clone();
    let (audio, events) = VeraAudio::start(AudioConfig {
        microphone: mic,
        output,
        volume,
        ..AudioConfig::default()
    })?;
    let started = Instant::now();
    // Wait until it listens.
    loop {
        if shutdown.load(Ordering::Relaxed) || started.elapsed() > Duration::from_secs(30) {
            return Err(eyre!("the engine never became ready"));
        }
        if let Ok(event) = events.recv_timeout(Duration::from_millis(50)) {
            print_event(started, &event);
            if matches!(event, AudioEvent::Ready { .. }) {
                break;
            }
            if let AudioEvent::Error { fatal: true, .. } = event {
                return Err(eyre!("the engine stopped"));
            }
        }
    }
    // Quiet first: the microphone's own noise and the room.
    print_for(&events, Duration::from_millis(800), shutdown);
    let mut user = None;
    for line in 0..lines.min(voices.vera.len()) {
        let clip = &voices.vera[line];
        let id = format!("live{line}");
        let line_started = Instant::now();
        audio.speak_pcm(id.clone(), clip.samples.clone(), clip.rate);
        let mut levels_at = Instant::now();
        let mut peak_mic: f32 = 0.0;
        loop {
            if shutdown.load(Ordering::Relaxed) {
                return Ok(());
            }
            if line == 0
                && user.is_none()
                && let (Some(clip), Some((_, gain_db))) = (&user_clip, &user_wav)
                && line_started.elapsed().as_secs_f64() >= user_at
            {
                println!(
                    "{:>7.3}s (the user starts: {})",
                    started.elapsed().as_secs_f64(),
                    clip.name
                );
                user = Some(play_apart(user_output.as_deref(), clip, *gain_db)?);
            }
            let levels = audio.levels();
            peak_mic = peak_mic.max(levels.mic);
            if levels_at.elapsed() > Duration::from_millis(500) {
                levels_at = Instant::now();
                println!(
                    "{:>7.3}s levels mic {:.1} dBFS out {:.1} dBFS (mic peak {:.1})",
                    started.elapsed().as_secs_f64(),
                    20.0 * levels.mic.max(1e-6).log10(),
                    20.0 * levels.out.max(1e-6).log10(),
                    20.0 * peak_mic.max(1e-6).log10()
                );
                peak_mic = 0.0;
            }
            if let Ok(event) = events.recv_timeout(Duration::from_millis(20)) {
                print_event(started, &event);
                if let AudioEvent::Playback { speak_id, state } = &event
                    && *speak_id == id
                    && *state != super::PlaybackState::Started
                {
                    break;
                }
            }
        }
        print_for(&events, Duration::from_millis(1_500), shutdown);
    }
    print_for(&events, Duration::from_secs(2), shutdown);
    drop(user);
    // The rest of the App's controls, briefly: Vera's volume, a stop with
    // nothing playing, and the microphone muted and back.
    audio.set_volume(volume * 0.8);
    audio.stop_playback();
    audio.set_mic_muted(true);
    print_for(&events, Duration::from_millis(300), shutdown);
    println!(
        "volume {:.2}, speaking {}, muted {}",
        audio.volume(),
        audio.speaking(),
        audio.mic_muted()
    );
    audio.set_mic_muted(false);
    print_for(&events, Duration::from_millis(500), shutdown);
    Ok(())
}

/// Plays `clip` on an output stream of its own, outside Vera's mixer, so
/// her echo canceller has no reference for it: to the microphone it is a
/// person in the room. Keep the returned stream until it has played.
fn play_apart(
    device: Option<&str>,
    clip: &sim::Clip,
    gain_db: f32,
) -> Result<super::output::Output> {
    use std::sync::{Arc, Mutex, atomic::AtomicU32};
    let (commands, receiver) = mpsc::channel();
    let (reports, _ignored) = mpsc::channel();
    let gain = 10f32.powf(gain_db / 20.0);
    let mixer =
        super::mixer::Mixer::new(48_000, gain, receiver, reports, Arc::new(AtomicU32::new(0)));
    let output = super::output::open(device, Arc::new(Mutex::new(mixer)))?;
    let id: super::mixer::SpeakId = "user".into();
    let _ = commands.send(super::mixer::Command::Begin { id: id.clone() });
    let _ = commands.send(super::mixer::Command::Pcm {
        id: id.clone(),
        rate: clip.rate,
        samples: clip.samples.clone(),
    });
    let _ = commands.send(super::mixer::Command::End { id });
    // Queued commands stay readable after the sender goes.
    Ok(output)
}
