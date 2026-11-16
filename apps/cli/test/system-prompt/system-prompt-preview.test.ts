import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  SystemPromptPreviewSchema,
  type AgentDefinition,
  type AgentsListResult,
  type ModelPort,
  type SystemPromptPreview,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { DEFAULT_SYSTEM_PROMPT, SHIPPED_SYSTEM_PROMPT_VERSION } from "@tavi/agent-host/system-prompt";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { loadBetterSqlite3 } from "../../../../packages/runtime/src/persistence/sqlite-loader.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `system-prompt preview` and the persona editor's compare-and-set: the layers a new task's prompt is
 * built from, answered by the owner and offline, and `agents update` refusing a
 * stale `expectedUpdatedAt`.
 */

const directories = temporaryDirectories({ prefix: "tavi-preview-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

const answering = (): ModelPort => ({
  async stream(request, options) {
    options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "ok" });
    return { status: "completed", attemptId: request.attemptId, text: "ok", toolCalls: [], usage: {} };
  },
});

async function owner(): Promise<{ readonly handle: ServeHandle; readonly client: IpcClient; readonly directory: string }> {
  const directory = directories.create();
  const handle = await serve(
    fixtureServeOptions(directory),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
    { modelOverride: answering() },
  );
  handles.push(handle);
  const discovered = await findLiveOwner(directory);
  if (discovered === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return { handle, client, directory };
}

describe("parsing tavi system-prompt preview", () => {
  it("takes an optional agent and refuses the write flags", () => {
    expect(parseArgs(["system-prompt", "preview"])).toEqual({
      command: "system-prompt",
      systemPrompt: { action: "preview", format: "text" },
    });
    // --format is every command's too (d101ea5): it is parsed once, globally, as well as for the preview.
    expect(parseArgs(["system-prompt", "preview", "--agent", "sdaddy", "--format", "json"])).toEqual({
      command: "system-prompt",
      format: "json",
      systemPrompt: { action: "preview", agentId: "sdaddy", format: "json" },
    });
    expect(() => parseArgs(["system-prompt", "preview", "--expected-revision", "1"])).toThrow(UsageError);
    expect(() => parseArgs(["system-prompt", "show", "--agent", "sdaddy"])).toThrow(/does not accept --agent/);
  });
});

describe("tavi system-prompt preview offline", () => {
  it("lists the shipped default, then the generated facts and context, with lengths", async () => {
    const directory = directories.create();
    const shown = capture();
    expect(await main(["system-prompt", "preview", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toContain(`base     Shipped default (${SHIPPED_SYSTEM_PROMPT_VERSION}) — ${DEFAULT_SYSTEM_PROMPT.length} chars\n`);
    expect(shown.out()).toContain("facts    Runtime facts — generated per call\n");
    expect(shown.out()).toContain("context  Memory and skills context — generated per call, 0 active skills\n");
    expect(shown.out()).toContain("Sample runtime facts");

    const json = capture();
    expect(await main(["system-prompt", "preview", "--format", "json", "--data-dir", directory], { io: json.io })).toBe(EXIT.ok);
    const preview = SystemPromptPreviewSchema.parse(JSON.parse(json.out()));
    expect(preview).toMatchObject({
      workspaceId: "default",
      overridden: false,
      shippedLength: DEFAULT_SYSTEM_PROMPT.length,
      baseText: DEFAULT_SYSTEM_PROMPT,
    });
    expect(preview.layers.at(-1)).toMatchObject({ kind: "context", skills: 0 });
  });

  it("counts the workspace's active skills on the context layer", async () => {
    const directory = directories.create();
    const pkg = join(directory, "package.bin");
    writeFileSync(pkg, "package v1");
    const quiet = capture();
    expect(
      await main(
        [
          "skills",
          "import",
          "reporting",
          "--version",
          "1.0.0",
          "--package",
          pkg,
          "--name",
          "Reporting",
          "--provenance",
          "test",
          "--data-dir",
          directory,
        ],
        { io: quiet.io },
      ),
    ).toBe(EXIT.ok);
    // Imported and approved, but not yet active: not counted.
    expect(await main(["skills", "approve", "reporting", "--version", "1.0.0", "--data-dir", directory], { io: quiet.io })).toBe(EXIT.ok);
    const before = capture();
    expect(await main(["system-prompt", "preview", "--format", "json", "--data-dir", directory], { io: before.io })).toBe(EXIT.ok);
    expect(SystemPromptPreviewSchema.parse(JSON.parse(before.out())).layers.at(-1)).toMatchObject({ skills: 0 });

    expect(await main(["skills", "activate", "reporting", "--version", "1.0.0", "--data-dir", directory], { io: quiet.io })).toBe(EXIT.ok);
    const shown = capture();
    expect(await main(["system-prompt", "preview", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toContain("context  Memory and skills context — generated per call, 1 active skill\n");
  });
});

describe("system-prompt preview on a live owner", () => {
  it("strikes the shipped default under an override, appends an agent's persona, and marks the facts a sample", async () => {
    const { client, directory } = await owner();
    const added = await client.request(
      "agents",
      { action: "add", agentId: "sdaddy", name: "Chief of staff", prompt: "  You are sdaddy.\n" },
      "add",
    );
    expect(added.ok).toBe(true);
    const custom = "My base.\n";
    expect(
      (await client.request("system-prompt", { action: "set", workspaceId: "default", text: custom, expectedRevision: 0 }, "set")).ok,
    ).toBe(true);

    const answer = await client.request("system-prompt", { action: "preview", agentId: "sdaddy" }, "preview");
    expect(answer.ok).toBe(true);
    const preview = SystemPromptPreviewSchema.parse(answer.result) as SystemPromptPreview;
    expect(preview).toMatchObject({
      workspaceId: "default",
      agentId: "sdaddy",
      overridden: true,
      baseText: custom,
      personaText: "You are sdaddy.",
    });
    expect(preview.layers.map((layer) => [layer.kind, layer.source ?? null, layer.active, layer.length ?? null])).toEqual([
      ["base", "shipped", false, DEFAULT_SYSTEM_PROMPT.length],
      ["base", "workspace", true, custom.length],
      ["persona", null, true, "You are sdaddy.".length],
      ["facts", null, true, null],
      ["context", null, true, null],
    ]);
    expect(preview.layers[3]).toMatchObject({ generated: true, sample: true });
    expect(preview.layers[3]?.detail).toContain("The current local time is");

    const unknown = await client.request("system-prompt", { action: "preview", agentId: "nobody" }, "preview-unknown");
    expect(unknown.error?.code).toBe("NOT_FOUND");
    const malformed = await client.request("system-prompt", { action: "get", workspaceId: "default", agentId: "sdaddy" }, "get-agent");
    expect(malformed.ok).toBe(false);

    // The CLI routes the preview through the owner.
    const shown = capture();
    expect(await main(["system-prompt", "preview", "--agent", "sdaddy", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.out()).toContain(
      `base     Shipped default (${SHIPPED_SYSTEM_PROMPT_VERSION}) — ${DEFAULT_SYSTEM_PROMPT.length} chars (not sent)\n`,
    );
    expect(shown.out()).toContain("persona  Persona: Chief of staff — 15 chars\n");
  });
});

describe("agents update as a compare-and-set", () => {
  it("lists what a persona picker needs, applies a current version and refuses a stale one", async () => {
    const { client, directory } = await owner();
    const created = (
      await client.request("agents", { action: "add", agentId: "sdaddy", name: "Chief of staff", prompt: "You are sdaddy." }, "add")
    ).result as AgentDefinition;

    const listed = (await client.request("agents", { action: "list" }, "list")).result as AgentsListResult;
    expect(listed.agents).toEqual([
      expect.objectContaining({
        agentId: "sdaddy",
        name: "Chief of staff",
        enabled: true,
        systemPromptLength: 15,
        updatedAt: created.updatedAt,
      }),
    ]);
    expect(listed.agents[0]).not.toHaveProperty("systemPrompt");
    expect(listed.agents[0]).not.toHaveProperty("pinnedBy");

    // A routine runs the agent under the instructions its revision pinned: the list says so.
    const db = new (loadBetterSqlite3())(join(directory, "tavi.sqlite"));
    try {
      const at = nowTimestamp();
      db.prepare(
        "INSERT INTO tavi_routines(routine_id,workspace_id,principal_id,name,version,active_revision,latest_revision,status,conversation_id,created_at,updated_at) VALUES('r1','default','operator','Morning news',1,1,1,'active',NULL,?,?)",
      ).run(at, at);
      db.prepare(
        "INSERT INTO tavi_routine_revisions(routine_id,revision,snapshot_json,hash,author,change_summary,created_at) VALUES('r1',1,?,'h','operator','created',?)",
      ).run(
        JSON.stringify({
          agent: { agentId: "sdaddy", name: "Chief of staff", instructions: "Pinned.", revision: 1, hash: "0".repeat(64) },
        }),
        at,
      );
    } finally {
      db.close();
    }
    const pinned = (await client.request("agents", { action: "list" }, "list-pinned")).result as AgentsListResult;
    expect(pinned.agents[0]?.pinnedBy).toEqual([{ routineId: "r1", name: "Morning news" }]);

    const saved = await client.request(
      "agents",
      { action: "update", agentId: "sdaddy", prompt: "Revised.", expectedUpdatedAt: created.updatedAt },
      "update-1",
    );
    expect(saved.ok).toBe(true);
    const revised = saved.result as AgentDefinition;
    expect(revised.systemPrompt).toBe("Revised.");
    // Even a write in the same millisecond moves the version forward.
    expect(Date.parse(revised.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));

    const stale = await client.request(
      "agents",
      { action: "update", agentId: "sdaddy", prompt: "Lost edit.", expectedUpdatedAt: created.updatedAt },
      "update-stale",
    );
    expect(stale.error?.code).toBe("CONFLICT");
    expect(stale.error?.message).toMatch(/changed since it was read/);
    const shown = (await client.request("agents", { action: "show", agentId: "sdaddy" }, "show")).result as AgentDefinition;
    expect(shown.systemPrompt).toBe("Revised.");

    // Without a version the write stays unconditional, as before.
    expect((await client.request("agents", { action: "update", agentId: "sdaddy", prompt: "Unconditional." }, "update-2")).ok).toBe(true);
    // A version on an action that writes no existing row is refused, not ignored.
    const misplaced = await client.request("agents", { action: "list", expectedUpdatedAt: created.updatedAt }, "list-version");
    expect(misplaced.error?.code).toBe("INVALID_INPUT");
  });
});
