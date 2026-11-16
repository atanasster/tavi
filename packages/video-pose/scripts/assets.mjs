// What the add-on ships besides its code, listed as dist/assets.json (file, sha256, source URL, licence) for the
// licence and release gates. No candidate pose weights' terms passed the
// licence allowlist, so it ships none: the person brings their own model.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "dist", "assets.json"), `${JSON.stringify({ assets: [] }, null, 2)}\n`);
