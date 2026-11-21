import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ONBOARDING_ABI,
  TaviError,
  type ConnectableApp,
  type ModelConfigPort,
  type ModelConnection,
  type OnboardingFlow,
  type OnboardingFlowAnswer,
  type OnboardingPayload,
  type OnboardingStatus,
} from "@tavi/contracts";
import { OnboardingProviderRegistry, hostFallbackFlow, type OnboardingLiveFacts } from "@tavi/agent-host/onboarding-host";
import { temporaryDirectories, partialFake } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVerifyGate, onboardingCommand, type OnboardingCommandDependencies } from "../../src/features/onboard/owner.js";
import { liveOnboardingFacts, serviceState, unitNamesDataDirectory, type OnboardingFactSources } from "../../src/features/onboard/facts.js";
import { onboardingTurnRecorder } from "../../src/features/onboard/verification.js";
import { renderServiceUnit } from "../../src/features/service/unit.js";
import { SqliteStore } from "../support/database-fixture.js";

/** `onboarding`: the command, live facts, the service unit, real turns and the backfill. */

const NOW = new Date("2026-10-20T09:00:00.000Z");
const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const EMPTY: OnboardingLiveFacts = {
  model: { hasConnection: false },
  about: { namePreference: false },
  search: { installed: true, ready: [] },
  apps: { available: [{ id: "gmail", label: "Gmail" }], connected: [] },
  channels: { available: true, connections: [] },
  service: { supported: true, running: false, installed: false },
  ideas: { tried: false, startedTurn: false },
};

async function fixture(extra: Partial<OnboardingCommandDependencies> = {}, facts: OnboardingLiveFacts = EMPTY) {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const repositories = store.asPort().repositories;
  const deps: OnboardingCommandDependencies = {
    repositories,
    principalOf: (workspaceId) => (workspaceId === "default" ? "operator" : undefined),
    providers: new OnboardingProviderRegistry(),
    facts: async () => facts,
    census: async () => [],
    channelKinds: () => ["telegram"],
    appIds: async () => ["gmail"],
    now: () => NOW,
    ...extra,
  };
  const call = async (payload: OnboardingPayload) => {
    const answer = await onboardingCommand(deps, payload);
    if (!answer.ok) throw new TaviError(answer.error.code as "INVALID_INPUT", answer.error.message);
    return answer.result as OnboardingStatus & Record<string, unknown>;
  };
  const refusal = async (payload: OnboardingPayload) => {
    const answer = await onboardingCommand(deps, payload);
    if (answer.ok) throw new Error(`${payload.action} was accepted`);
    return answer.error;
  };
  return { repositories, deps, call, refusal };
}

describe("onboarding command", () => {
  it("answers a fresh install's status in the flow's order, and notes when it was first seen", async () => {
    const { call, repositories } = await fixture();
    const status = await call({ action: "status" });
    expect(status).toMatchObject({ workspaceId: "default", providerId: null, firstRun: true, complete: false });
    // Every step the flow has, on every surface: the terminal's service step too, said to be done there.
    expect(status.open).toEqual(["model", "about", "search", "apps", "tasks", "channels", "voice", "service", "ideas"]);
    expect(status.steps.find((step) => step.kind === "service")).toMatchObject({ elsewhere: "cli", title: "Keep it running" });
    expect((await repositories.onboarding.install()).firstSeenAt).toBe(NOW.toISOString());
  });

  it("refuses a workspace with no operator", async () => {
    const { refusal } = await fixture();
    expect(await refusal({ action: "status", workspaceId: "elsewhere" })).toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("skips, restores, completes and confirms steps; never skips the model, never marks a step live state proves", async () => {
    const { call, refusal } = await fixture();
    expect((await call({ action: "skip", step: "channels" })).steps.find((step) => step.kind === "channels")?.state).toBe("skipped");
    expect((await call({ action: "restore", step: "channels" })).steps.find((step) => step.kind === "channels")?.state).toBe("todo");
    expect((await call({ action: "complete-step", step: "about" })).steps.find((step) => step.kind === "about")?.state).toBe("done");
    expect(await refusal({ action: "skip", step: "model" })).toMatchObject({ code: "INVALID_INPUT" });
    expect(await refusal({ action: "complete-step", step: "channels" })).toMatchObject({ code: "INVALID_INPUT" });
    const cli = await fixture();
    expect((await cli.call({ action: "status", surface: "cli" })).open).toContain("service");
    expect((await cli.call({ action: "status" })).steps.find((step) => step.kind === "service")?.elsewhere).toBe("cli");
    const confirmed = await cli.call({ action: "confirm-service", mode: "self-managed", surface: "cli" });
    expect(confirmed.steps.find((step) => step.kind === "service")).toMatchObject({ state: "done", detail: "You run it yourself" });
    expect(confirmed.open).not.toContain("service");
  });

  it("marks Tavi's own list as the tasks step's answer, and takes a saved task app as done with its name", async () => {
    const { call } = await fixture();
    expect((await call({ action: "status" })).steps.find((step) => step.kind === "tasks")).toMatchObject({ state: "todo" });
    expect((await call({ action: "complete-step", step: "tasks" })).steps.find((step) => step.kind === "tasks")).toMatchObject({
      state: "done",
      detail: "Tavi's own list",
    });
    const todoist = { id: "mcp:todoist", label: "Todoist", connected: true };
    const saved = await fixture({}, { ...EMPTY, tasks: { home: "mcp:todoist", apps: [todoist] } });
    expect((await saved.call({ action: "status" })).steps.find((step) => step.kind === "tasks")).toEqual({
      title: "Where do you keep tasks?",
      kind: "tasks",
      state: "done",
      detail: "Todoist",
      items: [{ id: "mcp:todoist", label: "Todoist", state: "connected" }],
    });
    // Added but not signed in: listed for the step to offer, the step still open.
    const added = await fixture({}, { ...EMPTY, tasks: { apps: [{ ...todoist, connected: false }] } });
    expect((await added.call({ action: "status" })).steps.find((step) => step.kind === "tasks")).toMatchObject({
      state: "todo",
      items: [{ id: "mcp:todoist", state: "needs-sign-in" }],
    });
  });

  it("dismisses for the flow in use, keeping every kind it has, though no surface walked it yet", async () => {
    const { call, repositories } = await fixture();
    await call({ action: "dismiss", surface: "web" });
    const install = await repositories.onboarding.install();
    const flow = (await call({ action: "flow", surface: "web" })) as unknown as OnboardingFlowAnswer;
    expect(install.dismissedFlowVersion).toBe(flow.flow.version);
    expect(install.dismissedStepKinds).toEqual(flow.flow.steps.map((step) => step.kind));
  });

  it("dismisses for the flow version walked, and resets skips and the dismissal only", async () => {
    const { call, repositories } = await fixture();
    const walked = (await call({ action: "flow", surface: "web" })) as unknown as OnboardingFlowAnswer;
    await call({ action: "skip", step: "apps" });
    const dismissed = await call({ action: "dismiss" });
    expect(dismissed.dismissedAt).toBe(NOW.toISOString());
    expect(dismissed.firstRun).toBe(false);
    expect((await repositories.onboarding.install()).dismissedFlowVersion).toBe(walked.flow.version);
    expect(await call({ action: "reset" })).toEqual({ cleared: 1 });
    const after = await call({ action: "status" });
    expect(after.dismissedAt).toBeUndefined();
    expect(after.steps.find((step) => step.kind === "apps")?.state).toBe("todo");
  });

  it("counts skips and reached steps in the status's funnel, kept on this machine", async () => {
    const { call } = await fixture();
    expect((await call({ action: "status" })).funnel).toBeUndefined();
    expect(await call({ action: "reached", step: "about" })).toEqual({ recorded: true });
    await call({ action: "skip", step: "about" });
    expect((await call({ action: "status" })).funnel).toEqual({ about: { reached: 1, skipped: 1, failed: 0 } });
    await call({ action: "reset" });
    expect((await call({ action: "status" })).funnel).toBeUndefined();
  });

  it("refuses reset and a provider change through the canvas bridge", async () => {
    const { refusal } = await fixture({ fromBridge: true });
    expect(await refusal({ action: "reset" })).toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(await refusal({ action: "provider", id: "tavi.onboarding" })).toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("selects an installed flow, falls back from one that throws, and refuses one not installed", async () => {
    const providers = new OnboardingProviderRegistry();
    const flow: OnboardingFlow = {
      abi: ONBOARDING_ABI,
      version: 3,
      title: "ACME",
      steps: [{ id: "about", kind: "about", title: "You", body: "You.", optional: true }],
      done: { title: "Done", body: "Done." },
    };
    providers.install("acme.onboarding", { provider: { flow: async () => flow }, kind: "plugin" });
    providers.install("acme.broken", {
      provider: {
        flow: async () => {
          throw new Error("boom");
        },
      },
      kind: "plugin",
    });
    const { call, refusal, repositories } = await fixture({ providers });
    expect(await refusal({ action: "provider", id: "acme.missing" })).toMatchObject({ code: "NOT_FOUND" });
    expect(await call({ action: "provider", id: "acme.onboarding" })).toMatchObject({
      providerId: "acme.onboarding",
      providers: [
        { id: "acme.onboarding", kind: "plugin" },
        { id: "acme.broken", kind: "plugin" },
      ],
    });
    const answer = await call({ action: "flow", surface: "web" });
    expect(answer).toMatchObject({ providerId: "acme.onboarding" });
    // The host put the open model step first.
    expect((answer["flow"] as OnboardingFlow).steps.map((step) => step.kind)).toEqual(["model", "about"]);
    expect((await repositories.onboarding.install()).flowVersion).toBe(3);
    expect((await call({ action: "status" })).open).toEqual(["model", "about"]);
    await call({ action: "provider", id: "acme.broken" });
    expect(await call({ action: "flow", surface: "web" })).toMatchObject({
      providerId: "host",
      fallback: "acme.broken's flow was not used: it failed",
    });
  });

  it("gives a plugin flow's ideas step with no prompts the host's own, whichever provider is chosen", async () => {
    const providers = new OnboardingProviderRegistry();
    const flow: OnboardingFlow = {
      abi: ONBOARDING_ABI,
      version: 1,
      title: "ACME",
      steps: [{ id: "ideas", kind: "ideas", title: "Try", body: "Try.", optional: true }],
      done: { title: "Done", body: "Done." },
    };
    providers.install("acme.onboarding", { provider: { flow: async () => flow }, kind: "plugin" });
    const { call } = await fixture({ providers });
    await call({ action: "provider", id: "acme.onboarding" });
    const ideas = ((await call({ action: "flow", surface: "web" }))["flow"] as OnboardingFlow).steps.find((step) => step.kind === "ideas");
    expect(ideas?.prompts).toEqual(hostFallbackFlow().steps.find((step) => step.kind === "ideas")?.prompts);
  });

  it("refuses detect, connect-detected and verify where nothing can run them", async () => {
    const { refusal } = await fixture();
    for (const payload of [{ action: "verify" }, { action: "detect" }, { action: "connect-detected", preset: "ollama" }] as const)
      expect(await refusal(payload)).toMatchObject({ code: "UNSUPPORTED" });
  });
});

// ------------------------------------------------------------------ live facts

const CONNECTION: ModelConnection = {
  connectionId: "openrouter",
  label: "OpenRouter",
  kind: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  credentialRef: "openrouter",
  defaultModel: "anthropic/claude-sonnet",
  localOnly: false,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

/** A model config with one connection as the default `main`, `fast` resolving where it is told. */
function modelConfig(state: {
  connection: ModelConnection;
  model: string;
  fast?: string;
  catalog?: "available" | "unavailable";
}): ModelConfigPort {
  const resolution = (role: "main" | "fast", model: string) => ({
    workspaceId: "default",
    role,
    target: { connectionId: state.connection.connectionId, model },
    connection: state.connection,
    source: "default" as const,
    skipped: [],
    fallback: [],
  });
  return {
    listConnections: async () => [state.connection],
    getConnection: async () => state.connection,
    getWorkspaceDefault: async () => ({
      workspaceId: "default",
      target: { connectionId: state.connection.connectionId, model: state.model },
    }),
    listRoleBindings: async () => [],
    resolveRole: async ({ role }: { role: string }) => {
      if (role === "fast" && state.fast !== undefined) return resolution("fast", state.fast);
      if (role === "fast") throw new TaviError("NOT_CONFIGURED", "no fast");
      return resolution("main", state.model);
    },
    listCatalog: async () =>
      state.catalog === undefined
        ? []
        : [
            {
              connectionId: state.connection.connectionId,
              modelId: state.model,
              provenance: "live",
              state: state.catalog,
              capabilities: [],
            },
          ],
  } as unknown as ModelConfigPort;
}

async function sources(
  config: ModelConfigPort,
  secret: { value: string },
): Promise<{
  readonly sources: OnboardingFactSources;
  readonly repositories: OnboardingCommandDependencies["repositories"] & OnboardingFactSources["repositories"];
}> {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const repositories = store.asPort().repositories;
  return {
    repositories,
    sources: {
      repositories,
      modelConfig: config,
      credentialRevision: async (reference) => createHash("sha256").update(`${reference}\0${secret.value}`).digest("hex"),
      credentialStored: async () => true,
      principalOf: () => "operator",
      channelKinds: () => [],
      startedTurn: async () => false,
      service: async () => ({ supported: true, running: false, installed: false }),
      now: () => NOW,
    },
  };
}

describe("live onboarding facts", () => {
  it("reads the default target with its credential revision, which a key rotated in place changes", async () => {
    const secret = { value: "aaaa" };
    const config = modelConfig({ connection: CONNECTION, model: "anthropic/claude-sonnet", fast: "anthropic/claude-haiku" });
    const { sources: live, repositories } = await sources(config, secret);
    const first = await liveOnboardingFacts(live, "default");
    expect(first.model.main).toMatchObject({
      connectionId: "openrouter",
      model: "anthropic/claude-sonnet",
      baseUrl: CONNECTION.baseUrl,
      label: "OpenRouter",
    });
    expect(first.model.fast?.model).toBe("anthropic/claude-haiku");
    expect(first.channels.available).toBe(false);
    await repositories.onboarding.recordVerification({
      workspaceId: "default",
      subject: "model",
      role: "main",
      subjectId: "openrouter",
      model: "anthropic/claude-sonnet",
      baseUrl: CONNECTION.baseUrl,
      credentialRevision: first.model.main?.credentialRevision as string,
      ok: true,
      at: NOW.toISOString(),
    });
    secret.value = "bbbb";
    const rotated = await liveOnboardingFacts(live, "default");
    expect(rotated.model.main?.credentialRevision).not.toBe(first.model.main?.credentialRevision);
  });

  it("names a provider-managed connection's plugin, with no revision", async () => {
    const managed = {
      ...CONNECTION,
      providerBinding: { instanceId: "acme.models", workspaceId: "default", principalId: "operator", bindingHash: "c".repeat(64) },
    };
    const { sources: live } = await sources(modelConfig({ connection: managed, model: "m" }), { value: "x" });
    expect((await liveOnboardingFacts(live, "default")).model.main).toEqual({
      connectionId: "openrouter",
      model: "m",
      baseUrl: CONNECTION.baseUrl,
      label: "OpenRouter",
      providedBy: "acme.models",
    });
  });

  it("names a channel by its label, else the account it speaks as, never its internal id when either is set", async () => {
    const { sources: live, repositories } = await sources(modelConfig({ connection: CONNECTION, model: "m" }), { value: "x" });
    const connection = (label: string | undefined, accountIdentity: string) => ({
      connectionId: "telegram-03a2",
      providerId: "telegram",
      workspaceId: "default",
      ...(label === undefined ? {} : { label }),
      accountIdentity,
      enabled: true,
    });
    const named = async (label: string | undefined, accountIdentity: string) =>
      (
        await liveOnboardingFacts(
          {
            ...live,
            repositories: {
              ...repositories,
              messagingConnections: { ...repositories.messagingConnections, list: async () => [connection(label, accountIdentity)] },
            } as unknown as typeof live.repositories,
          },
          "default",
        )
      ).channels.connections[0]?.label;
    expect(await named("My bot", "@tavi_bot")).toBe("My bot");
    expect(await named(undefined, "@tavi_bot")).toBe("@tavi_bot");
    expect(await named(undefined, " ")).toBe("telegram-03a2");
  });

  it("counts a provider the owner was launched with as a model connection, so it is no first run", async () => {
    const empty = partialFake<ModelConfigPort>({ ...modelConfig({ connection: CONNECTION, model: "m" }), listConnections: async () => [] });
    const { sources: live } = await sources(empty, { value: "x" });
    expect((await liveOnboardingFacts(live, "default")).model.hasConnection).toBe(false);
    expect((await liveOnboardingFacts({ ...live, launchedWithModel: true }, "default")).model.hasConnection).toBe(true);
  });

  it("reads the saved task home and the task apps added as MCP servers, each by the home it would be", async () => {
    const { sources: live, repositories } = await sources(modelConfig({ connection: CONNECTION, model: "m" }), { value: "x" });
    expect((await liveOnboardingFacts(live, "default")).tasks).toEqual({ apps: [] });
    const account = (accountId: string, health: string) => ({ accountId, label: accountId, health, workspaces: ["default"] });
    const apps = async () =>
      [
        {
          appId: "todoist",
          name: "Todoist",
          category: "tasks",
          source: { kind: "mcp", pluginIds: ["mcp.todoist"] },
          accounts: [account("mcp.todoist", "ready")],
        },
        { appId: "gcal", name: "Google Calendar", category: "calendar", source: { kind: "mcp" }, accounts: [account("mcp.gcal", "ready")] },
      ] as unknown as readonly ConnectableApp[];
    const current = await repositories.workspaceSettings.get("default");
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { ...current.settings, tasksHome: "mcp:todoist" },
      expectedRevision: current.revision,
      actor: "operator",
      now: NOW.toISOString(),
    });
    expect((await liveOnboardingFacts({ ...live, apps }, "default")).tasks).toEqual({
      home: "mcp:todoist",
      apps: [{ id: "mcp:todoist", label: "Todoist", connected: true }],
    });
  });

  it("counts a SearXNG instance as ready with no key, and a keyed kind only with its key stored", async () => {
    const { sources: live, repositories } = await sources(modelConfig({ connection: CONNECTION, model: "m" }), { value: "x" });
    const now = NOW.toISOString();
    await repositories.searchProviders.add({ providerId: "home", kind: "searxng", baseUrl: "http://127.0.0.1:8888", enabled: true, now });
    await repositories.searchProviders.add({ providerId: "brave", kind: "brave", credentialRef: "search.brave", enabled: true, now });
    const facts = await liveOnboardingFacts({ ...live, credentialStored: async () => false }, "default");
    expect(facts.search.ready).toEqual([{ id: "home", label: "home" }]);
  });

  it("counts an enabled search plugin's active instance as ready, in its own workspace only", async () => {
    const { sources: live } = await sources(modelConfig({ connection: CONNECTION, model: "m" }), { value: "x" });
    const withPlugin = { ...live, externalSearch: (workspaceId: string) => (workspaceId === "default" ? ["acme.search/main"] : []) };
    expect((await liveOnboardingFacts(withPlugin, "default")).search.ready).toEqual([
      { id: "acme.search/main", label: "acme.search/main" },
    ]);
    expect((await liveOnboardingFacts(withPlugin, "other")).search.ready).toEqual([]);
    expect(
      (
        await liveOnboardingFacts(
          {
            ...live,
            externalSearch: () => {
              throw new Error("gone");
            },
          },
          "default",
        )
      ).search.ready,
    ).toEqual([]);
  });
});

describe("the service step's facts", () => {
  const unit = (dataDirectory: string) =>
    renderServiceUnit({
      kind: "launchd",
      executablePath: "/usr/local/lib/tavi/executable.mjs",
      nodePath: "/usr/local/bin/node",
      dataDirectory,
      label: "dev.tavi.serve",
    });

  it("counts a unit only when it names this data directory, and running only from the owner itself", async () => {
    const home = directories.create("tavi-onboard-home-");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    const path = join(home, "Library", "LaunchAgents", "dev.tavi.serve.plist");
    writeFileSync(path, unit("/data/other"));
    expect(await serviceState({ platform: "darwin", dataDirectory: "/data/mine", ownerIsService: false, home })).toEqual({
      supported: true,
      running: false,
      installed: false,
    });
    writeFileSync(path, unit("/data/mine"));
    expect(await serviceState({ platform: "darwin", dataDirectory: "/data/mine", ownerIsService: false, home })).toEqual({
      supported: true,
      running: false,
      installed: true,
    });
    // A unit under another label is found only through the label the flow recorded.
    expect(
      await serviceState({ platform: "darwin", dataDirectory: "/data/mine", ownerIsService: true, label: "dev.tavi.other", home }),
    ).toEqual({ supported: true, running: true, installed: false });
    expect(await serviceState({ platform: "win32", dataDirectory: "/data/mine", ownerIsService: false, home })).toEqual({
      supported: false,
      running: false,
      installed: false,
    });
  });

  it("matches a systemd unit's --data-dir, quoted or not, and not a prefix of it", () => {
    expect(unitNamesDataDirectory("ExecStart=/usr/bin/tavi serve --data-dir /srv/tavi\n", "/srv/tavi")).toBe(true);
    expect(unitNamesDataDirectory('ExecStart=/usr/bin/tavi serve --data-dir "/srv/my tavi"\n', "/srv/my tavi")).toBe(true);
    expect(unitNamesDataDirectory("ExecStart=/usr/bin/tavi serve --data-dir /srv/tavi-2\n", "/srv/tavi")).toBe(false);
  });
});

// ------------------------------------------------------------------ real turns and the backfill

describe("real turns' verifications", () => {
  async function recorder() {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const repositories = store.asPort().repositories;
    const turns = onboardingTurnRecorder({
      repositories,
      modelConfig: modelConfig({ connection: CONNECTION, model: "anthropic/claude-sonnet" }),
      credentialRevision: async () => "d".repeat(64),
      now: () => NOW,
    });
    const context = { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "cli" } as const;
    const settle = async (status: "completed" | "failed" | "aborted", errorCode?: string, model = "anthropic/claude-sonnet") => {
      turns.record({
        connectionId: "openrouter",
        model,
        context: context as never,
        status,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
      await turns.idle();
      return await repositories.onboarding.verifications("default", "model");
    };
    const record = async (call: { status: "completed" | "failed"; errorCode?: string; purpose: string }) => {
      turns.record({ connectionId: "openrouter", model: "anthropic/claude-sonnet", context: context as never, ...call });
      await turns.idle();
      return await repositories.onboarding.verifications("default", "model");
    };
    return { settle, record, repositories };
  }

  it("marks the model failed on a lasting refusal, and leaves it alone on a transient one", async () => {
    const { settle } = await recorder();
    expect(await settle("failed", "rate_limit")).toEqual([]);
    expect(await settle("failed", "provider")).toEqual([]);
    expect(await settle("aborted")).toEqual([]);
    // A turn's own refusal (a long history, a big image) says nothing of the model.
    expect(await settle("failed", "invalid_request")).toEqual([]);
    expect(await settle("failed", "auth")).toMatchObject([
      { role: "main", ok: false, errorCode: "auth", credentialRevision: "d".repeat(64) },
    ]);
  });

  it("verifies an unverified model on a success, and never touches another target or a background call", async () => {
    const { settle, record } = await recorder();
    expect(await record({ status: "failed", errorCode: "auth", purpose: "summary" })).toEqual([]);
    expect(await settle("completed", undefined, "some/other-model")).toEqual([]);
    expect(await settle("completed")).toMatchObject([{ role: "main", ok: true, model: "anthropic/claude-sonnet" }]);
  });

  it("keeps a verify's own row when a turn succeeds on the same target", async () => {
    const { settle, repositories } = await recorder();
    await repositories.onboarding.recordVerification({
      workspaceId: "default",
      subject: "model",
      role: "main",
      subjectId: "openrouter",
      model: "anthropic/claude-sonnet",
      baseUrl: CONNECTION.baseUrl,
      credentialRevision: "d".repeat(64),
      ok: true,
      toolsOk: true,
      at: "2026-10-19T09:00:00.000Z",
    });
    expect(await settle("completed")).toMatchObject([{ toolsOk: true, at: "2026-10-19T09:00:00.000Z" }]);
  });
});

// ------------------------------------------------------------------ verify, detect and connect

describe("verify", () => {
  const live = (
    main = {
      connectionId: "openrouter",
      model: "anthropic/claude-sonnet",
      baseUrl: "https://openrouter.ai/api/v1",
      label: "OpenRouter",
      credentialRevision: "f".repeat(64),
    },
    fast?: typeof main,
  ): OnboardingLiveFacts => ({ ...EMPTY, model: { hasConnection: true, main, ...(fast === undefined ? {} : { fast }) } });
  const tested = (result: Record<string, unknown>) => async (payload: { action: string }) =>
    payload.action === "test" ? { ok: true as const, result } : { ok: true as const, result: [] };

  it("records a passing verify with its tool probe, and the model is done", async () => {
    const calls: unknown[] = [];
    const { call, repositories } = await fixture(
      {
        config: {
          credentials: async () => ({ ok: true, result: {} }),
          models: async (payload) => {
            calls.push(payload);
            return await tested({ ok: true, capabilities: ["chat", "tools"] })(payload);
          },
        },
      },
      live(),
    );
    const answer = await call({ action: "verify" });
    expect(answer["results"]).toEqual([
      { role: "main", connectionId: "openrouter", model: "anthropic/claude-sonnet", ok: true, toolsOk: true },
    ]);
    expect((answer["status"] as OnboardingStatus).steps[0]?.state).toBe("done");
    expect(calls).toEqual([{ action: "test", connectionId: "openrouter", model: "anthropic/claude-sonnet", workspaceId: "default" }]);
    expect(await repositories.onboarding.verifications("default")).toMatchObject([
      { ok: true, toolsOk: true, credentialRevision: "f".repeat(64) },
    ]);
  });

  it("warns on a model that answered without calling the probe tool, and tests fast when it is another target", async () => {
    const fast = {
      connectionId: "openrouter",
      model: "anthropic/claude-haiku",
      baseUrl: "https://openrouter.ai/api/v1",
      label: "OpenRouter",
      credentialRevision: "f".repeat(64),
    };
    const { call } = await fixture(
      { config: { credentials: async () => ({ ok: true, result: {} }), models: tested({ ok: true, capabilities: ["chat"] }) } },
      live(undefined, fast),
    );
    const results = (await call({ action: "verify" }))["results"] as { role: string; toolsOk: boolean; advice?: string }[];
    expect(results.map((result) => result.role)).toEqual(["main", "fast"]);
    expect(results[0]).toMatchObject({ toolsOk: false, advice: expect.stringContaining("didn't call a tool") });
  });

  it("gives plain advice for a refused key, an unknown model, a stopped local server and a timeout, and records only a lasting refusal", async () => {
    const cases = [
      [{ ok: false, capabilities: [], failureCode: "auth", message: "MODEL_FAILED: 401" }, "auth", "The key was refused", true],
      [
        { ok: false, capabilities: [], message: "MODEL_FAILED: 404 model_not_found" },
        "model_unavailable",
        "can't use anthropic/claude-sonnet",
        true,
      ],
      [
        { ok: false, capabilities: [], transient: true, message: "UNAVAILABLE: fetch failed: connect ECONNREFUSED 127.0.0.1:11434" },
        "unreachable",
        "Ollama isn't running",
        false,
      ],
      [
        { ok: false, capabilities: [], transient: true, message: "UNAVAILABLE: The connection test exceeded 20000ms" },
        "timeout",
        "didn't answer within 20 seconds",
        false,
      ],
    ] as const;
    for (const [result, code, advice, recorded] of cases) {
      const main =
        code === "unreachable"
          ? {
              connectionId: "ollama",
              model: "anthropic/claude-sonnet",
              baseUrl: "http://localhost:11434/v1",
              label: "Ollama",
              credentialRevision: "f".repeat(64),
            }
          : undefined;
      const { call, repositories } = await fixture(
        { config: { credentials: async () => ({ ok: true, result: {} }), models: tested(result) } },
        live(main),
      );
      const answer = await call({ action: "verify" });
      expect((answer["results"] as unknown[])[0], code).toMatchObject({
        ok: false,
        errorCode: code,
        advice: expect.stringContaining(advice),
      });
      expect((await repositories.onboarding.verifications("default")).length, code).toBe(recorded ? 1 : 0);
      // A lasting refusal leaves the model to do; a passing failure leaves it set up, still to verify.
      expect((answer["status"] as OnboardingStatus).steps[0]?.state, code).toBe(recorded ? "todo" : "done");
      // The funnel counts every failure, a transient one too, by its code.
      expect((await repositories.onboarding.funnel("default")).model, code).toMatchObject({ failed: 1, lastError: code });
    }
  });

  it("never touches the configured target, and refuses a second verify within seconds", async () => {
    const writes: unknown[] = [];
    const { call, refusal } = await fixture(
      {
        config: {
          credentials: async () => ({ ok: true, result: {} }),
          models: async (payload) => {
            if (payload.action !== "test") writes.push(payload);
            return await tested({ ok: false, capabilities: [], failureCode: "auth" })(payload);
          },
        },
        verifyGate: createVerifyGate(),
      },
      live(),
    );
    await call({ action: "verify" });
    expect(writes).toEqual([]);
    expect(await refusal({ action: "verify" })).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("passes a refusal of models test through as it is, recording nothing", async () => {
    const { call, repositories } = await fixture(
      {
        config: {
          credentials: async () => ({ ok: true, result: {} }),
          models: async () => ({
            ok: false,
            error: { code: "NOT_AUTHORIZED", message: "credential openrouter is bound to another origin" },
          }),
        },
      },
      live(),
    );
    expect(((await call({ action: "verify" }))["results"] as unknown[])[0]).toMatchObject({
      ok: false,
      errorCode: "not_authorized",
      advice: "credential openrouter is bound to another origin",
    });
    expect(await repositories.onboarding.verifications("default")).toEqual([]);
  });

  it("takes every role's gate before testing either", async () => {
    const fast = {
      connectionId: "openrouter",
      model: "anthropic/claude-haiku",
      baseUrl: "https://openrouter.ai/api/v1",
      label: "OpenRouter",
      credentialRevision: "f".repeat(64),
    };
    const tests: unknown[] = [];
    const gate = createVerifyGate();
    gate.begin("default\u0000fast", NOW.getTime());
    const { refusal } = await fixture(
      {
        verifyGate: gate,
        config: {
          credentials: async () => ({ ok: true, result: {} }),
          models: async (payload) => {
            tests.push(payload);
            return { ok: true, result: { ok: true, capabilities: ["tools"] } };
          },
        },
      },
      live(undefined, fast),
    );
    expect(await refusal({ action: "verify" })).toMatchObject({ code: "RATE_LIMITED" });
    expect(tests).toEqual([]);
  });

  it("refuses with no model, and says a provider-managed model verifies on its first turn", async () => {
    const empty = await fixture({
      config: { credentials: async () => ({ ok: true, result: {} }), models: tested({ ok: true, capabilities: [] }) },
    });
    expect(await empty.refusal({ action: "verify" })).toMatchObject({ code: "NOT_CONFIGURED" });
    const managed = await fixture(
      { config: { credentials: async () => ({ ok: true, result: {} }), models: tested({ ok: true, capabilities: [] }) } },
      live({ connectionId: "acme", model: "m", baseUrl: "", label: "ACME", providedBy: "acme.models" } as never),
    );
    expect(((await managed.call({ action: "verify" }))["results"] as unknown[])[0]).toMatchObject({
      ok: false,
      errorCode: "provider-managed",
      advice: expect.stringContaining("first answered turn"),
    });
  });
});

describe("detection", () => {
  const PLANTED = "sk-or-v1-planted-secret-value";
  /** A loopback stub: Ollama answers on 11434 with these models and capabilities; nothing else listens. */
  const ollama =
    (models: Record<string, readonly string[] | undefined>): typeof globalThis.fetch =>
    async (input, init) => {
      const url = String(input);
      if (url === "http://127.0.0.1:11434/v1/models")
        return new Response(JSON.stringify({ data: Object.keys(models).map((id) => ({ id, object: "model" })) }));
      if (url === "http://127.0.0.1:11434/api/show") {
        const capabilities = models[(JSON.parse(String(init?.body)) as { model: string }).model];
        return new Response(JSON.stringify(capabilities === undefined ? {} : { capabilities }));
      }
      throw new TypeError("fetch failed: connect ECONNREFUSED");
    };

  it("names allowlisted variables and counts local models, never a value", async () => {
    const env = { OPENROUTER_API_KEY: PLANTED, AWS_SECRET_ACCESS_KEY: "nope", GEMINI_API_KEY: "  " };
    const { call } = await fixture({
      detection: {
        env,
        fetch: ollama({
          "qwen3:8b": ["completion", "tools"],
          "nomic-embed-text": ["embedding"],
          "gemma2:2b": ["completion"],
          "llama3.1:8b": undefined,
        }),
      },
    });
    const answer = await call({ action: "detect" });
    expect(answer).toEqual({ env: ["OPENROUTER_API_KEY"], local: [{ preset: "ollama", models: 3, toolCapableModels: 2 }], existing: [] });
    expect(JSON.stringify(answer)).not.toContain(PLANTED);
  });

  it("recommends Ollama only with a tool-capable model, else keeps the flow's recommendation", async () => {
    const recommended = async (models: Record<string, readonly string[] | undefined>) => {
      const providers = new OnboardingProviderRegistry();
      providers.install("tavi.onboarding", {
        provider: {
          flow: async () => ({
            abi: ONBOARDING_ABI,
            version: 1,
            title: "Welcome",
            steps: [
              {
                id: "model",
                kind: "model",
                title: "Model",
                body: "Pick one.",
                optional: false,
                featured: ["openrouter", "ollama"],
                recommended: "openrouter",
              },
            ],
            done: { title: "Done", body: "Done." },
          }),
        },
        kind: "builtin",
      });
      const { call } = await fixture({ providers, detection: { env: {}, fetch: ollama(models) } });
      return ((await call({ action: "flow", surface: "web" }))["flow"] as OnboardingFlow).steps[0]?.recommended;
    };
    expect(await recommended({ "qwen3:8b": ["tools"] })).toBe("ollama");
    expect(await recommended({ "nomic-embed-text": ["embedding"], "gemma2:2b": ["completion"] })).toBe("openrouter");
  });
});

describe("the flow a status read orders by", () => {
  it("is kept 15 seconds while facts and records are unchanged, and resolved again on either", async () => {
    let calls = 0;
    let now = NOW.getTime();
    const providers = new OnboardingProviderRegistry();
    providers.install("tavi.onboarding", {
      provider: {
        flow: async () => {
          calls += 1;
          return {
            abi: ONBOARDING_ABI,
            version: 1,
            title: "Welcome",
            steps: [
              { id: "model", kind: "model", title: "Model", body: "Pick one.", optional: false },
              { id: "about", kind: "about", title: "About", body: "Name.", optional: true },
            ],
            done: { title: "Done", body: "Done." },
          };
        },
      },
      kind: "builtin",
    });
    const { call } = await fixture({ providers, now: () => new Date(now) });
    await call({ action: "status", workspaceId: "default" });
    await call({ action: "status", workspaceId: "default" });
    expect(calls).toBe(1);
    // The skip changes the records: the status it answers resolves the flow again, and is kept.
    await call({ action: "skip", workspaceId: "default", step: "about" });
    expect(calls).toBe(2);
    await call({ action: "status", workspaceId: "default" });
    expect(calls).toBe(2);
    now += 15_001;
    await call({ action: "status", workspaceId: "default" });
    expect(calls).toBe(3);
  });
});

describe("the census a flow is shown (invariant 15)", () => {
  it("is the Ideas census itself, passed to the plugin's flow unchanged", async () => {
    const seen: unknown[] = [];
    const providers = new OnboardingProviderRegistry();
    providers.install("tavi.onboarding", {
      provider: {
        flow: async (request) => {
          seen.push(request.census);
          return {
            abi: ONBOARDING_ABI,
            version: 1,
            title: "Welcome",
            steps: [{ id: "model", kind: "model", title: "Model", body: "Pick one.", optional: false }],
            done: { title: "Done", body: "Done." },
          };
        },
      },
      kind: "builtin",
    });
    const { call } = await fixture({ providers, census: async () => ["web", "reminders"] });
    await call({ action: "flow", surface: "web" });
    expect(seen).toEqual([["web", "reminders"]]);
  });
});

describe("connect-detected", () => {
  function config(
    existing: readonly string[] = [],
    options: {
      readonly baseUrl?: string;
      readonly stored?: readonly string[];
      readonly discovered?: readonly string[];
      readonly shown?: readonly Record<string, unknown>[];
    } = {},
  ) {
    const calls: { readonly command: string; readonly payload: Record<string, unknown> }[] = [];
    return {
      calls,
      config: {
        credentials: async (payload: { action: string }) => {
          calls.push({ command: "credentials", payload: payload as Record<string, unknown> });
          return { ok: true as const, result: payload.action === "list" ? { credentials: options.stored ?? [] } : {} };
        },
        models: async (payload: { action: string }) => {
          calls.push({ command: "models", payload: payload as Record<string, unknown> });
          if (payload.action === "list")
            return {
              ok: true as const,
              result: existing.map((connectionId) => ({ connectionId, baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1" })),
            };
          if (payload.action === "discover")
            return {
              ok: true as const,
              result: { models: (options.discovered ?? ["qwen3:8b", "nomic-embed-text"]).map((modelId) => ({ modelId })) },
            };
          if (payload.action === "show" && options.shown !== undefined) return { ok: true as const, result: { catalog: options.shown } };
          return { ok: true as const, result: {} };
        },
      },
    };
  }
  const running: typeof globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }));

  it("proposes no model a stored lifecycle says is going, when the connection is set up again", async () => {
    const discovered = ["anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-4.5"];
    const retired = { status: "retired", catalogVersion: "v", checkedAt: "2026-11-20T08:00:00.000Z" };
    const plain = config([], { discovered });
    const before = await fixture({ config: plain.config, detection: { env: { OPENROUTER_API_KEY: "sk-or-v1-x" }, fetch: running } });
    const first = (await before.call({ action: "connect-detected", preset: "openrouter", variable: "OPENROUTER_API_KEY" })) as unknown as {
      suggested: { main?: string };
    };
    const best = first.suggested.main;
    expect(best).toBeDefined();
    const going = config([], { discovered, shown: [{ modelId: best, lifecycle: retired }] });
    const after = await fixture({ config: going.config, detection: { env: { OPENROUTER_API_KEY: "sk-or-v1-x" }, fetch: running } });
    const second = (await after.call({ action: "connect-detected", preset: "openrouter", variable: "OPENROUTER_API_KEY" })) as unknown as {
      suggested: { main?: string };
    };
    expect(second.suggested.main).toBeDefined();
    expect(second.suggested.main).not.toBe(best);
  });

  it("stores the found key, then adds and discovers the connection, answering no key", async () => {
    const { calls, config: writes } = config();
    const { call, repositories } = await fixture({
      config: writes,
      detection: { env: { OPENROUTER_API_KEY: "sk-or-v1-planted" }, fetch: running },
    });
    const answer = await call({ action: "connect-detected", preset: "openrouter", variable: "OPENROUTER_API_KEY" });
    expect(answer).toMatchObject({ connectionId: "openrouter", models: ["qwen3:8b", "nomic-embed-text"] });
    expect(JSON.stringify(answer)).not.toContain("planted");
    // The connection at the preset's endpoint first, then its key: the key is bound before it is stored.
    expect(calls.map((entry) => `${entry.command}:${String(entry.payload["action"])}`)).toEqual([
      "models:list",
      "credentials:list",
      "models:add",
      "credentials:set",
      "models:discover",
      "models:show",
    ]);
    expect(calls[3]?.payload).toEqual({ action: "set", reference: "openrouter", value: "sk-or-v1-planted" });
    expect(calls[2]?.payload).toMatchObject({
      connectionId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      credentialRef: "openrouter",
      localOnly: false,
    });
    expect((await repositories.onboarding.steps("default")).find((step) => step.kind === "model")?.createdRef).toBe("openrouter");
  });

  it("writes the keyless placeholder for a running local server, and suggests a tool-capable model", async () => {
    const { calls, config: writes } = config();
    const { call } = await fixture({ config: writes, detection: { env: {}, fetch: running } });
    expect(await call({ action: "connect-detected", preset: "ollama" })).toMatchObject({
      connectionId: "ollama",
      suggested: { main: "qwen3:8b" },
    });
    expect(calls.find((entry) => entry.payload["action"] === "set")?.payload).toEqual({
      action: "set",
      reference: "ollama",
      value: "local-no-key",
    });
  });

  it.each(["ollama", "lmstudio"] as const)("writes %s's keyless placeholder, local only", async (preset) => {
    const { calls, config: writes } = config();
    const { call } = await fixture({ config: writes, detection: { env: {}, fetch: running } });
    expect(await call({ action: "connect-detected", preset })).toMatchObject({ connectionId: preset });
    expect(calls.find((entry) => entry.payload["action"] === "set")?.payload).toEqual({
      action: "set",
      reference: preset,
      value: "local-no-key",
    });
    expect(calls.find((entry) => entry.payload["action"] === "add")?.payload).toMatchObject({ localOnly: true });
  });

  it("never logs or answers a planted key, writes only its own tables, and starts no turn (invariants 1, 4, 5)", async () => {
    const planted = "sk-or-v1-planted-audit-0001";
    const { calls, config: writes } = config();
    const { deps, repositories } = await fixture({ config: writes, detection: { env: { OPENROUTER_API_KEY: planted }, fetch: running } });
    const families = new Set<string>();
    const watched = {
      ...deps,
      repositories: new Proxy(repositories, {
        get: (target, family, receiver) => {
          families.add(String(family));
          return Reflect.get(target, family, receiver);
        },
      }),
    };
    const printed: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      }),
    );
    try {
      const answers = [];
      for (const payload of [
        { action: "detect" },
        { action: "connect-detected", preset: "openrouter", variable: "OPENROUTER_API_KEY" },
        { action: "connect-key", preset: "openrouter", key: planted },
        { action: "status", workspaceId: "default" },
        { action: "skip", workspaceId: "default", step: "search" },
        { action: "reset", workspaceId: "default" },
      ] as OnboardingPayload[])
        answers.push(await onboardingCommand(watched, payload));
      expect(JSON.stringify(answers)).not.toContain(planted);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(printed.join("\n")).not.toContain(planted);
    expect([...families].filter((family) => family !== "onboarding" && family !== "then")).toEqual([]);
    // Its model writes are the models command's, and none of them is a chat or a run.
    expect(
      calls.map((entry) => `${entry.command}:${String(entry.payload["action"])}`).filter((call) => /chat|run|send/.test(call)),
    ).toEqual([]);
  });

  it("rebinds only the connection this flow created; another of the preset's name gets a suffix", async () => {
    const first = config(["openrouter"]);
    const someone = await fixture({ config: first.config, detection: { env: { OPENROUTER_API_KEY: "k" }, fetch: running } });
    expect(await someone.call({ action: "connect-detected", preset: "openrouter", variable: "OPENROUTER_API_KEY" })).toMatchObject({
      connectionId: "openrouter-2",
    });
    expect(first.calls.map((entry) => String(entry.payload["action"]))).toContain("add");

    const second = config(["openrouter"]);
    const ours = await fixture({ config: second.config, detection: { env: { OPENROUTER_API_KEY: "k" }, fetch: running } });
    await ours.repositories.onboarding.recordCreated({
      workspaceId: "default",
      kind: "model",
      createdRef: "openrouter",
      now: NOW.toISOString(),
    });
    expect(await ours.call({ action: "connect-detected", preset: "openrouter", variable: "OPENROUTER_API_KEY" })).toMatchObject({
      connectionId: "openrouter",
    });
    expect(second.calls.map((entry) => String(entry.payload["action"]))).toEqual(["list", "list", "rebind", "set", "discover", "show"]);
  });

  it("never rebinds its own connection once it points elsewhere, nor overwrites a key stored under the preset's name", async () => {
    const moved = config(["openrouter"], { baseUrl: "https://attacker.example/v1" });
    const ours = await fixture({ config: moved.config, detection: { env: { OPENROUTER_API_KEY: "k" }, fetch: running } });
    await ours.repositories.onboarding.recordCreated({
      workspaceId: "default",
      kind: "model",
      createdRef: "openrouter",
      now: NOW.toISOString(),
    });
    expect(await ours.call({ action: "connect-detected", preset: "openrouter", variable: "OPENROUTER_API_KEY" })).toMatchObject({
      connectionId: "openrouter-2",
    });
    expect(moved.calls.some((entry) => entry.payload["action"] === "rebind")).toBe(false);
    const keyed = config([], { stored: ["openrouter"] });
    const someone = await fixture({ config: keyed.config, detection: { env: { OPENROUTER_API_KEY: "k" }, fetch: running } });
    expect(await someone.call({ action: "connect-detected", preset: "openrouter", variable: "OPENROUTER_API_KEY" })).toMatchObject({
      connectionId: "openrouter-2",
    });
    expect(keyed.calls.find((entry) => entry.payload["action"] === "set")?.payload["reference"]).toBe("openrouter-2");
  });

  it("refuses a variable outside the allowlist or not set, and a local server that is not running", async () => {
    const { config: writes } = config();
    const refused: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const { refusal } = await fixture({ config: writes, detection: { env: { OPENAI_API_KEY: "" }, fetch: refused } });
    expect(await refusal({ action: "connect-detected", preset: "openrouter", variable: "OPENAI_API_KEY" })).toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await refusal({ action: "connect-detected", preset: "openai", variable: "OPENAI_API_KEY" })).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await refusal({ action: "connect-detected", preset: "ollama" })).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal({ action: "connect-detected", preset: "openai" })).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("connects a typed key the same way, answering no key, and a custom endpoint only as plain HTTP(S)", async () => {
    const { calls, config: writes } = config();
    const { call, refusal } = await fixture({ config: writes });
    const answer = await call({ action: "connect-key", preset: "openai", key: "sk-typed-welcome" });
    expect(answer).toMatchObject({ connectionId: "openai" });
    expect(JSON.stringify(answer)).not.toContain("sk-typed");
    expect(calls.map((entry) => `${entry.command}:${String(entry.payload["action"])}`)).toEqual([
      "models:list",
      "credentials:list",
      "models:add",
      "credentials:set",
      "models:discover",
      "models:show",
    ]);
    expect(calls[3]?.payload).toEqual({ action: "set", reference: "openai", value: "sk-typed-welcome" });

    expect(await call({ action: "connect-key", preset: "custom", key: "k", baseUrl: "https://llm.example.test/v1" })).toMatchObject({
      connectionId: "custom",
    });
    expect(calls.filter((entry) => entry.payload["action"] === "add").at(-1)?.payload).toMatchObject({
      connectionId: "custom",
      baseUrl: "https://llm.example.test/v1",
    });
    expect(await refusal({ action: "connect-key", preset: "custom", key: "k" })).toMatchObject({ code: "INVALID_INPUT" });
    expect(await refusal({ action: "connect-key", preset: "openai", key: "k", baseUrl: "https://elsewhere.example/v1" })).toMatchObject({
      code: "INVALID_INPUT",
    });
    for (const baseUrl of ["https://user:pass@llm.example.test/v1", "https://llm.example.test/v1?x=1", "ftp://llm.example.test/v1"]) {
      expect(await refusal({ action: "connect-key", preset: "custom", key: "k", baseUrl })).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(await refusal({ action: "connect-key", preset: "nope", key: "k" })).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("stores a ChatGPT sign-in only in an encrypted store, on the Responses wire, and only a whole token record", async () => {
    const credential = JSON.stringify({
      kind: "chatgpt-sign-in",
      issuer: "https://auth.openai.com",
      subject: "user-1",
      client_id: "oaiapp_1",
      ext_agent_host_id: "urn:uuid:11111111-1111-4111-8111-111111111111",
      id_token: "a.b.c",
      access_token: "access",
      refresh_token: "refresh",
      token_type: "Bearer",
      expires_at: "2026-10-20T11:00:00.000Z",
      scopes: ["chatgpt.tokens.use.direct"],
      saved_at: "2026-10-20T10:00:00.000Z",
    });
    const plain = await fixture({ config: config().config, chatGpt: { encrypted: () => false } });
    expect(await plain.refusal({ action: "connect-signed-in", preset: "chatgpt", credential })).toMatchObject({
      code: "NOT_CONFIGURED",
      message: expect.stringContaining("tavi credentials encrypt"),
    });
    const { calls, config: writes } = config();
    const encrypted = await fixture({ config: writes, chatGpt: { encrypted: () => true } });
    expect(await encrypted.refusal({ action: "connect-signed-in", preset: "chatgpt", credential: "sk-not-a-record" })).toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await encrypted.call({ action: "connect-signed-in", preset: "chatgpt", credential })).toMatchObject({ connectionId: "chatgpt" });
    expect(calls.find((entry) => entry.payload["action"] === "add")?.payload).toMatchObject({
      connectionId: "chatgpt",
      baseUrl: "https://api.openai.com/v1",
      wireApi: "responses",
      credentialRef: "chatgpt",
    });
    expect(calls.find((entry) => entry.payload["action"] === "set")?.payload).toMatchObject({ reference: "chatgpt", value: credential });
    const none = await fixture({ config: writes });
    // No ChatGPT handler: its preview is off, and the refusal names the flag; the status offers no tile.
    expect(await none.refusal({ action: "sign-in", preset: "chatgpt" })).toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("TAVI_PREVIEW_CHATGPT=1"),
    });
    expect(await none.refusal({ action: "connect-signed-in", preset: "chatgpt", credential })).toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("TAVI_PREVIEW_CHATGPT=1"),
    });
    expect(await none.call({ action: "status" })).not.toHaveProperty("chatGptSignIn");
    expect(await encrypted.call({ action: "status" })).toMatchObject({ chatGptSignIn: true });
    expect(await none.refusal({ action: "sign-in", preset: "openrouter" })).toMatchObject({ code: "UNSUPPORTED" });
  });

  it("starts the canvas's ChatGPT sign-in on the owner's loopback, for the kept account when there is one, and reads its status", async () => {
    const kept = { kind: "chatgpt-sign-in", client_id: "oaiapp_1", subject: "user-1" };
    const seen: unknown[] = [];
    const signIns = {
      start: async (_onCredential: unknown, returning?: unknown) => {
        seen.push(returning);
        return { url: "https://auth.openai.com/api/accounts/authorize?state=s1", state: "s".repeat(32) };
      },
      owns: (state: string) => state === "s".repeat(32),
      status: () => ({ state: "waiting" as const }),
    };
    const { call, refusal } = await fixture({
      config: config().config,
      chatGpt: { signIns: signIns as never, encrypted: () => true, kept: async () => kept as never },
    });
    expect(await call({ action: "sign-in", preset: "chatgpt" })).toEqual({
      url: "https://auth.openai.com/api/accounts/authorize?state=s1",
      state: "s".repeat(32),
    });
    expect(seen).toEqual([kept]);
    expect(await call({ action: "sign-in-status", state: "s".repeat(32) })).toEqual({ state: "waiting" });
    const plain = await fixture({ config: config().config, chatGpt: { signIns: signIns as never, encrypted: () => false } });
    expect(await plain.refusal({ action: "sign-in", preset: "chatgpt" })).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(await refusal({ action: "sign-in", preset: "openrouter" })).toMatchObject({ code: "UNSUPPORTED" });
  });

  it("refuses connect-key where no model config can be written", async () => {
    const { refusal } = await fixture();
    expect(await refusal({ action: "connect-key", preset: "openai", key: "k" })).toMatchObject({ code: "UNSUPPORTED" });
  });
});
