// The viewer's page, its stylesheets (the theme tokens' and its own),
// icon and language packs, beside the script tsdown built, in `dist/ui/`: every file the
// built-in plugin ships, and nothing else (the build-time content hash covers
// exactly these).
import { copyFileSync, cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "dist", "ui");
if (!existsSync(join(target, "live.js"))) {
  console.error("assemble: dist/ui/live.js is missing; tsdown builds it first");
  process.exit(1);
}
for (const file of ["live.html", "plugin-base.css", "live.css", "icon.svg"]) copyFileSync(join(root, "ui", file), join(target, file));
// Its language packs, `locales/<lang>.json`: hashed with the rest, so the owner reads only the ones it shipped.
cpSync(join(root, "locales"), join(target, "locales"), { recursive: true });
console.log(`assemble: ${readdirSync(target).sort().join(", ")}`);
