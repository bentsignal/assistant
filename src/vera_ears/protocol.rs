//! The Ears JSON-lines contract (`VERA.md`): one event object per stdout
//! line, one command object per stdin line. Times are Unix epoch ms.

use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Event<'a> {
    /// The model is loaded and the microphone delivers audio.
    Ready {
        engine: &'a str,
        model: &'a str,
        language: &'a str,
        /// The microphone in use.
        device: &'a str,
        /// Where the model runs, for example "NVIDIA GeForce RTX 5070 Ti (Vulkan)".
        backend: &'a str,
        /// Whether `partial` events can arrive.
        partials: bool,
        pause_ms: u64,
    },
    SpeechStart { t: u64 },
    Partial { text: &'a str, t: u64 },
    Final {
        text: &'a str,
        start: u64,
        end: u64,
        /// From the moment the end-of-utterance pause was reached to this
        /// line, in ms.
        latency_ms: u64,
    },
    /// A `speech_start` whose audio turned out to hold no words (a cough, a
    /// door, music the speech detector rejects) or that a pause interrupted.
    /// No `final` follows it. Extra to the contract: parsers that ignore
    /// unknown types lose nothing.
    SpeechCancel { t: u64, reason: &'a str },
    Paused { t: u64 },
    Resumed { t: u64 },
    Error { message: &'a str },
}

#[derive(Debug, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub(crate) enum Command {
    Pause,
    Resume,
    Shutdown,
}

/// Parses one stdin line; blank lines are `None`.
pub(crate) fn parse_command(line: &str) -> Option<Result<Command, String>> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    Some(serde_json::from_str(line).map_err(|error| format!("{error}: {line}")))
}

/// Serializes events as lines on stdout. A failed write (the parent closed
/// the pipe) sets `closed`, which ends the run.
pub(crate) struct Output<W: Write + Send> {
    writer: Mutex<W>,
    closed: AtomicBool,
}

impl<W: Write + Send> Output<W> {
    pub(crate) fn new(writer: W) -> Self {
        Self {
            writer: Mutex::new(writer),
            closed: AtomicBool::new(false),
        }
    }

    pub(crate) fn emit(&self, event: &Event) {
        let mut line = match serde_json::to_string(event) {
            Ok(line) => line,
            Err(error) => {
                tracing::error!(%error, "could not serialize an event");
                return;
            }
        };
        line.push('\n');
        let mut writer = self.writer.lock().unwrap_or_else(|error| error.into_inner());
        if writer
            .write_all(line.as_bytes())
            .and_then(|()| writer.flush())
            .is_err()
        {
            self.closed.store(true, Ordering::Release);
        }
    }

    pub(crate) fn closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> W
    where
        W: Clone,
    {
        self.writer
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    #[cfg(test)]
    pub(crate) fn into_inner(self) -> W {
        self.writer
            .into_inner()
            .unwrap_or_else(|error| error.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(event: &Event) -> String {
        let output = Output::new(Vec::new());
        output.emit(event);
        String::from_utf8(output.into_inner()).unwrap()
    }

    #[test]
    fn events_are_the_contract_lines() {
        assert_eq!(
            line(&Event::SpeechStart { t: 1_732_500_000_000 }),
            "{\"type\":\"speech_start\",\"t\":1732500000000}\n"
        );
        assert_eq!(
            line(&Event::Partial {
                text: "vera can you",
                t: 5
            }),
            "{\"type\":\"partial\",\"text\":\"vera can you\",\"t\":5}\n"
        );
        assert_eq!(
            line(&Event::Final {
                text: "Vera, can you check on the hex thread?",
                start: 1,
                end: 2,
                latency_ms: 40,
            }),
            "{\"type\":\"final\",\"text\":\"Vera, can you check on the hex thread?\",\"start\":1,\"end\":2,\"latency_ms\":40}\n"
        );
        assert_eq!(
            line(&Event::Error { message: "no mic" }),
            "{\"type\":\"error\",\"message\":\"no mic\"}\n"
        );
        let ready = line(&Event::Ready {
            engine: "hex",
            model: "parakeet_unified_en",
            language: "en",
            device: "Microphone",
            backend: "GPU",
            partials: true,
            pause_ms: 700,
        });
        assert!(
            ready.starts_with("{\"type\":\"ready\",\"engine\":\"hex\",\"model\":\"parakeet_unified_en\""),
            "{ready}"
        );
    }

    #[test]
    fn commands_parse_and_garbage_is_reported() {
        assert_eq!(parse_command("{\"cmd\":\"pause\"}"), Some(Ok(Command::Pause)));
        assert_eq!(
            parse_command(" {\"cmd\": \"resume\"}\r"),
            Some(Ok(Command::Resume))
        );
        assert_eq!(
            parse_command("{\"cmd\":\"shutdown\"}"),
            Some(Ok(Command::Shutdown))
        );
        assert_eq!(parse_command("   "), None);
        assert!(matches!(parse_command("{\"cmd\":\"dance\"}"), Some(Err(_))));
        assert!(matches!(parse_command("pause"), Some(Err(_))));
    }
}
