//! The voice service as the app sees it (DESIGN.md, "Voice service
//! contract"): how to start it, and a probe thread that watches
//! `GET /v1/health` and lists `GET /v1/voices` for Settings.
//!
//! The probe reads `/v1/voices` (`{"voices":[{"id","name","available",…}]}`,
//! a bare list of those, or a list of ids), leaves out voices the service
//! says it can't run here, and falls back to the one voice health names.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

use super::child::{Spec, which};
use super::config::Config;

/// A voice Settings can offer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Voice {
    pub(crate) id: String,
    pub(crate) name: String,
}

/// What the probe last saw.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct Status {
    pub(crate) ready: bool,
    /// The service's current voice.
    pub(crate) voice: Option<String>,
    pub(crate) voices: Vec<Voice>,
}

/// How to start the voice service: `app.voiceService.command` (an argv),
/// else `assistant/voice` (DESIGN.md, "Voice service contract"): the venv's
/// `pythonw.exe -m assistant_voice serve --port <port> --parent-pid <Vera>` from
/// `<repo>/assistant/voice`, so the repo's code is what runs. `pythonw` has no
/// console, and `--parent-pid` makes the service exit (freeing its VRAM)
/// whenever Vera does, even if the job object were somehow bypassed. The
/// venv is `~/.assistant/voice/venv` (`assistant\voice\scripts\setup.ps1` makes it).
pub(crate) fn spec(config: &Config) -> Result<Spec, String> {
    let port = config.voice_port.to_string();
    let env = vec![
        ("ASSISTANT_VOICE_PORT".to_string(), port.clone()),
        ("ASSISTANT_APP".to_string(), "1".to_string()),
        // The service's own log is ~/.assistant/logs/voice.log; Python's stray
        // prints and warnings shouldn't buffer behind a pipe.
        ("PYTHONUNBUFFERED".to_string(), "1".to_string()),
    ];
    if let Some(command) = &config.voice_service.command {
        let (program, args) = command
            .split_first()
            .ok_or("app.voiceService.command is empty")?;
        let program = which(program).unwrap_or_else(|| PathBuf::from(program));
        return Ok(Spec {
            program,
            args: args.iter().map(OsString::from).collect(),
            cwd: config.voice_service.cwd.clone(),
            env,
        });
    }
    let package = super::update::install::layout().package_dir();
    // A package runs its own copy of the service in the venv made for its
    // lock (`update::voice_env`); a repo build runs the repo's in `venv`.
    let python = match package {
        Some(package) => super::update::voice_env::pythonw(package),
        None => super::update::voice_env::legacy()
            .join("Scripts")
            .join("pythonw.exe"),
    };
    if !python.is_file() {
        return Err(format!(
            "the voice service isn't set up (no {}); run vera\\voice\\scripts\\setup.ps1",
            python.display()
        ));
    }
    let cwd = config.voice_service.cwd.clone().or_else(|| {
        if let Some(package) = package {
            return Some(package.join("voice"));
        }
        config
            .repo()
            .map(|repo| repo.join("assistant").join("voice"))
            .filter(|dir| dir.join("assistant_voice").join("__main__.py").is_file())
    });
    Ok(Spec {
        program: python,
        args: vec![
            "-m".into(),
            "assistant_voice".into(),
            "serve".into(),
            "--port".into(),
            port.into(),
            "--parent-pid".into(),
            std::process::id().to_string().into(),
        ],
        cwd,
        env,
    })
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .proxy(None)
        .http_status_as_error(true)
        .build()
        .into()
}

fn get(agent: &ureq::Agent, url: &str) -> Option<Value> {
    let mut response = agent.get(url).call().ok()?;
    let text = response.body_mut().read_to_string().ok()?;
    serde_json::from_str(&text).ok()
}

fn voices(value: &Value) -> Vec<Voice> {
    let list = value
        .get("voices")
        .and_then(Value::as_array)
        .or_else(|| value.as_array());
    list.into_iter()
        .flatten()
        .filter_map(|voice| match voice {
            Value::String(id) => Some(Voice {
                id: id.clone(),
                name: id.clone(),
            }),
            Value::Object(fields) => {
                if fields.get("available").and_then(Value::as_bool) == Some(false) {
                    return None;
                }
                let id = fields.get("id")?.as_str()?.to_owned();
                let name = fields
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_owned();
                Some(Voice { id, name })
            }
            _ => None,
        })
        .collect()
}

/// Watches the service at `url` until `stop`, calling `report` when what it
/// sees changes. Quick while it isn't ready, slow once it is.
pub(crate) fn probe(url: String, stop: Arc<AtomicBool>, report: impl Fn(Status) + Send + 'static) {
    let _ = std::thread::Builder::new()
        .name("assistant-voice-probe".into())
        .spawn(move || {
            let agent = agent();
            let mut last: Option<Status> = None;
            while !stop.load(Ordering::Relaxed) {
                let health = get(&agent, &format!("{url}/v1/health"));
                let ready = health
                    .as_ref()
                    .and_then(|h| h.get("ready"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let voice = health
                    .as_ref()
                    .and_then(|h| h.get("voice"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let mut status = Status {
                    ready,
                    voice: voice.clone(),
                    voices: Vec::new(),
                };
                if ready {
                    status.voices = match &last {
                        Some(last) if last.ready && !last.voices.is_empty() => last.voices.clone(),
                        _ => get(&agent, &format!("{url}/v1/voices"))
                            .map(|v| voices(&v))
                            .unwrap_or_default(),
                    };
                    if status.voices.is_empty()
                        && let Some(voice) = voice
                    {
                        status.voices.push(Voice {
                            id: voice.clone(),
                            name: voice,
                        });
                    }
                }
                if last.as_ref() != Some(&status) {
                    report(status.clone());
                    last = Some(status);
                }
                let wait = if ready { 3 } else { 2 };
                for _ in 0..wait * 4 {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_voice_lists_in_several_shapes() {
        let wrapped = json!({"voices": [{"id": "af_heart", "name": "Heart"}]});
        assert_eq!(
            voices(&wrapped),
            vec![Voice {
                id: "af_heart".into(),
                name: "Heart".into()
            }]
        );
        assert_eq!(voices(&json!(["a", "b"])).len(), 2);
        assert!(voices(&json!({"ready": true})).is_empty());
    }
}
