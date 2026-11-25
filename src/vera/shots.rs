//! `vera shots <dir>`: Vera's screens as PNGs, for review beside Hex's
//! goldens: the HUD's looks drawn through its real shaders over a desktop,
//! the card over a desktop, Settings in light and dark, the tray icon on
//! dark and light taskbars, and with `--tray` the real tray menu, opened for
//! a moment and copied off the screen.

use std::path::{Path, PathBuf};

use color_eyre::Result;
use color_eyre::eyre::eyre;

use crate::dictation::indicator::VeraLook;
use crate::rune_hud::vera_shots::{self, Step};
use crate::rune_ui::vera::card::CardView;
use crate::rune_ui::vera::shots as ui_shots;

/// The card's sample: a finished job, as Vera would show it.
pub(crate) fn sample_card() -> CardView {
    CardView {
        card_id: Some("c3".into()),
        title: "Hex build is green".into(),
        markdown:
            "The Windows build broke because `transcribe-cpp` was pinned to an older ggml.\n\n\
## What changed\n\
- Bumped the pin to **0.4.1** and rebuilt the Vulkan shaders\n\
- `scripts/check` passes: 1,284 tests, 0 failures\n\
- PR #2841 is open for review\n\n\
> Codex is still rendering the goldens. I'll chime when it's done."
                .into(),
    }
}

/// A desktop behind the shots: a soft wallpaper gradient.
fn wallpaper(dark: bool, y: f32) -> [f32; 3] {
    let (top, bottom) = if dark {
        ([0.13, 0.15, 0.20], [0.07, 0.08, 0.11])
    } else {
        ([0.88, 0.90, 0.94], [0.78, 0.82, 0.88])
    };
    [0, 1, 2].map(|i| top[i] + (bottom[i] - top[i]) * y)
}

/// Premultiplied `rgba` over the wallpaper, opaque.
fn over_wallpaper(width: u32, height: u32, rgba: &[u8], dark: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len());
    for (i, pixel) in rgba.chunks(4).enumerate() {
        let y = (i as u32 / width) as f32 / height.max(1) as f32;
        let under = wallpaper(dark, y);
        let a = f32::from(pixel[3]) / 255.0;
        for c in 0..3 {
            let v = f32::from(pixel[c]) / 255.0 + under[c] * (1.0 - a);
            out.push((v * 255.0).round().clamp(0.0, 255.0) as u8);
        }
        out.push(255);
    }
    out
}

fn save(
    dir: &Path,
    name: &str,
    width: u32,
    height: u32,
    rgba: &[u8],
    saved: &mut Vec<PathBuf>,
) -> Result<()> {
    let path = dir.join(format!("{name}.png"));
    rune::render::write_png(&path, width, height, rgba)?;
    saved.push(path);
    Ok(())
}

/// Lays images out in a row with `gap` pixels of `fill` between them.
fn row_of(images: &[(u32, u32, Vec<u8>)], gap: u32, fill: [u8; 4]) -> (u32, u32, Vec<u8>) {
    let width = images.iter().map(|(w, ..)| *w).sum::<u32>() + gap * (images.len() as u32 + 1);
    let height = images.iter().map(|(_, h, _)| *h).max().unwrap_or(0) + gap * 2;
    let mut out: Vec<u8> = std::iter::repeat_n(fill, (width * height) as usize)
        .flatten()
        .collect();
    let mut x0 = gap;
    for (w, h, rgba) in images {
        for y in 0..*h {
            let from = (y * w * 4) as usize;
            let to = (((y + gap) * width + x0) * 4) as usize;
            out[to..to + (w * 4) as usize].copy_from_slice(&rgba[from..from + (w * 4) as usize]);
        }
        x0 += w + gap;
    }
    (width, height, out)
}

pub(crate) fn run(dir: &Path, tray: bool) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let gpu = rune::render::Gpu::try_new(rune::render::Gpu::instance(), None)
        .map_err(|error| eyre!("no GPU to draw with: {error}"))?;
    let mut saved = Vec::new();

    // The HUD, through its own shaders, in the window Windows gives it.
    let looks: [(&str, &[Step], f32); 4] = [
        ("listening", &[(Some(VeraLook::Listening), 1.55)], 0.4),
        (
            "thinking",
            &[
                (Some(VeraLook::Listening), 0.9),
                (Some(VeraLook::Thinking), 0.95),
            ],
            0.0,
        ),
        (
            "speaking",
            &[
                (Some(VeraLook::Thinking), 0.8),
                (Some(VeraLook::Speaking), 2.4),
            ],
            0.4,
        ),
        (
            "done",
            &[(Some(VeraLook::Speaking), 1.2), (Some(VeraLook::Idle), 0.1)],
            1.0,
        ),
    ];
    for dark in [true, false] {
        let theme = if dark { "dark" } else { "light" };
        let mut strip = Vec::new();
        for (name, steps, voice) in looks {
            let frame = vera_shots::frame_after(steps, voice);
            let shot = vera_shots::draw(&gpu.device, &gpu.queue, &frame, 2.0);
            let rgba = over_wallpaper(shot.width, shot.height, &shot.rgba, dark);
            save(
                dir,
                &format!("hud-{name}-{theme}"),
                shot.width,
                shot.height,
                &rgba,
                &mut saved,
            )?;
            if name != "done" {
                strip.push((shot.width, shot.height, rgba));
            }
        }
        let fill = if dark {
            [18, 20, 26, 255]
        } else {
            [214, 220, 228, 255]
        };
        let (w, h, rgba) = row_of(&strip, 0, fill);
        save(dir, &format!("hud-states-{theme}"), w, h, &rgba, &mut saved)?;
    }

    // The card, over a desktop, cropped to it and its shadow.
    for dark in [true, false] {
        let theme = if dark { "dark" } else { "light" };
        let render = ui_shots::card(&gpu, sample_card(), dark);
        let (w, h, rgba) = crop_rows(render.width, render.height, &render.rgba, 0.62);
        save(dir, &format!("card-{theme}"), w, h, &rgba, &mut saved)?;
    }

    // Settings at the window's size, and the whole page at once.
    for (scene, theme, height, name) in [
        ("settings", "light", None, "settings-light"),
        ("settings", "dark", None, "settings-dark"),
        ("settings", "light", Some(1000.0), "settings-full-light"),
        ("settings", "dark", Some(1000.0), "settings-full-dark"),
        (
            "settings-voice-menu",
            "dark",
            None,
            "settings-voice-menu-dark",
        ),
        ("settings-muted", "light", None, "settings-muted-light"),
        ("settings-problem", "dark", None, "settings-problem-dark"),
    ] {
        let render = ui_shots::settings(&gpu, scene, theme == "dark", height)
            .ok_or_else(|| eyre!("no scene {scene}"))?;
        save(
            dir,
            name,
            render.width,
            render.height,
            &render.rgba,
            &mut saved,
        )?;
    }

    // The tray icon on both taskbars: plain, with the inbox badge, muted;
    // each at 16, 24 and 32 pixels, then 4x.
    let mut icons = Vec::new();
    for light in [false, true] {
        let taskbar = if light {
            [243, 243, 243, 255]
        } else {
            [32, 32, 32, 255]
        };
        for (badge, dim) in [(false, false), (true, false), (false, true)] {
            for size in [16u32, 24, 32] {
                let mark = super::icon::tray_rgba(size, light, badge, dim);
                let zoom = 4;
                let side = size * zoom;
                let mut big = Vec::with_capacity((side * side * 4) as usize);
                for y in 0..side {
                    for x in 0..side {
                        let i = (((y / zoom) * size + x / zoom) * 4) as usize;
                        let a = f32::from(mark[i + 3]) / 255.0;
                        for c in 0..3 {
                            let v = f32::from(mark[i + c]) * a + f32::from(taskbar[c]) * (1.0 - a);
                            big.push(v.round() as u8);
                        }
                        big.push(255);
                    }
                }
                icons.push((side, side, big));
            }
        }
        let (w, h, rgba) = row_of(&icons, 16, taskbar);
        let theme = if light { "light" } else { "dark" };
        save(dir, &format!("tray-icon-{theme}"), w, h, &rgba, &mut saved)?;
        icons.clear();
    }

    if tray {
        tray_menus(dir, &mut saved)?;
    }
    for path in &saved {
        println!("{}", path.display());
    }
    Ok(())
}

/// The top `fraction` of an image: the card sits at the top of its window.
fn crop_rows(width: u32, height: u32, rgba: &[u8], fraction: f32) -> (u32, u32, Vec<u8>) {
    let rows = ((height as f32 * fraction) as u32).min(height);
    (width, rows, rgba[..(width * rows * 4) as usize].to_vec())
}

/// Opens the real tray menu twice (as it is at rest, then muted while Vera
/// speaks) near the notification area and copies it off the screen.
fn tray_menus(dir: &Path, saved: &mut Vec<PathBuf>) -> Result<()> {
    use super::tray::{Tray, TrayState};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    let tray = Tray::new(
        TrayState {
            tooltip: "Vera \u{00b7} listening".into(),
            ..TrayState::default()
        },
        |_| {},
    )?;
    // SAFETY: plain queries.
    let (width, height) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    let at = (width - 300, height - 80);
    for (name, state) in [
        (
            "tray-menu",
            TrayState {
                tooltip: "Vera \u{00b7} listening".into(),
                ..TrayState::default()
            },
        ),
        (
            "tray-menu-muted-speaking",
            TrayState {
                muted: true,
                speaking: true,
                badge: 2,
                tooltip: "Vera \u{00b7} speaking \u{00b7} 2 new".into(),
            },
        ),
    ] {
        tray.set(state);
        std::thread::sleep(std::time::Duration::from_millis(250));
        let captured = tray
            .capture_menu(at)
            .ok_or_else(|| eyre!("couldn't capture the tray menu"))?;
        save(
            dir,
            name,
            captured.width,
            captured.height,
            &captured.rgba,
            saved,
        )?;
    }
    drop(tray);
    Ok(())
}
