//! Vera never fails silently. Every problem (her voice failed, the voice
//! service or Core died, the brain failed or timed out, the microphone went
//! silent or away, the audio engine stopped) goes through [`Alerts::raise`]:
//! the runtime then plays the soft error chime, flashes the HUD's coral
//! failed look, and keeps the problem at the top of Settings and on the
//! tray (a coral dot, and the tooltip) for [`SHOWN_FOR`] or until it's
//! fixed. Chimes and flashes are spaced by [`CHIME_GAP`], so a burst of
//! failures is one sound, not five.

use std::time::{Duration, Instant};

/// How long a past problem stays at the top of Settings and on the tray.
pub(super) const SHOWN_FOR: Duration = Duration::from_secs(60);
/// The least time between two error chimes (and HUD flashes).
pub(super) const CHIME_GAP: Duration = Duration::from_secs(4);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Alert {
    pub title: String,
    pub detail: String,
    pub at: Instant,
}

#[derive(Default)]
pub(super) struct Alerts {
    last: Option<Alert>,
    chimed_at: Option<Instant>,
}

impl Alerts {
    /// Records a problem. True when the runtime should chime and flash now.
    pub(super) fn raise(&mut self, title: &str, detail: &str, now: Instant) -> bool {
        tracing::warn!(title, detail, "assistant: problem");
        crate::assistant::trace::record(
            "alert",
            serde_json::json!({ "title": title, "detail": detail }),
        );
        self.last = Some(Alert {
            title: title.to_owned(),
            detail: detail.to_owned(),
            at: now,
        });
        let due = self
            .chimed_at
            .is_none_or(|at| now.saturating_duration_since(at) >= CHIME_GAP);
        if due {
            self.chimed_at = Some(now);
        }
        due
    }

    /// The last problem, while it's recent.
    pub(super) fn recent(&self, now: Instant) -> Option<&Alert> {
        self.last
            .as_ref()
            .filter(|alert| now.saturating_duration_since(alert.at) < SHOWN_FOR)
    }

    /// Forgets the last problem if it's this one (it was fixed).
    pub(super) fn resolve(&mut self, title: &str) {
        if self.last.as_ref().is_some_and(|alert| alert.title == title) {
            self.last = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_of_failures_chimes_once_and_stays_shown_a_while() {
        let now = Instant::now();
        let mut alerts = Alerts::default();
        assert!(alerts.raise("Vera couldn't speak", "a", now));
        assert!(!alerts.raise("Vera couldn't speak", "b", now + Duration::from_secs(1)));
        assert!(alerts.raise(
            "Core stopped",
            "c",
            now + CHIME_GAP + Duration::from_secs(1)
        ));
        assert_eq!(
            alerts.recent(now + Duration::from_secs(10)).unwrap().detail,
            "c"
        );
        assert!(alerts.recent(now + Duration::from_secs(100)).is_none());
        alerts.resolve("Core stopped");
        assert!(alerts.recent(now + Duration::from_secs(6)).is_none());
    }
}
