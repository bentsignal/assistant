//! Vera's global hotkey: Stop talking (`Ctrl+Alt+Space` unless
//! `app.stopHotkey` says otherwise). It is a plain `RegisterHotKey`, which
//! sits beside Hex's keyboard hook without touching it: Hex's own shortcuts
//! (Right Alt, Ctrl+Alt+V, F9, Escape while recording) never include it,
//! and a chord Windows already gave another app is refused and logged. Keys
//! are named as Hex names them (`windows::input::virtual_key`).

use std::sync::mpsc;
use std::thread::JoinHandle;

use color_eyre::Result;
use color_eyre::eyre::{bail, eyre};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, RegisterHotKey, UnregisterHotKey,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetMessageW, MSG, PostThreadMessageW, WM_HOTKEY, WM_QUIT,
};

/// `Ctrl+Alt+Space` as modifiers and a virtual key.
pub(crate) fn parse(spec: &str) -> Result<(u32, u32)> {
    let mut modifiers = 0;
    let mut key = None;
    for part in spec.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= MOD_CONTROL,
            "alt" | "option" => modifiers |= MOD_ALT,
            "shift" => modifiers |= MOD_SHIFT,
            "win" | "windows" | "super" => modifiers |= MOD_WIN,
            _ if key.is_none() => key = Some(crate::windows::input::virtual_key(part)?),
            _ => bail!("{spec} names more than one key"),
        }
    }
    let key = key.ok_or_else(|| eyre!("{spec} names no key"))?;
    if modifiers == 0 {
        bail!("{spec} needs a modifier, so typing never triggers it");
    }
    Ok((modifiers, key))
}

/// The registered hotkey; dropping it unregisters it.
pub(crate) struct Hotkey {
    thread: u32,
    worker: Option<JoinHandle<()>>,
}

impl Hotkey {
    pub(crate) fn register(spec: &str, on_press: impl Fn() + Send + 'static) -> Result<Self> {
        let (modifiers, key) = parse(spec)?;
        let (ready, result) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("assistant-hotkey".into())
            .spawn(move || {
                // SAFETY: registers for this thread's queue (no window).
                let ok = unsafe {
                    RegisterHotKey(std::ptr::null_mut(), 1, modifiers | MOD_NOREPEAT, key)
                };
                if ok == 0 {
                    let _ = ready.send(Err(std::io::Error::last_os_error()));
                    return;
                }
                // SAFETY: a plain query.
                let _ = ready.send(Ok(unsafe { GetCurrentThreadId() }));
                // SAFETY: this thread's message loop; WM_QUIT ends it.
                unsafe {
                    let mut msg: MSG = std::mem::zeroed();
                    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                        if msg.message == WM_HOTKEY {
                            on_press();
                        }
                    }
                    UnregisterHotKey(std::ptr::null_mut(), 1);
                }
            })?;
        match result.recv() {
            Ok(Ok(thread)) => Ok(Self {
                thread,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(eyre!("{spec} is taken by another app ({error})"))
            }
            Err(_) => Err(eyre!("the hotkey thread exited")),
        }
    }
}

impl Drop for Hotkey {
    fn drop(&mut self) {
        // SAFETY: posts to the hotkey thread's queue.
        unsafe { PostThreadMessageW(self.thread, WM_QUIT, 0, 0) };
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chords() {
        assert_eq!(
            parse("Ctrl+Alt+Space").unwrap(),
            (MOD_CONTROL | MOD_ALT, 0x20)
        );
        assert_eq!(
            parse("ctrl + shift + F8").unwrap(),
            (MOD_CONTROL | MOD_SHIFT, 0x77)
        );
        assert!(parse("Space").is_err());
        assert!(parse("Ctrl+A+B").is_err());
    }
}
