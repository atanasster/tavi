import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { cpSync } from "node:fs";
import { join } from "node:path";

import {
  BUILTIN_MEMORY_PROVIDER_ID,
  defaultHeartbeatConfig,
  type ChannelsListAnswer,
  type ChannelsPayload,
  type ChannelsSaveAnswer,
  type ChannelsShareClientAnswer,
  type HeartbeatSignal,
  type InvocationContext,
  type ModEnvelope,
  type ModHookInput,
  type ModelRequest,
  type OnboardingFlow,
  TaviError,
} from "@tavi/contracts";
import { GUARD_PLUGIN_ID } from "@tavi/plugin-guard/manifest";
import { nowTimestamp } from "@tavi/contracts/util";
import { fakeFetch, temporaryDirectories, until, delay } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";

import { channelsCommand } from "../../src/features/channels/owner.js";
import {
  CHANNELS_SHARED_CLIENTS_SETTING,
  channelDescriptorOf,
  isBuiltinChannel,
  parseSharedClients,
  setSharedClientBindings,
} from "../../src/features/channels/catalog.js";
import { oauthClientOf, sharedProviderOf } from "../../src/features/channels/oauth.js";
import { createLocalCredentialStore, encryptCredentialDirectory } from "../../src/features/credentials/store.js";
import { heartbeatCommand } from "../../src/features/heartbeat/owner.js";
import { ideasCommand, ideasProviderViews } from "../../src/features/ideas/owner.js";
import { memoryProviderCommand } from "../../src/features/memory/provider-owner.js";
import { captureProviderOf } from "../../src/features/memory/providers.js";
import { onboardingCommand } from "../../src/features/onboard/owner.js";
import { validatePlugin } from "../../src/features/plugins/validate.js";
import { ownerOnboardingDependencies } from "../../src/features/onboard/owner-dependencies.js";
import {
  routerCommand,
  routerProviderCandidate,
  routerProviderPricing,
  routerProviderState,
  runningProviderReadiness,
} from "../../src/features/router/owner.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { appsOwnerCommand } from "../../src/server/config-commands.js";
import type { TaviRuntime, TaviRuntimeOptions, TaviRuntimeOverrides } from "../../src/runtime/types.js";
import { ROUTED, compose as composeRouted, run, scope, seed } from "../router/router-fixtures.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";
import { directSandbox as direct } from "../support/direct-sandbox.js";

/**
 * Tier 4's reference replacements (examples/plugins/acme-*): each built-in a
 * plugin may stand in for is disabled, the matching example is installed,
 * approved in-process and enabled as any plugin is, and the owner serves it
 * through the path the built-in used — the channel registry and ingress, the
 * memory, ideas, onboarding and heartbeat provider registries and their
 * per-workspace selection, and the router's provider slot.
 */

const EXAMPLES = join(import.meta.dirname, "..", "..", "..", "..", "examples", "plugins");
const VERSION = "0.1.0";
const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  while (runtimes.length > 0) await runtimes.pop()?.close();
  dirs.cleanup();
});

async function compose(
  dataDirectory: string,
  overrides: Partial<TaviRuntimeOptions> = {},
  testing: TaviRuntimeOverrides = {},
): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory, { scheduleSweepEnabled: false, ...overrides }), {
    requireModelTransport: false,
    ...testing,
  });
  runtimes.push(runtime);
  return runtime;
}

/** In a throwaway owner on `dataDirectory`: disable `builtin`, then install, approve (in-process) and enable the example. */
async function replace(dataDirectory: string, builtin: string, example: string, id: string): Promise<void> {
  const source = dirs.create("tavi-replacement-src-");
  cpSync(join(EXAMPLES, example), source, { recursive: true });
  const setup = await compose(dataDirectory);
  await setup.plugins.registry.disable(builtin, "operator");
  await setup.plugins.registry.install(source, "operator");
  await setup.plugins.registry.decide(id, VERSION, "approved", "operator", { inProcess: true });
  await setup.plugins.registry.configure(id, {}, [], "operator");
  await setup.plugins.registry.enable(id, "operator");
  runtimes.splice(runtimes.indexOf(setup), 1);
  await setup.close();
}

describe("the reference replacements", () => {
  it.each([
    ["acme-telegram-webhook", "acme.telegramhook"],
    ["acme-memory-keywords", "acme.memorykeywords"],
    ["acme-ideas", "acme.ideas"],
    ["acme-onboarding", "acme.onboarding"],
    ["acme-heartbeat-rules", "acme.heartbeatrules"],
    ["acme-router", "acme.router"],
  ])("%s validates with no problems", async (example, pluginId) => {
    const report = await validatePlugin(join(EXAMPLES, example), { sandbox: direct, platform: "darwin" });
    expect(report).toMatchObject({ pluginId, version: VERSION, problems: [] });
  });
});

describe("a channel: acme-telegram-webhook in place of tavi.telegram", () => {
  it("takes the telegram provider id, saves and opens a connection, and answers a verified webhook update with sendMessage", async () => {
    const dataDirectory = dirs.create("tavi-replace-telegram-");
    await replace(dataDirectory, "tavi.telegram", "acme-telegram-webhook", "acme.telegramhook");
    const sent: { url: string; chatId: unknown; text: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      fakeFetch(async (url, init) => {
        // The token is checked as the connection opens and when it is probed.
        if (url.endsWith("/getMe")) return new Response(JSON.stringify({ ok: true, result: { username: "acme_tavi_bot" } }));
        const body = JSON.parse(String(init?.body)) as { chat_id: unknown; text: unknown };
        sent.push({ url, chatId: body.chat_id, text: body.text });
        return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
      }),
    );
    const captured: { listener?: (req: IncomingMessage, res: ServerResponse) => void } = {};
    const model = createFixtureModel({
      turns: [{ toolCalls: [{ id: "reply", name: "messaging.send", input: { content: "pong" } }] }, { text: "replied" }],
    });
    const runtime = await compose(
      dataDirectory,
      { approvalRequiredFor: [], openSavedChannels: true },
      {
        modelOverride: model,
        ingressCreateServerOverride: (listener) => {
          captured.listener = listener;
          return fakeServer();
        },
      },
    );
    // The plugin holds the id the disabled built-in freed, never as built-in.
    expect(channelDescriptorOf("telegram")?.label).toBe("Telegram (webhooks)");
    expect(isBuiltinChannel("telegram")).toBe(false);

    const channels = async <T>(payload: ChannelsPayload): Promise<T> =>
      (
        await channelsCommand(
          {
            dataDirectory,
            repositories: runtime.store.asPort().repositories,
            channels: runtime.channels,
            messaging: runtime.messaging,
            reload: (workspaceId) => runtime.reloadChannels(workspaceId),
            applyIngress: () => runtime.applyIngress(),
            pairings: runtime.pairings,
            oauth: runtime.oauthFlows,
            revokeToken: (connection) => runtime.oauthBroker.revoke(connection),
            now: () => runtime.clock.now(),
          },
          payload,
        )
      ).result as T;
    const saved = await channels<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "telegram",
      enabled: true,
      settings: { botUsername: "acme_tavi_bot", apiBaseUrl: "https://bot.test" },
      secrets: { token: "123:bot-token", webhookSecret: "hook-s3cret" },
    });
    expect(saved).not.toHaveProperty("notApplied");
    expect((await channels<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections[0]).toMatchObject({
      connectionId: saved.connectionId,
      providerId: "telegram",
      accountIdentity: "acme_tavi_bot",
      status: { state: "running" },
    });

    const listener = captured.listener;
    if (listener === undefined) throw new Error("the ingress did not listen");
    const path = `/hooks/${saved.connectionId}/webhook`;
    const update = (id: number, text: string) =>
      JSON.stringify({
        update_id: id,
        message: { message_id: id, date: 1, chat: { id: 4242, type: "private" }, from: { id: 4242 }, text },
      });
    const secret = { "content-type": "application/json", "x-telegram-bot-api-secret-token": "hook-s3cret" };
    expect((await deliver(listener, path, update(1, "forged"), { ...secret, "x-telegram-bot-api-secret-token": "wrong" })).status).toBe(
      403,
    );
    await channels({ action: "allow", workspaceId: "default", connectionId: saved.connectionId, sender: "4242", principalId: "operator" });
    expect((await deliver(listener, path, update(2, "ping"), secret)).status).toBe(200);
    await vi.waitFor(
      () => expect(sent).toContainEqual({ url: "https://bot.test/bot123:bot-token/sendMessage", chatId: "4242", text: "pong" }),
      {
        timeout: 10_000,
      },
    );
    // Telegram redelivers an update it was not answered for: the same update id is taken once, never answered twice.
    const replies = sent.length;
    expect((await deliver(listener, path, update(2, "ping"), secret)).status).not.toBe(500);
    await delay(300);
    expect(sent).toHaveLength(replies);
  });
});

describe("a memory provider: acme-memory-keywords in place of tavi.memoryprovider", () => {
  it("is selected for the workspace, ranks a turn's recall from the host's candidates, and drafts what a person asked to remember", async () => {
    const dataDirectory = dirs.create("tavi-replace-memory-");
    await replace(dataDirectory, BUILTIN_MEMORY_PROVIDER_ID, "acme-memory-keywords", "acme.memorykeywords");
    const runtime = await compose(dataDirectory);
    expect(runtime.memoryProviders.get(BUILTIN_MEMORY_PROVIDER_ID)).toBeUndefined();
    expect(runtime.memoryProviders.get("acme.memorykeywords")).toBeDefined();

    const command = (payload: Parameters<typeof memoryProviderCommand>[2]) =>
      memoryProviderCommand(
        {
          settings: runtime.store.asPort().repositories.workspaceSettings,
          providers: runtime.memoryProviders,
          sync: runtime.memoryProviderSync,
          actor: "operator:cli",
          now: () => nowTimestamp(),
        },
        "default",
        payload,
      );
    expect(await command({ action: "set-provider", providerId: "acme.memorykeywords", confirmed: true })).toMatchObject({
      selected: "acme.memorykeywords",
      serving: "acme.memorykeywords",
    });
    for (const field of ["records", "conversation"] as const) await command({ action: "egress", field, on: true, confirmed: true });

    const actor = { workspaceId: "default", principalId: "operator", caller: "test", authority: "operator" } as const;
    const scopeOf = { kind: "personal_workspace", principalId: "operator", workspaceId: "default" } as const;
    const garden = await runtime.memory.remember({ actor, scope: scopeOf, kind: "fact", body: "The garden grows tomatoes in summer" });
    const gym = await runtime.memory.remember({ actor, scope: scopeOf, kind: "fact", body: "Gym at 7 on weekdays" });
    const recall = async (query: string) =>
      (
        await runtime.memory.search({
          actor: { ...actor, runId: "chat-1", caller: "workflow", authority: "model" },
          query,
          match: "any",
          purpose: "turn",
        })
      ).hits.map((hit) => hit.recordId);
    expect(await recall("garden tomatoes")).toEqual([garden.recordId]);
    // The plugin ranks by words of three letters or more, so "at 7" finds nothing through it; the host's own search finds it.
    expect(await recall("at 7")).toEqual([]);
    await command({ action: "set-provider", providerId: "builtin", confirmed: true });
    expect(await recall("at 7")).toEqual([gym.recordId]);
    // Chosen again, its egress starts off again: capture needs `conversation`.
    await command({ action: "set-provider", providerId: "acme.memorykeywords", confirmed: true });
    await command({ action: "egress", field: "conversation", on: true, confirmed: true });

    // Capture, as the idle review and the epoch flush ask it: the workspace's provider is the plugin.
    const capture = await captureProviderOf(runtime.memoryProviders, "default");
    expect(capture?.id).toBe("acme.memorykeywords");
    const drafted = await capture?.provider.capture?.({
      span: [{ role: "person", text: "Remember that the dentist is on Tuesdays" }],
      today: "2026-10-25",
      known: [],
      limits: { maxProposals: 3, bodyChars: 400 },
      policy: { sensitive: "skip" },
      host: {} as never,
      signal: new AbortController().signal,
    } as never);
    expect(drafted?.proposals).toEqual([expect.objectContaining({ kind: "fact", body: "the dentist is on Tuesdays", from: "person" })]);
  });
});

describe("an ideas provider: acme-ideas in place of tavi.ideasagent", () => {
  it("is chosen with tavi ideas provider, and a refresh stores its ideas, checked against the census", async () => {
    const dataDirectory = dirs.create("tavi-replace-ideas-");
    await replace(dataDirectory, "tavi.ideasagent", "acme-ideas", "acme.ideas");
    const runtime = await compose(dataDirectory);
    expect(runtime.ideas.providers.get("tavi.ideasagent")).toBeUndefined();
    const repositories = runtime.store.asPort().repositories;
    const ideas = (payload: Parameters<typeof ideasCommand>[1]) =>
      ideasCommand(
        {
          repositories,
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          now: () => new Date(runtime.clock.now()),
          census: runtime.ideas.census,
          providers: () => ideasProviderViews(runtime.ideas.providers.list()),
          refresh: async (workspaceId) => await runtime.ideas.host.refresh(workspaceId),
          nextRunAt: async (workspaceId) => await runtime.ideas.host.nextAt(workspaceId),
        },
        payload,
      );
    expect(await ideas({ action: "set-settings", workspaceId: "default", changes: { provider: "acme.ideas" } })).toMatchObject({
      ok: true,
    });
    expect(await ideas({ action: "refresh", workspaceId: "default" })).toMatchObject({ ok: true });
    await runtime.ideas.host.idle();

    const listed = await ideas({ action: "list", workspaceId: "default" });
    if (!listed.ok) throw new Error(listed.error.message);
    const result = listed.result as {
      ideas: { key: string; templateId?: string }[];
      lastRun?: { providerId?: string; outcome: string };
      provider: string;
      providers: { id: string; kind: string }[];
    };
    expect(result.provider).toBe("acme.ideas");
    expect(result.providers).toEqual([expect.objectContaining({ id: "acme.ideas", kind: "plugin" })]);
    expect(result.lastRun).toMatchObject({ providerId: "acme.ideas", outcome: "generated" });
    // Only the catalogue entries whose capability this owner has, each the plugin's own.
    const census = new Set(await runtime.ideas.census("default"));
    const expected = [
      ["productivity.acme-weekly-review", "memory"],
      ["productivity.acme-standup-reminder", "reminders"],
      ["work.acme-industry-news", "web"],
    ].filter(([, needs]) => census.has(needs as never));
    expect(expected.length).toBeGreaterThan(0);
    expect(result.ideas.map((idea) => idea.key).sort()).toEqual(expected.map(([key]) => key).sort());
  });
});

describe("an onboarding flow: acme-onboarding in place of tavi.onboarding", () => {
  it("is chosen with tavi onboard provider, and setup walks its steps in its words, repaired by the host", async () => {
    const dataDirectory = dirs.create("tavi-replace-onboarding-");
    await replace(dataDirectory, "tavi.onboarding", "acme-onboarding", "acme.onboarding");
    const runtime = await compose(dataDirectory);
    expect(runtime.onboarding.providers.get("tavi.onboarding")).toBeUndefined();
    const deps = ownerOnboardingDependencies(runtime);
    const call = async (payload: Parameters<typeof onboardingCommand>[1]) => {
      const answer = await onboardingCommand(deps, payload);
      if (!answer.ok) throw new Error(answer.error.message);
      return answer.result as Record<string, unknown>;
    };
    expect(await call({ action: "provider", id: "acme.onboarding" })).toMatchObject({ providerId: "acme.onboarding" });
    for (const surface of ["web", "cli"] as const) {
      const answer = await call({ action: "flow", surface });
      expect(answer).toMatchObject({ providerId: "acme.onboarding" });
      expect(answer["fallback"]).toBeUndefined();
      const flow = answer["flow"] as OnboardingFlow;
      expect(flow.title).toBe("Welcome to Tavi at ACME");
      // One checklist on every surface: the canvas lists the terminal's service step too, as done there.
      expect(flow.steps.map((step) => step.id)).toEqual(["model", "slack", "about", "service", "ideas"]);
      // No Slack channel is installed here, so none is featured, and Telegram is never offered.
      expect(flow.steps.find((step) => step.id === "slack")?.featured ?? []).toEqual([]);
      expect(JSON.stringify(flow)).not.toContain("telegram");
    }
  });
});

describe("a heartbeat provider: acme-heartbeat-rules in place of tavi.heartbeatagent", () => {
  it("answers the heartbeat's checks with no model, telling a new signal that matches an instruction line", async () => {
    const dataDirectory = dirs.create("tavi-replace-heartbeat-");
    await replace(dataDirectory, "tavi.heartbeatagent", "acme-heartbeat-rules", "acme.heartbeatrules");
    const requests: ModelRequest[] = [];
    const fixture = createFixtureModel({ turns: [{ text: "done" }] });
    const runtime = await compose(
      dataDirectory,
      { heartbeatEnabled: true, scheduleSweepEnabled: true },
      {
        modelOverride: {
          ...fixture,
          stream: async (request, options) => {
            requests.push(request);
            return await fixture.stream(request, options);
          },
        },
        heartbeatTiming: { sweepMs: 20, intervalFloorMs: 1_000 },
      },
    );
    expect(runtime.heartbeat.providers.ids()).not.toContain("tavi.heartbeatagent");
    expect(runtime.heartbeat.providers.ids()).toContain("acme.heartbeatrules");
    // Something to watch: a job feed, the first look seeding what is already there.
    const at = "2026-10-11T09:00:00.000Z";
    const jobs: HeartbeatSignal[] = [{ key: "job:report", hash: "h1", title: "Job weekly-report failed", at, source: "Jobs" }];
    runtime.heartbeat.signals.install("test.jobs", { id: "jobs", collect: async () => jobs }, "plugin");

    // Saved off, then chosen and switched on as `tavi heartbeat set-provider` and `egress` do.
    const now = new Date(runtime.clock.now()).toISOString();
    await runtime.store.asPort().repositories.heartbeats.save({
      workspaceId: "default",
      principalId: "operator",
      expectedRevision: 0,
      author: "test",
      now,
      nextTickAt: now,
      config: {
        ...defaultHeartbeatConfig(),
        everyMs: 2_000,
        deepCheckEveryMs: 4_000,
        instructions: "Tell me when the nightly backup fails",
        activeHours: { start: "00:00", end: "23:59" },
        model: { connectionId: "fixture", model: "fixture-model" },
      },
    });
    const heartbeat = async (payload: Parameters<typeof heartbeatCommand>[1]) => {
      const answer = await heartbeatCommand(
        {
          repositories: runtime.store.asPort().repositories,
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          options: runtime.heartbeat.options,
          providers: () => runtime.heartbeat.providers.list(),
          providerStates: runtime.heartbeat.providerStates,
          toolChoices: () => runtime.heartbeat.toolChoices(),
          sources: () => runtime.heartbeat.signals.list().map((source) => ({ id: source.id, kind: source.kind })),
          host: () => runtime.heartbeat.host(),
          author: "ipc",
          now: () => new Date(runtime.clock.now()),
        },
        payload,
      );
      if (!answer.ok) throw new Error(answer.error.message);
    };
    await heartbeat({ action: "set-provider", providerId: "acme.heartbeatrules" });
    for (const field of ["instructions", "signals"] as const) await heartbeat({ action: "egress", field, on: true });
    await heartbeat({ action: "set", changes: { enabled: true } });
    const ticks = async () =>
      await runtime.store.asPort().repositories.heartbeats.listTicks({ workspaceId: "default", principalId: "operator", limit: 50 });
    await until(
      async () => (await ticks()).filter((row) => row.outcome !== "skipped" && row.kind !== "window").length,
      (count) => count > 0,
    );
    jobs.push({ key: "job:backup", hash: "h2", title: "Job nightly-backup failed", at, source: "Jobs" });
    const reported = await until(
      async () => (await ticks()).find((row) => row.outcome === "reported"),
      (row) => row !== undefined,
    );
    expect(reported).toMatchObject({ providerId: "acme.heartbeatrules", itemsNow: 1 });
    await runtime.heartbeat.host()?.idle();
    const told = await runtime.store.asPort().repositories.heartbeats.recentItems({
      workspaceId: "default",
      principalId: "operator",
      since: "2000-01-01T00:00:00.000Z",
      limit: 50,
    });
    expect(told.map((item) => item.title)).toEqual(["Job nightly-backup failed"]);
    expect(requests).toEqual([]);
  });
});

describe("a router: acme-router in place of tavi.router", () => {
  it("is bound with tavi router set-provider, routes a task with no network, and every receipt names it", async () => {
    const dataDirectory = dirs.create("tavi-replace-router-");
    await replace(dataDirectory, "tavi.router", "acme-router", "acme.router");
    const store = await seed(dataDirectory);
    const requests: ModelRequest[] = [];
    const routerFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("Jev must not be called");
    });
    const runtime = await composeRouted(dataDirectory, store, routerFetch, requests);
    runtimes.push(runtime);
    expect(runtime.routerProviders.get("acme.router")).toBeDefined();
    const deps = {
      repository: runtime.routerRepository,
      service: runtime.router,
      accounting: runtime.modelAccounting,
      readSecret: runtime.readSecret,
      now: () => runtime.clock.now(),
      providerState: async (providerId: string) =>
        await routerProviderState(runtime.plugins.registry, providerId, { ...runtime.plugins, providers: runtime.routerProviders }),
      providerCandidate: async (providerId: string) => await routerProviderCandidate(runtime.plugins.registry, providerId),
      providerReadiness: runningProviderReadiness(runtime.routerProviders),
      providerPricing: (providerId: string) => routerProviderPricing(runtime.plugins.registry, providerId, runtime.routerProviders),
    };
    // Its price sheet, installed with the settings: free, as a model-less router is.
    const sheet = {
      revision: "acme-price",
      connectionId: "plugin:acme.router",
      model: "keywords-1",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      currency: "USD" as const,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
    };
    await routerCommand(deps, {
      ...scope,
      action: "configure",
      expectedRevision: 0,
      settings: { ...ROUTED, deadlineMs: 10_000, priceRevision: "acme-price" },
      priceSheets: [sheet],
    });
    await routerCommand(deps, { ...scope, action: "set-provider", providerId: "acme.router", expectedRevision: 1 });
    expect(await routerCommand(deps, { ...scope, action: "status" })).toMatchObject({ provider: { id: "acme.router", state: "running" } });

    const result = await run(runtime, "task");
    expect(result?.outcome.status).toBe("completed");
    // A short task: the router chose the fast model.
    expect(requests[0]?.connectionId).toBe("fast");
    const receipts = await runtime.routerRepository.receipts(scope, result?.taskId ?? "missing");
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.every((receipt) => receipt.providerId === "acme.router")).toBe(true);
    expect(routerFetch).not.toHaveBeenCalled();
  });
});

/** A request as the ingress listener takes it; its body arrives once the handler listens. */
function request(url: string, body: string, headers: Record<string, string>): IncomingMessage {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string>; destroy: () => void };
  Object.assign(req, { method: "POST", url, headers, destroy: () => {} });
  setImmediate(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req as unknown as IncomingMessage;
}

async function deliver(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const state = { status: 200, body: "" };
    const res = {
      setHeader: () => {},
      writeHead: (status: number) => {
        state.status = status;
      },
      set statusCode(value: number) {
        state.status = value;
      },
      get statusCode() {
        return state.status;
      },
      end: (chunk?: string) => {
        state.body = chunk ?? "";
        resolve(state);
      },
    };
    listener(request(url, body, headers), res as unknown as ServerResponse);
  });
}

/** The ingress's server, never listening on a real port. */
function fakeServer(): import("node:http").Server {
  const emitter = new EventEmitter() as EventEmitter & {
    listen: (...args: unknown[]) => unknown;
    close: (callback?: () => void) => unknown;
    address: () => unknown;
  };
  emitter.listen = (...args: unknown[]) => {
    const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    setImmediate(() => {
      callback?.();
      emitter.emit("listening");
    });
    return emitter;
  };
  emitter.close = (callback?: () => void) => {
    setImmediate(() => callback?.());
    return emitter;
  };
  emitter.address = () => ({ address: "127.0.0.1", port: 18_025, family: "IPv4" });
  return emitter as unknown as import("node:http").Server;
}

/** The channels command against a composed owner, as `tavi channels` reaches it. */
function channelsOf(runtime: TaviRuntime, dataDirectory: string) {
  return async <T>(payload: ChannelsPayload, extra: Partial<Parameters<typeof channelsCommand>[0]> = {}): Promise<T> =>
    (
      await channelsCommand(
        {
          dataDirectory,
          repositories: runtime.store.asPort().repositories,
          channels: runtime.channels,
          messaging: runtime.messaging,
          reload: (workspaceId) => runtime.reloadChannels(workspaceId),
          applyIngress: () => runtime.applyIngress(),
          pairings: runtime.pairings,
          oauth: runtime.oauthFlows,
          revokeToken: (connection) => runtime.oauthBroker.revoke(connection),
          now: () => runtime.clock.now(),
          ...extra,
        },
        payload,
      )
    ).result as T;
}

const invocation: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" };
const callTool = (runtime: TaviRuntime, tool: string, input: unknown) => {
  const registered = runtime.tools.get(tool);
  if (registered === undefined) throw new Error(`tool ${tool} is not registered`);
  return registered.handler({ input, context: invocation, signal: new AbortController().signal });
};

describe("the reference replacements added for mail, flights, the brief and sites", () => {
  it.each([
    ["acme-mailgun-lite", "acme.mailgunlite"],
    ["acme-gmail-lite", "acme.gmaillite"],
    ["acme-flights", "acme.flights"],
    ["acme-daily-brief", "acme.dailybrief"],
    ["acme-flight-sites", "acme.flightsites"],
  ])("%s validates with no problems", async (example, pluginId) => {
    const report = await validatePlugin(join(EXAMPLES, example), { sandbox: direct, platform: "darwin" });
    expect(report).toMatchObject({ pluginId, version: VERSION, problems: [] });
  });
});

describe("an email channel: acme-mailgun-lite in place of tavi.mailgun", () => {
  it("takes the mailgun provider id, refuses an unsigned or replayed post, and answers a signed one through the Messages API", async () => {
    const dataDirectory = dirs.create("tavi-replace-mailgun-");
    await replace(dataDirectory, "tavi.mailgun", "acme-mailgun-lite", "acme.mailgunlite");
    const sent: { url: string; authorization: unknown; form: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      fakeFetch(async (url, init) => {
        // The domain check, as the connection opens and when it is probed.
        if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ domain: { name: "mg.acme.test" } }));
        sent.push({
          url,
          authorization: (init?.headers as Record<string, string>)["authorization"],
          form: Object.fromEntries(new URLSearchParams(String(init?.body))),
        });
        return new Response(JSON.stringify({ id: `<sent-${sent.length}@mg.acme.test>`, message: "Queued. Thank you." }));
      }),
    );
    const captured: { listener?: (req: IncomingMessage, res: ServerResponse) => void } = {};
    const model = createFixtureModel({
      turns: [{ toolCalls: [{ id: "reply", name: "messaging.send", input: { content: "pong" } }] }, { text: "replied" }],
    });
    const runtime = await compose(
      dataDirectory,
      { approvalRequiredFor: [], openSavedChannels: true },
      {
        modelOverride: model,
        ingressCreateServerOverride: (listener) => {
          captured.listener = listener;
          return fakeServer();
        },
      },
    );
    expect(channelDescriptorOf("mailgun")?.label).toBe("Email (Mailgun lite)");
    expect(isBuiltinChannel("mailgun")).toBe(false);

    const channels = channelsOf(runtime, dataDirectory);
    const saved = await channels<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "mailgun",
      enabled: true,
      settings: { domain: "mg.acme.test", apiBaseUrl: "https://mailgun.test/v3" },
      secrets: { apiKey: "key-123", webhookSigningKey: "signing-s3cret" },
    });
    expect(saved).not.toHaveProperty("notApplied");
    expect((await channels<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections[0]).toMatchObject({
      connectionId: saved.connectionId,
      providerId: "mailgun",
      accountIdentity: "tavi@mg.acme.test",
      status: { state: "running" },
    });
    await channels({
      action: "allow",
      workspaceId: "default",
      connectionId: saved.connectionId,
      sender: "ana@example.com",
      principalId: "operator",
    });

    const listener = captured.listener;
    if (listener === undefined) throw new Error("the ingress did not listen");
    const path = `/hooks/${saved.connectionId}/inbound`;
    const now = Math.floor(Date.parse(runtime.clock.now()) / 1000);
    const post = (token: string, messageId: string, overrides: Record<string, string> = {}) => {
      const timestamp = overrides["timestamp"] ?? String(now);
      return new URLSearchParams({
        timestamp,
        token,
        signature: createHmac("sha256", "signing-s3cret")
          .update(timestamp + token)
          .digest("hex"),
        sender: "ana@example.com",
        recipient: "tavi@mg.acme.test",
        from: "Ana <ana@example.com>",
        subject: "ping",
        "body-plain": "ping",
        "stripped-text": "ping",
        // Mailgun's verdicts sit above the first Received line its MX writes.
        "message-headers": JSON.stringify([
          ["X-Mailgun-Spf", "Pass"],
          ["X-Mailgun-Dkim-Check-Result", "Pass"],
          ["Received", "by mxa.mailgun.org"],
          ["Message-Id", messageId],
          ["From", "Ana <ana@example.com>"],
        ]),
        ...overrides,
      }).toString();
    };
    const form = { "content-type": "application/x-www-form-urlencoded" };
    // A wrong signature and a stale timestamp are both refused before anything is read.
    expect((await deliver(listener, path, post("t-forged", "<f@example.com>", { signature: "0".repeat(64) }), form)).status).toBe(403);
    expect((await deliver(listener, path, post("t-stale", "<s@example.com>", { timestamp: String(now - 3_600) }), form)).status).toBe(403);
    expect((await deliver(listener, path, post("t-1", "<m1@example.com>"), form)).status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000 });
    expect(sent[0]).toEqual({
      url: "https://mailgun.test/v3/mg.acme.test/messages",
      authorization: `Basic ${Buffer.from("api:key-123").toString("base64")}`,
      form: expect.objectContaining({
        from: "tavi@mg.acme.test",
        to: "ana@example.com",
        subject: "Re: ping",
        text: "pong",
        "h:In-Reply-To": "<m1@example.com>",
      }),
    });
    // The signature covers only timestamp + token: the same token with another message is a replay, never taken.
    expect((await deliver(listener, path, post("t-1", "<m2@example.com>"), form)).status).not.toBe(200);
    await delay(300);
    expect(sent).toHaveLength(1);
  });
});

describe("an OAuth mail channel: acme-gmail-lite in place of tavi.gmail", () => {
  afterEach(() => setSharedClientBindings(new Map()));

  it("takes the gmail provider id and is bound to the client Google's apps share with share-client", async () => {
    const dataDirectory = dirs.create("tavi-replace-gmail-");
    await replace(dataDirectory, "tavi.gmail", "acme-gmail-lite", "acme.gmaillite");
    const runtime = await compose(dataDirectory);
    expect((await runtime.plugins.registry.show("tavi.gmail", runtime.plugins)).enabled).toBe(false);
    const descriptor = channelDescriptorOf("gmail");
    const spec = descriptor?.auth.kind === "oauth2" ? descriptor.auth.oauth : undefined;
    if (descriptor === undefined || spec === undefined) throw new Error("no gmail channel");
    expect(descriptor.label).toBe("Gmail (lite)");
    expect(isBuiltinChannel("gmail")).toBe(false);
    expect(descriptor.app?.provider).toBe("google");
    // Not shared until the operator binds it: a plugin is never handed the shared client on its own word.
    expect(sharedProviderOf("gmail")).toBeUndefined();

    await encryptCredentialDirectory(dataDirectory);
    const store = createLocalCredentialStore(dataDirectory);
    await store.setSecret("oauth-clients.google.id", "shared.apps.googleusercontent.com");
    await store.setSecret("oauth-clients.google.secret", "the-shared-secret");
    const meta = {
      get: (key: string) => runtime.store.getMeta(key),
      set: async (key: string, value: string) => await runtime.store.setMeta(key, value, runtime.clock.now()),
    };
    const channels = channelsOf(runtime, dataDirectory);
    expect(
      await channels<ChannelsShareClientAnswer>({ action: "share-client", provider: "google", pluginId: "acme.gmaillite" }, { meta }),
    ).toEqual({ sharedClient: { provider: "google", pluginId: "acme.gmaillite", signedOut: 0 } });
    expect(sharedProviderOf("gmail")).toBe("google");
    expect(await oauthClientOf(dataDirectory, descriptor, spec)).toMatchObject({ clientId: "shared.apps.googleusercontent.com" });
    // Kept for the next start, bound to the version approved.
    expect(parseSharedClients(await meta.get(CHANNELS_SHARED_CLIENTS_SETTING)).get("google")).toEqual({
      pluginId: "acme.gmaillite",
      version: VERSION,
    });
  });

  it("polls labelled unread mail into events, marks each read once taken, and replies in its thread", async () => {
    const { gmailLiteChannel } = (await import(join(EXAMPLES, "acme-gmail-lite", "index.mjs"))) as {
      gmailLiteChannel: (deps: unknown) => {
        createConnection: (input: unknown) => {
          onInboundEvent: (handler: (event: unknown) => Promise<void>) => void;
          start: () => Promise<void>;
          stop: () => Promise<void>;
          pollOnce: () => Promise<void>;
          send: (message: unknown) => Promise<{ status: string }>;
        };
        destinationFromInbound: (replyTo: unknown) => unknown;
      };
    };
    const calls: { url: string; method: string; body?: string; authorization: unknown }[] = [];
    const encoded = (text: string) => Buffer.from(text).toString("base64url");
    const message = (id: string, from: string, results: string) => ({
      id,
      threadId: `thread-${id}`,
      internalDate: "1761390000000",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "Authentication-Results", value: results },
          { name: "From", value: from },
          { name: "Subject", value: "Plans" },
          { name: "Message-Id", value: `<${id}@mail.example.com>` },
        ],
        parts: [{ mimeType: "text/plain", body: { data: encoded("Lunch on Friday?") } }],
      },
    });
    const fetch = async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({
        url,
        method,
        ...(init.body === undefined ? {} : { body: String(init.body) }),
        authorization: (init.headers as Record<string, string>)["authorization"],
      });
      const json = (body: unknown) => new Response(JSON.stringify(body));
      if (url.endsWith("/profile")) return json({ emailAddress: "me@gmail.com" });
      if (url.includes("/messages?q=")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
      if (url.endsWith("/messages/m1?format=full"))
        return json(
          message("m1", "Ana <ana@example.com>", "mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=ana@example.com"),
        );
      // A display name that looks like an address is not the sender, and a pass for another domain is no pass.
      if (url.endsWith("/messages/m2?format=full"))
        return json(message("m2", '"boss@example.com" <mallory@evil.test>', "mx.google.com; dkim=pass header.i=@example.com"));
      if (url.endsWith("/messages/send")) return json({ id: "sent-1", threadId: "thread-m1" });
      return json({});
    };
    const channel = gmailLiteChannel({ z, TaviError, fetch, now: () => "2026-10-25T10:00:00.000Z" });
    const connection = channel.createConnection({
      connection: { connectionId: "gmail-1", accountIdentity: "me@gmail.com" },
      config: { label: "tavi" },
      credentials: { accessToken: async () => "access-token-1" },
    });
    const events: Record<string, unknown>[] = [];
    connection.onInboundEvent(async (event) => void events.push(event as Record<string, unknown>));
    await connection.start();
    await connection.stop(); // no timed poll in a test: one is run by hand
    await connection.start();
    await connection.pollOnce();
    await connection.stop();
    expect(events).toEqual([
      expect.objectContaining({
        providerEventId: "gmail:m1",
        externalSenderId: "ana@example.com",
        externalConversationId: "gmail-thread:thread-m1",
        conversationKind: "thread",
        content: "Lunch on Friday?",
        subject: "Plans",
        senderAuthentication: "pass",
      }),
      expect.objectContaining({ providerEventId: "gmail:m2", externalSenderId: "mallory@evil.test", senderAuthentication: "fail" }),
    ]);
    expect(calls.filter((call) => call.url.endsWith("/modify")).map((call) => [call.url.split("/").at(-2), call.body])).toEqual([
      ["m1", JSON.stringify({ removeLabelIds: ["UNREAD"] })],
      ["m2", JSON.stringify({ removeLabelIds: ["UNREAD"] })],
    ]);
    expect(decodeURIComponent(calls.find((call) => call.url.includes("/messages?q="))?.url ?? "")).toContain('label:"tavi" is:unread');
    expect(calls.every((call) => call.authorization === "Bearer access-token-1")).toBe(true);

    await connection.start();
    const destination = channel.destinationFromInbound({ ...events[0], externalMessageId: "<m1@mail.example.com>" });
    expect(await connection.send({ parts: [{ content: "Friday works." }], destination })).toMatchObject({ status: "accepted" });
    await connection.stop();
    const sent = JSON.parse(calls.find((call) => call.url.endsWith("/messages/send"))?.body ?? "{}") as { raw: string; threadId: string };
    expect(sent.threadId).toBe("thread-m1");
    const raw = Buffer.from(sent.raw, "base64url").toString("utf8");
    expect(raw).toContain("To: ana@example.com\r\nSubject: Re: Plans\r\nIn-Reply-To: <m1@mail.example.com>\r\n");
    expect(raw).toContain(Buffer.from("Friday works.").toString("base64"));
  });
});

describe("a flight search tool: acme-flights in place of tavi.flights", () => {
  it("replaces travel.flights_search with its own tool, answers from its fare sheet, and proves travel to Ideas", async () => {
    const dataDirectory = dirs.create("tavi-replace-flights-");
    await replace(dataDirectory, "tavi.flights", "acme-flights", "acme.flights");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("the fare sheet makes no request");
    });
    vi.stubGlobal("fetch", fetch);
    const runtime = await compose(dataDirectory);
    expect(runtime.tools.get("travel.flights_search")).toBeUndefined();
    expect(runtime.tools.get("acme.flights.search")).toMatchObject({ effect: "read-only" });
    expect(await callTool(runtime, "acme.flights.search", { from: "sof", to: "LHR", date: "2026-11-24", maxStops: 0 })).toEqual({
      from: "SOF",
      to: "LHR",
      date: "2026-11-24",
      source: "ACME fare sheet (fixed)",
      itineraries: [
        expect.objectContaining({ flight: "AC105", price: 98, currency: "EUR", date: "2026-11-24" }),
        expect.objectContaining({ flight: "AC101", price: 129 }),
      ],
    });
    expect(fetch).not.toHaveBeenCalled();
    // What the built-in proved while it answered, the example's manifest proves now: the owner's own census reads it.
    const census = async (owner: TaviRuntime) => await owner.ideas.census("default");
    expect(await census(runtime)).toContain("travel");
    await runtime.plugins.registry.disable("acme.flights", "operator");
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await runtime.close();
    expect(await census(await compose(dataDirectory))).not.toContain("travel");
  });
});

describe("a daily brief tool: acme-daily-brief in place of tavi.collectors", () => {
  it("leaves the built-in's collector and report tools out, and writes the brief from the figures it is given", async () => {
    const dataDirectory = dirs.create("tavi-replace-collectors-");
    const before = await compose(dataDirectory);
    const builtins = ["collect.daily", "reports.generate", "reports.history", "projects.get"];
    for (const id of builtins) expect(before.tools.get(id), id).toBeDefined();
    runtimes.splice(runtimes.indexOf(before), 1);
    await before.close();
    await replace(dataDirectory, "tavi.collectors", "acme-daily-brief", "acme.dailybrief");
    const runtime = await compose(dataDirectory);
    for (const id of builtins) expect(runtime.tools.get(id), id).toBeUndefined();
    expect(runtime.tools.get("acme.dailybrief.brief")).toMatchObject({ effect: "read-only" });
    const brief = (await callTool(runtime, "acme.dailybrief.brief", {
      date: "2026-10-25",
      figures: [
        { name: "Sessions", today: 1_100, yesterday: 1_000 },
        { name: "Signups", today: 15, yesterday: 30 },
        { name: "<b>Refunds</b>", today: 2, yesterday: 0 },
      ],
    })) as { text: string; html: string };
    expect(brief.text).toBe(
      ["Daily brief for 2026-10-25", "- <b>Refunds</b>: 2 (+2)", "- Signups: 15 (-15, -50%)", "- Sessions: 1100 (+100, +10%)"].join("\n"),
    );
    // A figure's name is the caller's text: escaped in the report, never markup.
    expect(brief.html).toContain("<li>&lt;b&gt;Refunds&lt;/b&gt;: 2 (+2)</li>");
  });
});

describe("a site profile: acme-flight-sites in place of tavi.siteskills", () => {
  it("offers its profile in Connected apps, off until turned on, and the browser tools then hold to it", async () => {
    const dataDirectory = dirs.create("tavi-replace-sites-");
    await replace(dataDirectory, "tavi.siteskills", "acme-flight-sites", "acme.flightsites");
    const fixture = createFixtureBrowser();
    const navigate = async (sessionId: string, url: string) => ({ sessionId, epoch: 1, url, elements: [{ ref: "el-1" }] });
    const runtime = await compose(
      dataDirectory,
      { approvalRequiredFor: [], browserAllowedHosts: ["www.google.com", "fares.acme.example"] },
      { browserOverride: { ...fixture, navigate } },
    );
    const apps = async (payload: Parameters<typeof appsOwnerCommand>[1]) => {
      const answer = await appsOwnerCommand(runtime, payload, "operator:ui");
      if (!answer.ok) throw new Error(answer.error.message);
      return answer.result as { apps?: { appId: string; sites?: { siteId: string; on: boolean; mode: string; navigate: boolean }[] }[] };
    };
    const listed = await apps({ action: "list", workspaceId: "default" });
    const app = listed.apps?.find((candidate) => candidate.appId === "acme-fare-sites");
    expect(app?.sites).toEqual([expect.objectContaining({ siteId: "acme-fares", mode: "assist-only", navigate: false, on: false })]);

    const session = (await callTool(runtime, "browser.create_session", {})) as { sessionId: string };
    // The built-in's notes are gone with it: Google Flights is reached with no site skill.
    expect(
      await callTool(runtime, "browser.navigate", { sessionId: session.sessionId, url: "https://www.google.com/travel/flights?q=x" }),
    ).not.toHaveProperty("site");
    // Off, the profile sets no rule.
    expect(
      await callTool(runtime, "browser.navigate", { sessionId: session.sessionId, url: "https://fares.acme.example/search?from=SOF" }),
    ).toMatchObject({ url: "https://fares.acme.example/search?from=SOF" });

    await apps({ action: "sites", appId: app?.appId ?? "missing", siteId: "acme-fares", on: true, workspaceId: "default" });
    expect(
      (await apps({ action: "list", workspaceId: "default" })).apps?.find((candidate) => candidate.appId === app?.appId)?.sites?.[0]?.on,
    ).toBe(true);
    // On, its rule holds: Tavi never opens a page there itself.
    await expect(
      callTool(runtime, "browser.navigate", { sessionId: session.sessionId, url: "https://fares.acme.example/search?from=SOF" }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED", message: expect.stringMatching(/only a page the person opened is read/) });
  });
});

describe("a guard mod: acme-guard in place of tavi.guard", () => {
  const envelope: ModEnvelope = { workspaceId: "default", principalId: "operator", taskId: "t", runId: "t", source: "cli", attended: true };
  const check = (input: unknown, over: Partial<ModEnvelope> = {}): ModHookInput<"tool.check"> => ({
    envelope: { ...envelope, ...over },
    tool: "sandbox.run",
    callId: "c",
    input,
    verdict: { decision: "allow", reasons: [] },
  });
  const allow = async () => ({ decision: "allow" as const });

  it("decides sandbox.run's check where the built-in did, once the built-in is disabled", async () => {
    const dataDirectory = dirs.create("tavi-replace-guard-");
    const setup = await compose(dataDirectory);
    await setup.plugins.registry.enable(GUARD_PLUGIN_ID, "operator");
    runtimes.splice(runtimes.indexOf(setup), 1);
    await setup.close();
    const guarded = await compose(dataDirectory);
    expect((await guarded.turnHooks.dispatch("tool.check", check({ command: "rm -rf build" }), allow)).decidedBy).toBe(GUARD_PLUGIN_ID);
    runtimes.splice(runtimes.indexOf(guarded), 1);
    await guarded.close();

    await replace(dataDirectory, GUARD_PLUGIN_ID, join("..", "mods", "acme-guard"), "acme.guard");
    const runtime = await compose(dataDirectory);
    expect((await runtime.plugins.registry.show(GUARD_PLUGIN_ID, runtime.plugins)).enabled).toBe(false);
    expect(runtime.plugins.status("acme.guard").phase).toBe("ready");
    expect(runtime.turnHooks.has("tool.check", envelope, "sandbox.run")).toBe(true);
    const asked = await runtime.turnHooks.dispatch("tool.check", check({ command: "rm", args: ["-rf", "build"] }), allow);
    expect(asked.decidedBy).toBe("acme.guard");
    expect(asked.result).toEqual({ decision: "ask", reason: "This command deletes files recursively." });
    // Where nobody can answer it refuses; anything harmless is left to the gate.
    expect(
      (await runtime.turnHooks.dispatch("tool.check", check({ command: "git reset --hard" }, { attended: false }), allow)).result,
    ).toMatchObject({
      decision: "deny",
    });
    expect((await runtime.turnHooks.dispatch("tool.check", check({ command: "ls" }), allow)).result).toEqual({ decision: "allow" });
  });
});
