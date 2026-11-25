//! What the runtime starts and opens: Core's command line, the audio
//! engine's config, start at login, and the personality file.

use super::super::audio::AudioConfig;
use super::super::child::{self, Spec};
use super::super::config::Config;

/// Start at login is on unless turned off, but a cargo build never
/// registers itself unasked.
pub(super) fn apply_start_at_login(config: &Config) {
    let enabled = match config.start_at_login {
        Some(enabled) => enabled,
        None if super::super::login::is_dev_build() => {
            tracing::info!("a development build doesn't start at login unless asked");
            return;
        }
        None => true,
    };
    if let Err(error) = super::super::login::apply(enabled) {
        tracing::warn!(error = %format!("{error:#}"), "could not update start at login");
    }
}

pub(super) fn core_spec(config: &Config) -> Result<Spec, String> {
    let env = vec![
        ("VERA_APP".to_string(), "1".to_string()),
        ("VERA_VOICE_URL".to_string(), config.voice_url()),
    ];
    let repo = config.repo();
    let core_dir = repo.as_ref().map(|repo| repo.join("vera").join("core"));
    if let Some(command) = &config.core.command {
        let (program, args) = command.split_first().ok_or("app.core.command is empty")?;
        return Ok(Spec {
            program: child::which(program).unwrap_or_else(|| program.into()),
            args: args.iter().map(Into::into).collect(),
            cwd: config.core.cwd.clone().or(core_dir),
            env,
        });
    }
    let repo = repo.ok_or("Vera's repo wasn't found; set app.repo in ~/.vera/config.json")?;
    let core_dir = repo.join("vera").join("core");
    let entry = repo.join(&config.core_entry);
    if !entry.is_file() {
        return Err(format!("no Core at {}", entry.display()));
    }
    if !core_dir.join("node_modules").join("tsx").exists() {
        return Err("Core's packages aren't installed (pnpm install in vera\\)".into());
    }
    let node = child::which("node").ok_or("Node isn't on PATH")?;
    let mut args: Vec<std::ffi::OsString> =
        vec!["--import".into(), "tsx".into(), entry.into_os_string()];
    args.extend(config.core_args.iter().map(Into::into));
    Ok(Spec {
        program: node,
        args,
        cwd: Some(core_dir),
        env,
    })
}

pub(super) fn audio_config(config: &Config, muted: bool) -> AudioConfig {
    AudioConfig {
        microphone: config.microphone.clone(),
        volume: config.volume,
        mic_muted: muted,
        voice_url: config.voice_url(),
        voice: config.voice.clone(),
    }
}

/// Opens `~/.vera/system-prompt.md` in the default editor, seeding it from
/// Core's prompt first if it doesn't exist; Notepad when nothing opens it.
pub(super) fn edit_personality(config: &Config) {
    let path = super::super::paths::system_prompt();
    if !path.is_file() {
        let seed = config
            .repo()
            .map(|repo| {
                repo.join("vera")
                    .join("core")
                    .join("prompts")
                    .join("system.md")
            })
            .and_then(|seed| std::fs::read_to_string(seed).ok())
            .unwrap_or_else(|| "# Vera\n\nYou are Vera, a calm voice assistant.\n".into());
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(error) = std::fs::write(&path, seed) {
            tracing::error!(%error, "could not create system-prompt.md");
            return;
        }
    }
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain([0]).collect() };
    let file = wide(&path.display().to_string());
    let verb = wide("open");
    // SAFETY: NUL-terminated strings that outlive the call.
    let result = unsafe {
        windows_sys::Win32::UI::Shell::ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        tracing::info!("no editor for .md files; opening Notepad");
        let _ = std::process::Command::new("notepad.exe").arg(&path).spawn();
    }
}
