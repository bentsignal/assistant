//! Start at login: the `Vera` value under the user's `Run` key, which
//! starts `vera.exe --hidden` (tray only). Hex's own `Hex` value is never
//! touched.

use std::io::ErrorKind;
use std::path::Path;

use color_eyre::eyre::{Result, WrapErr};
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Vera";

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

/// Registers this executable, or removes the registration.
pub(crate) fn set_enabled(enabled: bool) -> Result<()> {
    if enabled {
        let executable = std::env::current_exe().wrap_err("could not find vera.exe")?;
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

/// Whether this executable is a cargo build (`…\target\<profile>\vera.exe`),
/// which shouldn't register itself to start at login unasked.
pub(crate) fn is_dev_build() -> bool {
    std::env::current_exe().is_ok_and(|exe| {
        exe.ancestors()
            .any(|dir| dir.file_name().is_some_and(|name| name == "target"))
    })
}

/// Makes the registration match `enabled`, pointing at this executable.
pub(crate) fn apply(enabled: bool) -> Result<()> {
    let wanted = std::env::current_exe().ok().map(|exe| command(&exe));
    match (enabled, registered()) {
        (true, Some(current)) if Some(&current) == wanted.as_ref() => Ok(()),
        (true, _) => set_enabled(true),
        (false, None) => Ok(()),
        (false, Some(_)) => set_enabled(false),
    }
}
