import { defineConfig } from "tsdown";

/**
 * Two builds: the manifest, for the owner and the CLI (Node), and the viewer,
 * one browser script with nothing inline and no eval, under its document's
 * CSP. `scripts/assemble.mjs` puts the page, its stylesheets and icon beside
 * the script in `dist/ui/`, which the canvas build ships as
 * `plugins/tavi.browserview/`.
 */
export default defineConfig([
  {
    entry: ["src/manifest.ts"],
    format: ["esm"],
    platform: "node",
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
  },
  {
    entry: { live: "src/live.ts" },
    outDir: "dist/ui",
    format: ["esm"],
    platform: "browser",
    dts: false,
    clean: true,
    sourcemap: false,
    minify: true,
    target: "es2022",
    outExtensions: () => ({ js: ".js" }),
  },
]);
