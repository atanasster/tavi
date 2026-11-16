import type { FetchLike } from "@modelcontextprotocol/client";
import {
  TaviError,
  comparePluginVersions,
  mcpServerAllowed,
  mcpSlugOf,
  type ConfinementPort,
  type AnalyzerCaller,
  type McpBlock,
  type McpToolDefinition,
  type ResourceLimitPort,
  type SandboxHostPort,
  type McpNoticeKind,
  type ToolRule,
  type WorkspaceSettings,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { readPluginManifest, type PluginRegistry, type ToolRegistry } from "@tavi/runtime";

import { endpointFor, serverHasEgress, type McpActionContext } from "./actions.js";
import { McpBridge, type McpBridgeOptions } from "./bridge.js";
import { guardedFetch } from "./fetch.js";
import { McpLogins, McpOAuthTokens, type McpGrantStore, type McpRevocation } from "./oauth-provider.js";
import { checkDrift, type McpDrift } from "./drift.js";
import { noticeWords, raiseMcpNotice, type McpNoticeDeliveryDeps } from "./notices.js";
import { McpServerLog } from "./logs.js";
import { credentialsEncrypted } from "../credentials/store.js";
import { presetOf } from "./presets/index.js";
import {
  McpSupervisor,
  SUPERVISOR_DEFAULTS,
  reapOrphans,
  type McpServerSpec,
  type McpSupervisorEvent,
  type McpSupervisorOptions,
} from "./supervisor.js";

/**
 * The owner's MCP host: the supervisor, fed
 * from the plugin and MCP records, its log, and the `failed` notice. A
 * server runs only while its plugin is enabled at an approved version whose
 * MCP record was approved too; anything else is not started.
 */

type AsyncMcpRepository = McpActionContext["mcp"];

/** A server in use has its tools listed again at least this often. */
export const DRIFT_INTERVAL_MS = 15 * 60 * 1000;

/** After a server's `tools/list_changed`, the least time between two checks it starts: a minute. */
const LIST_CHANGED_GAP_MS = 60 * 1000;
/** How long a `tools/list_changed` waits for the rest of its burst before its check starts. */
const LIST_CHANGED_DEBOUNCE_MS = 1_000;

/**
 * When a server's tools are listed again: on each connect, and
 * at least every 15 minutes while it is in use — a call past the interval
 * since the last check starts one — by the owner's clock; one check per
 * server at a time, never inside the event that asked for it.
 *
 * A server's `notifications/tools/list_changed` starts one too, debounced
 * (a burst is one check: the first notification arms it a second ahead, the
 * rest join it) and
 * rate-limited (at most one a minute, counted from the last check of any
 * kind): a notification inside the minute arms one check for when the minute
 * is up, and every further one before then joins it. So a server that
 * announces a change on every listing, or without end, is listed once a
 * minute at most and can never loop the owner; a change it announced is
 * still listed within the minute.
 */
export function driftScheduler(options: {
  readonly now: () => number;
  readonly check: (pluginId: string) => Promise<void>;
  readonly interval?: number;
  /** The least time between two checks a `tools/list_changed` starts. */
  readonly listChangedGap?: number;
  /** How long a `tools/list_changed` waits for the rest of its burst. */
  readonly listChangedDebounce?: number;
  /** Runs `run` after `ms` (tests replace it); an unref'd `setTimeout` by default. */
  readonly later?: (run: () => void, ms: number) => void;
}): (event: McpSupervisorEvent) => void {
  const checking = new Set<string>();
  const lastChecked = new Map<string, number>();
  /** Servers with a `list_changed` check armed: further notifications join it. */
  const armed = new Set<string>();
  const gap = options.listChangedGap ?? LIST_CHANGED_GAP_MS;
  const debounce = options.listChangedDebounce ?? LIST_CHANGED_DEBOUNCE_MS;
  const later =
    options.later ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms).unref();
    });
  const schedule = (pluginId: string): void => {
    if (checking.has(pluginId)) return;
    checking.add(pluginId);
    lastChecked.set(pluginId, options.now());
    setImmediate(() => {
      void options.check(pluginId).finally(() => checking.delete(pluginId));
    });
  };
  /** The armed check's turn: now when a minute has passed since the last check and none runs, else at the minute. */
  const due = (pluginId: string): void => {
    const since = options.now() - (lastChecked.get(pluginId) ?? Number.NEGATIVE_INFINITY);
    if (!checking.has(pluginId) && since >= gap) {
      armed.delete(pluginId);
      schedule(pluginId);
      return;
    }
    // A check running, or one too recent: once more when the minute is up (at least the debounce from now).
    later(() => due(pluginId), Math.max(debounce, gap - since));
  };
  const announced = (pluginId: string): void => {
    if (armed.has(pluginId)) return;
    armed.add(pluginId);
    later(() => due(pluginId), debounce);
  };
  return (event) => {
    if (event.kind === "client" && event.event.kind === "connect") schedule(event.pluginId);
    else if (event.kind === "client" && event.event.kind === "tools-changed") announced(event.pluginId);
    else if (event.kind === "call" && options.now() - (lastChecked.get(event.pluginId) ?? 0) >= (options.interval ?? DRIFT_INTERVAL_MS))
      schedule(event.pluginId);
  };
}

export interface McpHostOptions {
  /** A server signed in (a login finished): the tasks waiting for it go on. */
  readonly onSignedIn?: (pluginId: string) => Promise<void>;
  /** Whether a server's account is Personal: its tools then reach only the operator's own chats. */
  readonly personal?: McpBridgeOptions["personal"];
  readonly registry: PluginRegistry;
  readonly mcp: AsyncMcpRepository;
  readonly dataDirectory: string;
  readonly resolveSecret: (reference: string) => Promise<string | null>;
  readonly now: () => string;
  /** What a sandboxed server is wrapped in; the owner's by default. */
  readonly confinement?: ConfinementPort;
  /** The owner's host detection: one cached answer for every server start. */
  readonly sandboxHost?: SandboxHostPort;
  /** Each server in a cgroup of its own. */
  readonly limits?: ResourceLimitPort;
  readonly log?: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  /** The registry MCP tools are registered in, and what the bridge reads to offer them. */
  readonly tools: ToolRegistry;
  readonly workspaceSettings: (workspaceId: string) => Promise<WorkspaceSettings>;
  readonly allWorkspaceSettings: () => Promise<readonly { readonly workspaceId: string; readonly settings: WorkspaceSettings }[]>;
  readonly operatorOf: (workspaceId: string) => string | undefined;
  /** How a notice reaches the operator (Home, channels); absent, notices wait in Center only. */
  readonly delivery?: Omit<McpNoticeDeliveryDeps, "mcp" | "now" | "log" | "workspacesOf" | "operatorOf">;
  /** The owner's `mcp.enabled`, read whenever a server would start or register. */
  readonly enabled: () => Promise<boolean>;
  /** The operator's line for a server in `tools.search`'s description. */
  readonly searchLine?: (pluginId: string) => Promise<string | undefined>;
  /** Where OAuth grants are kept: the credential store, one write at a time. */
  readonly grants: McpGrantStore;
  /** The owner's public address as its settings name it (CIMD, a public login redirect). */
  readonly publicUrl: () => Promise<string | undefined>;
  /** A public login waits: the public listener opens (or stays open) for its callback. */
  readonly awaitingPublic?: () => Promise<void>;
  /** A sign-in was forgotten (a logout, a removal): the public listener checks whether anything still needs it. */
  readonly publicMayClose?: () => Promise<void>;
  /** What drift needs beyond the host's own. */
  readonly deleteSessionGrants: (toolIds: readonly string[]) => Promise<number>;
  readonly rules: () => Promise<readonly ToolRule[]>;
  /** Where a call's image is stored for a model that reads images; absent, images are noted only. */
  readonly storeImage?: McpBridgeOptions["storeImage"];
  /** Where a call's progress is shown. */
  readonly progress?: McpBridgeOptions["progress"];
  /** Whether a task is still open, so a call held on its question is released when it ends. */
  readonly taskOpen?: McpBridgeOptions["taskOpen"];
  /** Supervisor tuning (tests). */
  readonly supervisor?: Partial<Omit<McpSupervisorOptions, "spec" | "dataDirectory" | "onFailed" | "onEra">>;
  /** A server's video analyser exchange directory, when `analyzers.json` names it. */
  readonly analyzerExchange?: McpActionContext["analyzerExchange"];
}

/**
 * A server's tool as the video host uses it as an analyser:
 * approved now, at its server's active
 * approved version, with the definition approved and whether its server can
 * reach the network (`serverHasEgress`), which makes the analyser remote
 * whatever its manifest says.
 */
export interface McpAnalyzerTool {
  readonly pluginId: string;
  readonly version: string;
  readonly name: string;
  readonly definition: McpToolDefinition;
  readonly definitionHash: string;
  readonly transport: "stdio" | "http";
  readonly egress: boolean;
}

/** A video analyser's call to its tool: its answer, or why there is none, in Tavi's words. */
type McpAnalyzerCallAnswer =
  | { readonly ok: true; readonly content: unknown; readonly text?: string; readonly structured?: true }
  | { readonly ok: false; readonly code: "unavailable" | "crashed" | "timeout"; readonly message: string };

export interface McpHost {
  readonly supervisor: McpSupervisor;
  readonly bridge: McpBridge;
  readonly log: McpServerLog;
  /**
   * `pluginChanged`: after an enable, disable, removal,
   * version switch or review, the server stops (its next call starts it
   * afresh) and its tools are registered again as approved now.
   */
  changed(pluginId: string): Promise<void>;
  /**
   * The budget checked over every workspace: a `budget` notice raised for each server listed where its tools
   * do not fit, and closed for one that fits again.
   */
  checkBudget(): Promise<void>;
  /** At owner start: every server's tools, and a `budget` notice for each workspace over its budget. */
  start(): Promise<void>;
  /**
   * Refuses an enable that would overflow the workspace's tool budget, naming the count; `alsoAllowed` are
   * servers allowed in the same change, counted with it.
   */
  checkEnable(pluginId: string, version: string | undefined, workspaceId: string, alsoAllowed?: readonly string[]): Promise<void>;
  /**
   * `tavi mcp on|off` on a running owner: off stops every
   * server and withdraws every tool at once; on registers them again.
   */
  switched(on: boolean): Promise<void>;
  /** Lists one server's tools afresh and applies drift; also run on each connect and every 15 minutes in use. */
  checkDrift(pluginId: string): Promise<McpDrift | undefined>;
  /** Raises (or updates) a server notice and tells the operator. */
  raise(pluginId: string, kind: McpNoticeKind, detail: Readonly<Record<string, unknown>>): Promise<void>;
  /** OAuth: run-time tokens, the operator's logins, and a logout that revokes through the server's own fetch. */
  readonly oauth: {
    readonly tokens: McpOAuthTokens;
    readonly logins: McpLogins;
    /** `upstream: false`: forgotten here only, the provider's grant left for another app of it. */
    logout(pluginId: string, options?: { readonly upstream?: boolean }): Promise<McpRevocation>;
    /** Revokes and deletes a server's grant through a fetch with `lan` as given: its removal's, read before its files went. */
    /** `upstream: false`: forgotten here only, another app keeping the provider's grant. */
    revoke(pluginId: string, lan: boolean, options?: { readonly upstream?: boolean }): Promise<McpRevocation>;
    /** Whether any server's sign-in names Tavi by its public CIMD document, so the public listener stays open. */
    publicClientInUse(): Promise<boolean>;
  };
  /** A server's tool as a video analyser, or why it cannot be one. */
  analyzerTool(pluginId: string, name: string): Promise<McpAnalyzerTool | { readonly missing: string }>;
  /**
   * Calls a video analyser's tool, when it is still approved as `tool` was
   * when the chain was built: the same definition, at the same reach, and
   * only for a caller the server's tools are offered to (the workspace's
   * `mcp.servers`, `mcp.people`, a Personal account's household rule), as
   * any MCP tool call is. One revoked, drifted or moved to another version
   * since, or a call that names no caller, is `unavailable`.
   */
  callAnalyzer(
    tool: McpAnalyzerTool,
    args: Readonly<Record<string, unknown>>,
    options: { readonly signal: AbortSignal; readonly timeoutMs: number; readonly caller?: AnalyzerCaller },
  ): Promise<McpAnalyzerCallAnswer>;
  /** Kills what an earlier owner left running (call only while holding the owner lock). */
  reap(): Promise<number>;
  shutdown(): Promise<void>;
}

export function createMcpHost(options: McpHostOptions): McpHost {
  /** Credential values each server was given, masked in its log. */
  const secrets = new Map<string, readonly string[]>();
  const log = new McpServerLog(options.dataDirectory, (pluginId) => secrets.get(pluginId) ?? []);
  // Each server's guarded fetch follows its own `lan`, read when its manifest is.
  const lan = new Map<string, boolean>();
  const fetchFor = (pluginId: string): FetchLike => guardedFetch({ lan: lan.get(pluginId) === true });
  const tokens = new McpOAuthTokens({ store: options.grants, fetchFor });
  /** The server needs its operator to sign in: its calls fail fast, and a `login` notice names the cause (Tavi's words). */
  const needsLogin = async (pluginId: string, cause: string): Promise<void> => {
    supervisor.loginRequired(pluginId, cause);
    await raise(pluginId, "login", { cause });
  };
  const oauthToken = async (pluginId: string): Promise<string> => {
    try {
      return await tokens.accessToken(pluginId);
    } catch (error) {
      if (error instanceof TaviError && error.details?.["mcpFailure"] === "login")
        await needsLogin(pluginId, String(error.details["cause"] ?? "it is not signed in"));
      throw error;
    }
  };
  const context: McpActionContext = {
    registry: options.registry,
    mcp: options.mcp,
    dataDirectory: options.dataDirectory,
    resolveSecret: options.resolveSecret,
    now: options.now,
    oauthToken,
    ...definedOnly({
      confinement: options.confinement,
      sandboxHost: options.sandboxHost,
      limits: options.limits,
      analyzerExchange: options.analyzerExchange,
    }),
  };
  const spec = async (pluginId: string): Promise<McpServerSpec | undefined> => {
    // Off, nothing starts (the kill switch).
    if (mcpSlugOf(pluginId) === undefined || !(await options.enabled())) return undefined;
    const view = (await options.registry.list()).find((candidate) => candidate.id === pluginId);
    if (view === undefined || view.kind !== "mcp" || !view.enabled || view.activeVersion === undefined) return undefined;
    const version = view.versions.find((candidate) => candidate.version === view.activeVersion);
    if (version?.reviewState !== "approved") return undefined;
    const record = await options.mcp.getVersion(pluginId, version.version);
    if (record?.approvedAt === undefined) return undefined;
    const manifest = readPluginManifest(options.registry.snapshotDirectory(pluginId, version.version));
    const block = manifest.mcp as McpBlock;
    lan.set(pluginId, block.network?.lan === true);
    return {
      pluginId,
      version: version.version,
      transport: block.transport,
      maxMessageBytes: block.maxMessageBytes,
      concurrency: block.concurrency,
      ...(record.eraPrior === undefined ? {} : { prior: record.eraPrior as NonNullable<McpServerSpec["prior"]> }),
      endpoint: async () => {
        // Every value the server was given is masked in its log, a rotated token's included.
        const remember = (given: readonly string[]): void =>
          void secrets.set(pluginId, [...new Set([...(secrets.get(pluginId) ?? []), ...given])]);
        const opened = await endpointFor(manifest, view, record, context, remember);
        remember(opened.secrets);
        return opened.endpoint;
      },
    };
  };
  /** Whose operator hears of a server: the workspaces that allow it, else the one it was added from. */
  const workspacesOf = async (pluginId: string): Promise<readonly string[]> => {
    const allowing = (await options.allWorkspaceSettings())
      .filter(({ settings }) => mcpServerAllowed(settings, pluginId))
      .map(({ workspaceId }) => workspaceId);
    if (allowing.length > 0) return allowing;
    const added = (await options.mcp.listVersions(pluginId))
      .map((record) => record.addedFromWorkspace)
      .find((workspaceId) => workspaceId !== undefined);
    return [added ?? "default"];
  };
  const raise = async (pluginId: string, kind: McpNoticeKind, detail: Readonly<Record<string, unknown>>): Promise<void> => {
    // A drift folds into the open one: what an earlier listing withheld stays named until it is decided.
    const open =
      kind === "drift" ? (await options.mcp.listNotices({ pluginId, open: true })).find((notice) => notice.kind === "drift") : undefined;
    const merged =
      open === undefined
        ? detail
        : {
            ...detail,
            ...Object.fromEntries(
              ["withheld", "added", "removed", "rules"].map((key) => [
                key,
                [
                  ...new Set([
                    ...((open.detail[key] as readonly string[] | undefined) ?? []),
                    ...((detail[key] as readonly string[] | undefined) ?? []),
                  ]),
                ],
              ]),
            ),
            ...(open.detail["instructions"] === true || detail["instructions"] === true ? { instructions: true } : {}),
          };
    const deps: McpNoticeDeliveryDeps = {
      mcp: options.mcp,
      now: options.now,
      workspacesOf,
      operatorOf: options.operatorOf,
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.delivery ?? {
        homeOf: async () => undefined,
        postNotice: async () => undefined,
        targets: async () => [],
        boundTo: async () => undefined,
        isLocalConnection: () => true,
        send: async () => undefined,
      }),
    };
    await raiseMcpNotice(deps, { pluginId, kind, detail: merged });
    // In the server's own log too (drift and login events), in the notice's words — Tavi's, never the server's.
    await log.write(pluginId, `notice ${kind}: ${noticeWords({ pluginId, kind, detail }).summary}`);
  };
  const supervisor = new McpSupervisor({
    ...options.supervisor,
    dataDirectory: options.dataDirectory,
    spec,
    // Tavi's own words only: the server's reason stays in its log.
    onFailed: async (pluginId) => {
      await raise(pluginId, "failed", { failures: options.supervisor?.failuresToFail ?? SUPERVISOR_DEFAULTS.failuresToFail });
      options.log?.("mcp server failed", { pluginId });
    },
    onEra: async (pluginId, version, prior) => {
      const record = await options.mcp.getVersion(pluginId, version);
      if (record !== undefined) await options.mcp.putVersion({ ...record, eraPrior: prior });
    },
  });
  log.follow(supervisor);
  const logins = new McpLogins({
    tokens,
    fetchFor,
    publicUrl: options.publicUrl,
    encrypted: () => credentialsEncrypted(options.dataDirectory),
    takenBy: async (pluginId, identity) => {
      // The same server is the same preset, or the same address: its other instances' accounts.
      const serverOf = (view: Awaited<ReturnType<typeof options.registry.list>>[number]): string | undefined => {
        const version = view.activeVersion ?? view.versions.at(-1)?.version;
        if (view.kind !== "mcp" || version === undefined) return undefined;
        const block = readPluginManifest(options.registry.snapshotDirectory(view.id, version)).mcp as McpBlock | undefined;
        if (block?.preset !== undefined) return `preset:${block.preset}`;
        const url = block?.url === undefined ? undefined : "value" in block.url ? block.url.value : view.config[block.url.setting];
        return typeof url === "string" ? `url:${url}` : undefined;
      };
      const views = await options.registry.list();
      const mine = views.find((view) => view.id === pluginId);
      const server = mine === undefined ? undefined : serverOf(mine);
      if (server === undefined) return undefined;
      for (const view of views) {
        if (view.id === pluginId || serverOf(view) !== server) continue;
        if ((await tokens.grant(view.id))?.identity === identity) return view.id;
      }
      return undefined;
    },
    ...(options.awaitingPublic === undefined ? {} : { awaitingPublic: options.awaitingPublic }),
    server: async (pluginId) => {
      const view = (await options.registry.list()).find((candidate) => candidate.id === pluginId);
      const version = view?.activeVersion ?? view?.versions.at(-1)?.version;
      if (view === undefined || view.kind !== "mcp" || version === undefined) throw new TaviError("NOT_FOUND", `no MCP server ${pluginId}`);
      const block = readPluginManifest(options.registry.snapshotDirectory(pluginId, version)).mcp as McpBlock;
      if (block.auth !== "oauth" || block.url === undefined)
        throw new TaviError("INVALID_INPUT", `${pluginId} does not sign in with OAuth`);
      lan.set(pluginId, block.network?.lan === true);
      const url = "value" in block.url ? block.url.value : view.config[block.url.setting];
      if (typeof url !== "string") throw new TaviError("NOT_CONFIGURED", `${pluginId} needs its url setting first`);
      const ownId = view.config["clientId"];
      const secretReference = view.config["clientSecret"];
      const ownSecret = typeof secretReference === "string" ? await options.resolveSecret(secretReference) : null;
      const preset = presetOf(block.preset);
      const login = preset?.login;
      // A client registered at the server, when one is set; else the login registers one (or asks).
      const clientId = typeof ownId === "string" && ownId !== "" ? ownId : undefined;
      const clientSecret = clientId === undefined || ownSecret === null ? undefined : ownSecret;
      return {
        url,
        ...(clientId === undefined ? {} : { clientId }),
        ...(clientSecret === undefined ? {} : { clientSecret }),
        ...(login?.authorizeParams === undefined ? {} : { authorizeParams: login.authorizeParams }),
        ...(login?.scope === undefined ? {} : { scope: login.scope }),
        ...(preset?.app?.auth?.kind === "oauth" && preset.app.auth.identity !== undefined ? { identity: preset.app.auth.identity } : {}),
      };
    },
    signedIn: async (pluginId) => {
      // Signed in: it starts afresh with its token, and its login notice is done; its tools name the account again.
      await supervisor.stop(pluginId);
      await bridge.reconcile(pluginId);
      for (const notice of await options.mcp.listNotices({ pluginId, open: true })) {
        if (notice.kind === "login" || notice.kind === "scope") await options.mcp.decideNotice(notice.noticeId, "operator", options.now());
      }
      await options.onSignedIn?.(pluginId);
    },
  });
  const bridge = new McpBridge({
    registry: options.registry,
    mcp: options.mcp,
    tools: options.tools,
    supervisor,
    workspaceSettings: options.workspaceSettings,
    allWorkspaceSettings: options.allWorkspaceSettings,
    operatorOf: options.operatorOf,
    now: options.now,
    ...(options.log === undefined ? {} : { log: options.log }),
    enabled: options.enabled,
    ...definedOnly({
      searchLine: options.searchLine,
      storeImage: options.storeImage,
      progress: options.progress,
      taskOpen: options.taskOpen,
      personal: options.personal,
    }),
    // The account a server signed in as names its tools, so the model can tell two apart.
    identityOf: async (pluginId) => (await tokens.grant(pluginId))?.identity,
    // A refused token on an OAuth server is a login to make; a refused scope, a notice (never a login started by itself).
    onAuthFailure: async (pluginId, status, insufficientScope, requiredScope) => {
      // Only an OAuth server's refusal is a login or a scope to grant; a header-authenticated one's is its token setting's.
      if (!(await tokens.signedIn(pluginId))) return;
      // A scope to grant only when the server says so (RFC 6750 `insufficient_scope`). A refused token (401) is a login
      // to make, its tools failing fast meanwhile; a bare 403 raises the login notice but stops nothing, since signing in
      // again may not be what it wants.
      if (insufficientScope) {
        if (requiredScope !== undefined) await tokens.noteWantedScope(pluginId, requiredScope);
        await raise(pluginId, "scope", {});
        return false;
      }
      if (status === 401) {
        await needsLogin(pluginId, "the server refused its token (HTTP 401)");
        // A login to make: the call that met it is a lapsed sign-in's, its card and its wait.
        return true;
      }
      if (status === 403) await raise(pluginId, "login", { cause: "the server refused a call with its sign-in (HTTP 403)" });
      return false;
    },
  });
  /**
   * One open `budget` notice per server over its budget in any workspace, naming them all; one for a server that now
   * fits everywhere is closed, as the operator's change decided it.
   */
  const checkBudget = async (): Promise<void> => {
    const byServer = new Map<string, { workspaceId: string; used: number; limit: number }[]>();
    for (const over of await bridge.overBudget()) {
      for (const pluginId of over.servers)
        byServer.set(pluginId, [...(byServer.get(pluginId) ?? []), { workspaceId: over.workspaceId, used: over.used, limit: over.limit }]);
      options.log?.("mcp tools over budget", { ...over });
    }
    const open = await options.mcp.listNotices({ open: true });
    for (const [pluginId, workspaces] of byServer) {
      // Raised again only when what it says changed: an unchanged one stays where it is in Center.
      const same = open.some(
        (notice) =>
          notice.pluginId === pluginId && notice.kind === "budget" && JSON.stringify(notice.detail) === JSON.stringify({ workspaces }),
      );
      if (!same) await raise(pluginId, "budget", { workspaces });
    }
    for (const notice of open) {
      if (notice.kind === "budget" && !byServer.has(notice.pluginId))
        await options.mcp.decideNotice(notice.noticeId, "operator", options.now());
    }
  };
  const drift = (pluginId: string): Promise<McpDrift | undefined> =>
    checkDrift(
      {
        registry: options.registry,
        mcp: options.mcp,
        supervisor,
        bridge,
        registeredToolIds: () => new Set(options.tools.list().map((tool) => tool.id)),
        deleteSessionGrants: options.deleteSessionGrants,
        rules: options.rules,
        raise: (id, detail) => raise(id, "drift", detail),
      },
      pluginId,
    );
  supervisor.subscribe(
    driftScheduler({
      now: () => Date.parse(options.now()),
      check: async (pluginId) => {
        await drift(pluginId).catch((error: unknown) => options.log?.("mcp drift check failed", { pluginId, error: errorMessage(error) }));
      },
    }),
  );
  const analyzerTool = async (pluginId: string, name: string): Promise<McpAnalyzerTool | { readonly missing: string }> => {
    if (mcpSlugOf(pluginId) === undefined) return { missing: `${pluginId} is not an MCP server's id (mcp.<name>)` };
    if (!(await options.enabled())) return { missing: "MCP is off (tavi mcp on)" };
    const view = (await options.registry.list()).find((candidate) => candidate.id === pluginId);
    if (view === undefined || view.kind !== "mcp") return { missing: `${pluginId} is not installed` };
    if (!view.enabled || view.activeVersion === undefined) return { missing: `${pluginId} is not enabled` };
    const version = view.versions.find((candidate) => candidate.version === view.activeVersion);
    const record = version?.reviewState === "approved" ? await options.mcp.getVersion(pluginId, version.version) : undefined;
    if (version === undefined || record?.approvedAt === undefined) return { missing: `${pluginId}@${view.activeVersion} is not approved` };
    const tool = (await options.mcp.listTools(pluginId, version.version)).find((candidate) => candidate.name === name);
    if (tool === undefined) return { missing: `${pluginId} has no tool ${name}` };
    if (tool.state !== "approved" || tool.decision === undefined || tool.approvedDef === undefined || tool.approvedDefHash === undefined)
      return { missing: `${pluginId}'s ${name} is not approved (${tool.state})` };
    const block = readPluginManifest(options.registry.snapshotDirectory(pluginId, version.version)).mcp as McpBlock;
    return {
      pluginId,
      version: version.version,
      name,
      definition: tool.approvedDef,
      definitionHash: tool.approvedDefHash,
      transport: block.transport,
      egress: serverHasEgress(block, record.sandboxState),
    };
  };
  const callAnalyzer = async (
    tool: McpAnalyzerTool,
    args: Readonly<Record<string, unknown>>,
    callOptions: { readonly signal: AbortSignal; readonly timeoutMs: number; readonly caller?: AnalyzerCaller },
  ): Promise<McpAnalyzerCallAnswer> => {
    const caller = callOptions.caller;
    let now: McpAnalyzerTool | { readonly missing: string };
    try {
      if (caller === undefined) return { ok: false, code: "unavailable", message: "the call names no one it is for" };
      if (!(await bridge.mayUse(tool.pluginId, caller)))
        return { ok: false, code: "unavailable", message: `${tool.pluginId} is not offered to this person in this workspace` };
      now = await analyzerTool(tool.pluginId, tool.name);
    } catch {
      return { ok: false, code: "unavailable", message: `${tool.pluginId}'s tool could not be looked up` };
    }
    if ("missing" in now) return { ok: false, code: "unavailable", message: now.missing };
    if (
      now.version !== tool.version ||
      now.definitionHash !== tool.definitionHash ||
      now.egress !== tool.egress ||
      now.transport !== tool.transport
    ) {
      return {
        ok: false,
        code: "unavailable",
        message: `${tool.pluginId}'s ${tool.name} changed since the analysers were read (another version, definition or reach); restart serve to use it as it is now`,
      };
    }
    try {
      const result = await supervisor.call(tool.pluginId, tool.name, args, {
        signal: callOptions.signal,
        timeoutMs: callOptions.timeoutMs,
      });
      return {
        ok: true,
        content: result.content,
        ...(result.text === undefined ? {} : { text: result.text }),
        ...(result.structured === true ? { structured: true as const } : {}),
      };
    } catch (error) {
      if (callOptions.signal.aborted) return { ok: false, code: "timeout", message: "the call was stopped" };
      const failure = error instanceof TaviError ? error.details?.["mcpFailure"] : undefined;
      // The tool's own error carries the server's words, which may quote the media: only that it failed is said.
      if (failure === "tool") return { ok: false, code: "crashed", message: "the tool answered with an error" };
      // Said in fixed words only: a JSON-RPC error carries the server's message, and a failed or restarting server's
      // reason may quote it, either of which may quote the media.
      if (failure === "failed")
        return { ok: false, code: "unavailable", message: `${tool.pluginId} has failed; probe it again once it is fixed` };
      if (failure === "backing-off") return { ok: false, code: "unavailable", message: `${tool.pluginId} is restarting after a failure` };
      if (failure === "busy") return { ok: false, code: "unavailable", message: `${tool.pluginId} is busy` };
      return { ok: false, code: "unavailable", message: "the server failed the call" };
    }
  };
  return {
    supervisor,
    bridge,
    log,
    analyzerTool,
    callAnalyzer,
    oauth: {
      tokens,
      logins,
      logout: async (pluginId, logoutOptions) => {
        // Its revocation goes through its own guarded fetch: `lan` read from its manifest, whether or not it ran since start.
        const view = (await options.registry.list()).find((candidate) => candidate.id === pluginId);
        const version = view?.activeVersion ?? view?.versions.at(-1)?.version;
        if (version !== undefined)
          lan.set(pluginId, readPluginManifest(options.registry.snapshotDirectory(pluginId, version)).mcp?.network?.lan === true);
        const revocation = await tokens.revoke(pluginId, logoutOptions);
        await supervisor.stop(pluginId);
        // Best effort: the public listener closes on its own check; a failure keeps it as it was, never opens it.
        await options.publicMayClose?.().catch(() => undefined);
        return revocation;
      },
      revoke: async (pluginId, onLan, revokeOptions) => {
        lan.set(pluginId, onLan);
        const revocation = await tokens.revoke(pluginId, revokeOptions);
        // Best effort: the public listener closes on its own check; a failure keeps it as it was, never opens it.
        await options.publicMayClose?.().catch(() => undefined);
        return revocation;
      },
      publicClientInUse: async () => {
        for (const view of await options.registry.list()) {
          if (view.kind === "mcp" && (await tokens.usesClientDocument(view.id).catch(() => false))) return true;
        }
        return false;
      },
    },
    checkDrift: drift,
    raise,
    switched: async (on) => {
      if (on) {
        await bridge.reconcileAll();
        return;
      }
      await bridge.withdrawAll();
      await Promise.all(supervisor.statuses().map((status) => supervisor.stop(status.pluginId)));
    },
    changed: async (pluginId) => {
      await supervisor.stop(pluginId);
      await bridge.reconcile(pluginId);
      await checkBudget();
    },
    checkBudget: () => checkBudget(),
    checkEnable: async (pluginId, version, workspaceId, alsoAllowed = []) => {
      const view = (await options.registry.list()).find((candidate) => candidate.id === pluginId);
      if (view === undefined || view.kind !== "mcp") return;
      // The version the enable picks: the one named, else the newest approved.
      const at =
        version ??
        view.versions
          .filter((candidate) => candidate.reviewState === "approved")
          .map((candidate) => candidate.version)
          .sort(comparePluginVersions)
          .at(-1);
      if (at === undefined) return;
      const manifest = readPluginManifest(options.registry.snapshotDirectory(pluginId, at));
      // Its resource tools are listed with its own.
      const resources =
        ((await options.mcp.getVersion(pluginId, at))?.capabilities as { readonly resources?: unknown } | undefined)?.resources !==
        undefined;
      const tools = (await options.mcp.listTools(pluginId, at)).filter((tool) => tool.state === "approved").length + (resources ? 2 : 0);
      await bridge.checkEnable(workspaceId, pluginId, manifest.mcp as McpBlock, tools, alsoAllowed);
    },
    start: async () => {
      await bridge.reconcileAll();
      // An offline change may have put a workspace over its budget: say so, naming the servers.
      await checkBudget();
    },
    reap: () => reapOrphans(options.dataDirectory, (line) => options.log?.(line)),
    shutdown: () => supervisor.shutdown(),
  };
}
