//! Her personality: the system prompt (`~/.assistant/system-prompt.md`), as
//! Settings edits it. Every save backs up the text it replaces to
//! `prompt-history/` the way Core's `edit_system_prompt` does
//! (`<stamp>-<seq>-edit.md`), so the brain's `revert_system_prompt` undoes a
//! save from Settings too. Core watches the file and applies a change from
//! the next turn.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::config::Config;
use super::paths;

/// The stock prompt when the repo's seed can't be read.
const FALLBACK: &str = "# {{name}}\n\nYou are {{name}}, a calm voice assistant.\n";

fn history() -> PathBuf {
    paths::home().join("prompt-history")
}

/// The stock prompt: `assistant/core/prompts/system.md` in the repo.
pub(crate) fn default_text() -> String {
    Config::load()
        .repo()
        .map(|repo| repo.join("assistant/core/prompts/system.md"))
        .and_then(|seed| std::fs::read_to_string(seed).ok())
        .map(|text| text.trim_start_matches('\u{feff}').to_owned())
        .unwrap_or_else(|| FALLBACK.to_owned())
}

/// The prompt as it is now (the stock one until it's been written).
pub(crate) fn load() -> String {
    std::fs::read_to_string(paths::system_prompt())
        .map(|text| text.trim_start_matches('\u{feff}').to_owned())
        .unwrap_or_else(|_| default_text())
}

/// Writes `text` as the prompt, backing up what it replaces.
pub(crate) fn save(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("An empty personality can't be saved".into());
    }
    let path = paths::system_prompt();
    let before = std::fs::read_to_string(&path).ok();
    if before.as_deref() == Some(text) {
        return Ok(());
    }
    if let Some(before) = before {
        let dir = history();
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let backup = dir.join(format!("{}-0001-edit.md", stamp(SystemTime::now())));
        std::fs::write(&backup, before).map_err(|error| error.to_string())?;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    // Write beside it and rename, so Core never reads half a prompt.
    let partial = path.with_extension("md.partial");
    std::fs::write(&partial, text).map_err(|error| error.to_string())?;
    std::fs::rename(&partial, &path).map_err(|error| error.to_string())?;
    tracing::info!(chars = text.chars().count(), "saved the personality");
    Ok(())
}

/// `2026-11-25T10-11-12-123Z`, as Core stamps its backups (an ISO time with
/// `:` and `.` made `-`), so the two sort together.
fn stamp(now: SystemTime) -> String {
    let since = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let (days, rest) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil(days as i64);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}-{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        since.subsec_millis()
    )
}

/// Days since 1970-01-01 to (year, month, day), Howard Hinnant's algorithm.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn backups_are_stamped_like_cores() {
        let at = UNIX_EPOCH + Duration::from_millis(1_795_000_000_123);
        assert_eq!(stamp(at), "2026-11-18T11-06-40-123Z");
        assert_eq!(stamp(UNIX_EPOCH), "1970-01-01T00-00-00-000Z");
    }
}
