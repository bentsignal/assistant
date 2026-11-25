//! The echo canceller: WebRTC's AEC3 (`sonora-aec3`, a pure-Rust port) at
//! 16 kHz on 4 ms blocks, with Vera's own playback as its reference.
//!
//! Two outputs come back for every block. The *linear* output is the
//! microphone minus AEC3's adaptive-filter echo estimate: the user's voice
//! is intact in it, with a residual of Vera's voice that tracks her level.
//! Barge-in judges that. The *suppressed* output adds AEC3's nonlinear
//! suppressor, which removes nearly all the residual but also clips the
//! user while both talk. Both are the raw microphone when Vera is silent,
//! high-passed at 80 Hz as WebRTC's pipeline does.
//!
//! The filters are 32 blocks (128 ms) instead of 13, so more of a room's
//! reverberation is cancelled linearly: in the simulator that buys about
//! 6 dB more linear echo loss in an ordinary room.

use sonora_aec3::block::Block;
use sonora_aec3::block_processor::BlockProcessor;
use sonora_aec3::config::EchoCanceller3Config;

use super::align::{BLOCK, RATE};

/// AEC3 works on floats in 16-bit sample scale.
const SCALE: f32 = 32_768.0;
const FILTER_BLOCKS: usize = 32;

pub(crate) struct EchoCanceller {
    processor: BlockProcessor,
    high_pass: HighPass,
    render: Block,
    capture: Block,
    linear: Block,
}

/// One block's results.
pub(crate) struct Cancelled {
    pub linear: [f32; BLOCK],
    pub suppressed: [f32; BLOCK],
}

impl EchoCanceller {
    pub(crate) fn new() -> Self {
        let mut config = EchoCanceller3Config::default();
        config.filter.refined.length_blocks = FILTER_BLOCKS;
        config.filter.coarse.length_blocks = FILTER_BLOCKS;
        config.filter.export_linear_aec_output = true;
        Self {
            processor: BlockProcessor::new(&config, RATE as usize, 1, 1),
            high_pass: HighPass::new(80.0, RATE as f32),
            render: Block::new(1, 1),
            capture: Block::new(1, 1),
            linear: Block::new(1, 1),
        }
    }

    /// Cancels `reference`'s echo from `microphone`.
    pub(crate) fn process(&mut self, microphone: &[f32], reference: &[f32]) -> Cancelled {
        debug_assert_eq!(microphone.len(), BLOCK);
        for (into, sample) in self.render.view_mut(0, 0).iter_mut().zip(reference) {
            *into = sample * SCALE;
        }
        self.processor.buffer_render(&self.render);
        for (into, sample) in self.capture.view_mut(0, 0).iter_mut().zip(microphone) {
            *into = self.high_pass.next(*sample) * SCALE;
        }
        self.processor
            .process_capture(false, false, Some(&mut self.linear), &mut self.capture);
        let mut cancelled = Cancelled {
            linear: [0.0; BLOCK],
            suppressed: [0.0; BLOCK],
        };
        for (into, sample) in cancelled.linear.iter_mut().zip(self.linear.view(0, 0)) {
            *into = sample / SCALE;
        }
        for (into, sample) in cancelled.suppressed.iter_mut().zip(self.capture.view(0, 0)) {
            *into = sample / SCALE;
        }
        cancelled
    }

    /// AEC3's current delay estimate between the reference it was given and
    /// the echo, in ms.
    pub(crate) fn delay_ms(&self) -> i32 {
        self.processor.get_metrics().delay_ms
    }
}

/// A second-order Butterworth high-pass.
struct HighPass {
    b: [f32; 3],
    a: [f32; 2],
    x: [f32; 2],
    y: [f32; 2],
}

impl HighPass {
    fn new(cutoff: f32, rate: f32) -> Self {
        let w = (std::f32::consts::PI * cutoff / rate).tan();
        let q = std::f32::consts::FRAC_1_SQRT_2;
        let norm = 1.0 / (1.0 + w / q + w * w);
        Self {
            b: [norm, -2.0 * norm, norm],
            a: [2.0 * (w * w - 1.0) * norm, (1.0 - w / q + w * w) * norm],
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    fn next(&mut self, x: f32) -> f32 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(seed: &mut u32) -> f32 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 17;
        *seed ^= *seed << 5;
        (*seed as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32
    }

    #[test]
    fn a_delayed_echo_of_the_reference_is_removed() {
        let mut aec = EchoCanceller::new();
        let mut seed = 9;
        // Speech-like reference: noise bursts; echo is it 50 ms later, half level.
        let total = RATE as usize * 6;
        let reference: Vec<f32> = (0..total)
            .map(|n| {
                let burst = ((n / 3_000) % 3 != 2) as u8 as f32;
                noise(&mut seed) * 0.1 * burst
            })
            .collect();
        let delay = RATE as usize / 20;
        let mut echo_in = 0.0;
        let mut echo_out = 0.0;
        let mut linear_out = 0.0;
        for block in 0..total / BLOCK {
            let at = block * BLOCK;
            let microphone: Vec<f32> = (at..at + BLOCK)
                .map(|n| n.checked_sub(delay).map_or(0.0, |m| reference[m] * 0.5))
                .collect();
            let cancelled = aec.process(&microphone, &reference[at..at + BLOCK]);
            if at > RATE as usize * 4 {
                echo_in += energy(&microphone);
                echo_out += energy(&cancelled.suppressed);
                linear_out += energy(&cancelled.linear);
            }
        }
        let erle = 10.0 * (echo_in / echo_out).log10();
        let linear = 10.0 * (echo_in / linear_out).log10();
        assert!(erle > 25.0, "suppressed {erle:.1} dB");
        assert!(linear > 15.0, "linear {linear:.1} dB");
        let delay_ms = aec.delay_ms();
        assert!((40..=60).contains(&delay_ms), "{delay_ms}");
    }

    #[test]
    fn without_a_reference_the_microphone_passes_through() {
        let mut aec = EchoCanceller::new();
        let mut seed = 3;
        let mut input = 0.0;
        let mut output = 0.0;
        for block in 0..400 {
            // A 1 kHz tone with a little noise.
            let microphone: Vec<f32> = (0..BLOCK)
                .map(|n| {
                    let t = (block * BLOCK + n) as f32 / RATE as f32;
                    (2.0 * std::f32::consts::PI * 1_000.0 * t).sin() * 0.1
                        + noise(&mut seed) * 0.001
                })
                .collect();
            let cancelled = aec.process(&microphone, &[0.0; BLOCK]);
            if block > 100 {
                input += energy(&microphone);
                output += energy(&cancelled.linear);
            }
        }
        let change = 10.0 * (output / input).log10();
        assert!(change.abs() < 0.5, "{change:.2} dB");
    }
}
