//! The assistant's Settings window: one page in Hex's window, with only
//! what she needs. Her name, a status line (Mute beside it), then Listening
//! (microphone, wake word), Voice (voice, volume), Brain (harness, model),
//! General (start at login, personality, the Stop talking hotkey), and
//! recent activity. Everything that names her uses her name.

use rune::{AppSpec, Cx, El, TextEdit, Tx, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, Menu, MenuItem, Placement, SegmentedControl, Select, SelectAppearance,
    TextArea, TextInput,
};

use super::super::controls::{
    DESCRIPTION, METRICS, PushSize, card, icon_described_row, icon_row, keycaps, page,
    pressable_row, row_switch, section, status_dot,
};
use super::super::{Paint, icons, lists, scroll_body};
use super::{Actions, Recent, SettingsView, Status, Tone, UiAction, UpdateButton, send};
use crate::assistant::config::{Brain, Persona, Wake};
use crate::assistant::update::Channel;

/// The window: Hex's settings pane, without the sidebar.
pub(crate) const SIZE: (f32, f32) = (600.0, 760.0);
const SELECT_WIDTH: f32 = 220.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Open {
    Persona(usize),
    Microphone,
    Voice,
    Model,
}

pub(crate) struct AssistantUi {
    pub(crate) view: SettingsView,
    /// One name field per persona; they follow `view.personas` unless one
    /// is being edited.
    names: Vec<TextEdit>,
    /// One wake-phrases field per persona ("hey Vera, okay Vera"), the same way.
    phrases: Vec<TextEdit>,
    open: Option<Open>,
    /// The volume while its slider is dragged; saved when it lets go.
    volume_drag: Option<f32>,
    /// The personality editor, while it's open.
    prompt: Option<PromptEditor>,
    actions: Actions,
}

/// Her system prompt being edited in Settings.
struct PromptEditor {
    edit: TextEdit,
    /// The text as it was last loaded or saved.
    saved: String,
    /// What the last Save or Revert did.
    note: Option<String>,
}

impl PromptEditor {
    fn new(text: String) -> Self {
        Self {
            edit: TextEdit::new(text.clone()),
            saved: text,
            note: None,
        }
    }

    fn dirty(&self) -> bool {
        self.edit.text != self.saved
    }
}

impl AssistantUi {
    pub(crate) fn live(actions: std::sync::mpsc::Sender<UiAction>) -> Self {
        Self {
            view: SettingsView::default(),
            names: Vec::new(),
            phrases: Vec::new(),
            open: None,
            volume_drag: None,
            prompt: None,
            actions: Some(actions),
        }
    }

    pub(crate) fn fixture() -> Self {
        Self {
            names: fields(&fixture_view().personas),
            phrases: phrase_fields(&fixture_view().personas),
            view: fixture_view(),
            open: None,
            volume_drag: None,
            prompt: None,
            actions: None,
        }
    }

    fn act(&mut self, action: UiAction) {
        send(&self.actions, action);
    }

    /// What the runtime published. The name field takes the new name unless
    /// Shawn is typing in it.
    pub(crate) fn set_view(&mut self, view: SettingsView) {
        let editing = self.names.iter().any(|name| name.focused);
        let shown: Vec<&str> = self.names.iter().map(|name| name.text.trim()).collect();
        let saved: Vec<&str> = view.personas.iter().map(|p| p.name.as_str()).collect();
        if !editing && shown != saved {
            self.names = fields(&view.personas);
        }
        let editing = self.phrases.iter().any(|field| field.focused);
        if !editing && view.personas != self.view.personas {
            self.phrases = phrase_fields(&view.personas);
        }
        self.view = view;
    }

    /// Applies what the name fields say: renamed, added, or emptied (an
    /// empty field is left out). Nothing changes if no name is left.
    fn commit_names(&mut self) {
        let mut personas = Vec::new();
        for (index, field) in self.names.iter().enumerate() {
            let Some(name) = crate::assistant::config::valid_name(field.text.trim()) else {
                continue;
            };
            if personas
                .iter()
                .any(|p: &Persona| p.name.eq_ignore_ascii_case(&name))
            {
                continue;
            }
            let persona = match self.view.personas.get(index) {
                Some(old) => old.renamed(&name),
                None => Persona::new(&name, &self.view.personas[0].voice, None),
            };
            personas.push(persona);
        }
        if !personas.is_empty() && personas != self.view.personas {
            self.view.personas = personas.clone();
            self.act(UiAction::SetPersonas(personas));
        }
    }

    /// Saves one persona's wake settings: what its phrases field says
    /// (empty: "hey <name>" again), and `edit` for its switches.
    fn commit_wake(&mut self, index: usize, edit: impl FnOnce(&mut Persona)) {
        let Some(old) = self.view.personas.get(index) else {
            return;
        };
        let mut persona = old.clone();
        let typed = self.phrases.get(index).map(|f| f.text.clone()).unwrap_or_default();
        let mut list: Vec<String> = Vec::new();
        for phrase in typed.split([',', ';']).filter_map(crate::assistant::config::valid_phrase) {
            if !list.iter().any(|x| x.eq_ignore_ascii_case(&phrase)) {
                list.push(phrase);
            }
        }
        let default = vec![format!("hey {}", persona.name)];
        persona.wake_phrases = (!list.is_empty() && list != default).then_some(list);
        edit(&mut persona);
        if persona != *old {
            let mut personas = self.view.personas.clone();
            personas[index] = persona;
            self.phrases = phrase_fields(&personas);
            self.view.personas = personas.clone();
            self.act(UiAction::SetPersonas(personas));
        } else {
            self.phrases = phrase_fields(&self.view.personas);
        }
    }

    fn remove_persona(&mut self, index: usize) {
        if self.view.personas.len() <= 1 || index >= self.view.personas.len() {
            return;
        }
        let mut personas = self.view.personas.clone();
        personas.remove(index);
        self.names = fields(&personas);
        self.phrases = phrase_fields(&personas);
        self.view.personas = personas.clone();
        self.act(UiAction::SetPersonas(personas));
    }

    /// Opens the personality editor on the prompt as it is now, or closes it.
    fn toggle_prompt(&mut self) {
        self.prompt = match self.prompt.take() {
            Some(_) => None,
            None => Some(PromptEditor::new(if self.actions.is_some() {
                crate::assistant::personality::load()
            } else {
                FIXTURE_PROMPT.to_owned()
            })),
        };
    }

    /// Saves the editor's text; Core applies it from her next turn.
    fn save_prompt(&mut self) {
        let live = self.actions.is_some();
        let name = self.view.name.clone();
        let Some(editor) = &mut self.prompt else {
            return;
        };
        let text = editor.edit.text.clone();
        let saved = if live {
            crate::assistant::personality::save(&text)
        } else {
            Ok(())
        };
        editor.note = Some(match saved {
            Ok(()) => {
                editor.saved = text;
                format!("Saved \u{00b7} {name} uses it from her next turn")
            }
            Err(error) => format!("Couldn't save: {error}"),
        });
    }

    /// Puts the stock personality back (the old one is backed up).
    fn default_prompt(&mut self) {
        let text = if self.actions.is_some() {
            crate::assistant::personality::default_text()
        } else {
            FIXTURE_PROMPT.to_owned()
        };
        if let Some(editor) = &mut self.prompt {
            editor.edit = TextEdit::new(text);
        }
        self.save_prompt();
    }

    fn toggle(&mut self, menu: Open) {
        self.open = if self.open == Some(menu) {
            None
        } else {
            Some(menu)
        };
    }
}

/// A name field per persona.
fn fields(personas: &[Persona]) -> Vec<TextEdit> {
    personas
        .iter()
        .map(|p| TextEdit::new(p.name.clone()))
        .collect()
}

/// A wake-phrases field per persona: its phrases, comma separated.
fn phrase_fields(personas: &[Persona]) -> Vec<TextEdit> {
    personas
        .iter()
        .map(|p| TextEdit::new(p.phrases().join(", ")))
        .collect()
}

/// The stock prompt, for renders and scenes.
const FIXTURE_PROMPT: &str = include_str!("../../../assistant/core/prompts/system.md");

/// Realistic content for renders and scenes.
pub(crate) fn fixture_view() -> SettingsView {
    SettingsView {
        status: Status {
            tone: Tone::Ready,
            title: "Listening".into(),
            detail: "Say \u{201c}hey Vera\u{201d} to start \u{00b7} Ctrl+Alt+Space stops her talking"
                .into(),
        },
        name: crate::assistant::config::DEFAULT_NAME.into(),
        personas: {
            let mut list =
                crate::assistant::config::default_personas(crate::assistant::config::DEFAULT_NAME);
            // Show each state: Jarvis answers to his name alone too, Tony is off.
            list[2].bare_name = true;
            list[2].wake_phrases = Some(vec!["hey Jarvis".into(), "okay Jarvis".into()]);
            list[6].enabled = false;
            list
        },
        muted: false,
        microphones: vec![
            "Microphone (Shure MV7+)".into(),
            "Headset Microphone (Jabra Evolve2 65)".into(),
            "Microphone Array (Realtek(R) Audio)".into(),
        ],
        microphone: Some("Microphone (Shure MV7+)".into()),
        microphone_note: Some(super::MicrophoneNote {
            text: "Hearing Microphone (Shure MV7+)".into(),
        }),
        volume: crate::assistant::config::DEFAULT_VOLUME,
        voices: vec![
            ("isla".into(), "Isla".into()),
            ("nora".into(), "Nora".into()),
            ("june".into(), "June".into()),
            ("eli".into(), "Eli".into()),
        ],
        voice: Some("isla".into()),
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
        updates: super::UpdatesView {
            current: "2.0.0 \u{00b7} Nightly 1a2b3c4".into(),
            channel: Channel::Nightly,
            line: "Up to date \u{00b7} checked 2 min ago".into(),
            ..super::UpdatesView::default()
        },
    }
}

fn spec() -> AppSpec<AssistantUi> {
    AppSpec {
        title: "Assistant",
        size: SIZE,
        min_size: Some((520.0, 460.0)),
        init: AssistantUi::fixture,
        view,
        scenes: SCENES,
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        setup: None,
        poll: None,
        on_key: None,
    }
}

/// A named state for renders: it changes the fixture.
type Scene = (&'static str, fn(&mut AssistantUi));

pub(crate) const SCENES: &[Scene] = &[
    ("settings", |_| {}),
    ("settings-muted", |ui| {
        ui.view.muted = true;
        ui.view.status = Status {
            tone: Tone::Quiet,
            title: "Not listening".into(),
            detail: "Vera is off: nothing wakes her. Turn Listening back on from the tray".into(),
        };
    }),
    ("settings-voice-menu", |ui| ui.open = Some(Open::Voice)),
    ("settings-update", |ui| {
        ui.view.updates.line = "Nightly 9f8e7d6 is available (2026-11-26) \u{00b7} 128 MB".into();
        ui.view.updates.button = Some(("Update".into(), UpdateButton::Install));
        ui.view.updates.notes = vec![
            "Settings: Updates, with Stable and Nightly".into(),
            "Barge-in: no duck when it can't be her echo".into(),
        ];
    }),
    ("settings-update-stable", |ui| {
        ui.view.updates.channel = Channel::Stable;
        ui.view.updates.line = "Stable 2.0.0 is available (2026-11-20) \u{00b7} 126 MB".into();
        ui.view.updates.button = Some(("Switch to Stable 2.0.0".into(), UpdateButton::Install));
    }),
    ("settings-update-downloading", |ui| {
        ui.view.updates.line = "Downloading Nightly 9f8e7d6 \u{00b7} 45% of 128 MB".into();
        ui.view.updates.button = None;
        ui.view.updates.progress = Some(0.45);
    }),
    ("settings-personality", |ui| ui.toggle_prompt()),
    ("settings-problem", |ui| {
        ui.view.status = Status {
            tone: Tone::Problem,
            title: "Voice service stopped".into(),
            detail: "Starting it again · it exited with code 1".into(),
        };
        ui.view.microphone = None;
        ui.view.microphone_note = Some(super::MicrophoneNote {
            text: "Headset Microphone (CORSAIR HS80) has sent no sound yet. If Vera can't hear \
                you, check it isn't muted"
                .into(),
        });
        ui.view.recent.clear();
    }),
];

/// The live window, reporting to `actions`.
pub(crate) fn app(actions: std::sync::mpsc::Sender<UiAction>) -> rune::App<AssistantUi> {
    rune::App::new(spec())
        .init(move || AssistantUi::live(actions))
        .on_close(|ui: &mut AssistantUi, _| {
            ui.open = None;
            ui.commit_names();
        })
}

pub(crate) fn view(ui: &AssistantUi, cx: &mut Cx<AssistantUi>) -> El {
    let dark = cx.system_dark();
    let p = Paint::new(dark, cx.env().scale);
    crate::windows::rune::match_title_bar(p.k.c.bg_deep, dark, dark);
    let mut layer = Vec::new();
    let content = page("assistant-settings")
        .pt(4.0)
        .pb(METRICS.section_gap)
        .child(section(
            p,
            "assistant",
            "Assistant",
            persona_rows(ui, p, &mut layer),
        ))
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
            vec![login_row(ui, p), personality_row(ui, p), hotkey_row(ui, p)],
        ))
        .child(section(p, "updates", "Updates", update_rows(ui, p)))
        .children(personality_editor(ui, p))
        .children(recent(ui, p))
        .child(footer(ui, p));
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
                    text("Settings")
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

fn status(ui: &AssistantUi, p: Paint) -> El {
    let Status {
        tone,
        title,
        detail,
    } = &ui.view.status;
    let dot = match tone {
        Tone::Ready => super::super::controls::pulsing_dot(p.success()),
        Tone::Quiet => status_dot(p.muted()),
        Tone::Problem => status_dot(p.danger()),
    };
    let muted = ui.view.muted;
    let action = Button::new(if muted { "Listen" } else { "Stop listening" })
        .variant(if muted {
            ButtonVariant::Contrast
        } else {
            ButtonVariant::Neutral
        })
        .on_press_tx(move |ui: &mut AssistantUi, _: &mut Tx| {
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
        .on_press(move |ui: &mut AssistantUi| ui.toggle(menu))
        .label(name)
        .a11y_value(label);
    let mut built = Menu::new(key)
        .trigger(trigger)
        .placement(Placement::BottomEnd)
        .gutter(4.0)
        .min_width(SELECT_WIDTH)
        .open(open)
        .on_close(|ui: &mut AssistantUi| ui.open = None);
    for (label, selected, action) in choices {
        built = built.item(MenuItem::new(label).checked(selected).on_select(
            move |ui: &mut AssistantUi| {
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

fn microphone_row(ui: &AssistantUi, p: Paint, layer: &mut Vec<El>) -> El {
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
    let note = ui.view.microphone_note.as_ref().map(|note| {
        // Silence is a hint, never an error: always the muted grey.
        (note.text.clone(), p.muted())
    });
    icon_described_row(
        p,
        "microphone",
        &icons::MIC,
        "Microphone",
        note,
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

fn wake_row(ui: &AssistantUi, p: Paint) -> El {
    let selected = Wake::ALL
        .iter()
        .position(|wake| *wake == ui.view.wake)
        .unwrap_or(1);
    let control = SegmentedControl::new(&["Strict", "Normal", "Relaxed"], Some(selected))
        .fit()
        .on_pick(|ui: &mut AssistantUi, index: usize, _: &mut Tx| {
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
        Some(&format!(
            "How close to \u{201c}{}\u{201d} counts",
            ui.view.name
        )),
        control,
    )
}

/// Her names: a line saying what they're for, then a row per persona (the
/// name, Enter applies it; its voice; remove), then Add.
fn persona_rows(ui: &AssistantUi, p: Paint, layer: &mut Vec<El>) -> Vec<El> {
    let mut rows = vec![
        col()
            .key("names-intro")
            .px(METRICS.row_px)
            .py(10.0)
            .gap(2.0)
            .child(text("Names").key("title").font(p.k.ty.ui).color(p.text()))
            .child(
                text("Each name wakes to its phrases and answers in its own voice. Name alone lets just the name wake it too")
                    .key("description")
                    .font(DESCRIPTION)
                    .color(p.muted()),
            ),
    ];
    let removable = ui.view.personas.len() > 1;
    for (index, field) in ui.names.iter().enumerate() {
        let typed = field.text.trim();
        let invalid = !typed.is_empty() && crate::assistant::config::valid_name(typed).is_none();
        let name = TextInput::new(field)
            .placeholder("Name")
            .label("Name")
            .width(Some(150.0))
            .invalid(invalid)
            .on_edit(move |ui: &mut AssistantUi| &mut ui.names[index])
            .on_submit(|ui: &mut AssistantUi, _: &mut Tx| ui.commit_names())
            .build(p.k)
            .key(format!("name-{index}"));
        let voice = ui
            .view
            .personas
            .get(index)
            .map(|persona| persona.voice.clone())
            .unwrap_or_default();
        let label = ui
            .view
            .voices
            .iter()
            .find(|(id, _)| *id == voice)
            .map_or_else(|| voice.clone(), |(_, name)| name.clone());
        let choices: Vec<(String, bool, UiAction)> = ui
            .view
            .voices
            .iter()
            .map(|(id, name)| {
                (
                    name.clone(),
                    *id == voice,
                    UiAction::SetPersonaVoice {
                        index,
                        voice: id.clone(),
                    },
                )
            })
            .collect();
        let picker = select(
            p,
            &format!("persona-voice-{index}"),
            "Voice",
            &label,
            ui.open == Some(Open::Persona(index)),
            Open::Persona(index),
            choices,
            layer,
        );
        let remove = rune_kit::IconButton::new(&rune_theme_opencode::icons::CLOSE)
            .variant(rune_kit::IconButtonVariant::Ghost)
            .label("Remove")
            .disabled(!removable || index >= ui.view.personas.len())
            .on_press(move |ui: &mut AssistantUi| ui.remove_persona(index))
            .build(p.k)
            .key(format!("remove-{index}"));
        let saved = ui.view.personas.get(index);
        let on = saved.is_some_and(|p| p.enabled);
        let toggle = pressable_row(
            el().key(format!("enabled-{index}"))
                .label(&format!("{} on", field.text.trim()))
                .child(row_switch(p, on)),
            on,
        )
        .disabled(saved.is_none())
        .on_press(move |ui: &mut AssistantUi| ui.commit_wake(index, |p| p.enabled = !on));
        rows.push(
            row()
                .key(format!("persona-{index}"))
                .px(METRICS.row_px)
                .pt(8.0)
                .pb(if saved.is_some() { 2.0 } else { 8.0 })
                .gap(8.0)
                .center_y()
                .child(toggle)
                .child(name)
                .child(el().grow(1.0))
                .child(picker)
                .child(remove),
        );
        if let Some(persona) = saved {
            let bare = persona.bare_name;
            let phrases = TextInput::new(&ui.phrases[index])
                .placeholder(&format!("hey {}", persona.name))
                .label("Wake phrases")
                .on_edit(move |ui: &mut AssistantUi| &mut ui.phrases[index])
                .on_submit(move |ui: &mut AssistantUi, _: &mut Tx| ui.commit_wake(index, |_| {}))
                .build(p.k)
                .key(format!("phrases-{index}"))
                .grow(1.0)
                .shrink();
            let alone = pressable_row(
                row()
                    .key(format!("bare-{index}"))
                    .gap(6.0)
                    .center_y()
                    .label("Name alone")
                    .child(text("Name alone").key("title").font(DESCRIPTION).color(p.muted()))
                    .child(row_switch(p, bare)),
                bare,
            )
            .on_press(move |ui: &mut AssistantUi| ui.commit_wake(index, |p| p.bare_name = !bare));
            rows.push(
                row()
                    .key(format!("wake-{index}"))
                    .px(METRICS.row_px)
                    .pl(METRICS.row_px + 44.0)
                    .pb(8.0)
                    .gap(12.0)
                    .center_y()
                    .opacity(if on { 1.0 } else { 0.5 })
                    .child(phrases)
                    .child(alone),
            );
        }
    }
    let adding = ui.names.len() > ui.view.personas.len();
    rows.push(
        row()
            .key("names-add")
            .px(METRICS.row_px)
            .py(8.0)
            .center_y()
            .child(
                text(if adding {
                    "Type the new name and press Enter"
                } else {
                    "Names apply when you press Enter"
                })
                .key("names-hint")
                .font(DESCRIPTION)
                .color(p.muted())
                .grow(1.0)
                .shrink(),
            )
            .child(
                Button::new("Add name")
                    .variant(ButtonVariant::Neutral)
                    .disabled(adding)
                    .on_press_tx(|ui: &mut AssistantUi, _: &mut Tx| {
                        ui.names.push(TextEdit::new(""))
                    })
                    .build_push(p.k)
                    .key("add-name"),
            ),
    );
    rows
}

fn voice_row(ui: &AssistantUi, p: Paint, layer: &mut Vec<El>) -> El {
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
        .map_or_else(|| "Each name's own".to_string(), name_of);
    let mut choices: Vec<(String, bool, UiAction)> = vec![(
        "Each name's own".to_string(),
        current.is_none(),
        UiAction::SetVoice(None),
    )];
    choices.extend(ui.view.voices.iter().map(|(id, name)| {
        (
            name.clone(),
            current.as_deref() == Some(id.as_str()),
            UiAction::SetVoice(Some(id.clone())),
        )
    }));
    icon_row(
        p,
        "voice-row",
        &icons::SPEAKER,
        "Voice",
        Some("One voice for every name, or each its own"),
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

fn volume_row(ui: &AssistantUi, p: Paint) -> El {
    let volume = ui.volume_drag.unwrap_or(ui.view.volume);
    icon_row(
        p,
        "volume-row",
        &icons::VOLUME,
        "Volume",
        Some(&format!("{}'s own, never the system's", ui.view.name)),
        lists::inline_slider_in(
            p,
            "volume",
            "Volume",
            volume,
            format!("{:.0}%", volume * 100.0),
            160.0,
            |ui: &mut AssistantUi, level: f32, done: bool| {
                ui.volume_drag = if done { None } else { Some(level) };
                if done {
                    ui.view.volume = level;
                }
                ui.act(UiAction::SetVolume { level, done });
            },
        ),
    )
}

fn brain_row(ui: &AssistantUi, p: Paint) -> El {
    let selected = usize::from(ui.view.brain == Brain::Codex);
    let control = SegmentedControl::new(&["Claude Code", "Codex"], Some(selected))
        .fit()
        .on_pick(|ui: &mut AssistantUi, index: usize, _: &mut Tx| {
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
        "Agent",
        Some("Decides what to do and hands work off"),
        control,
    )
}

fn model_row(ui: &AssistantUi, p: Paint, layer: &mut Vec<El>) -> El {
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
            (model_label(&model), selected, UiAction::SetModel(model))
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
            &model_label(&current),
            ui.open == Some(Open::Model),
            Open::Model,
            choices,
            layer,
        ),
    )
}

/// Claude Code's model aliases read as names; other ids stay as written.
fn model_label(model: &str) -> String {
    match model {
        "sonnet" => "Sonnet".into(),
        "opus" => "Opus".into(),
        "haiku" => "Haiku".into(),
        other => other.into(),
    }
}

fn login_row(ui: &AssistantUi, p: Paint) -> El {
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
    .on_press(move |ui: &mut AssistantUi| {
        ui.view.start_at_login = !on;
        ui.act(UiAction::SetStartAtLogin(!on));
    })
}

fn personality_row(ui: &AssistantUi, p: Paint) -> El {
    let open = ui.prompt.is_some();
    icon_row(
        p,
        "personality",
        &icons::PEN,
        "Personality",
        Some(&format!(
            "How {} talks and behaves: her system prompt",
            ui.view.name
        )),
        Button::new(if open { "Close" } else { "Edit\u{2026}" })
            .variant(ButtonVariant::Neutral)
            .on_press_tx(|ui: &mut AssistantUi, _: &mut Tx| ui.toggle_prompt())
            .build_push(p.k)
            .key("edit-personality"),
    )
}

/// The personality editor, under General while it's open.
fn personality_editor(ui: &AssistantUi, p: Paint) -> Option<El> {
    let editor = ui.prompt.as_ref()?;
    let dirty = editor.dirty();
    let note = if dirty {
        "Unsaved changes".to_string()
    } else {
        editor.note.clone().unwrap_or_else(|| {
            format!(
                "{{{{name}}}} is her name ({}). Saved changes apply from her next turn",
                ui.view.name
            )
        })
    };
    let body = col()
        .key("personality-body")
        .px(METRICS.row_px)
        .py(10.0)
        .gap(10.0)
        .child(
            TextArea::new(&editor.edit)
                .placeholder("Who she is, how she talks, what she does")
                .rows(12)
                .width(None)
                .on_edit(|ui: &mut AssistantUi| {
                    &mut ui.prompt.as_mut().expect("the editor is open").edit
                })
                .build(p.k)
                .key("prompt"),
        )
        .child(
            row()
                .key("personality-actions")
                .gap(8.0)
                .center_y()
                .child(
                    text(note)
                        .key("personality-note")
                        .font(DESCRIPTION)
                        .color(p.muted())
                        .grow(1.0)
                        .shrink(),
                )
                .child(
                    Button::new("Revert to default")
                        .variant(ButtonVariant::Neutral)
                        .on_press_tx(|ui: &mut AssistantUi, _: &mut Tx| ui.default_prompt())
                        .build_push(p.k)
                        .key("prompt-default"),
                )
                .child(
                    Button::new("Save")
                        .variant(ButtonVariant::Submit)
                        .disabled(!dirty)
                        .on_press_tx(|ui: &mut AssistantUi, _: &mut Tx| ui.save_prompt())
                        .build_push(p.k)
                        .key("prompt-save"),
                ),
        );
    Some(section(p, "personality-editor", "Personality", vec![body]))
}

fn hotkey_row(ui: &AssistantUi, p: Paint) -> El {
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

fn recent(ui: &AssistantUi, p: Paint) -> Option<El> {
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
                .py(8.0)
                .gap(12.0)
                .child(
                    text(if item.you {
                        "You".to_string()
                    } else {
                        ui.view.name.clone()
                    })
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

/// Updates: this build and the channel to follow, then what the channel
/// offers and the one button for it, then what's new.
fn update_rows(ui: &AssistantUi, p: Paint) -> Vec<El> {
    let updates = &ui.view.updates;
    let selected = usize::from(updates.channel == Channel::Nightly);
    let channel = SegmentedControl::new(&["Stable", "Nightly"], Some(selected))
        .fit()
        .on_pick(|ui: &mut AssistantUi, index: usize, _: &mut Tx| {
            let channel = if index == 1 {
                Channel::Nightly
            } else {
                Channel::Stable
            };
            if channel != ui.view.updates.channel {
                ui.view.updates.channel = channel;
                ui.act(UiAction::SetUpdateChannel(channel));
            }
        })
        .build(p.k)
        .key("update-channel")
        .role("segmented");
    let mut rows = vec![icon_row(
        p,
        "version-row",
        &icons::PANEL,
        "Version",
        Some(&updates.current),
        channel,
    )];
    let control = match &updates.button {
        Some((label, button)) => {
            let button = *button;
            Button::new(label.clone())
                .variant(match button {
                    UpdateButton::Install => ButtonVariant::Submit,
                    UpdateButton::Check => ButtonVariant::Neutral,
                })
                .on_press_tx(move |ui: &mut AssistantUi, _: &mut Tx| {
                    ui.view.updates.button = None;
                    ui.act(match button {
                        UpdateButton::Install => UiAction::InstallUpdate,
                        UpdateButton::Check => UiAction::CheckForUpdates,
                    });
                })
                .build_push(p.k)
                .key("update-action")
        }
        None => text(
            updates
                .progress
                .map_or_else(String::new, |done| format!("{:.0}%", done * 100.0)),
        )
        .key("update-progress")
        .font(p.meta())
        .color(p.muted()),
    };
    let color = if updates.problem {
        p.danger()
    } else {
        p.muted()
    };
    rows.push(icon_described_row(
        p,
        "update-row",
        &icons::REFRESH,
        "Updates",
        Some((updates.line.clone(), color)),
        control,
    ));
    if !updates.notes.is_empty() {
        let lines = updates.notes.iter().enumerate().map(|(i, line)| {
            text(format!("\u{2022} {line}"))
                .key(format!("note-{i}"))
                .font(DESCRIPTION)
                .color(p.muted())
                .wrap()
        });
        rows.push(
            col()
                .key("update-notes")
                .px(METRICS.row_px)
                .py(8.0)
                .gap(3.0)
                .child(
                    text("What's new")
                        .key("notes-title")
                        .font(p.meta())
                        .color(p.faint()),
                )
                .children(lines),
        );
    }
    rows
}

fn footer(ui: &AssistantUi, p: Paint) -> El {
    row()
        .key("footer")
        .px(METRICS.row_px)
        .pt(4.0)
        .center_y()
        .justify_between()
        .child(
            text(format!(
                "Assistant {}",
                crate::assistant::update::stamp::describe()
            ))
            .key("version")
            .font(p.meta())
            .color(p.faint()),
        )
        .child(
            el().key("quit")
                .role("button")
                .label(format!("Quit {}", ui.view.name))
                .focusable(true)
                .px(6.0)
                .py(2.0)
                .radius(p.k.radius.sm)
                .hover(p.k.c.hover)
                .press(p.k.c.pressed)
                .on_press(|ui: &mut AssistantUi| ui.act(UiAction::Quit))
                .child(
                    text(format!("Quit {}", ui.view.name))
                        .key("label")
                        .font(p.meta())
                        .color(p.muted())
                        .a11y_hidden(),
                ),
        )
}
