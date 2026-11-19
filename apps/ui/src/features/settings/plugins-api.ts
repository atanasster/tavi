import type { PermissionsGrantsResult, PermissionsRulesResult, PluginView, ProviderInstanceConfig } from "@tavi/contracts";

import { ask, mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/** A plugins write: what changed, and whether it waits for the owner's next start. */
interface PluginWrite {
  readonly result: Record<string, unknown>;
  readonly restartRequired: boolean;
  readonly routingStopped?: boolean;
  readonly cleanupWarning?: string;
}

const pluginNote = (written: PluginWrite, done: string): string => {
  const note =
    written.routingStopped === true
      ? `${done} Its routing stopped now; restart the owner (tavi serve) to unload its code.`
      : written.restartRequired
        ? `${done} Restart the owner (tavi serve) to load the current configuration.`
        : done;
  return written.cleanupWarning === undefined ? note : `${note} Warning: ${written.cleanupWarning}.`;
};

/** Tool rules and session grants: listed, removed and revoked here; added by approving with `always`. */
export const permissionActions = {
  rules: (client: SettingsClient, workspaceId: string) =>
    ask<PermissionsRulesResult>(client, "permissions", { action: "rules", workspaceId }),
  grants: (client: SettingsClient, workspaceId: string) =>
    ask<PermissionsGrantsResult>(client, "permissions", { action: "grants", workspaceId }),
  async remove(client: SettingsClient, workspaceId: string, ruleId: string): Promise<Outcome<string | undefined>> {
    const done = await ask<{ readonly removed: boolean }>(client, "permissions", { action: "remove", workspaceId, ruleId });
    return mapOutcome(done, () => "Rule removed. Calls it allowed are asked again.");
  },
  async revoke(client: SettingsClient, workspaceId: string, grantId: string): Promise<Outcome<string | undefined>> {
    const done = await ask<{ readonly revoked: boolean }>(client, "permissions", { action: "revoke", workspaceId, grantId });
    return mapOutcome(done, () => "Chat grant revoked.");
  },
};

/** One tool in an MCP server's review, as the owner's `mcp show` answers. */
export interface McpReviewTool {
  readonly name: string;
  readonly toolId: string;
  readonly state: "pending" | "approved" | "withheld" | "disabled" | "removed" | "rejected";
  readonly suggestedEffect: "read-only" | "mutating" | "external";
  readonly suggestedMinRisk?: "low" | "medium" | "high" | "critical";
  readonly decision?: {
    readonly effect: "read-only" | "mutating" | "external";
    readonly minRisk?: "low" | "medium" | "high" | "critical";
    readonly timeoutMs: number;
    readonly askTainted: boolean;
    readonly argFloors?: readonly { readonly risk: string; readonly identify: readonly string[]; readonly safe: readonly string[] }[];
  };
  readonly doubtful: boolean;
  readonly flagged: boolean;
  /** Where its definition reads like instructions, as JSON pointers (`/inputSchema/properties/to/description`); absent from an older owner. */
  readonly flaggedAt?: readonly string[];
  readonly observedDef: { readonly description?: string; readonly title?: string };
  /** Its name, title and description cleaned by the owner: what a page shows (the definition is the server's own text). */
  readonly shown: { readonly name: string; readonly title?: string; readonly description?: string };
  readonly schema: { readonly form: "zod" | "json"; readonly wrapped: boolean } | { readonly problem: string };
  readonly carriedFrom?: string;
  /** What changed since its definition was approved, field by field (cleaned by the owner): on a withheld tool. */
  readonly changedFields?: {
    readonly fields: readonly { readonly field: string; readonly before?: string; readonly after?: string }[];
    readonly more: number;
  };
}

export interface McpReview {
  readonly pluginId: string;
  readonly version: string;
  readonly reviewState: "proposed" | "approved" | "rejected";
  readonly sandboxState: "srt" | "nested" | "none";
  readonly transport: "stdio" | "http";
  readonly launch: readonly string[];
  readonly disclosure: readonly string[];
  readonly era?: "modern" | "legacy";
  readonly serverInfo?: { readonly name: string; readonly version: string };
  readonly instructions?: string;
  /** What differs from the version approved before this one: the sandbox, launch and reach line by line, the instructions. */
  readonly changes?: { readonly since: string; readonly lines: readonly string[] };
  readonly probedAt?: string;
  readonly approvedAt?: string;
  readonly tools: readonly McpReviewTool[];
  readonly notices: readonly { readonly kind: string; readonly title: string; readonly summary: string; readonly updatedAt: string }[];
  /** Overlap with a built-in family, or a description naming other tools (shadowing); an older owner sends none. */
  readonly warnings?: readonly string[];
}

interface McpServerRow {
  readonly pluginId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly activeVersion?: string;
  readonly state: string;
  readonly reason?: string;
  readonly sandboxState?: "srt" | "nested" | "none";
  readonly transport: "stdio" | "http";
  readonly exposure: "auto" | "always" | "search";
  readonly pendingVersions: readonly string[];
  readonly waitingTools: number;
  readonly allowed: boolean;
  readonly people: boolean;
  readonly listed?: number;
  readonly deferred?: boolean;
  readonly openNotices: readonly string[];
}

export interface McpServerList {
  readonly enabled: boolean;
  readonly workspaceId: string;
  readonly budget?: { readonly used: number; readonly limit: number };
  readonly servers: readonly McpServerRow[];
}

/** One way to add an MCP Registry entry, as the owner's `mcp search` answers. */
interface McpRegistryOption {
  readonly key: string;
  readonly kind: "npm" | "pypi" | "mcpb" | "remote";
  readonly summary: string;
  readonly settings: readonly string[];
  readonly credentials: readonly string[];
  readonly notes: readonly string[];
}

/** An MCP Registry entry: its publisher's words, cleaned by the owner, never a reason to trust the server. */
export interface McpRegistryEntry {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly version: string;
  readonly labels: readonly string[];
  readonly options: readonly McpRegistryOption[];
  readonly unsupported: readonly string[];
  readonly websiteUrl?: string;
  readonly repositoryUrl?: string;
  readonly slug: string;
}

export interface McpDiscoverPage {
  readonly registry: string;
  readonly entries: readonly McpRegistryEntry[];
  readonly next?: string;
}

/** What `mcpActions.add` adds: a remote, an npm package, or a registry entry's option. Tavi's presets are added from Discover (`appActions.add`). */
export type McpAddFormInput =
  | { readonly kind: "url"; readonly url: string; readonly headers: readonly string[]; readonly lan: boolean }
  | { readonly kind: "npm"; readonly spec: string }
  | { readonly kind: "registry"; readonly name: string; readonly version: string; readonly option: string };

/** What a page decides for one tool at approval: an effect, a floor, or leaving it out. */
export interface McpToolChoice {
  readonly effect?: "read-only" | "mutating" | "external";
  readonly floor?: "low" | "medium" | "high" | "critical";
  readonly disabled?: boolean;
}

/** The `mcp` family: what `tavi mcp` does, from the canvas; the owner refuses what weakens a server. */
export const mcpActions = {
  list: (client: SettingsClient, workspaceId: string) =>
    ask<{ readonly servers: McpServerList }>(client, "mcp", { action: "list", workspaceId }),
  show: (client: SettingsClient, pluginId: string, version?: string) =>
    ask<{ readonly review: McpReview }>(client, "mcp", { action: "show", pluginId, ...(version === undefined ? {} : { version }) }),
  /** A page of the MCP Registry; the registry is the owner's, which only the CLI changes. */
  search: (client: SettingsClient, query: string, cursor?: string) =>
    ask<{ readonly discover: McpDiscoverPage }>(
      client,
      "mcp",
      { action: "search", query, ...(cursor === undefined ? {} : { cursor }) },
      { timeoutMs: 60_000 },
    ),
  async add(client: SettingsClient, slug: string, form: McpAddFormInput): Promise<Outcome<string | undefined>> {
    const added = await mcpActions.addServer(client, slug, form);
    return mapOutcome(added, (value) => value.message);
  },
  /** `add`, with the plugin id the owner gave the new server. */
  async addServer(
    client: SettingsClient,
    slug: string,
    form: McpAddFormInput,
  ): Promise<Outcome<{ readonly pluginId: string; readonly message: string }>> {
    const added = await ask<{
      readonly added: {
        readonly pluginId: string;
        readonly version: string;
        readonly credentials: readonly string[];
        readonly settings: readonly string[];
      };
    }>(client, "mcp", { action: "add", slug, form }, { timeoutMs: 300_000 });
    if (!added.ok) return added;
    const { pluginId, version, credentials, settings } = added.value.added;
    const needs = [...settings, ...credentials];
    return {
      ok: true,
      value: {
        pluginId,
        message: `${pluginId}@${version} added.${needs.length === 0 ? " Probe it to list its tools." : ` Set ${needs.join(" and ")} in its Settings${credentials.length === 0 ? "" : " (a credential is stored under Credentials first)"}, then probe it.`}`,
      },
    };
  },
  async probe(client: SettingsClient, pluginId: string): Promise<Outcome<string | undefined>> {
    const probed = await ask<{ readonly review: McpReview }>(client, "mcp", { action: "probe", pluginId }, { timeoutMs: 180_000 });
    return mapOutcome(probed, (value) => `${pluginId} probed: ${String(value.review.tools.length)} tools to review.`);
  },
  async approve(
    client: SettingsClient,
    review: McpReview,
    choices: Readonly<Record<string, McpToolChoice>>,
  ): Promise<Outcome<string | undefined>> {
    const pick = <K extends keyof McpToolChoice>(key: K) =>
      Object.fromEntries(
        Object.entries(choices).flatMap(([name, choice]) =>
          choice[key] === undefined || choice.disabled === true ? [] : [[name, choice[key]]],
        ),
      );
    const approved = await ask<{ readonly review: McpReview }>(client, "mcp", {
      action: "approve",
      pluginId: review.pluginId,
      version: review.version,
      effects: pick("effect"),
      floors: pick("floor"),
      timeouts: {},
      disabled: Object.entries(choices)
        .filter(([, choice]) => choice.disabled === true)
        .map(([name]) => name),
      ...(review.sandboxState === "srt" ? {} : { sandbox: review.sandboxState }),
    });
    return mapOutcome(approved, () => `${review.pluginId}@${review.version} approved.`);
  },
  async reject(client: SettingsClient, pluginId: string, version: string): Promise<Outcome<string | undefined>> {
    const rejected = await ask(client, "mcp", { action: "reject", pluginId, version });
    return mapOutcome(rejected, () => `${pluginId}@${version} rejected.`);
  },
  async setEnabled(client: SettingsClient, pluginId: string, enabled: boolean, workspaceId: string): Promise<Outcome<string | undefined>> {
    const written = await ask<PluginWrite>(client, "plugins", {
      action: enabled ? "enable" : "disable",
      pluginId,
      ...(enabled ? { workspaceId } : {}),
    });
    return mapOutcome(written, () => `${pluginId} ${enabled ? `enabled in ${workspaceId}` : "disabled"}.`);
  },
  async people(client: SettingsClient, pluginId: string, on: boolean, workspaceId: string): Promise<Outcome<string | undefined>> {
    const set = await ask(client, "mcp", { action: "people", pluginId, on, workspaceId });
    return mapOutcome(set, () =>
      on
        ? `Other people's chats in ${workspaceId} are offered ${pluginId}'s tools, with your credentials.`
        : `Only your own chats are offered ${pluginId}'s tools.`,
    );
  },
  async off(client: SettingsClient): Promise<Outcome<string | undefined>> {
    const switched = await ask(client, "mcp", { action: "switch", on: false });
    return mapOutcome(switched, () => "MCP is off: every server stopped and its tools withdrawn.");
  },
  logs: (client: SettingsClient, pluginId: string) =>
    ask<{ readonly logs: { readonly lines: readonly string[] } }>(client, "mcp", { action: "logs", pluginId, lines: 200 }),
};

export const pluginActions = {
  list: (client: SettingsClient) => ask<{ readonly plugins: readonly PluginView[] }>(client, "plugins", { action: "list" }),
  /** One plugin as `show` gives it: with its hooks' activity (`hookActivity`) when it has hooks or commands. */
  show: (client: SettingsClient, pluginId: string) => ask<{ readonly plugin: PluginView }>(client, "plugins", { action: "show", pluginId }),
  async install(client: SettingsClient, path: string): Promise<Outcome<string | undefined>> {
    const written = await ask<PluginWrite>(client, "plugins", { action: "install", path });
    if (!written.ok) return written;
    const result = written.value.result as { pluginId?: string; version?: string; created?: boolean } | undefined;
    if (!result?.pluginId || !result?.version) {
      return { ok: false, message: "The owner returned an invalid installation response." };
    }
    const { pluginId, version, created = false } = result;
    return {
      ok: true,
      value: `${pluginId}@${version} ${created ? "installed" : "was already installed"}. Review it, then approve it before enabling.`,
    };
  },
  /**
   * Approve or reject a version. A page's approval runs it as a confined
   * worker: an in-process one is `tavi plugins approve --in-process`'s alone.
   */
  async decide(client: SettingsClient, pluginId: string, version: string, approve: boolean): Promise<Outcome<string | undefined>> {
    const written = await ask<PluginWrite>(client, "plugins", { action: approve ? "approve" : "reject", pluginId, version });
    if (!written.ok) return written;
    const isolation = (written.value.result as { isolation?: string } | undefined)?.isolation;
    const where =
      isolation === "process"
        ? ", to run as a confined worker"
        : isolation === "in-process"
          ? ", to run UNSANDBOXED in the owner's process"
          : "";
    return { ok: true, value: pluginNote(written.value, `${pluginId}@${version} ${approve ? "approved" : "rejected"}${where}.`) };
  },
  async setEnabled(client: SettingsClient, pluginId: string, enabled: boolean): Promise<Outcome<string | undefined>> {
    const written = await ask<PluginWrite>(client, "plugins", { action: enabled ? "enable" : "disable", pluginId });
    return mapOutcome(written, (value) => pluginNote(value, `${pluginId} ${enabled ? "enabled" : "disabled"}.`));
  },
  async configure(
    client: SettingsClient,
    pluginId: string,
    set: Readonly<Record<string, string | number | boolean>>,
    unset: readonly string[],
    instances?: readonly ProviderInstanceConfig[],
  ): Promise<Outcome<string | undefined>> {
    const written = await ask<PluginWrite>(client, "plugins", {
      action: "config",
      pluginId,
      set,
      unset,
      ...(instances === undefined ? {} : { instances }),
    });
    return mapOutcome(written, (value) => pluginNote(value, `${pluginId} settings saved.`));
  },
  /** Confirmed in the page, which says first when a channel's purge is owed. */
  async remove(client: SettingsClient, pluginId: string): Promise<Outcome<string | undefined>> {
    const written = await ask<PluginWrite>(client, "plugins", { action: "remove", pluginId, yes: true });
    return mapOutcome(written, (value) => pluginNote(value, `${pluginId} removed.`));
  },
};
