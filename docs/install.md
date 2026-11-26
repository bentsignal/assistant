# Installing and updating Assistant

Assistant installs per user, from a GitHub release, and updates itself from
Settings › Updates. Development happens on Winserve ([`dev-setup.md`](dev-setup.md));
GamerBox only runs releases.

## Releases

CI (`.github/workflows/assistant.yml`, on GitHub's `windows-latest`) tests and
packages every push:

| Channel | From | Release |
| --- | --- | --- |
| **Nightly** | every push to `main` | the rolling prerelease `nightly`, replaced each time |
| **Stable** | a tag `vX.Y.Z` (must match `assistant/VERSION`) | release `vX.Y.Z`, GitHub's Latest |

Each release has three files:

- `assistant-<label>-windows-x64.zip`: the whole app. `<label>` is `2.0.0` for
  Stable and `2.0.0-nightly.<commit date>.<commit>` for Nightly.
- `….zip.sha256`
- `manifest.json`: `version`, `label`, `channel`, `commit`, `date`, `notes`
  (what's new), the zip's `name`, `size`, and `sha256`, and `voice_lock` (the
  SHA-256 of the voice service's `uv.lock`).

The zip (`scripts/assistant-package.sh`) holds `assistant.exe` (stamped with its
label, channel, and commit), Core bundled into `core/dist/*.mjs` (no
`node_modules`), a portable `node/node.exe` (Node 22, so Core never depends on
what's installed, like glyphcam bundles what it needs), the voice service's code
with its `pyproject.toml` and `uv.lock`, and `tools/uv.exe`. User data is never
in it.

To cut a Stable release: set `assistant/VERSION` (optionally add
`release-notes/assistant/vX.Y.Z.md`), commit, then `git tag vX.Y.Z && git push
origin vX.Y.Z`. The repo is public, so builds run on GitHub's runners and the
app downloads releases without signing in.

## The install

```text
%LOCALAPPDATA%\Programs\Assistant\
  assistant.exe          the launcher: starts versions\<current>\assistant.exe
  install.json           {current, previous, pending, failed}
  versions\<label>\      one whole release each: assistant.exe, core\, node\, voice\, tools\
  downloads\             a release being fetched
```

- **Start at login** (HKCU `Run`, value `Assistant`) and the Start Menu shortcut
  run the launcher, `"…\Programs\Assistant\assistant.exe" --hidden`, so they
  follow updates. The app rewrites the Run value to the launcher whenever it
  applies start at login, which also moves an old repo-build entry over.
- **User data stays in `~/.assistant`** and updates never touch it: `config.json`,
  `system-prompt.md` and its history, logs, jobs, the inbox, `voices\` (Shawn's
  own voices), and `models\` (Qwen3-TTS; Parakeet in `models\stt` when Hex isn't
  installed).
- **The voice venv** is made from the release's `uv.lock` by its own `uv.exe`
  (`uv sync --frozen --no-install-project`; the service's code runs from the
  release). One venv per lock: `~/.assistant/voice/venv` (the one `setup.ps1`
  made) is adopted when it was synced from the same lock, and a release with a
  new lock gets `~/.assistant/voice/envs/<lock hash>`, made beside the running
  one before the switch. Updates whose lock didn't change make nothing. Envs no
  kept version uses are removed once an update confirms; `venv` never is.
- An installed copy ignores `app.repo`, `app.core.entry`, and the repo checkout:
  it runs its own Core and voice service. `app.core.command` and
  `app.voiceService.command`, if set, still win (the installer warns).

## Updating (Settings › Updates)

Settings shows this build ("2.0.0 · Nightly abc1234"), a **Stable / Nightly**
switch, the channel's state, and one button: **Check for updates**, **Update**,
or **Switch to Stable 2.0.0**, with download progress and what's new. The app
also checks by itself 90 s after launch and every 6 hours (`app.updates.check`),
and an available update adds "Update to …" to the tray menu and a quiet green
dot on the tray icon (`app.updates.trayBadge: false` turns the dot off). No
sound.

The channel's current release is offered whenever it **isn't the running
build**, newer or older: switching from Nightly to Stable offers the latest
Stable even if it's older, so getting back to a known-good version is one click.
The channel is `app.updates.channel` (`stable` or `nightly`; unset, the build's
own channel).

What Update does (`src/assistant/update/`):

1. Downloads the zip into `downloads\` and keeps it only if its size and SHA-256
   match the manifest.
2. Unpacks it into `versions\<label>` (through a `.partial` folder) and checks it
   names that label; makes the voice env if its lock is new. The running version
   keeps running through all of this.
3. Starts the **running version's own exe** as a supervisor
   (`assistant update-apply`) and quits cleanly (Core, the brain, and the voice
   service stop with it).
4. The supervisor waits for it to exit, makes the new version current (pending),
   and starts it.
5. The new version confirms once Core has run 8 s and the voice service is ready
   (or has run 25 s). Confirming keeps the old version as `previous`, copies
   itself over the launcher, and removes older versions and unused voice envs.
6. If the new version exits first or doesn't confirm within 150 s, the supervisor
   stops it, makes the old version current again, starts it, and records why in
   `install.json` (`failed`); Settings says so for a day. If the supervisor itself
   didn't survive (a restart mid-update), the launcher rolls back a version that
   was launched twice without confirming. A missing version folder falls back on
   `previous`.

Nothing ever deletes the version that's running or the one before it, so there's
always a working copy. Logs: `~/.assistant/logs/updater.log` (the launcher, the
supervisor, downloads) and `assistant-app.log`.

From a terminal: `assistant update` checks, `assistant update --install` does
the whole switch (`--channel stable|nightly`).

## Installing (any PC)

`scripts/install-assistant.ps1` installs a release from scratch, per user, no
admin rights: it downloads the release, checks its SHA-256, quits any running
Assistant, unpacks it into `versions\<label>`, runs `assistant.exe install-self`
(voice env, `install.json`, launcher, Start Menu shortcut), points start at login
at the launcher (removing the old `Vera` value), and starts it. It never touches
`~/.assistant`. Run it again to repair or reinstall.

```powershell
irm https://raw.githubusercontent.com/bentsignal/assistant/main/scripts/install-assistant.ps1 -OutFile $env:TEMP\install-assistant.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\install-assistant.ps1              # latest Stable (Nightly if none yet)
powershell -ExecutionPolicy Bypass -File $env:TEMP\install-assistant.ps1 -Channel nightly
```

Options: `-Tag v2.0.0`, `-Root <folder>`, `-Zip <zip> -Manifest <manifest.json>`
(a package on disk), `-NoStart`, `-NoLogin`.

## GamerBox: moving from the repo build (for the orchestrator)

GamerBox runs `D:\dev\assistant\target\release\assistant.exe`, started at login
by HKCU `Run` › `Assistant`, with its data in `C:\Users\<Shawn>\.assistant` (the
voice venv made by `setup.ps1`, the models, config, voices). The install below
keeps all of that and makes the installed copy the one that runs. Run it in a
normal (not admin) PowerShell, as Shawn:

1. **Check there's a release:** `gh release list -R bentsignal/assistant` shows
   `nightly` (and, once tagged, `vX.Y.Z`).
2. **Note the current state** (to roll back by hand if ever needed):
   ```powershell
   Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run | Select-Object Assistant, Vera
   Test-Path $HOME\.assistant\voice\venv\Scripts\pythonw.exe
   ```
3. **Install** (Nightly until the first Stable exists; it quits the running repo
   build itself):
   ```powershell
   irm https://raw.githubusercontent.com/bentsignal/assistant/main/scripts/install-assistant.ps1 -OutFile $env:TEMP\install-assistant.ps1
   powershell -ExecutionPolicy Bypass -File $env:TEMP\install-assistant.ps1 -Channel nightly
   ```
   It prints the old and new start-at-login commands. The first run syncs
   `~\.assistant\voice\venv` to the release's lock in place (quick when the repo's
   lock is the same; a few minutes if packages changed) and marks it.
4. **Check it:**
   ```powershell
   Get-Content "$env:LOCALAPPDATA\Programs\Assistant\install.json"
   (Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run).Assistant
   #   "C:\Users\<Shawn>\AppData\Local\Programs\Assistant\assistant.exe" --hidden
   Get-Process assistant | Select-Object Path   # …\Programs\Assistant\versions\<label>\assistant.exe
   ```
   In Settings: the footer and Updates say the installed version, the status line
   turns green once the voice has loaded (about 20 s), and the channel switch
   matches.
5. **If `config.json` has `app.core.command` or `app.voiceService.command`**
   (the installer warns), remove them so the installed Core and voice run. Leave
   `app.repo` alone; installs ignore it.
6. The repo checkout at `D:\dev\assistant` is no longer used and can stay or go;
   don't build there any more (development is on Winserve).

**Undo** (back to the repo build): quit Assistant from the tray, then
`Set-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run Assistant '"D:\dev\assistant\target\release\assistant.exe" --hidden'`
and start that exe. `~/.assistant` is unchanged either way (the venv only gained
a `.assistant-lock` marker). **Uninstall:** quit it, delete
`%LOCALAPPDATA%\Programs\Assistant`, the Start Menu `Assistant` shortcut, and the
`Run` value.
