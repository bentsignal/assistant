/**
 * Updates by voice go through the App's own updater, the same one as
 * Settings › Updates (DESIGN.md): Core sends `{"cmd":"update","id",
 * "action","channel"?}` and the App answers with an `update` event carrying
 * the same `id`. The App's answer is the only truth about an update: these
 * helpers turn it into what the tool returns, and the App's later
 * unsolicited events (`back`, `rolled_back`, `failed`) into what she says.
 */
export type UpdateAction = "status" | "check" | "install" | "channel"

export interface UpdateReply {
  type: "update"
  id?: string
  /** The updater's phase (`up_to_date`, `available`, `checking`, ...), `started`, or `back` / `rolled_back` / `failed` / `unavailable` / `superseded`. */
  state: string
  /** The release label running now. */
  running: string
  channel: "stable" | "nightly"
  /** The release it's about (the channel's current one, or the one that failed). */
  latest?: string
  message?: string
  /** False in a development build (it can check, but not install). */
  installed: boolean
}

/** How long a tool waits for the App's answer: a check talks to GitHub. */
export const UPDATE_TIMEOUT_MS: Record<UpdateAction, number> = { status: 5_000, check: 60_000, install: 90_000, channel: 60_000 }

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/**
 * A release label the way she says it: "version 2.1.0", or for a Nightly
 * (`2.0.0-nightly.20261126.abc1234`) "the November 26 Nightly, build a b c 1"
 * (the commit's first four characters, spelled, so two Nightlies of one day
 * are told apart).
 */
export function speakableVersion(label: string): string {
  const nightly = label.match(/^(\d+\.\d+\.\d+)-nightly\.(\d{4})(\d{2})(\d{2})\.([0-9a-f]+)/i)
  if (nightly) {
    const month = MONTHS[Number(nightly[3]) - 1]
    const day = Number(nightly[4])
    const build = nightly[5].slice(0, 4).toUpperCase().split("").join(" ")
    return `${month ? `the ${month} ${day} Nightly` : "the Nightly"}, build ${build}`
  }
  const plain = label.match(/^\d+\.\d+\.\d+$/)
  return plain ? `version ${label}` : label
}

/** The updater's reason, as one spoken sentence's worth. */
function reasonOf(message: string | undefined): string {
  const one = (message ?? "").replace(/\s+/g, " ").trim()
  if (!one) return "the updater didn't say why"
  return one.length > 160 ? `${one.slice(0, 157)}...` : one
}

/** What she says when a new version confirms it started: from what's actually running. */
export function backLine(reply: UpdateReply): string {
  return `I'm back, on ${speakableVersion(reply.running)}.`
}

/** What she says, once, in the version a failed update rolled back to. */
export function rolledBackLine(reply: UpdateReply): string {
  const failed = reply.latest ? speakableVersion(reply.latest) : "the new version"
  return `The update to ${failed} didn't take, so I'm back on ${speakableVersion(reply.running)}: ${reasonOf(reply.message)}.`
}

/** What she says when an install she started fails (the updater's reason). */
export function failedLine(reply: UpdateReply): string {
  return `The update failed: ${reasonOf(reply.message)}.`
}

const channelName = (c: string) => (c === "nightly" ? "Nightly" : "Stable")

/** The tool's result for an answer (or for no answer: `null`). */
export function describeUpdate(action: UpdateAction, reply: UpdateReply | null): string {
  if (!reply) {
    return `The app's updater hasn't answered yet. Don't say the update failed or worked: you don't know. Say in a few words that you couldn't get an answer from the updater just now.`
  }
  const running = `${reply.running} (${speakableVersion(reply.running)})`
  const latest = reply.latest ? `${reply.latest} (${speakableVersion(reply.latest)})` : "a new release"
  const on = channelName(reply.channel)
  if (action === "status") return statusLine(reply, running, latest, on)
  switch (reply.state) {
    case "started":
      return `Started: the app is installing ${latest} and will restart into it by itself. Speak exactly one short line, like "Updating, back in a moment.", then end the turn. Don't say how long it takes or whether it worked: when you're back you'll say so automatically.`
    case "installing":
      return `An update to ${latest} is already installing; the app restarts into it by itself. Say so in a few words.`
    case "up_to_date":
      return `No update available: ${running} is the newest on ${on}. Say so in a few words.`
    case "no_release":
      return `${on} has no release yet, so there's nothing to install. Say so in a few words.`
    case "available":
      return action === "install"
        ? `${latest} is available but the install didn't start. Say that in one sentence.`
        : `An update is available on ${on}: ${latest} (running ${running}). update_install installs it, restarting you; ask Shawn first if he didn't ask to install.`
    case "failed":
      return `The updater reported a failure: ${reasonOf(reply.message)}. Tell Shawn that reason in one sentence; don't guess at anything else.`
    case "unavailable":
      return `Updates aren't available here: ${reasonOf(reply.message)}. Say so in one sentence.`
    case "superseded":
      return "A newer update request replaced this one. Say nothing about it."
    default:
      return statusLine(reply, running, latest, on)
  }
}

/** The version, the channel, and the updater's phase as it stands. */
function statusLine(reply: UpdateReply, running: string, latest: string, on: string): string {
  return `Running ${running}, updating from ${on}. The updater is ${reply.state.replace(/_/g, " ")}${reply.latest ? ` (${latest})` : ""}${
    reply.message ? `: ${reasonOf(reply.message)}` : ""
  }${reply.installed ? "" : "; this is a development build, which can check but can't install"}. Say the version the way a person would, briefly.`
}

/** The channel tool's result: the switch, then what the check found. */
export function describeChannel(channel: string, reply: UpdateReply | null): string {
  const switched = `Updates now follow ${channelName(channel)}.`
  if (!reply) return `${switched} The check hasn't answered yet. Confirm the switch in a few words.`
  if (reply.state === "failed" && !reply.latest && /channel/.test(reply.message ?? "")) return describeUpdate("channel", reply)
  const news =
    reply.state === "up_to_date"
      ? " It's already on its newest release."
      : reply.state === "available"
        ? ` ${reply.latest} (${speakableVersion(reply.latest ?? "")}) is available there: update_install installs it.`
        : reply.state === "no_release"
          ? " That channel has no release yet."
          : reply.state === "failed"
            ? ` The check failed: ${reasonOf(reply.message)}.`
            : ""
  return `${switched}${news} Confirm in a few words.`
}
