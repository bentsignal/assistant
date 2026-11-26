#!/usr/bin/env node
// A local stand-in for GitHub's releases API, for testing the updater without publishing
// anything (docs/install.md, "Testing updates locally"). Point the app at it with
// ASSISTANT_UPDATE_API=http://127.0.0.1:<port>.
//
//   node scripts/assistant-fake-feed.mjs <feed dir> [--port 7399]
//
// <feed dir>/<tag>/ is one release: its files are the assets (the package zip, its .sha256,
// manifest.json); an optional release.json sets {"prerelease": true, "draft": false}. Tag
// "nightly" is a prerelease unless release.json says otherwise. Asset downloads answer with a
// 302 to another path first, as GitHub's do, so redirects are exercised.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"

const dir = process.argv[2]
if (!dir || !existsSync(dir)) {
  console.error("usage: assistant-fake-feed.mjs <feed dir> [--port N]")
  process.exit(2)
}
const portArg = process.argv.indexOf("--port")
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 7399
const base = `http://127.0.0.1:${port}`

function release(tag) {
  const folder = join(dir, tag)
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return null
  const meta = existsSync(join(folder, "release.json")) ? JSON.parse(readFileSync(join(folder, "release.json"), "utf8")) : {}
  const assets = readdirSync(folder)
    .filter((name) => name !== "release.json")
    .map((name, i) => ({
      id: i + 1,
      name,
      size: statSync(join(folder, name)).size,
      browser_download_url: `${base}/dl/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    }))
  return {
    tag_name: tag,
    name: tag,
    draft: meta.draft ?? false,
    prerelease: meta.prerelease ?? tag === "nightly",
    html_url: `${base}/releases/${tag}`,
    published_at: statSync(folder).mtime.toISOString(),
    assets,
  }
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(value))
}

createServer((req, res) => {
  const url = new URL(req.url, base)
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  console.log(`${req.method} ${url.pathname}`)
  // /repos/:owner/:repo/releases[/tags/:tag]
  if (parts[0] === "repos" && parts[3] === "releases") {
    if (parts[4] === "tags" && parts[5]) {
      const found = release(parts[5])
      return found ? json(res, 200, found) : json(res, 404, { message: "Not Found" })
    }
    const all = readdirSync(dir)
      .map(release)
      .filter(Boolean)
      .sort((a, b) => b.published_at.localeCompare(a.published_at))
    return json(res, 200, all)
  }
  // /dl/:tag/:name -> 302 -> /files/:tag/:name
  if (parts[0] === "dl" && parts.length === 3) {
    res.writeHead(302, { location: `${base}/files/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}` })
    return res.end()
  }
  if (parts[0] === "files" && parts.length === 3) {
    const file = join(dir, parts[1], parts[2])
    if (!existsSync(file)) return json(res, 404, { message: "Not Found" })
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(file).size })
    return createReadStream(file).pipe(res)
  }
  json(res, 404, { message: "Not Found" })
}).listen(port, "127.0.0.1", () => console.log(`fake release feed for ${dir} on ${base}`))
