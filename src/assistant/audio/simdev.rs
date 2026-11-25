//! Simulated devices, so the real app can be tested end to end without a
//! microphone or speakers (`ASSISTANT_AUDIO_SIM`; `scripts/assistant-soak/`). The
//! engine then opens these instead of cpal's:
//!
//! - **Microphone**: 48 kHz mono in 10 ms blocks at real-time pace, made of
//!   a faint noise floor (so it never reads as a muted device), Vera's own
//!   output as an echo (delayed and attenuated, like a headset's leak or a
//!   quiet speaker), and whatever WAVs [`inject_wav`] queued: the user.
//! - **Speakers**: a thread that renders the mixer at real-time pace into
//!   nothing, keeping what it played for the echo and reporting each
//!   stretch of audible output to the trace (`crate::assistant::trace`) as
//!   `{"kind":"out","start","end","rms_db","peak_db"}`, and each dip in
//!   Vera's level (a barge-in duck) as `{"kind":"dip","start","end","depth_db"}`.
//!
//! `ASSISTANT_AUDIO_SIM=1`, or a list such as `echo_db=-30,delay_ms=60,noise_db=-75`;
//! [`Sim::reconfigure`] changes it live (another device: a headset).
//! Both devices stamp their audio on [`now_ns`], as cpal does on WASAPI, so
//! the echo canceller lines them up exactly as it would real devices.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use color_eyre::eyre::{Result, WrapErr, eyre};

use super::mixer::Mixer;
use super::now_ns;

pub(crate) const RATE: u32 = 48_000;
const BLOCK: usize = 480;
const BLOCK_NS: u64 = 10_000_000;
/// Blocks the output renders ahead of the clock: its "latency".
const OUTPUT_LEAD: u64 = 2;
/// How much of the output the echo can reach back to.
const RING_BLOCKS: usize = 512;
/// Output quieter than this (RMS) is silence in the trace.
const AUDIBLE_RMS: f32 = 3.2e-4; // -70 dBFS
/// Silence this long ends a stretch of output.
const SEGMENT_GAP_BLOCKS: u32 = 20;
/// A duck gain under this is a dip in the trace.
const DIP_GAIN: f32 = 0.99;

pub(crate) struct Sim {
    epoch_ns: u64,
    /// Gains as f32 bits, so the spec can change live.
    echo_gain: AtomicU32,
    echo_delay_blocks: AtomicU64,
    noise: AtomicU32,
    /// The user's voice still to play into the microphone.
    feed: Mutex<VecDeque<f32>>,
    /// What the output rendered, by block.
    ring: Mutex<Vec<(u64, Vec<f32>)>>,
}

static SIM: OnceLock<Option<Arc<Sim>>> = OnceLock::new();

/// The simulated devices, when `ASSISTANT_AUDIO_SIM` asks for them.
pub(crate) fn sim() -> Option<Arc<Sim>> {
    SIM.get_or_init(|| {
        let spec = std::env::var("ASSISTANT_AUDIO_SIM").ok()?;
        let spec = spec.trim();
        if spec.is_empty() || spec == "0" {
            return None;
        }
        let sim = Sim {
            epoch_ns: now_ns(),
            echo_gain: AtomicU32::new(db(-30.0).to_bits()),
            echo_delay_blocks: AtomicU64::new(6),
            noise: AtomicU32::new(db(-75.0).to_bits()),
            feed: Mutex::new(VecDeque::new()),
            ring: Mutex::new(vec![(u64::MAX, Vec::new()); RING_BLOCKS]),
        };
        sim.reconfigure(spec);
        Some(Arc::new(sim))
    })
    .clone()
}

fn db(value: f32) -> f32 {
    10f32.powf(value / 20.0)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Sim {
    /// Applies `echo_db=…,delay_ms=…,noise_db=…` (any of them); the rest
    /// stays as it is.
    pub(crate) fn reconfigure(&self, spec: &str) {
        for part in spec.split(',') {
            let Some((key, value)) = part.split_once('=') else {
                continue;
            };
            let Ok(value) = value.trim().parse::<f32>() else {
                continue;
            };
            match key.trim() {
                "echo_db" => self.echo_gain.store(db(value).to_bits(), Ordering::Relaxed),
                "delay_ms" => self
                    .echo_delay_blocks
                    .store((value / 10.0).round().max(1.0) as u64, Ordering::Relaxed),
                "noise_db" => self.noise.store(db(value).to_bits(), Ordering::Relaxed),
                _ => {}
            }
        }
        tracing::info!(
            echo_db = 20.0 * f32::from_bits(self.echo_gain.load(Ordering::Relaxed)).log10(),
            delay_ms = self.echo_delay_blocks.load(Ordering::Relaxed) * 10,
            noise_db = 20.0 * f32::from_bits(self.noise.load(Ordering::Relaxed)).log10(),
            "assistant audio: simulated devices"
        );
    }

    /// Blocks fully elapsed since the epoch.
    fn blocks_done(&self) -> u64 {
        now_ns().saturating_sub(self.epoch_ns) / BLOCK_NS
    }

    fn block_start_ns(&self, block: u64) -> u64 {
        self.epoch_ns + block * BLOCK_NS
    }

    /// The microphone's next blocks, up to the clock.
    fn microphone(&self, from: u64, to: u64, rng: &mut u32) -> Vec<f32> {
        let mut out = Vec::with_capacity(((to - from) as usize) * BLOCK);
        let mut feed = lock(&self.feed);
        let ring = lock(&self.ring);
        let delay = self.echo_delay_blocks.load(Ordering::Relaxed);
        let echo_gain = f32::from_bits(self.echo_gain.load(Ordering::Relaxed));
        let noise_gain = f32::from_bits(self.noise.load(Ordering::Relaxed));
        for block in from..to {
            let echo = block
                .checked_sub(delay)
                .map(|source| &ring[(source as usize) % RING_BLOCKS])
                .filter(|(index, samples)| {
                    Some(*index) == block.checked_sub(delay) && samples.len() == BLOCK
                });
            for i in 0..BLOCK {
                // xorshift: cheap white noise.
                *rng ^= *rng << 13;
                *rng ^= *rng >> 17;
                *rng ^= *rng << 5;
                let noise = (*rng as f32 / u32::MAX as f32 * 2.0 - 1.0) * noise_gain;
                let echo = echo.map_or(0.0, |(_, samples)| samples[i] * echo_gain);
                let user = feed.pop_front().unwrap_or(0.0);
                out.push(noise + echo + user);
            }
        }
        out
    }

    /// Queues the user's voice: mono samples at [`RATE`].
    pub(crate) fn speak_into_microphone(&self, samples: &[f32]) {
        lock(&self.feed).extend(samples);
    }

    /// Drops whatever user audio is still queued.
    pub(crate) fn clear_microphone(&self) {
        lock(&self.feed).clear();
    }
}

/// Reads a WAV (any rate, any channels, int or float), mixes it to mono at
/// [`RATE`], applies `gain_db`, and queues it into the simulated
/// microphone. Returns how long it plays.
pub(crate) fn inject_wav(path: &std::path::Path, gain_db: f32) -> Result<Duration> {
    let sim =
        sim().ok_or_else(|| eyre!("the simulated devices aren't on (ASSISTANT_AUDIO_SIM)"))?;
    let mut reader = hound::WavReader::open(path)
        .wrap_err_with(|| format!("could not read {}", path.display()))?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let interleaved: Vec<f32> = match spec.sample_format {
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
    let mono: Vec<f32> = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    let mut samples = super::resample::resample(&mono, spec.sample_rate, RATE);
    let gain = db(gain_db);
    for sample in &mut samples {
        *sample = (*sample * gain).clamp(-1.0, 1.0);
    }
    let length = Duration::from_secs_f64(samples.len() as f64 / f64::from(RATE));
    sim.speak_into_microphone(&samples);
    Ok(length)
}

/// The simulated microphone.
pub(crate) struct SimInput {
    sim: Arc<Sim>,
    next: u64,
    rng: u32,
}

impl SimInput {
    pub(crate) fn open(sim: Arc<Sim>) -> Self {
        let next = sim.blocks_done();
        Self {
            sim,
            next,
            rng: 0x9e37_79b9,
        }
    }

    /// The audio captured since the last call (waiting up to `poll` for
    /// some), with when its last sample was captured.
    pub(crate) fn recv(&mut self, poll: Duration) -> Option<(Vec<f32>, u64)> {
        let mut done = self.sim.blocks_done();
        if done <= self.next {
            std::thread::sleep(poll.min(Duration::from_millis(10)));
            done = self.sim.blocks_done();
            if done <= self.next {
                return None;
            }
        }
        // A stalled reader skips ahead rather than flooding the engine.
        if done - self.next > 50 {
            self.next = done - 5;
        }
        let samples = self.sim.microphone(self.next, done, &mut self.rng);
        self.next = done;
        Some((samples, self.sim.block_start_ns(done)))
    }
}

/// The simulated speakers: a thread rendering the mixer in real time.
pub(crate) struct SimOutput {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl SimOutput {
    pub(crate) fn open(sim: Arc<Sim>, mixer: Arc<Mutex<Mixer>>) -> Result<Self> {
        lock(&mixer).set_rate(RATE);
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("assistant-sim-output".into())
            .spawn({
                let stop = stop.clone();
                move || render_loop(&sim, &mixer, &stop)
            })
            .wrap_err("could not start the simulated output")?;
        tracing::info!("assistant audio: output open device=\"simulated\" rate={RATE}");
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for SimOutput {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A stretch of audible output, for the trace.
#[derive(Default)]
struct Segment {
    start_block: u64,
    last_audible: u64,
    sum_squares: f64,
    samples: u64,
    peak: f32,
    quiet: u32,
}

fn render_loop(sim: &Sim, mixer: &Mutex<Mixer>, stop: &AtomicBool) {
    let mut next = sim.blocks_done() + OUTPUT_LEAD;
    let mut block = vec![0f32; BLOCK];
    let mut segment: Option<Segment> = None;
    // An open dip: its first block and the deepest gain so far.
    let mut dip: Option<(u64, f32)> = None;
    while !stop.load(Ordering::Relaxed) {
        let target = sim.blocks_done() + OUTPUT_LEAD;
        if next + 50 < target {
            next = target;
        }
        while next <= target {
            block.fill(0.0);
            let duck = {
                let mut mixer = lock(mixer);
                mixer.render(&mut block, sim.block_start_ns(next));
                mixer.duck_gain()
            };
            if duck < DIP_GAIN {
                let (_, deepest) = dip.get_or_insert((next, duck));
                *deepest = deepest.min(duck);
            } else if let Some((start, deepest)) = dip.take() {
                report_dip(sim, start, next, deepest);
            }
            let sum: f64 = block.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
            let rms = (sum / BLOCK as f64).sqrt() as f32;
            let peak = block.iter().fold(0f32, |peak, s| peak.max(s.abs()));
            {
                let mut ring = lock(&sim.ring);
                let slot = &mut ring[(next as usize) % RING_BLOCKS];
                slot.0 = next;
                slot.1.clear();
                slot.1.extend_from_slice(&block);
            }
            if rms >= AUDIBLE_RMS {
                let seg = segment.get_or_insert_with(|| Segment {
                    start_block: next,
                    ..Segment::default()
                });
                seg.last_audible = next;
                seg.sum_squares += sum;
                seg.samples += BLOCK as u64;
                seg.peak = seg.peak.max(peak);
                seg.quiet = 0;
            } else if let Some(seg) = &mut segment {
                seg.quiet += 1;
                if seg.quiet >= SEGMENT_GAP_BLOCKS {
                    report(sim, segment.take().expect("checked above"));
                }
            }
            next += 1;
        }
        std::thread::sleep(Duration::from_millis(4));
    }
    if let Some(seg) = segment {
        report(sim, seg);
    }
}

fn unix_ms(sim: &Sim, block: u64) -> i64 {
    let ns = sim.block_start_ns(block);
    crate::desktop::events::now_ms() as i64 - (now_ns() as i64 - ns as i64) / 1_000_000
}

fn report_dip(sim: &Sim, start: u64, end: u64, deepest: f32) {
    let depth_db = -20.0 * deepest.max(1e-6).log10();
    crate::assistant::trace::record(
        "dip",
        serde_json::json!({
            "start": unix_ms(sim, start),
            "end": unix_ms(sim, end),
            "depth_db": (depth_db * 10.0).round() / 10.0,
        }),
    );
}

fn report(sim: &Sim, segment: Segment) {
    let unix = |block: u64| unix_ms(sim, block);
    let rms = (segment.sum_squares / segment.samples.max(1) as f64).sqrt() as f32;
    let to_db = |v: f32| (20.0 * v.max(1e-9).log10() * 10.0).round() / 10.0;
    crate::assistant::trace::record(
        "out",
        serde_json::json!({
            "start": unix(segment.start_block),
            "end": unix(segment.last_audible + 1),
            "rms_db": to_db(rms),
            "peak_db": to_db(segment.peak),
        }),
    );
}
