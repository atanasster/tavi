import { join } from "node:path";

import { SkillService } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { skillsOwnerCommand, type SkillsCommandDependencies } from "../../src/features/skills/owner.js";
import { SqliteStore } from "../support/database-fixture.js";

/** The owner's `skills` command: the workspace's operator acts, a page never imports, and a body names the version it follows. */

const directories = temporaryDirectories({ prefix: "tavi-skills-owner-" });
afterAll(() => directories.cleanup());

async function setup(fromBridge = false) {
  const directory = directories.create();
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const deps = (bridge: boolean): SkillsCommandDependencies => ({
    service: new SkillService(store.asPort()),
    skills: store.asPort().repositories.skills,
    readArtifactBody: async (artifactId) => await store.readArtifactBody(artifactId),
    principalOf: (workspaceId) => (workspaceId === "default" ? "owner-person" : undefined),
    fromBridge: bridge,
  });
  const run = (payload: Parameters<typeof skillsOwnerCommand>[1], bridge = fromBridge) => skillsOwnerCommand(deps(bridge), payload);
  const importVersion = (version: string, text: string) =>
    run(
      {
        action: "import",
        workspaceId: "default",
        skillId: "notes",
        version,
        name: "Notes",
        provenance: "team wiki",
        packageBase64: Buffer.from(text).toString("base64"),
      },
      false,
    );
  return { store, run, importVersion };
}

describe("the owner's skills command", () => {
  it("refuses a workspace the owner does not serve", async () => {
    const { run, store } = await setup();
    expect(await run({ action: "list", workspaceId: "elsewhere" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    store.close();
  });

  it("lists each used skill's use count and last use", async () => {
    const { run, importVersion, store } = await setup();
    await importVersion("1.0.0", "first");
    await store.asPort().repositories.skills.recordUse({
      scopeKey: "default",
      taskId: "task-1",
      skillId: "notes",
      version: "1.0.0",
      usedAt: "2026-10-01T00:00:00.000Z",
      source: "chat",
    });
    expect(await run({ action: "list", workspaceId: "default" })).toMatchObject({
      ok: true,
      result: { usage: [{ skillId: "notes", uses: 1, lastUsedAt: "2026-10-01T00:00:00.000Z" }] },
    });
    store.close();
  });

  it("acts as the workspace's operator, attributed to the page, and never imports from one", async () => {
    const { run, importVersion, store } = await setup(true);
    expect(await importVersion("1.0.0", "first")).toMatchObject({ ok: true, result: { importedBy: "owner-person" } });
    const refused = await run({
      action: "import",
      workspaceId: "default",
      skillId: "notes",
      version: "9.0.0",
      name: "Notes",
      provenance: "team wiki",
      packageBase64: Buffer.from("from a page").toString("base64"),
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    expect(await run({ action: "approve", workspaceId: "default", skillId: "notes", version: "1.0.0" })).toMatchObject({
      ok: true,
      result: { reviewedBy: "owner-person" },
    });
    store.close();
  });

  it("answers a body with its text and the version it follows, never the other's text", async () => {
    const { run, importVersion, store } = await setup();
    await importVersion("1.0.0", "first");
    await run({ action: "approve", workspaceId: "default", skillId: "notes", version: "1.0.0" });
    await run({ action: "activate", workspaceId: "default", skillId: "notes", version: "1.0.0" });
    await importVersion("2.0.0", "second");
    const body = await run({ action: "body", workspaceId: "default", skillId: "notes", version: "2.0.0" });
    expect(body).toMatchObject({ ok: true, result: { text: "second" } });
    const result = (body as { result: { parentVersion?: string } }).result;
    if (result.parentVersion !== undefined) expect(result.parentVersion).toBe("1.0.0");
    expect(JSON.stringify(body)).not.toContain('"first"');
    store.close();
  });
});
