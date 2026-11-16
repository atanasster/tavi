// The web canvas's bundle, measured: every chunk under `dist/assets/` with its
// raw and gzipped size, the entry chunk (the one `index.html` loads) marked,
// and the first load: the entry, the chunks `index.html` modulepreloads and the
// stylesheets it links, all of which the browser fetches before the canvas
// runs. `pnpm --filter @tavi/ui analyze` builds and prints the table; `--json`
// prints the measurement as JSON instead, which `tests/ui-bundle.test.ts`
// holds to the canvas's budget. The measurement reads the build and writes
// nothing: a file left in `dist/` would ship inside `@tavi/cli`'s `ui-dist/`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const index = join(dist, "index.html");
if (!existsSync(index)) {
  console.error(`analyze: ${dist} has no index.html; run \`pnpm --filter @tavi/ui build\` first`);
  process.exit(1);
}

const html = readFileSync(index, "utf8");
const entry = /<script type="module"[^>]* src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
if (entry === undefined) {
  console.error(`analyze: ${index} loads no module script from /assets/`);
  process.exit(1);
}
// Every asset a `<link>` in index.html fetches up front: modulepreloaded chunks and the entry's stylesheets.
const firstLoad = new Set([entry]);
for (const [link] of html.matchAll(/<link\b[^>]*>/g)) {
  const rel = /\brel="([^"]+)"/.exec(link)?.[1];
  const href = /\bhref="\/assets\/([^"]+)"/.exec(link)?.[1];
  if (href !== undefined && (rel === "modulepreload" || rel === "stylesheet")) firstLoad.add(href);
}

const assets = join(dist, "assets");
const chunks = readdirSync(assets)
  .filter((name) => name.endsWith(".js") || name.endsWith(".css"))
  .map((name) => {
    const bytes = readFileSync(join(assets, name));
    return {
      name,
      bytes: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length,
      entry: name === entry,
      firstLoad: firstLoad.has(name),
    };
  })
  .sort((left, right) => right.gzip - left.gzip);
const scripts = chunks.filter((chunk) => chunk.name.endsWith(".js"));
const report = {
  entry,
  entryGzip: chunks.find((chunk) => chunk.entry)?.gzip ?? 0,
  firstLoad: [...firstLoad],
  firstLoadGzip: chunks.filter((chunk) => chunk.firstLoad).reduce((sum, chunk) => sum + chunk.gzip, 0),
  totalJsGzip: scripts.reduce((sum, chunk) => sum + chunk.gzip, 0),
  totalJsBytes: scripts.reduce((sum, chunk) => sum + chunk.bytes, 0),
  chunks,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  const kib = (size) => `${(size / 1024).toFixed(1)} KiB`.padStart(11);
  for (const chunk of chunks)
    console.log(
      `${kib(chunk.gzip)} gzip ${kib(chunk.bytes)} raw  ${chunk.name}${chunk.entry ? "  (entry)" : chunk.firstLoad ? "  (first load)" : ""}`,
    );
  console.log(`\nentry ${entry}: ${kib(report.entryGzip).trim()} gzipped`);
  console.log(`first load, ${firstLoad.size} files: ${kib(report.firstLoadGzip).trim()} gzipped`);
  console.log(
    `all JavaScript, ${scripts.length} chunks: ${kib(report.totalJsGzip).trim()} gzipped, ${kib(report.totalJsBytes).trim()} raw`,
  );
}
