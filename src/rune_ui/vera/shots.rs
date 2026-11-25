//! Offscreen renders of Vera's Settings window and card for `vera shots`,
//! through the same runtime and renderer Hex's goldens use.

use rune::Env;
use rune::text::TextSystem;

use super::card::{CardView, VeraCard, WINDOW};
use super::settings::{SCENES, SIZE, VeraUi};

/// Pixels as straight RGBA rows (premultiplied where the window is
/// transparent).
pub(crate) struct Render {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba: Vec<u8>,
}

const SCALE: f32 = 2.0;

fn render<S: 'static>(
    gpu: &rune::render::Gpu,
    state: S,
    view: fn(&S, &mut rune::Cx<S>) -> rune::El,
    size: (f32, f32),
    dark: bool,
) -> Render {
    let env = Env {
        system_dark: dark,
        scale: SCALE,
    };
    let text = TextSystem::new(rune_theme_opencode::FONTS, rune_theme_opencode::FAMILIES);
    let mut rt = super::super::offscreen::runtime(state, view, size, env, text);
    rt.settle_all();
    rt.frame(0.0);
    let (width, height) = ((size.0 * SCALE) as u32, (size.1 * SCALE) as u32);
    let rgba = super::super::offscreen::draw(gpu, &mut rt, width, height);
    Render {
        width,
        height,
        rgba,
    }
}

/// Settings as `scene` (see `settings::SCENES`) shows it, `height` points
/// tall (the window's own height when `None`).
pub(crate) fn settings(
    gpu: &rune::render::Gpu,
    scene: &str,
    dark: bool,
    height: Option<f32>,
) -> Option<Render> {
    let (_, apply) = SCENES.iter().find(|(name, _)| *name == scene)?;
    let mut state = VeraUi::fixture();
    apply(&mut state);
    let size = (SIZE.0, height.unwrap_or(SIZE.1));
    Some(render(gpu, state, super::settings::view, size, dark))
}

/// The card overlay's window showing `card`, over a desktop wallpaper
/// (an offscreen render has no transparency to composite).
pub(crate) fn card(gpu: &rune::render::Gpu, card: CardView, dark: bool) -> Render {
    render(gpu, VeraCard::fixture(card), card_on_desktop, WINDOW, dark)
}

fn card_on_desktop(card: &VeraCard, cx: &mut rune::Cx<VeraCard>) -> rune::El {
    let dark = cx.system_dark();
    let (top, bottom) = if dark {
        ("#222633", "#161a22")
    } else {
        ("#dfe5ee", "#cdd5e0")
    };
    let color = |hex| rune::color::hex(hex).unwrap_or(rune::Color::TRANSPARENT);
    rune::col()
        .key("desktop")
        .w_full()
        .h_full()
        .fill(color(top))
        .gradient(color(top), color(bottom))
        .child(super::card::view(card, cx))
}
