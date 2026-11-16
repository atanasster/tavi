import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import type { ModelPort, ModelRequest } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, until, waitFor, fakeFetch } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime, TaviRuntimeOptions } from "../../src/runtime/types.js";
import { REMINDER_NO_MODEL_NOTE } from "../../src/features/reminders/delivery.js";
import type { OwnerModelTarget } from "../../src/features/run/owner.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { saveChannelConnection } from "../support/saved-channel.js";
import { ended, requestWithSubscription } from "../support/ipc-run.js";

/**
 * An owner started on an empty store, composed
 * as `tavi serve` composes one with no model — no provider at all (no
 * fabricated `default` connection), the `default`/`default` placeholders and a
 * live target — takes its first model and its first search provider with no
 * restart. A chat turn, a reminder's task, a routine and a Telegram reply all
 * run on the model added; before it, a reminder records that no model is
 * configured and a channel message is refused cleanly; `web_search` reaches
 * the next turn once a provider is added; and the `restartRequired` answers
 * for models and search are false.
 */

const directories = temporaryDirectories({ prefix: "tavi-first-model-" });
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  directories.cleanup();
});

const workspaces = [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }];

/** What `tavi serve` composes with nothing configured (`server/command.ts`): placeholders with no provider behind them, resolved live. */
const UNCONFIGURED = {
  providers: [],
  credentials: {},
  defaultConnectionId: "default",
  defaultModel: "default",
  modelTargetUnconfigured: true,
  liveModelTarget: {},
} as const satisfies Partial<TaviRuntimeOptions>;

const PLACEHOLDER: OwnerModelTarget = { source: "placeholder", connectionId: "default", model: "default", workspaceId: "default" };

/** A first model, as the canvas or `tavi models add` + `set-default` configure it. */
async function addFirstModel(runtime: TaviRuntime): Promise<void> {
  const models = runtime.store.services.modelConfig;
  await models.putConnection({
    connectionId: "first",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1/v1",
    credentialRef: "first.key",
    label: "First",
    defaultModel: "m1",
  });
  await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "first", model: "m1" } });
  await runtime.refreshProviders();
}

/** A SearXNG stub on a free port, answering one result. */
async function searxng(): Promise<{ readonly baseUrl: string; readonly searches: string[] }> {
  const searches: string[] = [];
  const server: Server = createServer((request, response) => {
    searches.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [{ title: "Tavi", url: "https://tavi.example/", content: "an orchestrator" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, searches };
}

describe("the first model and search provider on a running owner", () => {
  it("runs a chat turn on a model added over IPC, offers web_search to the next turn once a provider is added, and never asks for a restart", async () => {
    const directory = directories.create();
    const seen: ModelRequest[] = [];
    const recording: ModelPort = {
      async stream(request) {
        seen.push(request);
        return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      },
    };
    const handle: ServeHandle = await serve(
      { dataDirectory: directory, workspaces, ...UNCONFIGURED, logger: { level: "error", sink: () => {} }, scheduleSweepEnabled: false },
      { dataDirectory: directory, drainDeadlineMs: 5_000, modelTarget: PLACEHOLDER },
      { stdout: () => {}, stderr: () => {}, isTty: false },
      { modelOverride: recording, browserOverride: createFixtureBrowser() },
    );
    cleanups.push(() => handle.shutdown("test cleanup"));
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const client: IpcClient = await createIpcClient(owner);
    cleanups.push(() => client.close());
    const run = (operationKey: string) =>
      requestWithSubscription(
        client,
        "run",
        { workspaceId: "default", principal: "operator", approval: "client", prompt: "say done", operationKey },
        `run-${operationKey}`,
      );

    // No fabricated provider: the owner was launched with none, and nothing runs until a model is added.
    expect(handle.runtime.workflow).toBeDefined();
    expect((await run("before")).response.error?.code).toBe("NOT_CONFIGURED");
    expect(seen).toEqual([]);

    const added = await client.request(
      "models",
      { action: "add", connectionId: "first", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "first.key", model: "m1" },
      "add",
    );
    expect(added.result).toMatchObject({ restartRequired: false, result: { connectionId: "first" } });
    const defaulted = await client.request("models", { action: "set-default", connectionId: "first", model: "m1" }, "default");
    expect(defaulted.result).toMatchObject({ restartRequired: false });

    const first = await run("after");
    expect(first.response.ok, JSON.stringify(first.response.error)).toBe(true);
    await waitFor(() => ended(first.events));
    expect(seen.map((request) => `${request.connectionId}/${request.model}`)).toEqual(["first/m1"]);
    expect(seen[0]?.tools.some((tool) => tool.id === "web_search")).toBe(false);

    // The first search provider: activated on demand and offered to the next turn.
    const stub = await searxng();
    expect(handle.runtime.tools.get("web_search")).toBeUndefined();
    const searchAdded = await client.request(
      "search",
      { action: "add", providerId: "home", kind: "searxng", baseUrl: stub.baseUrl },
      "search-add",
    );
    expect(searchAdded.result).toMatchObject({ restartRequired: false, result: { providerId: "home", enabled: true } });
    const enabled = await client.request("search", { action: "enable", providerId: "home" }, "search-enable");
    expect(enabled.result).toMatchObject({ restartRequired: false });
    const tool = handle.runtime.tools.get("web_search");
    expect(tool).toBeDefined();
    const context = { workspaceId: "default", principalId: "operator", runId: "run-search", caller: "test" };
    const binding = await tool?.resolveBinding?.({ query: "tavi" }, context);
    expect(
      await tool?.handler({
        input: { query: "tavi" },
        context,
        signal: new AbortController().signal,
        ...(binding === undefined ? {} : { expectedBindingHash: binding.bindingHash }),
      }),
    ).toMatchObject({ provider: "home" });
    expect(stub.searches).toHaveLength(1);

    const next = await run("with-search");
    await waitFor(() => ended(next.events));
    expect(seen.at(-1)?.tools.some((offered) => offered.id === "web_search")).toBe(true);
  });

  it("records noModel for a reminder fired before setup, and starts the task of one fired after", async () => {
    const logged: { message?: string }[] = [];
    const runtime = await composeTaviRuntime(
      {
        dataDirectory: directories.create(),
        workspaces,
        ...UNCONFIGURED,
        approvalRequiredFor: ["mutating", "external"],
        logger: { level: "warn", sink: (line: string) => void logged.push(JSON.parse(line) as { message?: string }) },
        reminderSweepEnabled: true,
        reminderSweepIntervalMs: 25,
      },
      { requireModelTransport: false, modelOverride: createFixtureModel({ turns: [{ text: "checked" }] }) },
    );
    cleanups.push(() => runtime.close());
    const repositories = runtime.store.asPort().repositories;
    const remind = async (reminderId: string) => {
      const { reminder } = await repositories.reminders.create({
        reminderId,
        workspaceId: "default",
        principalId: "operator",
        text: "Check the train",
        prompt: "Check the Frankfurt connection",
        when: { kind: "once", at: new Date(Date.now() + 500).toISOString() },
        timezone: "UTC",
        deliverTo: { kind: "app" },
        createdBy: "user",
        operationKey: reminderId,
        now: nowTimestamp(),
      });
      const fires = await until(
        () => repositories.reminders.fires({ workspaceId: "default", reminderId: reminder.reminderId, limit: 5 }),
        (rows) => rows.some((fire) => fire.outcome !== "pending"),
      );
      const fire = fires.find((row) => row.outcome !== "pending");
      if (fire === undefined) throw new Error("no fire settled");
      return fire;
    };

    const before = await remind("rem-before");
    expect(before).toMatchObject({ outcome: "delivered-in-app" });
    expect(before.taskId).toBeUndefined();
    expect(logged.some((line) => line.message === "a reminder's task was not started: no model is configured")).toBe(true);
    expect(REMINDER_NO_MODEL_NOTE).toContain("no model is configured");

    await addFirstModel(runtime);
    const after = await remind("rem-after");
    expect(after.taskId).toBeDefined();
    expect(await repositories.tasks.get(after.taskId ?? "")).toMatchObject({ origin: "reminder", principalId: "operator" });
  });

  it("creates a routine on the model added, wakes a setup-needed evaluation once search is added, and runs the routine on that model and search provider", async () => {
    const scope = { workspaceId: "default", principalId: "operator" };
    const seen: { readonly connectionId: string; readonly model: string; readonly purpose: string }[] = [];
    const modelOverride: ModelPort = {
      async stream(request) {
        seen.push({ connectionId: request.connectionId, model: request.model, purpose: request.purpose ?? "workflow" });
        if (request.purpose === "evaluation")
          return {
            attemptId: request.attemptId,
            status: "completed",
            text: "malformed-stop-after-first-call",
            toolCalls: [],
            usage: { totalTokens: 5 },
          };
        const hasToolResult = request.messages.some((message) => message.role === "tool");
        if (request.tools.some((tool) => tool.id === "web_search")) {
          return hasToolResult
            ? { attemptId: request.attemptId, status: "completed", text: "Tavi release evidence", toolCalls: [], usage: { totalTokens: 5 } }
            : {
                attemptId: request.attemptId,
                status: "completed",
                text: "",
                toolCalls: [{ id: "search", name: "web_search", input: { query: "tavi" } }],
                usage: { totalTokens: 5 },
              };
        }
        return hasToolResult
          ? {
              attemptId: request.attemptId,
              status: "completed",
              text: JSON.stringify({ stories: [] }),
              toolCalls: [],
              usage: { totalTokens: 5 },
            }
          : {
              attemptId: request.attemptId,
              status: "completed",
              text: "",
              toolCalls: [
                {
                  id: "spawn",
                  name: "agents.spawn",
                  input: { agentDefinitionId: "llm-news", input: "Find evidence", operationKey: "research" },
                },
              ],
              usage: { totalTokens: 5 },
            };
      },
    };
    const runtime = await composeTaviRuntime(
      {
        dataDirectory: directories.create(),
        workspaces,
        ...UNCONFIGURED,
        approvalRequiredFor: [],
        logger: { level: "error", sink: () => {} },
        scheduleSweepEnabled: false,
      },
      { requireModelTransport: false, modelOverride },
    );
    cleanups.push(() => runtime.close());
    const setup = (operationKey: string) => ({
      action: "create" as const,
      ...scope,
      operationKey,
      setup: { name: "LLM news", objective: "Find news", agentId: "llm-news", at: "09:00", timezone: "Europe/Sofia" },
    });

    // Before a model: refused, with what to set and no restart.
    await expect(runtime.routineControl.execute(setup("before"))).rejects.toThrow(
      /No model is configured for routines\. Set a default model in Settings → Models \(or `tavi models set-default`\), then create the routine again\./,
    );

    // Model added first, search still missing: creation succeeds on `first/m1`, and evaluation pauses in `setup-needed`.
    await addFirstModel(runtime);
    const waiting = (await runtime.routineControl.execute(setup("waiting-for-search"))) as { routine: { routineId: string } };
    await until(
      () => runtime.routines.get(scope, waiting.routine.routineId),
      (detail) => detail.routine.status === "setup-needed",
    );
    expect(seen).toEqual([]);

    // Adding the search provider and refreshing wakes the pending evaluation on `first/m1` without a restart.
    const stub = await searxng();
    await runtime.store
      .asPort()
      .repositories.searchProviders.add({ providerId: "home", kind: "searxng", baseUrl: stub.baseUrl, enabled: true, now: nowTimestamp() });
    await runtime.refreshProviders();
    expect(runtime.tools.get("web_search")).toBeDefined();
    await until(
      () => runtime.routines.get(scope, waiting.routine.routineId),
      (detail) => detail.evaluation.status === "failed",
    );
    expect(seen).toContainEqual({ connectionId: "first", model: "m1", purpose: "evaluation" });

    const created = (await runtime.routineControl.execute(setup("after"))) as {
      routine: { routineId: string };
      revision: { snapshot: { models: unknown; permissions: { providerBindings?: Record<string, string> } } };
    };
    // Pinned to the live default, not the `default` placeholder, with the binding configured for the connection added since start.
    expect(created.revision.snapshot.models).toMatchObject({
      research: { primary: { connectionId: "first", model: "m1", bindingHash: expect.any(String) } },
      synthesis: { primary: { connectionId: "first", model: "m1" } },
    });
    expect(created.revision.snapshot.permissions.providerBindings).toMatchObject({ web_search: expect.any(String) });
    const readiness = (await runtime.routineControl.execute({ action: "readiness", ...scope, routineId: created.routine.routineId })) as {
      research: { ready: boolean; blockedBy: string | null };
    };
    expect(readiness.research).toMatchObject({ ready: true, blockedBy: null });

    // Wait for background evaluation on `created` to settle, activate revision 1, and run the routine pipeline end-to-end.
    const settled = await until(
      () => runtime.routines.get(scope, created.routine.routineId),
      (detail) => detail.evaluation.status !== "pending" && detail.evaluation.status !== "running",
    );
    await runtime.routineControl.execute({
      action: "reevaluate",
      ...scope,
      routineId: created.routine.routineId,
      expectedVersion: settled.routine.version,
    });
    await runtime.routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
    await runtime.routineControl.execute({ action: "run", ...scope, routineId: created.routine.routineId, operationKey: "run-after" });
    await until(
      () => runtime.routineRuns.history(scope, created.routine.routineId),
      (rows) => rows.some((row) => row.status === "succeeded"),
    );
    expect(seen.filter((call) => call.purpose !== "evaluation").map((call) => `${call.connectionId}/${call.model}`)).toEqual([
      "first/m1",
      "first/m1",
      "first/m1",
      "first/m1",
    ]);
    expect(stub.searches).toHaveLength(1);
  });

  it("refuses a Telegram message cleanly before a model is added, and replies to the next one after", async () => {
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });
    const telegram = telegramStub();
    await saveChannelConnection(directory, {
      connectionId: "telegram-default",
      providerId: "telegram",
      workspaceId: "default",
      accountIdentity: "tavi-bot",
      settings: {},
      credentialRefs: { token: "telegram.botToken" },
    });
    const runtime = await composeTaviRuntime(
      {
        dataDirectory: directory,
        workspaces,
        ...UNCONFIGURED,
        credentials: { "telegram.botToken": { fromFile: tokenFile } },
        logger: { level: "error", sink: () => {} },
        approvalRequiredFor: [],
        scheduleSweepEnabled: false,
        messagingAllowedDestinations: ["8346819670"],
        openSavedChannels: true,
      },
      {
        requireModelTransport: false,
        channelFetch: { telegram: telegram.fetch },
        modelOverride: createFixtureModel({ turns: [{ text: "all projects green" }] }),
      },
    );
    cleanups.push(() => runtime.close());
    const repositories = runtime.store.asPort().repositories;
    await repositories.messagingIdentityBindings.bind({
      connectionId: "telegram-default",
      externalSenderId: "8346819670",
      workspaceId: "default",
      principalId: "operator",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    // Before a model: no task, and the sender hears why.
    telegram.push([textUpdate(500, "status please")]);
    await vi.waitFor(() => expect(telegram.sent.some((text) => text.includes("no model set up yet"))).toBe(true), { timeout: 10_000 });
    expect(await repositories.messagingConversations.get("telegram-default", "8346819670")).toBeUndefined();
    expect(await repositories.tasks.list(10)).toEqual([]);

    await addFirstModel(runtime);
    telegram.push([textUpdate(501, "status please")]);
    const conversation = await until(
      () => repositories.messagingConversations.get("telegram-default", "8346819670"),
      (row) => row !== undefined,
      10_000,
    );
    await vi.waitFor(async () => expect((await repositories.tasks.get(conversation?.taskId ?? ""))?.finalText).toBe("all projects green"), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(telegram.sent).toContain("all projects green"), { timeout: 10_000 });
  });
});

function textUpdate(updateId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: { message_id: updateId, date: 1_700_000_000, text, chat: { id: 8346819670, type: "private" }, from: { id: 8346819670 } },
  };
}

/** A fake Bot API: `getUpdates` answers each pushed batch once, and long-polls until shutdown between them; `sendMessage`'s texts are kept. */
function telegramStub(): { readonly fetch: typeof fetch; readonly sent: string[]; readonly push: (batch: readonly unknown[]) => void } {
  const batches: (readonly unknown[])[] = [];
  const sent: string[] = [];
  let wake = (): void => {};
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = fakeFetch(async (url, init) => {
    if (url.includes("/getMe")) return json({ ok: true, result: { id: 1, username: "tavi_bot" } });
    if (url.includes("/sendMessage")) {
      sent.push(String((JSON.parse(String(init?.body)) as { text?: unknown }).text));
      return json({ ok: true, result: { message_id: 900 + sent.length, date: 0, chat: { id: 8346819670 } } });
    }
    if (url.includes("/getUpdates")) {
      while (batches.length === 0) {
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return json({ ok: true, result: batches.shift() });
    }
    return json({ ok: true, result: true });
  });
  return {
    fetch: fetchImpl,
    sent,
    push: (batch) => {
      batches.push(batch);
      wake();
    },
  };
}
