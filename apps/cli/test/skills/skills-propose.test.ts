import { join } from "node:path";

import { skillProposalExpired, type SkillActor } from "@tavi/contracts";
import { SkillService, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { SKILLS_PROPOSE_ID, registerSkillProposeTool } from "../../src/features/skills/propose.js";
import { SqliteStore } from "../support/database-fixture.js";

/** `skills.propose`: a procedure offered as a skill, always for review, held to the caps when the person did not ask. */

const AT = "2026-10-27T12:00:00.000Z";
const operator: SkillActor = { principalId: "operator", workspaceId: "default", caller: "cli" };
const directories = temporaryDirectories({ prefix: "tavi-skills-propose-" });
afterAll(() => directories.cleanup());

async function setup(options: { suggestionsOff?: boolean } = {}) {
  const directory = directories.create();
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  // When the service files a proposal: moved back to age the ones already waiting.
  const clock = { at: AT };
  const service = new SkillService(store.asPort(), { now: () => clock.at });
  const registry = new ToolRegistry();
  let tick = 0;
  registerSkillProposeTool(registry, {
    service,
    skills: store.asPort().repositories.skills,
    // Every task is this workspace's, but one named `missing` (unknown) or `elsewhere` (another workspace's).
    tasks: {
      get: async (taskId: string) =>
        taskId === "missing" ? undefined : ({ taskId, workspaceId: taskId === "elsewhere" ? "other" : "default" } as never),
    },
    // Each proposal a second later, so each has its own version.
    now: () => new Date(Date.parse(AT) + (tick += 1) * 1000).toISOString(),
    ...(options.suggestionsOff === true ? { suggestionsOff: async () => true } : {}),
  });
  const propose = async (fields: Record<string, unknown>, chat = "chat-1", tainted = false, contextLabel?: unknown) =>
    (await registry.get(SKILLS_PROPOSE_ID)?.handler({
      input: {
        skillId: "weekly-report",
        name: "Weekly report",
        description: "How the weekly report is written",
        body: "1. Gather the numbers.\n2. Check the totals.",
        evidence: { taskId: chat, note: "The person confirmed the report was right" },
        requested: false,
        ...fields,
      },
      context: { workspaceId: "default", principalId: "operator", runId: chat, chatTaskId: chat, caller: "test" },
      signal: new AbortController().signal,
      ...(tainted ? { operationEnvelope: { tainted: true } } : {}),
      ...(contextLabel === undefined ? {} : { contextLabel }),
    } as never)) as Record<string, unknown>;
  return { store, service, propose, registry, clock };
}

describe("skills.propose", () => {
  it("always lands proposed, with its evidence, even for bytes approved before", async () => {
    const { store, service, propose } = await setup();
    await service.import({
      actor: operator,
      skillId: "weekly-report",
      version: "1.0.0",
      manifest: { name: "Weekly report", supportedRuntimeVersions: [], supportedToolContractVersions: [] },
      packageBody: new TextEncoder().encode("1. Gather the numbers.\n2. Check the totals."),
      provenance: "team wiki",
    });
    await service.approve({ actor: operator, skillId: "weekly-report", version: "1.0.0" });
    await service.activate({ actor: operator, skillId: "weekly-report", version: "1.0.0" });
    const result = await propose({ requested: true });
    expect(result).toMatchObject({ reviewState: "proposed", follows: "1.0.0" });
    const stored = await store.asPort().repositories.skills.getVersion("default", "weekly-report", result["version"] as string);
    expect(stored).toMatchObject({ provenance: "chat:chat-1", parentVersion: "1.0.0", manifest: { proposal: { requested: true } } });
    // Nobody reviewed it yet, whatever was approved before.
    expect(stored).not.toHaveProperty("reviewedBy");
    expect(stored).not.toHaveProperty("reviewedAt");
    store.close();
  });

  it("offers on its own at most once a conversation, never in a tainted turn, and never when suggestions are off", async () => {
    const { store, propose } = await setup();
    await expect(propose({}, "chat-2", true)).rejects.toThrow(/untrusted content/);
    expect(await propose({})).toMatchObject({ reviewState: "proposed" });
    await expect(propose({ skillId: "other-skill" })).rejects.toThrow(/already offered in this conversation/);
    // Asked for, it is taken all the same.
    expect(await propose({ skillId: "other-skill", requested: true })).toMatchObject({ reviewState: "proposed" });
    store.close();
    const off = await setup({ suggestionsOff: true });
    // Refused before any card is shown, and by the handler too.
    const check = (requested: boolean) =>
      off.registry
        .get(SKILLS_PROPOSE_ID)
        ?.checkSources?.(
          { skillId: "weekly-report", name: "n", description: "d", body: "b", evidence: { taskId: "c", note: "ok" }, requested },
          { workspaceId: "default", principalId: "operator", runId: "chat-1", caller: "test" },
          { personTexts: [] },
        );
    expect(await check(false)).toMatchObject({ refused: expect.stringContaining("suggestions off") });
    // Let through, it binds the call to a hash the gate accepts (a SHA-256 hex), or the gate denies every proposal.
    expect(await check(true)).toMatchObject({ statuses: [], contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(off.propose({})).rejects.toThrow(/turned skill suggestions off/);
    expect(await off.propose({ requested: true })).toMatchObject({ reviewState: "proposed" });
    off.store.close();
  });

  it("stops at five waiting, does not offer a topic turned down within 30 days, and refuses scripts' claims", async () => {
    const { store, service, propose } = await setup();
    const first = await propose({ skillId: "turned-down", name: "Turned down" }, "chat-a");
    await service.reject({ actor: operator, skillId: "turned-down", version: first["version"] as string });
    await expect(propose({ skillId: "turned-down" }, "chat-b")).rejects.toThrow(/turned down turned-down/);
    for (const [index, chat] of ["c1", "c2", "c3", "c4", "c5"].entries())
      await propose({ skillId: `s-${index}`, name: `Skill ${index}` }, chat);
    await expect(propose({ skillId: "one-too-many", requested: true }, "c6")).rejects.toThrow(/already wait for review/);
    await expect(propose({ skillId: "x", body: "---\nallowed-tools: Bash\n---\nsteps", requested: true }, "c7")).rejects.toThrow(
      /cannot set allowed-tools/,
    );
    store.close();
  });

  it("lets a proposal waiting past 30 days stop holding a place among the five, without rejecting it", async () => {
    const { store, propose, clock } = await setup();
    clock.at = new Date(Date.parse(AT) - 31 * 86_400_000).toISOString();
    for (const [index, chat] of ["o1", "o2", "o3", "o4", "o5"].entries())
      await propose({ skillId: `old-${index}`, name: `Old ${index}` }, chat);
    clock.at = AT;
    expect(await propose({ skillId: "fresh", requested: true }, "n1")).toMatchObject({ reviewState: "proposed" });
    const versions = await store.asPort().repositories.skills.listVersions({ scopeKey: "default" });
    const old = versions.filter((version) => version.skillId.startsWith("old-"));
    // Still waiting for the person, shown as expired; nothing rejected them.
    expect(old.map((version) => version.reviewState)).toEqual(["proposed", "proposed", "proposed", "proposed", "proposed"]);
    expect(old.every((version) => skillProposalExpired(version, AT))).toBe(true);
    expect(skillProposalExpired(versions.find((version) => version.skillId === "fresh")!, AT)).toBe(false);
    store.close();
  });

  it("matches a turned-down topic by its id or by its name, whatever the case, spacing or punctuation", async () => {
    const { store, service, propose } = await setup();
    const first = await propose({ skillId: "weekly-report", name: "Weekly report" }, "chat-a");
    await service.reject({ actor: operator, skillId: "weekly-report", version: first["version"] as string });
    await expect(propose({ skillId: "report-weekly", name: "  WEEKLY—Report! " }, "chat-b")).rejects.toThrow(/turned down weekly-report/);
    await expect(propose({ skillId: "weeklyreport", name: "Friday numbers" }, "chat-c")).rejects.toThrow(/turned down weekly-report/);
    // Another topic is offered as before, and asking for it lifts the hold.
    expect(await propose({ skillId: "monthly-report", name: "Monthly report" }, "chat-d")).toMatchObject({ reviewState: "proposed" });
    expect(await propose({ skillId: "report-weekly", name: "Weekly report", requested: true }, "chat-e")).toMatchObject({
      reviewState: "proposed",
    });
    store.close();
  });

  it("refuses evidence that names no task this workspace holds", async () => {
    const { store, propose } = await setup();
    for (const taskId of ["missing", "elsewhere"])
      await expect(propose({ requested: true, evidence: { taskId, note: "The person confirmed it" } }, "chat-1")).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining("names no task in this workspace"),
      });
    store.close();
  });

  it("stamps an asked-for proposal in a tainted turn with what the turn read, and names the review command", async () => {
    const { store, propose } = await setup();
    const label = {
      integrity: "untrusted",
      sources: ["web"],
      principals: [],
      confidentiality: "public",
      refs: [{ source: "web", ref: "call-1", host: "example.com", at: AT }],
    };
    const tainted = await propose({ requested: true }, "chat-1", true, label);
    const bare = await propose({ skillId: "bare", name: "Bare", requested: true }, "chat-2", true);
    const clean = await propose({ skillId: "clean", name: "Clean", requested: true }, "chat-3");
    const read = (skillId: string, version: unknown) =>
      store.asPort().repositories.skills.getVersion("default", skillId, version as string);
    expect((await read("weekly-report", tainted["version"]))?.manifest.proposal?.untrusted).toMatchObject({
      integrity: "untrusted",
      sources: ["web"],
      refs: [{ host: "example.com" }],
    });
    // A taint flag without a label reads as an unknown source; a clean turn's carries nothing.
    expect((await read("bare", bare["version"]))?.manifest.proposal?.untrusted).toMatchObject({ sources: ["unknown-source"] });
    expect((await read("clean", clean["version"]))?.manifest.proposal).not.toHaveProperty("untrusted");
    expect(clean["note"]).toContain(`tavi skills show clean --body --version ${clean["version"] as string}`);
    store.close();
  });

  it("does not hold a topic whose proposal the person only set aside by editing it", async () => {
    const { store, service, propose } = await setup();
    const first = await propose({}, "chat-a");
    // What the review's Edit does: a new proposal following it, the first rejected.
    await service.import({
      actor: operator,
      skillId: "weekly-report",
      version: "edited-1",
      manifest: { name: "Weekly report", proposal: { taskId: "chat-a", note: "ok", requested: false } },
      packageBody: new TextEncoder().encode("1. Gather.\n2. Check twice."),
      provenance: "chat:chat-a",
      parentVersion: first["version"] as string,
      alwaysReview: true,
    });
    await service.reject({ actor: operator, skillId: "weekly-report", version: first["version"] as string });
    expect(await propose({}, "chat-b")).toMatchObject({ reviewState: "proposed" });
    store.close();
  });
});
