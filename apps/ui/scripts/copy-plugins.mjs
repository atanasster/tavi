// The built-in UI plugins ship inside the canvas build, under `plugins/<id>/`.
// The bridge serves them only under
// `/plugin-ui/<id>/<hash>/`, for a sandboxed iframe — never as canvas
// documents — and the owner hashes these files as it starts.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BROWSER_VIEW_MANIFEST } from "@tavi/plugin-browser-view/manifest";

const ui = join(dirname(fileURLToPath(import.meta.url)), "..");
/** A built-in UI plugin's built files, found through its package as it is installed, not by the workspace's layout. */
const builtUi = (name) => join(dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`))), "dist", "ui");
const plugins = [{ id: BROWSER_VIEW_MANIFEST.id, from: builtUi("@tavi/plugin-browser-view") }];
for (const plugin of plugins) {
  if (!existsSync(join(plugin.from, "live.html"))) {
    console.error(`copy-plugins: ${plugin.from} is not built; build @tavi/plugin-browser-view first (pnpm run build builds both)`);
    process.exit(1);
  }
  const target = join(ui, "dist", "plugins", plugin.id);
  rmSync(target, { recursive: true, force: true });
  cpSync(plugin.from, target, { recursive: true });
  console.log(`copy-plugins: ${plugin.id} into ${target}`);
}
