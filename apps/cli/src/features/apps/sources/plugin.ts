import {
  appSettingFromPluginConfig,
  DEFAULT_EXTERNAL_TOOL_SINK,
  type AppAuth,
  type AppPresentation,
  type AppSiteView,
  type ConnectableApp,
  type PluginManifest,
  type PluginView,
  type SiteProfile,
  type ToolRule,
} from "@tavi/contracts";

import { approvedVersionOf, authorPresentation, servedIconOf } from "../builtin.js";
import { pluginHealth, pluginRepair } from "../health.js";
import { toolPolicy } from "../permissions.js";
import { sharingOf, type SharingOverrides, type SitesOn } from "../sharing.js";
import { accessOf } from "./mcp.js";

/**
 * External plugins as apps: one
 * account each, owner-wide. A plugin that presents nothing still appears, as a
 * bare app named from its manifest, with its tool names as titles.
 */

export interface PluginSourceInput {
  readonly views: readonly PluginView[];
  readonly manifestOf: (pluginId: string, version: string) => PluginManifest | undefined;
  readonly rules: readonly ToolRule[];
  readonly sharing: SharingOverrides;
  readonly workspaceId: string;
  /** The site profiles the operator turned on, by plugin. */
  readonly sitesOn?: SitesOn;
  readonly sitesOf?: (pluginId: string, version: string) => readonly SiteProfile[];
}

/** An approved version's site profiles as the page lists them, each with whether the operator turned it on. */
function siteViews(profiles: readonly SiteProfile[], on: readonly string[]): AppSiteView[] {
  return profiles.map((profile) => ({
    siteId: profile.id,
    name: profile.name,
    hosts: [...profile.hosts],
    mode: profile.access.mode,
    navigate: profile.access.navigate,
    watchable: profile.access.watchable,
    reason: profile.access.reason,
    termsUrl: profile.access.termsUrl,
    on: on.includes(profile.id),
  }));
}

/** Whether a plugin is an app: it has tools, or it presents one. Routers, memory and canvas-only plugins are not. */
function isApp(view: PluginView, manifest: PluginManifest | undefined): boolean {
  return view.kind === "external" && (view.tools.length > 0 || manifest?.apps !== undefined);
}

export function pluginApps(input: PluginSourceInput): ConnectableApp[] {
  const apps: ConnectableApp[] = [];
  for (const view of input.views) {
    const version = view.activeVersion ?? view.versions.at(-1)?.version;
    const manifest = version === undefined ? undefined : input.manifestOf(view.id, version);
    if (!isApp(view, manifest)) continue;
    // The author's words come only from a version that was approved: one awaiting review shows its bare name.
    const approved = approvedVersionOf(view);
    const declared = (approved === undefined ? undefined : input.manifestOf(view.id, approved))?.apps?.apps[0];
    const presentation: AppPresentation =
      declared !== undefined
        ? authorPresentation(declared, view.id)
        : { id: view.id, name: view.name, summary: view.description, category: "other", scopes: [], tools: {}, accountScope: "owner" };
    const config = manifest?.config ?? view.configFields;
    const credentialFields = Object.entries(config).filter(([, field]) => field.type === "credential");
    const auth: AppAuth =
      credentialFields.length === 0
        ? { kind: "none" }
        : { kind: "api-key", fields: credentialFields.slice(0, 4).map(([key, field]) => appSettingFromPluginConfig(key, field)) };
    const missingSettings = Object.entries(config)
      .filter(([key, field]) => field.required === true && (view.config[key] === undefined || view.config[key] === ""))
      .map(([key]) => key);
    const proposed = view.versions.some((candidate) => candidate.reviewState === "proposed");
    // Approved and not yet turned on is approved: its fix is to turn it on, not to review it again.
    const health = pluginHealth({ enabled: view.enabled, proposed, activeVersion: approved, missingSettings, error: view.error });
    const repair = pluginRepair(presentation.name, view.id, health, missingSettings, config);
    const untrusted = view.tools.some((tool) => tool.output === undefined);
    // Only the approved version that runs has its icon served; one awaiting review shows a monogram.
    const icon = servedIconOf(view, declared?.icon);
    // Only an approved version's profiles are listed: one awaiting review allows no site.
    const sites = approved === undefined ? [] : siteViews(input.sitesOf?.(view.id, approved) ?? [], input.sitesOn?.[view.id] ?? []);
    apps.push({
      appId: presentation.id,
      name: presentation.name,
      summary: presentation.summary,
      category: presentation.category,
      ...(icon === undefined ? {} : { icon }),
      ...(presentation.publisher === undefined ? {} : { publisher: presentation.publisher }),
      source: {
        kind: "plugin",
        pluginIds: [view.id],
        verified: approved === undefined ? "unreviewed" : "reviewed",
        isolation: view.isolation === "process" ? "sandboxed" : "in-process",
      },
      auth,
      tools: view.tools.map((tool) => {
        const name = tool.id.slice(view.id.length + 1);
        const own = presentation.tools[name];
        const policy = toolPolicy(input.rules, { toolId: tool.id, effect: tool.effect, mcp: false });
        return {
          toolId: tool.id,
          title: (own?.title ?? name).slice(0, 256),
          ...(own?.says !== undefined
            ? { says: own.says, saysSource: "author" as const }
            : { says: tool.description.slice(0, 2_000), saysSource: "author" as const }),
          access: accessOf(tool.effect),
          effect: tool.effect,
          // What the gate reads: the manifest's sink, else the external default.
          sink: tool.sink ?? DEFAULT_EXTERNAL_TOOL_SINK.sink,
          state: approved === undefined ? ("pending-review" as const) : ("offered" as const),
          decision: policy.decision,
          because: [...policy.because],
          canSetHere: [...policy.canSetHere],
        };
      }),
      egress: {
        hosts: [...(view.versions.find((candidate) => candidate.version === version)?.networkDomains ?? [])],
        lan: false,
        anyNetwork: view.isolation !== "process",
      },
      credentials: credentialFields.map(([name]) => ({
        name,
        raw: (view.versions.find((candidate) => candidate.version === version)?.rawSecrets ?? []).includes(name),
      })),
      settings: Object.entries(config).map(([key, field]) => appSettingFromPluginConfig(key, field)),
      trust: { output: untrusted ? "untrusted" : "trusted", source: "plugin", confidentiality: presentation.dataClass ?? "public" },
      accounts: [
        {
          accountId: view.id,
          label: view.name.slice(0, 120),
          owner: { kind: "owner" },
          health,
          grantedScopes: [],
          missingScopes: [],
          expiresWeekly: false,
          workspaces: [input.workspaceId],
          people: false,
          sharing: sharingOf(input.sharing, view.id, presentation.dataClass),
          readOnly: false,
          on: view.enabled,
        },
      ],
      ...(sites.length === 0 ? {} : { sites }),
      health,
      repairs: repair === undefined ? [] : [repair],
      warnings: [],
    });
  }
  return apps;
}
