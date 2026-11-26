//! Assistant's updates (docs/install.md): a Stable / Nightly channel, a
//! check against the GitHub releases CI publishes, and a safe switch to the
//! channel's current release whenever it isn't the running build, older or
//! not (going back to Stable is one click).
//!
//! - [`stamp`]: what this build is.
//! - [`install`]: the installed layout, `install.json`, and the launcher.
//! - [`feed`]: releases, their manifests, verified downloads.
//! - [`voice_env`]: the voice service's venv per `uv.lock`.
//! - [`apply`]: unpack, hand over, supervise, confirm, roll back.
//!
//! [`Updater`] is the runtime's handle: checks and installs run on their own
//! thread and report through `wake`; Settings and the tray read
//! [`Updater::snapshot`].

pub(crate) mod apply;
pub(crate) mod feed;
pub(crate) mod install;
pub(crate) mod stamp;
pub(crate) mod voice_env;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

pub(crate) use feed::{Channel, Offer};

/// The first automatic check, after launch settles.
const FIRST_CHECK: Duration = Duration::from_secs(90);
/// Then this often while the app runs.
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum Phase {
    /// Not checked yet.
    #[default]
    Idle,
    Checking,
    UpToDate,
    /// The channel has no release yet.
    NoRelease,
    Available(Offer),
    Downloading {
        offer: Offer,
        got: u64,
        total: u64,
    },
    /// Unpacking, or preparing the voice's Python packages.
    Preparing {
        offer: Offer,
        what: String,
    },
    /// In place; the app hands over and restarts into it.
    Ready(Offer),
    Failed {
        message: String,
        offer: Option<Offer>,
    },
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Snapshot {
    pub(crate) phase: Phase,
    pub(crate) channel: Channel,
    pub(crate) checked_at: Option<SystemTime>,
    /// The last version that failed to start and was rolled back.
    pub(crate) rolled_back: Option<install::Failure>,
}

struct Shared {
    phase: Phase,
    channel: Channel,
    checked_at: Option<SystemTime>,
    busy: bool,
}

pub(crate) struct Updater {
    shared: Arc<Mutex<Shared>>,
    repo: String,
    wake: Arc<dyn Fn() + Send + Sync>,
    cancel: Arc<AtomicBool>,
    started: Instant,
    last_auto: Option<Instant>,
    auto: bool,
    rolled_back: Option<install::Failure>,
}

fn lock(shared: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|error| error.into_inner())
}

/// The channel to follow when none is chosen: the build's own (a
/// development build follows Nightly).
pub(crate) fn default_channel() -> Channel {
    Channel::parse(stamp::CHANNEL).unwrap_or(Channel::Nightly)
}

/// Whether this copy can update itself (an installed version).
pub(crate) fn can_apply() -> bool {
    matches!(install::layout(), install::Layout::Installed { .. })
}

impl Updater {
    pub(crate) fn new(
        channel: Channel,
        repo: String,
        auto: bool,
        wake: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared {
                phase: Phase::Idle,
                channel,
                checked_at: None,
                busy: false,
            })),
            repo,
            wake: Arc::new(wake),
            cancel: Arc::new(AtomicBool::new(false)),
            started: Instant::now(),
            last_auto: None,
            auto,
            rolled_back: install::layout()
                .root()
                .and_then(|root| install::State::load(root).ok())
                .and_then(|state| state.failed),
        }
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        let shared = lock(&self.shared);
        Snapshot {
            phase: shared.phase.clone(),
            channel: shared.channel,
            checked_at: shared.checked_at,
            rolled_back: self.rolled_back.clone(),
        }
    }

    /// A new channel: checks it at once.
    pub(crate) fn set_channel(&mut self, channel: Channel) {
        {
            let mut shared = lock(&self.shared);
            if shared.channel == channel {
                return;
            }
            shared.channel = channel;
            if shared.busy {
                // A check in flight picks the new channel up; an install
                // in flight finishes what it started.
                return;
            }
            shared.phase = Phase::Idle;
        }
        self.check();
    }

    /// The automatic check, from the runtime's tick.
    pub(crate) fn tick(&mut self) {
        if !self.auto || !can_apply() {
            return;
        }
        let due = match self.last_auto {
            None => self.started.elapsed() >= FIRST_CHECK,
            Some(at) => at.elapsed() >= EVERY,
        };
        if due {
            self.last_auto = Some(Instant::now());
            self.check();
        }
    }

    /// Looks for the channel's current release (no-op while busy). A channel
    /// picked while it checks is checked next, on the same thread.
    pub(crate) fn check(&self) {
        {
            let mut shared = lock(&self.shared);
            if shared.busy {
                return;
            }
            shared.busy = true;
            shared.phase = Phase::Checking;
        }
        (self.wake)();
        let shared = self.shared.clone();
        let wake = self.wake.clone();
        let repo = self.repo.clone();
        let spawned = std::thread::Builder::new()
            .name("assistant-update-check".into())
            .spawn(move || {
                let feed = feed::Feed::new(&repo);
                loop {
                    let channel = lock(&shared).channel;
                    let result = feed.latest(channel);
                    let mut state = lock(&shared);
                    if state.channel != channel {
                        continue;
                    }
                    state.busy = false;
                    state.checked_at = Some(SystemTime::now());
                    state.phase = match result {
                        Ok(None) => Phase::NoRelease,
                        Ok(Some(offer)) if offer.is_running() => Phase::UpToDate,
                        Ok(Some(offer)) => Phase::Available(offer),
                        Err(error) => Phase::Failed {
                            message: format!("{error:#}"),
                            offer: None,
                        },
                    };
                    tracing::info!(channel = channel.key(), phase = %describe(&state.phase), "update check");
                    break;
                }
                wake();
            });
        if spawned.is_err() {
            let mut state = lock(&self.shared);
            state.busy = false;
            state.phase = Phase::Idle;
        }
    }

    /// Downloads, verifies, and unpacks the offered release and prepares its
    /// voice env; `ready` is called once it's in place (the runtime then
    /// hands over and quits).
    pub(crate) fn install(&self, ready: impl FnOnce(Offer) + Send + 'static) {
        let Some(root) = install::layout().root().map(std::path::Path::to_path_buf) else {
            return;
        };
        let offer = {
            let mut shared = lock(&self.shared);
            let offer = match &shared.phase {
                Phase::Available(offer) => offer.clone(),
                Phase::Failed {
                    offer: Some(offer), ..
                } => offer.clone(),
                _ => return,
            };
            if shared.busy {
                return;
            }
            shared.busy = true;
            shared.phase = Phase::Downloading {
                offer: offer.clone(),
                got: 0,
                total: offer.size,
            };
            offer
        };
        (self.wake)();
        self.cancel.store(false, Ordering::Relaxed);
        let shared = self.shared.clone();
        let wake = self.wake.clone();
        let cancel = self.cancel.clone();
        let repo = self.repo.clone();
        let _ = std::thread::Builder::new()
            .name("assistant-update-install".into())
            .spawn(move || {
                let set = |phase: Phase| {
                    lock(&shared).phase = phase;
                    wake();
                };
                let result = (|| -> color_eyre::Result<()> {
                    let zip = root.join("downloads").join(&offer.asset);
                    install::note(&format!(
                        "downloading {} ({} bytes)",
                        offer.label, offer.size
                    ));
                    feed::Feed::new(&repo).download(&offer, &zip, &cancel, |got, total| {
                        set(Phase::Downloading {
                            offer: offer.clone(),
                            got,
                            total,
                        });
                    })?;
                    set(Phase::Preparing {
                        offer: offer.clone(),
                        what: "Unpacking".into(),
                    });
                    let dir = apply::unpack(&root, &zip, &offer.label)?;
                    let _ = std::fs::remove_file(&zip);
                    let lock_hash = voice_env::lock_hash(&dir).unwrap_or_default();
                    if voice_env::find(&lock_hash).is_none() {
                        set(Phase::Preparing {
                            offer: offer.clone(),
                            what: "Preparing the voice's Python packages (a few minutes)".into(),
                        });
                        voice_env::prepare(&dir, false, &mut |line| install::note(line))?;
                    }
                    Ok(())
                })();
                let mut state = lock(&shared);
                state.busy = false;
                match result {
                    Ok(()) => {
                        install::note(&format!("{} is ready to switch to", offer.label));
                        state.phase = Phase::Ready(offer.clone());
                        drop(state);
                        wake();
                        ready(offer);
                    }
                    Err(error) => {
                        install::note(&format!("update to {} failed: {error:#}", offer.label));
                        state.phase = Phase::Failed {
                            message: format!("{error:#}"),
                            offer: Some(offer),
                        };
                        drop(state);
                        wake();
                    }
                }
            });
    }

    /// Stops a download in progress (quitting).
    pub(crate) fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

fn describe(phase: &Phase) -> String {
    match phase {
        Phase::Available(offer) => format!("available {}", offer.label),
        Phase::Failed { message, .. } => format!("failed: {message}"),
        other => format!("{other:?}"),
    }
}

/// `assistant update check|install`: the same steps from a terminal, for
/// testing against a real or local feed. `install` hands over and asks the
/// running app to quit.
pub(crate) fn cli(
    install_it: bool,
    channel: Option<String>,
    repo: Option<String>,
) -> color_eyre::Result<()> {
    let config = super::config::Config::load();
    let channel = channel
        .as_deref()
        .and_then(Channel::parse)
        .or(config.updates.channel)
        .unwrap_or_else(default_channel);
    let repo = repo.unwrap_or(config.updates.repo);
    println!(
        "running {} ({}, built {})",
        stamp::describe(),
        stamp::LABEL,
        if stamp::DATE.is_empty() {
            "locally"
        } else {
            stamp::DATE
        }
    );
    println!("layout: {:?}", install::layout());
    let feed = feed::Feed::new(&repo);
    let Some(offer) = feed.latest(channel)? else {
        println!("{} has no release yet", channel.name());
        return Ok(());
    };
    println!(
        "{}: {} ({}, {} bytes, sha256 {})",
        channel.name(),
        offer.label,
        offer.date,
        offer.size,
        offer.sha256
    );
    if offer.is_running() {
        println!("that's this build: up to date");
        return Ok(());
    }
    if !install_it {
        println!("an update is available");
        return Ok(());
    }
    let install::Layout::Installed { root, .. } = install::layout() else {
        color_eyre::eyre::bail!("only an installed copy can update itself");
    };
    let zip = root.join("downloads").join(&offer.asset);
    feed.download(&offer, &zip, &AtomicBool::new(false), |got, total| {
        eprint!("\rdownloading {:>3}%", got * 100 / total.max(1));
    })?;
    eprintln!();
    println!("verified {}", zip.display());
    let dir = apply::unpack(root, &zip, &offer.label)?;
    let _ = std::fs::remove_file(&zip);
    println!("unpacked into {}", dir.display());
    let env = voice_env::prepare(&dir, false, &mut |line| println!("  {line}"))?;
    println!("voice env {}", env.display());
    // The supervisor waits for the running app (if any) to quit.
    let running = super::instance::signal_quit();
    let pid = std::process::id();
    let root_arg = root.to_string_lossy().into_owned();
    let install::Layout::Installed { label: from, .. } = install::layout() else {
        unreachable!()
    };
    println!(
        "handing over from {from} to {}{}",
        offer.label,
        if running {
            " (asked the running app to quit)"
        } else {
            ""
        }
    );
    std::process::Command::new(std::env::current_exe()?)
        .args([
            "update-apply",
            "--root",
            &root_arg,
            "--to",
            &offer.label,
            "--from",
            from,
        ])
        .args(["--wait-pid", &pid.to_string()])
        // Not this terminal's pipes: the app it starts would hold them open.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}
