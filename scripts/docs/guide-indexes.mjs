#!/usr/bin/env node
// Writes the how-to guides' indexes (docs/use-cases/README.md and each folder's
// README.md) from the guide pages, and deletes an index whose folder has no
// guide left. tests/use-case-guides.test.ts fails while they are out of date.
//
//   node scripts/docs/guide-indexes.mjs      (pnpm docs:indexes)
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "./browser.mjs";
import { FOLDERS, guidesRoot, indexes } from "./guides.mjs";

const wanted = indexes();
for (const { path, text } of wanted) writeFileSync(join(root, path), text);
const paths = new Set(wanted.map((index) => index.path));
for (const id of [...FOLDERS.map((folder) => folder.id), "everyday"]) {
  const file = join(guidesRoot, id, "README.md");
  const path = `docs/use-cases/${id}/README.md`;
  if (existsSync(file) && !paths.has(path)) {
    rmSync(file);
    console.log(`deleted ${path}`);
  }
}
for (const path of paths) console.log(path);
