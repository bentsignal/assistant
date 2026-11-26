//! The installed layout (docs/install.md) and the launcher that keeps it
//! safe to update:
//!
//! ```text
//! %LOCALAPPDATA%\Programs\Assistant\
//!   assistant.exe        the launcher: starts versions\<current>\assistant.exe
//!   install.json         {current, previous, pending, failed}
//!   versions\<label>\    one whole release each (assistant.exe, core, node, voice, tools)
//!   downloads\           releases being fetched
//! ```
//!
//! Nothing here touches `~/.assistant`. An update unpacks beside the running
//! version, switches `current`, and keeps the previous one until the new one
//! has started cleanly; a version that never gets there is rolled back
//! (`super::apply`), so there's always a version that works.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use color_eyre::Result;
use color_eyre::eyre::{WrapErr, eyre};
use serde::{Deserialize, Serialize};

pub(crate) const STATE_FILE: &str = "install.json";
pub(crate) const PACKAGE_FILE: &str = "assistant-package.json";
pub(crate) const VERSIONS: &str = "versions";
pub(crate) const EXE: &str = "assistant.exe";

/// Where this executable runs from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Layout {
    /// `<root>\versions\<label>\assistant.exe`: an installed version.
    Installed {
        root: PathBuf,
        label: String,
        dir: PathBuf,
    },
    /// `<root>\assistant.exe` with `install.json` beside it: the launcher.
    Launcher { root: PathBuf },
    /// An unpacked package anywhere else: it runs from itself, but nothing
    /// updates it.
    Package { dir: PathBuf },
    /// A cargo build (or anything else): Core and the voice come from the repo.
    Dev,
}

impl Layout {
    /// The folder with Core, Node, and the voice service in it.
    pub(crate) fn package_dir(&self) -> Option<&Path> {
        match self {
            Self::Installed { dir, .. } | Self::Package { dir } => Some(dir),
            _ => None,
        }
    }

    pub(crate) fn root(&self) -> Option<&Path> {
        match self {
            Self::Installed { root, .. } | Self::Launcher { root } => Some(root),
            _ => None,
        }
    }
}

pub(crate) fn detect_at(exe: &Path) -> Layout {
    let Some(dir) = exe.parent() else {
        return Layout::Dev;
    };
    if let (Some(versions), Some(label)) = (dir.parent(), dir.file_name())
        && versions
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case(VERSIONS))
        && let Some(root) = versions.parent()
        && root.join(STATE_FILE).is_file()
    {
        return Layout::Installed {
            root: root.to_path_buf(),
            label: label.to_string_lossy().into_owned(),
            dir: dir.to_path_buf(),
        };
    }
    if dir.join(STATE_FILE).is_file() && dir.join(VERSIONS).is_dir() {
        return Layout::Launcher {
            root: dir.to_path_buf(),
        };
    }
    if dir.join(PACKAGE_FILE).is_file() {
        return Layout::Package {
            dir: dir.to_path_buf(),
        };
    }
    Layout::Dev
}

/// This executable's layout, read once.
pub(crate) fn layout() -> &'static Layout {
    static LAYOUT: OnceLock<Layout> = OnceLock::new();
    LAYOUT.get_or_init(|| {
        std::env::current_exe()
            .map(|exe| detect_at(&exe))
            .unwrap_or(Layout::Dev)
    })
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// A version that was switched to but hasn't yet started cleanly.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Pending {
    pub(crate) label: String,
    /// The version it replaced (where a failure rolls back to).
    #[serde(default)]
    pub(crate) from: Option<String>,
    #[serde(default)]
    pub(crate) at: u64,
    /// Launches the launcher made of it without it confirming.
    #[serde(default)]
    pub(crate) attempts: u32,
}

/// The last version that failed to start and was rolled back.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Failure {
    pub(crate) label: String,
    pub(crate) reason: String,
    #[serde(default)]
    pub(crate) at: u64,
    /// The version rolled back to has said so (once, by voice).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) told: bool,
}

/// `install.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct State {
    #[serde(default = "schema")]
    pub(crate) schema: u32,
    pub(crate) current: String,
    #[serde(default)]
    pub(crate) previous: Option<String>,
    #[serde(default)]
    pub(crate) pending: Option<Pending>,
    #[serde(default)]
    pub(crate) failed: Option<Failure>,
}

fn schema() -> u32 {
    1
}

impl State {
    pub(crate) fn load(root: &Path) -> Result<Self> {
        let path = root.join(STATE_FILE);
        let text = std::fs::read_to_string(&path)
            .wrap_err_with(|| format!("could not read {}", path.display()))?;
        serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .wrap_err_with(|| format!("{} isn't valid", path.display()))
    }

    pub(crate) fn save(&self, root: &Path) -> Result<()> {
        let path = root.join(STATE_FILE);
        let text = serde_json::to_string_pretty(self)? + "\n";
        crate::durable::write(&path, text.as_bytes())
            .wrap_err_with(|| format!("could not write {}", path.display()))
    }

    /// Reads, changes, and writes `install.json` in one go.
    pub(crate) fn edit<T>(root: &Path, change: impl FnOnce(&mut Self) -> T) -> Result<T> {
        let mut state = Self::load(root)?;
        let result = change(&mut state);
        state.save(root)?;
        Ok(result)
    }
}

pub(crate) fn version_dir(root: &Path, label: &str) -> PathBuf {
    root.join(VERSIONS).join(label)
}

pub(crate) fn version_exe(root: &Path, label: &str) -> PathBuf {
    version_dir(root, label).join(EXE)
}

/// What a launcher run decides: the version to start, after any rollback
/// of a version that keeps failing to start.
pub(crate) fn choose(state: &mut State, root: &Path) -> Option<String> {
    if let Some(pending) = state.pending.as_mut()
        && pending.label == state.current
    {
        // Two launches of a version that never confirmed (the supervisor
        // that watches it didn't survive, say a restart): give up on it.
        if pending.attempts >= 2
            && let Some(from) = pending.from.clone()
            && version_exe(root, &from).is_file()
        {
            state.failed = Some(Failure {
                label: state.current.clone(),
                reason: "it didn't start cleanly twice".into(),
                at: now(),
                told: false,
            });
            state.current = from;
            state.pending = None;
        } else {
            pending.attempts += 1;
        }
    }
    if version_exe(root, &state.current).is_file() {
        return Some(state.current.clone());
    }
    // The current version's folder is gone: fall back on the previous one.
    let previous = state.previous.clone()?;
    version_exe(root, &previous).is_file().then(|| {
        state.failed = Some(Failure {
            label: state.current.clone(),
            reason: "its files are missing".into(),
            at: now(),
            told: false,
        });
        state.current = previous.clone();
        state.pending = None;
        previous
    })
}

/// The launcher (`<root>\assistant.exe`): starts the current version with
/// these arguments. The app itself is left running and the launcher exits at
/// once (so it never holds its own file); a command (`quit`, `update`, …) is
/// waited for and its exit code returned.
pub(crate) fn launch(root: &Path, args: Vec<OsString>) -> i32 {
    let mut state = match State::load(root) {
        Ok(state) => state,
        Err(error) => {
            note(&format!("launcher: {error:#}"));
            return 1;
        }
    };
    let Some(label) = choose(&mut state, root) else {
        note(&format!(
            "launcher: no runnable version in {}",
            root.display()
        ));
        return 1;
    };
    if let Err(error) = state.save(root) {
        note(&format!("launcher: {error:#}"));
    }
    let exe = version_exe(root, &label);
    // The app is `assistant` or `assistant --hidden`; anything else is a
    // command whose output and exit code matter.
    let app = args.iter().all(|arg| arg == "--hidden");
    let mut command = std::process::Command::new(&exe);
    command.args(&args).current_dir(version_dir(root, &label));
    if app {
        match command.spawn() {
            Ok(_) => 0,
            Err(error) => {
                note(&format!(
                    "launcher: could not start {}: {error}",
                    exe.display()
                ));
                1
            }
        }
    } else {
        match command.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!("assistant: could not start {}: {error}", exe.display());
                1
            }
        }
    }
}

/// A line in `~/.assistant/logs/updater.log` (the launcher and the update
/// supervisor run before, or without, the app's own log).
pub(crate) fn note(line: &str) {
    use std::io::Write;
    let dir = crate::assistant::paths::logs();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("updater.log");
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 2 * 1024 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{} [{}] {line}", now(), std::process::id());
    }
    tracing::info!(target: "updater", "{line}");
}

/// Copies this version's executable over the launcher. The launcher only
/// runs for a moment, so a busy file is retried briefly; a launcher left
/// older still starts the right version.
pub(crate) fn refresh_launcher(root: &Path, from: &Path) -> Result<()> {
    let target = root.join(EXE);
    let temp = root.join("assistant.exe.new");
    std::fs::copy(from, &temp).wrap_err("could not copy the launcher")?;
    let mut last = None;
    for _ in 0..20 {
        match std::fs::rename(&temp, &target) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
    }
    let _ = std::fs::remove_file(&temp);
    Err(eyre!(
        "could not replace {}: {}",
        target.display(),
        last.map_or_else(String::new, |error| error.to_string())
    ))
}

/// Removes version folders other than these and leftover downloads.
pub(crate) fn prune(root: &Path, keep: &[&str]) {
    if let Ok(entries) = std::fs::read_dir(root.join(VERSIONS)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if keep.iter().any(|k| k.eq_ignore_ascii_case(&name)) {
                continue;
            }
            match std::fs::remove_dir_all(entry.path()) {
                Ok(()) => note(&format!("removed old version {name}")),
                Err(error) => note(&format!("could not remove old version {name}: {error}")),
            }
        }
    }
    let _ = std::fs::remove_dir_all(root.join("downloads"));
}

/// The labels this install keeps: current and previous.
pub(crate) fn kept(state: &State) -> Vec<String> {
    std::iter::once(state.current.clone())
        .chain(state.previous.clone())
        .chain(state.pending.as_ref().map(|p| p.label.clone()))
        .collect()
}

/// The Start Menu shortcut to the launcher (made by `install-self`).
pub(crate) fn write_shortcut(root: &Path) -> Result<()> {
    let appdata = std::env::var_os("APPDATA").ok_or_else(|| eyre!("APPDATA isn't set"))?;
    let link = PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs\Assistant.lnk");
    let target = root.join(EXE);
    // Paths go in through the environment so no quoting can break out.
    let script = "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:A_LINK); \
        $s.TargetPath = $env:A_TARGET; $s.WorkingDirectory = $env:A_DIR; \
        $s.IconLocation = $env:A_TARGET + ',0'; $s.Description = 'Assistant'; $s.Save()";
    let status = crate::desktop::background_process::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("A_LINK", &link)
        .env("A_TARGET", &target)
        .env("A_DIR", root)
        .status()
        .wrap_err("could not run PowerShell")?;
    if !status.success() {
        return Err(eyre!("could not write {}", link.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "assistant-install-{name}-{}-{}",
            std::process::id(),
            now()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn version(root: &Path, label: &str) {
        std::fs::create_dir_all(version_dir(root, label)).unwrap();
        std::fs::write(version_exe(root, label), b"exe").unwrap();
    }

    #[test]
    fn layouts_are_told_apart() {
        let root = temp("layout");
        version(&root, "2.0.0");
        assert_eq!(detect_at(&root.join(EXE)), Layout::Dev);
        State {
            current: "2.0.0".into(),
            ..State::default()
        }
        .save(&root)
        .unwrap();
        assert_eq!(
            detect_at(&root.join(EXE)),
            Layout::Launcher { root: root.clone() }
        );
        assert_eq!(
            detect_at(&version_exe(&root, "2.0.0")),
            Layout::Installed {
                root: root.clone(),
                label: "2.0.0".into(),
                dir: version_dir(&root, "2.0.0"),
            }
        );
        let package = temp("package");
        std::fs::write(package.join(PACKAGE_FILE), b"{}").unwrap();
        assert_eq!(
            detect_at(&package.join(EXE)),
            Layout::Package {
                dir: package.clone()
            }
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(package);
    }

    #[test]
    fn a_version_that_never_confirms_is_rolled_back_on_the_third_launch() {
        let root = temp("choose");
        version(&root, "a");
        version(&root, "b");
        let mut state = State {
            current: "b".into(),
            previous: Some("a".into()),
            pending: Some(Pending {
                label: "b".into(),
                from: Some("a".into()),
                ..Pending::default()
            }),
            ..State::default()
        };
        assert_eq!(choose(&mut state, &root).as_deref(), Some("b"));
        assert_eq!(choose(&mut state, &root).as_deref(), Some("b"));
        assert_eq!(choose(&mut state, &root).as_deref(), Some("a"));
        assert_eq!(state.current, "a");
        assert!(state.pending.is_none());
        assert_eq!(state.failed.as_ref().unwrap().label, "b");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_missing_current_version_falls_back_on_the_previous_one() {
        let root = temp("missing");
        version(&root, "a");
        let mut state = State {
            current: "b".into(),
            previous: Some("a".into()),
            ..State::default()
        };
        assert_eq!(choose(&mut state, &root).as_deref(), Some("a"));
        assert_eq!(state.current, "a");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn prune_keeps_current_and_previous() {
        let root = temp("prune");
        for label in ["a", "b", "c"] {
            version(&root, label);
        }
        prune(&root, &["b", "c"]);
        assert!(!version_dir(&root, "a").exists());
        assert!(version_dir(&root, "b").exists() && version_dir(&root, "c").exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
