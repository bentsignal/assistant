//! Assistant's folder, `~/.assistant` (or `$ASSISTANT_HOME`), shared with
//! Core and the voice service: config, system prompt, logs, the voice's venv
//! and models. The app's own Hex internals (the few that keep a file) live
//! in `~/.assistant/app/hex`, never in the installed Hex's folder.
//!
//! Before the rename this was `~/.vera`; [`migrate`] moves it on the first
//! launch, models, config, prompt, and history included.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) fn home() -> PathBuf {
    if let Some(home) = std::env::var_os("ASSISTANT_HOME") {
        return PathBuf::from(home);
    }
    crate::app_paths::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".assistant")
}

/// Where the app kept everything before it was renamed.
fn legacy_home() -> Option<PathBuf> {
    crate::app_paths::home_dir().map(|home| home.join(".vera"))
}

/// What [`migrate`] did, logged once logging is up.
static MIGRATION: Mutex<Option<String>> = Mutex::new(None);

/// Moves `~/.vera` to `~/.assistant` when only the old one exists (a
/// rename on the same drive: nothing is copied or downloaded again). A
/// Vera from before the rename keeps files open there, so it's asked to
/// quit first. If the move still fails, this run uses the old folder
/// (children inherit `ASSISTANT_HOME`) and the next launch tries again.
/// Called from `main` before any other thread exists.
pub(crate) fn migrate() {
    if std::env::var_os("ASSISTANT_HOME").is_some() {
        return;
    }
    let (Some(old), new) = (legacy_home(), home()) else {
        return;
    };
    if new.exists() || !old.is_dir() {
        return;
    }
    let asked = super::instance::signal_legacy_quit(&old);
    let deadline = Instant::now() + Duration::from_secs(if asked { 15 } else { 3 });
    loop {
        match std::fs::rename(&old, &new) {
            Ok(()) => {
                note(format!("moved {} to {}", old.display(), new.display()));
                return;
            }
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(250)),
            Err(error) => {
                note(format!(
                    "could not move {} to {} ({error}); using the old folder this time",
                    old.display(),
                    new.display()
                ));
                // SAFETY: called from `main` before any other thread exists.
                unsafe { std::env::set_var("ASSISTANT_HOME", &old) };
                return;
            }
        }
    }
}

fn note(text: String) {
    *MIGRATION.lock().unwrap_or_else(|error| error.into_inner()) = Some(text);
}

/// Whether `path` is the folder from before the rename.
#[allow(dead_code)]
pub(crate) fn is_legacy(path: &Path) -> bool {
    legacy_home().is_some_and(|old| old == path)
}

pub(crate) fn logs() -> PathBuf {
    home().join("logs")
}

pub(crate) fn config_file() -> PathBuf {
    home().join("config.json")
}

pub(crate) fn system_prompt() -> PathBuf {
    home().join("system-prompt.md")
}

/// Gives Hex code running inside Vera Vera's own data folder, keeping the
/// installed Hex's speech models, before any thread reads either. Called
/// first thing in `assistant::main`.
pub(crate) fn isolate() {
    if std::env::var_os("HEX_APPLICATION_SUPPORT_DIR").is_none() {
        if let Ok(models) = crate::app_paths::models_dir() {
            crate::app_paths::use_models_dir(models);
        }
        let data = home().join("app").join("hex");
        // SAFETY: called from `main` before any other thread exists.
        unsafe { std::env::set_var("HEX_APPLICATION_SUPPORT_DIR", &data) };
    }
    // Vera never updates itself through Hex's updater.
    // SAFETY: as above.
    unsafe { std::env::set_var("HEX_DISABLE_UPDATES", "1") };
}

/// Logs to `~/.assistant/logs/assistant-app.log`, cut back to nothing past 8 MB at
/// launch.
pub(crate) fn init_logging() {
    let dir = logs();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("assistant-app.log");
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 8 * 1024 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let filter = tracing_subscriber::EnvFilter::try_from_env("ASSISTANT_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_target(false)
        .with_writer(LogFile(std::sync::Arc::new(Mutex::new(file))))
        .try_init();
    tracing::info!(version = crate::VERSION, home = %home().display(), "Assistant starting");
    if let Some(note) = MIGRATION
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        tracing::warn!(%note, "data folder");
    }
}

#[derive(Clone)]
struct LogFile(std::sync::Arc<Mutex<std::fs::File>>);

impl Write for LogFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .flush()
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogFile {
    type Writer = LogFile;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}
