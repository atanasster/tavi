// What the add-on ships besides its code, listed as dist/assets.json (file, sha256, source URL, licence) for the
// licence and release gates. It ships no whisper.cpp binary and no model, so the person brings their own.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "dist", "assets.json"), `${JSON.stringify({ assets: [] }, null, 2)}\n`);
