import { defineConfig } from "tsdown";

/**
 * One self-contained module for the worker (PLUGINS.md: no bare imports): the
 * places kit, the domain kit, contracts and zod bundled in, Node's own modules
 * left as they are. `scripts/assemble.mjs` puts the manifest beside it.
 */
export default defineConfig({
  entry: { index: "src/index.ts" },
  outDir: "dist-plugin",
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  clean: true,
  sourcemap: false,
  noExternal: [/.*/],
  // The workspace packages' sources, as their `development` exports name them, not whatever was last built.
  inputOptions: { resolve: { conditionNames: ["development", "import", "node", "default"] } },
  outExtensions: () => ({ js: ".mjs" }),
});
