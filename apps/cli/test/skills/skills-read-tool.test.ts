import { join } from "node:path";

import { TOOL_LABEL_KEY, type SkillActor } from "@tavi/contracts";
import { SkillService, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { SKILLS_READ_ID, SKILLS_SEARCH_ID, SKILL_READ_PAGE_BYTES, registerSkillTools } from "../../src/features/skills/tools.js";
import { SqliteStore } from "../support/database-fixture.js";

/** `skills.read`: an active, approved skill's body, in the caller's workspace only, as reference text. */

const AT = "2026-01-01T00:00:00.000Z";
const actor: SkillActor = { principalId: "operator", workspaceId: "default", caller: "cli" };
const directories = temporaryDirectories({ prefix: "tavi-skills-read-" });
afterAll(() => directories.cleanup());

async function setup() {
  const directory = directories.create();
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const skills = new SkillService(store.asPort(), { now: () => AT });
  const add = async (skillId: string, body: string, provenance = "local-cli", workspaceId = "default") => {
    const as = { ...actor, workspaceId };
    await skills.import({
      actor: as,
      skillId,
      version: "1.0.0",
      manifest: { name: `${skillId} helper`, supportedRuntimeVersions: [], supportedToolContractVersions: [] },
      packageBody: new TextEncoder().encode(body),
      provenance,
    });
    await skills.approve({ actor: as, skillId, version: "1.0.0" });
    await skills.activate({ actor: as, skillId, version: "1.0.0" });
  };
  const registry = new ToolRegistry();
  const port = store.asPort();
  registerSkillTools(registry, { skills: port.repositories.skills, rollout: port.repositories.skillRollout, artifacts: store });
  const tool = registry.get(SKILLS_READ_ID);
  const read = async (input: unknown, workspaceId = "default", runId = "task-1") =>
    (await tool?.handler({
      input,
      context: { workspaceId, principalId: "operator", runId, caller: "test" },
      signal: new AbortController().signal,
    })) as Record<string, unknown>;
  return { store, skills, add, read, tool, port };
}

describe("skills.read", () => {
  it("is read-only and returns the active body as reference text, in pages", async () => {
    const { add, read, tool, store } = await setup();
    expect(tool?.effect).toBe("read-only");
    await add("reporting", `# Weekly report\n${"step ".repeat(5_000)}`);
    const first = await read({ skillId: "reporting", maxChars: 1_000 });
    expect(first).toMatchObject({ skillId: "reporting", version: "1.0.0", name: "reporting helper", offset: 0, nextOffset: 1_000 });
    expect(first["text"]).toMatch(/^# Weekly report/);
    expect(first["note"]).toMatch(/not a permission/);
    expect(first).not.toHaveProperty(TOOL_LABEL_KEY);
    const next = await read({ skillId: "reporting", offset: 1_000, maxChars: 1_000 });
    expect(next["offset"]).toBe(1_000);
    // The pages join back to the whole body, and the last has no nextOffset.
    let joined = "";
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await read({ skillId: "reporting", offset, maxChars: 24_000 });
      joined += page["text"] as string;
      offset = page["nextOffset"] as number | undefined;
    }
    expect(joined).toBe(`# Weekly report\n${"step ".repeat(5_000)}`);
    store.close();
  });

  it("records each task's use of a version once, as metadata, and nothing for a refused read", async () => {
    const { add, read, port, store } = await setup();
    await add("reporting", "# Weekly report\nsteps");
    await read({ skillId: "reporting" });
    await read({ skillId: "reporting", offset: 3 });
    await read({ skillId: "reporting" }, "default", "task-2");
    await expect(read({ skillId: "missing" })).rejects.toThrow(/no active skill/);
    const usage = await port.repositories.skills.listUsage("default");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ skillId: "reporting", uses: 2 });
    const rows = store.handle.prepare("SELECT * FROM tavi_skill_uses").all() as Record<string, unknown>[];
    expect(rows.map((row) => row["source"])).toEqual(["chat", "chat"]);
    expect(JSON.stringify(rows)).not.toContain("Weekly report");
    store.close();
  });

  it("keeps a page of multi-byte text under its byte cap", async () => {
    const { add, read, store } = await setup();
    await add("emoji", "🙂".repeat(20_000));
    const page = await read({ skillId: "emoji", maxChars: 24_000 });
    expect(Buffer.byteLength(page["text"] as string)).toBeLessThanOrEqual(SKILL_READ_PAGE_BYTES);
    expect(page["nextOffset"]).toBeDefined();
    store.close();
  });

  it("refuses bytes that are not the approved ones, or not UTF-8", async () => {
    const { add, store, port } = await setup();
    await add("tampered", "approved words");
    await add("binary", "placeholder");
    const registry = new ToolRegistry();
    registerSkillTools(registry, {
      skills: port.repositories.skills,
      rollout: port.repositories.skillRollout,
      artifacts: {
        getArtifact: async (id) => store.getArtifact(id),
        readArtifactBody: async (id) => {
          const version = await port.repositories.skills.getVersion("default", "tampered", "1.0.0");
          return id === version?.packageArtifactId ? new TextEncoder().encode("other words") : store.readArtifactBody(id);
        },
      },
    });
    const call = (input: unknown) =>
      registry.get(SKILLS_READ_ID)?.handler({
        input,
        context: { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" },
        signal: new AbortController().signal,
      });
    await expect(call({ skillId: "tampered" })).rejects.toThrow(/unavailable or changed/);
    store.close();
  });

  it("reads only an active skill of the caller's own workspace", async () => {
    const { add, read, skills, store } = await setup();
    await add("elsewhere", "other workspace", "local-cli", "other");
    await expect(read({ skillId: "elsewhere" })).rejects.toThrow(/no active skill elsewhere/);
    await add("retired", "gone soon");
    await skills.disable({ actor, skillId: "retired" });
    await expect(read({ skillId: "retired" })).rejects.toThrow(/no active skill retired/);
    store.close();
  });

  it("keeps a version under a bounded rollout to the tasks it allows", async () => {
    const { add, read, port, store } = await setup();
    await add("canary", "only for some");
    await port.repositories.skillRollout.allow({
      entryId: "e1",
      scopeKey: "default",
      skillId: "canary",
      version: "1.0.0",
      taskId: "task-allowed",
      authorizedBy: "operator",
      authorizedAt: AT,
    });
    await expect(read({ skillId: "canary" }, "default", "task-other")).rejects.toThrow(/no active skill canary/);
    expect((await read({ skillId: "canary" }, "default", "task-allowed"))["text"]).toBe("only for some");
    store.close();
  });

  it("labels a skill whose provenance is not the operator's as untrusted", async () => {
    const { add, read, store } = await setup();
    await add("proposed", "from a chat", "chat:task-9");
    expect((await read({ skillId: "proposed" }))[TOOL_LABEL_KEY]).toEqual({ untrusted: true, source: "agent" });
    await add("archive", "from outside", "archive:clawhub");
    expect((await read({ skillId: "archive" }))[TOOL_LABEL_KEY]).toEqual({ untrusted: true, source: "unknown-source" });
    // The operator words their own import's provenance: it stays trusted.
    await add("wiki", "from the team wiki", "team wiki");
    expect(await read({ skillId: "wiki" })).not.toHaveProperty(TOOL_LABEL_KEY);
    store.close();
  });
});

describe("skills.search", () => {
  it("finds active skills of the caller's workspace by their words, best first, and nothing else", async () => {
    const { add, store, port, skills } = await setup();
    await add("expenses", "steps");
    await add("expense-audit", "steps");
    await add("weekly-status", "steps");
    await add("other-expenses", "steps", "local-cli", "other");
    await add("retired-expenses", "steps");
    await skills.disable({ actor, skillId: "retired-expenses" });
    const registry = new ToolRegistry();
    registerSkillTools(registry, { skills: port.repositories.skills, rollout: port.repositories.skillRollout, artifacts: store });
    const search = async (query: string) =>
      (await registry.get(SKILLS_SEARCH_ID)?.handler({
        input: { query },
        context: { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" },
        signal: new AbortController().signal,
      })) as { skills: { skillId: string }[]; note?: string };
    expect(registry.get(SKILLS_SEARCH_ID)?.effect).toBe("read-only");
    expect((await search("expense audit")).skills.map((skill) => skill.skillId)).toEqual(["expense-audit", "expenses"]);
    expect(await search("gardening")).toEqual({ skills: [], note: "no active skill matches: go on without one" });
    // A rollout that leaves this task out hides the skill, as the listing does.
    await add("canary-expenses", "steps");
    await port.repositories.skillRollout.allow({
      entryId: "e1",
      scopeKey: "default",
      skillId: "canary-expenses",
      version: "1.0.0",
      taskId: "task-other",
      authorizedBy: "operator",
      authorizedAt: AT,
    });
    // A version proposed but not approved is never found.
    await skills.import({
      actor,
      skillId: "draft-expenses",
      version: "1.0.0",
      manifest: { name: "draft-expenses helper", supportedRuntimeVersions: [], supportedToolContractVersions: [] },
      packageBody: new TextEncoder().encode("draft"),
      provenance: "local-cli",
    });
    expect((await search("expenses")).skills.map((skill) => skill.skillId)).toEqual(["expenses"]);
    // A skill another author wrote comes back labelled as their words.
    await add("chat-expenses", "steps", "chat:task-9");
    expect(await search("chat expenses")).toMatchObject({ [TOOL_LABEL_KEY]: { untrusted: true, source: "agent" } });
    store.close();
  });
});
