import { join } from "node:path";

import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { DEFAULT_WORKSPACE_ID, type ToolRule } from "@tavi/contracts";
import { capture, temporaryDirectories } from "@tavi/test-support";

import { SqliteStore } from "../support/database-fixture.js";
import { afterAll, describe, expect, it } from "vitest";

import { pageRuleId } from "../../src/features/apps/permissions.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { createOwnerChatGrants, lastingChat } from "../../src/runtime/chat-scope.js";
import { EXIT, main } from "../../src/main.js";
import type { RuntimeFactory } from "../../src/cli/runtime-options.js";
import { permissionsCommand } from "../../src/features/permissions/owner.js";

/**
 * Tool rules decide calls before a round exists, driven end to end
 * through `main()` like `approvals.test.ts`: a stored deny refuses a call with
 * no round, a stored allow runs it with none, and a rule stored while a round
 * waits does not change that round.
 */

const directories = temporaryDirectories({ prefix: "tavi-tool-policy-" });
afterAll(() => directories.cleanup());

async function openStore(directory: string): Promise<SqliteStore> {
  return await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
}

async function storeRule(directory: string, rule: Pick<ToolRule, "ruleId" | "toolPattern" | "decision">): Promise<void> {
  const store = await openStore(directory);
  try {
    await store.asPort().repositories.toolPolicy.putRule({
      ...rule,
      workspaceId: DEFAULT_WORKSPACE_ID,
      source: "operator",
      createdBy: "operator",
      createdVia: "cli",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
  } finally {
    store.close();
  }
}

function browserModel(finalText: string): RuntimeFactory {
  const model = createFixtureModel({
    turns: [{ toolCall: { id: "call-1", name: "browser.create_session", input: {} } }, { text: finalText }],
  });
  return (options) => composeTaviRuntime(options, { modelOverride: model, browserOverride: createFixtureBrowser() });
}

const RUN = ["run", "--connection", "fixture-conn", "--model", "fixture-model", "--approval", "ask", "--format", "json"];

async function pendingApprovals(directory: string): Promise<readonly { record: { taskId: string; toolId: string; summary?: string } }[]> {
  const listed = capture();
  expect(await main(["approvals", "list", "--format", "json", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
  return (JSON.parse(listed.stdout()) as { rows: readonly { record: { taskId: string; toolId: string } }[] }).rows;
}

describe("tool rules", () => {
  it("refuses a call a stored deny rule names, with no round", async () => {
    const directory = directories.create();
    // The store exists only once a command opened the directory.
    expect(await main(["approvals", "list", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    await storeRule(directory, { ruleId: "no-browser", toolPattern: "browser.*", decision: "deny" });

    const run = capture();
    const code = await main([...RUN, "--data-dir", directory, "open a browser"], {
      io: run.io,
      runtimeFactory: browserModel("refused, so answered without it"),
    });
    expect(code, run.stderr()).toBe(EXIT.ok);
    expect(run.stdout()).toContain("refused, so answered without it");
    expect(await pendingApprovals(directory)).toEqual([]);
  });

  it("runs a gated call a stored allow rule covers, with no round", async () => {
    const directory = directories.create();
    expect(await main(["approvals", "list", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    await storeRule(directory, { ruleId: "browser-ok", toolPattern: "browser.create_session", decision: "allow" });

    const run = capture();
    const code = await main([...RUN, "--data-dir", directory, "open a browser"], {
      io: run.io,
      runtimeFactory: browserModel("opened by rule"),
    });
    expect(code, run.stderr()).toBe(EXIT.ok);
    expect(run.stdout()).toContain("opened by rule");
    expect(await pendingApprovals(directory)).toEqual([]);
  });

  it("keeps a waiting round's gate when a rule is stored while it waits", async () => {
    const directory = directories.create();
    const runtimeFactory = browserModel("decided by the round");
    const run = capture();
    expect(await main([...RUN, "--data-dir", directory, "open a browser"], { io: run.io, runtimeFactory }), run.stderr()).toBe(
      EXIT.approvalRequired,
    );
    const [pending] = await pendingApprovals(directory);
    expect(pending?.record.toolId).toBe("browser.create_session");

    // An allow stored now must not dissolve the round: its resume value is
    // matched to the interrupt the node raised, from the checkpointed verdict.
    await storeRule(directory, { ruleId: "late-allow", toolPattern: "browser.create_session", decision: "allow" });
    const decided = capture();
    const code = await main(
      ["approvals", "reject", pending!.record.taskId, "--connection", "fixture-conn", "--model", "fixture-model", "--data-dir", directory],
      { io: decided.io, runtimeFactory },
    );
    expect(code, decided.stderr()).toBe(EXIT.ok);
    const store = await openStore(directory);
    try {
      const rows = await store.asPort().repositories.approvals.listForTask(pending!.record.taskId);
      expect(rows.map((row) => row.state)).toEqual(["denied"]);
      expect((await store.asPort().repositories.tasks.get(pending!.record.taskId))?.status).toBe("completed");
    } finally {
      store.close();
    }
  });

  it("adds, lists and removes rules, lists and revokes grants, and refuses what it must (tavi permissions)", async () => {
    const directory = directories.create();
    const run = async (...args: string[]) => {
      const out = capture();
      const code = await main(["permissions", ...args, "--data-dir", directory], { io: out.io });
      return { code, stdout: out.stdout(), stderr: out.stderr() };
    };
    expect((await run("add", "--tool", "*", "--decision", "allow")).code).toBe(EXIT.usage);
    const stale = await run("add", "--tool", "web.search", "--decision", "allow");
    expect(stale.code).toBe(EXIT.usage);
    expect(stale.stderr).toMatch(/web_search, web_fetch, or web_\*/);
    const added = await run(
      "add",
      "--tool",
      "sandbox.run",
      "--match",
      "make *",
      "--decision",
      "allow",
      "--note",
      "builds are fine",
      "--format",
      "json",
    );
    expect(added.code, added.stderr).toBe(EXIT.ok);
    const ruleId = (JSON.parse(added.stdout) as { rule: { ruleId: string } }).rule.ruleId;
    const listed = await run("list");
    // A table: the rule's columns padded on one line, its note indented on the next.
    expect(listed.stdout).toMatch(new RegExp(`^${ruleId} +allow +sandbox\\.run matching make \\* +yours\\n {4}builds are fine$`, "m"));
    expect(listed.stdout).toMatch(/^shipped-messaging-send +allow +messaging\.send +shipped with tavi$/m);
    expect((await run("rm", "shipped-messaging-send")).stderr).toMatch(/shipped with tavi/);
    expect((await run("rm", ruleId)).stdout).toBe(`removed ${ruleId}: allow sandbox.run matching make *\n`);
    expect((await run("rm", ruleId)).code).not.toBe(EXIT.ok);
    expect((await run("grants")).stdout).toBe("(no chat grants)\n");
  });

  it("says which listed rule holds in every workspace, as a Connected apps page's own rule does, and not of a workspace's own", async () => {
    const directory = directories.create();
    const store = await openStore(directory);
    try {
      await store.asPort().repositories.toolPolicy.putRule({
        ruleId: pageRuleId("mcp.raw.echo"),
        workspaceId: "*",
        toolPattern: "mcp.raw.echo",
        decision: "deny",
        source: "operator",
        createdBy: "operator",
        createdVia: "bridge",
        createdAt: "2026-10-16T00:00:00.000Z",
      });
    } finally {
      store.close();
    }
    expect(
      await main(["permissions", "add", "--tool", "sandbox.run", "--decision", "allow", "--data-dir", directory], { io: capture().io }),
    ).toBe(EXIT.ok);
    const out = capture();
    expect(await main(["permissions", "list", "--data-dir", directory], { io: out.io })).toBe(EXIT.ok);
    expect(out.stdout()).toMatch(new RegExp(`^${pageRuleId("mcp.raw.echo")} +deny +mcp\\.raw\\.echo +yours, all workspaces$`, "m"));
    expect(
      out
        .stdout()
        .split("\n")
        // The operator's own, not the shipped read-only rule beside it.
        .find((line) => / allow +sandbox\.run +/.test(line) && !line.startsWith("shipped-")),
    ).toMatch(/ yours$/);
  });

  it("stores an allow rule that covers lines no rule can read only when asked to, and warns of a broad glob", async () => {
    const directory = directories.create();
    const out = capture();
    const code = await main(
      [
        "permissions",
        "add",
        "--tool",
        "sandbox.run",
        "--decision",
        "allow",
        "--match",
        "*test*",
        "--match-unparsed",
        "--data-dir",
        directory,
      ],
      { io: out.io },
    );
    expect(out.stderr()).toBe("");
    expect(code).toBe(EXIT.ok);
    expect(out.stdout()).toMatch(/lines no rule can read included/);
    expect(out.stdout()).toMatch(/note: \*test\* also matches every command/);
    const wrong = capture();
    expect(
      await main(["permissions", "add", "--tool", "sandbox.run", "--decision", "deny", "--match-unparsed", "--data-dir", directory], {
        io: wrong.io,
      }),
    ).not.toBe(EXIT.ok);
    expect(wrong.stderr()).toMatch(/takes --decision allow/);
  });

  it("refuses a page's rule, and lets it list and remove", async () => {
    const store = await openStore(directories.create());
    try {
      const repositories = store.asPort().repositories;
      const deps = {
        repositories,
        rulesInForce: async (workspaceId: string) => await repositories.toolPolicy.listRules(workspaceId),
        now: () => "2026-09-27T00:00:00.000Z",
        chatGrants: createOwnerChatGrants(repositories, () => "2026-09-27T00:00:00.000Z"),
        fromBridge: true,
        via: "bridge" as const,
      };
      expect(
        await permissionsCommand(deps, {
          action: "add",
          workspaceId: "default",
          toolPattern: "web_search",
          decision: "allow",
          createdBy: "operator",
        }),
      ).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
      expect(await permissionsCommand(deps, { action: "rules", workspaceId: "default" })).toEqual({ ok: true, result: { rules: [] } });
      // Removing a deny widens what runs unasked: refused from a page. Removing an allow narrows it.
      const stored = async (decision: "allow" | "deny") =>
        await repositories.toolPolicy.putRule({
          ruleId: `r-${decision}`,
          workspaceId: "default",
          toolPattern: "sandbox.run",
          decision,
          source: "operator",
          createdBy: "operator",
          createdVia: "cli",
          createdAt: "2026-09-27T00:00:00.000Z",
        });
      await stored("deny");
      await stored("allow");
      expect(await permissionsCommand(deps, { action: "remove", workspaceId: "default", ruleId: "r-deny" })).toMatchObject({
        ok: false,
        error: { code: "NOT_AUTHORIZED" },
      });
      expect(await permissionsCommand(deps, { action: "remove", workspaceId: "default", ruleId: "r-allow" })).toMatchObject({
        ok: true,
        // The removed rule is named in the answer, as `add` names the one it stored.
        result: { removed: true, rule: { ruleId: "r-allow", decision: "allow" } },
      });
      expect(await permissionsCommand(deps, { action: "revoke", workspaceId: "default", grantId: "missing" })).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    } finally {
      store.close();
    }
  });

  it("lists a Home's grant made before ends existed with its end, and not once it lapsed", async () => {
    const store = await openStore(directories.create());
    try {
      const repositories = store.asPort().repositories;
      await repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "operator",
        operationKey: "op-home",
        kind: "start",
        origin: "ipc",
        chatKind: "home",
        intent: { prompt: "hello" },
        checkpointNamespace: "",
        newTaskId: "home-1",
        newAdmissionId: "adm-1",
        newThreadId: "thread-1",
        now: "2026-10-03T00:00:00.000Z",
      });
      const legacy = { taskId: "home-1", workspaceId: "default", toolId: "sandbox.run", approvalId: "a1", createdBy: "operator" };
      await repositories.toolPolicy.addSessionGrant({ ...legacy, grantId: "g-fresh", createdAt: "2026-10-04T06:00:00.000Z" });
      await repositories.toolPolicy.addSessionGrant({ ...legacy, grantId: "g-lapsed", createdAt: "2026-10-03T06:00:00.000Z" });
      const at = "2026-10-05T00:00:00.000Z";
      const deps = {
        repositories,
        rulesInForce: async () => [],
        now: () => at,
        chatGrants: createOwnerChatGrants(repositories, () => at),
        fromBridge: false,
        via: "cli" as const,
      };
      expect(await permissionsCommand(deps, { action: "grants", workspaceId: "default" })).toMatchObject({
        ok: true,
        result: { grants: [{ grantId: "g-fresh", expiresAt: "2026-10-05T06:00:00.000Z" }] },
      });
      expect(await permissionsCommand(deps, { action: "grants", workspaceId: "default", taskId: "home-1" })).toMatchObject({
        ok: true,
        result: { grants: [{ grantId: "g-fresh" }] },
      });
      // The same judgement the inbox's "Allow until tomorrow" reads.
      expect(await lastingChat(repositories, "home-1")).toBe(true);
      expect(await lastingChat(repositories, "no-such-task")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("grants a session scope from `tavi approvals approve --scope session`", async () => {
    const directory = directories.create();
    const runtimeFactory = browserModel("opened for the session");
    const run = capture();
    expect(await main([...RUN, "--data-dir", directory, "open a browser"], { io: run.io, runtimeFactory }), run.stderr()).toBe(
      EXIT.approvalRequired,
    );
    const [pending] = await pendingApprovals(directory);
    const decided = capture();
    const code = await main(
      [
        "approvals",
        "approve",
        pending!.record.taskId,
        "--scope",
        "session",
        "--connection",
        "fixture-conn",
        "--model",
        "fixture-model",
        "--data-dir",
        directory,
      ],
      { io: decided.io, runtimeFactory },
    );
    expect(code, decided.stderr()).toBe(EXIT.ok);
    const store = await openStore(directory);
    try {
      expect(
        (await store.asPort().repositories.toolPolicy.listSessionGrants(pending!.record.taskId)).map((grant) => grant.toolId).sort(),
      ).toEqual(["browser.capture", "browser.create_session", "browser.navigate"]);
    } finally {
      store.close();
    }
    const grants = capture();
    expect(await main(["permissions", "grants", "--task", pending!.record.taskId, "--data-dir", directory], { io: grants.io })).toBe(
      EXIT.ok,
    );
    // A browser decision that named no site grants no click, typing or submit, and opening a
    // site only for calls that name none: a call that names one is asked about on its own host.
    expect(grants.stdout()).toContain("browser.capture (any call)");
    expect(grants.stdout()).not.toContain("browser.act");
    // One decision, revoked whole: no browser tool keeps a grant of it.
    const reopened = await openStore(directory);
    let first: string;
    try {
      first = (await reopened.asPort().repositories.toolPolicy.listSessionGrants(pending!.record.taskId))[0]!.grantId;
    } finally {
      reopened.close();
    }
    const revoked = capture();
    expect(await main(["permissions", "revoke", first, "--data-dir", directory], { io: revoked.io }), revoked.stderr()).toBe(EXIT.ok);
    const after = await openStore(directory);
    try {
      expect(await after.asPort().repositories.toolPolicy.listSessionGrants(pending!.record.taskId)).toEqual([]);
    } finally {
      after.close();
    }
  });
});
