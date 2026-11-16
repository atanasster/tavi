import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTENDED_TASK_POLICY,
  UNATTENDED_TASK_POLICY,
  type InboundEvent,
  type OutboundMessage,
  type TaskExecutionPolicy,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { sweepExpiredWaits } from "@tavi/agent-host/agent-wait-scheduler";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import { MCP_HELD_WATCH_MS } from "../../src/features/mcp/bridge.js";
import { answerNeed } from "../../src/features/approvals/needs-answer.js";
import { recordCancellation } from "../../src/features/tasks/mutations.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * A server's question in the owner: the calling
 * task's "Needs you" question, answered from Center, the terminal or
 * Telegram; declined at once where nobody attends; a 2026-07-28 question
 * survives a restart; one nobody answers sends the server nothing.
 */

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures/mcp/fake-server.mjs");
const directories = temporaryDirectories({ prefix: "tavi-mcp-ask-" });
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
  directories.cleanup();
});

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

/** A data directory with the fake server added, approved and enabled, in `era`; its runs counted in the returned file. */
async function installed(era: "legacy" | "modern"): Promise<{ readonly data: string; readonly calls: string }> {
  const data = directories.create();
  const at = ["--data-dir", data];
  const tools = join(data, "fake-tools.json");
  const calls = join(data, "fake-requests.log");
  writeFileSync(
    tools,
    JSON.stringify([
      {
        name: "confirm",
        description: "Deletes the draft, once confirmed.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "echo",
        description: "Echoes.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
      {
        name: "twice",
        description: "Deletes the draft and recolours it, asking both.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      { name: "pick", description: "Picks a colour.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ]),
  );
  const added = await tavi([
    "mcp",
    "add",
    "fake",
    "--command",
    process.execPath,
    "--unsandboxed",
    "--env",
    `FAKE_ERA=${era}`,
    "--env",
    `FAKE_TOOLS=${tools}`,
    "--env",
    `FAKE_LOG=${calls}`,
    ...at,
    "--",
    FAKE,
  ]);
  expect(added.code, added.stderr).toBe(EXIT.ok);
  const approved = await tavi(["mcp", "approve", "mcp.fake", "1.0.0", "--unsandboxed", ...at]);
  expect(approved.code, approved.stderr).toBe(EXIT.ok);
  expect((await tavi(["plugins", "enable", "mcp.fake", ...at])).code).toBe(EXIT.ok);
  return { data, calls };
}

async function owner(
  data: string,
  turns: readonly ScriptedTurn[],
  channel = false,
  gated = false,
): Promise<{
  readonly runtime: TaviRuntime;
  readonly model: ReturnType<typeof createFixtureModel>;
  readonly sent: () => readonly OutboundMessage[];
}> {
  const model = createFixtureModel({ turns });
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(data, {
      // Gated, a mutating tool asks before it runs, as by default; otherwise nothing asks but the server's questions.
      ...(gated ? {} : { approvalRequiredFor: [] }),
      ...(channel ? { messagingAllowedDestinations: ["chat-1"] } : {}),
    }),
    { modelOverride: model },
  );
  runtimes.push(runtime);
  let instance: FixtureMessagingConnectorInstance | undefined;
  if (channel) {
    // A connector with buttons, as Telegram has: a question's choices go as buttons.
    runtime.messaging.registerConnector({
      ...createFixtureMessagingConnectorDefinition({
        onInstanceCreated: (created) => {
          instance = created;
        },
        capabilities: { interactions: true, editOrProgress: true, approvals: "buttons" },
      }),
      // A reply goes back to the chat it came from, as on Telegram: an approval's card among them.
      destinationFromInbound: (replyTo) => ({ fixtureChat: replyTo.externalConversationId }),
    });
    await runtime.messaging.openConnection({
      connection: {
        connectionId: "telegram-main",
        providerId: "fixture",
        accountIdentity: "op-bot",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "telegram-main",
      externalSenderId: "operator-chat",
      workspaceId: "default",
      principalId: "operator",
      approvedBy: "test",
      createdAt: "2026-04-05T00:00:00.000Z",
    });
  }
  return { runtime, model, sent: () => instance?.sent ?? [] };
}

const asksToConfirm: ScriptedTurn[] = [{ toolCall: { id: "call-1", name: "mcp.fake.confirm", input: {} } }, { text: "done" }];
const context = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };

/** A chat started from the canvas, attended as the canvas starts it (or under `executionPolicy`). */
async function start(runtime: TaviRuntime, executionPolicy: TaskExecutionPolicy = ATTENDED_TASK_POLICY): Promise<string> {
  const workflow =
    runtime.workflow ??
    (() => {
      throw new Error("no workflow");
    })();
  const admitted = await workflow.admit({
    context,
    operationKey: `op-${Math.random().toString(36).slice(2)}`,
    kind: "start",
    prompt: "delete the draft",
    origin: "web",
    executionPolicy,
  });
  return admitted.taskId;
}

async function settled(runtime: TaviRuntime, taskId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await runtime.store.asPort().repositories.tasks.get(taskId);
    if (task !== undefined && ["completed", "failed", "cancelled"].includes(task.status)) return task.status;
    await delay(50);
  }
  throw new Error("the task did not finish");
}

const result = (model: ReturnType<typeof createFixtureModel>): string => JSON.stringify(model.calls.at(-1)?.messages ?? []);
const answer = (runtime: TaviRuntime, taskId: string, words: string, via: "bridge" | "cli") =>
  answerNeed(
    { repositories: runtime.store.asPort().repositories, channelApprovals: runtime.channelApprovals, operatorOf: () => "operator" },
    { actor: { workspaceId: "default", principalId: "operator", caller: via, authority: "operator" }, taskId, answer: words, via },
  );
/** `tools/call` requests the server read (its JSON-RPC log). */
const callsMade = (file: string): number =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((method) => method === "tools/call").length;

describe("a server's question, from the calling task", () => {
  for (const era of ["modern", "legacy"] as const) {
    it(`${era}: asked as the task's question naming its server, answered from Center, and the call goes on`, async () => {
      const { data, calls } = await installed(era);
      const { runtime, model } = await owner(data, asksToConfirm);
      const taskId = await start(runtime);
      const wait = await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId);
      expect(wait?.choices?.options.map((option) => option.label)).toEqual(["Accept", "Decline"]);
      expect((await answer(runtime, taskId, "Accept", "bridge")).ok).toBe(true);
      expect(await settled(runtime, taskId)).toBe("completed");
      expect(result(model)).toContain("confirm: accept");
      // A 2026-07-28 server is called again on the answer's run, and once more with the answer; a legacy one was held
      // open and answered mid-call, in its one request.
      expect(callsMade(calls)).toBe(era === "modern" ? 3 : 1);
    }, 60_000);
  }

  for (const era of ["modern", "legacy"] as const) {
    it(`${era}: a call that asks twice is answered twice, one question at a time`, async () => {
      const { data } = await installed(era);
      const { runtime, model } = await owner(data, [{ toolCall: { id: "call-1", name: "mcp.fake.twice", input: {} } }, { text: "done" }]);
      const taskId = await start(runtime);
      const waits = runtime.store.asPort().repositories.agentWaits;
      expect((await waits.getActiveByTask(taskId))?.choices?.options.map((option) => option.label)).toEqual(["Accept", "Decline"]);
      expect((await answer(runtime, taskId, "Accept", "bridge")).ok).toBe(true);
      const second = async (): Promise<string | undefined> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const wait = await waits.getActiveByTask(taskId);
          if (wait?.choices?.options[0]?.label === "red") return wait.waitId;
          await delay(50);
        }
        return undefined;
      };
      expect(await second()).toBeDefined();
      expect((await answer(runtime, taskId, "green", "bridge")).ok).toBe(true);
      expect(await settled(runtime, taskId)).toBe("completed");
      expect(result(model)).toContain('twice: accept then accept {\\"colour\\":\\"green\\"}');
    }, 60_000);
  }

  it("legacy: a read-only tool's question is held like any other", async () => {
    const { data, calls } = await installed("legacy");
    const { runtime, model } = await owner(data, [{ toolCall: { id: "call-1", name: "mcp.fake.pick", input: {} } }, { text: "done" }]);
    const taskId = await start(runtime);
    expect(
      (await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId))?.choices?.options.map((option) => option.label),
    ).toEqual(["red", "green", "Decline"]);
    expect((await answer(runtime, taskId, "red", "cli")).ok).toBe(true);
    expect(await settled(runtime, taskId)).toBe("completed");
    expect(result(model)).toContain('pick: accept {\\"colour\\":\\"red\\"}');
    expect(callsMade(calls)).toBe(1);
  }, 60_000);

  it("legacy: cancelling the task while its question waits cancels the held call at the server, not ten minutes later", async () => {
    const { data, calls } = await installed("legacy");
    const { runtime } = await owner(data, asksToConfirm);
    const taskId = await start(runtime);
    expect(await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId)).toBeDefined();
    expect(runtime.mcp.supervisor.status("mcp.fake").inFlight).toBe(1);
    await recordCancellation(runtime.store, { taskId, reason: "changed my mind", operator: "operator" }, () => nowTimestamp());
    // Within one watch: the call is cancelled at the server, and its slot is free again.
    for (let waited = 0; waited < MCP_HELD_WATCH_MS * 3 && runtime.mcp.supervisor.status("mcp.fake").inFlight > 0; waited += 100)
      await delay(100);
    expect(runtime.mcp.supervisor.status("mcp.fake").inFlight).toBe(0);
    expect(readFileSync(calls, "utf8").split("\n")).toContain("notifications/cancelled");
    expect(callsMade(calls)).toBe(1);
  }, 60_000);

  it("legacy: after a restart the held call is gone, and is reported uncertain rather than made again", async () => {
    const { data, calls } = await installed("legacy");
    const first = await owner(data, asksToConfirm);
    const taskId = await start(first.runtime);
    expect(await first.runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId)).toBeDefined();
    await first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);
    const second = await owner(data, [{ text: "done" }]);
    expect((await answer(second.runtime, taskId, "Accept", "cli")).ok).toBe(true);
    expect(await settled(second.runtime, taskId)).toBe("completed");
    expect(result(second.model)).toContain("EFFECT_UNCERTAIN");
    expect(callsMade(calls)).toBe(1);
    expect((await second.runtime.store.asPort().repositories.effects.listForTask(taskId)).map((effect) => effect.state)).toEqual([
      "pending",
    ]);
  }, 60_000);

  it("answered from the terminal, after a restart: a 2026-07-28 question survives it", async () => {
    const { data } = await installed("modern");
    const first = await owner(data, asksToConfirm);
    const taskId = await start(first.runtime);
    expect(await first.runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId)).toBeDefined();
    await first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);
    const second = await owner(data, [{ text: "done" }]);
    expect((await answer(second.runtime, taskId, "Accept", "cli")).ok).toBe(true);
    expect(await settled(second.runtime, taskId)).toBe("completed");
    expect(result(second.model)).toContain("confirm: accept");
  }, 60_000);

  it("answered on Telegram, from the chat the task started in", async () => {
    const { data } = await installed("modern");
    const { runtime, model, sent } = await owner(data, asksToConfirm, true);
    const event = (content: string, id: string): InboundEvent => ({
      connectionId: "telegram-main",
      providerEventId: `evt-${id}`,
      kind: "message",
      externalSenderId: "operator-chat",
      externalConversationId: "chat-1",
      externalMessageId: id,
      occurredAt: "2026-04-05T07:00:00.000Z",
      receivedAt: "2026-04-05T07:00:00.000Z",
      content,
    });
    await runtime.messaging.ingest(event("delete the draft", "m1"));
    const taskId = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = (await runtime.store.asPort().repositories.messagingConversations.get("telegram-main", "chat-1"))?.taskId;
        if (id !== undefined && (await runtime.store.asPort().repositories.agentWaits.getActiveByTask(id)) !== undefined) return id;
        await delay(50);
      }
      throw new Error("no question");
    })();
    // Sent through the channel's outbox, as any question is.
    const asked = async (): Promise<string> => {
      for (let attempt = 0; attempt < 100 && sent().length === 0; attempt += 1) await delay(50);
      return sent()
        .map((message) => JSON.stringify(message))
        .join("\n");
    };
    expect(await asked()).toContain("fake asks: Delete the draft?");
    // Its choices as buttons, in rows.
    const buttons = sent()
      .flatMap((message) => (message as { buttons?: readonly (readonly { readonly label: string }[])[] }).buttons ?? [])
      .flat();
    expect(buttons.map((button) => button.label)).toEqual(expect.arrayContaining(["Accept", "Decline"]));
    await runtime.messaging.ingest(event("Accept", "m2"));
    expect(await settled(runtime, taskId)).toBe("completed");
    expect(result(model)).toContain("confirm: accept");
  }, 60_000);

  it("a channel's buttons decide an MCP tool's approval, then its server's question is answered there too", async () => {
    const { data, calls } = await installed("modern");
    const { runtime, model, sent } = await owner(data, asksToConfirm, true, true);
    const repositories = runtime.store.asPort().repositories;
    const at = nowTimestamp();
    let counter = 0;
    const event = (extra: Partial<InboundEvent>): InboundEvent => {
      counter += 1;
      return {
        connectionId: "telegram-main",
        providerEventId: `evt-${String(counter)}`,
        kind: "message",
        externalSenderId: "operator-chat",
        externalConversationId: "chat-1",
        externalMessageId: `m${String(counter)}`,
        occurredAt: at,
        receivedAt: at,
        ...extra,
      } as InboundEvent;
    };
    await runtime.messaging.ingest(event({ content: "delete the draft" }));
    let token = "";
    let taskId = "";
    for (let attempt = 0; attempt < 100 && token === ""; attempt += 1) {
      taskId = (await repositories.messagingConversations.get("telegram-main", "chat-1"))?.taskId ?? "";
      token = taskId === "" ? "" : ((await repositories.approvalRounds.get(taskId, 1))?.token ?? "");
      if (token === "") await delay(50);
    }
    expect(token).not.toBe("");
    // The round's card goes out with its buttons; the person presses Once.
    for (
      let attempt = 0;
      attempt < 100 && !sent().some((message) => (message as { buttons?: unknown }).buttons !== undefined);
      attempt += 1
    )
      await delay(50);
    const card = sent().find((message) =>
      (message as { buttons?: readonly (readonly { readonly data: string }[])[] }).buttons
        ?.flat()
        .some((button) => button.data === `r:${token}:o`),
    );
    expect(card).toBeDefined();
    expect(JSON.stringify(card)).toContain("fake");
    await runtime.messaging.ingest(
      event({ kind: "interaction", interaction: { data: `r:${token}:o`, callbackId: "cb-1", messageId: "m-1" } } as Partial<InboundEvent>),
    );
    // Approved, the call runs and the server asks; the answer comes from the same chat.
    for (let attempt = 0; attempt < 200 && (await repositories.agentWaits.getActiveByTask(taskId)) === undefined; attempt += 1)
      await delay(50);
    await runtime.messaging.ingest(event({ content: "Accept" }));
    expect(await settled(runtime, taskId)).toBe("completed");
    expect(result(model)).toContain("confirm: accept");
    expect(callsMade(calls)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("an unattended run declines at once, a default notwithstanding, and asks nobody", async () => {
    const { data } = await installed("modern");
    for (const policy of [
      UNATTENDED_TASK_POLICY,
      { mode: "unattended", humanQuestionsAllowed: true, workerWaitsAllowed: true, requiresDefault: true } satisfies TaskExecutionPolicy,
    ]) {
      const { runtime, model } = await owner(data, asksToConfirm);
      const taskId = await start(runtime, policy);
      expect(await settled(runtime, taskId)).toBe("completed");
      expect(result(model)).toContain("confirm: decline");
      expect(await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId)).toBeUndefined();
      await runtime.close();
      runtimes.splice(runtimes.indexOf(runtime), 1);
    }
  }, 60_000);

  for (const era of ["modern", "legacy"] as const)
    it(`${era}: a question nobody answers sends the server nothing`, async () => {
      const { data, calls } = await installed(era);
      const { runtime, model } = await owner(data, asksToConfirm);
      const taskId = await start(runtime);
      expect(await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId)).toBeDefined();
      const repositories = runtime.store.asPort().repositories;
      const workflow =
        runtime.workflow ??
        (() => {
          throw new Error("no workflow");
        })();
      await sweepExpiredWaits({
        waits: repositories.agentWaits,
        tasks: repositories.tasks,
        workflow,
        now: () => "2030-01-01T00:00:00.000Z",
      });
      expect(await settled(runtime, taskId)).toBe("completed");
      expect(result(model)).toContain("went unanswered; nothing was sent to it");
      // A 2026-07-28 server, called again on the resumed turn, asked again and got no answer: no retry carried accept,
      // decline or cancel. A legacy one's held call was cancelled, its question unanswered.
      expect(callsMade(calls)).toBe(era === "modern" ? 2 : 1);
    }, 60_000);
});
