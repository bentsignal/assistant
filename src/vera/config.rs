//! What the app reads from and writes to `~/.vera/config.json`, the file it
//! shares with Core. The app owns the `app` object; from Settings it also
//! writes `brain.harness`, the chosen harness's `model`, and
//! `wake.sensitivity`, then tells Core `settings_changed`. Every save reads
//! the file again and changes only those keys, so Core's own keys survive.
//!
//! ```json
//! "app": {
//!   "microphone": null, "volume": 0.35, "voice": null,
//!   "startAtLogin": true, "stopHotkey": "Ctrl+Alt+Space", "hud": "bottom",
//!   "repo": null,
//!   "core": { "command": null, "entry": "vera/core/src/main.ts", "args": ["--stdio"] },
//!   "voiceService": { "command": null, "cwd": null, "port": 7314 }
//! }
//! ```

use std::path::{Path, PathBuf};

use color_eyre::Result;
use color_eyre::eyre::WrapErr;
use serde_json::{Map, Value, json};

/// Vera's own output gain until she's told otherwise: v1 was far too loud.
pub(crate) const DEFAULT_VOLUME: f32 = 0.35;
pub(crate) const DEFAULT_STOP_HOTKEY: &str = "Ctrl+Alt+Space";
pub(crate) const DEFAULT_VOICE_PORT: u16 = 7314;

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

/// How to start a child: an explicit argv, else found in the repo.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Launch {
    pub(crate) command: Option<Vec<String>>,
    pub(crate) cwd: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Config {
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
}

impl Default for Config {
    fn default() -> Self {
        Self {
            microphone: None,
            volume: DEFAULT_VOLUME,
            voice: None,
            start_at_login: None,
            stop_hotkey: DEFAULT_STOP_HOTKEY.into(),
            hud_bottom: true,
            repo: None,
            core: Launch::default(),
            core_entry: "vera/core/src/main.ts".into(),
            core_args: vec!["--stdio".into()],
            voice_service: Launch::default(),
            voice_port: DEFAULT_VOICE_PORT,
            brain: Brain::default(),
            model: None,
            wake: Wake::default(),
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
        config.brain = Brain::parse(root["brain"]["harness"].as_str().unwrap_or_default());
        config.model = string(&root["brain"][config.brain.key()]["model"]);
        config.wake = Wake::parse(root["wake"]["sensitivity"].as_str().unwrap_or_default());
        config
    }

    /// The voice service's base URL.
    pub(crate) fn voice_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.voice_port)
    }

    /// The repo with `vera/core` in it: the configured one, `$VERA_REPO`, or
    /// the first folder above this executable that has it.
    pub(crate) fn repo(&self) -> Option<PathBuf> {
        let has_core = |dir: &Path| dir.join("vera").join("core").join("package.json").is_file();
        if let Some(repo) = &self.repo {
            return Some(repo.clone());
        }
        if let Some(repo) = std::env::var_os("VERA_REPO").map(PathBuf::from)
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
        assert_eq!(config.voice_port, 9000);
        assert_eq!(config.voice_service.command.as_ref().unwrap().len(), 2);
        assert_eq!(Config::from_value(&json!({})), Config::default());
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
