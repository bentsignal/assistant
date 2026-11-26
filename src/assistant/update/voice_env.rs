//! The voice service's Python environment for a package: one venv per
//! `voice/uv.lock`, so an update makes a new one only when the lock changed,
//! and makes it beside the one the running version uses (never touching
//! it), which keeps a rollback working.
//!
//! - `~/.assistant/voice/venv`: the one `setup.ps1` makes (development, and
//!   the venv a machine had before installs). An installed version adopts it
//!   when its marker names the same lock.
//! - `~/.assistant/voice/envs/<lock hash>`: made by the updater with the
//!   package's own `tools\uv.exe` (`uv sync --frozen --no-install-project`:
//!   only the dependencies; the service's code runs from the package).
//!
//! Each env holds `.assistant-lock`, the SHA-256 of the lock it was synced
//! from, written last: an env without it is unfinished and is made again.

use std::path::{Path, PathBuf};

use color_eyre::Result;
use color_eyre::eyre::{WrapErr, bail};

const MARKER: &str = ".assistant-lock";

fn voice_home() -> PathBuf {
    crate::assistant::paths::home().join("voice")
}

pub(crate) fn legacy() -> PathBuf {
    voice_home().join("venv")
}

fn env_dir(lock: &str) -> PathBuf {
    voice_home()
        .join("envs")
        .join(lock.get(..16).unwrap_or(lock))
}

/// The SHA-256 of a package's `voice/uv.lock`.
pub(crate) fn lock_hash(package: &Path) -> Option<String> {
    super::feed::sha256_file(&package.join("voice").join("uv.lock")).ok()
}

fn marked(env: &Path, lock: &str) -> bool {
    std::fs::read_to_string(env.join(MARKER)).is_ok_and(|text| text.trim() == lock)
        && env.join("Scripts").join("pythonw.exe").is_file()
}

/// The env synced from this lock, if there is one.
pub(crate) fn find(lock: &str) -> Option<PathBuf> {
    [legacy(), env_dir(lock)]
        .into_iter()
        .find(|env| marked(env, lock))
}

/// The `pythonw.exe` a package runs its voice service with: its lock's env,
/// else the legacy venv (it may still work; Settings shows if it doesn't).
pub(crate) fn pythonw(package: &Path) -> PathBuf {
    lock_hash(package)
        .and_then(|lock| find(&lock))
        .unwrap_or_else(legacy)
        .join("Scripts")
        .join("pythonw.exe")
}

/// Makes the env for `package`'s lock unless it exists. With `in_place`
/// (the bootstrap installer, nothing running), the legacy venv is synced to
/// the lock itself, which is quick when little changed; otherwise a new env
/// is made beside it. `log` gets uv's output lines.
pub(crate) fn prepare(
    package: &Path,
    in_place: bool,
    log: &mut dyn FnMut(&str),
) -> Result<PathBuf> {
    let lock = lock_hash(package)
        .ok_or_else(|| color_eyre::eyre::eyre!("{} has no voice\\uv.lock", package.display()))?;
    if let Some(env) = find(&lock) {
        return Ok(env);
    }
    let env = if in_place && legacy().join("Scripts").join("python.exe").is_file() {
        legacy()
    } else {
        env_dir(&lock)
    };
    let _ = std::fs::remove_file(env.join(MARKER));
    let uv = package.join("tools").join("uv.exe");
    let uv = if uv.is_file() {
        uv
    } else {
        crate::assistant::child::which("uv").unwrap_or(uv)
    };
    log(&format!("syncing {} with {}", env.display(), uv.display()));
    std::fs::create_dir_all(env.parent().unwrap_or(&env))?;
    let output = crate::desktop::background_process::command(&uv)
        .args(["sync", "--frozen", "--no-install-project", "--no-dev"])
        .args(["--python", "3.12", "--managed-python", "--project"])
        .arg(package.join("voice"))
        .env("UV_PROJECT_ENVIRONMENT", &env)
        .env("UV_NO_PROGRESS", "1")
        .output()
        .wrap_err_with(|| format!("could not run {}", uv.display()))?;
    for line in String::from_utf8_lossy(&output.stderr)
        .lines()
        .chain(String::from_utf8_lossy(&output.stdout).lines())
    {
        log(line);
    }
    if !output.status.success() {
        bail!(
            "preparing the voice's Python packages failed (uv exited with {})",
            output.status.code().unwrap_or(-1)
        );
    }
    crate::durable::write(&env.join(MARKER), lock.as_bytes())?;
    Ok(env)
}

/// Removes envs under `envs\` that none of these locks use (never the legacy
/// venv).
pub(crate) fn prune(keep: &[String]) {
    let Ok(entries) = std::fs::read_dir(voice_home().join("envs")) else {
        return;
    };
    for entry in entries.flatten() {
        let marker = std::fs::read_to_string(entry.path().join(MARKER)).unwrap_or_default();
        if keep.iter().any(|lock| lock == marker.trim()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => super::install::note(&format!("removed unused voice env {name}")),
            Err(error) => {
                super::install::note(&format!("could not remove voice env {name}: {error}"))
            }
        }
    }
}
