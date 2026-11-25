//! Core and the voice service as hidden children that come back when they
//! die. Each one starts suspended with no console window
//! (`CREATE_NO_WINDOW`, which its own console children inherit, so nothing
//! flashes), joins a job object of its own that kills the whole tree when
//! its handle closes, and only then runs. Stopping a child, quitting Vera,
//! and Vera crashing all close that handle, so nothing is orphaned.
//!
//! A child that dies comes back after 1, 2, 5, 10, then 30 seconds; one that
//! ran a minute starts the count again. Its stderr goes to
//! `~/.assistant/logs/<name>.log`; its stdout lines go to the runtime.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::time::{Duration, Instant};

use color_eyre::Result;
use color_eyre::eyre::{WrapErr, eyre};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_SUSPENDED: u32 = 0x0000_0004;

/// A job object whose processes all die when it closes.
pub(crate) struct Job(HANDLE);

// SAFETY: a job handle is a kernel handle, usable from any thread.
unsafe impl Send for Job {}
// SAFETY: as above; the handle is only read.
unsafe impl Sync for Job {}

impl Job {
    pub(crate) fn new() -> Result<Self> {
        // SAFETY: no name or security attributes; checked below.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(eyre!(
                "CreateJobObjectW failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let job = Self(handle);
        // SAFETY: plain data; zero is its empty value.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is the struct this information class takes, and it
        // outlives the call.
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(eyre!(
                "SetInformationJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(job)
    }

    fn assign(&self, child: &Child) -> Result<()> {
        // SAFETY: both are live handles this process owns.
        let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
        if ok == 0 {
            return Err(eyre!(
                "AssignProcessToJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle is ours; closing it kills what is still in it.
        unsafe { CloseHandle(self.0) };
    }
}

/// Resumes every thread of a process started suspended (it has one).
fn resume(pid: u32) -> Result<()> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // SAFETY: a snapshot of every thread in the system, closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot.is_null() || snapshot as isize == -1 {
        return Err(eyre!("CreateToolhelp32Snapshot failed"));
    }
    let mut resumed = 0;
    // SAFETY: plain data with its size set; the snapshot is live.
    unsafe {
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut more = Thread32First(snapshot, &mut entry) != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    ResumeThread(thread);
                    CloseHandle(thread);
                    resumed += 1;
                }
            }
            more = Thread32Next(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    if resumed == 0 {
        return Err(eyre!("found no thread to resume in process {pid}"));
    }
    Ok(())
}

/// What to run.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Spec {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<OsString>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) env: Vec<(String, String)>,
}

impl Spec {
    pub(crate) fn describe(&self) -> String {
        std::iter::once(self.program.display().to_string())
            .chain(
                self.args
                    .iter()
                    .map(|arg| arg.to_string_lossy().into_owned()),
            )
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// A child as Settings and the tray describe it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum State {
    /// Nothing to run (not found or not configured), and why.
    Missing(String),
    Starting,
    Running,
    /// Died; comes back at the time given.
    Restarting {
        why: String,
    },
    Stopped,
}

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    started: Instant,
    /// Closing it kills the child's tree.
    _job: Job,
}

pub(crate) struct Supervisor {
    name: &'static str,
    spec: Result<Spec, String>,
    running: Option<Running>,
    failures: u32,
    restart_at: Option<Instant>,
    pub(crate) state: State,
    on_line: std::sync::Arc<dyn Fn(String) + Send + Sync>,
}

const BACKOFF: [u64; 5] = [1, 2, 5, 10, 30];

/// What a [`Supervisor::tick`] saw.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Tick {
    Nothing,
    /// The child just started (callers greet it).
    Started,
    /// The child just died; it comes back after the backoff.
    Exited,
}
const PROVEN: Duration = Duration::from_secs(60);

impl Supervisor {
    /// `spec` is what to run, or why there is nothing; `on_line` gets each
    /// stdout line on the child's reader thread.
    pub(crate) fn new(
        name: &'static str,
        spec: Result<Spec, String>,
        on_line: impl Fn(String) + Send + Sync + 'static,
    ) -> Self {
        let state = match &spec {
            Ok(_) => State::Starting,
            Err(why) => State::Missing(why.clone()),
        };
        Self {
            name,
            spec,
            running: None,
            failures: 0,
            restart_at: Some(Instant::now()),
            state,
            on_line: std::sync::Arc::new(on_line),
        }
    }

    /// Starts, notices a death, and restarts when due.
    pub(crate) fn tick(&mut self) -> Tick {
        if let Some(running) = &mut self.running {
            match running.child.try_wait() {
                Ok(None) => return Tick::Nothing,
                Ok(Some(status)) => {
                    let ran = running.started.elapsed();
                    tracing::warn!(child = self.name, %status, ran_secs = ran.as_secs(), "child exited");
                    crate::assistant::trace::record(
                        "child",
                        serde_json::json!({"name": self.name, "event": "exited", "pid": running.child.id()}),
                    );
                    if ran >= PROVEN {
                        self.failures = 0;
                    }
                    self.running = None;
                    let delay = BACKOFF[(self.failures as usize).min(BACKOFF.len() - 1)];
                    self.failures += 1;
                    self.restart_at = Some(Instant::now() + Duration::from_secs(delay));
                    self.state = State::Restarting {
                        why: format!("exited ({status})"),
                    };
                    return Tick::Exited;
                }
                Err(error) => {
                    tracing::warn!(child = self.name, %error, "could not poll child");
                    return Tick::Nothing;
                }
            }
        }
        let Some(at) = self.restart_at else {
            return Tick::Nothing;
        };
        if Instant::now() < at {
            return Tick::Nothing;
        }
        let spec = match &self.spec {
            Ok(spec) => spec.clone(),
            Err(_) => {
                self.restart_at = None;
                return Tick::Nothing;
            }
        };
        match self.spawn(&spec) {
            Ok(running) => {
                tracing::info!(child = self.name, command = %spec.describe(), pid = running.child.id(), "child started");
                crate::assistant::trace::record(
                    "child",
                    serde_json::json!({"name": self.name, "event": "started", "pid": running.child.id()}),
                );
                self.running = Some(running);
                self.restart_at = None;
                self.state = State::Running;
                Tick::Started
            }
            Err(error) => {
                tracing::error!(child = self.name, error = %format!("{error:#}"), "child could not start");
                let delay = BACKOFF[(self.failures as usize).min(BACKOFF.len() - 1)];
                self.failures += 1;
                self.restart_at = Some(Instant::now() + Duration::from_secs(delay));
                self.state = State::Restarting {
                    why: format!("{error:#}"),
                };
                Tick::Nothing
            }
        }
    }

    fn spawn(&self, spec: &Spec) -> Result<Running> {
        let mut command = std::process::Command::new(&spec.program);
        command
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        let job = Job::new()?;
        let mut child = command
            .spawn()
            .wrap_err_with(|| format!("could not start {}", spec.program.display()))?;
        // Into the job before it runs a single instruction, so nothing it
        // starts can escape.
        if let Err(error) = job.assign(&child).and_then(|()| resume(child.id())) {
            let _ = child.kill();
            return Err(error);
        }
        let stdin = child.stdin.take();
        if let Some(stdout) = child.stdout.take() {
            let on_line = self.on_line.clone();
            let name = self.name;
            std::thread::Builder::new()
                .name(format!("assistant-{name}-out"))
                .spawn(move || {
                    for line in BufReader::new(stdout).lines() {
                        match line {
                            Ok(line) if !line.trim().is_empty() => on_line(line),
                            Ok(_) => {}
                            Err(_) => break,
                        }
                    }
                })?;
        }
        if let Some(stderr) = child.stderr.take() {
            let name = self.name;
            std::thread::Builder::new()
                .name(format!("assistant-{name}-err"))
                .spawn(move || log_stderr(name, stderr))?;
        }
        Ok(Running {
            child,
            stdin,
            started: Instant::now(),
            _job: job,
        })
    }

    /// Writes one line to the child's stdin; false when it isn't running.
    pub(crate) fn send_line(&mut self, line: &str) -> bool {
        let Some(running) = &mut self.running else {
            return false;
        };
        let Some(stdin) = &mut running.stdin else {
            return false;
        };
        let written = stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush());
        if let Err(error) = written {
            tracing::warn!(child = self.name, %error, "could not write to child");
            return false;
        }
        true
    }

    /// Stops the child and its tree: stdin closes first, so it may finish on
    /// its own within `grace`; then its job kills whatever is left.
    pub(crate) fn stop(&mut self, grace: Duration) {
        self.restart_at = None;
        self.state = State::Stopped;
        let Some(mut running) = self.running.take() else {
            return;
        };
        drop(running.stdin.take());
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if matches!(running.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        // Dropping `running` closes the job, which kills the tree.
        let _ = running.child.kill();
        tracing::info!(child = self.name, "child stopped");
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop(Duration::ZERO);
    }
}

fn log_stderr(name: &str, stderr: std::process::ChildStderr) {
    let dir = super::paths::logs();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("{name}.log"));
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 16 * 1024 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok();
    for line in BufReader::new(stderr).lines() {
        let Ok(line) = line else { break };
        if let Some(file) = &mut file {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// `program` found on PATH (with `.exe` when it has no extension).
pub(crate) fn which(program: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(program);
    if candidate.is_absolute() {
        return candidate.is_file().then_some(candidate);
    }
    let names: Vec<String> = if candidate.extension().is_some() {
        vec![program.to_owned()]
    } else {
        vec![format!("{program}.exe"), program.to_owned()]
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file())
}
