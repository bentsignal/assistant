//! What this build is, as packaging stamped it (`build.rs`'s
//! `assistant_build`): its version, release label, channel, commit, and date.
//! A plain cargo build is channel `dev`.

pub(crate) const VERSION: &str = env!("ASSISTANT_BUILD_VERSION");
/// The release's name and its folder under `versions\`.
pub(crate) const LABEL: &str = env!("ASSISTANT_BUILD_LABEL");
/// `stable`, `nightly`, or `dev`.
pub(crate) const CHANNEL: &str = env!("ASSISTANT_BUILD_CHANNEL");
pub(crate) const COMMIT: &str = env!("ASSISTANT_BUILD_COMMIT");
/// UTC ISO 8601, empty for a plain cargo build.
pub(crate) const DATE: &str = env!("ASSISTANT_BUILD_DATE");

/// The commit's first seven characters.
pub(crate) fn short_commit() -> &'static str {
    COMMIT.get(..7).unwrap_or(COMMIT)
}

/// "Nightly", "Stable", or "Development".
pub(crate) fn channel_name(channel: &str) -> &'static str {
    match channel {
        "stable" => "Stable",
        "nightly" => "Nightly",
        _ => "Development",
    }
}

/// How Settings and `--version` describe this build: "2.0.0 · Nightly
/// abc1234", "2.0.0", or "2.0.0 · Development abc1234".
pub(crate) fn describe() -> String {
    match CHANNEL {
        "stable" => VERSION.to_string(),
        channel if short_commit().is_empty() => {
            format!("{VERSION} \u{00b7} {}", channel_name(channel))
        }
        channel => format!(
            "{VERSION} \u{00b7} {} {}",
            channel_name(channel),
            short_commit()
        ),
    }
}

/// The date part of an ISO 8601 stamp ("2026-11-25"), if any.
pub(crate) fn day(stamp: &str) -> Option<&str> {
    stamp
        .get(..10)
        .filter(|day| day.as_bytes().get(4) == Some(&b'-'))
}
