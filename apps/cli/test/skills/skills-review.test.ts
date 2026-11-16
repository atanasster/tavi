import { join } from "node:path";

import {
  SKILL_FEEDBACK_MAX_CHARS,
  SKILL_TRACE_CALLS_MAX,
  SKILL_TRACE_INPUT_CHARS,
  condenseSkillTrace,
  skillProposalEditedInto,
  type SkillActor,
} from "@tavi/contracts";
import { SkillService } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { skillsOwnerCommand, type SkillsCommandDependencies, type TaskToolsReader } from "../../src/features/skills/owner.js";
import { EXIT, main } from "../../src/main.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * Reviewing an agent's skill proposal: its source task's tool
 * trace, an edit filed as a new proposed version that follows it, and
 * `tavi skills edit` / `regenerate` from the CLI.
 */

const AT = "2026-10-27T12:00:00.000Z";
const agent: SkillActor = { principalId: "operator", workspaceId: "default", caller: "agent" };
const directories = temporaryDirectories({ prefix: "tavi-skills-review-" });
afterAll(() => directories.cleanup());

async function setup(readTaskTools?: TaskToolsReader) {
  const directory = directories.create();
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const service = new SkillService(store.asPort(), { now: () => AT });
  const deps: SkillsCommandDependencies = {
    service,
    skills: store.asPort().repositories.skills,
    readArtifactBody: async (artifactId) => await store.readArtifactBody(artifactId),
    principalOf: (workspaceId) => (workspaceId === "default" ? "operator" : undefined),
    now: () => "2026-10-27T13:00:00.000Z",
    ...(readTaskTools === undefined ? {} : { readTaskTools }),
  };
  const run = (payload: Parameters<typeof skillsOwnerCommand>[1]) => skillsOwnerCommand(deps, payload);
  /** A proposal as `skills.propose` files it. */
  const propose = (text: string, overrides: { version?: string; files?: string[] } = {}) =>
    service.import({
      actor: agent,
      skillId: "weekly-report",
      version: overrides.version ?? "proposed-20261027120000",
      manifest: {
        name: "Weekly report",
        description: "How the weekly report is written",
        proposal: {
          taskId: "chat-1",
          note: "The person confirmed it",
          requested: true,
          untrusted: { integrity: "untrusted", sources: ["web"], refs: [] },
        },
        ...(overrides.files === undefined ? {} : { files: overrides.files }),
      },
      packageBody: new TextEncoder().encode(text),
      provenance: "chat:chat-1",
      alwaysReview: true,
    });
  return { directory, store, service, run, propose };
}

describe("reviewing an agent's skill proposal", () => {
  it("files an edit as a new proposed version that follows the proposal, keeping where it came from, and sets the proposal aside", async () => {
    const { store, run, propose } = await setup();
    await propose("1. Gather.\n2. Check.");
    const edited = await run({
      action: "edit",
      workspaceId: "default",
      skillId: "weekly-report",
      version: "proposed-20261027120000",
      body: "1. Gather.\n2. Check the totals twice.",
    });
    expect(edited).toMatchObject({
      ok: true,
      result: {
        replaced: "proposed-20261027120000",
        version: {
          version: "edited-20261027130000",
          parentVersion: "proposed-20261027120000",
          reviewState: "proposed",
          provenance: "chat:chat-1",
          manifest: { name: "Weekly report", proposal: { taskId: "chat-1", requested: true, untrusted: { sources: ["web"] } } },
        },
      },
    });
    const versions = await store.asPort().repositories.skills.listVersions({ scopeKey: "default" });
    const original = versions.find((version) => version.version === "proposed-20261027120000");
    expect(original?.reviewState).toBe("rejected");
    // Set aside by the edit, not turned down: no hold on its topic.
    expect(skillProposalEditedInto(original!, versions)).toBe("edited-20261027130000");
    expect(await run({ action: "body", workspaceId: "default", skillId: "weekly-report", version: "edited-20261027130000" })).toMatchObject(
      { ok: true, result: { text: "1. Gather.\n2. Check the totals twice.", parentVersion: "proposed-20261027120000" } },
    );
    // A second edit of the edited version gets its own id, the same second notwithstanding.
    const again = await run({
      action: "edit",
      workspaceId: "default",
      skillId: "weekly-report",
      version: "edited-20261027130000",
      body: "1. Gather.\n2. Check.\n3. Send.",
    });
    expect(again).toMatchObject({ ok: true, result: { version: { version: "edited-20261027130000-2" } } });
    store.close();
  });

  it("refuses an edit that is unchanged, claims allowed-tools, or is not of a waiting proposal", async () => {
    const { store, service, run, propose } = await setup();
    await propose("1. Gather.");
    const edit = (body: string, version = "proposed-20261027120000") =>
      run({ action: "edit", workspaceId: "default", skillId: "weekly-report", version, body });
    expect(await edit("1. Gather.")).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("unchanged") },
    });
    expect(await edit("---\nallowed-tools: Bash\n---\n1. Gather.")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("allowed-tools") },
    });
    expect(await edit(Array.from({ length: 501 }, () => "x").join("\n"))).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    await service.import({
      actor: { ...agent, caller: "cli" },
      skillId: "weekly-report",
      version: "1.0.0",
      manifest: { name: "Weekly report" },
      packageBody: new TextEncoder().encode("operator's own"),
      provenance: "team wiki",
    });
    expect(await edit("changed", "1.0.0")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("not proposed by the agent") },
    });
    await service.reject({ actor: { ...agent, caller: "cli" }, skillId: "weekly-report", version: "proposed-20261027120000" });
    expect(await edit("changed")).toMatchObject({ ok: false, error: { message: expect.stringContaining("only a waiting proposal") } });
    expect(await edit("changed", "missing")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    store.close();
  });

  it("condenses the source task's tool calls for the review, and refuses a task of another workspace", async () => {
    const tools = Array.from({ length: SKILL_TRACE_CALLS_MAX + 2 }, (_, index) => ({
      toolName: index === 0 ? "web_fetch" : "sandbox.run",
      input: index === 0 ? { url: "https://example.com/report", note: "x".repeat(300) } : { command: `step ${index}\n\tnext` },
      status: index === 1 ? ("failed" as const) : ("completed" as const),
    }));
    const asked: string[] = [];
    const reader: TaskToolsReader = async (taskId) => {
      asked.push(taskId);
      return taskId === "chat-1" ? { workspaceId: "default", tools, partial: true } : undefined;
    };
    const { store, run, propose } = await setup(reader);
    await propose("1. Gather.");
    const trace = await run({ action: "trace", workspaceId: "default", skillId: "weekly-report", version: "proposed-20261027120000" });
    expect(asked).toEqual(["chat-1"]);
    const result = (trace as { result: { calls: { toolName: string; input: string; status: string }[]; more: number; partial: boolean } })
      .result;
    expect(result).toMatchObject({ taskId: "chat-1", more: 2, partial: true });
    expect(result.calls).toHaveLength(SKILL_TRACE_CALLS_MAX);
    expect(result.calls[0]?.input.length).toBe(SKILL_TRACE_INPUT_CHARS);
    expect(result.calls[0]?.input.startsWith('{"url":"https://example.com/report"')).toBe(true);
    // One line, white space folded.
    expect(result.calls[1]).toEqual({ toolName: "sandbox.run", input: '{"command":"step 1\\n\\tnext"}', status: "failed" });

    const elsewhere = await setup(async () => ({ workspaceId: "other", tools, partial: false }));
    await elsewhere.propose("1. Gather.");
    expect(
      await elsewhere.run({ action: "trace", workspaceId: "default", skillId: "weekly-report", version: "proposed-20261027120000" }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    elsewhere.store.close();
    store.close();
  });

  it("drops the bidi and format controls a tool call's name or input could reorder its trace line with", () => {
    const { calls } = condenseSkillTrace([
      { toolName: "web\u202efetch", input: "safe \u2066evil\u2069 \u200fend", status: "completed" },
      { toolName: "\u202e", input: undefined, status: "failed" },
    ]);
    expect(calls).toEqual([
      { toolName: "web fetch", input: "safe evil end", status: "completed" },
      { toolName: "?", input: "", status: "failed" },
    ]);
  });
});

describe("tavi skills edit and regenerate", () => {
  it("edits a proposal from a file, and prints how to review the new version", async () => {
    const { directory, store, propose } = await setup();
    await propose("1. Gather.");
    store.close();
    const { writeFileSync } = await import("node:fs");
    const file = join(directory, "edited.md");
    writeFileSync(file, "1. Gather.\n2. Check twice.");
    const out = capture();
    const code = await main(
      ["skills", "edit", "weekly-report", "--version", "proposed-20261027120000", "--package", file, "--data-dir", directory],
      { io: out.io },
    );
    expect(code, out.stderr()).toBe(EXIT.ok);
    expect(out.stdout()).toMatch(/^weekly-report@edited-\d{14} proposed, following proposed-20261027120000 \(set aside\)/);
    const shown = capture();
    const version = /@(edited-\d{14})/.exec(out.stdout())?.[1] ?? "";
    expect(await main(["skills", "show", "weekly-report", "--body", "--version", version, "--data-dir", directory], { io: shown.io })).toBe(
      EXIT.ok,
    );
    // The banner for what the source turn read, and the edited text.
    expect(shown.stdout()).toContain("! Proposed after this chat read a web page. Parts of this text may come from that content");
    expect(shown.stdout()).toContain("2. Check twice.");
  });

  it("needs --package for edit, --feedback for regenerate, and a running owner to send feedback", async () => {
    const directory = directories.create();
    const missing = capture();
    expect(await main(["skills", "edit", "weekly-report", "--version", "v", "--data-dir", directory], { io: missing.io })).toBe(EXIT.usage);
    expect(missing.stderr()).toContain("skills edit needs --package");
    const blank = capture();
    expect(await main(["skills", "regenerate", "weekly-report", "--version", "v", "--data-dir", directory], { io: blank.io })).toBe(
      EXIT.usage,
    );
    expect(blank.stderr()).toContain("skills regenerate needs --feedback");
    const long = capture();
    expect(
      await main(
        [
          "skills",
          "regenerate",
          "weekly-report",
          "--version",
          "v",
          "--feedback",
          "x".repeat(SKILL_FEEDBACK_MAX_CHARS + 1),
          "--data-dir",
          directory,
        ],
        { io: long.io },
      ),
    ).toBe(EXIT.usage);
    expect(long.stderr()).toContain(`at most ${SKILL_FEEDBACK_MAX_CHARS} characters`);
    const offline = capture();
    expect(
      await main(["skills", "regenerate", "weekly-report", "--version", "v", "--feedback", "shorter", "--data-dir", directory], {
        io: offline.io,
      }),
    ).toBe(EXIT.unavailable);
    expect(offline.stderr()).toContain("start `tavi serve` first");
  });
});
