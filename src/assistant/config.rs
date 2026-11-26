//! What the app reads from and writes to `~/.assistant/config.json`, the file it
//! shares with Core. The app owns the `app` object; from Settings it also
//! writes `brain.harness`, the chosen harness's `model`, and
//! `wake.sensitivity`, then tells Core `settings_changed`. Every save reads
//! the file again and changes only those keys, so Core's own keys survive.
//!
//! ```json
//! "app": {
//!   "listening": true, "microphone": null, "volume": 0.7, "voice": null,
//!   "startAtLogin": true, "stopHotkey": "Ctrl+Alt+Space", "hud": "bottom",
//!   "repo": null,
//!   "core": { "command": null, "entry": "assistant/core/src/main.ts", "args": ["--stdio"] },
//!   "voiceService": { "command": null, "cwd": null, "port": 7314 },
//!   "updates": { "channel": null, "check": true, "trayBadge": true, "repo": "bentsignal/assistant" }
//! }
//! ```

use std::path::{Path, PathBuf};

use color_eyre::Result;
use color_eyre::eyre::WrapErr;
use serde_json::{Map, Value, json};

/// Vera's own output volume until she's told otherwise (the audio engine's
/// scale: each 0.1 is 4 dB, 0.7 is -12 dB under the voice service, roughly
/// half as loud as v1, which was far too loud).
pub(crate) const DEFAULT_VOLUME: f32 = crate::assistant::audio::DEFAULT_VOLUME;
pub(crate) const DEFAULT_STOP_HOTKEY: &str = "Ctrl+Alt+Space";
pub(crate) const DEFAULT_VOICE_PORT: u16 = 7314;
/// What the assistant is called (`assistant.name`): her wake word, how she
/// refers to herself, and what the tray and Settings call her.
pub(crate) const DEFAULT_NAME: &str = "Vera";

/// A name the assistant can go by: one word of letters (an apostrophe or a
/// hyphen inside is fine), 2 to 20 of them, as typed but trimmed and with a
/// capital first letter. `None` for anything else.
pub(crate) fn valid_name(name: &str) -> Option<String> {
    let name = name
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\u{201c}' || c == '\u{201d}');
    let letters = name.chars().filter(|c| c.is_alphabetic()).count();
    let ok = (2..=20).contains(&letters)
        && name
            .chars()
            .all(|c| c.is_alphabetic() || c == '\'' || c == '-')
        && name.chars().next().is_some_and(char::is_alphabetic)
        && name.chars().last().is_some_and(char::is_alphabetic);
    if !ok {
        return None;
    }
    let mut chars = name.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().chain(chars).collect())
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum Brain {
    #[default]
    ClaudeCode,
    Codex,
}

impl Brain {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    fn parse(key: &str) -> Self {
        match key {
            "codex" => Self::Codex,
            _ => Self::ClaudeCode,
        }
    }

    /// The models Settings offers for this harness, besides the saved one.
    pub(crate) fn models(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["sonnet", "opus", "haiku"],
            Self::Codex => &["gpt-6.2-sol", "gpt-6.2", "gpt-6.2-mini"],
        }
    }
}

/// How readily a near miss of "Vera" wakes her (Core's `wake.sensitivity`).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum Wake {
    Strict,
    #[default]
    Normal,
    Relaxed,
}

impl Wake {
    pub(crate) const ALL: [Self; 3] = [Self::Strict, Self::Normal, Self::Relaxed];

    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::Normal => "normal",
            Self::Relaxed => "relaxed",
        }
    }

    fn parse(key: &str) -> Self {
        match key {
            "strict" | "low" => Self::Strict,
            "relaxed" | "high" => Self::Relaxed,
            _ => Self::Normal,
        }
    }
}

/// `app.updates`: which channel to follow (`None`: the build's own), whether
/// to check by itself (at launch and every few hours), and whether an
/// available update puts a quiet dot on the tray icon.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Updates {
    pub(crate) channel: Option<crate::assistant::update::Channel>,
    pub(crate) check: bool,
    pub(crate) tray_badge: bool,
    pub(crate) repo: String,
}

impl Default for Updates {
    fn default() -> Self {
        Self {
            channel: None,
            check: true,
            tray_badge: true,
            repo: crate::assistant::update::feed::DEFAULT_REPO.into(),
        }
    }
}

/// How to start a child: an explicit argv, else found in the repo.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Launch {
    pub(crate) command: Option<Vec<String>>,
    pub(crate) cwd: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Config {
    /// The tray's Listening switch (`app.listening`, on unless he turned it
    /// off): off, the microphone wakes nothing and she says nothing.
    pub(crate) listening: bool,
    /// A microphone by name; `None` follows the system default.
    pub(crate) microphone: Option<String>,
    pub(crate) volume: f32,
    pub(crate) voice: Option<String>,
    /// `None` until chosen: on, but a build under `target\` doesn't register
    /// itself unasked.
    pub(crate) start_at_login: Option<bool>,
    pub(crate) stop_hotkey: String,
    /// The HUD sits at the bottom edge, clear of Hex's at the top.
    pub(crate) hud_bottom: bool,
    pub(crate) repo: Option<PathBuf>,
    pub(crate) core: Launch,
    pub(crate) core_entry: String,
    pub(crate) core_args: Vec<String>,
    pub(crate) voice_service: Launch,
    pub(crate) voice_port: u16,
    pub(crate) brain: Brain,
    pub(crate) model: Option<String>,
    pub(crate) wake: Wake,
    /// The assistant's name (`assistant.name`): the first persona's.
    pub(crate) name: String,
    /// Her names, each with its own voice (`assistant.personas`). Any of
    /// them wakes her; the reply speaks in the waking one's voice.
    pub(crate) personas: Vec<Persona>,
    /// `assistant.personas` was in the file (else `personas` are defaults).
    pub(crate) has_personas: bool,
    pub(crate) updates: Updates,
    /// How long a pause ends his turn (`turn.finishedMs`, `pauseMs`,
    /// `unfinishedMs`, `maxMs`; Core reads the same section).
    pub(crate) turn: crate::assistant_ears::patience::Patience,
}

/// One of her names and the voice it speaks in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Persona {
    pub(crate) name: String,
    pub(crate) voice: String,
    pub(crate) style: Option<String>,
}

impl Persona {
    fn new(name: &str, voice: &str, style: Option<&str>) -> Self {
        Self {
            name: name.into(),
            voice: voice.into(),
            style: style.map(str::to_owned),
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        let mut value = json!({ "name": self.name, "voice": self.voice });
        if let Some(style) = &self.style {
            value["style"] = json!(style);
        }
        value
    }
}

/// The personas a config without `assistant.personas` starts with: her
/// current name (Vera, with Isla's voice), then the stock ones.
pub(crate) fn default_personas(name: &str) -> Vec<Persona> {
    let mut list = vec![Persona::new(name, "isla", None)];
    for (name, voice, style) in [
        ("Alfred", "alfred", "a dry, courteous English butler"),
        (
            "Jarvis",
            "jarvis",
            "a crisp, unflappable AI aide with polite wit",
        ),
        ("Optimus", "optimus", "a calm, noble commander of few words"),
        ("Buzz", "buzz", "an earnest, upbeat space ranger"),
        ("Saul", "saul", "a quick, persuasive fixer with a wink"),
        (
            "Tony",
            "tony",
            "a quick, confident inventor with a wry edge",
        ),
    ] {
        if !list.iter().any(|p| p.name.eq_ignore_ascii_case(name)) {
            list.push(Persona::new(name, voice, Some(style)));
        }
    }
    list
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listening: true,
            microphone: None,
            volume: DEFAULT_VOLUME,
            voice: None,
            start_at_login: None,
            stop_hotkey: DEFAULT_STOP_HOTKEY.into(),
            hud_bottom: true,
            repo: None,
            core: Launch::default(),
            core_entry: "assistant/core/src/main.ts".into(),
            core_args: vec!["--stdio".into()],
            voice_service: Launch::default(),
            voice_port: DEFAULT_VOICE_PORT,
            brain: Brain::default(),
            model: None,
            wake: Wake::default(),
            name: DEFAULT_NAME.into(),
            personas: default_personas(DEFAULT_NAME),
            has_personas: false,
            updates: Updates::default(),
            turn: crate::assistant_ears::patience::Patience::default(),
        }
    }
}

fn read(path: &Path) -> Value {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
            tracing::warn!(%error, path = %path.display(), "config.json isn't valid JSON; using defaults");
            Value::Object(Map::new())
        }),
        Err(_) => Value::Object(Map::new()),
    }
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned).filter(|s| !s.is_empty())
}

fn argv(value: &Value) -> Option<Vec<String>> {
    let list: Vec<String> = value
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    (!list.is_empty()).then_some(list)
}

impl Config {
    pub(crate) fn load() -> Self {
        Self::from_value(&read(&super::paths::config_file()))
    }

    fn from_value(root: &Value) -> Self {
        let mut config = Self::default();
        let app = &root["app"];
        config.listening = app["listening"].as_bool().unwrap_or(true);
        config.microphone = string(&app["microphone"]);
        if let Some(volume) = app["volume"].as_f64() {
            config.volume = (volume as f32).clamp(0.0, 1.0);
        }
        config.voice = string(&app["voice"]);
        config.start_at_login = app["startAtLogin"].as_bool();
        if let Some(hotkey) = string(&app["stopHotkey"]) {
            config.stop_hotkey = hotkey;
        }
        config.hud_bottom = app["hud"].as_str() != Some("top");
        config.repo = string(&app["repo"]).map(PathBuf::from);
        config.core.command = argv(&app["core"]["command"]);
        config.core.cwd = string(&app["core"]["cwd"]).map(PathBuf::from);
        if let Some(entry) = string(&app["core"]["entry"]) {
            config.core_entry = entry;
        }
        if let Some(args) = app["core"]["args"].as_array() {
            config.core_args = args
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
        }
        config.voice_service.command = argv(&app["voiceService"]["command"]);
        config.voice_service.cwd = string(&app["voiceService"]["cwd"]).map(PathBuf::from);
        if let Some(port) = app["voiceService"]["port"].as_u64() {
            config.voice_port = u16::try_from(port).unwrap_or(DEFAULT_VOICE_PORT);
        }
        let updates = &app["updates"];
        config.updates.channel = updates["channel"]
            .as_str()
            .and_then(crate::assistant::update::Channel::parse);
        if let Some(check) = updates["check"].as_bool() {
            config.updates.check = check;
        }
        if let Some(badge) = updates["trayBadge"].as_bool() {
            config.updates.tray_badge = badge;
        }
        if let Some(repo) = string(&updates["repo"]).filter(|repo| repo.contains('/')) {
            config.updates.repo = repo;
        }
        let turn = &root["turn"];
        let ms = |key: &str, default: std::time::Duration| {
            turn[key]
                .as_u64()
                .map_or(default, std::time::Duration::from_millis)
        };
        config.turn = crate::assistant_ears::patience::Patience {
            finished: ms("finishedMs", config.turn.finished),
            pause: ms("pauseMs", config.turn.pause),
            unfinished: ms("unfinishedMs", config.turn.unfinished),
            max: ms("maxMs", config.turn.max),
        }
        .clamped();
        config.brain = Brain::parse(root["brain"]["harness"].as_str().unwrap_or_default());
        config.model = string(&root["brain"][config.brain.key()]["model"]);
        config.wake = Wake::parse(root["wake"]["sensitivity"].as_str().unwrap_or_default());
        if let Some(name) = root["assistant"]["name"].as_str() {
            match valid_name(name) {
                Some(name) => config.name = name,
                None => tracing::warn!(name, "assistant.name isn't a name; using {DEFAULT_NAME}"),
            }
        }
        let personas: Vec<Persona> = root["assistant"]["personas"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|p| {
                        let name = valid_name(p["name"].as_str()?)?;
                        let voice = string(&p["voice"]).unwrap_or_else(|| "isla".into());
                        Some(Persona {
                            name,
                            voice,
                            style: string(&p["style"]),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if personas.is_empty() {
            config.personas = default_personas(&config.name);
        } else {
            config.has_personas = true;
            config.name = personas[0].name.clone();
            config.personas = personas;
        }
        config
    }

    /// The voice service's base URL.
    pub(crate) fn voice_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.voice_port)
    }

    /// The repo with `assistant/core` in it: the configured one, `$ASSISTANT_REPO`, or
    /// the first folder above this executable that has it.
    pub(crate) fn repo(&self) -> Option<PathBuf> {
        let has_core = |dir: &Path| {
            dir.join("assistant")
                .join("core")
                .join("package.json")
                .is_file()
        };
        if let Some(repo) = &self.repo {
            return Some(repo.clone());
        }
        if let Some(repo) = std::env::var_os("ASSISTANT_REPO").map(PathBuf::from)
            && has_core(&repo)
        {
            return Some(repo);
        }
        let exe = std::env::current_exe().ok()?;
        exe.ancestors()
            .skip(1)
            .find(|dir| has_core(dir))
            .map(Path::to_path_buf)
    }
}

/// Reads config.json again, lets `edit` change it, and writes it whole and
/// atomically. Keys `edit` doesn't touch stay as they were.
pub(crate) fn save(edit: impl FnOnce(&mut Value)) -> Result<()> {
    let path = super::paths::config_file();
    let mut root = read(&path);
    if !root.is_object() {
        root = Value::Object(Map::new());
    }
    edit(&mut root);
    let text = serde_json::to_string_pretty(&root)? + "\n";
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::durable::write(&path, text.as_bytes())
        .wrap_err_with(|| format!("could not save {}", path.display()))
}

/// `root[a][b]…`, making objects on the way.
pub(crate) fn slot<'a>(root: &'a mut Value, keys: &[&str]) -> &'a mut Value {
    let mut value = root;
    for key in keys {
        if !value.is_object() {
            *value = json!({});
        }
        value = value
            .as_object_mut()
            .expect("made an object above")
            .entry(key.to_string())
            .or_insert(Value::Null);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personas_default_from_the_name_and_load_when_set() {
        let config = Config::from_value(&json!({ "assistant": { "name": "Nova" } }));
        assert!(!config.has_personas);
        assert_eq!(config.personas[0], Persona::new("Nova", "isla", None));
        assert_eq!(config.personas[1].voice, "alfred");
        assert_eq!(config.personas.len(), 7);
        let config = Config::from_value(&json!({ "assistant": { "name": "Vera", "personas": [
            { "name": "Max", "voice": "optimus" }, { "name": "not a name!", "voice": "x" },
            { "name": "Jarvis", "voice": "eli", "style": "crisp" } ] } }));
        assert!(config.has_personas);
        assert_eq!(config.name, "Max");
        assert_eq!(config.personas.len(), 2);
        assert_eq!(config.personas[1].style.as_deref(), Some("crisp"));
        assert_eq!(config.personas[1].to_json()["voice"], "eli");
    }

    #[test]
    fn reads_the_app_section_and_cores_keys() {
        let root = json!({
            "port": 7313,
            "brain": { "harness": "codex", "codex": { "model": "gpt-x" } },
            "wake": { "sensitivity": "relaxed" },
            "app": { "volume": 0.2, "microphone": "Headset", "hud": "top",
                     "voiceService": { "port": 9000, "command": ["py", "serve.py"] } }
        });
        let config = Config::from_value(&root);
        assert_eq!(config.brain, Brain::Codex);
        assert_eq!(config.model.as_deref(), Some("gpt-x"));
        assert_eq!(config.wake, Wake::Relaxed);
        assert_eq!(config.volume, 0.2);
        assert_eq!(config.microphone.as_deref(), Some("Headset"));
        assert!(!config.hud_bottom);
        assert!(config.listening);
        assert!(!Config::from_value(&json!({ "app": { "listening": false } })).listening);
        assert_eq!(config.voice_port, 9000);
        assert_eq!(config.voice_service.command.as_ref().unwrap().len(), 2);
        assert_eq!(Config::from_value(&json!({})), Config::default());
    }

    #[test]
    fn reads_the_update_settings() {
        use crate::assistant::update::Channel;
        let config = Config::from_value(&json!({ "app": { "updates": {
            "channel": "stable", "check": false, "trayBadge": false } } }));
        assert_eq!(config.updates.channel, Some(Channel::Stable));
        assert!(!config.updates.check && !config.updates.tray_badge);
        assert_eq!(config.updates.repo, "bentsignal/assistant");
        let config = Config::from_value(&json!({ "app": { "updates": { "channel": "beta" } } }));
        assert_eq!(config.updates.channel, None);
    }

    #[test]
    fn slot_keeps_siblings() {
        let mut root =
            json!({ "brain": { "harness": "claude-code", "codex": { "effort": "low" } } });
        *slot(&mut root, &["brain", "codex", "model"]) = json!("m");
        assert_eq!(root["brain"]["codex"]["effort"], "low");
        assert_eq!(root["brain"]["codex"]["model"], "m");
        assert_eq!(root["brain"]["harness"], "claude-code");
    }
}
