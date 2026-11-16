import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

/**
 * One self-contained module (PLUGINS.md: no bare imports): the connector and
 * the channel kit bundled in, Node's own modules left as they are.
 * `@tavi/contracts` resolves to `src/host-shim.ts`, so the bundle holds no
 * second `TaviError` class and none of the contracts barrel:
 * `register` sets the host's own class before it builds the connector. A
 * value import the shim does not provide fails the build; the other value
 * imports from contracts (the channel kit's URL helpers and inbound split, the
 * REST client's repository URL, the shared helpers) come from the
 * zod-free `url-text`, `inbound-parts` and `util` entries.
 * `scripts/assemble.mjs` puts the manifest beside it and holds it to budget.
 */
const HOST_SHIM = fileURLToPath(new URL("./src/host-shim.ts", import.meta.url));

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
  // The bare barrel only: `@tavi/contracts/url-text`, `/inbound-parts` and `/util`, zod-free, are bundled as they are.
  plugins: [{ name: "tavi-host-shim", resolveId: (id: string) => (id === "@tavi/contracts" ? HOST_SHIM : undefined) }],
  inputOptions: { resolve: { conditionNames: ["development", "import", "node", "default"] } },
  outExtensions: () => ({ js: ".mjs" }),
});
