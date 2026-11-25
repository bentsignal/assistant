import type { BrainHarness } from "../config.ts"
import { ClaudeBrain } from "./claude.ts"
import { CodexBrain } from "./codex.ts"
import type { Brain, BrainFactory } from "./types.ts"

export type { Brain, BrainOptions, TurnResult, McpLaunch } from "./types.ts"

/**
 * Brain adapters by harness name. To add one (grok, gemini/Antigravity):
 * implement `Brain` in ./<name>.ts (persistent session, `turn()` resolves at
 * the end of the turn, Vera MCP server passed through the harness's MCP
 * config, built-in tools cut to web search) and register it here. Nothing
 * else in Core needs to change; `set_brain` and config accept the name.
 */
export const BRAINS: Partial<Record<BrainHarness, BrainFactory>> = {
  "claude-code": (o) => new ClaudeBrain(o),
  codex: (o) => new CodexBrain(o),
}

export function availableBrains(): BrainHarness[] {
  return Object.keys(BRAINS) as BrainHarness[]
}

export function createBrain(harness: BrainHarness, opts: Parameters<BrainFactory>[0]): Brain {
  const f = BRAINS[harness]
  if (!f) throw new Error(`no brain adapter for "${harness}" yet (have: ${availableBrains().join(", ")})`)
  return f(opts)
}
