//! One Vera per login session (per `ASSISTANT_HOME`), apart from Hex's: a named
//! event the first Vera keeps. A later launch signals it, and the running
//! Vera opens Settings, unless that launch was hidden (login).

use color_eyre::Result;
use color_eyre::eyre::eyre;
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
use windows_sys::Win32::System::Threading::{
    CreateEventW, INFINITE, SetEvent, WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{ASFW_ANY, AllowSetForegroundWindow};

pub(crate) struct Instance(HANDLE);

// SAFETY: an event handle is usable from any thread.
unsafe impl Send for Instance {}

/// The session's event `kind` (`App`, `Quit`) for this `ASSISTANT_HOME`, so a
/// test Vera with its own home runs beside the real one.
fn name(kind: &str) -> String {
    let home = super::paths::home().display().to_string().to_lowercase();
    // FNV-1a.
    let hash = home.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3)
    });
    format!("Local\\Assistant.{kind}.{hash:016x}")
}

fn wide(name: &str) -> Vec<u16> {
    name.encode_utf16().chain([0]).collect()
}

/// Asks a Vera from before the rename, kept in `old_home`, to quit (its
/// events were `Local\\Vera.<kind>.<hash of its home>`); false when none
/// runs.
pub(crate) fn signal_legacy_quit(old_home: &std::path::Path) -> bool {
    use windows_sys::Win32::System::Threading::{EVENT_MODIFY_STATE, OpenEventW};
    let home = old_home.display().to_string().to_lowercase();
    let hash = home.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3)
    });
    let name = wide(&format!("Local\\Vera.Quit.{hash:016x}"));
    // SAFETY: a NUL-terminated name that outlives the call.
    let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
    if event.is_null() {
        return false;
    }
    // SAFETY: a valid handle we own.
    unsafe {
        SetEvent(event);
        CloseHandle(event);
    }
    true
}

/// Asks the running Vera to quit (`vera quit`); false when none runs.
pub(crate) fn signal_quit() -> bool {
    use windows_sys::Win32::System::Threading::{EVENT_MODIFY_STATE, OpenEventW};
    let name = wide(&name("Quit"));
    // SAFETY: a NUL-terminated name that outlives the call.
    let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
    if event.is_null() {
        return false;
    }
    // SAFETY: a valid handle we own.
    unsafe {
        SetEvent(event);
        CloseHandle(event);
    }
    true
}

/// Whether an app for this `ASSISTANT_HOME` is running (its instance event
/// exists).
pub(crate) fn is_running() -> bool {
    use windows_sys::Win32::System::Threading::{EVENT_MODIFY_STATE, OpenEventW};
    let name = wide(&name("App"));
    // SAFETY: a NUL-terminated name that outlives the call.
    let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
    if event.is_null() {
        return false;
    }
    // SAFETY: a valid handle we own.
    unsafe { CloseHandle(event) };
    true
}

/// Calls `on_quit` when `vera quit` signals this Vera.
pub(crate) fn forward_quit(on_quit: impl Fn() + Send + 'static) {
    let name = wide(&name("Quit"));
    // SAFETY: as above; the handle stays open for the process's life.
    let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) } as usize;
    if event == 0 {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("assistant-quit".into())
        .spawn(move || {
            // SAFETY: the handle is never closed.
            while unsafe { WaitForSingleObject(event as HANDLE, INFINITE) } == 0 {
                on_quit();
            }
        });
}

impl Instance {
    /// `None` when a Vera already runs; it was asked to open Settings unless
    /// `hidden`.
    pub(crate) fn claim(hidden: bool) -> Result<Option<Self>> {
        let name = wide(&name("App"));
        // SAFETY: a NUL-terminated name that outlives the call.
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
        if event.is_null() {
            return Err(eyre!(
                "could not create Vera's instance event: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: read right after the call it describes.
        if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
            return Ok(Some(Self(event)));
        }
        if !hidden {
            tracing::info!("Vera is already running; opening its Settings");
            // SAFETY: a valid handle; the running Vera may take the foreground.
            unsafe {
                AllowSetForegroundWindow(ASFW_ANY);
                SetEvent(event);
            }
        }
        // SAFETY: ours to close.
        unsafe { CloseHandle(event) };
        Ok(None)
    }

    /// Calls `on_launch` each time a later launch signals.
    pub(crate) fn forward_launches(self, on_launch: impl Fn() + Send + 'static) {
        let event = self.0 as usize;
        std::mem::forget(self);
        let _ = std::thread::Builder::new()
            .name("assistant-relaunch".into())
            .spawn(move || {
                // SAFETY: the handle stays open for the process's life.
                while unsafe { WaitForSingleObject(event as HANDLE, INFINITE) } == 0 {
                    on_launch();
                }
            });
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        // SAFETY: ours to close.
        unsafe { CloseHandle(self.0) };
    }
}
