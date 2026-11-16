import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { TaviError } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { readWebProviderConfiguration } from "../../src/features/search/provider-config.js";

const directories = temporaryDirectories({ prefix: "tavi-provider-config-" });
afterEach(() => directories.cleanup());

describe("a damaged web-providers.json", () => {
  it("is refused in one line naming the file and its first problem, never a validation dump", () => {
    const directory = directories.create();
    for (const [content, problem] of [
      ["{}", /is not a valid search provider file at schemaVersion: /],
      ["{ not json", /is not valid JSON/],
    ] as const) {
      writeFileSync(join(directory, "web-providers.json"), content);
      let caught: unknown;
      try {
        readWebProviderConfiguration(directory);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TaviError);
      expect((caught as TaviError).code).toBe("INVALID_INPUT");
      expect((caught as TaviError).message).toContain(join(directory, "web-providers.json"));
      expect((caught as TaviError).message).toMatch(problem);
      expect((caught as TaviError).message).not.toContain("\n");
    }
  });
});
