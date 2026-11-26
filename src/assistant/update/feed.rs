//! Releases as CI publishes them (`.github/workflows/assistant-release.yml`,
//! `scripts/assistant-publish.sh`) on GitHub: the rolling `nightly`
//! prerelease from `main`, and stable `vX.Y.Z` releases from tags. Each one
//! carries the package zip, its `.sha256`, and `manifest.json` (version,
//! label, channel, commit, date, notes, the zip's name, size, and SHA-256).
//!
//! The repo is public, so nothing here sends credentials. `ASSISTANT_UPDATE_API`
//! points the client at another server with GitHub's routes (the local test
//! feed, `scripts/assistant-fake-feed.mjs`).

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use color_eyre::Result;
use color_eyre::eyre::{WrapErr, bail, eyre};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub(crate) const DEFAULT_REPO: &str = "bentsignal/assistant";
pub(crate) const NIGHTLY_TAG: &str = "nightly";
const MANIFEST: &str = "manifest.json";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum Channel {
    #[default]
    Stable,
    Nightly,
}

impl Channel {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Nightly => "nightly",
        }
    }

    pub(crate) fn parse(key: &str) -> Option<Self> {
        match key {
            "stable" => Some(Self::Stable),
            "nightly" => Some(Self::Nightly),
            _ => None,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Stable => "Stable",
            Self::Nightly => "Nightly",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Clone, Debug, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Clone, Debug, Deserialize)]
struct ManifestAsset {
    name: String,
    size: u64,
    sha256: String,
}

/// `manifest.json`.
#[derive(Clone, Debug, Deserialize)]
struct Manifest {
    version: String,
    label: String,
    channel: String,
    commit: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    notes: String,
    asset: ManifestAsset,
    #[serde(default)]
    voice_lock: String,
}

/// A release this install could switch to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Offer {
    pub(crate) version: String,
    pub(crate) label: String,
    pub(crate) channel: String,
    pub(crate) commit: String,
    pub(crate) date: String,
    /// Markdown: what's new.
    pub(crate) notes: String,
    pub(crate) url: String,
    pub(crate) asset: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    pub(crate) voice_lock: String,
    pub(crate) page: String,
}

impl Offer {
    /// "Nightly abc1234" or "Stable 2.0.0".
    pub(crate) fn title(&self) -> String {
        if self.channel == "nightly" {
            format!("Nightly {}", self.commit.get(..7).unwrap_or(&self.commit))
        } else {
            format!("Stable {}", self.version)
        }
    }

    /// Whether this is exactly the build that's running.
    pub(crate) fn is_running(&self) -> bool {
        self.label == super::stamp::LABEL
    }
}

pub(crate) struct Feed {
    api: String,
    repo: String,
    agent: ureq::Agent,
}

/// `1.2.3` (with an optional leading `v`) as numbers; nothing else counts.
fn semver(tag: &str) -> Option<(u64, u64, u64)> {
    let mut parts = tag.strip_prefix('v')?.split('.');
    let triple = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(triple)
}

impl Feed {
    pub(crate) fn new(repo: &str) -> Self {
        let api = std::env::var("ASSISTANT_UPDATE_API")
            .ok()
            .filter(|api| !api.is_empty())
            .unwrap_or_else(|| "https://api.github.com".into());
        Self {
            api: api.trim_end_matches('/').to_string(),
            repo: repo.to_string(),
            agent: ureq::Agent::config_builder()
                .timeout_connect(Some(Duration::from_secs(15)))
                .timeout_recv_response(Some(Duration::from_secs(30)))
                .user_agent("assistant-updater")
                .http_status_as_error(false)
                .build()
                .into(),
        }
    }

    fn json<T: for<'de> Deserialize<'de>>(&self, url: &str) -> Result<Option<T>> {
        let mut response = self
            .agent
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .call()
            .wrap_err_with(|| format!("could not reach {url}"))?;
        match response.status().as_u16() {
            200 => {}
            404 => return Ok(None),
            403 | 429 => bail!("GitHub is rate limiting update checks; try again later"),
            status => bail!("{url} answered {status}"),
        }
        let text = response.body_mut().read_to_string()?;
        Ok(Some(serde_json::from_str(&text).wrap_err_with(|| {
            format!("{url} didn't answer with what was expected")
        })?))
    }

    fn release(&self, channel: Channel) -> Result<Option<Release>> {
        let base = format!("{}/repos/{}", self.api, self.repo);
        match channel {
            Channel::Nightly => {
                self.json::<Release>(&format!("{base}/releases/tags/{NIGHTLY_TAG}"))
            }
            Channel::Stable => {
                let list: Vec<Release> = self
                    .json(&format!("{base}/releases?per_page=50"))?
                    .unwrap_or_default();
                Ok(list
                    .into_iter()
                    .filter(|r| !r.draft && !r.prerelease)
                    .filter_map(|r| semver(&r.tag_name).map(|v| (v, r)))
                    .max_by_key(|(version, _)| *version)
                    .map(|(_, release)| release))
            }
        }
    }

    /// The channel's current release, if it has one with a Windows package.
    pub(crate) fn latest(&self, channel: Channel) -> Result<Option<Offer>> {
        let Some(release) = self.release(channel)? else {
            return Ok(None);
        };
        let Some(manifest) = release.assets.iter().find(|a| a.name == MANIFEST) else {
            return Ok(None);
        };
        let manifest: Manifest = {
            let mut response = self
                .agent
                .get(&manifest.browser_download_url)
                .call()
                .wrap_err("could not download the release's manifest")?;
            if response.status().as_u16() != 200 {
                bail!(
                    "the release's manifest answered {}",
                    response.status().as_u16()
                );
            }
            let text = response.body_mut().read_to_string()?;
            serde_json::from_str(&text).wrap_err("the release's manifest isn't valid")?
        };
        let asset = release
            .assets
            .iter()
            .find(|a| a.name == manifest.asset.name)
            .ok_or_else(|| eyre!("the release has no {}", manifest.asset.name))?;
        if asset.size != 0 && asset.size != manifest.asset.size {
            bail!("the release's package doesn't match its manifest");
        }
        if manifest.asset.sha256.len() != 64 || !valid_label(&manifest.label) {
            bail!("the release's manifest isn't valid");
        }
        Ok(Some(Offer {
            version: manifest.version,
            label: manifest.label,
            channel: manifest.channel,
            commit: manifest.commit,
            date: manifest.date,
            notes: manifest.notes,
            url: asset.browser_download_url.clone(),
            asset: manifest.asset.name,
            size: manifest.asset.size,
            sha256: manifest.asset.sha256.to_ascii_lowercase(),
            voice_lock: manifest.voice_lock,
            page: release.html_url,
        }))
    }

    /// Downloads `offer`'s package to `dest`, reporting (bytes so far,
    /// total), and keeps it only if its size and SHA-256 match the manifest.
    pub(crate) fn download(
        &self,
        offer: &Offer,
        dest: &Path,
        cancel: &AtomicBool,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<()> {
        let response = self
            .agent
            .get(&offer.url)
            .call()
            .wrap_err("could not start the download")?;
        if response.status().as_u16() != 200 {
            bail!("the download answered {}", response.status().as_u16());
        }
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let part = dest.with_extension("part");
        let mut out = std::fs::File::create(&part)
            .wrap_err_with(|| format!("could not write {}", part.display()))?;
        let mut reader = response.into_body().into_reader();
        let mut hash = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut got = 0u64;
        let mut reported = std::time::Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                drop(out);
                let _ = std::fs::remove_file(&part);
                bail!("cancelled");
            }
            let n = reader.read(&mut buf).wrap_err("the download broke off")?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            hash.update(&buf[..n]);
            got += n as u64;
            if got > offer.size {
                break;
            }
            if reported.elapsed() >= Duration::from_millis(150) {
                reported = std::time::Instant::now();
                progress(got, offer.size);
            }
        }
        out.sync_all()?;
        drop(out);
        let sha256 = hex(&hash.finalize());
        if got != offer.size || sha256 != offer.sha256 {
            let _ = std::fs::remove_file(&part);
            bail!(
                "the download didn't match its checksum ({got} of {} bytes)",
                offer.size
            );
        }
        std::fs::rename(&part, dest)?;
        progress(got, offer.size);
        Ok(())
    }
}

/// A label names a folder: letters, digits, `.`, `-`, `_`, not leading `.`.
pub(crate) fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && !label.starts_with('.')
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A file's SHA-256 as lowercase hex.
pub(crate) fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).wrap_err_with(|| format!("could not open {}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hex(&hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_version_tags_are_stable() {
        assert_eq!(semver("v2.0.1"), Some((2, 0, 1)));
        assert_eq!(semver("v10.0.0"), Some((10, 0, 0)));
        assert_eq!(semver("nightly"), None);
        assert_eq!(semver("v2.0.0-rc.1"), None);
        assert_eq!(semver("2.0.0"), None);
        assert!(semver("v10.0.0") > semver("v9.9.9"));
    }

    #[test]
    fn labels_are_folder_safe() {
        assert!(valid_label("2.0.0-nightly.20261125.abcdef12"));
        assert!(!valid_label(".."));
        assert!(!valid_label("a\\b"));
        assert!(!valid_label(""));
    }
}
