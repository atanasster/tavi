import {
  mcpServerForPeople,
  worseHealth,
  type AppAccess,
  type AppAccountView,
  type AppAuth,
  type AppPresentation,
  type AppRepair,
  appSettingFromPluginConfig,
  type AppSettingField,
  type AppToolView,
  type ConnectableApp,
  type McpBlock,
  type PluginConfigField,
  type PluginManifest,
  type PluginView,
  type ToolEffect,
  type ToolRule,
  type WorkspaceSettings,
} from "@tavi/contracts";

import type { McpReview, McpReviewTool, McpServerRow } from "../../mcp/actions.js";
import { isTaviMcpDescription } from "../../mcp/descriptions.js";
import { mcpToolSink } from "../../mcp/bridge.js";
import { mcpOAuthRef } from "../../mcp/oauth-provider.js";
import { presetOf } from "../../mcp/presets/index.js";
import { approvedVersionOf, authorPresentation, servedIconOf } from "../builtin.js";
import { mcpAccountHealth, mcpAccountRepair, nextWeeklySignIn, weeklySignInReminder, type McpAccountFacts } from "../health.js";
import { toolPolicy } from "../permissions.js";
import { configPrint, sharingOf, type RefusedKey, type RefusedKeys, type SharingOverrides } from "../sharing.js";

/**
 * MCP servers as apps: each
 * server is one account, and instances of one preset (or one manifest app
 * id, of the same server) group into one app, so a second Google Calendar is
 * "add another account", not another app.
 */

export interface McpSourceInput {
  readonly views: readonly PluginView[];
  readonly rows: ReadonlyMap<string, McpServerRow>;
  readonly reviews: ReadonlyMap<string, McpReview>;
  readonly manifestOf: (pluginId: string, version: string) => PluginManifest | undefined;
  readonly rules: readonly ToolRule[];
  readonly settings: WorkspaceSettings;
  readonly workspaceId: string;
  readonly sharing: SharingOverrides;
  /** Credential references the store holds: an OAuth server's grant among them. */
  readonly credentialRefs: ReadonlySet<string>;
  /** Each signed-in server's sign-in, as a page may know it. */
  readonly grants?: ReadonlyMap<string, McpGrantFacts>;
  /** The owner's time, for a weekly sign-in's reminder. */
  readonly now?: string;
  /** Keys a server refused at their test (`apps.refused`). */
  readonly refused?: RefusedKeys;
}

/** An MCP sign-in as a page may know it: never a token. */
export interface McpGrantFacts {
  readonly identity?: string;
  readonly signedInAt: string;
  readonly missingScopes: readonly string[];
  /** It was refused 7 days after a sign-in: it signs out weekly. */
  readonly learnedWeekly?: boolean;
}

export function accessOf(effect: ToolEffect): AppAccess {
  return effect === "read-only" ? "read" : effect === "mutating" ? "change" : "send";
}

/** A server's presentation: its preset's, else its manifest's first app, else a bare one from its name. */
function mcpPresentationOf(view: PluginView, manifest: PluginManifest | undefined): AppPresentation & { readonly auth?: AppAuth } {
  const preset = presetOf(manifest?.mcp?.preset ?? view.mcp?.preset);
  if (preset?.app !== undefined) return preset.app;
  const declared = manifest?.apps?.apps[0];
  if (declared !== undefined) return authorPresentation(declared, view.id);
  return { id: view.id, name: view.name, summary: view.description, category: "other", scopes: [], tools: {}, accountScope: "owner" };
}

function authOf(
  block: McpBlock | undefined,
  presentation: AppPresentation & { readonly auth?: AppAuth },
  manifest: PluginManifest | undefined,
  config: PluginView["config"],
): AppAuth {
  if (presentation.auth !== undefined)
    return {
      ...presentation.auth,
      ...(presentation.auth.kind === "oauth" && presentation.auth.scopes.length === 0 ? { scopes: presentation.scopes } : {}),
    } as AppAuth;
  // The client a sign-in uses is the one set on the server (`clientId`), not one its manifest merely has a field for.
  if (block?.auth === "oauth")
    return {
      kind: "oauth",
      client: typeof config["clientId"] === "string" && config["clientId"] !== "" ? "own" : "registration",
      scopes: presentation.scopes,
      stepUp: [],
    };
  if (block?.auth === "headers") {
    const credentials = Object.entries(manifest?.config ?? {}).filter(([, field]) => field.type === "credential");
    const keySteps = presetOf(block.preset)?.keySteps;
    return {
      kind: "api-key",
      fields: credentials.slice(0, 4).map(([key, field]) => settingOf(key, field, block.preset)),
      ...(keySteps === undefined ? {} : { keySteps: [...keySteps] }),
    };
  }
  return { kind: "none" };
}

/** A setting in words: its own label, else its preset's (a server added before the preset named it), else its key. */
function settingOf(key: string, field: PluginConfigField, preset: McpBlock["preset"]): AppSettingField {
  const label = field.label ?? (preset === undefined ? undefined : presetOf(preset)?.config[key]?.label);
  return appSettingFromPluginConfig(key, label === undefined ? field : { ...field, label });
}

/**
 * The key a server refused at its last test, when it still holds the same settings and was not probed since; its
 * first credential, in words, and where it is kept.
 */
function refusedKeyOf(
  view: PluginView,
  refused: RefusedKey | undefined,
  probedAt: string | undefined,
  fields: Readonly<Record<string, AppSettingField>>,
): McpAccountFacts["refusedKey"] {
  if (refused === undefined || refused.config !== configPrint(view.config)) return undefined;
  if (probedAt !== undefined && probedAt > refused.at) return undefined;
  const [key, field] = Object.entries(fields).find(([, candidate]) => candidate.type === "credential") ?? [];
  if (key === undefined) return undefined;
  const value = view.config[key];
  return { label: field?.label ?? "its key", ref: typeof value === "string" && value !== "" ? value : `plugins.${view.id}.${key}` };
}

/** A tool's bare name in words, for one with no title: `find-completed-tasks` → "Find completed tasks". */
function nameInWords(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_.\s]+/)
    .filter((word) => word !== "")
    .map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase()));
  const text = words.join(" ");
  return text === "" ? name : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The first sentence of a server's description of its tool: a line, not its whole manual. */
function firstSentence(text: string): string {
  const line = text.trim().split(/\n/)[0]?.trim() ?? "";
  const sentence = /^.+?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  return sentence.length > 300 ? `${sentence.slice(0, 299).trimEnd()}…` : sentence;
}

function toolState(tool: McpReviewTool): AppToolView["state"] {
  switch (tool.state) {
    case "approved":
      return "offered";
    case "pending":
      return "pending-review";
    case "withheld":
      return "withheld";
    default:
      return "disabled";
  }
}

function toolView(
  tool: McpReviewTool,
  presentation: AppPresentation,
  egress: boolean,
  rules: readonly ToolRule[],
  fromPreset: boolean,
): AppToolView {
  const effect = tool.decision?.effect ?? tool.suggestedEffect;
  const floor = tool.decision?.minRisk ?? tool.suggestedMinRisk;
  const own = presentation.tools[tool.name];
  const state = toolState(tool);
  const policy =
    state === "disabled"
      ? { decision: "block" as const, because: ["review-disabled" as const], canSetHere: [] }
      : toolPolicy(rules, { toolId: tool.toolId, effect, floor, mcp: true });
  const serverSays = state === "offered" ? tool.shown.description : undefined;
  return {
    toolId: tool.toolId,
    title: (own?.title ?? tool.shown.title ?? nameInWords(tool.shown.name)).slice(0, 256),
    ...(own?.says !== undefined
      ? { says: own.says, saysSource: fromPreset ? ("tavi" as const) : ("author" as const) }
      : serverSays === undefined || firstSentence(serverSays) === ""
        ? {}
        : { says: firstSentence(serverSays), saysSource: "server-approved" as const }),
    access: accessOf(effect),
    effect,
    ...(floor === undefined ? {} : { floor }),
    sink: mcpToolSink(effect, egress).sink,
    state,
    decision: policy.decision,
    because: [...policy.because],
    canSetHere: [...policy.canSetHere],
  };
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Which server an instance is: its preset, else the origin it is reached at or the package it runs. Instances
 * group into one app only when they are the same server, so an author's `apps` block cannot make its server another
 * app's account by naming that app's id.
 */
function serverIdentityOf(view: PluginView, manifest: PluginManifest | undefined): string {
  const block = manifest?.mcp ?? view.mcp;
  if (block?.preset !== undefined) return `preset:${block.preset}`;
  const url = serverUrlOf(view, block);
  if (url !== undefined) {
    try {
      return `url:${new URL(url).origin}`;
    } catch {
      return `plugin:${view.id}`;
    }
  }
  if (block?.package !== undefined) return `package:${block.package.registry}:${block.package.name}`;
  return `plugin:${view.id}`;
}

/** Where a server is reached: its URL, as given or as the setting it names holds. */
function serverUrlOf(view: PluginView, block: PluginManifest["mcp"] | PluginView["mcp"]): string | undefined {
  if (block?.url === undefined) return undefined;
  if ("value" in block.url) return block.url.value;
  const configured = view.config[block.url.setting];
  return typeof configured === "string" ? configured : undefined;
}

/** When an instance was first installed: the group installed earliest keeps an app id another server also names. */
const installedAtOf = (view: PluginView): string => view.versions.map((version) => version.installedAt).sort()[0] ?? "";

/** Every MCP app in the workspace, one per presentation id and server, its accounts in plugin-id order. */
export function mcpApps(input: McpSourceInput): ConnectableApp[] {
  type Group = {
    readonly id: string;
    readonly presentation: ReturnType<typeof mcpPresentationOf>;
    readonly members: { readonly view: PluginView; readonly manifest: PluginManifest | undefined }[];
  };
  // One group per app id and server: a second account of a server joins its own, never another server's.
  const byServer = new Map<string, Group>();
  for (const view of input.views) {
    if (view.kind !== "mcp") continue;
    const version = view.activeVersion ?? view.versions.at(-1)?.version;
    const manifest = version === undefined ? undefined : input.manifestOf(view.id, version);
    // The author's words come only from a version that was approved; a preset's are Tavi's whichever version names it.
    const reviewed = approvedVersionOf(view);
    const approvedManifest = reviewed === undefined ? undefined : reviewed === version ? manifest : input.manifestOf(view.id, reviewed);
    const presentation = mcpPresentationOf(view, approvedManifest ?? (manifest?.mcp?.preset === undefined ? undefined : manifest));
    const key = `${presentation.id}\u0000${serverIdentityOf(view, manifest)}`;
    const group = byServer.get(key) ?? { id: presentation.id, presentation, members: [] };
    group.members.push({ view, manifest });
    byServer.set(key, group);
  }
  // The plain id goes to the server installed first; another naming it is an app of its own, under `<id>.<plugin>`.
  const groups = new Map<string, Group>();
  const earliest = (group: Group): string => group.members.map(({ view }) => installedAtOf(view)).sort()[0] ?? "";
  for (const group of [...byServer.values()].sort((a, b) => earliest(a).localeCompare(earliest(b)))) {
    const appId = groups.has(group.id) ? `${group.id}.${group.members[0]?.view.id ?? ""}` : group.id;
    groups.set(appId, group);
  }
  const apps: ConnectableApp[] = [];
  for (const [appId, { presentation, members }] of groups) {
    const first = members[0];
    if (first === undefined) continue;
    const fromPreset = presetOf(first.manifest?.mcp?.preset)?.app !== undefined;
    const block = first.manifest?.mcp ?? first.view.mcp;
    const auth = authOf(block, presentation, first.manifest, first.view.config);
    const tools: AppToolView[] = [];
    const accounts: AppAccountView[] = [];
    const repairs: AppRepair[] = [];
    const hosts = new Set<string>();
    let lan = false;
    let anyNetwork = false;
    const warnings: string[] = [];
    for (const { view, manifest } of members) {
      const row = input.rows.get(view.id);
      const review = input.reviews.get(view.id);
      const mcp = manifest?.mcp ?? view.mcp;
      const url = serverUrlOf(view, mcp);
      const host = hostOf(url);
      if (host !== undefined) hosts.add(host);
      for (const domain of mcp?.network?.domains ?? []) hosts.add(domain);
      lan ||= mcp?.network?.lan === true;
      anyNetwork ||= row?.sandboxState === "none";
      const egress = mcp?.transport === "http" || (mcp?.network?.domains ?? []).length > 0 || row?.sandboxState === "none";
      for (const tool of review?.tools ?? []) tools.push(toolView(tool, presentation, egress, input.rules, fromPreset));
      const config = manifest?.config ?? view.configFields;
      const missingSettings = Object.entries(config)
        .filter(([key, field]) => field.required === true && (view.config[key] === undefined || view.config[key] === ""))
        .map(([key]) => key);
      const fields = Object.fromEntries(Object.entries(config).map(([key, field]) => [key, settingOf(key, field, mcp?.preset)]));
      const refusedKey = refusedKeyOf(view, input.refused?.[view.id], review?.probedAt, fields);
      const facts: McpAccountFacts = {
        pluginId: view.id,
        state: row?.state ?? (view.enabled ? "unknown" : "disabled"),
        reason: row?.reason,
        enabled: view.enabled,
        // Approved and not yet turned on is approved: its fix is to turn it on, not to review it again.
        activeVersion: approvedVersionOf(view),
        pendingVersions:
          row?.pendingVersions ??
          view.versions.filter((candidate) => candidate.reviewState === "proposed").map((candidate) => candidate.version),
        waitingTools: row?.waitingTools ?? 0,
        openNotices: row?.openNotices ?? [],
        missingSettings,
        fields,
        ...(refusedKey === undefined ? {} : { refusedKey }),
        oauth: mcp?.auth === "oauth",
        signedIn: input.credentialRefs.has(mcpOAuthRef(view.id)),
        missingScopes: input.grants?.get(view.id)?.missingScopes ?? [],
        learnedWeekly: input.grants?.get(view.id)?.learnedWeekly === true,
      };
      if (facts.openNotices.includes("budget"))
        warnings.push(`${view.name} has more tools than fit the model's tool budget; some wait behind search.`);
      const health = mcpAccountHealth(facts);
      const repair = mcpAccountRepair(presentation.name, health, facts);
      if (repair !== undefined) repairs.push(repair);
      const sharing = sharingOf(input.sharing, view.id, presentation.dataClass);
      const lent = input.settings.mcpPeople?.includes(view.id) === true;
      if (sharing === "personal" && lent) {
        repairs.push({
          kind: "sharing",
          accountId: view.id,
          title: `${presentation.name} is no longer used by other people`,
          detail: "People you allowed could use this Personal account; Tavi has stopped that. Mark it shared to let them again.",
          cli: `tavi apps sharing ${appId} ${view.id} shared`,
        });
      }
      const grant = input.grants?.get(view.id);
      // An app left in Testing signs out every 7 days: learned from a refusal 7 days after a sign-in.
      const expiresWeekly = grant?.learnedWeekly === true;
      const nextSignInBy = expiresWeekly && grant !== undefined ? nextWeeklySignIn(grant.signedInAt) : undefined;
      if (health === "ready" && nextSignInBy !== undefined && input.now !== undefined) {
        const reminder = weeklySignInReminder(presentation.name, view.id, nextSignInBy, input.now);
        if (reminder !== undefined) repairs.push(reminder);
      }
      accounts.push({
        accountId: view.id,
        label: (grant?.identity ?? (members.length > 1 ? `${view.name} (${view.id.slice(4)})` : view.name)).slice(0, 120),
        ...(grant?.identity === undefined ? {} : { identity: grant.identity }),
        owner: { kind: "owner" },
        health,
        grantedScopes: [],
        missingScopes: [...(grant?.missingScopes ?? [])].slice(0, 64),
        ...(grant === undefined ? {} : { signedInAt: grant.signedInAt }),
        expiresWeekly,
        ...(nextSignInBy === undefined ? {} : { nextSignInBy }),
        workspaces: input.settings.mcpServers?.includes(view.id) === true ? [input.workspaceId] : [],
        people: sharing === "shared" && mcpServerForPeople(input.settings, view.id),
        sharing,
        readOnly: false,
        on: view.enabled,
      });
    }
    const health = accounts.reduce((worst, account) => worseHealth(worst, account.health), "ready" as ConnectableApp["health"]);
    const transport = block?.transport;
    const sandbox = input.rows.get(first.view.id)?.sandboxState;
    // Named as the sheet names them ("Your Maps API key"), not by their config key (QA 2104).
    const credentials = Object.entries(first.manifest?.config ?? first.view.configFields)
      .filter(([, field]) => field.type === "credential")
      .map(([name, field]) => ({ name: settingOf(name, field, block?.preset).label, raw: false }));
    // A preset's own presentation names no snapshot icon; an author's is served from the server plugin's snapshot.
    const icon = fromPreset ? undefined : servedIconOf(first.view, first.manifest?.apps?.apps[0]?.icon);
    apps.push({
      appId,
      name: presentation.name,
      summary: presentation.summary,
      // A bare server's description may be Tavi's own line (`tavi mcp add` wrote it): the page does not quote it as the author's.
      ...(presentation.id === first.view.id && !fromPreset && isTaviMcpDescription(presentation.summary)
        ? { summaryByTavi: true as const }
        : {}),
      category: presentation.category,
      ...(icon === undefined ? {} : { icon }),
      ...(presentation.publisher === undefined ? {} : { publisher: presentation.publisher }),
      source: {
        kind: "mcp",
        pluginIds: members.map(({ view }) => view.id),
        ...(block?.preset === undefined ? {} : { preset: block.preset }),
        verified: fromPreset ? "tavi-preset" : approvedVersionOf(first.view) === undefined ? "unreviewed" : "reviewed",
        isolation: transport === "http" ? "remote" : sandbox === "none" ? "unsandboxed" : "sandboxed",
      },
      auth,
      tools,
      egress: { hosts: [...hosts], lan, anyNetwork },
      credentials: auth.kind === "oauth" ? [...credentials, { name: "sign-in", raw: false }] : credentials,
      settings: Object.entries(first.manifest?.config ?? first.view.configFields).map(([key, field]) =>
        settingOf(key, field, block?.preset),
      ),
      trust: { output: "untrusted", source: "mcp", confidentiality: presentation.dataClass ?? "public" },
      accounts,
      health,
      repairs,
      warnings: warnings.slice(0, 8),
    });
  }
  return apps;
}
