import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, expect, it } from "vitest";
import { readWebProviderConfiguration } from "../../src/features/search/provider-config.js";
const paths = temporaryDirectories();
const directory = () => {
  const path = paths.create("tavi-web-selection-");
  return path;
};
afterEach(() => paths.cleanup());
it("reads explicit per-workspace chains with one bounded deadline", () => {
  const path = directory();
  expect(readWebProviderConfiguration(path)).toEqual({ schemaVersion: 1, workspaces: {} });
  writeFileSync(
    join(path, "web-providers.json"),
    JSON.stringify({
      schemaVersion: 1,
      workspaces: {
        home: { search: { providers: ["primary", "backup"] }, fetch: { providers: ["builtin:public-fetch"], timeoutMs: 4000 } },
      },
    }),
  );
  expect(readWebProviderConfiguration(path).workspaces["home"]).toEqual({
    search: { providers: ["primary", "backup"], timeoutMs: 10_000 },
    fetch: { providers: ["builtin:public-fetch"], timeoutMs: 4000 },
  });
});
it.each([
  { providers: ["same", "same"] },
  { providers: ["a", "b", "c", "d", "e"] },
  { providers: ["a"], timeoutMs: 30_001 },
  { providers: [] },
  { providers: ["a"], apiKey: "secret" },
])("refuses malformed selection %j", (selection) => {
  const path = directory();
  writeFileSync(join(path, "web-providers.json"), JSON.stringify({ schemaVersion: 1, workspaces: { home: { search: selection } } }));
  expect(() => readWebProviderConfiguration(path)).toThrow();
});
it("refuses oversized files and symlinks", () => {
  const path = directory();
  const config = join(path, "web-providers.json");
  writeFileSync(config, " ".repeat(65_537));
  expect(() => readWebProviderConfiguration(path)).toThrow(/64 KiB/);
  rmSync(config);
  writeFileSync(join(path, "target"), "{}");
  symlinkSync(join(path, "target"), config);
  expect(() => readWebProviderConfiguration(path)).toThrow();
});
