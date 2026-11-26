import { EventEmitter } from "node:events"
import type { BrainHarness } from "../config.ts"
import type { ResolvedServer } from "../mcp/config.ts"

/** How the brain harness launches the Assistant MCP server. */
export interface McpLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface BrainOptions {
  model?: string
  effort?: string
  /** System prompt text (read fresh from ~/.assistant/system-prompt.md at each start). */
  systemPrompt: string
  mcp: McpLaunch
  /** Her own MCP servers from ~/.assistant/mcp.json (enabled, resolved), beside the Assistant server. */
  servers?: Record<string, ResolvedServer>
  /** Working directory for the harness (~/.assistant/brain). Holds nothing; the brain doesn't touch files. */
  cwd: string
  /** Where adapters may write their own small config files. */
  stateDir: string
  log: (line: string) => void
  /** Resume this harness session id instead of starting a new conversation (if the adapter can). */
  resume?: string
}

export interface TurnResult {
  ok: boolean
  /** The brain's plain text output for this turn. Kept with the turn (GET /api/state), never spoken. */
  text: string
  error?: string
  interrupted?: boolean
}

/**
 * One persistent brain session. Adapters emit:
 *  - "text"  (chunk: string)              plain output as it streams
 *  - "tool"  ({id, name, input})          a tool call started, from any server (Core's tools come back through MCP too)
 *  - "tool_done" ({id, name, result})     that call's result reached the brain (completed, failed, or cancelled)
 *  - "exit"  (code)                       the harness process died
 *  - "mcp"   ([{name, status, error?}])   her own MCP servers' state once the harness connected them
 */
export interface Brain extends EventEmitter {
  readonly harness: BrainHarness
  readonly label: string
  /** Harness session/thread id, when the adapter can resume it. */
  readonly sessionId?: string
  start(): Promise<void>
  /** Run one user turn to completion. Only one turn at a time. */
  turn(text: string): Promise<TurnResult>
  /** Stop the turn in flight, if any. Cancels whatever tool it is running: Core never calls it while one runs. */
  interrupt(): Promise<void>
  /**
   * Adds a user message to the turn in flight without stopping it: the
   * harness hands it to the model at its next step (after the running tools
   * return), and `turn()` resolves only once the model has had it. False
   * when there's no turn, or the adapter can't (Core then waits for the
   * tools and interrupts after).
   */
  steer?(text: string): boolean
  close(): Promise<void>
}

export type BrainFactory = (opts: BrainOptions) => Brain
