//! Vera's HUD looks drawn offscreen through the real shaders, for
//! `vera shots` (DESIGN.md): the model is stepped at 60 fps through a fixed
//! schedule with a speech-like meter, and the chosen frame is drawn into a
//! window the size Windows gives the HUD.

use std::time::{Duration, Instant};

use super::{Layout, Painter, Target, WINDOW};
use crate::dictation::indicator::{
    AssistantLook, DictationIndicatorEvent, DotFrame, IndicatorModel,
};
use crate::rune_hud::dot_scope::{self, Tuning};

/// A drawn HUD, premultiplied RGBA rows.
pub(crate) struct Shot {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba: Vec<u8>,
}

/// A step of the schedule: the look to set (if any), then seconds to run.
pub(crate) type Step = (Option<AssistantLook>, f32);

/// The frame after running `steps`, metering `voice` (a speech envelope
/// phase) while listening or speaking. A metered last step gives its
/// liveliest frame of its last 0.8 s, as a voice mid-word looks.
pub(crate) fn frame_after(steps: &[Step], voice: f32) -> DotFrame {
    let start = Instant::now();
    let mut model = IndicatorModel::new(Tuning::default(), start);
    let mut now = start;
    let mut time = voice;
    let mut look = None;
    let mut frame = model.frame();
    let dt = 1.0 / 60.0;
    let mut best: Option<(u64, DotFrame)> = None;
    let last = steps.len().saturating_sub(1);
    for (index, (set, seconds)) in steps.iter().enumerate() {
        if let Some(set) = set {
            look = Some(*set);
            model.handle(DictationIndicatorEvent::Assistant(*set), now, false);
        }
        let frames = (seconds / dt).round() as usize;
        for n in 0..frames {
            now += Duration::from_secs_f32(dt);
            time += dt;
            if matches!(
                look,
                Some(AssistantLook::Listening | AssistantLook::Speaking)
            ) {
                let rms = 10f32.powf(dot_scope::demo_loudness(time) / 20.0);
                model.handle(
                    DictationIndicatorEvent::Meter {
                        average: rms,
                        peak: rms,
                    },
                    now,
                    false,
                );
            }
            frame = model.step(now, dt, false);
            let metered = matches!(
                look,
                Some(AssistantLook::Listening | AssistantLook::Speaking)
            );
            if index == last && metered && (frames - n) as f32 * dt <= 0.8 {
                let energy: u64 = frame.dots.iter().map(|[power, _]| u64::from(*power)).sum();
                if best.as_ref().is_none_or(|(most, _)| energy > *most) {
                    best = Some((energy, frame.clone()));
                }
            }
        }
    }
    best.map_or(frame, |(_, frame)| frame)
}

/// Draws `frame` into the HUD's window at `scale`.
pub(crate) fn draw(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    frame: &DotFrame,
    scale: f32,
) -> Shot {
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let painter = Painter::new(device, format);
    let size = (
        (WINDOW.0 * scale).round() as u32,
        (WINDOW.1 * scale).round() as u32,
    );
    let extent = wgpu::Extent3d {
        width: size.0,
        height: size.1,
        depth_or_array_layers: 1,
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("vera hud shot"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    let row = (size.0 * 4).div_ceil(256) * 256;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("vera hud readback"),
        size: u64::from(row * size.1),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let target = Target {
        viewport: [0.0, 0.0, size.0 as f32, size.1 as f32],
        clip: [0, 0, size.0, size.1],
        scale,
    };
    let mut encoder = device.create_command_encoder(&Default::default());
    let uniforms = painter.write(frame, Layout::default(), target, |buffer, data| {
        queue.write_buffer(buffer, 0, data)
    });
    painter.draw(&mut encoder, &view, &uniforms);
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row),
                rows_per_image: None,
            },
        },
        extent,
    );
    queue.submit([encoder.finish()]);
    readback.slice(..).map_async(wgpu::MapMode::Read, |result| {
        let _ = result;
    });
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let mapped = readback
        .slice(..)
        .get_mapped_range()
        .expect("the readback is mapped");
    let mut rgba = Vec::with_capacity((size.0 * size.1 * 4) as usize);
    for y in 0..size.1 {
        rgba.extend_from_slice(&mapped[(y * row) as usize..][..(size.0 * 4) as usize]);
    }
    drop(mapped);
    readback.unmap();
    Shot {
        width: size.0,
        height: size.1,
        rgba,
    }
}
