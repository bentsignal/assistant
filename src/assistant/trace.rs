//! A machine-readable record of what the app did, for end-to-end tests
//! (`ASSISTANT_TRACE=<file>`; `scripts/assistant-soak/`): every line to and from
//! Core, the HUD's looks, chimes, alerts, the status line, the tray, child
//! processes, the audio engine's lifetime, and (with the simulated devices)
//! each stretch of audible output. One JSON object per line, each with `t`
//! (Unix ms) and `kind`. Off (and free) unless the variable is set.

use std::io::Write;
use std::sync::{Mutex, OnceLock, PoisonError};

use serde_json::{Value, json};

static TRACE: OnceLock<Option<Mutex<std::fs::File>>> = OnceLock::new();

fn file() -> Option<&'static Mutex<std::fs::File>> {
    TRACE
        .get_or_init(|| {
            let path = std::env::var_os("ASSISTANT_TRACE")?;
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .inspect_err(|error| tracing::warn!(%error, "could not open ASSISTANT_TRACE"))
                .ok()
                .map(Mutex::new)
        })
        .as_ref()
}

pub(crate) fn enabled() -> bool {
    file().is_some()
}

/// Appends `{"t", "kind", ...fields}`.
pub(crate) fn record(kind: &str, fields: Value) {
    let Some(file) = file() else {
        return;
    };
    let mut line = json!({ "t": crate::desktop::events::now_ms(), "kind": kind });
    if let (Some(line), Value::Object(fields)) = (line.as_object_mut(), fields) {
        line.extend(fields);
    }
    let mut text = line.to_string();
    text.push('\n');
    let mut file = file.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = file.write_all(text.as_bytes());
}
