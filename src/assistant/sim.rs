//! The end-to-end test's hands (`ASSISTANT_SIM_CONTROL=127.0.0.1:<port>`, with
//! `ASSISTANT_AUDIO_SIM` and `ASSISTANT_TRACE`; `scripts/assistant-soak/`): a loopback TCP
//! port that takes one command per line and answers `ok …` or `err …`.
//!
//! - `mic <gain_db> <wav path>`: say that WAV into the simulated microphone
//!   (answers `ok <ms>`, how long it plays); `mic-clear` drops what's queued.
//! - `voice <id>|default`, `volume <0..1>`, `microphone <name>|default`,
//!   `mute on|off`: what the Settings window would do.
//! - `stop`: the Stop talking hotkey.
//! - `sim echo_db=…,delay_ms=…,noise_db=…`: other simulated devices, live
//!   (a headset: `sim echo_db=-90,delay_ms=20,noise_db=-100`).
//!
//! Off unless the variable is set; it listens on loopback only.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::mpsc::Sender;

use super::runtime::Msg;
use crate::rune_ui::assistant::UiAction;

pub(super) fn start(messages: Sender<Msg>) {
    let Ok(address) = std::env::var("ASSISTANT_SIM_CONTROL") else {
        return;
    };
    let listener = match TcpListener::bind(address.trim()) {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!(%error, address, "could not open ASSISTANT_SIM_CONTROL");
            return;
        }
    };
    tracing::info!(address, "assistant: test control is on");
    let _ = std::thread::Builder::new()
        .name("assistant-sim-control".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let messages = messages.clone();
                let _ = std::thread::Builder::new()
                    .name("assistant-sim-client".into())
                    .spawn(move || {
                        let Ok(reader) = stream.try_clone() else {
                            return;
                        };
                        let mut writer = stream;
                        for line in BufReader::new(reader).lines() {
                            let Ok(line) = line else {
                                return;
                            };
                            let answer = match command(line.trim(), &messages) {
                                Ok(answer) => format!("ok {answer}\n"),
                                Err(error) => format!("err {error}\n"),
                            };
                            if writer.write_all(answer.as_bytes()).is_err() {
                                return;
                            }
                        }
                    });
            }
        });
}

fn ui(messages: &Sender<Msg>, action: UiAction) -> Result<String, String> {
    messages
        .send(Msg::Ui(action))
        .map(|()| String::new())
        .map_err(|_| "Vera is quitting".to_owned())
}

fn named(value: &str) -> Option<String> {
    (!value.is_empty() && value != "default").then(|| value.to_owned())
}

fn command(line: &str, messages: &Sender<Msg>) -> Result<String, String> {
    let (verb, rest) = line.split_once(' ').unwrap_or((line, ""));
    let rest = rest.trim();
    match verb {
        "mic" => {
            let (gain, path) = rest
                .split_once(' ')
                .ok_or("usage: mic <gain_db> <wav path>")?;
            let gain: f32 = gain.parse().map_err(|_| "the gain isn't a number")?;
            let length = super::audio::simdev::inject_wav(Path::new(path.trim()), gain)
                .map_err(|error| format!("{error:#}"))?;
            crate::assistant::trace::record(
                "mic",
                serde_json::json!({"path": path.trim(), "ms": length.as_millis() as u64}),
            );
            Ok(length.as_millis().to_string())
        }
        "sim" => {
            let sim = super::audio::simdev::sim().ok_or("the simulated devices aren't on")?;
            sim.reconfigure(rest);
            crate::assistant::trace::record("sim", serde_json::json!({ "spec": rest }));
            Ok(String::new())
        }
        "mic-clear" => {
            if let Some(sim) = super::audio::simdev::sim() {
                sim.clear_microphone();
            }
            Ok(String::new())
        }
        "voice" => ui(messages, UiAction::SetVoice(named(rest))),
        "volume" => {
            let level: f32 = rest.parse().map_err(|_| "the volume isn't a number")?;
            ui(messages, UiAction::SetVolume { level, done: true })
        }
        "microphone" => ui(messages, UiAction::SetMicrophone(named(rest))),
        "mute" => ui(messages, UiAction::SetMuted(rest == "on")),
        "stop" => messages
            .send(Msg::StopHotkey)
            .map(|()| String::new())
            .map_err(|_| "Vera is quitting".to_owned()),
        "" => Ok(String::new()),
        _ => Err(format!("unknown command {verb:?}")),
    }
}
