#!/usr/bin/env node
// The skills dictionary, copied from jobs-kit's export into this package's own
// assets/ (git-ignored), where the source reads it when it runs unbundled in
// tests: vitest's global setup for this package runs it before every run, so
// the copy is never missing or stale. `scripts/assemble.mjs` ships the same
// file beside the bundle.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

/** The jobs kit's skills dictionary, as the package is installed. */
export const KIT_DICTIONARY = createRequire(import.meta.url).resolve("@tavi/jobs-kit/skills.json");

/** Copies the kit's dictionary to `assets/skills.json`: vitest's global setup. */
export function setup() {
  mkdirSync(new URL("../assets", import.meta.url), { recursive: true });
  copyFileSync(KIT_DICTIONARY, new URL("../assets/skills.json", import.meta.url));
}
