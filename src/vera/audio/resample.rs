//! A streaming windowed-sinc resampler between any two rates.
//!
//! Output sample `n` is the input signal at input position `n × from / to`
//! exactly: the kernel is centred, so the output carries no delay against
//! the input's timeline, it only arrives `half_taps` input samples after the
//! input that completes it. The aligner leans on that: a 16 kHz index maps
//! straight back to a device-rate position. Before the first input sample
//! the signal reads as silence.

use std::sync::Arc;

/// Kernel zero crossings kept on each side, at the lower of the two rates.
const ZERO_CROSSINGS: f64 = 12.0;
/// Kernel table resolution: entries per input sample.
const PHASES: usize = 64;

pub(crate) struct Resampler {
    /// Input samples per output sample.
    step: f64,
    half_taps: usize,
    /// The kernel sampled every `1 / PHASES` input samples over
    /// `-half_taps ..= half_taps`.
    table: Arc<[f32]>,
    buffer: Vec<f32>,
    /// Absolute input index of `buffer[0]`.
    buffer_start: i64,
    /// Input samples pushed so far, flush padding included.
    pushed: i64,
    /// Input samples of the signal itself.
    real: u64,
    /// The next output sample.
    next: u64,
}

impl Resampler {
    pub(crate) fn new(from: u32, to: u32) -> Self {
        let step = from as f64 / to as f64;
        // The cutoff sits just under the lower Nyquist, relative to the input.
        let cutoff = (1.0 / step).min(1.0) * 0.94;
        let half_taps = (ZERO_CROSSINGS / cutoff).ceil() as usize;
        let length = 2 * half_taps * PHASES + 1;
        let table: Vec<f32> = (0..length)
            .map(|index| {
                let x = index as f64 / PHASES as f64 - half_taps as f64;
                let sinc = if x.abs() < 1e-12 {
                    cutoff
                } else {
                    (std::f64::consts::PI * x * cutoff).sin() / (std::f64::consts::PI * x)
                };
                // Blackman window over the kernel's span.
                let w = (x / half_taps as f64 + 1.0) * 0.5;
                let window = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * w).cos()
                    + 0.08 * (4.0 * std::f64::consts::PI * w).cos();
                (sinc * window) as f32
            })
            .collect();
        Self {
            step,
            half_taps,
            table: table.into(),
            buffer: Vec::new(),
            buffer_start: 0,
            pushed: 0,
            real: 0,
            next: 0,
        }
    }

    /// Output samples produced so far.
    pub(crate) fn produced(&self) -> u64 {
        self.next
    }

    /// Appends `input` and returns every output sample it completes.
    pub(crate) fn push(&mut self, input: &[f32]) -> Vec<f32> {
        let mut output = Vec::new();
        self.push_into(input, &mut output);
        output
    }

    pub(crate) fn push_into(&mut self, input: &[f32], output: &mut Vec<f32>) {
        self.real += input.len() as u64;
        self.extend(input, output);
    }

    /// Ends the signal: returns the output samples still owed, so the total
    /// is the input's length at the new rate.
    pub(crate) fn flush(&mut self) -> Vec<f32> {
        let expected = (self.real as f64 / self.step).ceil() as u64;
        let mut output = Vec::new();
        let padding = vec![0.0; self.half_taps + 1];
        while self.next < expected {
            self.extend(&padding, &mut output);
        }
        let excess = (self.next - expected) as usize;
        output.truncate(output.len().saturating_sub(excess));
        self.next = expected;
        output
    }

    fn extend(&mut self, input: &[f32], output: &mut Vec<f32>) {
        self.buffer.extend_from_slice(input);
        self.pushed += input.len() as i64;
        let half = self.half_taps as i64;
        loop {
            let center = self.next as f64 * self.step;
            let last_needed = center.floor() as i64 + half;
            if last_needed >= self.pushed {
                break;
            }
            output.push(self.sample_at(center));
            self.next += 1;
        }
        // Keep what the next output still reaches back to.
        let keep_from = (self.next as f64 * self.step).floor() as i64 - half;
        let drop = (keep_from - self.buffer_start).clamp(0, self.buffer.len() as i64) as usize;
        if drop > 0 {
            self.buffer.drain(..drop);
            self.buffer_start += drop as i64;
        }
    }

    fn sample_at(&self, center: f64) -> f32 {
        let half = self.half_taps as i64;
        let base = center.floor() as i64;
        let mut acc = 0.0f32;
        // Every tap's weight, so each phase has unity gain at DC; inputs
        // before the first sample count as silence.
        let mut weights = 0.0f32;
        for k in (base - half + 1)..=(base + half) {
            // Kernel position of input k relative to the centre.
            let x = (k as f64 - center + half as f64) * PHASES as f64;
            let at = x.floor();
            let frac = (x - at) as f32;
            let at = at as usize;
            let a = self.table.get(at).copied().unwrap_or(0.0);
            let b = self.table.get(at + 1).copied().unwrap_or(0.0);
            let weight = a + (b - a) * frac;
            weights += weight;
            let index = k - self.buffer_start;
            if index >= 0
                && let Some(sample) = self.buffer.get(index as usize)
            {
                acc += sample * weight;
            }
        }
        if weights.abs() < 1e-6 { acc } else { acc / weights }
    }
}

/// Resamples a whole signal at once (tests, fixtures, the simulator).
pub(crate) fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to {
        return input.to_vec();
    }
    let mut resampler = Resampler::new(from, to);
    let mut output = resampler.push(input);
    output.extend(resampler.flush());
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, hz: f32, seconds: f32) -> Vec<f32> {
        (0..(rate as f32 * seconds) as usize)
            .map(|n| (2.0 * std::f32::consts::PI * hz * n as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn a_tone_keeps_its_level_and_phase_across_rates() {
        for (from, to) in [(48_000, 16_000), (24_000, 48_000), (44_100, 16_000), (16_000, 16_000)] {
            let input = tone(from, 440.0, 1.0);
            let output = resample(&input, from, to);
            assert_eq!(output.len(), to as usize, "{from}->{to}");
            let mut streamed = Resampler::new(from, to);
            let mut total = streamed.push(&input).len();
            total += streamed.flush().len();
            assert_eq!(total, to as usize);
            let expected = tone(to, 440.0, 1.0);
            // Away from the edges the output is the same tone, in phase.
            let middle = to as usize / 4..to as usize * 3 / 4;
            let error: Vec<f32> = middle
                .clone()
                .map(|n| output[n] - expected[n])
                .collect();
            let snr = 20.0 * (rms(&expected[middle]) / rms(&error).max(1e-9)).log10();
            assert!(snr > 50.0, "{from}->{to}: {snr:.1} dB");
        }
    }

    #[test]
    fn content_above_the_new_nyquist_is_removed() {
        // 9 kHz is above 16 kHz's Nyquist: it must not alias to 7 kHz.
        let input = tone(48_000, 9_000.0, 1.0);
        let output = resample(&input, 48_000, 16_000);
        let level = rms(&output[4_000..12_000]);
        assert!(level < 0.002, "{level}");
    }

    #[test]
    fn streaming_in_odd_chunks_matches_one_push() {
        let input = tone(48_000, 300.0, 0.5);
        let whole = Resampler::new(48_000, 16_000).push(&input);
        let mut streamed = Vec::new();
        let mut resampler = Resampler::new(48_000, 16_000);
        for chunk in input.chunks(97) {
            streamed.extend(resampler.push(chunk));
        }
        assert_eq!(whole.len(), streamed.len());
        for (a, b) in whole.iter().zip(&streamed) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}

