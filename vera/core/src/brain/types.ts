import { EventEmitter } from "node:events"
import type { BrainHarness } from "../config.ts"

/** How the brain harness launches the Vera MCP server. */
export interface McpLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface BrainOptions {
  model?: string
  effort?: string
  /** System prompt text (read fresh from ~/.vera/system-prompt.md at each start). */
  systemPrompt: string
  mcp: McpLaunch
  /** Working directory for the harness (~/.vera/brain). Holds nothing; the brain doesn't touch files. */
  cwd: string
  /** Where adapters may write their own small config files. */
  stateDir: string
  log: (line: string) => void
  /** Resume this harness session id instead of starting a new conversation (if the adapter can). */
  resume?: string
}

export interface TurnResult {
  ok: boolean
  /** The brain's plain text output for this turn. Goes to the panel, never spoken. */
  text: string
  error?: string
  interrupted?: boolean
}

/**
 * One persistent brain session. Adapters emit:
 *  - "text"  (chunk: string)              plain output as it streams
 *  - "tool"  ({name, input})              a tool call started (Vera tools come back through MCP anyway)
 *  - "exit"  (code)                       the harness process died
 */
export interface Brain extends EventEmitter {
  readonly harness: BrainHarness
  readonly label: string
  /** Harness session/thread id, when the adapter can resume it. */
  readonly sessionId?: string
  start(): Promise<void>
  /** Run one user turn to completion. Only one turn at a time. */
  turn(text: string): Promise<TurnResult>
  /** Stop the turn in flight, if any. */
  interrupt(): Promise<void>
  close(): Promise<void>
}

export type BrainFactory = (opts: BrainOptions) => Brain
