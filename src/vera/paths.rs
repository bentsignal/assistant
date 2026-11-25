//! Vera's folder, `~/.vera` (or `$VERA_HOME`), shared with Core: config,
//! system prompt, logs. The app's own Hex internals (the few that keep a
//! file) live in `~/.vera/app/hex`, never in the installed Hex's folder.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

pub(crate) fn home() -> PathBuf {
    if let Some(home) = std::env::var_os("VERA_HOME") {
        return PathBuf::from(home);
    }
    crate::app_paths::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vera")
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
/// first thing in `vera::main`.
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

/// Logs to `~/.vera/logs/vera-app.log`, cut back to nothing past 8 MB at
/// launch.
pub(crate) fn init_logging() {
    let dir = logs();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("vera-app.log");
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
    let filter = tracing_subscriber::EnvFilter::try_from_env("VERA_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_target(false)
        .with_writer(LogFile(std::sync::Arc::new(Mutex::new(file))))
        .try_init();
    tracing::info!(version = crate::VERSION, home = %home().display(), "Vera starting");
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
