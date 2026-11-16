import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConnectableApp, ToolRule } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it, vi } from "vitest";

import { pageRuleId } from "../../src/features/apps/permissions.js";
import { APPS_SHARING_SETTING } from "../../src/features/apps/sharing.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { appsOwnerCommand, mcpCommand } from "../../src/server/config-commands.js";
import { EXIT, main } from "../../src/main.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** Connected apps on a real owner: the household rule, owner-wide page rules, `apps list`. */

const RAW = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp"), "raw-server.mjs");
const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  directories.cleanup();
});

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

/** An owner with one unsandboxed MCP server, approved, enabled and allowed in `default`. */
async function ownerWithServer(): Promise<TaviRuntime> {
  const data = directories.create("tavi-apps-owner-");
  const at = ["--data-dir", data];
  const server = directories.create("tavi-apps-raw-");
  writeFileSync(join(server, "raw.mjs"), readFileSync(RAW));
  expect((await tavi(["mcp", "add", "raw", "--dir", server, "--unsandboxed", ...at, "--", "node", "raw.mjs"])).code).toBe(EXIT.ok);
  expect(
    (await tavi(["mcp", "approve", "mcp.raw", "1.0.0", "--unsandboxed", "--effect", "connect=external", "--disable", "write", ...at])).code,
  ).toBe(EXIT.ok);
  expect((await tavi(["plugins", "enable", "mcp.raw", ...at])).code).toBe(EXIT.ok);
  expect((await tavi(["mcp", "on", ...at])).code).toBe(EXIT.ok);
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(data, {
      workspaces: [
        { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
        { workspaceId: "other", principalId: "operator", permissions: ["tools.invoke"] },
      ],
    }),
    { modelOverride: createFixtureModel({ turns: [{ text: "done" }] }) },
  );
  runtimes.push(runtime);
  return runtime;
}

describe("the household rule on the owner", () => {
  it("withholds a Personal account from other people and group chats, and refuses lending it", async () => {
    const runtime = await ownerWithServer();
    const offered = async (context: { workspaceId: string; operator?: boolean; memoryReach?: "chat-only" }) =>
      (await runtime.tools.listOffered(context)).map((tool) => tool.id).filter((id) => id.startsWith("mcp."));
    const echo = runtime.tools.get("mcp.raw.echo");
    const call = { workspaceId: "default", principalId: "bob", runId: "task-1", caller: "test" };
    // Lent to people while Shared (its default: the server declares no personal data).
    expect((await mcpCommand(runtime, { action: "people", pluginId: "mcp.raw", on: true, workspaceId: "default" }, "operator")).ok).toBe(
      true,
    );
    expect(await offered({ workspaceId: "default", operator: false })).toContain("mcp.raw.echo");
    // Marked Personal: withheld from the person at once, at offer and at call time, and from a group chat's turn.
    await runtime.store.setMeta(APPS_SHARING_SETTING, JSON.stringify({ "mcp.raw": "personal" }), nowTimestamp());
    expect(await offered({ workspaceId: "default", operator: false })).toEqual([]);
    await expect(echo?.handler({ input: { text: "x" }, context: call, signal: new AbortController().signal })).rejects.toThrow(
      /not offered here/,
    );
    expect(await offered({ workspaceId: "default", operator: true })).toContain("mcp.raw.echo");
    expect(await offered({ workspaceId: "default", operator: true, memoryReach: "chat-only" })).toEqual([]);
    await expect(
      echo?.handler({
        input: { text: "x" },
        context: { ...call, principalId: "operator", memoryReach: "chat-only" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not offered here/);
    // Lending it again is refused; marking it Shared from the page lets people use it again.
    expect(
      await mcpCommand(runtime, { action: "people", pluginId: "mcp.raw", on: true, workspaceId: "default" }, "operator"),
    ).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    const listed = await appsOwnerCommand(runtime, { action: "list", workspaceId: "default" }, "operator:ui");
    if (!listed.ok) throw new Error(listed.error.message);
    const app = (listed.result as { readonly apps: readonly ConnectableApp[] }).apps.find((candidate) => candidate.appId === "mcp.raw");
    expect(app?.repairs).toContainEqual(expect.objectContaining({ kind: "sharing", accountId: "mcp.raw" }));
    expect(
      (
        await appsOwnerCommand(
          runtime,
          { action: "sharing", appId: "mcp.raw", accountId: "mcp.raw", sharing: "shared", workspaceId: "default" },
          "operator:ui",
        )
      ).ok,
    ).toBe(true);
    expect(await offered({ workspaceId: "default", operator: false })).toContain("mcp.raw.echo");
  }, 120_000);
});

describe("apps on the owner", () => {
  it("lists the server as an app, and keeps the page's rules owner-wide and its own", async () => {
    const runtime = await ownerWithServer();
    const listed = await appsOwnerCommand(runtime, { action: "list", workspaceId: "default" }, "operator:ui");
    if (!listed.ok) throw new Error(listed.error.message);
    const app = (listed.result as { readonly apps: readonly ConnectableApp[] }).apps.find((candidate) => candidate.appId === "mcp.raw");
    expect(app).toMatchObject({
      name: "raw",
      health: "ready",
      source: { kind: "mcp", pluginIds: ["mcp.raw"], isolation: "unsandboxed" },
      egress: { anyNetwork: true },
    });
    expect(app?.tools.map((tool) => tool.toolId)).toContain("mcp.raw.echo");
    expect(app?.tools.find((tool) => tool.toolId === "mcp.raw.write")).toMatchObject({
      state: "disabled",
      decision: "block",
      canSetHere: [],
    });

    // Block from the page: one owner-wide rule, in force in every workspace.
    const blocked = await appsOwnerCommand(
      runtime,
      { action: "permission", appId: "mcp.raw", toolId: "mcp.raw.echo", target: "block", workspaceId: "default" },
      "operator:ui",
    );
    expect(blocked.ok).toBe(true);
    const ruleIds = async (workspaceId: string) => (await runtime.toolRulesInForce(workspaceId)).map((rule) => rule.ruleId);
    expect(await ruleIds("default")).toContain(pageRuleId("mcp.raw.echo"));
    expect(await ruleIds("other")).toContain(pageRuleId("mcp.raw.echo"));
    // A page still cannot add a rule through `permissions`, and the store refuses `*` for anything but the page's own.
    const toolPolicy = runtime.store.asPort().repositories.toolPolicy;
    const stray: ToolRule = {
      ruleId: "stray",
      workspaceId: "*",
      toolPattern: "web_fetch",
      decision: "deny",
      source: "operator",
      createdBy: "x",
      createdVia: "cli",
      createdAt: nowTimestamp(),
    };
    await expect(toolPolicy.putRule(stray)).rejects.toThrow(/names its workspace/);
    // Allow on a read undoes the page's own Block, from either workspace's view, and the owner logs who did.
    const logged = vi.spyOn(runtime.logger, "info");
    expect(
      (
        await appsOwnerCommand(
          runtime,
          { action: "permission", appId: "mcp.raw", toolId: "mcp.raw.echo", target: "allow", workspaceId: "default" },
          "operator:ui",
        )
      ).ok,
    ).toBe(true);
    expect(await ruleIds("other")).not.toContain(pageRuleId("mcp.raw.echo"));
    expect(logged).toHaveBeenCalledWith("a Connected apps page removed its own tool rule", {
      ruleId: pageRuleId("mcp.raw.echo"),
      workspaceId: "*",
      actor: "operator:ui",
    });
    // Allow on an external write is never the page's to give.
    expect(
      await appsOwnerCommand(
        runtime,
        { action: "permission", appId: "mcp.raw", toolId: "mcp.raw.connect", target: "allow", workspaceId: "default" },
        "operator:ui",
      ),
    ).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    // Listing rules from both workspaces sees an owner-wide rule once (uniqueRules).
    expect(
      (
        await appsOwnerCommand(
          runtime,
          { action: "permission", appId: "mcp.raw", toolId: "mcp.raw.connect", target: "block", workspaceId: "default" },
          "operator:ui",
        )
      ).ok,
    ).toBe(true);
    const merged = [...(await toolPolicy.listRules("default")), ...(await toolPolicy.listRules("other"))];
    const { uniqueRules } = await import("@tavi/contracts");
    expect(uniqueRules(merged).filter((rule) => rule.ruleId === pageRuleId("mcp.raw.connect"))).toHaveLength(1);
  }, 120_000);
});
