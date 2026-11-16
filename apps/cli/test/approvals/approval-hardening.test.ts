import { inspectDatabase } from "../support/database-fixture.js";

import { decidableRound, expectedStepsOf, roundResumeKey, type InboundEvent } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions, askingForMemoryProposals } from "../support/serve-fixture.js";

/**
 * Cross-cutting guarantees of approvals in channels: a round survives an owner restart and is decided from every
 * channel after it; concurrent decisions from several front ends settle it
 * once; expiry racing a decision settles it once; and a re-announced round
 * sends one message.
 */

const directories = temporaryDirectories({ prefix: "tavi-approval-hardening-" });
afterEach(() => directories.cleanup());

const propose = { toolCall: { id: "c1", name: "memory.propose", input: { kind: "fact", body: "the sky is blue" } } } as const;
const BASE = "https://mail.example.test";

interface Owner {
  readonly runtime: TaviRuntime;
  readonly sent: () => readonly string[];
  readonly answered: { callbackId: string; text: string }[];
}

/** An owner on `directory`, with an interactive chat connection that also has a link base (so every channel path is open). */
async function owner(directory: string, turns: readonly ScriptedTurn[], sweepMs = 60_000): Promise<Owner> {
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: ["mutating", "external"],
      agentWaitSweepIntervalMs: sweepMs,
    }),
    { modelOverride: createFixtureModel({ turns }), approvalLinkBase: () => BASE },
  );
  // A memory proposal is these tests' asked call: its seeded allow rule is revoked.
  await askingForMemoryProposals(runtime);
  const instances: FixtureMessagingConnectorInstance[] = [];
  const answered: { callbackId: string; text: string }[] = [];
  const fixture = createFixtureMessagingConnectorDefinition({
    sendOutcome: () => ({ status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "m-1" }] }),
    onInstanceCreated: (instance) => instances.push(instance),
    capabilities: { interactions: true, editOrProgress: true, approvals: "buttons" },
  });
  runtime.messaging.registerConnector({
    ...fixture,
    createConnection: (input) => {
      const instance = fixture.createConnection(input);
      return {
        ...instance,
        send: (message) => instance.send(message),
        onInboundEvent: (next) => instance.onInboundEvent?.(next),
        answerInteraction: async (callbackId: string, text: string) => void answered.push({ callbackId, text }),
        editMessage: async () => undefined,
      };
    },
    destinationFromInbound: (replyTo) => ({ chat: replyTo.externalConversationId }),
  });
  await runtime.messaging.openConnection({
    connection: {
      connectionId: "conn-a",
      providerId: "fixture",
      accountIdentity: "acct",
      workspaceId: "default",
      configRevision: 1,
      enabled: true,
    },
    config: {},
  });
  await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
    connectionId: "conn-a",
    externalSenderId: "user-1",
    workspaceId: "default",
    principalId: "alice",
    approvedBy: "operator",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const sent = () => (instances[0]?.sent ?? []).map((message) => (message.parts[0] as { content?: string }).content ?? "");
  return { runtime, sent, answered };
}

let counter = 0;
function message(content: string): InboundEvent {
  counter += 1;
  return {
    connectionId: "conn-a",
    providerEventId: `evt-${counter}`,
    kind: "message",
    externalSenderId: "user-1",
    externalConversationId: "chat-1",
    occurredAt: nowTimestamp(),
    receivedAt: nowTimestamp(),
    content,
  };
}

function press(data: string): InboundEvent {
  counter += 1;
  return {
    connectionId: "conn-a",
    providerEventId: `press-${counter}`,
    kind: "interaction",
    externalSenderId: "user-1",
    externalConversationId: "chat-1",
    occurredAt: nowTimestamp(),
    receivedAt: nowTimestamp(),
    interaction: { data, callbackId: `cb-${counter}`, messageId: "m-1" },
  };
}

/** The chat's task, its pending round's token, and the round's link tokens, as an owner sees them. */
async function roundOf(target: Owner): Promise<{ readonly taskId: string; readonly token: string; readonly links: readonly string[] }> {
  const repositories = target.runtime.store.asPort().repositories;
  const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
  const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
  const links = [...(target.sent().find((text) => text.startsWith("🔐")) ?? "").matchAll(/\/i\/([A-Za-z0-9_-]+)/g)].map(
    (match) => match[1] ?? "",
  );
  return { taskId, token, links };
}

/**
 * The approval decisions a task committed: what "settled once" means. The
 * approval row is updated in place and the audit settles once whatever
 * happens, so neither could show a second decision; a committed admission
 * under the round's key is the decision itself.
 */
async function committedDecisions(target: Owner, taskId: string) {
  return (await target.runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).filter(
    (admission) => admission.kind === "approval" && admission.state !== "refused",
  );
}

/** Suspend a chat-started task on a round, then stop the owner: what a restart finds. */
async function suspendedThenStopped(
  directory: string,
): Promise<{ readonly taskId: string; readonly token: string; readonly links: readonly string[] }> {
  const first = await owner(directory, [propose, { text: "done" }]);
  await first.runtime.messaging.ingest(message("remember that the sky is blue"));
  const { taskId, token, links } = await roundOf(first);
  expect((await first.runtime.store.asPort().repositories.tasks.get(taskId))?.status).toBe("waiting");
  await first.runtime.close();
  return { taskId, token, links };
}

describe("a round across an owner restart", () => {
  for (const channel of ["typed", "button", "link"] as const) {
    it(`is decided by a ${channel} after the owner restarts`, async () => {
      const directory = directories.create();
      const { taskId, token, links } = await suspendedThenStopped(directory);
      const second = await owner(directory, [{ text: "done after restart" }]);
      const repositories = second.runtime.store.asPort().repositories;
      if (channel === "typed") await second.runtime.messaging.ingest(message(`approve ${token}`));
      if (channel === "button") {
        await second.runtime.messaging.ingest(press(`r:${token}:o`));
        expect(second.answered.at(-1)?.text).toBe(`Approving round ${token}…`);
      }
      if (channel === "link") expect(await second.runtime.channelApprovals.useLink(links[0] ?? "", {})).toMatchObject({ ok: true });
      await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
      expect((await repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["granted"]);
      await second.runtime.close();
    });
  }
});

describe("one round, several deciders", () => {
  it("settles once when a chat, a button, a link and IPC decide it together", async () => {
    const directory = directories.create();
    const { runtime, sent } = await owner(directory, [propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(message("remember"));
    const { taskId, token, links } = await roundOf({ runtime, sent, answered: [] });
    const task = await repositories.tasks.get(taskId);
    const decidability = task === undefined ? undefined : await decidableRound(repositories, task);
    if (task === undefined || decidability === undefined || !decidability.decidable || runtime.workflow === undefined)
      throw new Error("no round");
    const round = decidability.round;
    const results = await Promise.allSettled([
      runtime.messaging.ingest(message(`reject ${token} not this`)),
      runtime.messaging.ingest(press(`r:${token}:o`)),
      runtime.channelApprovals.useLink(links[0] ?? "", {}),
      runtime.workflow.admit({
        context: { workspaceId: task.workspaceId, principalId: task.principalId, caller: "ipc", runId: taskId },
        taskId,
        operationKey: roundResumeKey(taskId, round),
        kind: "approval",
        resume: { approved: true, decidedBy: "operator", ...expectedStepsOf(round) },
      }),
    ]);
    // A loser is refused under the round's key — "already admitted with
    // different content" — never applied as a second decision.
    for (const result of results) {
      if (result.status === "rejected") expect(String(result.reason)).toMatch(/CONFLICT|already admitted/i);
    }
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    // Exactly one decision was committed, and what is recorded is that one.
    const committed = await committedDecisions({ runtime, sent, answered: [] }, taskId);
    expect(committed).toHaveLength(1);
    const [row] = await repositories.approvals.listForTask(taskId);
    const settled = (await repositories.approvalRounds.listEvents(taskId, 1)).find((event) => event.kind === "settled");
    const recorded = (settled?.detail?.["decisions"] as readonly { approved: boolean }[] | undefined)?.[0]?.approved;
    expect(row?.state).toBe(recorded === true ? "granted" : "denied");
    await runtime.close();
  });

  it("settles once when expiry races a decision", async () => {
    const directory = directories.create();
    const { runtime } = await owner(directory, [propose, { text: "done" }], 20);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(message("remember"));
    const target: Owner = { runtime, sent: () => [], answered: [] };
    const { taskId, token } = await roundOf(target);
    inspectDatabase(runtime.store)
      .prepare("UPDATE tavi_approval_rounds SET expires_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?")
      .run(taskId);
    await Promise.allSettled([runtime.messaging.ingest(message(`approve ${token}`)), runtime.channelApprovals.sweepExpired()]);
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    // Exactly one of the two was committed, and the row says which.
    expect(await committedDecisions(target, taskId)).toHaveLength(1);
    const [row] = await repositories.approvals.listForTask(taskId);
    expect(row?.decidedBy).toBe(row?.state === "granted" ? "alice" : "policy:expired");
    await runtime.close();
  });
});

describe("announcing a round again", () => {
  it("sends one message, whether the round record exists or the send is retried under its effect id", async () => {
    const directory = directories.create();
    const { runtime, sent } = await owner(directory, [propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(message("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const announcements = () => sent().filter((text) => text.startsWith("🔐")).length;
    expect(announcements()).toBe(1);
    const again = {
      taskId,
      steps: 1,
      invocation: {
        workspaceId: "default",
        principalId: "alice",
        runId: taskId,
        caller: "test",
        messagingReplyTo: { connectionId: "conn-a", externalConversationId: "chat-1", externalSenderId: "user-1" },
      },
      requests: [{ callId: "c1", toolName: "memory.propose", summary: "Run memory.propose", input: {} }],
    };
    // A re-entered node, or one resumed after a crash that followed the send:
    // the round is recorded before it is sent, so it is found and nothing is sent.
    await runtime.channelApprovals.announceRound(again);
    expect(announcements()).toBe(1);
    // And the send itself is an outbox effect: retried under the round's
    // effect id, it is not delivered a second time.
    const retried = await runtime.messaging.send({
      effectId: `approval:${taskId}:1`,
      connectionId: "conn-a",
      workspaceId: "default",
      destination: { chat: "chat-1" },
      parts: [{ content: "🔐 again" }],
    });
    expect(retried.status).toBe("accepted");
    expect(announcements()).toBe(1);
    // The round the one message named is still the one to decide.
    await runtime.messaging.ingest(message(`approve ${(await repositories.approvalRounds.get(taskId, 1))?.token ?? ""}`));
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    await runtime.close();
  });
});
