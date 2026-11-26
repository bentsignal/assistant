// Bundles Core for an install (scripts/assistant-package.sh): src/main.ts and the MCP
// server become dist/main.mjs and dist/mcp-server.mjs, plain ESM for the Node the package
// ships, with no node_modules. prompts/ stays beside dist/ (CORE_DIR is dist/..).
//
//   node scripts/bundle.mjs [outdir]     (default: dist)
import { build } from "esbuild"
import { rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const core = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outdir = resolve(process.argv[2] ?? join(core, "dist"))
rmSync(outdir, { recursive: true, force: true })
await build({
  entryPoints: { main: join(core, "src", "main.ts"), "mcp-server": join(core, "src", "mcp", "server.ts") },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  define: { __ASSISTANT_BUNDLED__: "true" },
  // Some packages still call require(); give ESM output one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
})
