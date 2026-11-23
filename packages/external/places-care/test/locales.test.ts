import { join } from "node:path";
import { bulgarianPackOf } from "@tavi/test-support/plugin-locales";
import { expect, it } from "vitest";

/** Its Bulgarian language pack: the words a person reads in Bulgarian, what the model reads in English as reviewed. */

const { problems, shown } = bulgarianPackOf(join(import.meta.dirname, ".."));

it("places.care's Bulgarian pack is named at schemaVersion 3, translates only what a person reads, and shows its app's name in Bulgarian", () => {
  // Each field within its length; the tools, which the model reads, left in English.
  expect(problems).toEqual([]);
  expect(shown.apps?.apps[0]?.name).toBe("Места: здраве");
});
