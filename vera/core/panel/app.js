// Vera panel: renders the daemon's state from /ws. No build step.
;(function () {
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  let state = null
  let logLines = []

  function ago(t) {
    if (!t) return ""
    const s = Math.round((Date.now() - t) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.round(s / 60)} min ago`
    return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  }

  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
  }

  function list(el, items, render, empty) {
    el.innerHTML = items.length ? items.map(render).join("") : `<li class="empty">${empty}</li>`
  }

  function render() {
    if (!state) return
    const s = state
    const listening = s.status === "idle" && s.followUpUntil > Date.now() ? "listening" : s.status
    $("orb").className = "orb " + listening
    $("status-word").textContent = listening
    const lat = s.turns.filter((t) => t.firstSpeakMs != null).slice(-1)[0]
    $("meta").textContent = [
      `brain ${s.brain}`,
      `mouth ${s.mouth}`,
      `ears ${s.ears}`,
      lat ? `last reply in ${(lat.firstSpeakMs / 1000).toFixed(1)} s` : "",
      s.queue.length ? `${s.queue.length} queued` : "",
    ]
      .filter(Boolean)
      .join(" · ")
    $("said").textContent = s.lastSaid || "…"
    $("heard").textContent = s.lastHeard || ""
    $("partial").textContent = s.partial || ""
    $("thinking").textContent = s.current ? (s.current.output || "") : ""

    $("cards").innerHTML = s.cards
      .map((c) => `<div class="card"><span class="when">${ago(c.at)}</span><h3>${esc(c.title)}</h3>${window.renderMarkdown(c.markdown)}</div>`)
      .join("")

    list(
      $("inbox"),
      s.inbox,
      (i) => `<li class="${i.read ? "" : "unread"}"><div class="t">${esc(i.title)}</div><div class="s">${esc(i.summary)}</div><div class="s">${ago(i.createdAt)}</div></li>`,
      "Nothing new",
    )
    list(
      $("jobs"),
      s.jobs,
      (j) =>
        `<li class="${j.status}"><div class="t">${esc(j.id)} · ${esc(j.agent)} · ${esc(j.status)}</div><div class="s">${esc(j.task)}</div>` +
        `<div class="s">${esc(j.status === "running" ? j.progress || "working…" : j.result || j.error || "")}</div></li>`,
      "No jobs",
    )
    list(
      $("watches"),
      s.watches,
      (w) => `<li class="${w.lastWaiting ? "waiting" : w.lastStatus === "running" ? "running" : ""}"><div class="t">${esc(w.title)}</div><div class="s">${esc(w.lastWaiting ? "waiting for you" : w.lastStatus)}</div></li>`,
      "Not watching any threads",
    )
  }

  function connect() {
    const ws = new WebSocket(`ws://${location.host}/ws`)
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === "state") {
        state = msg.state
        render()
      } else if (msg.type === "log") {
        logLines.push(msg.line)
        logLines = logLines.slice(-200)
        $("log").textContent = logLines.join("\n")
      }
    }
    ws.onclose = () => {
      $("status-word").textContent = "offline"
      $("orb").className = "orb idle"
      setTimeout(connect, 1500)
    }
  }

  $("ask").addEventListener("submit", (e) => {
    e.preventDefault()
    const text = $("text").value.trim()
    if (!text) return
    $("text").value = ""
    post("/api/utterance", { text, direct: true, source: "panel" })
  })
  $("talk").addEventListener("click", () => {
    post("/api/talk")
    if (state && state.ears === "none") $("text").focus()
  })
  $("stop").addEventListener("click", () => post("/api/stop"))
  $("inbox-read").addEventListener("click", () => post("/api/inbox/read"))
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") post("/api/stop")
  })
  setInterval(render, 1000) // keep "ago" and the follow-up window fresh
  connect()
})()
