import type { AgentWaitOutcome, BrowserLiveControlChange, BrowserPort } from "@tavi/contracts";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createBrowserLiveSource, type BrowserLiveSource } from "@tavi/plugin-browser/live";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { createIpcClient, readDiscovery, readToken, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBrowserHandoffs, remoteHandoffText, type BrowserHandoffDependencies } from "../../src/features/browser/handoff.js";
import type { CliIo } from "../../src/cli/io.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `browser.request_handoff` end to end: a real owner whose model asks for a person, a watcher that takes
 * the page and hands it back, and the task going on with how it went.
 */

const io: CliIo = { stdout: () => undefined, stderr: () => undefined, isTty: false };
const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const handle of handles.splice(0)) await handle.shutdown("test");
  directories.cleanup();
});

async function ownerAskingForAPerson() {
  const directory = directories.create("tavi-handoff-");
  const live = createBrowserLiveSource();
  const browser = createFixtureBrowser({ live, liveFrameMs: 10 });
  const model = createFixtureModel({
    turns: [
      { toolCall: { id: "call-open", name: "browser.create_session", input: {} } },
      {
        toolCall: {
          id: "call-hand",
          name: "browser.request_handoff",
          input: { sessionId: "browser-session-1", reason: "sign-in", instructions: "Sign in to shop.example, then hand back" },
        },
      },
      { text: "Thanks — I can see the account page now." },
    ],
  });
  const handle = await serve(
    fixtureServeOptions(directory),
    {
      dataDirectory: directory,
      drainDeadlineMs: 5_000,
      modelTarget: { source: "default", connectionId: "fixture", model: "fixture-model", workspaceId: "default" },
    },
    io,
    { modelOverride: model, browserOverride: browser, liveOverride: live },
  );
  handles.push(handle);
  const discovery = readDiscovery(directory);
  const token = readToken(directory);
  if (discovery === undefined || token === undefined) throw new Error("no owner");
  const client = await createIpcClient({ endpoint: discovery.endpoint, sessionId: discovery.sessionId, token });
  clients.push(client);
  return { handle, client, model, live };
}

describe("browser.request_handoff on a live owner", () => {
  it("suspends the task on the handoff, lets a watcher take the page and hand it back, and resumes with the outcome and the page", async () => {
    const { handle, client, model } = await ownerAskingForAPerson();
    const run = await client.request(
      "run",
      { prompt: "buy the thing", workspaceId: "default", principal: "operator", operationKey: "handoff-1", approval: "approve" },
      "run-1",
    );
    expect(run.ok, JSON.stringify(run.error)).toBe(true);
    const taskId = (run.result as { taskId: string }).taskId;
    const tasks = handle.runtime.store.asPort().repositories;
    // The session's page tainted the turn: the instructions name a site the chat has not seen as a URL, so it is defanged as a reply's would be.
    await vi.waitFor(
      async () =>
        expect((await tasks.agentWaits.getActiveByTask(taskId))?.handoff).toEqual({
          sessionId: "fixture-live-1",
          reason: "sign-in",
          instructions: "Sign in to shop[.]example, then hand back",
        }),
      { timeout: 10_000 },
    );
    // The tool was offered, with the guidance to ask in chat for what is not secret.
    expect(JSON.stringify(model.calls.flatMap((call) => call.tools).find((tool) => tool.id === "browser.request_handoff"))).toContain(
      "operator.ask_user",
    );

    const watched = await client.request("browser-live", { action: "watch", workspaceId: "default", taskId }, "watch-1");
    const subscriptionId = (watched.result as { subscriptionId: string }).subscriptionId;
    expect((watched.result as { sessions: { control?: string }[] }).sessions[0]?.control).toBe("requested");
    expect(
      (await client.request("browser-live", { action: "take", subscriptionId, sessionId: "fixture-live-1", maxWidth: 1280 }, "take-1")).ok,
    ).toBe(true);
    expect(
      (
        await client.request(
          "browser-live",
          { action: "release", subscriptionId, sessionId: "fixture-live-1", outcome: "done", note: "Signed in as the guest" },
          "release-1",
        )
      ).ok,
    ).toBe(true);

    await vi.waitFor(async () => expect((await tasks.tasks.get(taskId))?.status).toBe("completed"), { timeout: 10_000 });
    const handedBack = model.calls
      .at(-1)
      ?.messages.filter((message) => message.role === "tool")
      .at(-1);
    expect(JSON.stringify(handedBack?.toolResults)).toMatch(/"outcome":"done".*"note":"Signed in as the guest"/);
    expect(JSON.stringify(handedBack?.toolResults)).toContain('"url":"about:blank"');
  }, 30_000);
});

describe("the owner's handoffs", () => {
  function fakes() {
    const waits = new Map<
      string,
      {
        waitId: string;
        taskId: string;
        state: string;
        handoff?: { sessionId: string; reason: "sign-in" };
        outcome?: AgentWaitOutcome;
        by?: string;
      }
    >();
    const listeners = new Set<(change: BrowserLiveControlChange) => void>();
    const told: string[] = [];
    const requested: string[] = [];
    const recorded: BrowserLiveControlChange[] = [];
    const woken: string[] = [];
    const deps = {
      browser: {
        handoffTarget: (sessionId: string, options?: { wake?: boolean }) => {
          if (options?.wake === true) woken.push(sessionId);
          return sessionId === "browser-session-1"
            ? { historyId: "h1", taskId: "chat" }
            : sessionId === "browser-session-9"
              ? { historyId: "h9", taskId: "elsewhere" }
              : undefined;
        },
        observe: async () => ({}),
      } as unknown as BrowserPort,
      live: {
        onControl: (listener: (change: BrowserLiveControlChange) => void) => (listeners.add(listener), () => listeners.delete(listener)),
        controlState: (historyId: string) => (requested.includes(historyId) ? "requested" : "agent"),
        requestHandoff: (historyId: string) => void requested.push(historyId),
        endControl: () => undefined,
        sessions: () => [{ sessionId: "h1", taskId: "chat", state: "open", url: "https://shop.example/login" }],
      } as unknown as BrowserLiveSource,
      repositories: {
        agentWaits: {
          getActiveByTask: async (taskId: string) => [...waits.values()].find((wait) => wait.taskId === taskId && wait.state === "active"),
          settle: async ({ waitId, outcome, by }: { waitId: string; outcome: AgentWaitOutcome; by: string }) => {
            const wait = waits.get(waitId);
            if (wait === undefined || wait.state !== "active") return false;
            waits.set(waitId, { ...wait, state: "settled", outcome, by });
            return true;
          },
          listActiveHandoffs: async () => [...waits.values()].filter((wait) => wait.state === "active" && wait.handoff !== undefined),
          listActiveConnects: async () => [],
          get: async (waitId: string) => waits.get(waitId),
          markResumed: async () => undefined,
        },
        tasks: {
          get: async (taskId: string) => ({
            taskId,
            workspaceId: "w",
            principalId: "operator",
            status: "waiting",
            origin: taskId === "chat" ? "telegram" : "web",
          }),
          getAdmission: async () => undefined,
        },
        agentDelegations: { getByWorkerTaskId: async () => undefined },
      } as unknown as BrowserHandoffDependencies["repositories"],
      workflow: () => undefined,
      taskTree: async (_workspaceId: string, taskId: string) => [taskId, `${taskId}-worker`],
      tellChat: async (_taskId: string, text: string) => (told.push(text), true),
      recordControl: (change: BrowserLiveControlChange) => void recorded.push(change),
      log: () => undefined,
    } satisfies BrowserHandoffDependencies;
    return {
      deps,
      waits,
      listeners,
      told,
      requested,
      recorded,
      woken,
      emit: (change: BrowserLiveControlChange) => listeners.forEach((listener) => listener(change)),
    };
  }

  it("finds the task's session, refuses another's, and tells a chat where to go", async () => {
    const { deps, told, requested, woken } = fakes();
    const { port } = createBrowserHandoffs(deps);
    // Asking who holds a session (every browser call does, whichever chat) wakes none kept from a last turn.
    expect(port.controlState({ taskId: "chat", sessionId: "browser-session-9" })).toBe("agent");
    expect(woken).toEqual([]);
    expect(await port.target({ taskId: "chat", sessionId: "browser-session-1" })).toEqual({ historyId: "h1" });
    expect(await port.target({ taskId: "chat", sessionId: "browser-session-9" })).toMatchObject({
      refusal: expect.stringContaining("not this task's"),
    });
    // Only the task's own session is woken for a person to take; another's is left as it was.
    expect(woken).toEqual(["browser-session-1"]);
    expect(await port.target({ taskId: "chat", sessionId: "browser-session-404" })).toMatchObject({
      refusal: expect.stringContaining("No open browser session"),
    });
    await port.request({
      taskId: "chat",
      historyId: "h1",
      handoff: { sessionId: "h1", reason: "sign-in", instructions: "Sign in, then hand back" },
      waitId: "w1",
    });
    expect(requested).toEqual(["h1"]);
    expect(told).toEqual([
      "Tavi needs you in shop.example. Open Tavi on your computer (tavi ui) to take over the browser: Sign in, then hand back",
    ]);
    expect(port.controlState({ taskId: "chat", sessionId: "browser-session-1" })).toBe("requested");
    expect(remoteHandoffText(undefined, undefined)).toBe(
      "Tavi needs you in the browser. Open Tavi on your computer (tavi ui) to take over the browser",
    );
  });

  it("records the page handed back as any observation, so the next card names its elements and its title now", async () => {
    const { deps } = fakes();
    const page = { sessionId: "browser-session-1", url: "https://shop.example/bills", title: "Your bills", elements: [] };
    const noted: [unknown, string][] = [];
    const { port } = createBrowserHandoffs({
      ...deps,
      browser: { ...deps.browser, observe: async () => page } as unknown as BrowserPort,
      noteObservation: async (observation, sessionId) => (noted.push([observation, sessionId]), observation),
    });
    expect(await port.observe("browser-session-1")).toBe(page);
    expect(noted).toEqual([[page, "browser-session-1"]]);
  });

  it("settles the task's handoff when the person hands back or the session ends, and cancels those a restart orphaned", async () => {
    const { deps, waits, emit, recorded, requested } = fakes();
    waits.set("w-orphan", { waitId: "w-orphan", taskId: "old", state: "active", handoff: { sessionId: "h-old", reason: "sign-in" } });
    const handoffs = createBrowserHandoffs(deps);
    const stop = handoffs.start();
    await vi.waitFor(() =>
      expect(waits.get("w-orphan")?.outcome).toMatchObject({ kind: "cancelled", error: { code: "HANDOFF_CANCELLED" } }),
    );
    // Handoffs of this owner's life, asked for since it started.
    waits.set("w1", { waitId: "w1", taskId: "chat", state: "active", handoff: { sessionId: "h1", reason: "sign-in" } });
    waits.set("w2", { waitId: "w2", taskId: "other", state: "active", handoff: { sessionId: "h2", reason: "sign-in" } });
    // Another session's change settles nothing: a person's own hold no wait was on goes to the transcript alone.
    emit({ sessionId: "h-other", taskId: "chat", state: "agent", outcome: "done", controlledMs: 1 });
    // An agent's request ended unheld (declined at once) is not a hold.
    emit({ sessionId: "h-idle", taskId: "chat", state: "agent", outcome: "cancelled", controlledMs: 0 });
    await vi.waitFor(() =>
      expect(recorded).toEqual([{ sessionId: "h-other", taskId: "chat", state: "agent", outcome: "done", controlledMs: 1 }]),
    );
    // A wait's own end (its deadline came, its wait already settled) hands the page back: no second row for it.
    requested.push("h-deadline");
    const { port } = handoffs;
    port.end({ historyId: "h-deadline", outcome: "timeout" });
    emit({ sessionId: "h-deadline", taskId: "chat", state: "agent", outcome: "timeout", controlledMs: 30_000 });
    await delay(10);
    expect(recorded.map((change) => change.sessionId)).toEqual(["h-other"]);
    emit({ sessionId: "h1", taskId: "chat", state: "operator" });
    await delay(10);
    expect(waits.get("w1")?.state).toBe("active");
    emit({ sessionId: "h1", taskId: "chat", state: "agent", outcome: "done", note: "Signed in", controlledMs: 1234.4, by: "operator:ui" });
    await vi.waitFor(() =>
      expect(waits.get("w1")?.outcome).toEqual({
        kind: "answered",
        handoff: { outcome: "done", controlledMs: 1234 },
        replyText: "Signed in",
      }),
    );
    // Recorded as the front end the person used.
    expect(waits.get("w1")?.by).toBe("operator:ui");
    // A person-side timeout (no answer to "Still working?") settles it at once, not at the wait's deadline;
    // the sweep's own timeout finds its wait already settled.
    waits.set("w4", { waitId: "w4", taskId: "chat", state: "active", handoff: { sessionId: "h4", reason: "sign-in" } });
    emit({ sessionId: "h4", taskId: "chat", state: "agent", outcome: "timeout", controlledMs: 720_000 });
    await vi.waitFor(() => expect(waits.get("w4")?.outcome).toEqual({ kind: "wait-timeout" }));
    expect(waits.get("w4")?.by).toBe("policy");
    emit({ sessionId: "h2", taskId: "other", state: "agent", outcome: "cancelled", controlledMs: 0 });
    await vi.waitFor(() => expect(waits.get("w2")?.outcome).toMatchObject({ kind: "cancelled" }));
    // A session a worker opened, handed over by the task that asked: found by its session.
    waits.set("w3", { waitId: "w3", taskId: "chat", state: "active", handoff: { sessionId: "h-worker", reason: "sign-in" } });
    emit({ sessionId: "h-worker", taskId: "chat-worker", state: "agent", outcome: "failed", controlledMs: 10 });
    await vi.waitFor(() =>
      expect(waits.get("w3")?.outcome).toEqual({ kind: "answered", handoff: { outcome: "failed", controlledMs: 10 } }),
    );
    stop();
  });

  it("withdraws the handoffs a task and its workers wait on, and no other's (Stop for a Home)", async () => {
    const { deps, waits } = fakes();
    waits.set("w-home", { waitId: "w-home", taskId: "home", state: "active", handoff: { sessionId: "h1", reason: "sign-in" } });
    waits.set("w-worker", { waitId: "w-worker", taskId: "home-worker", state: "active", handoff: { sessionId: "h2", reason: "sign-in" } });
    waits.set("w-other", { waitId: "w-other", taskId: "other", state: "active", handoff: { sessionId: "h3", reason: "sign-in" } });
    const handoffs = createBrowserHandoffs(deps);
    expect(await handoffs.withdraw("home", "operator:ui")).toBe(2);
    expect(waits.get("w-home")).toMatchObject({
      state: "settled",
      by: "operator:ui",
      outcome: { kind: "cancelled", error: { code: "HANDOFF_STOPPED" } },
    });
    expect(waits.get("w-worker")?.state).toBe("settled");
    expect(waits.get("w-other")?.state).toBe("active");
    expect(await handoffs.withdraw("home", "operator:ui")).toBe(0);
  });
});
