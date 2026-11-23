import { join } from "node:path";
import { bulgarianPackOf } from "@tavi/test-support/plugin-locales";
import { describe, expect, it } from "vitest";

/** Its Bulgarian language pack: the words a person reads in Bulgarian, what the model reads in English as reviewed. */

const root = join(import.meta.dirname, "..");
const { problems, shown } = bulgarianPackOf(root);

it("discord.channel's Bulgarian pack is named at schemaVersion 3, translates only what a person reads, and shows its channel in Bulgarian", () => {
  // Each field within its length; the tools, which the model reads, left in English.
  expect(problems).toEqual([]);
  expect(shown.channels[0]?.description).toBe("Пиши на агента през собствения си бот в Discord.");
});

describe("the assembler's language packs", () => {
  it("copies only a relative path inside the package and dist-plugin/", async () => {
    // @ts-expect-error -- a plain script with no declarations, imported for its checks.
    const { containedCopy } = (await import("../scripts/assemble.mjs")) as {
      containedCopy: (root: string, out: string, path: string) => { from: string; to: string };
    };
    const out = join(root, "dist-plugin");
    expect(containedCopy(root, out, "locales/bg.json")).toEqual({
      from: join(root, "locales", "bg.json"),
      to: join(out, "locales", "bg.json"),
    });
    for (const path of ["../x.json", "locales/../../x.json", "/etc/passwd", ""])
      expect(() => containedCopy(root, out, path)).toThrow("not a relative path inside the package");
  });
});
