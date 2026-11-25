//! The voice service client (`VERA.md`, "Voice service contract"):
//! `POST /v1/speech` on localhost answers raw little-endian f32 mono PCM,
//! streamed sentence by sentence, at the rate in `X-Sample-Rate`. Each
//! utterance is fetched on its own thread and fed to the mixer as it
//! arrives, so the first sentence plays while the rest is synthesized.

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::time::Duration;

use serde::Serialize;

use super::mixer::{self, SpeakId};

/// The rate assumed when a response doesn't say.
const DEFAULT_RATE: u32 = 24_000;
/// PCM handed to the mixer at a time: 50 ms at 24 kHz.
const CHUNK_BYTES: usize = 1_200 * 4;

#[derive(Clone)]
pub(crate) struct VoiceClient {
    url: String,
    voice: Option<String>,
    preset: Option<String>,
    agent: ureq::Agent,
}

/// How a fetch ended.
#[derive(Debug)]
pub(crate) enum Fetched {
    Done { id: SpeakId },
    Failed { id: SpeakId, message: String },
}

#[derive(Serialize)]
struct SpeechRequest<'a> {
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    voice: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preset: Option<&'a str>,
}

impl VoiceClient {
    /// `url` is the service's base, for example `http://127.0.0.1:47114`.
    pub(crate) fn new(url: &str, voice: Option<String>, preset: Option<String>) -> Self {
        let agent = crate::net::loopback_agent(|config| {
            config
                .timeout_connect(Some(Duration::from_secs(2)))
                .timeout_recv_body(Some(Duration::from_secs(20)))
        });
        Self {
            url: url.trim_end_matches('/').to_owned(),
            voice,
            preset,
            agent,
        }
    }

    pub(crate) fn url(&self) -> &str {
        &self.url
    }

    /// Whether the service answers its health check as ready.
    pub(crate) fn ready(&self) -> Result<bool, String> {
        let mut response = self
            .agent
            .get(format!("{}/v1/health", self.url))
            .call()
            .map_err(|error| error.to_string())?;
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|error| error.to_string())?;
        let health: serde_json::Value =
            serde_json::from_str(&body).map_err(|error| error.to_string())?;
        Ok(health["ready"].as_bool().unwrap_or(false))
    }

    /// Fetches `text` on a thread of its own, feeding the mixer as PCM
    /// arrives; `cancel` stops it between chunks.
    pub(crate) fn speak(
        &self,
        id: SpeakId,
        text: String,
        mixer: Sender<mixer::Command>,
        done: Sender<Fetched>,
        cancel: Arc<AtomicBool>,
    ) {
        let client = self.clone();
        let spawned = std::thread::Builder::new()
            .name("vera-voice-fetch".into())
            .spawn({
                let id = id.clone();
                let done = done.clone();
                move || {
                    let outcome = client.fetch(&id, &text, &mixer, &cancel);
                    let _ = mixer.send(mixer::Command::End { id: id.clone() });
                    let _ = done.send(match outcome {
                        Ok(()) => Fetched::Done { id },
                        Err(message) => Fetched::Failed { id, message },
                    });
                }
            });
        if let Err(error) = spawned {
            let _ = done.send(Fetched::Failed {
                id,
                message: format!("could not start the fetch: {error}"),
            });
        }
    }

    fn fetch(
        &self,
        id: &SpeakId,
        text: &str,
        mixer: &Sender<mixer::Command>,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let body = serde_json::to_string(&SpeechRequest {
            text,
            voice: self.voice.as_deref(),
            preset: self.preset.as_deref(),
        })
        .map_err(|error| error.to_string())?;
        let response = self
            .agent
            .post(format!("{}/v1/speech", self.url))
            .header("Content-Type", "application/json")
            .send(body)
            .map_err(|error| format!("the voice service at {} failed: {error}", self.url))?;
        let rate = response
            .headers()
            .get("x-sample-rate")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u32>().ok())
            .filter(|rate| (8_000..=192_000).contains(rate))
            .unwrap_or(DEFAULT_RATE);
        let mut reader = response.into_body().into_reader();
        let mut buffer = vec![0u8; CHUNK_BYTES];
        let mut carry: Vec<u8> = Vec::new();
        let mut total = 0usize;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            let read = reader
                .read(&mut buffer)
                .map_err(|error| format!("the voice stream broke: {error}"))?;
            if read == 0 {
                break;
            }
            carry.extend_from_slice(&buffer[..read]);
            let whole = carry.len() / 4 * 4;
            let samples: Vec<f32> = carry[..whole]
                .chunks_exact(4)
                .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
                .map(|sample| if sample.is_finite() { sample.clamp(-1.0, 1.0) } else { 0.0 })
                .collect();
            carry.drain(..whole);
            total += samples.len();
            if !samples.is_empty()
                && mixer
                    .send(mixer::Command::Pcm {
                        id: id.clone(),
                        rate,
                        samples,
                    })
                    .is_err()
            {
                return Ok(());
            }
        }
        if total == 0 {
            return Err("the voice service returned no audio".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// A one-request voice service that answers `samples` at `rate`.
    fn serve(samples: Vec<f32>, rate: u32) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                if line == "\r\n" {
                    break;
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let pcm: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nX-Sample-Rate: {rate}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                pcm.len()
            )
            .unwrap();
            stream.write_all(&pcm).unwrap();
            String::from_utf8(body).unwrap()
        });
        (url, handle)
    }

    #[test]
    fn speech_streams_into_the_mixer_at_the_service_rate() {
        let samples: Vec<f32> = (0..10_000).map(|n| (n as f32 / 10_000.0) - 0.5).collect();
        let (url, server) = serve(samples.clone(), 22_050);
        let client = VoiceClient::new(&url, Some("af_heart".into()), None);
        let (mixer, commands) = mpsc::channel();
        let (done, fetched) = mpsc::channel();
        client.speak(
            "s1".into(),
            "On it.".into(),
            mixer,
            done,
            Arc::new(AtomicBool::new(false)),
        );
        let outcome = fetched.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(matches!(outcome, Fetched::Done { ref id } if &**id == "s1"), "{outcome:?}");
        let request = server.join().unwrap();
        assert_eq!(request, r#"{"text":"On it.","voice":"af_heart"}"#);
        let mut received = Vec::new();
        let mut ended = false;
        for command in commands.try_iter() {
            match command {
                mixer::Command::Pcm { rate, samples, .. } => {
                    assert_eq!(rate, 22_050);
                    received.extend(samples);
                }
                mixer::Command::End { .. } => ended = true,
                other => panic!("{other:?}"),
            }
        }
        assert!(ended);
        assert_eq!(received, samples);
    }

    #[test]
    fn an_unreachable_service_fails_the_utterance() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let client = VoiceClient::new(&url, None, None);
        let (mixer, _commands) = mpsc::channel();
        let (done, fetched) = mpsc::channel();
        client.speak("s2".into(), "Hi.".into(), mixer, done, Arc::new(AtomicBool::new(false)));
        let outcome = fetched.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(matches!(outcome, Fetched::Failed { .. }), "{outcome:?}");
    }
}
