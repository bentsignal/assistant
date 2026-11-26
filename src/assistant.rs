//! Vera (DESIGN.md): the hands-free voice front end, as its own Windows app
//! built from this crate. `assistant.exe` is the `vera` bin in Cargo.toml, the
//! same sources as `hex.exe`; `main` sends it here ([`IS_ASSISTANT`]).
//!
//! It runs in the background like Hex: a tray icon with a small menu, Hex's
//! HUD on screen only while Vera is engaged, a card popup Vera opens and
//! closes, and a Settings window. Its own name, icon, tray entry, instance,
//! and data folder (`~/.assistant`) keep it apart from the installed Hex, whose
//! settings and data it never writes; it only reads Hex's speech models.
//!
//! - [`runtime`]: the controller thread. It routes Core's commands to the
//!   audio engine, HUD, card, and tray, and the audio engine's events to Core.
//! - [`child`]: Core and the voice service as hidden, supervised children, each
//!   tree in a kill-on-close job object.
//! - [`audio`]: the full-duplex audio engine (AEC3, barge-in, Parakeet STT,
//!   playback); `hex assistant-audio` drives it from the command line (`docs/assistant-audio.md`).
//! - `crate::rune_ui::assistant`: the Settings window and the card, in Hex's style.

pub(crate) mod audio;
mod child;
pub(crate) mod config;
mod hotkey;
mod icon;
mod instance;
mod login;
mod paths;
pub(crate) mod personality;
mod protocol;
mod runtime;
mod shots;
mod sim;
pub(crate) mod trace;
mod tray;
pub(crate) mod update;
mod voice;

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use color_eyre::Result;

/// Whether this is the `vera` executable.
pub(crate) const IS_ASSISTANT: bool = same(env!("CARGO_BIN_NAME"), "assistant");

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

#[derive(Parser)]
#[command(
    name = "assistant",
    version = update::stamp::LABEL,
    about = "Assistant: a hands-free voice for your coding agents"
)]
struct Cli {
    /// Start in the tray without opening Settings (the login launch).
    #[arg(long)]
    hidden: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Quit the running Vera (and every process it started).
    Quit,
    /// Check for (or install) the update channel's current release.
    Update {
        /// Download, verify, and switch to it (restarts the app).
        #[arg(long)]
        install: bool,
        /// `stable` or `nightly` (default: the channel in Settings).
        #[arg(long)]
        channel: Option<String>,
        /// Another `owner/repo` to read releases from.
        #[arg(long, hide = true)]
        repo: Option<String>,
    },
    /// Make this unpacked version the installed one (the bootstrap installer).
    #[command(hide = true)]
    InstallSelf,
    /// The update supervisor: switch to a version once the app quits, and
    /// roll back if it doesn't start cleanly.
    #[command(hide = true)]
    UpdateApply {
        #[arg(long)]
        root: PathBuf,
        #[arg(long)]
        to: String,
        #[arg(long)]
        from: String,
        #[arg(long)]
        wait_pid: Option<u32>,
    },
    /// Draw Vera's screens (HUD looks, card, Settings) into a folder as PNGs.
    #[command(hide = true)]
    Shots {
        /// Where the PNGs go.
        dir: PathBuf,
        /// Also open the real tray menu for a moment and capture it.
        #[arg(long)]
        tray: bool,
    },
}

/// `assistant.exe`'s `main`, after DLL search hardening.
pub(crate) fn main(dll_search: std::io::Result<()>) -> Result<()> {
    // A terminal that ran `vera --help` or `vera shots` sees its output;
    // the app leaves the terminal right after parsing.
    crate::windows::attach_parent_console();
    if let Err(error) = dll_search {
        eprintln!("assistant: SetDefaultDllDirectories failed: {error}");
    }
    color_eyre::install()?;
    // `<install>ssistant.exe` is the launcher: it starts the current
    // version (rolling back one that keeps failing) and gets out of the way.
    if let update::install::Layout::Launcher { root } = update::install::layout() {
        let code = update::install::launch(root, std::env::args_os().skip(1).collect());
        std::process::exit(code);
    }
    let cli = Cli::parse();
    // Before any thread starts: the data folder moves from its old name
    // (`~/.vera`) on the app's first launch, Hex internals that keep files
    // use Assistant's folder, and the speech models are the installed Hex's.
    if cli.command.is_none() {
        paths::migrate();
    }
    paths::isolate();
    match cli.command {
        Some(Command::Shots { dir, tray }) => shots::run(&dir, tray),
        Some(Command::Update {
            install,
            channel,
            repo,
        }) => update::cli(install, channel, repo),
        Some(Command::InstallSelf) => update::apply::install_self(),
        Some(Command::UpdateApply {
            root,
            to,
            from,
            wait_pid,
        }) => {
            let result = update::apply::supervise(&root, &to, &from, wait_pid);
            if let Err(error) = &result {
                update::install::note(&format!("update supervisor: {error:#}"));
            }
            result
        }
        Some(Command::Quit) => {
            if !instance::signal_quit() {
                eprintln!("Assistant isn't running");
                std::process::exit(3);
            }
            Ok(())
        }
        None => {
            crate::windows::detach_from_console();
            crate::windows::vulkan::check();
            paths::init_logging();
            runtime::run(cli.hidden)
        }
    }
}
