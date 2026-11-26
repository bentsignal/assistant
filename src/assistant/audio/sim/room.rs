//! The simulated room: Vera's speaker (a soft-clipping, band-limited
//! driver), the acoustic path to the microphone (a synthetic impulse
//! response with a direct path, early reflections, and an exponential tail
//! at a chosen RT60 and direct-to-reverberant ratio), the user's voice
//! through the same room from further away, background noise, and a
//! microphone whose clock drifts against the speaker's.

use std::sync::Arc;

use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

use super::super::align::RATE;

/// One room: geometry, levels, and the devices' timing.
#[derive(Clone, Debug)]
pub(crate) struct RoomSpec {
    pub name: &'static str,
    pub rt60: f32,
    /// Direct-to-reverberant ratio of the speaker-to-microphone path, dB.
    pub drr_db: f32,
    /// Vera's echo at the microphone against the user's voice there, dB
    /// (positive: louder than the user).
    pub echo_over_user_db: f32,
    /// The user's voice at the microphone, dBFS RMS while speaking.
    pub user_dbfs: f32,
    /// Speaker drive into its soft clip (0: linear).
    pub drive: f32,
    /// The speaker's low cut, Hz.
    pub speaker_low_cut: f32,
    /// Output latency the device reports, and what it doesn't (Bluetooth).
    pub output_latency_ms: f32,
    pub unreported_output_ms: f32,
    /// How late the microphone's stamps are against when it heard (can be
    /// negative), and how long its audio takes to arrive.
    pub capture_stamp_error_ms: f32,
    pub input_latency_ms: f32,
    /// Microphone clock against the speaker's.
    pub drift_ppm: f32,
    pub noise_dbfs: f32,
    /// Fan-like noise (low-passed), dBFS; `None` for none.
    pub fan_dbfs: Option<f32>,
    /// A noise-gated microphone (Shawn's CORSAIR headset): exact zeros
    /// while what it hears stays under this level (dBFS over 10 ms), open
    /// for `GATE_HOLD_MS` after it last went over.
    pub gate_dbfs: Option<f32>,
    /// Small sounds near the microphone (breath, a chair, a click), dBFS,
    /// a few a second: enough to open a gate, not speech.
    pub rustle_dbfs: Option<f32>,
}

impl RoomSpec {
    pub(crate) fn all() -> Vec<Self> {
        let desk = Self {
            name: "desk",
            rt60: 0.35,
            drr_db: 4.0,
            echo_over_user_db: 6.0,
            user_dbfs: -32.0,
            drive: 3.0,
            speaker_low_cut: 80.0,
            output_latency_ms: 20.0,
            unreported_output_ms: 10.0,
            capture_stamp_error_ms: 1.0,
            input_latency_ms: 12.0,
            drift_ppm: 60.0,
            noise_dbfs: -66.0,
            fan_dbfs: None,
            gate_dbfs: None,
            rustle_dbfs: None,
        };
        vec![
            desk.clone(),
            Self {
                name: "laptop",
                rt60: 0.3,
                drr_db: 10.0,
                echo_over_user_db: 10.0,
                user_dbfs: -34.0,
                drive: 6.0,
                speaker_low_cut: 300.0,
                output_latency_ms: 30.0,
                unreported_output_ms: 5.0,
                drift_ppm: 0.0,
                noise_dbfs: -60.0,
                ..desk.clone()
            },
            Self {
                name: "kitchen",
                rt60: 0.6,
                drr_db: -2.0,
                echo_over_user_db: 8.0,
                user_dbfs: -38.0,
                drive: 3.0,
                unreported_output_ms: 30.0,
                drift_ppm: -90.0,
                noise_dbfs: -64.0,
                fan_dbfs: Some(-50.0),
                ..desk.clone()
            },
            Self {
                name: "bluetooth",
                unreported_output_ms: 190.0,
                drift_ppm: 120.0,
                ..desk.clone()
            },
            Self {
                name: "headset",
                rt60: 0.25,
                drr_db: 6.0,
                echo_over_user_db: -40.0,
                user_dbfs: -26.0,
                drive: 0.0,
                ..desk.clone()
            },
            // A wireless gaming headset whose microphone gates itself:
            // digital silence between sounds, its own hiss (-82 dBFS) while
            // open, nothing of Vera at all.
            Self {
                name: "gated",
                rt60: 0.25,
                drr_db: 6.0,
                echo_over_user_db: -90.0,
                user_dbfs: -26.0,
                drive: 0.0,
                noise_dbfs: -82.0,
                gate_dbfs: Some(-72.0),
                rustle_dbfs: Some(-58.0),
                ..desk
            },
        ]
    }
}

/// A small xorshift noise source.
pub(crate) struct Noise(pub u32);

impl Noise {
    pub(crate) fn uniform(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    pub(crate) fn gauss(&mut self) -> f32 {
        (0..4).map(|_| self.uniform()).sum::<f32>() * 0.866
    }
}

/// An impulse response at 16 kHz for a source `distance_m` away.
pub(crate) fn impulse_response(rt60: f32, drr_db: f32, distance_m: f32, seed: u32) -> Vec<f32> {
    let rate = RATE as f32;
    let length = (rate * rt60 * 1.1) as usize;
    let mut response = vec![0.0f32; length.max(64)];
    let direct = ((distance_m / 343.0) * rate) as usize;
    response[direct] = 1.0;
    let mut noise = Noise(seed);
    // Early reflections: a few taps over the next 25 ms.
    let mut early = 0.0f32;
    for tap in 0..6 {
        let at = direct + (rate * (0.003 + 0.004 * tap as f32)) as usize;
        let gain = 0.45 * noise.uniform() * (1.0 - tap as f32 / 8.0);
        response[at] += gain;
        early += gain * gain;
    }
    let tail_from = direct + (rate * 0.005) as usize;
    let decay = 6.91 / (rt60 * rate);
    let mut tail = vec![0.0f32; length.max(64)];
    for (index, sample) in tail.iter_mut().enumerate().skip(tail_from) {
        *sample = noise.gauss() * (-decay * (index - tail_from) as f32).exp();
    }
    let tail_energy: f32 = tail.iter().map(|s| s * s).sum();
    let direct_energy = 1.0 + early;
    // Scale the tail so direct / reverberant energy is `drr_db`.
    let scale = (direct_energy / tail_energy / 10f32.powf(drr_db / 10.0)).sqrt();
    for (into, sample) in response.iter_mut().zip(&tail) {
        *into += sample * scale;
    }
    response
}

/// Uniformly partitioned overlap-save convolution, `PART` samples a step.
pub(crate) struct Convolver {
    part: usize,
    forward: Arc<dyn RealToComplex<f32>>,
    inverse: Arc<dyn ComplexToReal<f32>>,
    filter: Vec<Vec<Complex32>>,
    history: Vec<Vec<Complex32>>,
    newest: usize,
    input: Vec<f32>,
    scratch: Vec<f32>,
    spectrum: Vec<Complex32>,
    sum: Vec<Complex32>,
}

impl Convolver {
    pub(crate) fn new(response: &[f32], part: usize) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let size = part * 2;
        let forward = planner.plan_fft_forward(size);
        let inverse = planner.plan_fft_inverse(size);
        let filter: Vec<Vec<Complex32>> = response
            .chunks(part)
            .map(|chunk| {
                let mut padded = vec![0.0f32; size];
                padded[..chunk.len()].copy_from_slice(chunk);
                let mut spectrum = forward.make_output_vec();
                forward
                    .process(&mut padded, &mut spectrum)
                    .expect("sizes match");
                spectrum
            })
            .collect();
        let bins = size / 2 + 1;
        Self {
            part,
            history: vec![vec![Complex32::default(); bins]; filter.len()],
            filter,
            forward,
            inverse,
            newest: 0,
            input: vec![0.0; size],
            scratch: vec![0.0; size],
            spectrum: vec![Complex32::default(); bins],
            sum: vec![Complex32::default(); bins],
        }
    }

    /// Convolves the next `part` samples.
    pub(crate) fn process(&mut self, block: &[f32]) -> Vec<f32> {
        debug_assert_eq!(block.len(), self.part);
        self.input.copy_within(self.part.., 0);
        self.input[self.part..].copy_from_slice(block);
        self.scratch.copy_from_slice(&self.input);
        self.forward
            .process(&mut self.scratch, &mut self.spectrum)
            .expect("sizes match");
        let partitions = self.filter.len();
        self.newest = (self.newest + partitions - 1) % partitions;
        self.history[self.newest].copy_from_slice(&self.spectrum);
        self.sum
            .iter_mut()
            .for_each(|bin| *bin = Complex32::default());
        for (offset, filter) in self.filter.iter().enumerate() {
            let spectrum = &self.history[(self.newest + offset) % partitions];
            for ((sum, x), h) in self.sum.iter_mut().zip(spectrum).zip(filter) {
                *sum += x * h;
            }
        }
        // The DC and Nyquist bins must be real for the inverse.
        self.sum[0].im = 0.0;
        if let Some(last) = self.sum.last_mut() {
            last.im = 0.0;
        }
        self.inverse
            .process(&mut self.sum, &mut self.scratch)
            .expect("sizes match");
        let size = (self.part * 2) as f32;
        self.scratch[self.part..]
            .iter()
            .map(|sample| sample / size)
            .collect()
    }
}

/// A two-pole high-pass, for the speaker's low cut.
pub(crate) struct LowCut {
    b: [f32; 3],
    a: [f32; 2],
    state: [f32; 4],
}

impl LowCut {
    pub(crate) fn new(cutoff: f32, rate: f32) -> Self {
        let w = (std::f32::consts::PI * cutoff / rate).tan();
        let q = std::f32::consts::FRAC_1_SQRT_2;
        let norm = 1.0 / (1.0 + w / q + w * w);
        Self {
            b: [norm, -2.0 * norm, norm],
            a: [2.0 * (w * w - 1.0) * norm, (1.0 - w / q + w * w) * norm],
            state: [0.0; 4],
        }
    }

    pub(crate) fn next(&mut self, x: f32) -> f32 {
        let [x1, x2, y1, y2] = self.state;
        let y = self.b[0] * x + self.b[1] * x1 + self.b[2] * x2 - self.a[0] * y1 - self.a[1] * y2;
        self.state = [x, x1, y, y1];
        y
    }
}

/// How long a gated microphone stays open after its level last went over.
pub(crate) const GATE_HOLD_MS: usize = 400;

/// A microphone's noise gate, on 10 ms windows: closed, it delivers exact
/// zeros.
pub(crate) struct NoiseGate {
    threshold: f32,
    window: Vec<f32>,
    open_for: usize,
}

impl NoiseGate {
    pub(crate) fn new(threshold_dbfs: f32) -> Self {
        Self {
            threshold: 10f32.powf(threshold_dbfs / 10.0),
            window: Vec::new(),
            open_for: 0,
        }
    }

    pub(crate) fn process(&mut self, samples: &mut [f32]) {
        let window = RATE as usize / 100;
        let hold = GATE_HOLD_MS * RATE as usize / 1_000;
        for sample in samples {
            self.window.push(*sample);
            if self.window.len() == window {
                let energy = self.window.iter().map(|s| s * s).sum::<f32>() / window as f32;
                if energy > self.threshold {
                    self.open_for = hold;
                }
                self.window.clear();
            }
            if self.open_for == 0 {
                *sample = 0.0;
            } else {
                self.open_for -= 1;
            }
        }
    }
}

/// Rustles: 60–120 ms bursts of low-passed noise at about `dbfs`, one
/// every 0.3–1.1 s (deterministic), so a gate is open most of the time.
pub(crate) fn rustles(samples: usize, dbfs: f32, seed: u32) -> Vec<f32> {
    let rate = RATE as usize;
    let mut out = vec![0.0f32; samples];
    let mut noise = Noise(seed);
    let burst = fan(rate / 4, dbfs, seed ^ 0x5bd1);
    let mut at = rate;
    while at < samples {
        let length = rate * (60 + ((noise.uniform() + 1.0) * 30.0) as usize) / 1_000;
        let ramp = (rate / 200) as f32;
        for (offset, sample) in burst.iter().take(length).enumerate() {
            let fade = (offset.min(length - offset) as f32 / ramp).min(1.0);
            if let Some(into) = out.get_mut(at + offset) {
                *into += sample * fade;
            }
        }
        at += rate * 3 / 10 + ((noise.uniform() + 1.0) * 0.4 * rate as f32) as usize;
    }
    out
}

/// Fan noise: white noise through two one-pole low-passes (~400 Hz).
pub(crate) fn fan(samples: usize, dbfs: f32, seed: u32) -> Vec<f32> {
    let mut noise = Noise(seed);
    let alpha = 1.0 - (-2.0 * std::f32::consts::PI * 400.0 / RATE as f32).exp();
    let (mut a, mut b) = (0.0f32, 0.0f32);
    let mut out: Vec<f32> = (0..samples)
        .map(|_| {
            a += alpha * (noise.gauss() - a);
            b += alpha * (a - b);
            b
        })
        .collect();
    let rms = (out.iter().map(|s| s * s).sum::<f32>() / samples.max(1) as f32).sqrt();
    let gain = 10f32.powf(dbfs / 20.0) / rms.max(1e-9);
    out.iter_mut().for_each(|sample| *sample *= gain);
    out
}

/// Cubic (Catmull-Rom) interpolation of `signal` at fractional `position`.
pub(crate) fn interpolate(signal: &[f32], position: f64) -> f32 {
    let base = position.floor() as i64;
    let t = (position - base as f64) as f32;
    let at = |offset: i64| -> f32 {
        let index = base + offset;
        if index < 0 {
            0.0
        } else {
            signal.get(index as usize).copied().unwrap_or(0.0)
        }
    };
    let (p0, p1, p2, p3) = (at(-1), at(0), at(1), at(2));
    p1 + 0.5
        * t
        * (p2 - p0 + t * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + t * (3.0 * (p1 - p2) + p3 - p0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partitioned_convolution_matches_direct_convolution() {
        let response = impulse_response(0.2, 0.0, 1.0, 5);
        let mut noise = Noise(11);
        let signal: Vec<f32> = (0..16_000).map(|_| noise.uniform()).collect();
        let mut convolver = Convolver::new(&response, 160);
        let fast: Vec<f32> = signal
            .chunks(160)
            .flat_map(|chunk| convolver.process(chunk))
            .collect();
        for n in (4_000..16_000).step_by(997) {
            let direct: f32 = (0..response.len().min(n + 1))
                .map(|k| response[k] * signal[n - k])
                .sum();
            assert!(
                (fast[n] - direct).abs() < 1e-3,
                "{n}: {} vs {direct}",
                fast[n]
            );
        }
    }

    #[test]
    fn the_direct_to_reverberant_ratio_follows_the_setting() {
        let ratio = |drr_db: f32| {
            let response = impulse_response(0.4, drr_db, 1.0, 2);
            let direct_at = (RATE as f32 / 343.0) as usize;
            let split = direct_at + (RATE as usize * 5 / 1_000);
            let direct: f32 = response[..split].iter().map(|s| s * s).sum();
            let tail: f32 = response[split..].iter().map(|s| s * s).sum();
            10.0 * (direct / tail).log10()
        };
        let difference = ratio(6.0) - ratio(0.0);
        // Less than the 6 dB asked: the early reflections stay as they are.
        assert!((3.0..=7.0).contains(&difference), "{difference}");
    }
}
