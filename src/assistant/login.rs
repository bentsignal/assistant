//! Start at login: the `Vera` value under the user's `Run` key, which
//! starts `assistant.exe --hidden` (tray only). Hex's own `Hex` value is never
//! touched.

use std::io::ErrorKind;
use std::path::Path;

use color_eyre::eyre::{Result, WrapErr};
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Assistant";
/// What it was called before the rename; removed whenever start at login
/// is applied, so the old `vera.exe` never starts beside it.
const LEGACY_VALUE_NAME: &str = "Vera";

fn command(executable: &Path) -> String {
    format!(r#""{}" --hidden"#, executable.display())
}

/// The command registered now, if any.
pub(crate) fn registered() -> Option<String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_READ)
        .ok()?
        .get_value::<String, _>(VALUE_NAME)
        .ok()
}

/// What start at login runs: an installed version's launcher (so it follows
/// updates), else this executable.
fn target() -> Option<std::path::PathBuf> {
    match super::update::install::layout().root() {
        Some(root) => Some(root.join(super::update::install::EXE)),
        None => std::env::current_exe().ok(),
    }
}

/// Registers this executable, or removes the registration.
pub(crate) fn set_enabled(enabled: bool) -> Result<()> {
    if enabled {
        let executable =
            target().ok_or_else(|| color_eyre::eyre::eyre!("could not find assistant.exe"))?;
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(RUN_KEY)
            .wrap_err("could not open Windows startup applications")?;
        key.set_value(VALUE_NAME, &command(&executable))
            .wrap_err("could not register Vera to start at login")?;
    } else {
        let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_WRITE)
        {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error).wrap_err("could not open Windows startup applications");
            }
        };
        if let Err(error) = key.delete_value(VALUE_NAME)
            && error.kind() != ErrorKind::NotFound
        {
            return Err(error).wrap_err("could not unregister Vera from Windows startup");
        }
    }
    Ok(())
}

/// Whether this executable is a cargo build (`…\target\<profile>\assistant.exe`),
/// which shouldn't register itself to start at login unasked.
pub(crate) fn is_dev_build() -> bool {
    std::env::current_exe().is_ok_and(|exe| {
        exe.ancestors()
            .any(|dir| dir.file_name().is_some_and(|name| name == "target"))
    })
}

/// Removes the registration from before the rename, if it's there.
fn remove_legacy() {
    if let Ok(key) =
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_READ | KEY_WRITE)
        && key.get_value::<String, _>(LEGACY_VALUE_NAME).is_ok()
    {
        match key.delete_value(LEGACY_VALUE_NAME) {
            Ok(()) => tracing::info!("removed the old Vera start-at-login entry"),
            Err(error) => {
                tracing::warn!(%error, "could not remove the old Vera start-at-login entry")
            }
        }
    }
}

/// Makes the registration match `enabled`, pointing at this executable.
pub(crate) fn apply(enabled: bool) -> Result<()> {
    remove_legacy();
    let wanted = target().map(|exe| command(&exe));
    match (enabled, registered()) {
        (true, Some(current)) if Some(&current) == wanted.as_ref() => Ok(()),
        (true, _) => set_enabled(true),
        (false, None) => Ok(()),
        (false, Some(_)) => set_enabled(false),
    }
}
