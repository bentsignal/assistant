//! The simulator: the real duplex core and mixer in a closed loop with a
//! simulated room, so echo cancellation and barge-in are measured without
//! a person. Vera's voice goes through the mixer (her volume, ducks, and
//! stops included) into a soft-clipping speaker, through a room impulse
//! response, and into a microphone that also hears the user (through the
//! same room, from further away) and noise, on a clock that drifts. Device
//! timestamps carry the latencies a real device reports and the ones it
//! doesn't.
//!
//! Plans (`Plan`):
//! - `echo`: Vera alone, back to back: false ducks, false barge-ins, and
//!   echo that became speech (all should be zero), and echo loss.
//! - `barge`: the user cuts in at different points of Vera's lines,
//!   starting with the very first (an unconverged canceller): detection,
//!   duck and barge-in latency, and how well the interrupting words were
//!   transcribed.
//! - `after`: the user talks right after Vera finishes: no barge-in, an
//!   ordinary final.
//! - `clean`: the user with no Vera, the speech-to-text baseline.

pub(crate) mod room;

use std::sync::Arc;
use std::sync::atomic::AtomicU32;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use color_eyre::eyre::{Result, WrapErr, eyre};
use serde::Serialize;

pub(crate) use room::RoomSpec;
use room::{Convolver, LowCut, Noise, fan, impulse_response, interpolate};

use super::align::RATE;
use super::barge::Action;
use super::duplex::{Core, Epoch, SttSource};
use super::mixer::{self, Mixer, SpeakId, volume_gain};
use super::resample::{Resampler, resample};
use super::{AudioEvent, PlaybackState};
use crate::vera_ears::EarsSettings;
use crate::vera_ears::utterances::{Backend, Finished};

const DEVICE_RATE: u32 = 48_000;
const STEP_NS: u64 = 10_000_000;
const T0_NS: u64 = 1_000_000_000;
/// Unix ms the simulated clock starts at.
const EPOCH_MS: u64 = 1_000_000;

/// A voice clip: mono samples at `rate`, and what it says.
#[derive(Clone)]
pub(crate) struct Clip {
    pub name: String,
    pub text: String,
    pub samples: Vec<f32>,
    pub rate: u32,
}

impl Clip {
    pub(crate) fn load(path: &std::path::Path, text: &str) -> Result<Self> {
        let mut reader = hound::WavReader::open(path)
            .wrap_err_with(|| format!("could not open {}", path.display()))?;
        let spec = reader.spec();
        let channels = spec.channels.max(1) as usize;
        let samples: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Int => {
                let scale = (1u32 << (spec.bits_per_sample - 1)) as f32;
                reader
                    .samples::<i32>()
                    .map(|sample| sample.map(|value| value as f32 / scale))
                    .collect::<std::result::Result<_, _>>()?
            }
            hound::SampleFormat::Float => reader
                .samples::<f32>()
                .collect::<std::result::Result<_, _>>()?,
        };
        let mono = samples
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect();
        Ok(Self {
            name: path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default(),
            text: text.to_owned(),
            samples: mono,
            rate: spec.sample_rate,
        })
    }
}

pub(crate) struct Voices {
    pub vera: Vec<Clip>,
    pub user: Vec<Clip>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    Echo,
    Barge,
    After,
    Clean,
}

impl std::str::FromStr for Plan {
    type Err = String;
    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "echo" => Ok(Self::Echo),
            "barge" => Ok(Self::Barge),
            "after" => Ok(Self::After),
            "clean" => Ok(Self::Clean),
            _ => Err(format!("{value:?} is not echo, barge, after, or clean")),
        }
    }
}

enum Cue {
    Vera(usize),
    User(usize),
}

/// The sim's speech to text: Hex's engine, or a stand-in that answers
/// every clip with a fixed text (detection-only runs).
pub(crate) enum SimStt {
    Engine(crate::vera_ears::EngineBackend),
    Fake,
}

struct SimBackend {
    stt: SimStt,
    asked: usize,
    fake_answers: Vec<Finished>,
}

impl Backend for SimBackend {
    fn heard_speech(&mut self, samples: &[f32]) -> Option<bool> {
        match &mut self.stt {
            SimStt::Engine(backend) => backend.heard_speech(samples),
            SimStt::Fake => Some(true),
        }
    }

    fn transcribe(&mut self, id: u64, clip: Vec<f32>, verified: bool) {
        self.asked += 1;
        match &mut self.stt {
            SimStt::Engine(backend) => backend.transcribe(id, clip, verified),
            SimStt::Fake => self.fake_answers.push(Finished {
                id,
                text: Ok("(speech)".into()),
                speech: true,
            }),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub(crate) struct BargeCase {
    pub phrase: String,
    pub expected: String,
    /// When the user started, into Vera's line, in s.
    pub into_vera_s: f64,
    /// From the user's first sound to Vera's duck decision and her stop
    /// decision, ms (add the output latency for the audible change).
    pub duck_ms: Option<f64>,
    pub barge_in_ms: Option<f64>,
    pub heard: Option<String>,
    pub word_error_rate: f64,
    pub during_playback: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub(crate) struct RunReport {
    pub room: String,
    pub plan: String,
    pub seconds: f64,
    /// Seconds Vera played with nobody talking over her.
    pub echo_only_s: f64,
    pub ducks: u64,
    /// Ducks with nobody talking.
    pub false_ducks: u64,
    pub barge_ins: u64,
    pub false_barge_ins: u64,
    /// Finals that came from Vera's own voice.
    pub echo_finals: Vec<String>,
    /// Echo loss once converged (after Vera's first 3 s), dB.
    pub erle_linear_db: f64,
    pub erle_suppressed_db: f64,
    pub echo_dbfs: f64,
    pub delay_ms: i32,
    pub resyncs: u64,
    pub cases: Vec<BargeCase>,
}

struct UserTruth {
    phrase: usize,
    onset_ns: f64,
    end_ns: f64,
}

fn gated_rms_db(samples: &[f32]) -> f64 {
    let frames: Vec<f64> = samples
        .chunks(1_600)
        .map(|frame| frame.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / frame.len() as f64)
        .collect();
    let loudest = frames.iter().copied().fold(0.0, f64::max);
    let active: Vec<f64> = frames.into_iter().filter(|e| *e > loudest * 1e-3).collect();
    10.0 * (active.iter().sum::<f64>() / active.len().max(1) as f64 + 1e-20).log10()
}

/// Where speech in a 16 kHz clip starts and ends (frames within 35 dB of
/// its loudest).
fn speech_span(samples: &[f32]) -> (usize, usize) {
    let frames: Vec<f32> = samples
        .chunks(160)
        .map(|frame| frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32)
        .collect();
    let loudest = frames.iter().copied().fold(0.0, f32::max);
    let threshold = loudest * 10f32.powf(-3.5);
    let first = frames.iter().position(|e| *e > threshold).unwrap_or(0);
    let last = frames.iter().rposition(|e| *e > threshold).unwrap_or(0);
    (first * 160, (last + 1) * 160)
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Word error rate of `heard` against `expected`.
pub(crate) fn word_error_rate(expected: &str, heard: &str) -> f64 {
    let (expected, heard) = (words(expected), words(heard));
    if expected.is_empty() {
        return if heard.is_empty() { 0.0 } else { 1.0 };
    }
    let mut row: Vec<usize> = (0..=heard.len()).collect();
    for (i, word) in expected.iter().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, other) in heard.iter().enumerate() {
            let substitution = previous + usize::from(word != other);
            previous = row[j + 1];
            row[j + 1] = substitution.min(row[j] + 1).min(previous + 1);
        }
    }
    row[heard.len()] as f64 / expected.len() as f64
}

/// Runs one plan in one room.
pub(crate) fn run(
    room: &RoomSpec,
    plan: Plan,
    voices: &Voices,
    stt: SimStt,
    results: Option<&Receiver<Finished>>,
    source: SttSource,
    volume: f32,
) -> Result<RunReport> {
    if voices.vera.is_empty() || voices.user.is_empty() {
        return Err(eyre!("the simulator needs Vera lines and user phrases"));
    }
    let vera_seconds =
        |line: usize| voices.vera[line].samples.len() as f64 / voices.vera[line].rate as f64;
    // The cues, in seconds.
    let mut cues: Vec<(f64, Cue)> = Vec::new();
    let mut at = 0.5;
    match plan {
        Plan::Echo => {
            for round in 0..3 {
                for line in 0..voices.vera.len() {
                    cues.push((at, Cue::Vera(line)));
                    at += vera_seconds(line) + 1.2 + round as f64 * 0.3;
                }
            }
        }
        Plan::Barge => {
            let offsets: [f64; 6] = [0.9, 2.3, 3.6, 5.2, 1.6, 4.3];
            for (index, _) in voices.user.iter().enumerate() {
                let line = index % voices.vera.len();
                let offset = offsets[index % offsets.len()].min(vera_seconds(line) - 1.0);
                cues.push((at, Cue::Vera(line)));
                cues.push((at + offset, Cue::User(index)));
                at += offset + 6.0;
            }
        }
        Plan::After => {
            for (index, _) in voices.user.iter().enumerate().take(6) {
                let line = index % voices.vera.len();
                cues.push((at, Cue::Vera(line)));
                // Vera's audio reaches the room ~40 ms after it is queued.
                at += vera_seconds(line) + 0.45;
                cues.push((at, Cue::User(index)));
                at += 5.0;
            }
        }
        Plan::Clean => {
            for (index, _) in voices.user.iter().enumerate() {
                cues.push((at, Cue::User(index)));
                at += 4.5;
            }
        }
    }
    let seconds = at + 2.0;
    let total16 = (seconds * RATE as f64) as usize + RATE as usize;

    // The room's field at the microphone, on true time, 16 kHz.
    let speaker_ir = impulse_response(room.rt60, room.drr_db, 0.8, 17);
    let user_ir = impulse_response(room.rt60, room.drr_db - 6.0, 2.0, 29);
    let mut field = vec![0.0f32; total16 + 4];
    let mut noise = Noise(5);
    let noise_gain = 10f32.powf(room.noise_dbfs / 20.0);
    for sample in &mut field {
        *sample = noise.gauss() * noise_gain * 0.58;
    }
    if let Some(fan_dbfs) = room.fan_dbfs {
        for (into, sample) in field.iter_mut().zip(fan(total16 + 4, fan_dbfs, 9)) {
            *into += sample;
        }
    }
    let mut truths = Vec::new();
    for (at, cue) in &cues {
        if let Cue::User(phrase) = cue {
            let clip = &voices.user[*phrase];
            let dry = resample(&clip.samples, clip.rate, RATE);
            let mut convolver = Convolver::new(&user_ir, 160);
            let mut wet: Vec<f32> = Vec::new();
            for chunk in dry.chunks(160) {
                let mut block = chunk.to_vec();
                block.resize(160, 0.0);
                wet.extend(convolver.process(&block));
            }
            let gain = 10f64.powf((room.user_dbfs as f64 - gated_rms_db(&wet)) / 20.0) as f32;
            let start = (at * RATE as f64) as usize;
            for (offset, sample) in wet.iter().enumerate() {
                if let Some(into) = field.get_mut(start + offset) {
                    *into += sample * gain;
                }
            }
            let (first, last) = speech_span(&wet);
            truths.push(UserTruth {
                phrase: *phrase,
                onset_ns: T0_NS as f64 + (start + first) as f64 * 1e9 / RATE as f64,
                end_ns: T0_NS as f64 + (start + last) as f64 * 1e9 / RATE as f64,
            });
        }
    }

    // How loud Vera's echo is for unit coupling, to set the coupling.
    let gain = volume_gain(volume);
    let calibration = {
        let line = &voices.vera[0];
        let device = resample(&line.samples, line.rate, DEVICE_RATE);
        let mut low_cut = LowCut::new(room.speaker_low_cut, DEVICE_RATE as f32);
        let driven: Vec<f32> = device
            .iter()
            .map(|sample| low_cut.next(drive(sample * gain, room.drive)))
            .collect();
        let at16 = resample(&driven, DEVICE_RATE, RATE);
        let mut convolver = Convolver::new(&speaker_ir, 160);
        let mut echo = Vec::new();
        for chunk in at16.chunks(160) {
            let mut block = chunk.to_vec();
            block.resize(160, 0.0);
            echo.extend(convolver.process(&block));
        }
        gated_rms_db(&echo)
    };
    let echo_dbfs = (room.user_dbfs + room.echo_over_user_db) as f64;
    let coupling = 10f64.powf((echo_dbfs - calibration) / 20.0) as f32;

    // The engine.
    let (commands, command_receiver) = mpsc::channel();
    let (report_sender, reports) = mpsc::channel();
    let mut mixer = Mixer::new(
        DEVICE_RATE,
        gain,
        command_receiver,
        report_sender,
        Arc::new(AtomicU32::new(0)),
    );
    let mut settings = EarsSettings {
        partials: false,
        ..EarsSettings::default()
    };
    settings.check_speech = true;
    let mut core = Core::new(
        SimBackend {
            stt,
            asked: 0,
            fake_answers: Vec::new(),
        },
        &settings,
        commands.clone(),
        Epoch {
            clock_ns: T0_NS,
            unix_ms: EPOCH_MS,
        },
        Arc::new(AtomicU32::new(0)),
    );
    core.set_stt_source(source);
    core.traces = Some(Vec::new());
    let dump_dir = std::env::var_os("VERA_SIM_TRACE").map(std::path::PathBuf::from);
    if dump_dir.is_some() {
        core.audio_dump = Some(Default::default());
    }

    let output_lead_ns = ((room.output_latency_ms + room.unreported_output_ms) * 1e6) as f64;
    let mut speaker_low_cut = LowCut::new(room.speaker_low_cut, DEVICE_RATE as f32);
    let mut speaker_resampler = Resampler::new(DEVICE_RATE, RATE);
    let mut speaker16: Vec<f32> = Vec::new();
    let mut speaker_convolver = Convolver::new(&speaker_ir, 160);
    // Field index the next echo block lands at.
    let mut echo_at = (output_lead_ns * RATE as f64 / 1e9) as usize;
    let mic_rate = 1.0 + room.drift_ppm as f64 * 1e-6;
    let mut mic_next: u64 = 0;
    let mut received = 0usize;
    let mut events: Vec<(u64, AudioEvent)> = Vec::new();
    let mut actions: Vec<(u64, Action)> = Vec::new();
    let mut cue_index = 0;
    let mut speak_count = 0;
    let mut traces_seen = 0;
    let steps = (seconds * 100.0) as u64;
    let mut silero = |samples: &[f32]| crate::transcription::speech_detector::contains_speech(samples);
    for step in 0..steps {
        let now = T0_NS + step * STEP_NS;
        while cue_index < cues.len() && cues[cue_index].0 * 1e9 + T0_NS as f64 <= now as f64 {
            if let Cue::Vera(line) = cues[cue_index].1 {
                // Each case starts clean: a line the user didn't stop ends.
                if core.speaking() {
                    core.stop_playback();
                }
                speak_count += 1;
                let id: SpeakId = format!("s{speak_count}").into();
                let clip = &voices.vera[line];
                let _ = commands.send(mixer::Command::Begin { id: id.clone() });
                let _ = commands.send(mixer::Command::Pcm {
                    id: id.clone(),
                    rate: clip.rate,
                    samples: clip.samples.clone(),
                });
                let _ = commands.send(mixer::Command::End { id: id.clone() });
                core.speech_queued(id);
            }
            cue_index += 1;
        }
        // The output callback.
        let mut block = vec![0.0f32; (DEVICE_RATE / 100) as usize];
        let playback_ns = now + (room.output_latency_ms * 1e6) as u64;
        mixer.render(&mut block, playback_ns);
        while let Ok(report) = reports.try_recv() {
            core.report(report, DEVICE_RATE, now);
        }
        // The speaker and the room.
        let driven: Vec<f32> = block
            .iter()
            .map(|sample| speaker_low_cut.next(drive(*sample, room.drive)))
            .collect();
        speaker16.extend(speaker_resampler.push(&driven));
        while speaker16.len() >= 160 {
            let chunk: Vec<f32> = speaker16.drain(..160).collect();
            for (offset, sample) in speaker_convolver.process(&chunk).iter().enumerate() {
                if let Some(into) = field.get_mut(echo_at + offset) {
                    *into += sample * coupling;
                }
            }
            echo_at += 160;
        }
        // The microphone hears up to now, minus its buffering.
        let heard_until_ns = now as f64 - room.input_latency_ms as f64 * 1e6;
        let until = ((heard_until_ns - T0_NS as f64) / 1e9 * RATE as f64 * mic_rate).max(0.0) as u64;
        if until > mic_next {
            let chunk: Vec<f32> = (mic_next..until)
                .map(|j| interpolate(&field, j as f64 / mic_rate))
                .collect();
            mic_next = until;
            let through_ns = T0_NS as f64
                + until as f64 / mic_rate / RATE as f64 * 1e9
                + room.capture_stamp_error_ms as f64 * 1e6;
            core.mic(&chunk, RATE, through_ns as u64, now);
        }
        core.tick(now, &mut silero);
        // Speech to text answers before the next step: an infinitely fast GPU.
        loop {
            let fake: Vec<Finished> = core.backend().fake_answers.drain(..).collect();
            for finished in fake {
                received += 1;
                core.transcribed(finished);
            }
            if received >= core.backend().asked {
                break;
            }
            let Some(results) = results else { break };
            let finished = results
                .recv_timeout(Duration::from_secs(30))
                .wrap_err("speech to text stopped answering")?;
            received += 1;
            core.transcribed(finished);
        }
        if let Some(traces) = &core.traces {
            for trace in &traces[traces_seen..] {
                if let Some(action) = trace.action {
                    actions.push((now, action));
                }
            }
            traces_seen = traces.len();
        }
        for event in core.take_events() {
            events.push((now, event));
        }
    }
    let traces = core.traces.take().unwrap_or_default();
    if let (Some(dir), Some(dump)) = (&dump_dir, core.audio_dump.take()) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        for (name, samples) in ["mic", "ref", "linear", "suppressed"].iter().zip(dump.iter()) {
            let path = dir.join(format!("{}-{plan:?}-{name}.wav", room.name));
            if let Ok(mut writer) = hound::WavWriter::create(&path, spec) {
                for sample in samples {
                    let _ = writer.write_sample(*sample);
                }
                let _ = writer.finalize();
            }
        }
        // Where the user really spoke, for offline analysis.
        let mut truth = String::from("onset_s,end_s,phrase
");
        for t in &truths {
            truth.push_str(&format!(
                "{:.3},{:.3},{}
",
                (t.onset_ns - T0_NS as f64) / 1e9,
                (t.end_ns - T0_NS as f64) / 1e9,
                voices.user[t.phrase].name
            ));
        }
        let _ = std::fs::write(dir.join(format!("{}-{plan:?}-truth.csv", room.name)), truth);
    }
    if let Some(path) = std::env::var_os("VERA_SIM_TRACE") {
        let path = std::path::PathBuf::from(path).join(format!("{}-{plan:?}.csv", room.name));
        let mut csv = String::from(
            "t_s,mic_db,ref_db,linear_db,suppressed_db,bound_db,linear_hit,suppressed_hit,band_hits,active,action\n",
        );
        let db = |e: f32| 10.0 * (e + 1e-12).log10();
        for trace in &traces {
            csv.push_str(&format!(
                "{:.3},{:.1},{:.1},{:.1},{:.1},{:.1},{},{},{},{},{}\n",
                (trace.ns - T0_NS as f64) / 1e9,
                db(trace.microphone),
                db(trace.reference),
                db(trace.linear),
                db(trace.suppressed),
                trace.probe.bound_db,
                u8::from(trace.probe.linear_hit),
                u8::from(trace.probe.suppressed_hit),
                trace.probe.band_hits,
                u8::from(trace.probe.active),
                trace.action.map(|action| format!("{action:?}")).unwrap_or_default()
            ));
        }
        let _ = std::fs::write(&path, csv);
    }
    Ok(report(
        room,
        plan,
        seconds,
        voices,
        &truths,
        &events,
        &actions,
        &traces,
        &core,
        echo_dbfs,
    ))
}

fn drive(sample: f32, drive: f32) -> f32 {
    if drive <= 0.0 {
        sample
    } else {
        (sample * drive).tanh() / drive
    }
}

#[allow(clippy::too_many_arguments)]
fn report(
    room: &RoomSpec,
    plan: Plan,
    seconds: f64,
    voices: &Voices,
    truths: &[UserTruth],
    events: &[(u64, AudioEvent)],
    actions: &[(u64, Action)],
    traces: &[super::duplex::BlockTrace],
    core: &Core<SimBackend>,
    echo_dbfs: f64,
) -> RunReport {
    let unix_to_ns = |ms: u64| (ms - EPOCH_MS) as f64 * 1e6 + T0_NS as f64;
    let user_near = |ns: f64, margin: f64| {
        truths
            .iter()
            .any(|truth| ns >= truth.onset_ns - margin && ns <= truth.end_ns + margin)
    };
    // Playback spans, from the core's own events.
    let mut playing: Vec<(f64, f64)> = Vec::new();
    let mut open: Option<f64> = None;
    for (now, event) in events {
        if let AudioEvent::Playback { state, .. } = event {
            match state {
                PlaybackState::Started => open = Some(*now as f64),
                PlaybackState::Finished | PlaybackState::Interrupted | PlaybackState::Failed => {
                    if let Some(start) = open.take() {
                        playing.push((start, *now as f64));
                    }
                }
            }
        }
    }
    let mut report = RunReport {
        room: room.name.into(),
        plan: format!("{plan:?}").to_lowercase(),
        seconds,
        echo_dbfs,
        delay_ms: core.delay_ms(),
        resyncs: core.reference_resyncs(),
        ..RunReport::default()
    };
    // Echo-only blocks: Vera audible, the user far away.
    let mut first_reference: Option<f64> = None;
    let (mut mic, mut linear, mut suppressed, mut blocks) = (0.0f64, 0.0f64, 0.0f64, 0u64);
    for trace in traces {
        if trace.reference > 1e-9 && first_reference.is_none() {
            first_reference = Some(trace.ns);
        }
        let echo_only = trace.probe.active && !user_near(trace.ns, 500e6);
        if echo_only {
            blocks += 1;
            if first_reference.is_some_and(|first| trace.ns > first + 3e9) && trace.microphone > 1e-8 {
                mic += trace.microphone as f64;
                linear += trace.linear as f64;
                suppressed += trace.suppressed as f64;
            }
        }
    }
    report.echo_only_s = blocks as f64 * 0.004;
    if mic > 0.0 {
        report.erle_linear_db = 10.0 * (mic / linear.max(1e-20)).log10();
        report.erle_suppressed_db = 10.0 * (mic / suppressed.max(1e-20)).log10();
    }
    for (now, action) in actions {
        let ns = *now as f64;
        match action {
            Action::Duck => {
                report.ducks += 1;
                if !user_near(ns, 300e6) {
                    report.false_ducks += 1;
                }
            }
            Action::Confirm { .. } | Action::Restore => {}
        }
    }
    for (now, event) in events {
        match event {
            AudioEvent::BargeIn { .. } => {
                report.barge_ins += 1;
                if !user_near(*now as f64, 300e6) {
                    report.false_barge_ins += 1;
                }
            }
            AudioEvent::Final { text, start, end, .. } => {
                let (start, end) = (unix_to_ns(*start), unix_to_ns(*end));
                let user = truths
                    .iter()
                    .any(|truth| start < truth.end_ns + 300e6 && end > truth.onset_ns - 300e6);
                if !user {
                    report.echo_finals.push(text.clone());
                }
            }
            _ => {}
        }
    }
    for truth in truths {
        let clip = &voices.user[truth.phrase];
        let vera_start = playing
            .iter()
            .filter(|(start, _)| *start <= truth.onset_ns)
            .map(|(start, _)| *start)
            .next_back();
        let mut case = BargeCase {
            phrase: clip.name.clone(),
            expected: clip.text.clone(),
            into_vera_s: vera_start.map_or(-1.0, |start| (truth.onset_ns - start) / 1e9),
            ..BargeCase::default()
        };
        case.duck_ms = actions
            .iter()
            .find(|(now, action)| {
                *action == Action::Duck
                    && (*now as f64) >= truth.onset_ns - 100e6
                    && (*now as f64) <= truth.end_ns
            })
            .map(|(now, _)| (*now as f64 - truth.onset_ns) / 1e6);
        case.barge_in_ms = events
            .iter()
            .find(|(now, event)| {
                matches!(event, AudioEvent::BargeIn { .. })
                    && (*now as f64) >= truth.onset_ns - 100e6
                    && (*now as f64) <= truth.end_ns + 500e6
            })
            .map(|(now, _)| (*now as f64 - truth.onset_ns) / 1e6);
        let heard: Vec<(String, bool)> = events
            .iter()
            .filter_map(|(_, event)| match event {
                AudioEvent::Final {
                    text,
                    start,
                    end,
                    during_playback,
                } if unix_to_ns(*start) < truth.end_ns + 300e6
                    && unix_to_ns(*end) > truth.onset_ns - 300e6 =>
                {
                    Some((text.clone(), *during_playback))
                }
                _ => None,
            })
            .collect();
        if !heard.is_empty() {
            let text = heard
                .iter()
                .map(|(text, _)| text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            case.word_error_rate = word_error_rate(&clip.text, &text);
            case.during_playback = heard.iter().any(|(_, during)| *during);
            case.heard = Some(text);
        } else {
            case.word_error_rate = 1.0;
        }
        report.cases.push(case);
    }
    report
}

/// The default test material: Vera's lines and the user's phrases, read
/// from `dir` (see `scripts/vera-audio/make-voices.ps1`).
pub(crate) fn load_voices(dir: &std::path::Path) -> Result<Voices> {
    let manifest_path = dir.join("voices.json");
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&manifest_path)
            .wrap_err_with(|| format!("could not read {}", manifest_path.display()))?,
    )?;
    let load = |key: &str| -> Result<Vec<Clip>> {
        manifest[key]
            .as_array()
            .ok_or_else(|| eyre!("{} has no {key:?} list", manifest_path.display()))?
            .iter()
            .map(|entry| {
                let file = entry["file"].as_str().unwrap_or_default();
                let text = entry["text"].as_str().unwrap_or_default();
                Clip::load(&dir.join(file), text)
            })
            .collect()
    };
    Ok(Voices {
        vera: load("vera")?,
        user: load("user")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_error_rate_counts_edits_per_expected_word() {
        assert_eq!(word_error_rate("Stop, ask Claude to fix them.", "stop ask claude to fix them"), 0.0);
        assert!((word_error_rate("wait start a new thread", "start a new thread") - 0.2).abs() < 1e-9);
        assert_eq!(word_error_rate("no", ""), 1.0);
    }

    /// Synthetic voices: noise bursts shaped like syllables.
    fn voices() -> Voices {
        let clip = |name: &str, seconds: f32, seed: u32| {
            let rate = 24_000;
            let mut noise = Noise(seed);
            let samples = (0..(rate as f32 * seconds) as usize)
                .map(|n| {
                    let syllable = ((n as f32 / rate as f32 * 4.0).fract() < 0.7) as u8 as f32;
                    noise.gauss() * 0.08 * syllable
                })
                .collect();
            Clip {
                name: name.into(),
                text: "hello there".into(),
                samples,
                rate,
            }
        };
        Voices {
            vera: vec![clip("vera", 7.0, 3), clip("vera2", 6.0, 4)],
            user: vec![clip("user", 1.6, 8), clip("user2", 1.4, 9)],
        }
    }

    #[test]
    fn in_a_simulated_room_echo_never_barges_in_and_the_user_does() {
        let room = &RoomSpec::all()[0];
        let voices = voices();
        let _speech = crate::transcription::speech_detector::override_for_test(Some(true));
        let echo = run(room, Plan::Echo, &voices, SimStt::Fake, None, SttSource::Hybrid, 0.7).unwrap();
        assert_eq!(echo.false_barge_ins, 0, "{echo:?}");
        assert!(echo.echo_finals.is_empty(), "{:?}", echo.echo_finals);
        assert!(echo.erle_suppressed_db > 20.0, "{echo:?}");
        let barge = run(room, Plan::Barge, &voices, SimStt::Fake, None, SttSource::Hybrid, 0.7).unwrap();
        // The first case is 0.9 s into the first audio Vera ever played:
        // the canceller hasn't converged, so nothing confirms yet.
        for case in &barge.cases[1..] {
            let at = case.barge_in_ms.unwrap_or(f64::INFINITY);
            assert!(at < 400.0, "{case:?}");
        }
        assert_eq!(barge.false_barge_ins, 0, "{barge:?}");
    }
}
