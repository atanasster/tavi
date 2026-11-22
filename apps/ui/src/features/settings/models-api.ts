import {
  ChatModelSchema,
  lifecycleWarnings,
  MODEL_ROLES,
  worstLifecycleLevel,
  type LifecycleLevel,
  type LifecycleWarning,
  type ModelCatalogEntry,
  type ModelConnection,
  type ModelLifecycle,
  type ModelRoleBinding,
} from "@tavi/contracts";

import { formatTokens } from "../../lib/format.js";
import { translateNow } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { ask, mapOutcome, read, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { restartNote } from "./common.js";
import { loadReplacements, type ModelReplacements } from "./lifecycle-api.js";

/** What `models list` answers per connection. */
export interface ConnectionSummary {
  readonly connectionId: string;
  readonly label: string;
  readonly kind: ModelConnection["kind"];
  readonly baseUrl: string;
  readonly credentialRef: string;
  readonly localOnly: boolean;
  readonly defaultModel: string | null;
  readonly providerBinding?: ModelConnection["providerBinding"];
  /** The models this connection sends whole videos to, each turned on with its disclosure. */
  readonly videoModels?: readonly string[];
}

/** One model the browser shows: a catalog entry, with its connection's label. */
export interface BrowsedModel extends ModelCatalogEntry {
  readonly connectionLabel: string;
  readonly providerManaged?: boolean;
  /** Discovered before the connection last changed. */
  readonly stale: boolean;
  /** What the last lifecycle sync (Rhumb) stored of it; absent when none ran or an older owner. */
  readonly lifecycle?: ModelLifecycle;
}

/** A model's lifecycle today, as a badge says it: its worst level and each warning in words; none when nothing warns. */
export interface LifecycleNotice {
  readonly level: LifecycleLevel;
  /** A badge's word: Retired, Redirected, Retiring, or Notice. */
  readonly label: string;
  readonly text: string;
}

/**
 * One warning as a clause about the model, in the page's language: "retired on
 * 2026-11-19", "will be answered and billed as b on 2026-12-01" — what follows
 * "This model" in the picker, and what the badge's title lists.
 */
export function lifecycleWarningWords(warning: LifecycleWarning): string {
  const date = warning.date;
  const dated = (bare: UiKey, on: UiKey): string => (date === undefined ? translateNow(bare) : translateNow(on, { date }));
  switch (warning.code) {
    case "retired":
      return dated("settings.models.warning.retired", "settings.models.warning.retiredOn");
    case "redirected":
    case "redirects_soon": {
      const to = warning.via === undefined ? warning.to : translateNow("settings.models.warning.via", { to: warning.to, via: warning.via });
      if (warning.code === "redirected")
        return date === undefined
          ? translateNow("settings.models.warning.redirected", { to })
          : translateNow("settings.models.warning.redirectedSince", { to, date });
      return date === undefined
        ? translateNow("settings.models.warning.redirectsSoon", { to })
        : translateNow("settings.models.warning.redirectsSoonOn", { to, date });
    }
    case "retires_soon":
      return dated("settings.models.warning.retires", "settings.models.warning.retiresOn");
    case "end_claimed":
      return warning.days !== undefined && warning.days <= 0
        ? dated("settings.models.warning.mayHaveRetired", "settings.models.warning.mayHaveRetiredOn")
        : dated("settings.models.warning.mayRetire", "settings.models.warning.mayRetireOn");
    case "deprecated":
      return dated("settings.models.warning.deprecated", "settings.models.warning.deprecatedOn");
    case "price_changes":
      return dated("settings.models.warning.priceChanges", "settings.models.warning.priceChangesOn");
  }
}

export function lifecycleNotice(
  model: Pick<BrowsedModel, "lifecycle">,
  today: string = new Date().toISOString().slice(0, 10),
): LifecycleNotice | undefined {
  if (model.lifecycle === undefined) return undefined;
  const warnings = lifecycleWarnings(model.lifecycle, today);
  const level = worstLifecycleLevel(warnings);
  if (level === undefined) return undefined;
  const first = warnings[0]?.code;
  const label = translateNow(
    first === "retired"
      ? "settings.models.lifecycle.retired"
      : first === "redirected"
        ? "settings.models.lifecycle.redirected"
        : first === "redirects_soon"
          ? "settings.models.lifecycle.redirecting"
          : first === "retires_soon"
            ? "settings.models.lifecycle.retiring"
            : "settings.models.lifecycle.notice",
  );
  return { level, label, text: warnings.map(lifecycleWarningWords).join(translateNow("settings.models.warning.separator")) };
}

/**
 * The targets the workspace's default, the owner's running target and the roles name (fallbacks too) whose
 * model warns today: what the Models page's banner lists. A target whose model
 * the catalog does not list has no lifecycle here and is not named.
 */
export function rolesLifecycleNotices(
  data: Pick<ModelsData, "models" | "roles" | "replacements">,
  today?: string,
): readonly { readonly target: string; readonly notice: LifecycleNotice; readonly replacements?: ModelReplacements }[] {
  const targets = [
    ...(data.roles.workspaceDefault === null ? [] : [data.roles.workspaceDefault.target]),
    // With no default saved, what the owner runs for a turn is its own: as much in use.
    ...(data.roles.activeTarget === undefined || data.roles.activeTarget === null ? [] : [data.roles.activeTarget]),
    ...(data.roles.roles ?? []).flatMap((binding) => [binding.target, ...binding.fallback]),
  ];
  const seen = new Set<string>();
  return targets.flatMap((target) => {
    if (target.model === undefined) return [];
    const key = `${target.connectionId}/${target.model}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const model = data.models.find((entry) => entry.connectionId === target.connectionId && entry.modelId === target.model);
    const notice = model === undefined ? undefined : lifecycleNotice(model, today);
    if (notice === undefined || notice.level === "info") return [];
    const replacements = data.replacements?.get(key);
    return [{ target: key, notice, ...(replacements === undefined ? {} : { replacements }) }];
  });
}

export type ModelRole = (typeof MODEL_ROLES)[number];

/** What `models roles` answers, as far as the browser reads it. */
export interface RolesDocument {
  readonly activeTarget?: { readonly connectionId: string; readonly model: string } | null;
  /** What a restart would run (`null`: nothing usable); absent on older owners. */
  readonly restartTarget?: { readonly connectionId: string; readonly model: string } | null;
  /** A restart would run another target than `activeTarget`; absent on older owners. */
  readonly restartRequired?: boolean;
  readonly roles?: readonly ModelRoleBinding[];
  readonly workspaceDefault: { readonly target: { readonly connectionId: string; readonly model?: string } } | null;
  readonly resolved: readonly {
    readonly role: ModelRole;
    readonly source: string | null;
    readonly target?: { readonly connectionId: string; readonly model?: string };
    readonly error?: { readonly code: string; readonly message: string };
  }[];
}

export interface ModelsData {
  readonly connections: readonly ConnectionSummary[];
  readonly models: readonly BrowsedModel[];
  readonly roles: RolesDocument;
  /** Connections whose catalog could not be read: the others are still shown. */
  readonly failures: readonly { readonly connectionId: string; readonly message: string }[];
  /** What the last lifecycle sync suggests in place of a model in use, by `connection/model`; absent from an older owner. */
  readonly replacements?: ReadonlyMap<string, ModelReplacements>;
}

/**
 * The workspace's connections, every connection's catalog, and each role's
 * resolution — the catalogs asked for together, and one that cannot be read
 * (a connection removed meanwhile, say) reported beside the others rather than
 * blanking them.
 */
export async function loadModels(
  client: SettingsClient,
  workspaceId: string,
  /** `replacements`: also read what the last lifecycle sync suggests (the Models page's banner; the picker needs none). */
  options: { readonly replacements?: boolean } = {},
): Promise<Outcome<ModelsData>> {
  const listed = await ask<readonly ConnectionSummary[]>(client, "models", { action: "list" });
  if (!listed.ok) return listed;
  // An owner that answers `list` with anything but a list is not one this page can read.
  if (!Array.isArray(listed.value)) return { ok: false, message: translateNow("settings.models.unreadable") };
  const connections = listed.value.filter(
    (connection) => connection.providerBinding === undefined || connection.providerBinding.workspaceId === workspaceId,
  );
  const replacements = options.replacements === true ? loadReplacements(client) : undefined;
  const [roles, ...shown] = await Promise.all([
    ask<RolesDocument>(client, "models", { action: "roles", workspaceId }),
    ...connections.map((connection) =>
      ask<{ readonly catalog: readonly (ModelCatalogEntry & { readonly stale?: boolean; readonly lifecycle?: ModelLifecycle })[] }>(
        client,
        "models",
        {
          action: "show",
          connectionId: connection.connectionId,
        },
      ),
    ),
  ]);
  if (!roles.ok) return roles;
  const models: BrowsedModel[] = [];
  const failures: { connectionId: string; message: string }[] = [];
  connections.forEach((connection, index) => {
    const catalog = shown[index];
    if (catalog === undefined) return;
    if (!catalog.ok) {
      failures.push({ connectionId: connection.connectionId, message: catalog.message });
      return;
    }
    for (const entry of catalog.value.catalog)
      models.push({
        ...entry,
        connectionLabel: connection.label,
        providerManaged: connection.providerBinding !== undefined,
        stale: entry.stale === true,
      });
  });
  return {
    ok: true,
    value: {
      connections,
      models,
      roles: roles.value as RolesDocument,
      failures,
      ...(replacements === undefined ? {} : { replacements: await replacements }),
    },
  };
}

/** A target as the strip and the picker name it: `connection/model`, or the connection alone. */
const targetLabel = (target: { readonly connectionId: string; readonly model?: string | undefined }): string =>
  target.model === undefined ? target.connectionId : `${target.connectionId}/${target.model}`;

/** What the owner runs, and whether a saved choice waits on a restart. */
export interface OwnerTarget {
  /**
   * What the owner runs (`connection/model`), or — on an owner too old to say —
   * the workspace default. `undefined` when it runs no configured model.
   */
  readonly running: string | undefined;
  /** No model is configured: the owner refuses every run until one is. */
  readonly unconfigured: boolean;
  /** Only an owner that reads its model at startup: what a restart would run, when a restart would resolve one. */
  readonly afterRestart: string | undefined;
  /** Only an owner that reads its model at startup: a restart would run another target than it runs. A live owner never says so. */
  readonly restartRequired: boolean;
}

/**
 * The owner's target as the composer and the footer strip name it. An owner
 * that answers no `activeTarget` predates the field: its workspace default is
 * named, as before, and nothing is claimed about a restart. A workspace with no
 * default answers `running: undefined`, and the strip says so rather than
 * inventing one.
 */
export async function loadTarget(client: SettingsClient, workspaceId: string): Promise<Outcome<OwnerTarget>> {
  const roles = await ask<RolesDocument>(client, "models", { action: "roles", workspaceId });
  if (!roles.ok) return roles;
  const { activeTarget, restartTarget, restartRequired, workspaceDefault } = roles.value;
  if (activeTarget === undefined) {
    const saved = workspaceDefault?.target;
    return {
      ok: true,
      value: {
        running: saved === undefined ? undefined : targetLabel(saved),
        unconfigured: false,
        afterRestart: undefined,
        restartRequired: false,
      },
    };
  }
  return {
    ok: true,
    value: {
      running: activeTarget === null ? undefined : targetLabel(activeTarget),
      unconfigured: activeTarget === null,
      afterRestart: restartTarget === undefined || restartTarget === null ? undefined : targetLabel(restartTarget),
      restartRequired: restartRequired === true,
    },
  };
}

/** What the composer's picker shows as chosen: the saved choice a restart would run, else what runs. */
export function chosenTarget(target: OwnerTarget | undefined): string | undefined {
  return target === undefined ? undefined : target.restartRequired ? (target.afterRestart ?? target.running) : target.running;
}

/**
 * The sentence the chat shows while the owner's target is not what was chosen,
 * or `undefined` when there is nothing to say. An unconfigured owner refuses
 * every run, so that is said whether or not a model has been chosen yet.
 */
export function targetNotice(target: OwnerTarget | undefined): string | undefined {
  if (target === undefined) return undefined;
  if (target.unconfigured) {
    return target.afterRestart === undefined
      ? translateNow("settings.models.target.unconfigured")
      : translateNow("settings.models.target.unconfiguredUntilRestart", { next: target.afterRestart });
  }
  if (!target.restartRequired) return undefined;
  const running = target.running;
  if (target.afterRestart === undefined)
    return running === undefined
      ? translateNow("settings.models.target.startupUnresolved")
      : translateNow("settings.models.target.unresolved", { running });
  return running === undefined
    ? translateNow("settings.models.target.startupUntilRestart", { next: target.afterRestart })
    : translateNow("settings.models.target.untilRestart", { running, next: target.afterRestart });
}

/**
 * A chat's own model, as `models chat` answers it: `chosen`, saved as
 * the chat's; else `default`, the default as configured now. `target` is
 * undefined for a chosen model no connection offers any more.
 */
export interface ChatModel {
  readonly target: string | undefined;
  readonly source: "chosen" | "default";
}

/**
 * What the picker and the strip name for a chosen model no connection offers
 * any more, in the page's language: the chat's next turn is refused until
 * another is picked.
 */
export const chatModelUnavailable = (): string => translateNow("settings.models.chatModelUnavailable");

/**
 * The model chat `taskId` runs from its next turn, or `undefined` — the
 * owner predates chat models (it refuses the action as `INVALID_INPUT`), and a
 * pick sets only the default.
 */
export async function loadChatModel(client: SettingsClient, workspaceId: string, taskId: string): Promise<Outcome<ChatModel | undefined>> {
  const answer = await read(client, "models", { action: "chat", workspaceId, taskId }, ChatModelSchema);
  if (!answer.ok) return answer.code === "INVALID_INPUT" ? { ok: true, value: undefined } : answer;
  return {
    ok: true,
    value: { target: answer.value.target === null ? undefined : targetLabel(answer.value.target), source: answer.value.source },
  };
}

/** What the open chat's model read says of the owner: it keeps one per chat, predates them, or has not said yet. */
export type ChatModelSupport = "supported" | "unsupported" | "unknown";

/**
 * What a pick in the composer does: beside making it the default for
 * new chats, `chat` sets the open chat's own model, `new-chat` holds it for the
 * first message of the chat being written, `default` does nothing more — a Home
 * or chat whose first turn has no task yet, or an owner with one model for
 * every chat — and
 * `wait` refuses until the open chat's model is read, so a pick never quietly
 * leaves it on the old one.
 */
export type ModelPick =
  | { readonly kind: "chat"; readonly taskId: string }
  | { readonly kind: "new-chat" }
  | { readonly kind: "default" }
  | { readonly kind: "wait"; readonly message: string };

export function planModelPick(input: {
  readonly taskId: string | undefined;
  readonly newChat: boolean;
  readonly support: ChatModelSupport;
}): ModelPick {
  if (input.taskId === undefined) return input.newChat ? { kind: "new-chat" } : { kind: "default" };
  if (input.support === "supported") return { kind: "chat", taskId: input.taskId };
  if (input.support === "unsupported") return { kind: "default" };
  return { kind: "wait", message: translateNow("settings.models.pick.wait") };
}

/**
 * The note a pick shows, once its writes answered: `made`, the default's; the
 * chat's own was saved first. `newChats`, what the owner runs for a new chat
 * once they did (`connection/model`): role `main`, or the flags it was started
 * with, outrank the default, so a default saved is not always what runs.
 */
export function modelPickNote(
  pick: Exclude<ModelPick, { readonly kind: "wait" }>,
  picked: { readonly connectionId: string; readonly model: string },
  made: Outcome<string | undefined>,
  newChats: string | undefined,
): Outcome<string | undefined> {
  const { model } = picked;
  const notDefault = made.ok ? undefined : made.message;
  const outranked = made.ok && newChats !== undefined && newChats !== `${picked.connectionId}/${picked.model}` ? newChats : undefined;
  switch (pick.kind) {
    case "chat":
      if (notDefault !== undefined)
        return { ok: true, value: translateNow("settings.models.pick.chatNotDefault", { model, message: notDefault }) };
      // The picker already names the model: a note only for what it does not show.
      return {
        ok: true,
        value: outranked === undefined ? undefined : translateNow("settings.models.pick.chatOutranked", { model, newChats: outranked }),
      };
    case "new-chat":
      if (notDefault !== undefined)
        return { ok: true, value: translateNow("settings.models.pick.newChatNotDefault", { model, message: notDefault }) };
      return {
        ok: true,
        value: outranked === undefined ? undefined : translateNow("settings.models.pick.newChatOutranked", { model, newChats: outranked }),
      };
    case "default":
      return outranked === undefined
        ? made
        : { ok: true, value: translateNow("settings.models.pick.defaultOutranked", { model, newChats: outranked }) };
  }
}

/** What a listing disclosed of a model's size, in a few characters, or nothing. */
export function capacityLabel(model: {
  readonly contextWindow?: number | undefined;
  readonly maxTokens?: number | undefined;
}): string | undefined {
  const parts = [
    model.contextWindow === undefined
      ? undefined
      : translateNow("settings.models.capacity.context", { tokens: formatTokens(model.contextWindow) }),
    model.maxTokens === undefined ? undefined : translateNow("settings.models.capacity.out", { tokens: formatTokens(model.maxTokens) }),
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

export type SortKey = "name" | "state" | "connection";

export interface ModelFilter {
  readonly search: string;
  /** A connection id, or "" for all. */
  readonly connectionId: string;
  /** A state, or "" for all. */
  readonly state: string;
  /** Only models the probe found tool calling on. */
  readonly toolsOnly: boolean;
}

/** The models `filter` keeps, in `sort`'s order (Meggy's FilterBar, over tavi's catalog). */
export function browse(models: readonly BrowsedModel[], filter: ModelFilter, sort: SortKey): BrowsedModel[] {
  const needle = filter.search.trim().toLowerCase();
  const rank: Readonly<Record<string, number>> = { capable: 0, available: 1, unavailable: 2 };
  return models
    .filter((model) => filter.connectionId === "" || model.connectionId === filter.connectionId)
    .filter((model) => filter.state === "" || model.state === filter.state)
    .filter((model) => !filter.toolsOnly || model.capabilities.includes("tools"))
    .filter(
      (model) =>
        needle === "" ||
        model.modelId.toLowerCase().includes(needle) ||
        (model.displayName ?? "").toLowerCase().includes(needle) ||
        model.connectionLabel.toLowerCase().includes(needle),
    )
    .sort((left, right) => {
      const byName = (left.displayName ?? left.modelId).localeCompare(right.displayName ?? right.modelId);
      if (sort === "state") return (rank[left.state] ?? 9) - (rank[right.state] ?? 9) || byName;
      if (sort === "connection") return left.connectionLabel.localeCompare(right.connectionLabel) || byName;
      return byName;
    });
}

/** The roles a model serves now: bound to it, or resolved to it through the default. */
export function rolesOf(model: Pick<BrowsedModel, "connectionId" | "modelId">, roles: RolesDocument): ModelRole[] {
  return roles.resolved
    .filter((entry) => entry.target?.connectionId === model.connectionId && entry.target.model === model.modelId)
    .map((entry) => entry.role);
}

/** A model a role or the default points at; the default may name a connection alone. */
export interface TargetRef {
  readonly connectionId: string;
  readonly model?: string | undefined;
}

/** One line of the Models page's roles table: what a role runs, and why. */
export interface RoleRow {
  readonly role: ModelRole;
  /** `override`: the role's own chain; `default`: the workspace default; `unset`: nothing. */
  readonly source: "override" | "default" | "unset";
  readonly target?: TargetRef;
  readonly fallback: readonly TargetRef[];
  /** Why the owner could not resolve the role, when it could not. */
  readonly problem?: string;
}

/**
 * Each role as the owner resolves it (`resolveRole`): its own chain, else the
 * workspace default — except `embedding`, which only an explicit binding
 * serves (vectors from two models cannot be compared), so with none it is unset.
 */
export function roleRows(roles: RolesDocument): RoleRow[] {
  const fallbackDefault = roles.workspaceDefault?.target;
  return MODEL_ROLES.map((role) => {
    const binding = roles.roles?.find((row) => row.role === role);
    const problem = roles.resolved.find((row) => row.role === role)?.error?.message;
    const base =
      binding !== undefined
        ? { role, source: "override" as const, target: binding.target, fallback: binding.fallback }
        : fallbackDefault !== undefined && role !== "embedding"
          ? { role, source: "default" as const, target: fallbackDefault, fallback: [] }
          : { role, source: "unset" as const, fallback: [] };
    return problem === undefined ? base : { ...base, problem };
  });
}

/** A target named for people: the model's display name and its connection's label. */
export function describeTarget(
  target: TargetRef,
  data: Pick<ModelsData, "models" | "connections">,
): { readonly name: string; readonly connection: string } {
  const model = data.models.find((row) => row.connectionId === target.connectionId && row.modelId === target.model);
  const connection = data.connections.find((row) => row.connectionId === target.connectionId)?.label ?? target.connectionId;
  return { name: model?.displayName ?? target.model ?? translateNow("settings.models.connectionDefault"), connection };
}

export const sameTarget = (left: TargetRef | undefined, right: TargetRef | undefined): boolean =>
  left !== undefined && right !== undefined && left.connectionId === right.connectionId && left.model === right.model;

/**
 * Turning native video on for a model: the owner refuses an unconfirmed
 * one with its disclosure, which the page shows and asks about before it
 * confirms; any other refusal is said as it is.
 */
export type VideoSwitchOutcome =
  | Outcome<string | undefined>
  | { readonly ok: false; readonly disclosure: string; readonly message: string };

export const modelActions = {
  async setVideo(
    client: SettingsClient,
    connectionId: string,
    model: string,
    enable: boolean,
    confirmed = false,
  ): Promise<VideoSwitchOutcome> {
    const written = await ask<unknown>(client, "models", {
      action: "video",
      connectionId,
      ...(enable ? { videoEnable: model, disclosureConfirmed: confirmed } : { videoDisable: model }),
    });
    if (written.ok)
      return { ok: true, value: translateNow(enable ? "settings.models.video.whole" : "settings.models.video.frames", { model }) };
    const disclosure = written.details?.["disclosure"];
    return typeof disclosure === "string" && enable && !confirmed ? { ok: false, disclosure, message: written.message } : written;
  },
  /** `tavi models probe --video`: whether the model watches a short clip sent whole, recorded on its catalog row. */
  async probeVideo(client: SettingsClient, connectionId: string, model: string): Promise<Outcome<string | undefined>> {
    const probed = await ask<{ readonly ok?: boolean; readonly message?: string }>(
      client,
      "models",
      { action: "probe", probe: "video", connectionId, model },
      { timeoutMs: 120_000 },
    );
    if (!probed.ok) return probed;
    // A failed probe is the owner's words: a wrong reading, no answer at all, or a pass not recorded (the connection changed).
    return probed.value.ok === false
      ? {
          ok: false,
          message: translateNow("settings.models.video.probeFailed", {
            model,
            reason: probed.value.message ?? translateNow("settings.models.noReason"),
          }),
        }
      : { ok: true, value: translateNow("settings.models.video.probePassed", { model }) };
  },
  async discover(client: SettingsClient, connectionId: string): Promise<Outcome<string | undefined>> {
    const found = await ask<{ readonly models?: readonly unknown[] }>(client, "models", { action: "discover", connectionId });
    return mapOutcome(found, (value) =>
      [translateNow("settings.models.discovered", { count: value.models?.length ?? 0 }), restartNote(value, "models")]
        .filter(Boolean)
        .join(" "),
    );
  },
  async test(client: SettingsClient, connectionId: string, model: string): Promise<Outcome<string | undefined>> {
    const tested = await ask<{ readonly ok: boolean; readonly message?: string; readonly latencyMs?: number }>(client, "models", {
      action: "test",
      connectionId,
      model,
    });
    if (!tested.ok) return tested;
    // A model that failed its test is a failed outcome, so a caller can show it as one.
    if (!tested.value.ok)
      return {
        ok: false,
        message: translateNow("settings.models.test.failed", {
          model,
          reason: tested.value.message ?? translateNow("settings.models.noReason"),
        }),
      };
    const answer =
      tested.value.latencyMs === undefined
        ? translateNow("settings.models.test.answered", { model })
        : translateNow("settings.models.test.answeredIn", { model, latency: String(tested.value.latencyMs) });
    const note = restartNote(tested.value, "models");
    return { ok: true, value: note === undefined ? answer : `${answer} ${note}` };
  },
  async setDefault(client: SettingsClient, workspaceId: string, connectionId: string, model: string): Promise<Outcome<string | undefined>> {
    const written = await ask<unknown>(client, "models", { action: "set-default", workspaceId, connectionId, model });
    return mapOutcome(written, (value) => restartNote(value, "models") ?? translateNow("settings.models.isDefault", { model }));
  },
  /** Chat `taskId` runs `connectionId`/`model` from its next model call. */
  async setChat(
    client: SettingsClient,
    workspaceId: string,
    taskId: string,
    connectionId: string,
    model: string,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<unknown>(client, "models", { action: "set-chat", workspaceId, taskId, connectionId, model });
    return mapOutcome(written, () => translateNow("settings.models.chatRuns", { model }));
  },
  async setRole(
    client: SettingsClient,
    workspaceId: string,
    role: ModelRole,
    connectionId: string,
    model: string,
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<unknown>(client, "models", { action: "set-role", workspaceId, role, connectionId, model });
    return mapOutcome(written, (value) => restartNote(value, "models") ?? translateNow("settings.models.servesRole", { model, role }));
  },
};
