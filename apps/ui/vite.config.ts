import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * `rehype-katex`'s HTML parser without its browser build, which parses through
 * the DOM: each of KaTeX's inline styles was then a CSP error in the console.
 */
const htmlParser = {
  find: "hast-util-from-html-isomorphic",
  replacement: createRequire(createRequire(import.meta.url).resolve("rehype-katex")).resolve("hast-util-from-html-isomorphic"),
};

/**
 * A workspace package resolved to its TypeScript sources (its exports'
 * `development` entries, which the tests and the typecheck already read)
 * instead of its built `dist/`. The build of `@tavi/contracts` is one module,
 * so whatever any page used of it landed on the first load; its sources are a
 * module per file, which the lazy pages' chunks can take with them.
 */
function sources(name: string): { find: RegExp; replacement: string }[] {
  const root = new URL(`../../packages/${name}/`, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
    exports: Record<string, { development: string }>;
  };
  return Object.entries(manifest.exports).map(([subpath, entry]) => ({
    find: new RegExp(`^@tavi/${name}${subpath.slice(1).replaceAll("/", "\\/")}$`),
    replacement: fileURLToPath(new URL(entry.development, root)),
  }));
}

/**
 * `build.target` (es2022) as Lightning CSS's browser targets (`major << 16 |
 * minor << 8`), the set Vite's CSS minifier derives from it. The transform
 * reads the same set, so it keeps every fallback the minifier would (the
 * `100vh` before a `100dvh`) and prefixes once.
 */
const es2022 = {
  chrome: 94 << 16,
  edge: 94 << 16,
  firefox: 93 << 16,
  opera: 80 << 16,
  safari: (16 << 16) | (4 << 8),
  ios_saf: (16 << 16) | (4 << 8),
};

/**
 * The canvas `tavi ui` serves: a static bundle under a strict
 * Content Security Policy — `script-src 'self'`, `style-src 'self'` — which
 * the page's shape satisfies (every script and stylesheet a file under
 * `/assets/`, which the artifacts gate checks). CSS is one file; nothing is
 * inlined as a data URL. The module-preload polyfill is off because every
 * browser the canvas targets supports `modulepreload`, not for the CSP.
 * Everything the first load needs is one chunk (the `$initial` group): left
 * to itself the bundler split it into a score of small shared chunks, each
 * compressed on its own. `@tavi/cli`'s build copies `dist/` into its `ui-dist/`.
 * The stylesheets go through Lightning CSS, whose `customMedia` draft writes
 * each `@media (--phone)` out from `styles/breakpoints.css`.
 */
export default defineConfig({
  plugins: [react()],
  base: "/",
  css: { transformer: "lightningcss", lightningcss: { targets: es2022, drafts: { customMedia: true } } },
  resolve: { alias: [...sources("contracts"), ...sources("client"), htmlParser] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: "es2022",
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: "index", tags: ["$initial"] }] } } },
  },
});
