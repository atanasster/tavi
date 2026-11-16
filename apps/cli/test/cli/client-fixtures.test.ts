import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { replayRun } from "@tavi/client/node";
import {
  ClientEventSchema,
  approvalRowId,
  waitRowId,
  type ClientEvent,
  type InboundEvent,
  type ModelOutcome,
  type ModelPort,
} from "@tavi/contracts";
import { createFixtureMessagingConnectorDefinition } from "@tavi/test-support/messaging";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { createRunEventBus } from "@tavi/runtime";
import { waitFor } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import { ATTACHED, capture, capturing, ndjson, useAttachedOwners } from "../support/attached-owner.js";
import { requestWithSubscription } from "../support/ipc-run.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The event fixtures `@tavi/client`'s reducers replay,
 * recorded here from real streams: `tavi run --format json` (and `--attach`)
 * against a live owner, the owners' own frames across a restart, and a
 * chat-admitted task on the bus every front end reads. Each scenario is run
 * again on every test run and compared with its committed file, so a change
 * to what the owner emits shows up as a fixture that no longer matches.
 * Re-record with `TAVI_RECORD_FIXTURES=1`.
 *
 * Normalized, so they are stable: epochs, task, thread, attempt and artifact
 * ids become placeholders in order of first appearance (and the
 * length-prefixed approval and wait ids are rebuilt from them), times become a
 * fixed clock, durations 0, and tool payloads lose minted ids and long
 * strings. Sequences are kept, and each epoch becomes a placeholder, so epoch
 * changes survive: they are what the reducers check.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/client/test/fixtures");
const RECORD = process.env["TAVI_RECORD_FIXTURES"] === "1";

const owners = useAttachedOwners("tavi-fixtures-");
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
});

const TARGET = ["--connection", "fixture-conn", "--model", "fixture-model"];

function normalize(events: readonly ClientEvent[]): ClientEvent[] {
  // Every minted id, in order of first appearance, with its placeholder.
  const names = new Map<string, string>();
  const counts = new Map<string, number>();
  const name = (space: string, value: string): string => {
    const known = names.get(value);
    if (known !== undefined) return known;
    const count = counts.get(space) ?? 0;
    counts.set(space, count + 1);
    names.set(value, `${space}-${count}`);
    return `${space}-${count}`;
  };
  for (const event of events) {
    name("epoch", event.epoch);
    name("task", event.runId);
    if ("supersededAttemptId" in event) name("attempt", event.supersededAttemptId);
    name("attempt", event.attemptId);
    if ("threadId" in event) name("thread", event.threadId);
    if (event.kind === "task.review_required") for (const request of event.requests) name("artifact", request.artifactId);
  }
  // Minted ids also appear inside other strings (a wait id names its task, a
  // provider's block id its attempt), so those are replaced wherever they
  // occur — longest first, so an id containing another is replaced whole. A
  // short literal (the bus's own `resync` attempt) is renamed only where it is
  // the field's value, never inside words such as `resync.required`.
  const minted = [...names.entries()].filter(([value]) => value.length >= 12).sort(([left], [right]) => right.length - left.length);
  const renamed = (text: string): string =>
    minted
      .reduce((current, [value, placeholder]) => current.split(value).join(placeholder), text)
      // Length-prefixed, so rebuilt from the placeholder rather than renamed in place.
      .replace(/wait:\d+:([^:"]+):(\d+):([^"]+)/g, (_match, task: string, steps: string, call: string) =>
        waitRowId(task, Number(steps), call),
      );
  const scrub = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value ?? null, (_key, inner: unknown) => {
        if (typeof inner !== "string") return inner;
        // Not its length: a producer that cuts by bytes cuts a varying number of characters.
        if (inner.length > 200) return "<long string>";
        return inner
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
          .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>");
      }),
    );
  const clock = Date.UTC(2026, 0, 1);
  return events.map((event, index) => {
    const copy = JSON.parse(renamed(JSON.stringify(event))) as Record<string, unknown>;
    copy["epoch"] = name("epoch", event.epoch);
    copy["runId"] = name("task", event.runId);
    copy["attemptId"] = name("attempt", event.attemptId);
    if ("supersededAttemptId" in event) copy["supersededAttemptId"] = name("attempt", event.supersededAttemptId);
    if ("threadId" in event) copy["threadId"] = name("thread", event.threadId);
    if (event.kind === "task.review_required") {
      copy["requests"] = event.requests.map((request) => ({ ...request, artifactId: name("artifact", request.artifactId) }));
    }
    copy["at"] = new Date(clock + index * 1_000).toISOString();
    if ("durationMs" in event) copy["durationMs"] = 0;
    if ("deadlineAt" in event) copy["deadlineAt"] = new Date(clock + 86_400_000).toISOString();
    if ("input" in event) copy["input"] = scrub(copy["input"]);
    if ("output" in event) copy["output"] = scrub(copy["output"]);
    // Rebuilt rather than renamed: the id is length-prefixed.
    if (event.kind === "approval.required") copy["approvalId"] = approvalRowId(String(copy["runId"]), event.callId, event.steps);
    // A label's refs say when their content arrived: the run's clock, not the fixture's.
    const label = (copy["risk"] as { label?: { refs?: { at: string }[] } } | undefined)?.label;
    for (const ref of label?.refs ?? []) ref.at = new Date(clock).toISOString();
    // …and so do the refs an approval's provenance names.
    const provenance = copy["provenance"] as { refs?: { at: string }[] } | undefined;
    for (const ref of provenance?.refs ?? []) ref.at = new Date(clock).toISOString();
    // Still an event the contract accepts: the reducers parse nothing else.
    return ClientEventSchema.parse(copy);
  });
}

/** Compare a recorded stream with its committed fixture, or write it when recording. */
function matchesFixture(name: string, events: readonly ClientEvent[]): void {
  const normalized = normalize(events);
  const path = join(FIXTURES, `${name}.ndjson`);
  if (RECORD) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(path, normalized.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }
  expect(normalized).toEqual(ndjson(readFileSync(path, "utf8")));
}

/** A turn that says something under `blockId` and asks for `calls`; then an answer. Ids repeat as a provider may repeat them. */
function scripted(rounds: readonly (readonly string[])[], blockId = "txt-0"): ModelPort {
  let calls = 0;
  return {
    async stream(request, options): Promise<ModelOutcome> {
      const round = rounds[calls];
      calls += 1;
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId, text: round === undefined ? "done" : "working… " });
      if (round === undefined) return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: "working… ",
        toolCalls: round.map((id) => ({ id, name: "browser.create_session", input: {} })),
        finishReason: "tool-calls",
        usage: {},
      };
    },
  };
}

/** Run `argv` against `directory`, expecting `code`; its stdout. */
async function tavi(directory: string, argv: readonly string[], code: number): Promise<string> {
  const out = capture();
  expect(await main([...argv, "--data-dir", directory], { io: out.io }), out.stderr()).toBe(code);
  return out.stdout();
}

/** `tavi run … --format json`: its stream. */
async function run(directory: string, argv: readonly string[], code: number): Promise<ClientEvent[]> {
  return ndjson(await tavi(directory, ["run", ...argv, "--format", "json"], code));
}

describe("the client's event fixtures, recorded from real streams", ATTACHED, () => {
  it("two-call-round: one turn asks for two gated calls, decided together", async () => {
    const { directory } = await owners.startOwner(scripted([["call-a", "call-b"]]));
    const events = await run(directory, ["open two browsers", "--approval", "approve"], EXIT.ok);
    expect(events.filter((event) => event.kind === "approval.required")).toHaveLength(2);
    matchesFixture("two-call-round", events);
  });

  it("reused-call-id: every turn reuses one call id and one text block id, across three admissions", async () => {
    const { directory } = await owners.startOwner(scripted([["call-1"], ["call-1"]]));
    const events = await run(directory, ["open a browser twice", "--approval", "approve"], EXIT.ok);
    expect(events.filter((event) => event.kind === "attempt.replaced")).toHaveLength(2);
    matchesFixture("reused-call-id", events);
  });

  it("settled-by-another-client: the round is decided elsewhere, and the stream says so", async () => {
    const { directory } = await owners.startOwner(scripted([["call-1"]]));
    const asked = await run(directory, ["open a browser"], EXIT.approvalRequired);
    const taskId = asked[0]?.runId ?? "";
    await tavi(directory, ["approvals", "approve", taskId, "--decided-by", "another-client", "--format", "json"], EXIT.ok);
    const events = await run(directory, ["--attach", taskId], EXIT.ok);
    expect(events.find((event) => event.kind === "approval.settled")).toMatchObject({ decidedBy: "another-client" });
    matchesFixture("settled-by-another-client", events);
  });

  it("review-required: an artifact a person must review suspends the task until it is reviewed", async () => {
    const { handle, directory } = await owners.startOwner(capturing("reviewed", "b-review"), { review: true });
    const suspended = await run(directory, ["archive it"], EXIT.reviewRequired);
    const taskId = suspended[0]?.runId ?? "";
    const artifactId = (await handle.runtime.store.asPort().repositories.artifacts.listPendingReview("default", 10))[0]?.artifactId ?? "";
    await tavi(directory, ["artifacts", "approve", artifactId, "--resume", ...TARGET, "--format", "json"], EXIT.ok);
    const events = await run(directory, ["--attach", taskId], EXIT.ok);
    expect(events.map((event) => event.kind)).toContain("task.review_required");
    matchesFixture("review-required", events);
  });

  it("resync-after-restart: a subscription resumed on the owner that replaced a restarted one", async () => {
    // Recorded from the owners' own frames, through the runtime's plain IPC
    // client: `@tavi/client` drops an event it already delivered, so a
    // fixture recorded through it could not show an owner that sent one twice.
    const { handle, directory } = await owners.startOwner(scripted([["call-1"]]));
    const asked = await run(directory, ["open a browser"], EXIT.approvalRequired);
    const taskId = asked[0]?.runId ?? "";
    const before = await requestWithSubscription(await owners.attach(handle), "subscribe", { taskId, from: "beginning" }, "sub-before");
    expect(before.response.ok).toBe(true);
    await waitFor(() => before.events.some((event) => event.kind === "approval.required"));

    await owners.stopLatest("restart for the resync fixture");
    const { handle: next } = await owners.startOwner(scripted([[]]), { directory });
    // Resumed as any front end resumes: from the last event it was sent.
    const last = before.events.at(-1);
    if (last === undefined) throw new Error("nothing was recorded before the restart");
    const after = await requestWithSubscription(
      await owners.attach(next),
      "subscribe",
      { taskId, from: { epoch: last.epoch, sequence: last.sequence } },
      "sub-after",
    );
    expect(after.response.ok).toBe(true);
    await waitFor(() => after.events.some((event) => event.kind === "resync.required"));
    await tavi(directory, ["approvals", "approve", taskId, "--format", "json"], EXIT.ok);
    await waitFor(() => after.events.at(-1)?.kind === "task.completed");
    before.off();
    after.off();
    matchesFixture("resync-after-restart", [...before.events, ...after.events]);
  });

  it("denied-then-failed: a denied round, then a model that fails the task", async () => {
    let calls = 0;
    const model: ModelPort = {
      async stream(request, options): Promise<ModelOutcome> {
        calls += 1;
        if (calls === 1) {
          options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "txt-0", text: "trying… " });
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "trying… ",
            toolCalls: [{ id: "call-1", name: "browser.create_session", input: {} }],
            finishReason: "tool-calls",
            usage: {},
          };
        }
        return {
          status: "failed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [],
          usage: {},
          error: { code: "provider", message: "the provider gave up", retryable: false },
        };
      },
    };
    const { directory } = await owners.startOwner(model);
    const events = await run(directory, ["open a browser", "--approval", "deny"], EXIT.taskFailed);
    expect(events.find((event) => event.kind === "approval.settled")).toMatchObject({ decisions: [{ callId: "call-1", approved: false }] });
    expect(events.at(-1)?.kind).toBe("task.failed");
    matchesFixture("denied-then-failed", events);
  });

  it("one-admission-reuse: a model that emits nothing of its own reuses a call id within one admission", async () => {
    // The model adapter assigns an attempt for every call even when the
    // provider emits no events; both reused call ids must remain distinct.
    let calls = 0;
    const model: ModelPort = {
      async stream(request, options): Promise<ModelOutcome> {
        calls += 1;
        if (calls <= 2) {
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [{ id: "call-1", name: "agents.status", input: { taskId: `task-missing-${calls}` } }],
            finishReason: "tool-calls",
            usage: {},
          };
        }
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "txt-0", text: "neither exists" });
        return { status: "completed", attemptId: request.attemptId, text: "neither exists", toolCalls: [], usage: {} };
      },
    };
    const { directory } = await owners.startOwner(model);
    const events = await run(directory, ["check two tasks"], EXIT.ok);
    const started = events.filter((event) => event.kind === "tool.started");
    expect(started).toHaveLength(2);
    expect(new Set(started.map((event) => event.attemptId)).size).toBe(2);
    matchesFixture("one-admission-reuse", events);
  });

  it("waiting-question: a chat task asks the operator, waits on the answer, and continues", async () => {
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(owners.tempDirectory(), { approvalRequiredFor: [], messagingAllowedDestinations: ["chat-1"] }),
      {
        modelOverride: createFixtureModel({
          turns: [
            {
              toolCall: {
                id: "call-ask",
                name: "operator.ask_user",
                input: { question: "Which projects should I track?", connectionId: "chat-main", chatId: "chat-1" },
              },
            },
            { text: "tracking them" },
          ],
        }),
      },
    );
    runtimes.push(runtime);
    runtime.messaging.registerConnector(createFixtureMessagingConnectorDefinition());
    await runtime.messaging.openConnection({
      connection: {
        connectionId: "chat-main",
        providerId: "fixture",
        accountIdentity: "bot",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "chat-main",
      externalSenderId: "operator-chat",
      workspaceId: "default",
      principalId: "operator",
      approvedBy: "test",
      createdAt: "2026-04-05T00:00:00.000Z",
    });
    const inbound = (content: string, id: string): InboundEvent => ({
      connectionId: "chat-main",
      providerEventId: `evt-${id}`,
      kind: "message",
      externalSenderId: "operator-chat",
      externalConversationId: "chat-1",
      externalMessageId: `msg-${id}`,
      occurredAt: "2026-04-05T07:00:00.000Z",
      receivedAt: "2026-04-05T07:00:00.000Z",
      content,
    });

    await runtime.messaging.ingest(inbound("track my projects", "1"));
    const repositories = runtime.store.asPort().repositories;
    await waitFor(async () => (await repositories.messagingConversations.get("chat-main", "chat-1"))?.taskId !== undefined);
    const taskId = (await repositories.messagingConversations.get("chat-main", "chat-1"))?.taskId ?? "";
    const events: ClientEvent[] = [];
    // From the beginning, as a TUI attaching to the conversation's task would.
    const { replayed } = runtime.runEventBus.subscribe({ taskId, from: "beginning", deliver: (event) => events.push(event) });
    events.unshift(...replayed);
    await waitFor(() => events.some((event) => event.kind === "task.waiting"));
    await runtime.messaging.ingest(inbound("ai-crucible and elections-bg", "2"));
    await waitFor(() => events.at(-1)?.kind === "task.completed");
    expect(events.find((event) => event.kind === "task.waiting")).toMatchObject({ question: "Which projects should I track?" });
    matchesFixture("waiting-question", events);
  });
});

describe("the owner's bus and the client's reducer agree", () => {
  it("every stale subscriber of a silent task follows its marker with the first real event", () => {
    // After a restart each attached front end resubscribes with its old
    // epoch's cursor; a task suspended on a decision publishes nothing until
    // it is decided.
    const bus = createRunEventBus({ epoch: "session-2" });
    const streams: ClientEvent[][] = [[], []];
    for (const stream of streams) {
      const { resync } = bus.subscribe({
        taskId: "task-1",
        from: { epoch: "session-1", sequence: 7 },
        deliver: (event) => stream.push(event),
      });
      if (resync !== null) stream.push(resync);
    }
    bus.publish("task-1", { kind: "text.delta", runId: "task-1", attemptId: "attempt-1", blockId: "b", text: "decided" });
    for (const stream of streams) {
      const state = replayRun(stream);
      expect(state.truncated).toBe(true);
      expect(state.status).toBe("running");
    }
  });
});
