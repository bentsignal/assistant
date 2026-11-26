import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * Updates by voice, through the installed launcher's own CLI
 * (docs/install.md): `assistant update` checks, `assistant update
 * --install` downloads, verifies and switches (the app restarts),
 * `--channel stable|nightly` picks the channel. Core runs from
 * `<root>\versions\<label>\core`, so the install is found from there; a
 * repo or dev build has none, and updates aren't available.
 */
export type Install =
  | { installed: true; root: string; label: string; launcher: string; channel: "stable" | "nightly" }
  | { installed: false; why: string }

/** The install around a Core folder, if it's an installed one. */
export function installOf(coreDir: string, exists: (p: string) => boolean = existsSync): Install {
  const versionDir = dirname(coreDir)
  const versions = dirname(versionDir)
  const root = dirname(versions)
  const launcher = join(root, "assistant.exe")
  if (basename(versions).toLowerCase() !== "versions" || !exists(join(root, "install.json")) || !exists(launcher)) {
    return { installed: false, why: "this is a development build run from the repo, not an installed Assistant, so it can't update itself" }
  }
  const label = basename(versionDir)
  return { installed: true, root, label, launcher, channel: /nightly/i.test(label) ? "nightly" : "stable" }
}

/** The launcher's arguments for a check or an install. */
export function updateArgs(opts: { install?: boolean; channel?: string | null } = {}): string[] {
  const args = ["update"]
  if (opts.install) args.push("--install")
  if (opts.channel) {
    const c = opts.channel.trim().toLowerCase()
    if (c !== "stable" && c !== "nightly") throw new Error(`the channel is stable or nightly (got ${opts.channel})`)
    args.push("--channel", c)
  }
  return args
}

/** What `assistant update` printed, read: the channel's release, and whether it's this one. */
export function readCheck(stdout: string): { latest?: string; upToDate: boolean; available: boolean; none: boolean } {
  const latest = stdout.match(/^(?:Stable|Nightly): (\S+)/m)?.[1]
  return {
    latest,
    upToDate: /up to date/i.test(stdout),
    available: /an update is available/i.test(stdout),
    none: /has no release yet/i.test(stdout),
  }
}

/** Quotes one argument for a Windows command line. */
function winQuote(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
}

/**
 * The command line that runs the install outside Core's process tree: the
 * App kills its job (Core and everything Core started) when it quits for the
 * update, so the install is started by WMI instead, and its output goes to
 * a log.
 */
export function installCommandLine(launcher: string, args: string[], log: string): string {
  const inner = [launcher, ...args].map(winQuote).join(" ")
  return `cmd.exe /d /c "${inner} > ${winQuote(log)} 2>&1"`
}

/** Starts the install detached from the App's job (Windows: WMI's Win32_Process.Create). */
export function startDetached(commandLine: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:ASSISTANT_UPDATE_CMD }; if ($r.ReturnValue -ne 0) { Write-Error "Win32_Process.Create returned $($r.ReturnValue)"; exit 1 }`
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ASSISTANT_UPDATE_CMD: commandLine },
    })
    let err = ""
    child.stderr!.setEncoding("utf8").on("data", (d) => (err += d))
    child.on("error", reject)
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `powershell exited ${code}`))))
  })
}
