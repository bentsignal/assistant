//! Vera's Settings window: one page in Hex's window, with only what Vera
//! needs. A status line (Mute beside it), then Listening (microphone, wake
//! word), Voice (voice, volume), Brain (harness, model), General (start at
//! login, personality, the Stop talking hotkey), and recent activity.

use rune::{AppSpec, Cx, El, Tx, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, Menu, MenuItem, Placement, SegmentedControl, Select, SelectAppearance,
};

use super::super::controls::{
    DESCRIPTION, METRICS, PushSize, card, icon_row, keycaps, page, pressable_row, row_switch,
    section, status_dot,
};
use super::super::{Paint, icons, lists, scroll_body};
use super::{Actions, Recent, SettingsView, Status, Tone, UiAction, send};
use crate::vera::config::{Brain, Wake};

/// The window: Hex's settings pane, without the sidebar.
pub(crate) const SIZE: (f32, f32) = (600.0, 740.0);
const SELECT_WIDTH: f32 = 220.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Open {
    Microphone,
    Voice,
    Model,
}

pub(crate) struct VeraUi {
    pub(crate) view: SettingsView,
    open: Option<Open>,
    /// The volume while its slider is dragged; saved when it lets go.
    volume_drag: Option<f32>,
    actions: Actions,
}

impl VeraUi {
    pub(crate) fn live(actions: std::sync::mpsc::Sender<UiAction>) -> Self {
        Self {
            view: SettingsView::default(),
            open: None,
            volume_drag: None,
            actions: Some(actions),
        }
    }

    pub(crate) fn fixture() -> Self {
        Self {
            view: fixture_view(),
            open: None,
            volume_drag: None,
            actions: None,
        }
    }

    fn act(&mut self, action: UiAction) {
        send(&self.actions, action);
    }

    fn toggle(&mut self, menu: Open) {
        self.open = if self.open == Some(menu) {
            None
        } else {
            Some(menu)
        };
    }
}

/// Realistic content for renders and scenes.
pub(crate) fn fixture_view() -> SettingsView {
    SettingsView {
        status: Status {
            tone: Tone::Ready,
            title: "Listening".into(),
            detail: "Say \u{201c}Vera\u{201d} to start \u{00b7} Ctrl+Alt+Space stops her talking".into(),
        },
        muted: false,
        microphones: vec![
            "Microphone (Shure MV7+)".into(),
            "Headset Microphone (Jabra Evolve2 65)".into(),
            "Microphone Array (Realtek(R) Audio)".into(),
        ],
        microphone: Some("Microphone (Shure MV7+)".into()),
        volume: 0.35,
        voices: vec![
            ("af_heart".into(), "Heart".into()),
            ("af_sky".into(), "Sky".into()),
            ("bf_emma".into(), "Emma".into()),
            ("am_michael".into(), "Michael".into()),
        ],
        voice: Some("af_heart".into()),
        brain: Brain::ClaudeCode,
        model: "sonnet".into(),
        wake: Wake::Normal,
        start_at_login: true,
        stop_hotkey: "Ctrl+Alt+Space".into(),
        stop_hotkey_note: None,
        recent: vec![
            Recent {
                you: true,
                text: "Vera, can you check on the hex thread?".into(),
                when: "2 min ago".into(),
            },
            Recent {
                you: false,
                text: "It finished. The build is green and the PR is ready for review.".into(),
                when: "2 min ago".into(),
            },
            Recent {
                you: true,
                text: "Great, show me what changed.".into(),
                when: "1 min ago".into(),
            },
        ],
    }
}

fn spec() -> AppSpec<VeraUi> {
    AppSpec {
        title: "Vera",
        size: SIZE,
        min_size: Some((520.0, 460.0)),
        init: VeraUi::fixture,
        view,
        scenes: SCENES,
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        setup: None,
        poll: None,
        on_key: None,
    }
}

pub(crate) const SCENES: &[(&str, fn(&mut VeraUi))] = &[
    ("settings", |_| {}),
    ("settings-muted", |ui| {
        ui.view.muted = true;
        ui.view.status = Status {
            tone: Tone::Quiet,
            title: "Microphone muted".into(),
            detail: "Vera can't hear you until you unmute".into(),
        };
    }),
    ("settings-voice-menu", |ui| ui.open = Some(Open::Voice)),
    ("settings-problem", |ui| {
        ui.view.status = Status {
            tone: Tone::Problem,
            title: "Core isn't running".into(),
            detail: "Node isn't on PATH \u{00b7} retrying".into(),
        };
        ui.view.recent.clear();
    }),
];

/// The live window, reporting to `actions`.
pub(crate) fn app(actions: std::sync::mpsc::Sender<UiAction>) -> rune::App<VeraUi> {
    rune::App::new(spec())
        .init(move || VeraUi::live(actions))
        .on_close(|ui: &mut VeraUi, _| ui.open = None)
}

pub(crate) fn view(ui: &VeraUi, cx: &mut Cx<VeraUi>) -> El {
    let dark = cx.system_dark();
    let p = Paint::new(dark, cx.env().scale);
    crate::windows::rune::match_title_bar(p.k.c.bg_deep, dark, dark);
    let mut layer = Vec::new();
    let content = page("vera-settings")
        .pt(4.0)
        .pb(METRICS.section_gap)
        .child(status(ui, p))
        .child(section(
            p,
            "listening",
            "Listening",
            vec![microphone_row(ui, p, &mut layer), wake_row(ui, p)],
        ))
        .child(section(
            p,
            "voice",
            "Voice",
            vec![voice_row(ui, p, &mut layer), volume_row(ui, p)],
        ))
        .child(section(
            p,
            "brain",
            "Brain",
            vec![brain_row(ui, p), model_row(ui, p, &mut layer)],
        ))
        .child(section(
            p,
            "general",
            "General",
            vec![login_row(ui, p), personality_row(p), hotkey_row(ui, p)],
        ))
        .children(recent(ui, p))
        .child(footer(p));
    let panel = col()
        .key("panel")
        .role("main")
        .grow(1.0)
        .shrink()
        .mt(8.0)
        .mr(8.0)
        .mb(8.0)
        .ml(8.0)
        .radius(p.k.radius.lg)
        .fill(p.k.c.bg_base)
        .border(p.hair, p.k.c.border_weak)
        .padding(p.hair)
        .clip_soft(0.0)
        .child(
            row()
                .key("pane-header")
                .h(METRICS.header_h)
                .px(METRICS.gutter)
                .center_y()
                .child(
                    text("Vera")
                        .key("pane-title")
                        .role("heading")
                        .level(1)
                        .font(p.title())
                        .color(p.text()),
                ),
        )
        .child(scroll_body(p.k, "body", content));
    let window = row()
        .key("window")
        .role("none")
        .fill(p.k.c.bg_deep)
        .child(panel);
    rune_kit::root(window, layer)
}

fn status(ui: &VeraUi, p: Paint) -> El {
    let Status { tone, title, detail } = &ui.view.status;
    let dot = match tone {
        Tone::Ready => super::super::controls::pulsing_dot(p.success()),
        Tone::Quiet => status_dot(p.muted()),
        Tone::Problem => status_dot(p.danger()),
    };
    let muted = ui.view.muted;
    let action = Button::new(if muted { "Unmute" } else { "Mute" })
        .variant(if muted {
            ButtonVariant::Contrast
        } else {
            ButtonVariant::Neutral
        })
        .on_press_tx(move |ui: &mut VeraUi, _: &mut Tx| {
            ui.view.muted = !muted;
            ui.act(UiAction::SetMuted(!muted));
        })
        .build_push(p.k)
        .key("mute");
    let summary = row()
        .key("status")
        .min_h(METRICS.row_h_described)
        .px(METRICS.row_px)
        .py(8.0)
        .gap(12.0)
        .center_y()
        .child(dot)
        .child(
            col()
                .key("copy")
                .grow(1.0)
                .shrink()
                .gap(2.0)
                .child(
                    text(title.clone())
                        .key("title")
                        .font(p.k.ty.ui_medium)
                        .color(p.text()),
                )
                .child(
                    text(detail.clone())
                        .key("detail")
                        .font(DESCRIPTION)
                        .color(if *tone == Tone::Problem {
                            p.danger()
                        } else {
                            p.muted()
                        })
                        .wrap(),
                ),
        )
        .child(action);
    card(p, "status-card", vec![summary])
}

/// A select field whose choices open in a menu above the page.
#[allow(clippy::too_many_arguments)]
fn select(
    p: Paint,
    key: &str,
    name: &str,
    label: &str,
    open: bool,
    menu: Open,
    choices: Vec<(String, bool, UiAction)>,
    layer: &mut Vec<El>,
) -> El {
    let trigger = Select::new::<&str>(format!("{key}-field"), &[])
        .appearance(SelectAppearance::Field)
        .width(SELECT_WIDTH)
        .current(Some(label))
        .open(open)
        .trigger(p.k)
        .on_press(move |ui: &mut VeraUi| ui.toggle(menu))
        .label(name)
        .a11y_value(label);
    let mut built = Menu::new(key)
        .trigger(trigger)
        .placement(Placement::BottomEnd)
        .gutter(4.0)
        .min_width(SELECT_WIDTH)
        .open(open)
        .on_close(|ui: &mut VeraUi| ui.open = None);
    for (label, selected, action) in choices {
        built = built.item(MenuItem::new(label).checked(selected).on_select(
            move |ui: &mut VeraUi| {
                ui.open = None;
                apply_locally(&mut ui.view, &action);
                ui.act(action.clone());
            },
        ));
    }
    built.build(p.k, layer)
}

/// Shows a choice at once; the runtime's next view confirms it.
fn apply_locally(view: &mut SettingsView, action: &UiAction) {
    match action {
        UiAction::SetMicrophone(microphone) => view.microphone = microphone.clone(),
        UiAction::SetVoice(voice) => view.voice = voice.clone(),
        UiAction::SetModel(model) => view.model = model.clone(),
        _ => {}
    }
}

fn microphone_row(ui: &VeraUi, p: Paint, layer: &mut Vec<El>) -> El {
    let current = ui.view.microphone.clone();
    let label = current.clone().unwrap_or_else(|| "System default".into());
    let mut choices = vec![(
        "System default".to_string(),
        current.is_none(),
        UiAction::SetMicrophone(None),
    )];
    choices.extend(ui.view.microphones.iter().map(|name| {
        (
            name.clone(),
            current.as_deref() == Some(name.as_str()),
            UiAction::SetMicrophone(Some(name.clone())),
        )
    }));
    icon_row(
        p,
        "microphone",
        &icons::MIC,
        "Microphone",
        None,
        select(
            p,
            "microphone-select",
            "Microphone",
            &label,
            ui.open == Some(Open::Microphone),
            Open::Microphone,
            choices,
            layer,
        ),
    )
}

fn wake_row(ui: &VeraUi, p: Paint) -> El {
    let selected = Wake::ALL
        .iter()
        .position(|wake| *wake == ui.view.wake)
        .unwrap_or(1);
    let control = SegmentedControl::new(&["Strict", "Normal", "Relaxed"], Some(selected))
        .fit()
        .on_pick(|ui: &mut VeraUi, index: usize, _: &mut Tx| {
            let wake = Wake::ALL[index.min(2)];
            ui.view.wake = wake;
            ui.act(UiAction::SetWake(wake));
        })
        .build(p.k)
        .key("wake")
        .role("segmented");
    icon_row(
        p,
        "wake-row",
        &icons::WAVE,
        "Wake word",
        Some("How close to \u{201c}Vera\u{201d} counts"),
        control,
    )
}

fn voice_row(ui: &VeraUi, p: Paint, layer: &mut Vec<El>) -> El {
    let current = ui.view.voice.clone();
    let name_of = |id: &str| {
        ui.view
            .voices
            .iter()
            .find(|(voice, _)| voice == id)
            .map_or_else(|| id.to_string(), |(_, name)| name.clone())
    };
    let label = current
        .as_deref()
        .map_or_else(|| "Default".to_string(), name_of);
    let mut choices: Vec<(String, bool, UiAction)> = ui
        .view
        .voices
        .iter()
        .map(|(id, name)| {
            (
                name.clone(),
                current.as_deref() == Some(id.as_str()),
                UiAction::SetVoice(Some(id.clone())),
            )
        })
        .collect();
    if choices.is_empty() {
        choices.push((
            "Default".into(),
            true,
            UiAction::SetVoice(current.clone()),
        ));
    }
    icon_row(
        p,
        "voice-row",
        &icons::SPEAKER,
        "Voice",
        None,
        select(
            p,
            "voice-select",
            "Voice",
            &label,
            ui.open == Some(Open::Voice),
            Open::Voice,
            choices,
            layer,
        ),
    )
}

fn volume_row(ui: &VeraUi, p: Paint) -> El {
    let volume = ui.volume_drag.unwrap_or(ui.view.volume);
    icon_row(
        p,
        "volume-row",
        &icons::VOLUME,
        "Volume",
        Some("Vera's own; the system volume stays as it is"),
        lists::inline_slider_in(
            p,
            "volume",
            "Volume",
            volume,
            format!("{:.0}%", volume * 100.0),
            180.0,
            |ui: &mut VeraUi, level: f32, done: bool| {
                ui.volume_drag = if done { None } else { Some(level) };
                if done {
                    ui.view.volume = level;
                }
                ui.act(UiAction::SetVolume { level, done });
            },
        ),
    )
}

fn brain_row(ui: &VeraUi, p: Paint) -> El {
    let selected = usize::from(ui.view.brain == Brain::Codex);
    let control = SegmentedControl::new(&["Claude Code", "Codex"], Some(selected))
        .fit()
        .on_pick(|ui: &mut VeraUi, index: usize, _: &mut Tx| {
            let brain = if index == 1 {
                Brain::Codex
            } else {
                Brain::ClaudeCode
            };
            if brain != ui.view.brain {
                ui.view.brain = brain;
                ui.view.model = brain.models()[0].to_string();
                ui.act(UiAction::SetBrain(brain));
            }
        })
        .build(p.k)
        .key("brain")
        .role("segmented");
    icon_row(
        p,
        "brain-row",
        &icons::SPARKLES,
        "Brain",
        Some("Decides what to do and hands work off"),
        control,
    )
}

fn model_row(ui: &VeraUi, p: Paint, layer: &mut Vec<El>) -> El {
    let current = ui.view.model.clone();
    let mut models: Vec<String> = ui
        .view
        .brain
        .models()
        .iter()
        .map(|m| m.to_string())
        .collect();
    if !models.contains(&current) {
        models.insert(0, current.clone());
    }
    let choices = models
        .into_iter()
        .map(|model| {
            let selected = model == current;
            (model.clone(), selected, UiAction::SetModel(model))
        })
        .collect();
    icon_row(
        p,
        "model-row",
        &icons::PILL,
        "Model",
        None,
        select(
            p,
            "model-select",
            "Model",
            &current,
            ui.open == Some(Open::Model),
            Open::Model,
            choices,
            layer,
        ),
    )
}

fn login_row(ui: &VeraUi, p: Paint) -> El {
    let on = ui.view.start_at_login;
    pressable_row(
        icon_row(
            p,
            "login",
            &icons::POWER,
            "Start at login",
            None,
            row_switch(p, on),
        ),
        on,
    )
    .on_press(move |ui: &mut VeraUi| {
        ui.view.start_at_login = !on;
        ui.act(UiAction::SetStartAtLogin(!on));
    })
}

fn personality_row(p: Paint) -> El {
    icon_row(
        p,
        "personality",
        &icons::PEN,
        "Personality",
        Some("Vera's system prompt, in your editor"),
        Button::new("Edit personality\u{2026}")
            .variant(ButtonVariant::Neutral)
            .on_press_tx(|ui: &mut VeraUi, _: &mut Tx| ui.act(UiAction::EditPersonality))
            .build_push(p.k)
            .key("edit-personality"),
    )
}

fn hotkey_row(ui: &VeraUi, p: Paint) -> El {
    let parts: Vec<String> = ui
        .view
        .stop_hotkey
        .split('+')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect();
    icon_row(
        p,
        "hotkey",
        &icons::KEYBOARD,
        "Stop talking",
        ui.view.stop_hotkey_note.as_deref(),
        keycaps(p, "stop-keys", &parts),
    )
}

fn recent(ui: &VeraUi, p: Paint) -> Option<El> {
    if ui.view.recent.is_empty() {
        return None;
    }
    let rows: Vec<El> = ui
        .view
        .recent
        .iter()
        .enumerate()
        .map(|(index, item)| {
            row()
                .key(format!("recent{index}"))
                .px(METRICS.row_px)
                .py(9.0)
                .gap(12.0)
                .child(
                    text(if item.you { "You" } else { "Vera" })
                        .key("who")
                        .font(p.k.ty.ui_medium)
                        .color(if item.you { p.muted() } else { p.text() })
                        .w(40.0),
                )
                .child(
                    text(item.text.clone())
                        .key("text")
                        .font(p.k.ty.ui)
                        .color(p.text())
                        .wrap()
                        .grow(1.0)
                        .shrink(),
                )
                .child(
                    text(item.when.clone())
                        .key("when")
                        .font(p.meta())
                        .color(p.faint()),
                )
        })
        .collect();
    Some(section(p, "recent", "Recent", rows))
}

fn footer(p: Paint) -> El {
    row()
        .key("footer")
        .px(METRICS.row_px)
        .pt(4.0)
        .center_y()
        .justify_between()
        .child(
            text(format!("Vera {}", crate::VERSION))
                .key("version")
                .font(p.meta())
                .color(p.faint()),
        )
        .child(
            el().key("quit")
                .role("button")
                .label("Quit Vera")
                .focusable(true)
                .px(6.0)
                .py(2.0)
                .radius(p.k.radius.sm)
                .hover(p.k.c.hover)
                .press(p.k.c.pressed)
                .on_press(|ui: &mut VeraUi| ui.act(UiAction::Quit))
                .child(
                    text("Quit Vera")
                        .key("label")
                        .font(p.meta())
                        .color(p.muted())
                        .a11y_hidden(),
                ),
        )
}
