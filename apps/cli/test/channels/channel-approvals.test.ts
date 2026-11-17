import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { inspectDatabase } from "../support/database-fixture.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  decidableRound,
  evaluateGate,
  expectedStepsOf,
  roundResumeKey,
  untrustedLabel,
  type ApprovalsShowResult,
  type InboundEvent,
  type OutboundMessage,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { SqliteStore } from "../support/database-fixture.js";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseApprovalCommand,
  questionReceipt,
  questionToken,
  renderQuestionText,
  renderRoundText,
  roundButtons,
  roundScopes,
} from "../../src/features/approvals/channel-approval-text.js";
import { createChannelApprovals } from "../../src/features/approvals/channel-approvals.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { listNeeds } from "../../src/features/approvals/inbox.js";
import { answerNeed } from "../../src/features/approvals/needs-answer.js";
import { EXIT, main } from "../../src/main.js";
import { runScheduleNow } from "@tavi/agent-host/schedule-scheduler";
import { temporaryDirectories, waitFor, delay } from "@tavi/test-support";
import { fixtureRuntimeOptions, askingForMemoryProposals } from "../support/serve-fixture.js";

/**
 * Rounds in the conversation a task came from: announced with a token,
 * decided by typing it with a scope, reported back, audited, and denied when
 * nobody answers in time.
 */

const directories = temporaryDirectories({ prefix: "tavi-channel-approvals-" });
afterEach(() => directories.cleanup());

const propose = { toolCall: { id: "c1", name: "memory.propose", input: { kind: "fact", body: "the sky is blue" } } } as const;

interface Harness {
  readonly runtime: TaviRuntime;
  readonly sent: () => string[];
  readonly directory: string;
  /** Every message sent, with its buttons. */
  readonly messages: () => readonly OutboundMessage[];
  readonly answered: { callbackId: string; text: string }[];
  readonly edited: { messageId: string; text: string }[];
  /** Set to make every edit fail, as a provider refusing it does. */
  readonly failEdits: { value: boolean };
}

/** `interactive`: a connector with buttons and edits; `"no-round-buttons"` has them but decides rounds some other way. */
async function harness(
  turns: readonly ScriptedTurn[],
  sweepMs = 60_000,
  interactive: boolean | "no-round-buttons" = false,
  failedSends = 0,
  fsRoots: readonly string[] = [],
  reopen?: string,
  reasonWindowMs = 50,
): Promise<Harness> {
  // `reopen` starts a second owner on an earlier one's data: a restart.
  const directory = reopen ?? directories.create();
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: ["mutating", "external"],
      agentWaitSweepIntervalMs: sweepMs,
      approvalReasonWindowMs: reasonWindowMs,
      ...(fsRoots.length === 0 ? {} : { fsRoots }),
    }),
    { modelOverride: createFixtureModel({ turns }) },
  );
  // These rounds are `memory.propose`'s: with its seeded allow rule revoked (as an operator may), it asks.
  if (reopen === undefined) await askingForMemoryProposals(runtime);
  const instances: FixtureMessagingConnectorInstance[] = [];
  const answered: { callbackId: string; text: string }[] = [];
  const edited: { messageId: string; text: string }[] = [];
  const failEdits = { value: false };
  const fixture = createFixtureMessagingConnectorDefinition({
    // The first `failedSends` sends are refused, as a connection that is down refuses them.
    sendOutcome: () =>
      (failedSends -= 1) >= 0
        ? { status: "rejected", retryable: true, parts: [{ index: 0, status: "rejected", error: "connection is down" }] }
        : { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "m-1" }] },
    onInstanceCreated: (instance) => instances.push(instance),
    ...(interactive === false
      ? {}
      : {
          capabilities: {
            interactions: true,
            editOrProgress: true,
            approvals: interactive === true ? ("buttons" as const) : ("none" as const),
          },
        }),
  });
  runtime.messaging.registerConnector({
    ...fixture,
    // A connector that can take presses and edit what it sent, as Telegram can.
    createConnection: (input) => {
      const instance = fixture.createConnection(input);
      return interactive
        ? {
            ...instance,
            send: (message) => instance.send(message),
            onInboundEvent: (next) => instance.onInboundEvent?.(next),
            answerInteraction: async (callbackId: string, text: string) => void answered.push({ callbackId, text }),
            editMessage: async (edit: { readonly messageId: string; readonly text: string }) => {
              if (failEdits.value) throw new Error("message to edit not found");
              edited.push({ messageId: edit.messageId, text: edit.text });
            },
          }
        : instance;
    },
    destinationFromInbound: (replyTo) => ({ fixtureChat: replyTo.externalConversationId }),
  });
  await runtime.messaging.openConnection({
    connection: {
      connectionId: "conn-a",
      providerId: "fixture",
      accountIdentity: "acct-a",
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
  return { runtime, sent, directory, messages: () => instances[0]?.sent ?? [], answered, edited, failEdits };
}

function press(data: string, sender = "user-1"): InboundEvent {
  eventCounter += 1;
  return {
    connectionId: "conn-a",
    providerEventId: `press-${eventCounter}`,
    kind: "interaction",
    externalSenderId: sender,
    externalConversationId: "chat-1",
    // Now: a press older than ten minutes is not acted on.
    occurredAt: nowTimestamp(),
    receivedAt: nowTimestamp(),
    interaction: { data, callbackId: `cb-${eventCounter}`, messageId: "m-1" },
  };
}

let eventCounter = 0;
function inbound(content: string, sender = "user-1"): InboundEvent {
  eventCounter += 1;
  return {
    connectionId: "conn-a",
    providerEventId: `evt-${eventCounter}`,
    kind: "message",
    externalSenderId: sender,
    externalConversationId: "chat-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    content,
  };
}

describe("parseApprovalCommand", () => {
  it("reads a verb, an optional target, a scope for approvals and a reason for rejections", () => {
    expect(parseApprovalCommand("approve")).toEqual({ approved: true });
    expect(parseApprovalCommand("Allow k3f9abcd session")).toEqual({ approved: true, target: "k3f9abcd", scope: "session" });
    expect(parseApprovalCommand("approve always")).toEqual({ approved: true, scope: "always" });
    expect(parseApprovalCommand("reject k3f9abcd too risky")).toEqual({ approved: false, target: "k3f9abcd", note: "too risky" });
    expect(parseApprovalCommand("deny")).toEqual({ approved: false });
  });

  it("does not read an ordinary sentence as a command", () => {
    expect(parseApprovalCommand("approve the budget for next week please")).toBeNull();
    expect(parseApprovalCommand("what should I approve?")).toBeNull();
  });
});

describe("renderRoundText", () => {
  it("offers only the scopes every call allows", () => {
    const requests = [
      { callId: "a", toolName: "x.y", summary: "s", input: {}, allowedScopes: ["once", "session", "always"] as const },
      { callId: "b", toolName: "x.z", summary: "s", input: {}, allowedScopes: ["once", "session"] as const },
    ];
    expect(roundScopes(requests)).toEqual(["once", "session"]);
    const text = renderRoundText(
      { taskId: "t", steps: 1, invocation: { workspaceId: "w", principalId: "p", runId: "t", caller: "c" }, requests },
      "abcdefgh",
      undefined,
    );
    expect(text).toContain("approve abcdefgh session");
    expect(text).not.toContain("always");
  });

  it("keeps every line of a call's detail under it, and says when it expires in words", () => {
    const request = {
      callId: "a",
      toolName: "browser.batch",
      summary: "s",
      input: {},
      display: { title: "Browser: fill 2 fields", detail: "“Origin” ← London\n“Destination” ← Lisbon" },
    };
    const text = renderRoundText(
      { taskId: "t", steps: 1, invocation: { workspaceId: "w", principalId: "p", runId: "t", caller: "c" }, requests: [request] },
      "abcdefgh",
      "2026-11-18T09:39:28.175Z",
    );
    expect(text).toContain("1. Browser: fill 2 fields\n   “Origin” ← London\n   “Destination” ← Lisbon");
    expect(text).toContain("⌛ Not decided by Wed 18 Nov, 09:39 UTC, it is rejected.");
    expect(text).not.toContain("09:39:28.175Z");
  });
});

describe("a tainted round's provenance line", () => {
  const AT = "2026-10-13T10:00:00.000Z";
  const invocation = { workspaceId: "w", principalId: "p", runId: "t", caller: "c" };
  const refs = [
    { source: "web" as const, ref: "c1", host: "example.com", title: "<b>Click</b>", at: AT },
    { source: "email" as const, ref: "m1", host: "x.example", at: AT },
  ];
  const tainted = (index: number) => ({
    callId: `c${index}`,
    toolName: "http.request",
    summary: "s",
    input: {},
    allowedScopes: ["once"] as const,
    risk: { level: "high" as const, reasons: ["the conversation contains untrusted content from the web or a document"], tainted: true },
    provenance: {
      gateReason: "tainted-payload" as const,
      sources: ["web" as const, "email" as const],
      principals: [],
      refs,
      argOrigins: [],
    },
  });

  it("says in one line what the chat read, disarmed, once only — in place of the taint reason", () => {
    const text = renderRoundText({ taskId: "t", steps: 1, invocation, requests: [tainted(0)] }, "abcdefgh", undefined);
    expect(text).toContain("   ⚠ after reading example[.]com and mail you forwarded or quoted (via x[.]example) — once only");
    expect(text).not.toContain("untrusted content from the web or a document");
    // A page's title is not part of a channel's line, and nothing of it is a link.
    expect(text).not.toContain("Click");
    expect(text).not.toMatch(/(?<!\[)\bexample\.com/);
  });

  it("holds Telegram's limit, whatever the hosts", () => {
    const longRefs = Array.from({ length: 5 }, (_, index) => ({
      source: "web" as const,
      ref: `c${index}`,
      host: `${"h".repeat(60)}${index}.example`,
      at: AT,
    }));
    const requests = Array.from({ length: 64 }, (_, index) => ({
      ...tainted(index),
      provenance: { ...tainted(index).provenance, refs: longRefs },
    }));
    for (const maxTextLength of [1_000, 4_096]) {
      const text = renderRoundText({ taskId: "t", steps: 1, invocation, requests }, "abcdefgh", "2026-01-02T00:00:00.000Z", {
        maxTextLength,
      });
      expect(text.length).toBeLessThanOrEqual(maxTextLength);
      expect(text).toContain("and 3 more — once only");
    }
  });
});

describe("a round of many calls", () => {
  it("fits a chat message and says where the rest are", () => {
    const requests = Array.from({ length: 64 }, (_, index) => ({
      callId: `c${index}`,
      toolName: "sandbox.run",
      summary: "s",
      input: {},
      display: { title: `Run \`step ${index}\` in the sandbox`, command: "x".repeat(250) },
      risk: { level: "medium" as const, reasons: ["reaches the network"], tainted: false },
    }));
    const text = renderRoundText(
      { taskId: "t", steps: 1, invocation: { workspaceId: "w", principalId: "p", runId: "t", caller: "c" }, requests },
      "abcdefgh",
      "2026-01-02T00:00:00.000Z",
    );
    expect(text.length).toBeLessThan(4_096);
    expect(text).toMatch(/…and \d+ more — `tavi approvals list` shows every call\./);
    expect(text).toContain("approve abcdefgh");
  });

  it("lists only what the channel's own limit holds", () => {
    const requests = Array.from({ length: 64 }, (_, index) => ({
      callId: `c${index}`,
      toolName: "sandbox.run",
      summary: "s",
      input: {},
      display: { title: `Run step ${index}`, command: "x".repeat(250) },
    }));
    const round = { taskId: "t", steps: 1, invocation: { workspaceId: "w", principalId: "p", runId: "t", caller: "c" }, requests };
    for (const maxTextLength of [1_500, 4_096, 20_000]) {
      const text = renderRoundText(round, "abcdefgh", "2026-01-02T00:00:00.000Z", { maxTextLength });
      expect(text.length).toBeLessThanOrEqual(maxTextLength);
    }
    // A longer channel lists more calls.
    expect(renderRoundText(round, "abcdefgh", undefined, { maxTextLength: 20_000 }).length).toBeGreaterThan(
      renderRoundText(round, "abcdefgh", undefined, { maxTextLength: 4_096 }).length,
    );
  });

  it("stays within a chat message when every call is a different tool offering session", () => {
    const requests = Array.from({ length: 64 }, (_, index) => ({
      callId: `c${index}`,
      toolName: `plugin-${"x".repeat(40)}.tool${index}`,
      summary: "s",
      input: {},
      allowedScopes: ["once", "session"] as const,
      display: { title: "t".repeat(200), detail: "d".repeat(300) },
    }));
    const text = renderRoundText(
      { taskId: "t", steps: 1, invocation: { workspaceId: "w", principalId: "p", runId: "t", caller: "c" }, requests },
      "abcdefgh",
      "2026-01-02T00:00:00.000Z",
    );
    expect(text.length).toBeLessThan(4_096);
    expect(text).toContain("approve abcdefgh session (any ");
  });

  it("says a search's always is a rule for any search, in every chat", () => {
    const requests = [
      { callId: "a", toolName: "web_search", summary: "s", input: {}, allowedScopes: ["once", "session", "always"] as const },
    ];
    const text = renderRoundText(
      { taskId: "t", steps: 1, invocation: { workspaceId: "w", principalId: "p", runId: "t", caller: "c" }, requests },
      "abcdefgh",
      undefined,
    );
    expect(text).toContain("approve abcdefgh session (any web_search call in this chat)");
    expect(text).toContain("approve abcdefgh always (any web_search call, in every chat)");
  });

  it("asks a browser round as one question: for this task by default, or always", () => {
    const requests = [
      {
        callId: "a",
        toolName: "browser.navigate",
        summary: "s",
        input: {},
        allowedScopes: ["once", "session", "always"] as const,
        subjects: ["smart.example.org"],
        scopeGroup: "browser.*",
        display: { title: "Open smart.example.org in the browser" },
        risk: { level: "medium" as const, reasons: [], tainted: false },
      },
    ];
    const text = renderRoundText(
      { taskId: "t", steps: 1, invocation: { workspaceId: "w", principalId: "p", runId: "t", caller: "c" }, requests },
      "abcdefgh",
      undefined,
    );
    // One question for the browser: a bare approve allows it for the task.
    expect(text).toContain("🔐 This task wants to use the browser");
    expect(text).toContain("approve abcdefgh (the browser, for this chat)");
    expect(text).toContain("approve abcdefgh always (the browser, in every chat)");
    expect(roundButtons(requests, "abcdefgh")[0]?.map((button) => button.label)).toEqual(["✅ Allow for this chat", "♾ Always allow"]);
    // An email reply decides one call only, and says so.
    expect(
      renderRoundText(
        { taskId: "t", steps: 1, invocation: { workspaceId: "w", principalId: "p", runId: "t", caller: "c" }, requests },
        "abcdefgh",
        undefined,
        { email: { links: true } },
      ),
    ).toContain("this call only: the next one asks again");
  });

  it("names the host a browser round allows, and that another site asks again", () => {
    const requests = [
      {
        callId: "a",
        toolName: "browser.navigate",
        summary: "s",
        input: {},
        allowedScopes: ["once", "session", "always"] as const,
        subjects: ["smart.example.org"],
        scopeGroup: "browser.*",
        display: { title: "Open smart.example.org in the browser", host: "smart.example.org" },
        risk: { level: "medium" as const, reasons: [], tainted: false },
      },
    ];
    const text = renderRoundText(
      { taskId: "t", steps: 1, invocation: { workspaceId: "w", principalId: "p", runId: "t", caller: "c" }, requests },
      "abcdefgh",
      undefined,
    );
    expect(text).toContain("🔐 This task wants to use the browser on smart.example.org");
    expect(text).toContain("approve abcdefgh (the browser on smart.example.org, for this chat)");
    expect(text).toContain("Opening another site asks again");
  });

  it("tells an email reader how to decide a round a reply cannot", () => {
    const requests = [
      {
        callId: "a",
        toolName: "sandbox.run",
        summary: "s",
        input: {},
        allowedScopes: ["once"] as const,
        risk: { level: "high" as const, reasons: [], tainted: false },
      },
    ];
    const round = {
      taskId: "task-1",
      steps: 1,
      invocation: { workspaceId: "w", principalId: "p", runId: "task-1", caller: "c" },
      requests,
    };
    expect(renderRoundText(round, "abcdefgh", undefined, { email: { links: false } })).toContain("`tavi approvals approve task-1`");
    expect(renderRoundText(round, "abcdefgh", undefined, { email: { links: false } })).not.toContain("Reply:");
    expect(renderRoundText(round, "abcdefgh", undefined, { email: { links: true } })).toContain("use a link below");
  });
});

describe("rounds in the originating conversation", () => {
  it("announces a round with its token, applies a typed session scope, reports and audits it", async () => {
    const { runtime, sent, directory } = await harness([
      propose,
      { text: "proposed" },
      { ...propose, toolCall: { ...propose.toolCall, id: "c2" } },
      { text: "proposed again" },
    ]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember that the sky is blue"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");

    const announcement = sent().find((text) => text.startsWith("🔐"));
    expect(announcement).toBeDefined();
    const round = (await repositories.approvalRounds.listEvents(taskId)).find((event) => event.kind === "announced");
    const token = (round?.detail as { token: string }).token;
    expect(announcement).toContain(`approve ${token} session`);
    expect((await repositories.approvalRounds.get(taskId, 1))?.messageIds).toEqual(["m-1"]);

    await runtime.messaging.ingest(inbound(`approve ${token} session`));
    expect(sent().at(-1)).toMatch(/approved \(session\): the run is now completed/);
    expect((await repositories.toolPolicy.listSessionGrants(taskId)).map((grant) => grant.toolId)).toEqual(["memory.propose"]);
    expect((await repositories.approvalRounds.listEvents(taskId)).map((event) => event.kind)).toEqual([
      "announced",
      "settled",
      "grant_created",
      "notified",
      "tool_result",
    ]);
    // What to revoke, and what became of the call.
    const events = await repositories.approvalRounds.listEvents(taskId);
    expect(events.find((event) => event.kind === "grant_created")?.detail?.["created"]).toEqual([
      { id: (await repositories.toolPolicy.listSessionGrants(taskId))[0]?.grantId },
    ]);
    expect(events.find((event) => event.kind === "tool_result")?.detail).toMatchObject({ toolName: "memory.propose", status: "ok" });
    // Decided in the chat, so the chat's own reply is the only report there.
    expect(sent().filter((text) => text.startsWith("✅"))).toEqual([]);

    // The grant covers the same tool for the rest of the task: no second round.
    await runtime.messaging.ingest(inbound("and remember it again"));
    expect((await repositories.tasks.get(taskId))?.status).toBe("completed");
    expect(await repositories.approvals.listForTask(taskId)).toHaveLength(1);
    await runtime.close();

    // The audit trail, read back offline.
    let out = "";
    const io = { stdout: (chunk: string) => void (out += chunk), stderr: () => undefined, isTty: false };
    expect(await main(["approvals", "show", taskId, "--format", "json", "--data-dir", directory], { io })).toBe(EXIT.ok);
    const shown = JSON.parse(out) as ApprovalsShowResult;
    expect(shown.rounds.map((entry) => [entry.steps, entry.token, entry.connectionId])).toEqual([[1, token, "conn-a"]]);
    expect(shown.events.map((event) => [event.kind, event.via])).toEqual([
      ["announced", "conn-a"],
      ["settled", "conn-a"],
      ["grant_created", "conn-a"],
      ["notified", "conn-a"],
      ["tool_result", undefined],
    ]);
    expect(shown.calls?.map((call) => [call.toolId, call.state])).toEqual([["memory.propose", "granted"]]);
  });

  it("sends an announcement that failed again, and starts its expiry only then", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }], 20, false, 1);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    await waitFor(async () => (await repositories.approvalRounds.listEvents(taskId)).some((event) => event.kind === "announced"));
    expect((await repositories.approvalRounds.listEvents(taskId)).map((event) => event.kind)).toEqual(["announce_failed", "announced"]);
    const round = await repositories.approvalRounds.get(taskId, 1);
    expect(Date.parse(round?.expiresAt ?? "") - Date.parse(round?.createdAt ?? "")).toBeGreaterThan(24 * 60 * 60 * 1000 - 1);
    expect(
      sent()
        .filter((text) => text.startsWith("🔐"))
        .at(-1),
    ).toContain(`approve ${round?.token}`);
    await runtime.close();
  });

  it("does not deny a round nobody was shown", async () => {
    const { runtime } = await harness([propose, { text: "done" }], 20, false, 1_000);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    inspectDatabase(runtime.store)
      .prepare("UPDATE tavi_approval_rounds SET expires_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?")
      .run(taskId);
    await delay(150);
    expect((await repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["pending"]);
    await runtime.close();
  });

  it("refuses a decision for a round past its expiry, before the sweep denies it", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    inspectDatabase(runtime.store)
      .prepare("UPDATE tavi_approval_rounds SET expires_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?")
      .run(taskId);
    await runtime.messaging.ingest(inbound(`approve ${token}`));
    expect(sent().some((text) => text.startsWith(`Round ${token} expired`))).toBe(true);
    expect(
      (await repositories.approvalRounds.listEvents(taskId)).some(
        (event) => event.kind === "decision_refused" && event.detail?.["reason"] === "expired",
      ),
    ).toBe(true);
    await waitFor(async () => (await repositories.approvals.listForTask(taskId))[0]?.state === "denied");
    await runtime.close();
  });

  it("passes `approve it` on as the answer to a question, not a command naming a round", async () => {
    const ask = { toolCall: { id: "q1", name: "operator.ask_user", input: { question: "Shall I store it?" } } } as const;
    const { runtime, sent } = await harness([ask, { text: "stored" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("store the note"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const wait = await repositories.agentWaits.getActiveByTask(taskId);
    expect(wait).toBeDefined();
    await runtime.messaging.ingest(inbound("approve it"));
    expect((await repositories.agentWaits.get(wait?.waitId ?? ""))?.settledOutcome).toMatchObject({
      kind: "answered",
      replyText: "approve it",
    });
    expect(sent().some((text) => /There is no task/.test(text))).toBe(false);
    await runtime.close();
  });

  it("holds a chat-started task to the messaging profile: a file write is refused, not put to a round", async () => {
    const root = directories.create();
    const write = { toolCall: { id: "w1", name: "fs.write", input: { path: "notes.md", content: "hi" } } } as const;
    const { runtime, sent } = await harness([write, { text: "could not write" }], 60_000, false, 0, [root]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("write a note"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    expect(await repositories.approvals.listForTask(taskId)).toEqual([]);
    expect(sent().some((text) => text.startsWith("🔐"))).toBe(false);
    expect(existsSync(join(root, "notes.md"))).toBe(false);
    await runtime.close();
  });

  it("refuses a token for a round that was already decided", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await runtime.messaging.ingest(inbound(`reject ${token} not now`));
    await runtime.messaging.ingest(inbound(`approve ${token}`));
    expect(sent().at(-1)).toMatch(/has no pending approval/);
    expect((await repositories.approvals.listForTask(taskId)).map((row) => [row.state, row.note])).toEqual([["denied", "not now"]]);
    await runtime.close();
  });

  it("denies a round nobody decided before it expired, and says so in the chat", async () => {
    const { runtime, sent } = await harness([propose, { text: "carried on without it" }], 20);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    inspectDatabase(runtime.store)
      .prepare("UPDATE tavi_approval_rounds SET expires_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?")
      .run(taskId);
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    expect((await repositories.approvals.listForTask(taskId)).map((row) => [row.state, row.decidedBy])).toEqual([
      ["denied", "policy:expired"],
    ]);
    await waitFor(() => sent().some((text) => text.startsWith("⌛")));
    expect((await repositories.approvalRounds.listEvents(taskId)).map((event) => event.kind)).toContain("expired");
    await runtime.close();
  });
  it("refuses a valid token typed by another person bound in the same workspace", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await repositories.messagingIdentityBindings.bind({
      connectionId: "conn-a",
      externalSenderId: "user-2",
      workspaceId: "default",
      principalId: "bob",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await runtime.messaging.ingest(inbound(`approve ${token}`, "user-2"));
    expect(sent().at(-1)).toMatch(/There is no task/);
    expect((await repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["pending"]);
    expect((await repositories.approvalRounds.listEvents(taskId)).find((event) => event.kind === "decision_refused")).toMatchObject({
      actor: "bob",
      detail: { reason: "not-owner" },
    });
    await runtime.close();
  });

  it("grants once, and says so, when a scope the round does not offer is asked for", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    // `memory.propose` has nothing narrower to match, so `always` is not offered.
    expect(sent().find((text) => text.startsWith("🔐"))).toContain("(any memory.propose call in this chat)");
    await runtime.messaging.ingest(inbound(`approve ${token} always`));
    expect(sent().at(-1)).toMatch(/approved once \(always is not offered for this round\)/);
    // Only the rules every workspace is seeded with (reminders, to-dos, web search, skill proposals; the memory one
    // revoked above): no rule for the call.
    expect((await repositories.toolPolicy.listRules("default")).map((rule) => rule.ruleId)).toEqual([
      "seeded-reminders",
      "seeded-skills-propose",
      "seeded-todos",
      "seeded-web-search",
    ]);
    expect(await repositories.toolPolicy.listSessionGrants(taskId)).toEqual([]);
    await runtime.close();
  });

  it("passes a rejection-like sentence to the model when there is no round to decide", async () => {
    const { runtime, sent } = await harness([{ text: "first" }, { text: "declined alice's request" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("hello"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const before = (await repositories.tasks.listAdmissions(taskId)).length;
    await runtime.messaging.ingest(inbound("deny the meeting request from alice"));
    expect((await repositories.tasks.listAdmissions(taskId)).length).toBe(before + 1);
    expect(sent().some((text) => text.includes("has no pending approval"))).toBe(false);
    await runtime.close();
  });

  it("reports a round decided from another front end to the chat it was announced in", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const task = await repositories.tasks.get(taskId);
    const workflow = runtime.workflow;
    if (task === undefined || workflow === undefined) throw new Error("no task or no workflow");
    const decidability = await decidableRound(repositories, task);
    if (!decidability.decidable) throw new Error("no round");
    await workflow.admit({
      context: { workspaceId: task.workspaceId, principalId: task.principalId, caller: "test", runId: taskId },
      taskId,
      operationKey: roundResumeKey(taskId, decidability.round),
      kind: "approval",
      resume: { approved: true, decidedBy: "operator", ...expectedStepsOf(decidability.round) },
    });
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await waitFor(() => sent().some((text) => text.startsWith("✅")));
    expect(sent().find((text) => text.startsWith("✅"))).toMatch(
      new RegExp(`^✅ Round ${token} approved by operator via a terminal at \\d\\d:\\d\\d UTC\\.$`),
    );
    await runtime.close();
  });
});

describe("announcing a review a channel's turn waits on", () => {
  it("tells the chat where to review it and that a new message goes on, once per review, and nothing to the owner's own chats", async () => {
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const sentTo: { effectId: string; text: string }[] = [];
      const local = new Set<string>();
      const channels = createChannelApprovals({
        repositories: store.asPort().repositories,
        messaging: {
          send: async (message) => {
            sentTo.push({ effectId: message.effectId, text: (message.parts[0] as { content: string }).content });
            return { status: "accepted", retryable: false, parts: [] };
          },
          buildReplyDestination: (_connectionId, replyTo) => ({ chat: replyTo.externalConversationId }),
          capabilitiesOf: () => undefined,
          answerInteraction: async () => {},
          editMessage: async () => false,
        },
        workflow: () => undefined,
        scheduleOf: () => undefined,
        isLocalConnection: (connectionId) => local.has(connectionId),
        now: () => "2026-01-01T00:00:00.000Z",
        fillRandom: (bytes) => bytes.fill(7),
      });
      const review = (connectionId: string) => ({
        taskId: "task-1",
        steps: 4,
        invocation: {
          workspaceId: "default",
          principalId: "alice",
          runId: "task-1",
          caller: "channel",
          messagingReplyTo: { connectionId, externalConversationId: "chat-1", externalSenderId: "user-1" },
        },
        requests: [{ artifactId: "art-1", callId: "c1", toolName: "browser.capture", steps: 4 }],
      });
      await channels.announceReview(review("telegram"));
      await channels.announceReview({ ...review("telegram"), steps: 5 });
      expect(sentTo.map((entry) => entry.text)).toEqual([
        "📎 The screenshot I took is waiting for your review before I can use it. Review it in the Tavi app (the chat's Held files), or send a new message and I'll go on without it.",
        expect.any(String),
      ]);
      // The outbox sends one effect once: a node that re-enters on the same review sends nothing new.
      expect(new Set(sentTo.map((entry) => entry.effectId)).size).toBe(1);
      local.add("web");
      await channels.announceReview(review("web"));
      expect(sentTo).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe("announcing a delegated task's round", () => {
  it("sends it to the conversation its delegation root came from", async () => {
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const repositories = store.asPort().repositories;
      for (const taskId of ["root-task", "worker-task"]) {
        await repositories.tasks.admit({
          prompt: fixturePromptPolicy,
          workspaceId: "default",
          principalId: "alice",
          operationKey: `op-${taskId}`,
          kind: "start",
          intent: { prompt: "hi" },
          checkpointNamespace: "",
          newTaskId: (() => taskId)(),
          newAdmissionId: (() => `adm-${taskId}`)(),
          newThreadId: (() => `thread-${taskId}`)(),
          now: (() => "2026-01-01T00:00:00.000Z")(),
        });
      }
      await repositories.messagingConversations.record({
        connectionId: "conn-a",
        externalConversationId: "chat-1",
        taskId: "root-task",
        createdAt: "2026-01-01T00:00:00.000Z",
        replyTo: { connectionId: "conn-a", externalConversationId: "chat-1", externalSenderId: "user-1" },
      });
      await repositories.agentDelegations.recordSpawn({
        operationKey: "spawn-1",
        workspaceId: "default",
        principalId: "alice",
        workerTaskId: "worker-task",
        workerAgentId: "agent-1",
        parentTaskId: "root-task",
        rootTaskId: "root-task",
        depth: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const sentTo: { destination: unknown; text: string }[] = [];
      const channels = createChannelApprovals({
        repositories,
        messaging: {
          send: async (message) => {
            sentTo.push({ destination: message.destination, text: (message.parts[0] as { content: string }).content });
            return { status: "accepted", retryable: false, parts: [] };
          },
          buildReplyDestination: (_connectionId, replyTo) => ({ chat: replyTo.externalConversationId }),
          capabilitiesOf: () => undefined,
          answerInteraction: async () => {},
          editMessage: async () => false,
        },
        workflow: () => undefined,
        scheduleOf: () => undefined,
        isLocalConnection: () => false,
        now: () => "2026-01-01T00:00:00.000Z",
        fillRandom: (bytes) => bytes.fill(7),
      });
      await channels.announceRound({
        taskId: "worker-task",
        steps: 1,
        invocation: { workspaceId: "default", principalId: "alice", runId: "worker-task", caller: "agent" },
        requests: [{ callId: "c1", toolName: "memory.propose", summary: "Run memory.propose", input: {} }],
      });
      expect(sentTo.map((entry) => entry.destination)).toEqual([{ chat: "chat-1" }]);
      expect(await repositories.approvalRounds.get("worker-task", 1)).toMatchObject({ connectionId: "conn-a", conversationId: "chat-1" });
    } finally {
      store.close();
    }
  });
});

describe("a round's scopes in the approvals inbox", () => {
  it.each([
    { path: "a round sent to no chat", replyTo: undefined },
    {
      path: "a round announced to a chat",
      replyTo: { connectionId: "conn-a", externalConversationId: "chat-1", externalSenderId: "user-1" },
    },
  ])("lists each call with the scopes its gate verdict offered, not only what its risk allows: $path", async ({ replyTo }) => {
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const repositories = store.asPort().repositories;
      await repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "alice",
        operationKey: "op-task",
        kind: "start",
        intent: { prompt: "hi" },
        checkpointNamespace: "",
        newTaskId: (() => "task-1")(),
        newAdmissionId: (() => "adm-task-1")(),
        newThreadId: (() => "thread-task-1")(),
        now: (() => "2026-01-01T00:00:00.000Z")(),
      });
      // A reminder change after the task read a web page: high risk, so its
      // risk alone would allow `session`, but the gate offers `once` only.
      const tainted = evaluateGate({
        toolId: "reminders.update",
        effect: "mutating",
        assessment: { display: { title: "Move the dentist reminder" }, risk: "low", reasons: [], subjects: [], askWhenTainted: true },
        rules: [],
        sessionGrants: [],
        gatedEffects: new Set(),
        tainted: true,
        label: untrustedLabel("web", {
          principal: "host:example.com",
          ref: { ref: "c-page", host: "example.com", at: "2026-01-01T00:00:00.000Z" },
        }),
      });
      const ordinary = evaluateGate({
        toolId: "files.read",
        effect: "read-only",
        assessment: { display: { title: "Read /tmp/a" }, risk: "low", reasons: [], subjects: ["/tmp/a"] },
        rules: [],
        sessionGrants: [],
        gatedEffects: new Set(["read-only"]),
        tainted: false,
      });
      expect(tainted).toMatchObject({ decision: "ask", risk: { level: "high" }, allowedScopes: ["once"] });
      expect(ordinary).toMatchObject({ decision: "ask", risk: { level: "low" }, allowedScopes: ["once", "session", "always"] });
      const calls = [
        { callId: "c-tainted", verdict: tainted },
        { callId: "c-ordinary", verdict: ordinary },
      ];
      for (const { callId, verdict } of calls) {
        await repositories.approvals.request({
          approvalId: `appr-${callId}`,
          taskId: "task-1",
          admissionId: "adm-task-1",
          toolId: verdict.toolId,
          callId,
          steps: 1,
          inputs: {},
          now: { fixed: "2026-01-01T00:00:00.000Z" },
        });
      }
      const sent: unknown[] = [];
      const channels = createChannelApprovals({
        repositories,
        messaging: {
          send: async (message) => {
            sent.push(message.destination);
            return { status: "accepted", retryable: false, parts: [] };
          },
          buildReplyDestination: (_connectionId, target) => ({ chat: target.externalConversationId }),
          capabilitiesOf: () => undefined,
          answerInteraction: async () => {},
          editMessage: async () => false,
        },
        workflow: () => undefined,
        scheduleOf: () => undefined,
        isLocalConnection: () => false,
        now: () => "2026-01-01T00:00:00.000Z",
        fillRandom: (bytes) => bytes.fill(7),
      });
      await channels.announceRound({
        taskId: "task-1",
        steps: 1,
        invocation: {
          workspaceId: "default",
          principalId: "alice",
          runId: "task-1",
          caller: "test",
          ...(replyTo === undefined ? {} : { messagingReplyTo: replyTo }),
        },
        requests: calls.map(({ callId, verdict }) => ({
          callId,
          toolName: verdict.toolId,
          summary: verdict.display.title,
          input: {},
          risk: verdict.risk,
          display: verdict.display,
          allowedScopes: verdict.allowedScopes,
        })),
      });
      expect(sent).toEqual(replyTo === undefined ? [] : [{ chat: "chat-1" }]);
      const stored = await repositories.approvalRounds.get("task-1", 1);
      expect(stored?.connectionId).toBe(replyTo?.connectionId);
      expect(stored?.callScopes).toEqual([
        { callId: "c-tainted", allowedScopes: ["once"] },
        { callId: "c-ordinary", allowedScopes: ["once", "session", "always"] },
      ]);
      // The context label the round's calls were emitted under is stored with its risk.
      expect(stored?.riskLabel).toEqual(tainted.risk.label);
      expect(stored?.riskLabel).toMatchObject({ integrity: "untrusted", sources: ["web"] });
      const listed = await repositories.approvalInbox.pending({ workspaceId: "default", limit: 10 });
      expect(Object.fromEntries(listed.rows.map((row) => [row.callId, row.allowedScopes]))).toEqual({
        "c-tainted": ["once"],
        "c-ordinary": ["once", "session", "always"],
      });
      expect(listed.rows.map((row) => row.risk)).toEqual(["high", "high"]);
    } finally {
      store.close();
    }
  });
});

describe("buttons", () => {
  it("offers a round no buttons on a channel that has them but does not decide rounds with them", async () => {
    const { runtime, messages } = await harness([propose, { text: "done" }], 60_000, "no-round-buttons");
    await runtime.messaging.ingest(inbound("remember"));
    expect(messages().some((message) => ((message.parts[0] as { content?: string }).content ?? "").startsWith("🔐"))).toBe(true);
    expect(messages().some((message) => message.buttons !== undefined)).toBe(false);
  });

  it("announces a round with a button per offered scope, decides a press, acknowledges it and edits the round", async () => {
    const { runtime, messages, answered, edited } = await harness([propose, { text: "done" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    const announcement = messages().find((message) => message.buttons !== undefined);
    expect(announcement?.buttons).toEqual([
      [
        { label: "✅ Once", data: `r:${token}:o` },
        { label: "🔁 Session", data: `r:${token}:s` },
      ],
      [{ label: "❌ Deny", data: `r:${token}:d` }],
    ]);

    await runtime.messaging.ingest(press(`r:${token}:s`));
    // Answered before the decision runs, which then finishes in the background.
    expect(answered.at(-1)?.text).toBe(`Approving round ${token} (session)…`);
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed" && edited.length === 1);
    expect(await repositories.toolPolicy.listSessionGrants(taskId)).toHaveLength(1);
    expect(edited[0]?.text).toMatch(/🔐 Approval needed[\s\S]*✅ Round .* approved \(session\) by alice via conn-a at \d\d:\d\d UTC\./);
    await runtime.close();
  });

  it("acts once on a double press, refuses a press for a round decided elsewhere or unknown, and ignores an old question press", async () => {
    const ask = {
      toolCall: { id: "q1", name: "operator.ask_user", input: { question: "Which?", options: [{ label: "A" }, { label: "B" }] } },
    } as const;
    const { runtime, answered, sent } = await harness([propose, ask, { text: "done" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    // ❌ twice asks for the reason once.
    await runtime.messaging.ingest(press(`r:${token}:d`));
    await runtime.messaging.ingest(press(`r:${token}:d`));
    expect(sent().filter((text) => text.startsWith(`Why reject round ${token}?`))).toHaveLength(1);
    expect(sent().at(-1)).toMatch(/within 1 minute[\s\S]*With no reply, it is rejected without one/);
    await runtime.messaging.ingest(inbound("-"));
    await waitFor(async () => (await repositories.approvals.listForTask(taskId))[0]?.state === "denied");
    // Decided: a later press, of any button, decides nothing.
    await runtime.messaging.ingest(press(`r:${token}:o`));
    expect(answered.at(-1)?.text).toBe("This round was already decided.");
    // Well-formed, but no such round.
    await runtime.messaging.ingest(press("r:abcdefgh:o"));
    expect(answered.at(-1)?.text).toBe("This round was already decided.");
    // A question press replayed from the held inbox long after it was made.
    await waitFor(async () => (await repositories.agentWaits.getActiveByTask(taskId)) !== undefined);
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    const stale = { ...press(`q:${questionToken(waitId)}:1`), receivedAt: "2000-01-01T00:00:00.000Z" };
    await runtime.messaging.ingest(stale);
    expect(answered.at(-1)?.text).toBe("This button press is too old to act on.");
    expect((await repositories.agentWaits.get(waitId))?.state).toBe("active");
    await runtime.close();
  });

  it("withdraws a round when /new resets its conversation: its buttons go, and a later press says so", async () => {
    const { runtime, answered, edited } = await harness([propose, { text: "done" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await runtime.messaging.ingest(inbound("/new"));
    expect((await repositories.approvalRounds.get(taskId, 1))?.settledAt).toBeDefined();
    expect(edited.at(-1)?.text).toMatch(/🔐 Approval needed[\s\S]*This conversation was reset, so this round was withdrawn\./);
    await runtime.messaging.ingest(press(`r:${token}:o`));
    expect(answered.at(-1)?.text).toBe("This conversation was reset, so this round was withdrawn.");
    expect((await repositories.approvals.listForTask(taskId)).some((record) => record.state === "granted")).toBe(false);
    await runtime.close();
  });

  it("refuses a press by someone else, and a press whose data names nothing", async () => {
    const { runtime, answered } = await harness([propose, { text: "done" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await repositories.messagingIdentityBindings.bind({
      connectionId: "conn-a",
      externalSenderId: "user-2",
      workspaceId: "default",
      principalId: "bob",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await runtime.messaging.ingest(press(`r:${token}:o`, "user-2"));
    expect(answered.at(-1)?.text).toBe("Only the person this chat belongs to can decide it.");
    // ❌ from someone else asks nobody for a reason and holds no message back.
    await runtime.messaging.ingest(press(`r:${token}:d`, "user-2"));
    expect(answered.at(-1)?.text).toBe("Only the person this chat belongs to can decide it.");
    await runtime.messaging.ingest(press("r:zzzzzzzz:o; drop table"));
    expect(answered.at(-1)?.text).toBe("This button is no longer valid.");
    expect((await repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["pending"]);
    await runtime.close();
  });

  it("takes the message after ❌ as the reason, or rejects without one when none comes", async () => {
    const first = await harness([propose, { text: "done" }], 60_000, true);
    let repositories = first.runtime.store.asPort().repositories;
    await first.runtime.messaging.ingest(inbound("remember"));
    let taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    let token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await first.runtime.messaging.ingest(press(`r:${token}:d`));
    expect(first.sent().at(-1)).toMatch(/Why reject round/);
    await first.runtime.messaging.ingest(inbound("it is already stored"));
    // Decided in the background: the poll loop does not wait for the resumed turn.
    await waitFor(async () => (await repositories.approvals.listForTask(taskId))[0]?.state === "denied");
    expect((await repositories.approvals.listForTask(taskId)).map((row) => [row.state, row.note])).toEqual([
      ["denied", "it is already stored"],
    ]);
    await first.runtime.close();

    const second = await harness([propose, { text: "done" }], 60_000, true);
    repositories = second.runtime.store.asPort().repositories;
    await second.runtime.messaging.ingest(inbound("remember"));
    taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await second.runtime.messaging.ingest(press(`r:${token}:d`));
    await waitFor(async () => (await repositories.approvals.listForTask(taskId))[0]?.state === "denied");
    expect((await repositories.approvals.listForTask(taskId))[0]?.note).toBeNull();
    await second.runtime.close();
  });

  it("takes a reason typed after a restart while the ❌ window is still open", async () => {
    // A window long enough that the first owner's timer never fires.
    const first = await harness([propose, { text: "done" }], 60_000, true, 0, [], undefined, 60_000);
    let repositories = first.runtime.store.asPort().repositories;
    await first.runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await first.runtime.messaging.ingest(press(`r:${token}:d`));
    await first.runtime.close();

    const second = await harness([{ text: "done" }], 60_000, true, 0, [], first.directory, 60_000);
    repositories = second.runtime.store.asPort().repositories;
    // Not yet expired: the sweep leaves it, and a reason typed now is still taken.
    expect((await repositories.needDeliveries.getReason(`conn-a\u0000chat-1\u0000user-1`))?.token).toBe(token);
    await second.runtime.messaging.ingest(inbound("no longer needed"));
    await waitFor(async () => (await repositories.approvals.listForTask(taskId))[0]?.state === "denied");
    expect((await repositories.approvals.listForTask(taskId))[0]?.note).toBe("no longer needed");
    await second.runtime.close();
  });

  it("rejects without a reason, from the sweep, a ❌ whose window passed with no timer left", async () => {
    const { runtime } = await harness([propose, { text: "done" }], 60_000, true, 0, [], undefined, 60_000);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await runtime.messaging.ingest(press(`r:${token}:d`));
    // As a restarted owner finds it: the window over, no timer to end it.
    const held = await repositories.needDeliveries.takeReason(`conn-a\u0000chat-1\u0000user-1`);
    if (held === undefined) throw new Error("the ❌ press held no reason prompt");
    await repositories.needDeliveries.putReason({ ...held, expiresAt: "2000-01-01T00:00:00.000Z" });
    await runtime.channelApprovals.sweepExpired();
    await waitFor(async () => (await repositories.approvals.listForTask(taskId))[0]?.state === "denied");
    expect((await repositories.approvals.listForTask(taskId))[0]?.note).toBeNull();
    expect(await repositories.needDeliveries.getReason(`conn-a\u0000chat-1\u0000user-1`)).toBeUndefined();
    await runtime.close();
  });

  it("lets a message through as a message when the round a ❌ asked about was decided elsewhere", async () => {
    const { runtime } = await harness([propose, { text: "done" }, { text: "a new turn" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await runtime.messaging.ingest(press(`r:${token}:d`));
    // Decided by typing, before any reason came.
    await runtime.messaging.ingest(inbound(`approve ${token}`));
    const admissions = (await repositories.tasks.listAdmissions(taskId)).length;
    await runtime.messaging.ingest(inbound("thanks, now something else"));
    expect((await repositories.tasks.listAdmissions(taskId)).length).toBe(admissions + 1);
    expect((await repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["granted"]);
    await runtime.close();
  });

  it("answers a press from someone with no binding, and decides nothing", async () => {
    const { runtime, answered } = await harness([propose, { text: "done" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("remember"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await runtime.messaging.ingest(press(`r:${token}:o`, "stranger"));
    expect(answered.at(-1)?.text).toBe("You are not allowed to decide this.");
    expect((await repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["pending"]);
    await runtime.close();
  });
});

describe("renderQuestionText", () => {
  it("says why it asks, marks the recommended option, and when it stops waiting with what", () => {
    const choices = {
      options: [{ label: "Ship it" }, { label: "Wait" }],
      multiSelect: false,
      allowOther: false,
      recommended: 1,
      defaultOption: 2,
    };
    expect(
      renderQuestionText("Ship to production?", choices, {
        context: "Two tests are flaky.",
        deadlineAt: "2026-10-02T14:30:00.000Z",
        now: "2026-10-02T09:00:00.000Z",
      }),
    ).toBe(
      "❓ Ship to production?\nWhy: Two tests are flaky.\n1. Ship it ★ recommended\n2. Wait\nReply with a number.\n⌛ Answer by 14:30 UTC (otherwise: Wait)",
    );
    // Due another day: the day is named, so a time earlier than now does not read as past.
    expect(
      renderQuestionText("Which folder?", undefined, { deadlineAt: "2026-10-03T08:00:00.000Z", now: "2026-10-02T15:00:00.000Z" }),
    ).toBe("Which folder?\n⌛ Answer by Sat 3 Oct, 08:00 UTC");
    expect(renderQuestionText("Which folder?", undefined)).toBe("Which folder?");
    // A schedule's run says whose question it is, on one line.
    expect(renderQuestionText("Which folder?", undefined, { origin: "Daily\nrelease" })).toBe("⏸ Daily release asks:\nWhich folder?");
    expect(
      renderQuestionText("Ship?", { options: [{ label: "Yes" }], multiSelect: false, allowOther: false }, { origin: "Daily release" })
        .split("\n")
        .slice(0, 2),
    ).toEqual(["⏸ Daily release asks:", "❓ Ship?"]);
  });
});

describe("questionReceipt", () => {
  const at = "2026-10-02T14:02:00.000Z";
  it("names the answer, and where it came from when that was elsewhere", () => {
    expect(questionReceipt({ kind: "answered", replyText: "Acme, Globex", answers: ["Acme", "Globex"] }, undefined, at)).toBe(
      "✅ Acme, Globex",
    );
    expect(questionReceipt({ kind: "answered", replyText: "later", answers: ["Acme"], other: "and call me" }, "link", at)).toBe(
      "✅ Acme, and call me — answered via an email link at 14:02 UTC",
    );
    expect(questionReceipt({ kind: "answered", replyText: "free text" }, "bridge", at)).toBe(
      "✅ free text — answered via the web app at 14:02 UTC",
    );
  });
  it("says an expired or withdrawn question went on without an answer", () => {
    expect(questionReceipt({ kind: "wait-timeout" }, "policy", at)).toBe(
      "⌛ No answer came in time at 14:02 UTC; the task went on without one.",
    );
    expect(questionReceipt({ kind: "cancelled" }, "policy", at)).toBe("✖ This question was withdrawn at 14:02 UTC.");
    expect(questionReceipt({ kind: "wait-timeout", answers: ["Wait"] }, "policy", at)).toBe(
      "⌛ No answer came in time at 14:02 UTC; the task went with the default: Wait.",
    );
  });
  it("tells a press on an expired question what the task went with", async () => {
    const { runtime, messages, answered } = await harness(
      [
        {
          toolCall: {
            id: "q1",
            name: "operator.ask_user",
            input: { question: "Ship?", options: [{ label: "Ship" }, { label: "Wait" }], defaultOption: 2 },
          },
        },
        { text: "ok" },
      ],
      60_000,
      true,
    );
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("go"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    const token =
      messages()
        .find((message) => message.buttons !== undefined)
        ?.buttons?.[0]?.[0]?.data.split(":")[1] ?? "";
    await repositories.agentWaits.settle({ waitId, outcome: { kind: "wait-timeout", answers: ["Wait"] } });
    await runtime.messaging.ingest(press(`q:${token}:1`));
    expect(answered.at(-1)?.text).toBe("This question expired; the task went with the default: Wait.");
    await runtime.close();
  });
});

describe("questions with options", () => {
  const ask = (multiSelect = false, allowOther = true) =>
    ({
      toolCall: {
        id: "q1",
        name: "operator.ask_user",
        input: {
          question: "Which customer?",
          header: "Customer",
          options: [{ label: "Acme" }, { label: "Globex", description: "the big one" }, { label: "Initech" }],
          multiSelect,
          allowOther,
        },
      },
    }) as const;

  it("numbers the options, offers buttons, and answers the wait with the pressed label", async () => {
    const { runtime, messages, answered, edited } = await harness([ask(), { text: "thanks" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer for me"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waiting = await repositories.agentWaits.getActiveByTask(taskId);
    expect(waiting?.choices?.options.map((option) => option.label)).toEqual(["Acme", "Globex", "Initech"]);
    const question = messages().find((message) => (message.parts[0] as { content: string }).content.startsWith("❓"));
    expect((question?.parts[0] as { content: string }).content).toMatch(
      /^❓ Customer — Which customer\?\n1\. Acme\n2\. Globex — the big one\n3\. Initech\nReply with a number, or with your own answer\.\n⌛ Answer by (\w{3} \d{1,2} \w{3}, )?\d\d:\d\d UTC$/,
    );
    const token = question?.buttons?.[0]?.[0]?.data.split(":")[1] ?? "";
    expect(question?.buttons?.map((row) => row.map((button) => button.data))).toEqual([
      [`q:${token}:1`],
      [`q:${token}:2`],
      [`q:${token}:3`],
    ]);

    await runtime.messaging.ingest(press(`q:${token}:2`));
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    expect((await repositories.agentWaits.get(waiting?.waitId ?? ""))?.settledOutcome).toMatchObject({
      kind: "answered",
      answers: ["Globex"],
      replyText: "Globex",
    });
    expect(answered.at(-1)?.text).toBe("Answered: Globex");
    expect(edited.at(-1)?.text).toMatch(/✅ Globex$/);
    await runtime.close();
  });

  it("lists an open question in the needs queue with the chat it went to, and drops it once answered", async () => {
    const { runtime, messages } = await harness([ask(), { text: "thanks" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const listed = await listNeeds(repositories, { workspaceId: "default" }, runtime.channelName);
    expect(listed.needs).toEqual([
      expect.objectContaining({
        kind: "question",
        taskId,
        question: expect.objectContaining({
          question: "Which customer?",
          origin: "messaging",
          choices: expect.objectContaining({ header: "Customer" }),
          deliveries: [expect.objectContaining({ connectionId: "conn-a" })],
        }),
      }),
    ]);
    const token =
      messages()
        .find((message) => message.buttons !== undefined)
        ?.buttons?.[0]?.[0]?.data.split(":")[1] ?? "";
    await runtime.messaging.ingest(press(`q:${token}:1`));
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    expect((await listNeeds(repositories, { workspaceId: "default" })).needs).toEqual([]);
    await runtime.close();
  });

  it("answers a chat's question from the web, and says so in the chat", async () => {
    const { runtime, edited } = await harness([ask(false, false), { text: "thanks" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    const deps = { repositories, channelApprovals: runtime.channelApprovals };
    const owner = { workspaceId: "default", principalId: "alice", caller: "bridge", authority: "operator" } as const;
    // Someone else's task is not found; an answer outside the options is refused, and nothing is settled.
    expect(await answerNeed(deps, { actor: { ...owner, principalId: "mallory" }, taskId, answer: "1", via: "bridge" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await answerNeed(deps, { actor: owner, taskId, answer: "Hooli", via: "bridge" })).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Reply with one of: 1. Acme, 2. Globex, 3. Initech." },
    });
    expect(await answerNeed(deps, { actor: owner, taskId, waitId: "another-wait", answer: "2", via: "bridge" })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });

    expect(await answerNeed(deps, { actor: owner, taskId, waitId, answer: "2", via: "bridge" })).toEqual({
      ok: true,
      result: { taskId, waitId, answers: ["Globex"] },
    });
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    expect(edited.at(-1)?.text).toMatch(/\n\n✅ Globex — answered via the web app at \d\d:\d\d UTC$/);
    expect(await answerNeed(deps, { actor: owner, taskId, answer: "2", via: "bridge" })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    await runtime.close();
  });

  it("lets the workspace's operator answer a person's question from the web, resuming the person's own task", async () => {
    const { runtime } = await harness([ask(false, false), { text: "thanks" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    // Ana, allowed under a principal of her own: her task is hers, not the operator's.
    await repositories.messagingIdentityBindings.bind({
      connectionId: "conn-a",
      externalSenderId: "user-2",
      workspaceId: "default",
      principalId: "ana",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await runtime.messaging.ingest(inbound("pick a customer", "user-2"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    await waitFor(async () => (await repositories.agentWaits.getActiveByTask(taskId)) !== undefined);
    expect((await repositories.tasks.get(taskId))?.principalId).toBe("ana");
    const operator = { workspaceId: "default", principalId: "alice", caller: "bridge", authority: "operator" } as const;
    const deps = {
      repositories,
      channelApprovals: runtime.channelApprovals,
      operatorOf: (workspaceId: string) => (workspaceId === "default" ? "alice" : undefined),
    };
    // Nobody else in the workspace, and not without knowing who its operator is.
    expect(await answerNeed(deps, { actor: { ...operator, principalId: "mallory" }, taskId, answer: "1", via: "bridge" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(
      await answerNeed(
        { repositories, channelApprovals: runtime.channelApprovals },
        { actor: operator, taskId, answer: "1", via: "bridge" },
      ),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    expect(await answerNeed(deps, { actor: operator, taskId, waitId, answer: "2", via: "bridge" })).toEqual({
      ok: true,
      result: { taskId, waitId, answers: ["Globex"] },
    });
    // Her task goes on, as hers; the answer is recorded as the operator's.
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    expect((await repositories.tasks.get(taskId))?.principalId).toBe("ana");
    expect(await repositories.agentWaits.get(waitId)).toMatchObject({ settledOutcome: { kind: "answered", answers: ["Globex"] } });
    await runtime.close();
  });

  it("never settles a browser handoff's wait from a chat message or approvals answer: it ends in the live view", async () => {
    const { runtime } = await harness([ask(), { text: "thanks" }, { text: "a new task" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    // The same wait, as a handoff records it.
    inspectDatabase(runtime.store)
      .prepare("UPDATE tavi_agent_wait_intents SET handoff_json = ? WHERE wait_id = ?")
      .run(JSON.stringify({ sessionId: "6f1d2c3b-0000-4000-8000-000000000001", reason: "sign-in" }), waitId);
    await runtime.messaging.ingest({ ...inbound("3"), externalReplyToId: "m-1" });
    const owner = { workspaceId: "default", principalId: "alice", caller: "bridge", authority: "operator" } as const;
    expect(
      await answerNeed(
        { repositories, channelApprovals: runtime.channelApprovals },
        { actor: owner, taskId, waitId, answer: "3", via: "bridge" },
      ),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    await delay(50);
    expect((await repositories.agentWaits.get(waitId))?.state).toBe("active");
    await runtime.close();
  });

  it("takes a typed reply to a question's message, in the chat it was sent to, as its answer", async () => {
    const { runtime } = await harness([ask(), { text: "thanks" }, { text: "a new task" }, { text: "another" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    // Message ids are a chat's own: m-1 in another chat is some other message.
    await runtime.messaging.ingest({ ...inbound("3"), externalConversationId: "chat-2", externalReplyToId: "m-1" });
    expect((await repositories.agentWaits.get(waitId))?.state).toBe("active");
    // As a scheduled task's question is: sent to a named chat (chat-3, as m-9) that has no task of its own.
    inspectDatabase(runtime.store)
      .prepare("UPDATE tavi_need_deliveries SET chat_id = 'chat-3', provider_message_id = 'm-9' WHERE wait_id = ?")
      .run(waitId);
    // A reply with no answer in it is dropped, not run as an instruction on the question's task.
    const admissions = (await repositories.tasks.listAdmissions(taskId)).length;
    await runtime.messaging.ingest({ ...inbound("   "), externalConversationId: "chat-3", externalReplyToId: "m-9" });
    expect((await repositories.tasks.listAdmissions(taskId)).length).toBe(admissions);
    await runtime.messaging.ingest({ ...inbound("3"), externalConversationId: "chat-3", externalReplyToId: "m-9" });
    await waitFor(async () => (await repositories.agentWaits.get(waitId))?.state === "settled");
    expect((await repositories.agentWaits.get(waitId))?.settledOutcome?.answers).toEqual(["Initech"]);
    expect(await repositories.messagingConversations.get("conn-a", "chat-3")).toBeUndefined();
    await runtime.close();
  });

  it("does not take someone else's typed answer, or reply, as the answer to the owner's question (invariant 5)", async () => {
    const { runtime } = await harness([ask(), { text: "thanks" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await repositories.messagingIdentityBindings.bind({
      connectionId: "conn-a",
      externalSenderId: "user-2",
      workspaceId: "default",
      principalId: "bob",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    // Bob's message is not the answer; what becomes of it otherwise is unchanged by this check.
    await runtime.messaging.ingest(inbound("1", "user-2")).catch(() => undefined);
    await runtime.messaging.ingest({ ...inbound("2", "user-2"), externalReplyToId: "m-1" }).catch(() => undefined);
    expect((await repositories.agentWaits.get(waitId))?.state).toBe("active");
    await runtime.close();
  });

  it("answers, by typing in the conversation, a question a worker asked there when the conversation's task asks none", async () => {
    const { runtime } = await harness([{ text: "done" }, { text: "noted" }, { text: "again" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("hello"));
    const rootId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    await waitFor(async () => (await repositories.tasks.get(rootId))?.status === "completed");
    // A worker's question, asked in the root's conversation.
    const workerId = "task-worker";
    await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "alice",
      operationKey: "op-worker",
      kind: "start",
      intent: { prompt: "w" },
      checkpointNamespace: "",
      origin: "agent",
      newTaskId: (() => workerId)(),
      newAdmissionId: (() => "adm-worker")(),
      newThreadId: (() => "thread-worker")(),
      now: (() => nowTimestamp())(),
    });
    await repositories.agentWaits.prepare({
      waitId: "w-worker",
      taskId: workerId,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      choices: { options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false, allowOther: false },
    });
    await repositories.agentWaits.activate("w-worker");
    await repositories.needDeliveries.record({
      waitId: "w-worker",
      taskId: workerId,
      connectionId: "conn-a",
      destination: { fixtureChat: "chat-1" },
      chatId: "chat-1",
      text: "❓ Which colour?",
      token: "tok-w",
      createdAt: nowTimestamp(),
    });
    // Only a worker of this chat's own tree is answered from it.
    await runtime.messaging.ingest(inbound("1")).catch(() => undefined);
    expect((await repositories.agentWaits.get("w-worker"))?.state).toBe("active");
    await repositories.agentDelegations.recordSpawn({
      operationKey: "spawn-worker",
      workspaceId: "default",
      principalId: "alice",
      workerTaskId: workerId,
      workerAgentId: "agent-1",
      parentTaskId: rootId,
      rootTaskId: rootId,
      depth: 1,
      createdAt: nowTimestamp(),
    });
    await runtime.messaging.ingest(inbound("2")).catch(() => undefined);
    await waitFor(async () => (await repositories.agentWaits.get("w-worker"))?.state === "settled");
    expect((await repositories.agentWaits.get("w-worker"))?.settledOutcome?.answers).toEqual(["Blue"]);
    await runtime.close();
  });

  it("collects toggles for a multi-select and answers on Done", async () => {
    const { runtime, messages, answered } = await harness([ask(true), { text: "thanks" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick customers"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    const token =
      messages()
        .find((message) => message.buttons !== undefined)
        ?.buttons?.[0]?.[0]?.data.split(":")[1] ?? "";
    await runtime.messaging.ingest(press(`q:${token}:ok`));
    expect(answered.at(-1)?.text).toBe("Pick at least one option first.");
    await runtime.messaging.ingest(press(`q:${token}:t3`));
    await runtime.messaging.ingest(press(`q:${token}:t1`));
    await runtime.messaging.ingest(press(`q:${token}:ok`));
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    expect((await repositories.agentWaits.get(waitId))?.settledOutcome?.answers).toEqual(["Acme", "Initech"]);
    await runtime.close();
  });

  it("keeps a question's delivery, text and toggles across a restart", async () => {
    const first = await harness([ask(true), { text: "thanks" }], 60_000, true);
    let repositories = first.runtime.store.asPort().repositories;
    await first.runtime.messaging.ingest(inbound("pick customers"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    const token =
      first
        .messages()
        .find((message) => message.buttons !== undefined)
        ?.buttons?.[0]?.[0]?.data.split(":")[1] ?? "";
    await first.runtime.messaging.ingest(press(`q:${token}:t1`));
    expect(await repositories.needDeliveries.listForWait(waitId)).toEqual([
      expect.objectContaining({
        connectionId: "conn-a",
        token,
        providerMessageId: "m-1",
        selected: [1],
        text: expect.stringMatching(/^❓ Customer — Which customer\?/),
      }),
    ]);
    await first.runtime.close();

    const second = await harness([{ text: "thanks" }], 60_000, true, 0, [], first.directory);
    repositories = second.runtime.store.asPort().repositories;
    await second.runtime.messaging.ingest(press(`q:${token}:t3`));
    await second.runtime.messaging.ingest(press(`q:${token}:ok`));
    await waitFor(async () => (await repositories.agentWaits.get(waitId))?.state === "settled");
    expect((await repositories.agentWaits.get(waitId))?.settledOutcome?.answers).toEqual(["Acme", "Initech"]);
    // The edit keeps the question's own text, read back from the record.
    expect(second.edited.at(-1)?.text).toMatch(/^❓ Customer — Which customer\?[\s\S]*✅ Acme, Initech$/);
    await second.runtime.close();
  });

  it("edits the question's message when it is answered by typing, and clears its buttons", async () => {
    const { runtime, edited } = await harness([ask(), { text: "thanks" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    await runtime.messaging.ingest(inbound("2"));
    await waitFor(() => edited.length > 0);
    expect(edited.at(-1)).toEqual({
      messageId: "m-1",
      text: expect.stringMatching(/^❓ Customer — Which customer\?[\s\S]*\n\n✅ Globex$/),
    });
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    await runtime.close();
  });

  it("marks an expired question in place, and tells a later press it expired", async () => {
    const { runtime, messages, edited, answered } = await harness([ask(), { text: "thanks" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    const token =
      messages()
        .find((message) => message.buttons !== undefined)
        ?.buttons?.[0]?.[0]?.data.split(":")[1] ?? "";
    // As the deadline sweep settles it.
    expect(await repositories.agentWaits.settle({ waitId, outcome: { kind: "wait-timeout" } })).toBe(true);
    await runtime.channelApprovals.onQuestionSettled({ waitId, outcome: { kind: "wait-timeout" }, via: "policy" });
    expect(edited.at(-1)?.text).toMatch(/\n\n⌛ No answer came in time at \d\d:\d\d UTC; the task went on without one\.$/);
    await runtime.messaging.ingest(press(`q:${token}:1`));
    expect(answered.at(-1)?.text).toBe("This question expired without an answer.");
    await runtime.close();
  });

  it("still says a question was withdrawn when editing its message fails, and tells a later press", async () => {
    const { runtime, messages, sent, answered, failEdits } = await harness([ask(), { text: "thanks" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    const token =
      messages()
        .find((message) => message.buttons !== undefined)
        ?.buttons?.[0]?.[0]?.data.split(":")[1] ?? "";
    await repositories.agentWaits.settle({ waitId, outcome: { kind: "cancelled" } });
    failEdits.value = true;
    await runtime.channelApprovals.onQuestionSettled({ waitId, outcome: { kind: "cancelled" }, via: "policy" });
    expect(sent().at(-1)).toMatch(/^✖ This question was withdrawn/);
    await runtime.messaging.ingest(press(`q:${token}:1`));
    expect(answered.at(-1)?.text).toBe("This question was withdrawn.");
    await runtime.close();
  });

  it("names where a question was answered when that was not its own chat", async () => {
    const { runtime, edited } = await harness([ask(), { text: "thanks" }], 60_000, true);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    await runtime.channelApprovals.onQuestionSettled({
      waitId,
      outcome: { kind: "answered", replyText: "Acme", answers: ["Acme"] },
      via: "link",
      at: "2026-10-02T14:02:00.000Z",
    });
    expect(edited.at(-1)?.text).toMatch(/\n\n✅ Acme — answered via an email link at 14:02 UTC$/);
    await runtime.close();
  });

  it("says in a follow-up that a question expired where its message cannot be edited", async () => {
    const { runtime, sent } = await harness([ask(), { text: "thanks" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    await repositories.agentWaits.settle({ waitId, outcome: { kind: "wait-timeout" } });
    await runtime.channelApprovals.onQuestionSettled({ waitId, outcome: { kind: "wait-timeout" }, via: "policy" });
    expect(sent().at(-1)).toMatch(/^⌛ No answer came in time/);
    // An answer gives no follow-up: the person gave it.
    const before = sent().length;
    await runtime.channelApprovals.onQuestionSettled({
      waitId,
      outcome: { kind: "answered", replyText: "Acme", answers: ["Acme"] },
      via: "conn-a",
    });
    expect(sent().length).toBe(before);
    await runtime.close();
  });

  it("acknowledges an answer sent again instead of starting a new turn, and lets anything else through", async () => {
    const { runtime, sent } = await harness([ask(), { text: "thanks" }, { text: "a new turn" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    await runtime.messaging.ingest(inbound("2"));
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    const admissions = (await repositories.tasks.listAdmissions(taskId)).length;
    await runtime.messaging.ingest(inbound("Globex"));
    expect(sent().at(-1)).toBe("That question was already answered: Globex. To ask for something new, say it in other words.");
    expect((await repositories.tasks.listAdmissions(taskId)).length).toBe(admissions);
    await runtime.messaging.ingest(inbound("now draft the email to them"));
    expect((await repositories.tasks.listAdmissions(taskId)).length).toBe(admissions + 1);
    await runtime.close();
  });

  it("names a free-text answer when a later message picks an option again", async () => {
    const { runtime, sent } = await harness([ask(), { text: "thanks" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    await runtime.messaging.ingest(inbound("Hooli, the new one"));
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    await runtime.messaging.ingest(inbound("2"));
    expect(sent().at(-1)).toBe("That question was already answered: Hooli, the new one. To ask for something new, say it in other words.");
    await runtime.close();
  });

  it("reads a typed answer against the options, and refuses one outside them where not allowed", async () => {
    const { runtime, sent } = await harness([ask(false, false), { text: "thanks" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("pick a customer"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    await runtime.messaging.ingest(inbound("Hooli"));
    expect(sent().at(-1)).toBe("Reply with one of: 1. Acme, 2. Globex, 3. Initech.");
    expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");
    await runtime.messaging.ingest(inbound("3"));
    expect((await repositories.agentWaits.get(waitId))?.settledOutcome).toMatchObject({ answers: ["Initech"] });
    await runtime.close();
  });

  it("gives a chat-started question a day to be answered", async () => {
    const { runtime } = await harness([ask(), { text: "thanks" }]);
    const repositories = runtime.store.asPort().repositories;
    const before = Date.now();
    await runtime.messaging.ingest(inbound("pick"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const deadline = Date.parse((await repositories.agentWaits.getActiveByTask(taskId))?.deadlineAt ?? "");
    expect(deadline - before).toBeGreaterThan(23 * 60 * 60 * 1000);
    await runtime.close();
  });
});

describe("a schedule that may ask", () => {
  it("asks in its alert destination under its name, before its next fire, and carries on under its policy once answered", async () => {
    const asked = {
      toolCall: {
        id: "q1",
        name: "operator.ask_user",
        input: {
          question: "Send the brief to the whole team?",
          options: [{ label: "Team" }, { label: "Only me" }],
          defaultOption: 2,
          connectionId: "conn-a",
          chatId: "chat-elsewhere",
        },
      },
    } as const;
    const { runtime, messages } = await harness([asked, { text: "brief ready" }]);
    const repositories = runtime.store.asPort().repositories;
    const now = nowTimestamp();
    const nextRunAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const schedule = await repositories.schedules.create({
      scheduleId: "sched-ask",
      workspaceId: "default",
      principalId: "alice",
      name: "Morning brief",
      prompt: "Write the brief",
      spec: { at: "07:00", timezone: "UTC" },
      missedRunPolicy: "skip",
      autoApproveTools: [],
      alert: { connectionId: "conn-a", destination: "chat-9" },
      humanCheckpoints: "ask-with-default",
      enabled: true,
      nextRunAt,
      now,
    });
    const fired = await runScheduleNow(schedule, runtime.scheduleDependencies!);
    expect(fired).toMatchObject({ kind: "ran", status: "waiting" });
    const taskId = (fired as { taskId: string }).taskId;
    // Asked where the operator pointed the schedule, not where the model said, under the schedule's name.
    const question = messages().find((message) => (message.parts[0] as { content?: string }).content?.includes("Send the brief"));
    expect(question?.destination).toEqual({ chatId: "chat-9" });
    expect((question?.parts[0] as { content?: string }).content).toMatch(/^⏸ Morning brief asks:/);
    const wait = await repositories.agentWaits.getActiveByTask(taskId);
    // Decided, with time to carry on, before the next fire.
    expect(Date.parse(wait?.deadlineAt ?? "")).toBeLessThanOrEqual(Date.parse(nextRunAt) - 15 * 60_000);

    const deps = { repositories, channelApprovals: runtime.channelApprovals };
    expect(
      await answerNeed(deps, {
        actor: { workspaceId: "default", principalId: "alice", caller: "bridge", authority: "operator" },
        taskId,
        answer: "1",
        via: "bridge",
      }),
    ).toMatchObject({ ok: true });
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    // Carried on, a manual run is still told apart from a scheduled one.
    await waitFor(async () => (await repositories.schedules.get("sched-ask"))?.lastOutcome === "manual run: completed");
    await runtime.close();
  });
});
