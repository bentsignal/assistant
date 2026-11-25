// Tiny Markdown renderer for panel cards: headings, paragraphs, lists,
// code blocks, inline code, bold, italics, links, and simple tables.
// Escapes HTML first, so card text can't inject markup.
;(function () {
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
  }
  function render(md) {
    const lines = String(md || "").replace(/\r/g, "").split("\n")
    const out = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (/^```/.test(line)) {
        const buf = []
        i++
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
        i++
        out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>")
        continue
      }
      const h = line.match(/^(#{1,4})\s+(.*)/)
      if (h) {
        out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`)
        i++
        continue
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        const rows = []
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++])
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
        let html = "<table>"
        rows.forEach((r, n) => {
          if (/^\s*\|[\s:|-]+\|\s*$/.test(r)) return
          const tag = n === 0 ? "th" : "td"
          html += "<tr>" + cells(r).map((c) => `<${tag}>${inline(c)}</${tag}>`).join("") + "</tr>"
        })
        out.push(html + "</table>")
        continue
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line)
        const items = []
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""))
        const tag = ordered ? "ol" : "ul"
        out.push(`<${tag}>` + items.map((t) => `<li>${inline(t)}</li>`).join("") + `</${tag}>`)
        continue
      }
      if (!line.trim()) {
        i++
        continue
      }
      const para = []
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) para.push(lines[i++])
      out.push("<p>" + inline(para.join(" ")) + "</p>")
    }
    return out.join("\n")
  }
  window.renderMarkdown = render
})()
