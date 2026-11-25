//! Vera's output stream: the default output device (or one named), opened
//! when there is something to play and closed once it has been idle a
//! while, so the default device is followed between utterances and nothing
//! holds the speakers open all day. The callback renders the shared
//! [`Mixer`] and never touches system volume.

use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, PoisonError};

use color_eyre::eyre::{Result, WrapErr, eyre};
use cpal::traits::{DeviceTrait, StreamTrait};

use super::mixer::Mixer;

/// What keeps the output playing: a cpal stream, or the simulated
/// speakers (`simdev`).
#[allow(dead_code)]
enum Stream {
    Cpal(cpal::Stream),
    Sim(super::simdev::SimOutput),
}

pub(crate) struct Output {
    _stream: Stream,
    pub rate: u32,
    pub name: String,
    /// The stream failed (device unplugged, format changed).
    pub errors: Receiver<String>,
}

/// The output devices, by name, default first.
pub(crate) fn output_names() -> Vec<String> {
    candidates()
        .iter()
        .filter_map(|device| device.description().ok().map(|d| d.name().to_owned()))
        .collect()
}

fn candidates() -> Vec<cpal::Device> {
    #[cfg(target_os = "windows")]
    {
        crate::audio::default_output_candidates()
    }
    #[cfg(not(target_os = "windows"))]
    {
        use cpal::traits::HostTrait;
        let host = cpal::default_host();
        let mut devices: Vec<cpal::Device> = host.default_output_device().into_iter().collect();
        if let Ok(listed) = host.output_devices() {
            devices.extend(listed);
        }
        devices
    }
}

/// Opens `device` (a name fragment) or the default output, rendering
/// `mixer`, which is set to the device's rate first.
pub(crate) fn open(device: Option<&str>, mixer: Arc<Mutex<Mixer>>) -> Result<Output> {
    if let Some(sim) = super::simdev::sim() {
        let output = super::simdev::SimOutput::open(sim, mixer)?;
        // Never fails, but the engine reads failures the same way.
        let (_failed, errors) = mpsc::channel();
        return Ok(Output {
            _stream: Stream::Sim(output),
            rate: super::simdev::RATE,
            name: "simulated".into(),
            errors,
        });
    }
    let devices = candidates();
    let wanted = device.map(str::to_lowercase);
    let device = devices
        .into_iter()
        .find(|candidate| {
            wanted.as_deref().is_none_or(|wanted| {
                candidate
                    .description()
                    .is_ok_and(|description| description.name().to_lowercase().contains(wanted))
            })
        })
        .ok_or_else(|| match &wanted {
            Some(wanted) => eyre!("no output device matches {wanted:?}"),
            None => eyre!("there is no output device"),
        })?;
    let name = device
        .description()
        .map(|description| description.name().to_owned())
        .unwrap_or_else(|_| "output".into());
    let supported = device
        .default_output_config()
        .wrap_err_with(|| format!("could not read {name}'s output format"))?;
    let config = supported.config();
    let rate = config.sample_rate;
    let channels = config.channels as usize;
    mixer
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .set_rate(rate);
    let (failed, errors) = mpsc::channel();
    let on_error = move |error: cpal::Error| {
        let _ = failed.send(error.to_string());
    };
    let mut mono = Vec::new();
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_output_stream(
            config,
            move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
                render(&mixer, &mut mono, data.len() / channels, info);
                for (frame, sample) in data.chunks_mut(channels).zip(&mono) {
                    frame.fill(*sample);
                }
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_output_stream(
            config,
            move |data: &mut [i16], info: &cpal::OutputCallbackInfo| {
                render(&mixer, &mut mono, data.len() / channels, info);
                for (frame, sample) in data.chunks_mut(channels).zip(&mono) {
                    frame.fill((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                }
            },
            on_error,
            None,
        ),
        format => {
            return Err(eyre!(
                "{name} wants {format:?} samples, which Vera doesn't write"
            ));
        }
    }
    .wrap_err_with(|| format!("could not open {name} for output"))?;
    stream
        .play()
        .wrap_err_with(|| format!("could not start {name}"))?;
    tracing::info!(
        device = name,
        rate,
        channels,
        "assistant audio: output open"
    );
    Ok(Output {
        _stream: Stream::Cpal(stream),
        rate,
        name,
        errors,
    })
}

fn render(
    mixer: &Mutex<Mixer>,
    mono: &mut Vec<f32>,
    frames: usize,
    info: &cpal::OutputCallbackInfo,
) {
    mono.clear();
    mono.resize(frames, 0.0);
    let playback_ns = u64::try_from(info.timestamp().playback.as_nanos()).unwrap_or(u64::MAX);
    mixer
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .render(mono, playback_ns);
}
