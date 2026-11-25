/**
 * Her voices, as the voice service lists them (`GET /v1/voices`) at the
 * moment she's asked: voices come and go, so nothing here is fixed. The
 * choice is the App's `app.voice` in config.json; Core saves it and tells
 * the App (`{"cmd":"voice"}`), which uses it from the next line.
 */

export interface VoiceInfo {
  id: string
  name: string
  description?: string
  gender?: string
  accent?: string
}

export interface VoiceList {
  /** The service's own default voice. */
  default?: string
  voices: VoiceInfo[]
}

/** Reads `/v1/voices` (the object form, a bare list, or a list of ids), keeping only voices that can run here. */
export function parseVoices(body: unknown): VoiceList {
  const raw: unknown[] = Array.isArray(body) ? body : Array.isArray((body as any)?.voices) ? (body as any).voices : []
  const voices: VoiceInfo[] = []
  for (const v of raw) {
    if (typeof v === "string") voices.push({ id: v, name: v })
    else if (v && typeof v === "object" && typeof (v as any).id === "string" && (v as any).available !== false) {
      const o = v as any
      voices.push({
        id: o.id,
        name: typeof o.name === "string" && o.name ? o.name : o.id,
        ...(typeof o.description === "string" ? { description: o.description } : {}),
        ...(typeof o.gender === "string" ? { gender: o.gender } : {}),
        ...(typeof o.accent === "string" ? { accent: o.accent } : {}),
      })
    }
  }
  const def = typeof (body as any)?.default === "string" ? (body as any).default : undefined
  return { default: def, voices }
}

export async function fetchVoices(port: number, timeoutMs = 4000): Promise<VoiceList> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}/v1/voices`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new Error(`the voice service isn't answering (${(err as Error).message})`)
  }
  if (!res.ok) throw new Error(`the voice service answered ${res.status}`)
  return parseVoices(await res.json())
}

/**
 * Which voice `wanted` names: an id or name (any case, "the Eli voice"
 * works), or "next"/"previous" from `current` around the list.
 */
export function pickVoice(list: VoiceInfo[], wanted: string, current?: string): VoiceInfo {
  if (!list.length) throw new Error("the voice service lists no voices")
  const w = wanted.trim().toLowerCase().replace(/[.!?]+$/, "")
  const at = Math.max(
    0,
    list.findIndex((v) => v.id === current),
  )
  const known = current !== undefined && list.some((v) => v.id === current)
  if (w === "next") return list[known ? (at + 1) % list.length : 0]
  if (w === "previous" || w === "prev" || w === "last") return list[known ? (at - 1 + list.length) % list.length : list.length - 1]
  const exact = list.find((v) => v.id.toLowerCase() === w || v.name.toLowerCase() === w)
  if (exact) return exact
  const words = w.split(/[^a-z0-9_-]+/).filter(Boolean)
  const loose = list.find((v) => words.includes(v.id.toLowerCase()) || words.includes(v.name.toLowerCase()))
  if (loose) return loose
  throw new Error(`no voice called "${wanted}"; have ${list.map((v) => v.name).join(", ")}`)
}

/** One line per voice for the brain, the current one marked. */
export function describeVoices(list: VoiceInfo[], current?: string): string {
  return list
    .map((v) => {
      const bits = [v.gender, v.accent, v.description].filter(Boolean).join(", ")
      return `${v.id === current ? "* " : "- "}${v.name} (id ${v.id})${bits ? `: ${bits}` : ""}`
    })
    .join("\n")
}
