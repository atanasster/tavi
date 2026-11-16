import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, expect, it } from "vitest";
import { providerCredentialRevision } from "../../src/features/models/credential-revision.js";
const paths = temporaryDirectories();
const temp = () => {
  const path = paths.create("tavi-provider-revision-");
  return path;
};
afterEach(() => paths.cleanup());
it("keeps revisions stable across owners and distinct across values, references and profiles", async () => {
  const path = temp();
  const revision = providerCredentialRevision(path);
  const first = await revision("plugins.exa.a.key", "fixture-secret");
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(await providerCredentialRevision(path)("plugins.exa.a.key", "fixture-secret")).toBe(first);
  expect(await revision("plugins.exa.a.key", "rotated-secret")).not.toBe(first);
  expect(await revision("plugins.exa.b.key", "fixture-secret")).not.toBe(first);
  expect(await revision("plugins.exa.a.key", null)).not.toBe(first);
  expect(await providerCredentialRevision(temp())("plugins.exa.a.key", "fixture-secret")).not.toBe(first);
  expect(statSync(join(path, "provider-bindings.key")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(path, "provider-bindings.key"), "utf8")).not.toContain("fixture-secret");
});
it("refuses an unsafe existing profile key instead of replacing it", async () => {
  const path = temp();
  const target = join(path, "other");
  writeFileSync(target, "a".repeat(64), { mode: 0o600 });
  symlinkSync(target, join(path, "provider-bindings.key"));
  await expect(providerCredentialRevision(path)("plugins.exa.a.key", "secret")).rejects.toThrow();
  expect(readFileSync(target, "utf8")).toBe("a".repeat(64));
});
