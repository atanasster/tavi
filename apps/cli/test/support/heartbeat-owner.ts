import { temporaryDirectories } from "@tavi/test-support";
import type { HeartbeatTickRecord, MemoryActor, ModelOutcome, ModelPort, ModelRequest } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { fixturePromptPolicy } from "./prompt-policy.js";
import { createIpcClient, readDiscovery, readToken, type IpcClient } from "@tavi/runtime";

import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureRuntimeOptions } from "./serve-fixture.js";

/**
 * A real owner for the heartbeat's usage tests:
 * served on a 1 s interval floor and a 200 ms sweep, in UTC with Home on,
 * with a model that records every request and reports what the test queues
 * once through heartbeat.report.
 */

export const HEARTBEAT_SWEEP_MS = 200;
const quiet: CliIo = { stdout: () => undefined, stderr: () => undefined, isTty: false };

export interface HeartbeatOwner {
  readonly directory: string;
  readonly handle: ServeHandle;
  readonly client: IpcClient;
  /** Every model request, in order: the captured prompts. */
  readonly requests: ModelRequest[];
  /** Queues what the next turn reports through heartbeat.report, once. */
  report(items: readonly unknown[]): void;
  /** Whether a queued report is still waiting for a turn. */
  readonly reportPending: () => boolean;
  readonly repositories: () => ReturnType<ServeHandle["runtime"]["store"]["asPort"]>["repositories"];
  /** The operator's ticks, newest first. */
  readonly ticks: () => Promise<readonly HeartbeatTickRecord[]>;
  close(): Promise<void>;
}

/** A request's messages as one text. */
export const promptOf = (request: ModelRequest | undefined): string => request?.messages.map((message) => message.text).join("\n") ?? "";

/** `HH:MM` in UTC, the workspace's zone here. */
export const hhmm = (date: Date): string =>
  `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;

/** Hours from an hour ago to an hour from now, so the run is inside them. */
export const hoursAroundNow = (): { start: string; end: string } => ({
  start: hhmm(new Date(Date.now() - 60 * 60_000)),
  end: hhmm(new Date(Date.now() + 60 * 60_000)),
});

export async function startHeartbeatOwner(prefix: string): Promise<HeartbeatOwner> {
  const directories = temporaryDirectories();
  const directory = directories.create(prefix);
  const requests: ModelRequest[] = [];
  let reportNext: readonly unknown[] | undefined;
  const fixture = createFixtureModel({ turns: [{ text: "done" }] });
  const model: ModelPort = {
    ...fixture,
    stream: async (request: ModelRequest): Promise<ModelOutcome> => {
      requests.push(request);
      const first = !request.messages.some((message) => message.role === "tool");
      if (first && reportNext !== undefined) {
        const items = reportNext;
        reportNext = undefined;
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: `report-${requests.length}`, name: "heartbeat.report", input: { items } }],
          finishReason: "tool-calls",
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        };
      }
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: "All quiet.",
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
      };
    },
  };
  const handle = await serve(
    fixtureRuntimeOptions(directory, {
      providers: [{ connectionId: "fixture", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "fixture" }],
      heartbeatEnabled: true,
    }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    quiet,
    { modelOverride: model, heartbeatTiming: { sweepMs: HEARTBEAT_SWEEP_MS, intervalFloorMs: 1_000 } },
  );
  for (const [key, value] of [
    ["workspace.timezone", "UTC"],
    ["chat.home", "on"],
  ] as const) {
    if ((await main(["config", "set", key, value, "--data-dir", directory], { io: quiet })) !== EXIT.ok)
      throw new Error(`config set ${key} failed`);
  }
  const discovery = readDiscovery(directory);
  const token = readToken(directory);
  if (discovery === undefined || token === undefined) throw new Error("no owner");
  const client = await createIpcClient({ endpoint: discovery.endpoint, sessionId: discovery.sessionId, token });
  const repositories = () => handle.runtime.store.asPort().repositories;
  return {
    directory,
    handle,
    client,
    requests,
    report: (items) => {
      reportNext = items;
    },
    reportPending: () => reportNext !== undefined,
    repositories,
    ticks: async () => await repositories().heartbeats.listTicks({ workspaceId: "default", principalId: "operator", limit: 200 }),
    close: async () => {
      client.close();
      await handle.shutdown("test");
      directories.cleanup();
    },
  };
}

/** A Home for the card, with no turn of its own: a person who just wrote in Home is busy, and the heartbeat waits for them (G2). */
export async function seedHome(owner: HeartbeatOwner): Promise<string> {
  const written = await owner.repositories().tasks.admit({
    prompt: fixturePromptPolicy,
    workspaceId: "default",
    principalId: "operator",
    operationKey: "seed-home",
    kind: "start",
    intent: { prompt: "earlier" },
    checkpointNamespace: "",
    chatKind: "home",
    newTaskId: "home-1",
    newAdmissionId: "adm-home-1",
    newThreadId: "thread-home-1",
    now: nowTimestamp(),
  });
  await owner.repositories().tasks.commitAdmission({
    admissionId: written.admission.admissionId,
    taskId: "home-1",
    state: "committed",
    result: { status: "completed", finalText: "" },
  });
  return "home-1";
}

export const OPERATOR: MemoryActor = { workspaceId: "default", principalId: "operator", caller: "test", authority: "operator" };

/** What a turn must never be given: memory search would match each, but none is the person's own, approved record. */
export const EXCLUDED_MEMORY = ["belong to Bob", "noted in one chat", "nobody approved"] as const;

/** The person's preference and fact about ACME, and another person's, a run-local and a pending record about it too. */
export async function seedMemory(owner: HeartbeatOwner): Promise<{ readonly preference: string; readonly fact: string }> {
  const memory = owner.handle.runtime.memory;
  const preference = await memory.remember({
    actor: OPERATOR,
    scope: { kind: "personal", principalId: "operator" },
    kind: "preference",
    body: "Keep it short",
    preferenceKey: "tone",
    preference: { valueType: "string", value: "short" },
  });
  const fact = await memory.remember({
    actor: OPERATOR,
    scope: { kind: "personal", principalId: "operator" },
    kind: "fact",
    body: "ACME pays invoices late but always pays",
  });
  await memory.remember({
    actor: { ...OPERATOR, principalId: "bob" },
    scope: { kind: "personal", principalId: "bob" },
    kind: "fact",
    body: "ACME invoices belong to Bob",
  });
  await memory.remember({
    actor: { ...OPERATOR, runId: "chat-1" },
    scope: { kind: "run_local", principalId: "operator", workspaceId: "default", runId: "chat-1" },
    kind: "fact",
    body: "ACME invoices noted in one chat",
  });
  await memory.propose({
    actor: { ...OPERATOR, authority: "model" },
    scope: { kind: "personal", principalId: "operator" },
    kind: "fact",
    body: "ACME invoices proposal nobody approved",
  });
  return { preference: preference.recordId, fact: fact.recordId };
}
