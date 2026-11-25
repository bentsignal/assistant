// pnpm --filter @vera/mouth setup [--all] [--voice id] [--engine kokoro|piper]
// Downloads the configured voice model to ~/.vera/models/. --all also fetches the Piper comparison voice.

import { loadUserMouthConfig, resolveConfig } from "../src/config.ts"
import { ensureModel, packageFor, piperPackage } from "../src/models.ts"
import { resolveFfplay } from "../src/player.ts"
import { spawnSync } from "node:child_process"

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const cfg = resolveConfig({
  ...loadUserMouthConfig(),
  ...(flag("voice") ? { voice: flag("voice") } : {}),
  ...(flag("engine") ? { engine: flag("engine") as "kokoro" | "piper" } : {}),
})

const pkgs = [packageFor(cfg.engine, cfg.voice)]
if (args.includes("--all")) pkgs.push(packageFor("kokoro", "bf_emma"), piperPackage("en_GB-alba-medium"))
const seen = new Set<string>()
for (const pkg of pkgs) {
  if (seen.has(pkg.name)) continue
  seen.add(pkg.name)
  const dir = await ensureModel(cfg.modelsDir, pkg)
  console.log(`ok  ${pkg.name}  ${dir}`)
}

const ffplay = resolveFfplay(cfg.player.command)
const r = spawnSync(ffplay, ["-version"], { encoding: "utf8", windowsHide: true })
if (r.status === 0) console.log(`ok  ffplay  ${ffplay}`)
else {
  console.error(`missing ffplay (${ffplay}). Install ffmpeg: scoop install ffmpeg`)
  process.exitCode = 1
}
