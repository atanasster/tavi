import {
  memoryScopeKey,
  type ChatNotice,
  type MemoryActor,
  type MemoryCardAnswer,
  type MemoryGetAnswer,
  type MemoryItem,
  type MemoryRecord,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { instructionsAndContextOf } from "@tavi/test-support/fakes";
import { fixturePromptPolicy } from "./prompt-policy.js";
import { createIpcClient, readDiscovery, readToken, type IpcClient } from "@tavi/runtime";
import { until, waitFor, temporaryDirectories, delay } from "@tavi/test-support";

import type { TaviRuntimeOptions } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { serve, type ServeHandle, type ServeTestingOverrides } from "../../src/server/serve.js";
import { ended, requestWithSubscription } from "./ipc-run.js";
import { fixtureRuntimeOptions } from "./serve-fixture.js";

/**
 * A real owner for memory's usage tests: served
 * with the `tavi.memory` host on a 200 ms tick, in UTC, with a Home for the
 * digest; a model that records every request and proposes "You're vegetarian"
 * when a message says "remember that", and reads a page when one says "read
 * the page"; and a digest clock the test sets, so a
 * digest is due only when a test says so. Shared by the IPC companion
 * (`memory-flow.test.ts`) and the Chromium run (`memory-ui.browser.test.ts`).
 */

const quiet: CliIo = { stdout: () => undefined, stderr: () => undefined, isTty: false };
const DAY_MS = 86_400_000;

/** What a message says to have the model propose `VEGETARIAN`. */
export const REMEMBER_PHRASE = "remember that";
/** What a message says to have the model read a page: `findings.list`, whose output is untrusted. */
export const READ_PAGE_PHRASE = "read the page";
export const VEGETARIAN = { title: "You're vegetarian", body: "The person is vegetarian and cooks at home." } as const;
export const OPERATOR_ACTOR: MemoryActor = { workspaceId: "default", principalId: "operator", caller: "test", authority: "operator" };
export const PERSONAL = { kind: "personal", principalId: "operator" } as const;
/** A turn's memory manifest, by its two sections' openings. */
export const MANIFEST_MARKERS = ["Known preferences.", "Retrieved memory evidence."] as const;
export const memoryTools = (request: ModelRequest | undefined): readonly string[] =>
  (request?.tools ?? []).map((tool) => tool.id).filter((id) => id.startsWith("memory.") || id === "sessions.search");
/**
 * What a request gave the model besides the conversation: its system text and its context block, where
 * the memory manifest goes, with the brackets retrieval puts round a matched word taken off.
 */
export const contextOf = (request: ModelRequest | undefined): string => instructionsAndContextOf(request).replace(/\[(\w+)\]/g, "$1");

export interface MemoryOwner {
  readonly directory: string;
  readonly handle: ServeHandle;
  readonly client: IpcClient;
  readonly homeId: string;
  /** Every model request, in order: the captured prompts. */
  readonly requests: ModelRequest[];
  /** A turn's generation requests since `from`: what the model was given to answer. */
  generationsSince(from: number): readonly ModelRequest[];
  readonly repositories: () => ReturnType<ServeHandle["runtime"]["store"]["asPort"]>["repositories"];
  /** The memory cards posted in a chat, as the owner renders them now, oldest first. */
  cards(taskId: string): Promise<readonly MemoryCardAnswer[]>;
  /** A record as the operator sees it now, or undefined once forgotten. */
  record(recordId: string): Promise<MemoryItem | undefined>;
  /** Forgets a record as the canvas does (`memory forget`). */
  forget(recordId: string): Promise<void>;
  /** One `memory` IPC call for the default workspace, as the canvas makes it. */
  memory<T>(payload: Record<string, unknown>): Promise<T>;
  /** Deletion journal rows for a record of the operator's own memory. */
  deletions(recordId: string): Promise<number>;
  /** Moves the digest's clock: a digest is due only once it reads 09:00 or later. */
  setDigestClock(at: Date | undefined): void;
  /** A proposal by the model, as a turn would make one, for the operator. */
  propose(title: string): Promise<MemoryRecord>;
  /** The instant `days` after `from`, at 10:00 UTC or later that day. */
  readonly daysAfter: (from: string, days: number) => Date;
  close(): Promise<void>;
}

/** Proposes `VEGETARIAN` when the newest message says "remember that", reads a page when it says "read the page"; otherwise "Noted." */
function proposingModel(requests: ModelRequest[]): ModelPort {
  return {
    async stream(request: ModelRequest): Promise<ModelOutcome> {
      requests.push(request);
      const done = {
        status: "completed" as const,
        attemptId: request.attemptId,
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
      };
      if (request.purpose !== undefined && request.purpose !== "generation") return { ...done, text: "A chat" };
      const last = request.messages.at(-1);
      if (last?.role === "user" && last.toolResults === undefined && last.text.toLowerCase().includes(REMEMBER_PHRASE)) {
        return {
          ...done,
          text: "",
          finishReason: "tool-calls",
          toolCalls: [
            {
              id: `propose-${requests.length}`,
              name: "memory.propose",
              input: { kind: "fact", title: VEGETARIAN.title, body: VEGETARIAN.body },
            },
          ],
        };
      }
      if (last?.role === "user" && last.toolResults === undefined && last.text.toLowerCase().includes(READ_PAGE_PHRASE)) {
        return {
          ...done,
          text: "",
          finishReason: "tool-calls",
          toolCalls: [{ id: `read-${requests.length}`, name: "findings.list", input: {} }],
        };
      }
      return { ...done, text: "Noted." };
    },
  };
}

/**
 * What a caller may put in place of the owner's defaults: the model (the
 * injection suite's scripted model) — `requests` then
 * records what reaches it all the same — or the providers the runtime options
 * configure, and runtime options laid over the memory flows' own (the real
 * default `approvalRequiredFor`, an HTTP allowlist, `serve --allow`).
 */
export interface MemoryOwnerOptions {
  /** `"configured"`: no stand-in at all — the providers in `runtime` answer (a live eval); `requests` then stays empty. */
  readonly model?: ModelPort | "configured";
  readonly runtime?: Partial<TaviRuntimeOptions>;
  /** A stand-in browser (the injection harness's observed page); absent: the real Playwright adapter, never launched unless a browser tool runs. */
  readonly browser?: ServeTestingOverrides["browserOverride"];
}

/** `model`, with every request it is sent recorded in `requests`. */
const recording = (model: ModelPort, requests: ModelRequest[]): ModelPort => ({
  stream: async (request, streamOptions) => {
    requests.push(request);
    return await model.stream(request, streamOptions);
  },
});

export async function startMemoryOwner(prefix: string, options: MemoryOwnerOptions = {}): Promise<MemoryOwner> {
  const directories = temporaryDirectories();
  const directory = directories.create(prefix);
  const requests: ModelRequest[] = [];
  // Before 09:00 until a test moves it: no digest goes out unasked.
  let digestAt: Date | undefined;
  const handle = await serve(
    fixtureRuntimeOptions(directory, {
      providers: [{ connectionId: "fixture", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "fixture" }],
      approvalRequiredFor: [],
      memoryHostEnabled: true,
      ...options.runtime,
    }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    quiet,
    {
      ...(options.model === "configured"
        ? {}
        : { modelOverride: options.model === undefined ? proposingModel(requests) : recording(options.model, requests) }),
      ...(options.browser === undefined ? {} : { browserOverride: options.browser }),
      memoryTiming: { tickMs: 200, now: () => digestAt ?? new Date("2026-01-01T05:00:00.000Z") },
    },
  );
  if ((await main(["config", "set", "workspace.timezone", "UTC", "--data-dir", directory], { io: quiet })) !== EXIT.ok)
    throw new Error("config set workspace.timezone failed");
  // Chats as the canvas starts them, not turns of Home: Home is on by default, and these tests are of memory.
  if ((await main(["config", "set", "chat.home", "off", "--data-dir", directory], { io: quiet })) !== EXIT.ok)
    throw new Error("config set chat.home failed");
  const discovery = readDiscovery(directory);
  const token = readToken(directory);
  if (discovery === undefined || token === undefined) throw new Error("no owner");
  const client = await createIpcClient({ endpoint: discovery.endpoint, sessionId: discovery.sessionId, token });
  const repositories = () => handle.runtime.store.asPort().repositories;
  // The operator's Home, where the digest goes: one settled turn, no memory of its own.
  const written = await repositories().tasks.admit({
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
  await repositories().tasks.commitAdmission({
    admissionId: written.admission.admissionId,
    taskId: "home-1",
    state: "committed",
    result: { status: "completed", finalText: "" },
  });
  const memoryIpc = async <T>(payload: Record<string, unknown>): Promise<T> => {
    const answer = await client.request("memory", { workspaceId: "default", ...payload }, `memory-${Math.random().toString(36).slice(2)}`);
    if (!answer.ok) throw new Error(`${answer.error?.code ?? "?"}: ${answer.error?.message ?? ""}`);
    return answer.result as T;
  };
  return {
    directory,
    handle,
    client,
    homeId: "home-1",
    requests,
    generationsSince: (from) => requests.slice(from).filter((request) => request.purpose === undefined || request.purpose === "generation"),
    repositories,
    cards: async (taskId) => {
      const notices: readonly ChatNotice[] = (await repositories().transcripts.notices(taskId, { limit: 100 })).filter(
        (notice) => notice.kind === "memory",
      );
      const cards: MemoryCardAnswer[] = [];
      for (const notice of notices) cards.push(await memoryIpc<MemoryCardAnswer>({ action: "card", noticeId: notice.noticeId }));
      return cards;
    },
    record: async (recordId) => {
      try {
        return (await memoryIpc<MemoryGetAnswer>({ action: "get", recordId })).record;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("NOT_FOUND")) return undefined;
        throw error;
      }
    },
    forget: async (recordId) => {
      await memoryIpc({ action: "forget", recordId });
    },
    memory: memoryIpc,
    deletions: async (recordId) =>
      (await repositories().memory.listDeletions({ scopeKeys: [memoryScopeKey(PERSONAL)], limit: 100 })).filter(
        (row) => row.recordId === recordId,
      ).length,
    setDigestClock: (at) => {
      digestAt = at;
    },
    propose: async (title) =>
      await handle.runtime.memory.propose({
        actor: { ...OPERATOR_ACTOR, caller: "agent", authority: "model" },
        scope: PERSONAL,
        kind: "fact",
        title,
        body: title,
      }),
    daysAfter: (from, days) => {
      const at = new Date(Date.parse(from) + days * DAY_MS);
      if (at.getUTCHours() < 10) at.setUTCHours(10, 0, 0, 0);
      return at;
    },
    close: async () => {
      client.close();
      await handle.shutdown("test");
      directories.cleanup();
    },
  };
}

/** Waits until a chat has `count` saved turns, and answers the newest's seq. */
export async function savedTurns(owner: MemoryOwner, taskId: string, count: number): Promise<number> {
  const page = await until(
    async () => await owner.repositories().transcripts.page(taskId, { limit: 50 }),
    (read) => read.entries.length >= count,
  );
  return page.entries.at(-1)?.seq ?? 0;
}

let sequence = 0;

/** A new chat started over IPC as a terminal starts one, its first turn settled; answers its task id. */
export async function startChat(owner: MemoryOwner, prompt: string): Promise<string> {
  sequence += 1;
  const started = await requestWithSubscription(
    owner.client,
    "run",
    { workspaceId: "default", principal: "operator", approval: "client", prompt, operationKey: `memory-chat-${sequence}` },
    `run-${sequence}`,
  );
  if (!started.response.ok) throw new Error(JSON.stringify(started.response.error));
  await waitFor(() => ended(started.events));
  started.off();
  const taskId = (started.response.result as { readonly taskId: string }).taskId;
  await savedTurns(owner, taskId, 1);
  return taskId;
}

/** The chat's next message over IPC, its turn settled; answers the saved turn's seq. */
export async function replyIn(owner: MemoryOwner, taskId: string, text: string): Promise<number> {
  sequence += 1;
  const before = (await owner.repositories().transcripts.page(taskId, { limit: 50 })).entries.length;
  const answer = await owner.client.request(
    "reply",
    { workspaceId: "default", taskId, text, clientMessageId: `memory-message-${sequence}` },
    `reply-${sequence}`,
    { timeoutMs: 15_000 },
  );
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  const seq = await savedTurns(owner, taskId, before + 1);
  await waitFor(async () => (await owner.repositories().tasks.get(taskId))?.status === "completed");
  return seq;
}

/** A slash command in a chat, as the canvas and the terminal run one (`plugin-commands run`); answers its text. */
export async function commandIn(owner: MemoryOwner, taskId: string, line: string): Promise<string> {
  sequence += 1;
  const [name = "", ...rest] = line.slice(1).split(" ");
  // Under the per-sender command rate.
  await delay(260);
  const answer = await owner.client.request(
    "plugin-commands",
    { action: "run", workspaceId: "default", name, args: rest.join(" "), taskId },
    `command-${sequence}`,
  );
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  return (answer.result as { readonly text?: string }).text ?? "";
}
