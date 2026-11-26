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
        ("ASSISTANT_APP".to_string(), "1".to_string()),
        ("ASSISTANT_VOICE_URL".to_string(), config.voice_url()),
    ];
    let repo = config.repo();
    let core_dir = repo
        .as_ref()
        .map(|repo| repo.join("assistant").join("core"));
    if let Some(command) = &config.core.command {
        let (program, args) = command.split_first().ok_or("app.core.command is empty")?;
        return Ok(Spec {
            program: child::which(program).unwrap_or_else(|| program.into()),
            args: args.iter().map(Into::into).collect(),
            cwd: config.core.cwd.clone().or(core_dir),
            env,
        });
    }
    // An installed (or unpacked) package runs its own Core with its own
    // Node, never a repo checkout's.
    if let Some(package) = super::super::update::install::layout().package_dir() {
        let core_dir = package.join("core");
        let entry = core_dir.join("dist").join("main.mjs");
        let node = package.join("node").join("node.exe");
        if !entry.is_file() || !node.is_file() {
            return Err(format!(
                "this install is missing Core ({})",
                entry.display()
            ));
        }
        let mut args: Vec<std::ffi::OsString> = vec![entry.into_os_string()];
        args.extend(config.core_args.iter().map(Into::into));
        return Ok(Spec {
            program: node,
            args,
            cwd: Some(core_dir),
            env,
        });
    }
    let repo = repo.ok_or("Vera's repo wasn't found; set app.repo in ~/.assistant/config.json")?;
    let core_dir = repo.join("assistant").join("core");
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

/// The audio engine's config: Vera's microphone (`None` follows the
/// Windows default), volume, and the voice service the app started.
pub(super) fn audio_config(config: &Config) -> AudioConfig {
    AudioConfig {
        microphone: config.microphone.clone(),
        volume: config.volume,
        voice_url: config.voice_url(),
        voice: config.voice.clone(),
        ears: crate::assistant_ears::EarsSettings {
            vocabulary: config.personas.iter().map(|p| p.name.clone()).collect(),
            patience: config.turn,
            ..Default::default()
        },
        ..AudioConfig::default()
    }
}
