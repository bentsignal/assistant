//! The card Vera shows when there's something to see: a small panel in the
//! top right corner, styled like Hex's meeting capsule, with a title, a
//! close button, and markdown-ish text that scrolls when long. It's a
//! click-through overlay except for the card itself, and never takes the
//! keyboard, so it never steals focus. Vera opens it with `show` and
//! closes it with `hide`; its close button tells Core `card_closed`.

use std::time::Duration;

use rune::{
    Align, Cx, El, KeyPolicy, OverlayHandle, OverlayInput, OverlayOptions, OverlaySpec,
    ScreenEdge, Tx, col, el, row, text,
};

use super::super::Paint;
use super::{Actions, UiAction, send};

/// The overlay's window; the card sits in its top right and is only as
/// tall as its text, up to [`MAX_BODY`].
pub(crate) const WINDOW: (f32, f32) = (432.0, 600.0);
const CARD_WIDTH: f32 = 400.0;
/// The window's margin around the card, room for its shadow.
const INSET: f32 = 16.0;
const RADIUS: f32 = 14.0;
const MAX_BODY: f32 = 460.0;
const FADE: Duration = Duration::from_millis(140);

/// What a card shows.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct CardView {
    pub(crate) card_id: Option<String>,
    pub(crate) title: String,
    pub(crate) markdown: String,
}

pub(crate) struct VeraCard {
    pub(crate) card: Option<CardView>,
    pub(crate) actions: Actions,
    this: Option<OverlayHandle<VeraCard>>,
}

impl VeraCard {
    pub(crate) fn fixture(card: CardView) -> Self {
        Self {
            card: Some(card),
            actions: None,
            this: None,
        }
    }
}

/// Adds the card's overlay to `app`, hidden.
pub(crate) fn install<S: 'static>(
    app: &mut rune::App<S>,
    actions: std::sync::mpsc::Sender<UiAction>,
) -> CardHandle {
    let spec = OverlaySpec {
        name: "vera-card",
        size: WINDOW,
        edge: ScreenEdge::Top,
        margin: 24.0,
        align: Align::End,
        inset: 24.0,
        interactive: true,
        view,
    }
    .options(OverlayOptions {
        // Only the card takes the pointer; its margin passes clicks through.
        input: OverlayInput::Regions,
        keys: KeyPolicy::None,
        display: rune::DisplayTarget::UnderPointer,
        ..OverlayOptions::default()
    })
    .release_gpu_after(Duration::from_secs(30));
    let overlay = app.overlay(
        spec,
        VeraCard {
            card: None,
            actions: Some(actions),
            this: None,
        },
    );
    let this = overlay.clone();
    overlay.update(move |card, _| card.this = Some(this));
    CardHandle(overlay)
}

/// Shows and hides the card from any thread.
#[derive(Clone)]
pub(crate) struct CardHandle(OverlayHandle<VeraCard>);

impl CardHandle {
    pub(crate) fn show(&self, card: CardView) {
        let overlay = self.0.clone();
        self.0.update(move |state, _| {
            state.card = Some(card);
            overlay.fade_in(FADE);
        });
    }

    /// Hides the card if it shows `card_id` (any card for `None`); true when
    /// one was showing.
    pub(crate) fn hide(&self, card_id: Option<String>) {
        let overlay = self.0.clone();
        self.0.update(move |state, _| {
            let matches = state.card.as_ref().is_some_and(|shown| {
                card_id.is_none() || shown.card_id.is_none() || shown.card_id == card_id
            });
            if matches {
                state.card = None;
                overlay.fade_out(FADE);
            }
        });
    }
}

fn close(card: &mut VeraCard, _: &mut Tx) {
    let closed = card.card.take();
    if let Some(this) = &card.this {
        this.fade_out(FADE);
    }
    if let Some(closed) = closed {
        send(&card.actions, UiAction::CardClosed(closed.card_id));
    }
}

pub(crate) fn view(card: &VeraCard, cx: &mut Cx<VeraCard>) -> El {
    let p = Paint::new(cx.system_dark(), cx.env().scale);
    let Some(shown) = &card.card else {
        return el().key("empty").w_full().h_full();
    };
    let close_button = el()
        .key("close")
        .role("button")
        .label("Close")
        .focusable(true)
        .size(28.0, 28.0)
        .center()
        .radius(14.0)
        .hover(p.k.c.hover)
        .press(p.k.c.pressed)
        .on_press_tx(close)
        .child(
            rune::icon(p.k.glyph.close, 16.0)
                .key("x")
                .color(p.k.c.icon_muted)
                .a11y_hidden(),
        );
    let header = row()
        .key("header")
        .pl(18.0)
        .pr(10.0)
        .pt(12.0)
        .pb(6.0)
        .gap(8.0)
        .center_y()
        .child(
            text(shown.title.clone())
                .key("title")
                .role("heading")
                .level(1)
                .font(p.k.ty.body_medium)
                .color(p.text())
                .wrap()
                .grow(1.0)
                .shrink(),
        )
        .child(close_button);
    // Keyed by the card, so each new card opens scrolled to its top.
    let body = col()
        .key(format!(
            "card-body-{}",
            shown.card_id.as_deref().unwrap_or("none")
        ))
        .max_h(MAX_BODY)
        .scroll(rune::ScrollSpec {
            stick_bottom: false,
        })
        .px(18.0)
        .pt(2.0)
        .pb(16.0)
        .child(super::markdown::render(p, &shown.markdown));
    let mut panel = col()
        .key("card")
        .role("dialog")
        .label(shown.title.clone())
        .w(CARD_WIDTH)
        .radius(RADIUS)
        .fill(p.k.c.bg_base)
        .border(p.hair, p.k.c.border_base)
        .clip_rounded(RADIUS)
        .hit()
        .child(header)
        .child(body);
    for shadow in &p.k.elevation.overlay {
        panel = panel.box_shadow(*shadow);
    }
    col()
        .key("corner")
        .w_full()
        .h_full()
        .padding(INSET)
        .items_end()
        .justify_start()
        .child(panel)
}
