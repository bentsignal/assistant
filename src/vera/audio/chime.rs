//! Vera's chimes, synthesized: short, soft, bell-like two-note figures.
//! Each note is a sine with a quiet octave and twelfth, a 6 ms attack, and
//! an exponential decay, so nothing clicks and nothing rings for long. The
//! peak is about -20 dBFS before Vera's volume, well under her voice.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChimeKind {
    /// Something arrived (inbox item, a job finished): one warm dyad.
    Notify,
    /// Vera is listening: a quick rising fifth.
    Listening,
    /// Done: a gentle rising fourth that settles.
    Done,
    /// Something went wrong: two soft, low, falling notes.
    Error,
}

impl std::str::FromStr for ChimeKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "notify" => Ok(Self::Notify),
            "listening" => Ok(Self::Listening),
            "done" => Ok(Self::Done),
            "error" => Ok(Self::Error),
            _ => Err(format!("{value:?} is not notify, listening, done, or error")),
        }
    }
}

/// Peak level of a chime before Vera's volume.
const PEAK: f32 = 0.1;

struct Note {
    /// Start, in seconds from the chime's start.
    at: f32,
    hz: f32,
    /// Decay time constant, in seconds.
    decay: f32,
    gain: f32,
    /// Level of the octave and twelfth partials against the fundamental.
    brightness: f32,
}

fn notes(kind: ChimeKind) -> Vec<Note> {
    let note = |at, hz, decay, gain, brightness| Note {
        at,
        hz,
        decay,
        gain,
        brightness,
    };
    match kind {
        // G5 + D6 together.
        ChimeKind::Notify => vec![
            note(0.0, 783.99, 0.22, 0.6, 0.18),
            note(0.0, 1174.66, 0.18, 0.4, 0.12),
        ],
        // E5 then B5.
        ChimeKind::Listening => vec![
            note(0.0, 659.25, 0.07, 0.7, 0.15),
            note(0.085, 987.77, 0.11, 0.8, 0.15),
        ],
        // A5 then D6, the second a little longer.
        ChimeKind::Done => vec![
            note(0.0, 880.0, 0.08, 0.7, 0.15),
            note(0.11, 1174.66, 0.18, 0.75, 0.12),
        ],
        // E4 then C4, duller.
        ChimeKind::Error => vec![
            note(0.0, 329.63, 0.12, 0.8, 0.06),
            note(0.16, 261.63, 0.18, 0.8, 0.06),
        ],
    }
}

/// The chime as mono samples at `rate`.
pub(crate) fn render(kind: ChimeKind, rate: u32) -> Vec<f32> {
    let notes = notes(kind);
    let end = notes
        .iter()
        .map(|note| note.at + note.decay * 6.0)
        .fold(0.0f32, f32::max);
    let length = (end * rate as f32).ceil() as usize;
    let mut samples = vec![0.0f32; length];
    let attack = 0.006;
    for note in &notes {
        let start = (note.at * rate as f32) as usize;
        for (offset, sample) in samples[start..].iter_mut().enumerate() {
            let t = offset as f32 / rate as f32;
            let envelope = (t / attack).min(1.0) * (-t / note.decay).exp();
            if envelope < 1e-4 && t > attack {
                break;
            }
            let phase = 2.0 * std::f32::consts::PI * note.hz * t;
            let tone = phase.sin()
                + note.brightness * (2.0 * phase).sin()
                + note.brightness * 0.4 * (3.0 * phase).sin();
            *sample += note.gain * envelope * tone;
        }
    }
    let peak = samples.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
    if peak > 0.0 {
        for sample in &mut samples {
            *sample *= PEAK / peak;
        }
    }
    // A short fade so the tail ends at exactly zero.
    let fade = (rate as usize / 100).min(samples.len());
    let len = samples.len();
    for (index, sample) in samples[len - fade..].iter_mut().enumerate() {
        *sample *= 1.0 - (index + 1) as f32 / fade as f32;
    }
    samples
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chimes_are_short_soft_and_end_in_silence() {
        for kind in [
            ChimeKind::Notify,
            ChimeKind::Listening,
            ChimeKind::Done,
            ChimeKind::Error,
        ] {
            let samples = render(kind, 48_000);
            let seconds = samples.len() as f32 / 48_000.0;
            assert!((0.25..=1.4).contains(&seconds), "{kind:?}: {seconds} s");
            let peak = samples.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
            assert!((peak - PEAK).abs() < 1e-4, "{kind:?}: {peak}");
            assert_eq!(*samples.last().unwrap(), 0.0);
            // No click at the start.
            assert!(samples[0].abs() < 0.01 && samples[1].abs() < 0.01);
        }
    }

    #[test]
    fn kinds_parse_from_the_protocol_names() {
        assert_eq!("notify".parse(), Ok(ChimeKind::Notify));
        assert_eq!("error".parse(), Ok(ChimeKind::Error));
        assert!("bong".parse::<ChimeKind>().is_err());
    }
}
