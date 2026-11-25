//! `vera shots <dir>`: renders Vera's screens.

use std::path::Path;

use color_eyre::Result;

pub(crate) fn run(dir: &Path, _tray: bool) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    Ok(())
}
