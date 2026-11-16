import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** The test support's copy of the trends plugin's routine template stays the plugin's own. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));

describe("the trends-v1 fixture", () => {
  it("is the template the trends plugin's manifest declares", () => {
    const manifest = read("packages/external/trends/tavi-plugin.json") as { readonly routineTemplates?: readonly unknown[] };
    expect(read("packages/test-support/fixtures/trends-v1.json")).toEqual(manifest.routineTemplates?.[0]);
  });
});
