//! Putting a release in place and switching to it safely.
//!
//! 1. [`unpack`]: the verified zip becomes `versions\<label>` (through a
//!    `.partial` folder, so a half-unpacked version never looks real), and
//!    its voice env is made if its lock is new (`voice_env::prepare`). The
//!    running version keeps running through all of this.
//! 2. [`hand_over`]: starts the old version's own executable as the
//!    supervisor (`assistant update-apply`), and the app quits.
//! 3. [`supervise`]: waits for the old app to exit, makes the new version
//!    current (pending), starts it, and waits for it to confirm it started
//!    cleanly ([`confirm`]: Core and the voice service up). If it exits or
//!    doesn't confirm in time, the old version is made current again and
//!    started, with the failure noted for Settings.
//! 4. [`confirm`], in the new version: keeps it, keeps the old one as
//!    `previous` (one click back), refreshes the launcher, and removes older
//!    versions and unused voice envs.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use color_eyre::Result;
use color_eyre::eyre::{WrapErr, bail, eyre};

use super::install::{self, Failure, Layout, Pending, State, note};

/// How long a new version has to confirm it started.
const CONFIRM_WITHIN: Duration = Duration::from_secs(150);
/// How long the old app has to quit.
const QUIT_WITHIN: Duration = Duration::from_secs(30);

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

/// Unpacks a verified package zip into `versions\<label>`. Returns its folder.
pub(crate) fn unpack(root: &Path, zip: &Path, label: &str) -> Result<PathBuf> {
    if !super::feed::valid_label(label) {
        bail!("{label} isn't a valid release name");
    }
    let dest = install::version_dir(root, label);
    if dest.join(install::EXE).is_file() && dest.join(install::PACKAGE_FILE).is_file() {
        return Ok(dest);
    }
    let partial = root
        .join(install::VERSIONS)
        .join(format!(".{label}.partial"));
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(&partial)?;
    // Windows' own bsdtar reads zips (Windows 10 1803 and later).
    let tar = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("tar.exe"))
        .filter(|tar| tar.is_file())
        .unwrap_or_else(|| PathBuf::from("tar.exe"));
    let output = crate::desktop::background_process::command(&tar)
        .arg("-xf")
        .arg(zip)
        .arg("-C")
        .arg(&partial)
        .output()
        .wrap_err("could not run tar to unpack the update")?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&partial);
        bail!(
            "could not unpack the update: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let package: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(partial.join(install::PACKAGE_FILE))
            .wrap_err("the update has no package manifest")?,
    )?;
    if package["label"].as_str() != Some(label) || !partial.join(install::EXE).is_file() {
        let _ = std::fs::remove_dir_all(&partial);
        bail!("the update's contents don't match its release");
    }
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&partial, &dest)
        .wrap_err_with(|| format!("could not move the update into {}", dest.display()))?;
    Ok(dest)
}

fn spawn_detached(exe: &Path, args: &[&str]) -> Result<std::process::Child> {
    let mut command = std::process::Command::new(exe);
    command
        .args(args)
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Out of any job the parent is in, so the parent quitting can't take it.
    let flags = CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    command
        .creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
        .or_else(|_| command.creation_flags(flags).spawn())
        .wrap_err_with(|| format!("could not start {}", exe.display()))
}

/// Starts the supervisor that switches to `label` once this app quits. The
/// caller quits right after.
pub(crate) fn hand_over(root: &Path, label: &str) -> Result<()> {
    let Layout::Installed { label: from, .. } = install::layout() else {
        bail!("only an installed copy can update itself");
    };
    let me = std::env::current_exe()?;
    let pid = std::process::id().to_string();
    let root_arg = root.to_string_lossy().into_owned();
    note(&format!("handing over from {from} to {label}"));
    spawn_detached(
        &me,
        &[
            "update-apply",
            "--root",
            &root_arg,
            "--to",
            label,
            "--from",
            from,
            "--wait-pid",
            &pid,
        ],
    )?;
    Ok(())
}

#[allow(unsafe_code)]
mod process {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
    };

    /// Waits up to `ms` for process `pid` to exit; true if it did (or is gone).
    pub(super) fn wait(pid: u32, ms: u32) -> bool {
        // SAFETY: a plain open; the handle is closed below.
        let handle: HANDLE = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return true;
        }
        // SAFETY: a live handle we own.
        let done = unsafe { WaitForSingleObject(handle, ms) } == WAIT_OBJECT_0;
        // SAFETY: as above.
        unsafe { CloseHandle(handle) };
        done
    }

    pub(super) fn kill(pid: u32) {
        // SAFETY: as above.
        let handle: HANDLE = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if !handle.is_null() {
            // SAFETY: a live handle we own.
            unsafe {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
}

/// `assistant update-apply`: the supervisor, run from the old version's
/// executable (so it works even if the new one doesn't start at all).
pub(crate) fn supervise(root: &Path, to: &str, from: &str, wait_pid: Option<u32>) -> Result<()> {
    if let Some(pid) = wait_pid
        && !process::wait(pid, QUIT_WITHIN.as_millis() as u32)
    {
        note(&format!("{from} didn't quit in time; stopping it"));
        process::kill(pid);
        process::wait(pid, 5_000);
    }
    // An app started some other way (the CLI asked it to quit) holds the
    // instance until it's gone; the new one would only hand Settings to it.
    let quitting = Instant::now();
    while crate::assistant::instance::is_running() {
        if quitting.elapsed() >= QUIT_WITHIN {
            bail!("the running app didn't quit; nothing changed");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Its children leave with its job; give the files a moment.
    std::thread::sleep(Duration::from_millis(400));
    let exe = install::version_exe(root, to);
    if !exe.is_file() {
        bail!("{} is missing", exe.display());
    }
    State::edit(root, |state| {
        state.current = to.to_string();
        state.pending = Some(Pending {
            label: to.to_string(),
            from: Some(from.to_string()),
            at: install::now(),
            attempts: 0,
        });
    })?;
    note(&format!("switched to {to}; starting it"));
    let mut child = spawn_detached(&exe, &[])?;
    let started = Instant::now();
    let reason = loop {
        std::thread::sleep(Duration::from_millis(500));
        match State::load(root) {
            Ok(state) if state.pending.is_none() && state.current == to => {
                note(&format!("{to} started cleanly"));
                return Ok(());
            }
            Ok(state) if state.current != to => {
                // Something else (the launcher, or the user) moved on.
                note(&format!("{} is current now; stopping watch", state.current));
                return Ok(());
            }
            _ => {}
        }
        if let Ok(Some(status)) = child.try_wait() {
            break format!("it exited during startup ({status})");
        }
        if started.elapsed() >= CONFIRM_WITHIN {
            let _ = child.kill();
            let _ = child.wait();
            break format!(
                "it didn't start cleanly within {} s",
                CONFIRM_WITHIN.as_secs()
            );
        }
    };
    note(&format!("{to} failed: {reason}; rolling back to {from}"));
    State::edit(root, |state| {
        state.current = from.to_string();
        state.pending = None;
        state.failed = Some(Failure {
            label: to.to_string(),
            reason,
            at: install::now(),
        });
    })?;
    spawn_detached(&install::version_exe(root, from), &[])?;
    Ok(())
}

/// In a version that was just switched to and has started cleanly: makes it
/// stick (see the module docs). Does nothing unless it's pending.
pub(crate) fn confirm() -> Result<bool> {
    let Layout::Installed { root, label, dir } = install::layout() else {
        return Ok(false);
    };
    let state = State::load(root)?;
    let Some(pending) = state.pending.clone().filter(|p| p.label == *label) else {
        return Ok(false);
    };
    let state = State::edit(root, |state| {
        state.current = label.clone();
        if pending.from.as_deref() != Some(label.as_str()) {
            state.previous = pending.from.clone().or(state.previous.take());
        }
        state.pending = None;
        if state.failed.as_ref().is_some_and(|f| f.label == *label) {
            state.failed = None;
        }
        state.clone()
    })?;
    note(&format!(
        "{label} confirmed; previous is {}",
        state.previous.as_deref().unwrap_or("none")
    ));
    if let Err(error) = install::refresh_launcher(root, &dir.join(install::EXE)) {
        note(&format!("{error:#}"));
    }
    let kept = install::kept(&state);
    install::prune(root, &kept.iter().map(String::as_str).collect::<Vec<_>>());
    let locks: Vec<String> = kept
        .iter()
        .filter_map(|label| super::voice_env::lock_hash(&install::version_dir(root, label)))
        .collect();
    super::voice_env::prune(&locks);
    Ok(true)
}

/// `assistant install-self` (the bootstrap installer runs it from an
/// unpacked `versions\<label>`): makes this version current in its root,
/// prepares the voice env (adopting the venv the machine already has),
/// copies the launcher, and adds the Start Menu shortcut. Start at login is
/// applied when the app starts (it points at the launcher).
pub(crate) fn install_self() -> Result<()> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| eyre!("no folder"))?
        .to_path_buf();
    let label = dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| eyre!("no label"))?;
    let root = dir
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| eyre!("{} isn't in a versions folder", dir.display()))?
        .to_path_buf();
    if !dir.join(install::PACKAGE_FILE).is_file() {
        bail!("{} isn't a package", dir.display());
    }
    println!("installing {label} in {}", root.display());
    let env = super::voice_env::prepare(&dir, true, &mut |line| {
        println!("  {line}");
        note(line);
    })?;
    println!("voice env: {}", env.display());
    let previous = State::load(&root).ok().map(|state| state.current);
    State {
        schema: 1,
        current: label.clone(),
        previous: previous.filter(|p| *p != label),
        pending: None,
        failed: None,
    }
    .save(&root)?;
    install::refresh_launcher(&root, &exe)?;
    if let Err(error) = install::write_shortcut(&root) {
        println!("note: no Start Menu shortcut ({error:#})");
    }
    note(&format!("installed {label} in {}", root.display()));
    println!(
        "installed; start it with {}",
        root.join(install::EXE).display()
    );
    Ok(())
}
