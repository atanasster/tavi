import {
  PROVIDER_ABI,
  PluginProvenanceSchema,
  ProviderDeclarationSchema,
  ProviderInstancesSchema,
  type ProviderInstanceConfig,
  type ProviderDeclaration,
} from "./provider-config.js";
import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { SECRET_KEY_REF_PATTERN, TimestampSchema } from "./ids.js";
import { canvasCoreEnglish, type CanvasCoreKey, type CanvasCoreT } from "./locales/core-canvas.js";
import { SUPPORTED_LOCALES, type Locale } from "./i18n.js";
import { ToolEffectSchema } from "./tools.js";
import { RouterFeatureSchema } from "./router.js";
import { PluginContentHashSchema, PluginUiSchema, snapshotPath, type PluginUi } from "./plugin-ui.js";
import { PLUGIN_ID_PATTERN, PluginVersionSchema } from "./plugin-ids.js";
import { PLUGIN_MESSAGE_MAX_CHARS, PLUGIN_MESSAGES_MAX, PluginMessageKeySchema, PluginMessageSchema } from "./plugin-messages.js";
import { RiskLevelSchema } from "./tool-policy.js";
import { ChannelDescriptorSchema, type ChannelDescriptor } from "./channels.js";
import { RoutineTemplateSchema } from "./routines.js";
import type { ChannelRetention } from "./channel-groups.js";
import {
  PluginHeartbeatDeclarationSchema,
  PluginHeartbeatSignalsDeclarationSchema,
  type PluginHeartbeatDeclaration,
  type PluginHeartbeatSignalsDeclaration,
} from "./heartbeat.js";
import { PluginMemoryDeclarationSchema, type PluginMemoryDeclaration } from "./memory-provider.js";
import { IdeaPluginCapabilitySchema, PluginIdeasDeclarationSchema, type PluginIdeasDeclaration } from "./ideas.js";
import { PluginOnboardingDeclarationSchema, type PluginOnboardingDeclaration } from "./onboarding-plugin.js";
import { MCP_PLUGIN_PREFIX, McpBlockSchema, mcpPackageDirectory, mcpSettingProblems, mcpSlugOf, type McpBlock } from "./mcp-manifest.js";
import { SANDBOX_DOMAINS_MAX, normalizeSandboxDomain } from "./sandbox.js";
import { PluginAppsBlockSchema, type PluginAppsBlock } from "./connected-apps.js";
import {
  MAX_MOD_HOOKS,
  ModsDeclarationSchema,
  type ModCommandDeclaration,
  type ModEvent,
  type ModsDeclaration,
  type PluginModHookView,
} from "./mods.js";

/**
 * Plugin registry: the operator lists, installs, reviews, enables and
 * configures plugins from the CLI and the web canvas.
 *
 * Two kinds exist. A **built-in** plugin is composed from this build's own
 * packages; it can be listed and, unless another plugin needs a service it
 * provides (`core`), disabled. An **external** plugin is a directory with a
 * `tavi-plugin.json` manifest and an ES module entry, installed as an
 * immutable content-hashed snapshot and reviewed before it can run. Plugins run
 * in the owner's process with its privileges: approval is the trust decision,
 * and the hash pins exactly what was approved.
 */

export const PLUGIN_MANIFEST_FILE = "tavi-plugin.json";

/** Limits that keep an install bounded and a list inside one IPC frame. */
export const PLUGIN_BOUNDS = {
  maxFiles: 500,
  maxBytes: 20 * 1024 * 1024,
  maxTools: 32,
  maxConfigKeys: 32,
  maxConfigString: 4096,
  /** Directories, including the root, and their nesting depth. */
  maxDirectories: 500,
  maxDepth: 32,
  maxVersionsPerPlugin: 50,
  maxPlugins: 100,
  /** A tool's model-facing name is its id with dots as underscores, cut at 64: longer ids could collide. */
  maxToolIdLength: 64,
  /** Hooks one plugin may declare in its `mods` block. */
  maxHooks: MAX_MOD_HOOKS,
  /** A hook's own time per dispatch, not counting time inside `next`. */
  hookBudgetMs: 5_000,
  /** The most of a tool's output a `tool.result` hook is handed; more is handed over truncated. */
  maxHookOutputBytes: 1024 * 1024,
  /** One language pack (`locales/<lang>.json`): its bytes, its manifest overlay's entries and its messages. */
  maxLocaleBytes: 64 * 1024,
  maxLocaleOverlayKeys: 500,
  maxLocaleMessages: PLUGIN_MESSAGES_MAX,
  /** One message, or one plural form of it. */
  maxLocaleMessageChars: PLUGIN_MESSAGE_MAX_CHARS,
} as const;

/** The newest manifest `schemaVersion` this Tavi reads; 3 adds `locales`. */
export const PLUGIN_MANIFEST_SCHEMA_VERSION = 3;

/**
 * Why a manifest cannot be read by this Tavi before its schema is checked: a
 * `schemaVersion` newer than it knows, said plainly rather than as a schema
 * mismatch; `undefined` otherwise (the schema says what else is wrong).
 */
export function pluginManifestVersionProblem(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const version = (raw as { readonly schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version <= PLUGIN_MANIFEST_SCHEMA_VERSION) return undefined;
  return `${PLUGIN_MANIFEST_FILE} uses schemaVersion ${String(version)}, which needs a newer Tavi: this one reads up to ${String(PLUGIN_MANIFEST_SCHEMA_VERSION)}`;
}

/**
 * External plugin ids are dotted lower-case like every plugin id; the `tavi.`
 * namespace is reserved for built-ins so an install can never shadow one.
 */
export const ExternalPluginIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(PLUGIN_ID_PATTERN, "plugin ids use dotted lowercase segments, such as acme.weather")
  .refine((id) => !id.startsWith("tavi."), "the tavi. namespace is reserved for built-in plugins");

export { PluginVersionSchema } from "./plugin-ids.js";

/** A tool the plugin will register, named without its plugin prefix (`forecast` → `acme.weather.forecast`). */
export const PluginToolDeclarationSchema = z
  .strictObject({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "tool names are lower-case, such as forecast")
      .max(64),
    effect: ToolEffectSchema,
    description: z.string().min(1).max(2000),
    /**
     * The least risk the approval gate gives any call of this tool. It can
     * only raise the risk the effect implies — a `critical`
     * tool is asked on every call, whatever a rule says — never lower it, and
     * it is the manifest's, so it is part of what the operator approved.
     */
    minRisk: RiskLevelSchema.optional(),
    /** What Ideas may offer while this tool is registered (`trends`, `jobs`, …), reviewed with the version. */
    proves: z.array(IdeaPluginCapabilitySchema).max(4).optional(),
    /**
     * The tool returns third-party content (pages, messages, files), which taints the conversation.
     * Absent means `true`: only an explicit `false` makes the output trusted, and
     * approval shows it; see `pluginToolOutputTrust`.
     */
    untrustedOutput: z.boolean().optional(),
    /**
     * Where the tool's input goes, as the taint step reads it. Absent means
     * `network`, the external
     * default: a request with a model-chosen payload. `search` is a query to a
     * third party; `persist` writes what outlives the chat, and only a
     * `mutating` tool may say it; `none` makes no request at all, only a
     * `read-only` tool may say it, and a worker refuses any request it makes.
     */
    sink: z.enum(["network", "search", "persist", "none"]).optional(),
    /**
     * Only a person decides its calls: the gate asks every one, once, whatever a rule or grant says,
     * and a run nobody attends refuses it. Raise-only: `true` or absent.
     */
    attendedOnly: z.literal(true).optional(),
    /**
     * Input values its approval card shows verbatim, as JSON pointers into the call's input
     * (`/query`, `/cadence`): rows on the card, clipped as every display row is. They never change the
     * call's risk, title or scope.
     */
    card: z
      .strictObject({
        fields: z
          .array(z.string().regex(/^(\/[A-Za-z0-9_-]{1,64}){1,4}$/, "a card field is a JSON pointer such as /query/keywords"))
          .min(1)
          .max(8),
      })
      .optional(),
    /**
     * Offered to the built-in browser worker too, beside its browser tools: only a read-only
     * tool, or one a person decides every call of (`attendedOnly`). Raise-only: `true` or absent.
     */
    browserWorker: z.literal(true).optional(),
    /**
     * Tools of another plugin this one needs to be of any use (`browser.observe`): it is offered only while every
     * one of them is registered, so the model is never handed a tool whose input it cannot get.
     */
    requiresTools: z
      .array(
        z
          .string()
          .max(128)
          .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/, "a required tool is a full tool id, such as browser.observe"),
      )
      .min(1)
      .max(8)
      .optional(),
  })
  .superRefine((tool, context) => {
    if (tool.browserWorker === true && tool.effect !== "read-only" && tool.attendedOnly !== true)
      context.addIssue({
        code: "custom",
        path: ["browserWorker"],
        message: `tool ${tool.name}: the browser worker is offered only a read-only tool, or one with attendedOnly`,
      });
    if (tool.sink === "persist" && tool.effect !== "mutating")
      context.addIssue({ code: "custom", path: ["sink"], message: `tool ${tool.name}: only a mutating tool may declare sink "persist"` });
    if (tool.sink === "none" && tool.effect !== "read-only")
      context.addIssue({ code: "custom", path: ["sink"], message: `tool ${tool.name}: only a read-only tool may declare sink "none"` });
  });
export type PluginToolDeclaration = z.infer<typeof PluginToolDeclarationSchema>;

/**
 * How a plugin tool's output is treated: `untrusted` (it taints the chat) unless
 * the manifest says `untrustedOutput: false`, shown at approval (`trusted`).
 */
export type PluginToolOutputTrust = "untrusted" | "trusted";

export function pluginToolOutputTrust(tool: Pick<PluginToolDeclaration, "untrustedOutput">): PluginToolOutputTrust {
  return tool.untrustedOutput === false ? "trusted" : "untrusted";
}

/** What a listing adds after a tool's effect for its output: nothing for the default (untrusted). */
export function pluginToolOutputNote(output: PluginToolOutputTrust | undefined, t: CanvasCoreT = canvasCoreEnglish): string {
  return output === "trusted" ? t("plugin.tool.note", { note: t("plugin.tool.note.trustedOutput") }) : "";
}

/** What a tool's declaration asks of the gate, as a review says it: its sink, a person deciding every call, its card's rows. */
export function pluginToolDeclarationNote(
  tool: {
    readonly sink?: string | undefined;
    readonly attendedOnly?: boolean | undefined;
    readonly cardFields?: readonly string[] | undefined;
    readonly browserWorker?: boolean | undefined;
  },
  t: CanvasCoreT = canvasCoreEnglish,
): string {
  const notes = [
    ...(tool.sink === undefined ? [] : [t("plugin.tool.note.sink", { sink: tool.sink })]),
    ...(tool.attendedOnly === true ? [t("plugin.tool.note.attended")] : []),
    ...(tool.cardFields === undefined ? [] : [t("plugin.tool.note.card", { fields: tool.cardFields.join(" ") })]),
    ...(tool.browserWorker === true ? [t("plugin.tool.note.browserWorker")] : []),
  ];
  return notes.map((note) => t("plugin.tool.note", { note })).join("");
}

/** A tool's effect as its badge says it: read-only, mutating, external; an effect this release does not know reads as it arrives. */
const TOOL_EFFECT_KEYS: Readonly<Record<z.infer<typeof ToolEffectSchema>, CanvasCoreKey>> = {
  "read-only": "plugin.tool.effect.readOnly",
  mutating: "plugin.tool.effect.mutating",
  external: "plugin.tool.effect.external",
};

const toolEffectLabel = (effect: string, t: CanvasCoreT): string =>
  Object.hasOwn(TOOL_EFFECT_KEYS, effect) ? t(TOOL_EFFECT_KEYS[effect as keyof typeof TOOL_EFFECT_KEYS]) : effect;

/** A tool as a review lists it: `acme.weather.forecast (read-only)`, with its output's trust when that is not the default, and what it asks of the gate. */
export function describePluginTool(
  tool: {
    readonly id: string;
    readonly effect: string;
    readonly output?: PluginToolOutputTrust | undefined;
    readonly sink?: string | undefined;
    readonly attendedOnly?: boolean | undefined;
    readonly cardFields?: readonly string[] | undefined;
    readonly browserWorker?: boolean | undefined;
  },
  t: CanvasCoreT = canvasCoreEnglish,
): string {
  return t("plugin.tool.line", {
    id: tool.id,
    effect: toolEffectLabel(tool.effect, t),
    notes: `${pluginToolOutputNote(tool.output, t)}${pluginToolDeclarationNote(tool, t)}`,
  });
}

/** The most characters an approval card's `detail` shows (`ApprovalDisplaySchema`). */
const CARD_DETAIL_MAX = 2_000;

/** The most top-level fields of an object value its card shows a row each; a larger object is one JSON row. */
const CARD_OBJECT_ROWS = 16;

/** A model-written text as one card row shows it: JSON-quoted when it holds a line break or another control character. */
function cardShown(value: unknown): string {
  return typeof value === "string" && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value) ? value : JSON.stringify(value);
}

/**
 * A tool's card rows: one line per declared field the call gives,
 * `name: value` — a field it does not give has no row, and an object value
 * (a profile, a query) shows one `name/key: value` row per top-level field.
 * The input is model-written, so a value or key with a line break or another
 * control character is shown JSON-quoted — it can never draw a row of its
 * own — and each row gets an equal share of the card, so a long early value
 * can never push a later row off it.
 */
export function cardRows(input: unknown, fields: readonly string[], clip: (text: string, limit: number) => string): string[] {
  const rows = fields.flatMap((pointer): (readonly [string, unknown])[] => {
    const value = inputAtPointer(input, pointer);
    if (value === undefined) return [];
    const name = pointer.slice(1);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
      if (entries.length > 0 && entries.length <= CARD_OBJECT_ROWS) {
        return entries.map(([key, entry]) => [`${name}/${cardShown(key)}`, entry] as const);
      }
    }
    return [[name, value] as const];
  });
  const budget = Math.floor((CARD_DETAIL_MAX - Math.max(0, rows.length - 1)) / Math.max(1, rows.length));
  return rows.map(([name, value]) => clip(`${name}: ${cardShown(value)}`, budget));
}

/**
 * The value at a JSON pointer (RFC 6901) in a call's input, or `undefined`
 * where the input has none: what a tool's card fields read.
 */
export function inputAtPointer(input: unknown, pointer: string): unknown {
  let value: unknown = input;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value) && /^\d+$/.test(key)) value = value[Number(key)];
    else if (value !== null && typeof value === "object" && Object.hasOwn(value, key)) value = (value as Record<string, unknown>)[key];
    else return undefined;
  }
  return value;
}

/**
 * A routing provider the plugin supplies (`provides: ["router"]`). What it may be asked,
 * whether it batches and how it is priced come from here, never from the plugin's code;
 * pricing uses a `plugin:` connection id so a plugin's price sheet cannot stand in for
 * Jev's or a model connection's.
 */
export const PluginRouterDeclarationSchema = z.strictObject({
  features: z
    .array(RouterFeatureSchema)
    .min(1)
    .max(4)
    .refine((features) => new Set(features).size === features.length, "router features are listed once each"),
  batch: z.boolean().default(false),
  pricing: z.strictObject({
    connectionId: z
      .string()
      .max(128)
      .regex(/^plugin:[a-z0-9][a-z0-9_.-]*$/, "router pricing uses a plugin: connection id, such as plugin:acme.router"),
    model: z.string().min(1).max(128),
  }),
});
export type PluginRouterDeclaration = z.infer<typeof PluginRouterDeclarationSchema>;

/** The data each non-model feature discloses beyond the task text. */
const ROUTER_FEATURE_DISCLOSURES = {
  tools: "plugin.router.feature.tools",
  memory: "plugin.router.feature.memory",
  skills: "plugin.router.feature.skills",
} as const;

/** The version a plugin runs (or would run next): the active one, else the newest installed. */
export function pluginRunningVersion(plugin: PluginView): PluginView["versions"][number] | undefined {
  return plugin.versions.find((version) => version.version === (plugin.activeVersion ?? plugin.versions.at(-1)?.version));
}

/** What approving a routing provider means, in the words the CLI and the canvas both show. */
export function describeRouterDeclaration(router: PluginRouterDeclaration, t: CanvasCoreT = canvasCoreEnglish): string {
  const extra = router.features.flatMap((feature) => (feature === "model" ? [] : [t(ROUTER_FEATURE_DISCLOSURES[feature])]));
  const receives = extra.length === 0 ? t("plugin.router.receives") : t("plugin.router.receivesAnd", { extra: extra.join(", ") });
  const words = {
    receives,
    calls: t(router.batch ? "plugin.router.calls.batched" : "plugin.router.calls.perFeature"),
    connection: router.pricing.connectionId,
    model: router.pricing.model,
  };
  return t(router.features.includes("model") ? "plugin.router.describeChooses" : "plugin.router.describe", words);
}

/**
 * A `credential` setting holds a credential *reference*, never a value: the operator stores the
 * secret with `tavi credentials set plugins.<plugin-id>.<name>` and the plugin reads it through
 * `context.secret(key)`. References outside the plugin's own namespace are refused, so a page
 * configuring a plugin cannot point it at a model's or another plugin's key.
 */
export const PluginConfigFieldSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean", "credential"]),
  description: z.string().max(500).optional(),
  required: z.boolean().optional(),
  /** What a settings form calls it ("Adzuna app id"); without one, its key. */
  label: z.string().min(1).max(60).optional(),
  /** Folded under a settings form's *More settings*: an optional or regional field. */
  advanced: z.boolean().optional(),
});
export type PluginConfigField = z.infer<typeof PluginConfigFieldSchema>;

export const PluginConfigValueSchema = z.union([z.string().max(PLUGIN_BOUNDS.maxConfigString), z.number().finite(), z.boolean()]);
export type PluginConfigValue = z.infer<typeof PluginConfigValueSchema>;
export const PluginConfigSchema = z.record(
  z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
    .max(64),
  PluginConfigValueSchema,
);
export type PluginConfig = z.infer<typeof PluginConfigSchema>;

/** A plugin channel as its review shows it: what it may do, and where it reaches. */
export interface PluginChannelDisclosure {
  readonly providerId: string;
  readonly label: string;
  readonly kind: ChannelDescriptor["kind"];
  readonly disclosure: string;
  /** The addresses it signs in at, the webhook routes it receives on, and the hosts it reaches. */
  readonly endpoints: readonly string[];
  /** What removing one of its connections does to what it brought in. */
  readonly retention: ChannelRetention;
}

/** What a channel asks for beyond carrying messages, as its review says it: each is granted by this approval or a later choice. */
function grantsOf(descriptor: ChannelDescriptor, t: CanvasCoreT): string[] {
  const app = descriptor.app;
  return [
    ...(app?.mailbox === true ? [t("plugin.channel.mailbox")] : []),
    ...(app?.provider === undefined
      ? []
      : [t("plugin.channel.sharedClient", { provider: app.provider, command: `tavi channels share-client ${app.provider} <plugin>` })]),
    ...(app?.dataClass === "public" ? [t("plugin.channel.startsPublic")] : []),
  ];
}

export function channelDisclosureOf(descriptor: ChannelDescriptor, t: CanvasCoreT = canvasCoreEnglish): PluginChannelDisclosure {
  const oauth = descriptor.auth.kind === "oauth2" ? descriptor.auth.oauth : undefined;
  const endpoints = [
    ...(oauth === undefined
      ? []
      : [
          `authorize ${oauth.authorizeUrl}`,
          `token ${oauth.tokenUrl}`,
          ...(oauth.revokeUrl === undefined ? [] : [`revoke ${oauth.revokeUrl}`]),
          ...(oauth.accountIdentity === undefined ? [] : [`account ${oauth.accountIdentity.userinfoUrl}`]),
          `scopes ${oauth.scopes.join(" ") || "(none)"}`,
          ...(oauth.client.source === "plugin" && oauth.client.clientSecretRef !== undefined
            ? [`client secret ${oauth.client.clientSecretRef} (sent to its token address)`]
            : []),
        ]),
    ...(descriptor.ingress ?? []).map(
      (route) =>
        `webhook ${route.methods.join("/")} ${route.scope === "provider" ? `/hooks/p/${descriptor.providerId}/${route.name}` : `/hooks/<connection>/${route.name}`} (up to ${route.maxBodyBytes} bytes)`,
    ),
    ...(descriptor.hosts ?? []).map((host) => `host ${host}`),
  ];
  const retention = descriptor.retention ?? "keep";
  const sentences = [
    t("plugin.channel.receives", { label: descriptor.label }),
    ...(retention === "purge-on-remove" ? [t("plugin.channel.erases")] : []),
    ...grantsOf(descriptor, t),
  ];
  return {
    providerId: descriptor.providerId,
    label: descriptor.label,
    kind: descriptor.kind,
    disclosure: sentences.join(". "),
    endpoints,
    retention,
  };
}

/** Where an approved plugin's code runs: a confined worker, or beside the owner. */
export const PLUGIN_ISOLATIONS = ["process", "in-process"] as const;
export type PluginIsolation = (typeof PLUGIN_ISOLATIONS)[number];

/** A language a plugin can carry a pack for. */
const PluginLocaleSchema = z.enum(SUPPORTED_LOCALES);

export const PluginManifestSchema = z
  .strictObject({
    /** 2, or 3 for a manifest with `locales` (and only then): an older Tavi refuses 3, so only a plugin that carries a pack uses it. */
    schemaVersion: z.literal([2, 3]),
    abi: z.literal(PROVIDER_ABI),
    provenance: PluginProvenanceSchema,
    capabilities: z.array(ProviderDeclarationSchema).max(32).default([]),
    id: ExternalPluginIdSchema,
    version: PluginVersionSchema,
    name: z.string().min(1).max(80),
    description: z.string().max(500).default(""),
    /**
     * Module path inside the plugin directory; no escaping it. Optional only for
     * a UI-only plugin (one with `ui`), which runs no owner code: the owner never
     * imports anything from it.
     */
    entry: z
      .string()
      .max(256)
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+\.mjs$/, "entry is a relative .mjs path inside the plugin")
      .optional(),
    /** What the plugin adds to the web canvas; its files are `.js`, never imported by the owner. */
    ui: PluginUiSchema.optional(),
    /**
     * How its apps present in Connected apps: an icon, a category,
     * scope sentences and tool titles. Presentation only, reviewed with the version; a plugin without it still
     * appears, as a bare app. Its own ABI keeps `schemaVersion` as it is.
     */
    apps: PluginAppsBlockSchema.optional(),
    tools: z.array(PluginToolDeclarationSchema).max(PLUGIN_BOUNDS.maxTools).default([]),
    /**
     * Its site profiles: `.json` files in the plugin, each a `SiteProfileSchema`,
     * reviewed and hash-pinned with the version, and each off until the operator turns it on.
     */
    sites: z
      .array(snapshotPath(["json"], "a site profile"))
      .max(32)
      .optional(),
    /**
     * Its site notes: `.json` files in the plugin, each a `SiteNoteSchema`, reviewed and hash-pinned with the
     * version and checked at install like a profile; a note is on while the operator has the plugin's site of
     * its id on (`tavi apps sites <app> <id> on` takes a note's id too), and is read as reference notes.
     */
    siteNotes: z
      .array(snapshotPath(["json"], "a site note"))
      .max(32)
      .optional(),
    /** Services the plugin provides to the host: a routing provider, messaging channels, a heartbeat provider, heartbeat signal sources, a memory provider, an ideas provider, an onboarding flow. */
    provides: z
      .array(z.enum(["router", "channel", "heartbeat", "heartbeat-signals", "memory", "ideas", "onboarding"]))
      .max(7)
      .default([]),
    router: PluginRouterDeclarationSchema.optional(),
    /**
     * The messaging channels the plugin adds: their descriptors, reviewed
     * before any of its code runs; the code
     * supplies each one's connector with `registerChannel`.
     */
    channels: z.array(ChannelDescriptorSchema).max(4).default([]),
    /** The channel contract the plugin is built for; one not in `SUPPORTED_CHANNEL_ABIS` is refused until updated. */
    channelAbi: z.number().int().min(1).max(1000).optional(),
    /** The plugin's hooks into the turn, each declared and approved. */
    mods: ModsDeclarationSchema.optional(),
    /** A heartbeat provider: what it asks to receive, reviewed before its code runs. */
    heartbeat: PluginHeartbeatDeclarationSchema.optional(),
    /** Heartbeat signal sources the plugin adds. */
    heartbeatSignals: PluginHeartbeatSignalsDeclarationSchema.optional(),
    /** A memory provider: what it does and asks to receive, reviewed before its code runs. */
    memory: PluginMemoryDeclarationSchema.optional(),
    /**
     * Routine report templates (docs/AUTOMATION.md): each its prompts, its report's words and the tools its research
     * uses, reviewed with the version; a routine copies one into its revision when it is saved.
     */
    routineTemplates: z.array(RoutineTemplateSchema).max(4).optional(),
    /** An ideas provider (docs/IDEAS-PLUGINS.md): what it asks to receive, reviewed before its code runs. */
    ideas: PluginIdeasDeclarationSchema.optional(),
    /** An onboarding flow (docs/ONBOARDING-PLUGINS.md): steps and words only, reviewed before its code runs. */
    onboarding: PluginOnboardingDeclarationSchema.optional(),
    /** An MCP server's launch spec: the plugin runs no code in the owner. */
    mcp: McpBlockSchema.optional(),
    config: z
      .record(
        z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
          .max(64),
        PluginConfigFieldSchema,
      )
      .refine((fields) => Object.keys(fields).length <= PLUGIN_BOUNDS.maxConfigKeys, "too many config fields")
      .default({}),
    /**
     * Where the plugin asks to run: `process`,
     * a confined worker, or `in-process`, beside the owner, which only an
     * approval with `--in-process` grants. Absent: a worker when it can be one.
     */
    isolation: z.enum(PLUGIN_ISOLATIONS).optional(),
    /** The hosts a worker's code may reach, through its proxy (`host`, `*.domain`, with an optional `:port`). Absent: none. */
    network: z
      .strictObject({
        domains: z
          .array(
            z
              .string()
              .min(1)
              .max(260)
              .refine((entry) => normalizeSandboxDomain(entry) === entry, {
                message: "expected a host or *.domain, optionally with :port, in lower case",
              }),
          )
          .max(SANDBOX_DOMAINS_MAX),
      })
      .optional(),
    /**
     * Credential settings whose real value a worker's `secret(key)` returns,
     * shown at approval. Any other credential reaches a worker as a placeholder
     * its proxy replaces toward the manifest's exact `network.domains` hosts.
     */
    rawSecrets: z
      .array(
        z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
          .max(64),
      )
      .max(16)
      .optional(),
    /** Device broker capabilities declared by a plugin (`"screen"` for desktop computer use). */
    devices: z
      .array(z.enum(["screen"]))
      .max(1)
      .optional(),
    /**
     * Its language packs (schemaVersion 3), by language: `locales/<lang>.json` files, each a
     * `PluginLocaleFileSchema`, reviewed and hash-pinned with the version. The manifest itself stays English.
     */
    locales: z.partialRecord(PluginLocaleSchema, snapshotPath(["json"], "a language pack")).optional(),
  })
  .superRefine((manifest, context) => {
    // 3 is a manifest with language packs: one without stays 2, so an older Tavi still reads it.
    if (manifest.locales !== undefined && manifest.schemaVersion < 3)
      context.addIssue({ code: "custom", path: ["locales"], message: "language packs (locales) need schemaVersion 3" });
    if (manifest.locales === undefined && manifest.schemaVersion === 3)
      context.addIssue({
        code: "custom",
        path: ["schemaVersion"],
        message: "schemaVersion 3 is for a manifest with language packs (locales); without them it stays 2",
      });
    for (const key of manifest.rawSecrets ?? []) {
      if (manifest.config[key]?.type !== "credential")
        context.addIssue({ code: "custom", path: ["rawSecrets"], message: `rawSecrets names ${key}, which is not a credential setting` });
    }
    if (manifest.mcp !== undefined) {
      // An MCP server's plugin: a launch spec and its settings, nothing that runs in the owner.
      if (mcpSlugOf(manifest.id) === undefined)
        context.addIssue({
          code: "custom",
          path: ["id"],
          message: "an MCP server's id is mcp.<name>: lowercase letters and digits, at most 19 characters",
        });
      if (!manifest.provenance.format.startsWith("mcp-"))
        context.addIssue({
          code: "custom",
          path: ["provenance", "format"],
          message: "an MCP server's provenance format is one of mcp-remote, mcp-npm, mcp-pypi, mcp-dir, mcp-command, mcp-mcpb",
        });
      const owner = {
        sites: manifest.sites !== undefined,
        siteNotes: manifest.siteNotes !== undefined,
        entry: manifest.entry !== undefined,
        ui: manifest.ui !== undefined,
        tools: manifest.tools.length > 0,
        capabilities: manifest.capabilities.length > 0,
        provides: manifest.provides.length > 0,
        mods: manifest.mods !== undefined,
        router: manifest.router !== undefined,
        channels: manifest.channels.length > 0,
        heartbeat: manifest.heartbeat !== undefined,
        heartbeatSignals: manifest.heartbeatSignals !== undefined,
        memory: manifest.memory !== undefined,
        ideas: manifest.ideas !== undefined,
        onboarding: manifest.onboarding !== undefined,
      };
      for (const [field, present] of Object.entries(owner)) {
        if (present)
          context.addIssue({
            code: "custom",
            path: [field],
            message: `an MCP server's plugin has no ${field}: its tools come from the server, reviewed at approval`,
          });
      }
      for (const problem of mcpSettingProblems(manifest.mcp, manifest.config))
        context.addIssue({ code: "custom", path: ["mcp"], message: problem });
      if ((manifest.mcp.command ?? []).some((arg) => arg.includes("${package}")) && mcpPackageDirectory(manifest) === undefined) {
        context.addIssue({
          code: "custom",
          path: ["mcp", "command"],
          message: "${package} needs a package, or files copied with the server (mcp-dir, mcp-mcpb)",
        });
      }
      return;
    }
    if (manifest.id.startsWith(MCP_PLUGIN_PREFIX))
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "the mcp. namespace is reserved for MCP servers (a manifest with an mcp block)",
      });
    if (manifest.provenance.format !== "bundled-esm")
      context.addIssue({
        code: "custom",
        path: ["provenance", "format"],
        message: "only an MCP server's plugin uses an mcp-* provenance format",
      });
    if (manifest.entry === undefined && manifest.ui === undefined)
      context.addIssue({ code: "custom", path: ["entry"], message: "entry is required unless the plugin only contributes ui" });
    if (manifest.entry === undefined && (manifest.tools.length > 0 || manifest.capabilities.length > 0 || manifest.provides.length > 0)) {
      context.addIssue({ code: "custom", path: ["entry"], message: "tools, provider factories and services need an entry module" });
    }
    if (manifest.entry === undefined && manifest.mods !== undefined)
      context.addIssue({ code: "custom", path: ["entry"], message: "mods need an entry module that registers their hooks" });
    if (manifest.provides.includes("router") !== (manifest.router !== undefined))
      context.addIssue({ code: "custom", message: 'a routing provider needs both provides: ["router"] and a router declaration' });
    if (manifest.provides.includes("channel") !== manifest.channels.length > 0)
      context.addIssue({ code: "custom", message: 'a channel needs both provides: ["channel"] and its descriptor in channels' });
    if (manifest.provides.includes("heartbeat") !== (manifest.heartbeat !== undefined))
      context.addIssue({ code: "custom", message: 'a heartbeat provider needs both provides: ["heartbeat"] and a heartbeat declaration' });
    if (manifest.provides.includes("heartbeat-signals") !== (manifest.heartbeatSignals !== undefined))
      context.addIssue({
        code: "custom",
        message: 'heartbeat signal sources need both provides: ["heartbeat-signals"] and a heartbeatSignals declaration',
      });
    if (manifest.provides.includes("memory") !== (manifest.memory !== undefined))
      context.addIssue({ code: "custom", message: 'a memory provider needs both provides: ["memory"] and a memory declaration' });
    if (manifest.provides.includes("ideas") !== (manifest.ideas !== undefined))
      context.addIssue({ code: "custom", message: 'an ideas provider needs both provides: ["ideas"] and an ideas declaration' });
    if (manifest.provides.includes("onboarding") !== (manifest.onboarding !== undefined))
      context.addIssue({ code: "custom", message: 'an onboarding flow needs both provides: ["onboarding"] and an onboarding declaration' });
    if (new Set(manifest.provides).size !== manifest.provides.length)
      context.addIssue({ code: "custom", path: ["provides"], message: "a service is listed twice" });
    // A provider never hooks its own checks: a hook that could match a heartbeat turn would read past its egress switches.
    if (manifest.heartbeat !== undefined) {
      for (const [index, hook] of (manifest.mods?.hooks ?? []).entries()) {
        const sources: readonly string[] | undefined = hook.match?.sources;
        if (sources === undefined || sources.includes("heartbeat"))
          context.addIssue({
            code: "custom",
            path: ["mods", "hooks", index],
            message: "a heartbeat provider's hooks must name their sources and leave out heartbeat turns",
          });
      }
    }
    // Nor an ideas provider the prepared steps of its ideas: its hooks name their sources and leave those out.
    if (manifest.ideas !== undefined) {
      for (const [index, hook] of (manifest.mods?.hooks ?? []).entries()) {
        const sources: readonly string[] | undefined = hook.match?.sources;
        if (sources === undefined || sources.includes("ideas"))
          context.addIssue({
            code: "custom",
            path: ["mods", "hooks", index],
            message: "an ideas provider's hooks must name their sources and leave out prepared ideas",
          });
      }
    }
    if (manifest.channels.length > 0 && manifest.channelAbi === undefined)
      context.addIssue({ code: "custom", path: ["channelAbi"], message: "a channel plugin names the channel ABI it is built for" });
    // The group seam is ABI 2's: an ABI 1 plugin cannot claim group features its contract has no methods for.
    if (manifest.channelAbi === 1 && manifest.channels.some((channel) => channel.groups !== undefined))
      context.addIssue({ code: "custom", path: ["channels"], message: "a channel declaring groups is built for channel ABI 2" });
    if (new Set(manifest.channels.map((channel) => channel.providerId)).size !== manifest.channels.length)
      context.addIssue({ code: "custom", message: "a channel is declared twice" });
    if (new Set(manifest.capabilities.map((capability) => capability.id)).size !== manifest.capabilities.length)
      context.addIssue({ code: "custom", message: "duplicate provider factory IDs" });
    const names = new Set<string>();
    for (const tool of manifest.tools) {
      if (names.has(tool.name)) context.addIssue({ code: "custom", message: `tool ${tool.name} is declared twice` });
      names.add(tool.name);
      if (`${manifest.id}.${tool.name}`.length > PLUGIN_BOUNDS.maxToolIdLength) {
        context.addIssue({
          code: "custom",
          message: `tool id ${manifest.id}.${tool.name} is longer than ${PLUGIN_BOUNDS.maxToolIdLength} characters`,
        });
      }
    }
  });
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ——— language packs ———

/** The longest manifest field a pack translates (a channel's `setupHelp`); each path's own limit is `pluginLocaleProblems`'s. */
const OVERLAY_TEXT_MAX = 4000;

// A message's shape, key and bounds are shared with a UI contribution's words (`plugin-messages.ts`).
export { PLUGIN_MESSAGE_KEY_PATTERN } from "./plugin-messages.js";

/**
 * A plugin's language pack (`locales/<lang>.json`): `manifest`, the words of its
 * manifest a person reads, by ID-keyed path (`config.apiKey.label`,
 * `channels.<providerId>.label`, `apps.apps.<appId>.tools.<tool>.title`, …; see
 * `pluginOverlayTargets`), and `messages`, its code's own words (`ctx.t`).
 * Each path is checked against the manifest; a field the model reads is never one.
 */
export const PluginLocaleFileSchema = z.strictObject({
  manifest: z
    .record(z.string().min(1).max(600), z.string().trim().min(1).max(OVERLAY_TEXT_MAX))
    .refine((overlay) => Object.keys(overlay).length <= PLUGIN_BOUNDS.maxLocaleOverlayKeys, "too many manifest entries")
    .default({}),
  messages: z
    .record(PluginMessageKeySchema, PluginMessageSchema)
    .refine((messages) => Object.keys(messages).length <= PLUGIN_BOUNDS.maxLocaleMessages, "too many messages")
    .default({}),
});
export type PluginLocaleFile = z.infer<typeof PluginLocaleFileSchema>;
// `ctx.t`'s lookup lives with the formatter, so the confined worker bundles the same one.
export { pluginTranslate, type PluginMessages } from "./i18n.js";

/** A manifest field a language pack may translate: the longest text it takes, and how it is written into a copy. */
export interface PluginOverlayTarget {
  readonly max: number;
  readonly apply: (copy: PluginManifest, text: string) => void;
}

/**
 * Every manifest field a language pack may translate, by its ID-keyed path:
 * only words a person reads (names, labels, help, sentences and titles), each
 * with the length limit of the field it replaces. Nothing the model reads is
 * here — a tool's description or schema, a routine template's prompts — so the
 * model always reads the English the version was reviewed with.
 */
export function pluginOverlayTargets(manifest: PluginManifest): ReadonlyMap<string, PluginOverlayTarget> {
  const targets = new Map<string, PluginOverlayTarget>();
  const add = (path: string, max: number, apply: PluginOverlayTarget["apply"]) => targets.set(path, { max, apply });
  add("name", 80, (copy, text) => {
    copy.name = text;
  });
  add("description", 500, (copy, text) => {
    copy.description = text;
  });
  for (const key of Object.keys(manifest.config)) {
    add(`config.${key}.label`, 60, (copy, text) => {
      const field = copy.config[key];
      if (field !== undefined) field.label = text;
    });
    add(`config.${key}.description`, 500, (copy, text) => {
      const field = copy.config[key];
      if (field !== undefined) field.description = text;
    });
  }
  for (const app of manifest.apps?.apps ?? []) {
    const appOf = (copy: PluginManifest) => copy.apps?.apps.find((candidate) => candidate.id === app.id);
    const base = `apps.apps.${app.id}`;
    add(`${base}.name`, 60, (copy, text) => {
      const found = appOf(copy);
      if (found !== undefined) found.name = text;
    });
    add(`${base}.summary`, 200, (copy, text) => {
      const found = appOf(copy);
      if (found !== undefined) found.summary = text;
    });
    for (const scope of app.scopes)
      add(`${base}.scopes.${scope.scope}.says`, 160, (copy, text) => {
        const found = appOf(copy)?.scopes.find((candidate) => candidate.scope === scope.scope);
        if (found !== undefined) found.says = text;
      });
    for (const name of Object.keys(app.tools)) {
      add(`${base}.tools.${name}.title`, 60, (copy, text) => {
        const found = appOf(copy)?.tools[name];
        if (found !== undefined) found.title = text;
      });
      add(`${base}.tools.${name}.says`, 160, (copy, text) => {
        const found = appOf(copy)?.tools[name];
        if (found !== undefined) found.says = text;
      });
    }
  }
  for (const channel of manifest.channels) {
    const channelOf = (copy: PluginManifest) => copy.channels.find((candidate) => candidate.providerId === channel.providerId);
    const base = `channels.${channel.providerId}`;
    add(`${base}.label`, 60, (copy, text) => {
      const found = channelOf(copy);
      if (found !== undefined) found.label = text;
    });
    add(`${base}.description`, 500, (copy, text) => {
      const found = channelOf(copy);
      if (found !== undefined) found.description = text;
    });
    add(`${base}.setupHelp`, OVERLAY_TEXT_MAX, (copy, text) => {
      const found = channelOf(copy);
      if (found !== undefined) found.setupHelp = text;
    });
    for (const field of channel.settings) {
      add(`${base}.settings.${field.key}.label`, 80, (copy, text) => {
        const found = channelOf(copy)?.settings.find((candidate) => candidate.key === field.key);
        if (found !== undefined) found.label = text;
      });
      add(`${base}.settings.${field.key}.help`, 500, (copy, text) => {
        const found = channelOf(copy)?.settings.find((candidate) => candidate.key === field.key);
        if (found !== undefined) found.help = text;
      });
    }
    const authFields = channel.auth.kind === "none" ? [] : (channel.auth.fields ?? []);
    for (const field of authFields) {
      const fieldOf = (copy: PluginManifest) => {
        const auth = channelOf(copy)?.auth;
        return auth === undefined || auth.kind === "none" ? undefined : auth.fields?.find((candidate) => candidate.key === field.key);
      };
      add(`${base}.auth.fields.${field.key}.label`, 80, (copy, text) => {
        const found = fieldOf(copy);
        if (found !== undefined) found.label = text;
      });
      add(`${base}.auth.fields.${field.key}.help`, 500, (copy, text) => {
        const found = fieldOf(copy);
        if (found !== undefined) found.help = text;
      });
    }
    for (const side of ["sender", "target"] as const) {
      add(`${base}.${side}.label`, 80, (copy, text) => {
        const found = channelOf(copy);
        if (found !== undefined) found[side].label = text;
      });
      add(`${base}.${side}.placeholder`, 120, (copy, text) => {
        const found = channelOf(copy);
        if (found !== undefined) found[side].placeholder = text;
      });
      add(`${base}.${side}.help`, 200, (copy, text) => {
        const found = channelOf(copy);
        if (found !== undefined) found[side].help = text;
      });
    }
    if (channel.pairing !== undefined)
      add(`${base}.pairing.openLabel`, 60, (copy, text) => {
        const found = channelOf(copy)?.pairing;
        if (found !== undefined) found.openLabel = text;
      });
  }
  for (const contribution of manifest.ui?.contributions ?? []) {
    const contributionOf = (copy: PluginManifest) => copy.ui?.contributions.find((candidate) => candidate.id === contribution.id);
    add(`ui.contributions.${contribution.id}.title`, 40, (copy, text) => {
      const found = contributionOf(copy);
      if (found !== undefined) found.title = text;
    });
    if (contribution.disclosure !== undefined)
      add(`ui.contributions.${contribution.id}.disclosure`, 500, (copy, text) => {
        const found = contributionOf(copy);
        if (found !== undefined) found.disclosure = text;
      });
  }
  for (const template of manifest.routineTemplates ?? [])
    add(`routineTemplates.${template.id}.title`, 60, (copy, text) => {
      const found = copy.routineTemplates?.find((candidate) => candidate.id === template.id);
      if (found !== undefined) found.title = text;
    });
  for (const command of manifest.mods?.commands ?? [])
    add(`mods.commands.${command.name}.description`, 200, (copy, text) => {
      const found = copy.mods?.commands.find((candidate) => candidate.name === command.name);
      if (found !== undefined) found.description = text;
    });
  return targets;
}

/** A path the model reads: a tool's declaration, a routine template's prompts, an MCP server's launch spec. */
function modelFacingPath(path: string): boolean {
  return (
    path === "tools" ||
    path.startsWith("tools.") ||
    path.startsWith("mcp.") ||
    /^routineTemplates\..+\.(research|synthesis|corroborationRule|tools)(\.|$)/.test(path)
  );
}

/**
 * What is wrong with `raw` as `manifest`'s language pack for `locale`: not a
 * pack, a path the manifest has no such field at, a field the model reads, or a
 * text longer than the field it replaces. English's pack carries messages only:
 * the manifest is the English.
 */
export function pluginLocaleProblems(manifest: PluginManifest, locale: Locale, raw: unknown): string[] {
  const parsed = PluginLocaleFileSchema.safeParse(raw);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => `${issue.path.length === 0 ? "" : `${issue.path.join(".")}: `}${issue.message}`);
  const entries = Object.entries(parsed.data.manifest);
  if (locale === "en" && entries.length > 0) return ["the English pack carries messages only: the manifest itself is the English"];
  const targets = pluginOverlayTargets(manifest);
  const problems: string[] = [];
  for (const [path, text] of entries) {
    const target = targets.get(path);
    if (modelFacingPath(path)) problems.push(`${path} is read by the model, which reads the manifest's English; it cannot be translated`);
    else if (target === undefined) problems.push(`${path} is not a field of this manifest a language pack can translate`);
    else if (text.length > target.max) problems.push(`${path} is longer than the ${String(target.max)} characters its field takes`);
  }
  return problems;
}

/**
 * `manifest` with a language pack's words in place of its English ones, for a
 * person's screens only; never what runs or what the model reads. Paths the
 * manifest has no field at are skipped (the pack was checked at install). No
 * overlay, or an empty one, answers `manifest` itself.
 */
export function overlayPluginManifest(manifest: PluginManifest, overlay: Readonly<Record<string, string>> | undefined): PluginManifest {
  const entries = Object.entries(overlay ?? {});
  if (entries.length === 0) return manifest;
  const targets = pluginOverlayTargets(manifest);
  const copy = JSON.parse(JSON.stringify(manifest)) as PluginManifest;
  for (const [path, text] of entries) {
    const target = targets.get(path);
    if (target === undefined || modelFacingPath(path) || text.length > target.max) continue;
    target.apply(copy, text);
  }
  return copy;
}

/** Why `config` does not satisfy `manifest`, or an empty list. Unknown keys and wrong types are refused. */
export function pluginCredentialNamespace(pluginId: string): string {
  return `plugins.${pluginId}.`;
}

export function pluginConfigProblems(manifest: Pick<PluginManifest, "id" | "config">, config: PluginConfig): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    const field = manifest.config[key];
    if (field === undefined) problems.push(`${key} is not a setting of this plugin`);
    else if (field.type === "credential") {
      const namespace = pluginCredentialNamespace(manifest.id);
      if (
        typeof value !== "string" ||
        !SECRET_KEY_REF_PATTERN.test(value) ||
        !value.startsWith(namespace) ||
        value.length === namespace.length
      ) {
        problems.push(`${key} must be a credential reference under ${namespace}<name>, stored with \`tavi credentials set\``);
      }
    } else if (typeof value !== field.type) problems.push(`${key} must be a ${field.type}`);
  }
  for (const [key, field] of Object.entries(manifest.config)) {
    if (field.required === true && config[key] === undefined) problems.push(`${key} is required`);
  }
  return problems;
}

export const PLUGIN_REVIEW_STATES = ["proposed", "approved", "rejected"] as const;
export type PluginReviewState = (typeof PLUGIN_REVIEW_STATES)[number];

/** One installed, immutable version of an external plugin. */
export interface PluginVersionRecord {
  readonly pluginId: string;
  readonly version: string;
  /** sha256 over the snapshot's sorted relative paths and file bytes. */
  readonly contentHash: string;
  readonly manifest: PluginManifest;
  readonly reviewState: PluginReviewState;
  readonly installedBy: string;
  readonly installedAt: string;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
  /**
   * Where the approval runs it: a confined worker, or beside the owner.
   * Absent on a version approved before workers: it runs in-process, as it
   * did, until it is approved again.
   */
  readonly isolation?: PluginIsolation;
}

/** Operator settings for one plugin, built-in or external. Absent means defaults. */
export interface PluginSettingRecord {
  readonly pluginId: string;
  readonly enabled: boolean;
  /** External only: the approved version that runs. */
  readonly activeVersion?: string;
  readonly config: PluginConfig;
  readonly instances?: readonly ProviderInstanceConfig[];
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export const PluginSettingRecordSchema = z.strictObject({
  pluginId: z.string().min(1).max(128),
  enabled: z.boolean(),
  activeVersion: PluginVersionSchema.optional(),
  config: PluginConfigSchema,
  instances: ProviderInstancesSchema.default([]),
  updatedBy: z.string().min(1).max(128),
  updatedAt: TimestampSchema,
});

/** Durable plugin registry storage. */
interface PluginRepositoryPortDefinition {
  /**
   * Records an installed version. The same id, version and hash again is a
   * no-op (`created: false`); a different hash is a `CONFLICT`, because an
   * installed version is immutable.
   */
  addVersion(record: PluginVersionRecord): { readonly record: PluginVersionRecord; readonly created: boolean };
  getVersion(pluginId: string, version: string): PluginVersionRecord | undefined;
  listVersions(pluginId?: string): { readonly versions: readonly PluginVersionRecord[]; readonly unreadable: readonly string[] };
  /**
   * A proposed version can be approved or rejected; an approved one can be rejected later
   * (revoking trust). A rejected version is final. The same decision again is a no-op.
   */
  decide(
    pluginId: string,
    version: string,
    state: "approved" | "rejected",
    by: string,
    now: string,
    isolation?: PluginIsolation,
  ): PluginVersionRecord;
  removeVersion(pluginId: string, version: string): boolean;
  getSetting(pluginId: string): PluginSettingRecord | undefined;
  listSettings(): { readonly settings: readonly PluginSettingRecord[]; readonly unreadable: readonly string[] };
  putSetting(record: PluginSettingRecord): PluginSettingRecord;
  removeSetting(pluginId: string): boolean;
  loadPluginState(pluginId: string): Record<string, unknown>;
  putPluginState(pluginId: string, namespace: string, value: unknown, now: string): void;
  clearPluginState(pluginId: string): boolean;
  /** Record a hook's decision or failure; the newest `MAX_PLUGIN_HOOK_DECISIONS` decisions and `MAX_PLUGIN_HOOK_FAILURES` failures per plugin are kept. */
  appendHookEvent(record: PluginHookEventRecord): void;
  /** A plugin's hook events, newest first. */
  listHookEvents(pluginId: string, limit: number): readonly PluginHookEventRecord[];
  /** What a plugin's hooks decided and how often they failed, counted over the kept rows, with the newest `recent`. */
  hookActivity(pluginId: string, recent: number): PluginHookActivity;
  clearHookEvents(pluginId: string): boolean;
}

export interface PluginHookActivity {
  readonly decisions: number;
  readonly failures: number;
  /** The newest few, newest first. */
  readonly recent: readonly PluginHookEventRecord[];
  /** A kind has reached its bound, so its oldest rows are pruned as new ones come: the counts are of the kept ones. */
  readonly pruned?: true;
}

/** How many hook events a listing returns at most (the newest). */
export const MAX_PLUGIN_HOOK_EVENTS = 500;
/** How many hook decisions are kept per plugin, and failures apart from them; older ones of the kind are dropped as new ones arrive. */
export const MAX_PLUGIN_HOOK_DECISIONS = 10_000;
export const MAX_PLUGIN_HOOK_FAILURES = 500;

/**
 * One audit row of a plugin's hooks: a verdict a hook changed, a call it
 * denied, a result it withheld or a prompt it dropped (`decision`), or a hook
 * that threw, ran out of time or answered a wrong shape (`failure`).
 */
export interface PluginHookEventRecord {
  readonly pluginId: string;
  readonly kind: "decision" | "failure";
  /** The hook's event, or `command.run` for a slash command. */
  readonly event: ModEvent | "command.run";
  readonly tool?: string;
  readonly taskId?: string;
  readonly workspaceId?: string;
  /** `mod:<plugin id>` on a verdict a hook decided. */
  readonly ruleId?: string;
  /** What happened, in words: "allow → ask: Deletes files.", "timeout: …". A hook writes part of it, so credential shapes are masked before it is stored. */
  readonly detail: string;
  readonly at: string;
}

export type PluginRepositoryPort = AsyncRepository<PluginRepositoryPortDefinition>;

/** A built-in plugin as the registry presents it. */
export interface BuiltinPluginInfo {
  readonly id: string;
  readonly description: string;
  /** Another plugin needs a service it provides: it cannot be disabled. */
  readonly core: boolean;
  /** What it adds to the web canvas, described by the same schema as an external plugin's manifest. */
  readonly ui?: PluginUi;
  /** It composes no owner code — only `ui` — so switching it needs no restart. */
  readonly uiOnly?: true;
  /** The build-time hash of its UI files, as the canvas build ships them (`dist/plugins/<id>/`); required with `ui`. */
  readonly uiContentHash?: string;
  /** `false`: off until the operator enables it (a first-party mod). Absent: on. */
  readonly enabledByDefault?: false;
  /** Its hooks into the turn, declared as an external plugin's are, so its review reads the same. */
  readonly mods?: ModsDeclaration;
}

/** Live state, when an owner answers: the host's phase for a composed plugin. */
/** `verified`: `doctor` checked the enabled version (approval, hash, settings) without importing it. */
/** `degraded`: its hooks failed too often and are suspended until the owner restarts; gating ones still fail closed. */
export const PLUGIN_PHASES = [
  "registered",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
  "not_composed",
  "verified",
  "degraded",
] as const;

/** A plugin's own time in its hooks for one event, `next` not counted, over its last dispatches (at most `samples`). */
export interface PluginHookLatency {
  readonly event: string;
  readonly medianMs: number;
  readonly worstMs: number;
  readonly samples: number;
}

/** A tool in a plugin's listing. `output` is set only when it is not untrusted: `trusted`, declared. */
export interface PluginToolView {
  readonly id: string;
  readonly effect: z.infer<typeof ToolEffectSchema>;
  readonly description: string;
  readonly output?: Exclude<PluginToolOutputTrust, "untrusted">;
  /** The manifest's declared sink; absent is the external default, `network`. */
  readonly sink?: PluginToolDeclaration["sink"];
  /** Only a person decides its calls. */
  readonly attendedOnly?: true;
  /** The input values its card shows. */
  readonly cardFields?: readonly string[];
  /** Offered to the built-in browser worker. */
  readonly browserWorker?: true;
}

/** A version's tools as its listing shows them, each with its output's trust when that is not the default. */
export function pluginToolViews(record: Pick<PluginVersionRecord, "pluginId" | "manifest">): PluginToolView[] {
  return record.manifest.tools.map((tool) => {
    const output = pluginToolOutputTrust(tool);
    return {
      id: `${record.pluginId}.${tool.name}`,
      effect: tool.effect,
      description: tool.description,
      ...(output === "untrusted" ? {} : { output }),
      ...(tool.sink === undefined ? {} : { sink: tool.sink }),
      ...(tool.attendedOnly === true ? { attendedOnly: true as const } : {}),
      ...(tool.card === undefined ? {} : { cardFields: tool.card.fields }),
      ...(tool.browserWorker === true ? { browserWorker: true as const } : {}),
    };
  });
}

export interface PluginView {
  readonly id: string;
  /** `mcp`: an MCP server's plugin, which runs no owner code. */
  readonly kind: "builtin" | "external" | "mcp";
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly core: boolean;
  readonly activeVersion?: string;
  /** Each installed version with what it declares, so a review sees the version it decides on. */
  readonly versions: readonly {
    readonly version: string;
    readonly reviewState: PluginReviewState;
    readonly contentHash: string;
    readonly installedAt: string;
    readonly tools: readonly PluginToolView[];
    readonly configFields: Readonly<Record<string, PluginConfigField>>;
    readonly capabilities?: readonly ProviderDeclaration[];
    readonly provenance?: z.infer<typeof PluginProvenanceSchema>;
    /** The routing provider this version declares, if any. */
    readonly router?: PluginRouterDeclaration;
    /** What this version adds to the web canvas: contributions, their channels and disclosure. */
    readonly ui?: PluginUi;
    /** How its apps present in Connected apps: the author's words, shown as such in its review. */
    readonly apps?: PluginAppsBlock;
    /** The messaging channels this version adds, with what each may do and the addresses it reaches. */
    readonly channels?: readonly PluginChannelDisclosure[];
    /** It only adds to the web canvas (no `entry`, a `ui`): enabling or disabling it needs no restart. */
    readonly uiOnly?: true;
    /** Its `entry` module is imported into the owner when it runs; an MCP server's or a UI-only plugin's is not. */
    readonly runsOwnerCode: boolean;
    /** Where its approval runs it; absent before approval, and on one approved before workers (in-process). */
    readonly isolation?: PluginIsolation;
    /** Why it cannot be a worker, for the review; absent when it can. */
    readonly workerRefusal?: string;
    /** What a worker of it may reach, and the credentials it holds raw, for the review. */
    readonly networkDomains?: readonly string[];
    readonly rawSecrets?: readonly string[];
    /** An MCP server's launch spec, as the review shows it. */
    readonly mcp?: McpBlock;
    /** The hooks this version declares, with what each can read. */
    readonly mods?: readonly PluginModHookView[];
    /** The slash commands this version declares. */
    readonly commands?: readonly ModCommandDeclaration[];
    /** The heartbeat provider this version declares, with what it asks to receive. */
    readonly heartbeat?: PluginHeartbeatDeclaration;
    /** The heartbeat signal sources this version adds. */
    readonly heartbeatSignals?: PluginHeartbeatSignalsDeclaration;
    /** The memory provider this version declares, with what it does and asks to receive. */
    readonly memory?: PluginMemoryDeclaration;
    /** The ideas provider this version declares, with what it asks to receive (docs/IDEAS-PLUGINS.md). */
    readonly ideas?: PluginIdeasDeclaration;
    /** The onboarding flow this version declares (docs/ONBOARDING-PLUGINS.md). */
    readonly onboarding?: PluginOnboardingDeclaration;
  }[];
  /** Where the installed snapshots live on the owner's machine, to read before approving. */
  readonly directory?: string;
  readonly tools: readonly PluginToolView[];
  readonly configFields: Readonly<Record<string, PluginConfigField>>;
  readonly config: PluginConfig;
  readonly instances?: readonly ProviderInstanceConfig[];
  /** The running (or newest) version's canvas contributions; a built-in's own. */
  readonly ui?: PluginUi;
  /** The running (or newest) version, or the built-in, only adds to the web canvas: switching it needs no restart. */
  readonly uiOnly?: true;
  /** The running (or newest) version, or the built-in, imports code into the owner. */
  readonly runsOwnerCode: boolean;
  /** The running (or newest) version's approved isolation: `in-process` (or absent, approved before workers) runs unsandboxed. */
  readonly isolation?: PluginIsolation;
  /** The running (or newest) version's MCP launch spec, for an MCP server. */
  readonly mcp?: McpBlock;
  /** The running (or newest) version's hooks. */
  readonly mods?: readonly PluginModHookView[];
  /** The running (or newest) version's slash commands. */
  readonly commands?: readonly ModCommandDeclaration[];
  /** On `show`, for a plugin with hooks: what they decided and how often they failed, from the newest audit rows. */
  readonly hookActivity?: PluginHookActivity;
  /** A built-in's UI files' build-time hash (`BuiltinPluginInfo.uiContentHash`). */
  readonly uiContentHash?: string;
  /** Loaded unapproved from a folder by `tavi serve --dev-plugin` for this owner run: never installed, reloaded on save. */
  readonly dev?: true;
  /** Phase in the running owner; absent offline. */
  readonly phase?: (typeof PLUGIN_PHASES)[number];
  /** In the running owner, for a plugin with hooks: each event's own hook time over its recent dispatches. */
  readonly hookLatency?: readonly PluginHookLatency[];
  /** Why a composed plugin failed to load or start, when it did. */
  readonly error?: string;
}

const pluginIdField = z.string().min(1).max(128);
const versionField = PluginVersionSchema;

/** The `plugins` IPC command (CLI and web canvas). */
/** The canvas's workspace on a read: the words a person reads come in its language (the owner's `default` when absent). */
const readWorkspaceField = z.string().min(1).max(128).optional();

export const PluginsPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list"), workspaceId: readWorkspaceField }),
  z.strictObject({ action: z.literal("show"), pluginId: pluginIdField, workspaceId: readWorkspaceField }),
  /** An absolute path to a plugin directory. */
  z.strictObject({ action: z.literal("install"), path: z.string().min(1).max(4096) }),
  z.strictObject({ action: z.literal("approve"), pluginId: pluginIdField, version: versionField, inProcess: z.boolean().optional() }),
  z.strictObject({ action: z.literal("reject"), pluginId: pluginIdField, version: versionField }),
  /** `workspaceId`: for an MCP server, the workspace whose `mcp.servers` it joins (the owner's `default` when absent). */
  z.strictObject({
    action: z.literal("enable"),
    pluginId: pluginIdField,
    version: versionField.optional(),
    workspaceId: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({ action: z.literal("disable"), pluginId: pluginIdField }),
  /** `version` validates against that version's settings (an upgrade's new ones); otherwise the active or newest. */
  z.strictObject({
    action: z.literal("config"),
    pluginId: pluginIdField,
    version: versionField.optional(),
    set: PluginConfigSchema.default({}),
    instances: ProviderInstancesSchema.optional(),
    unset: z.array(z.string().max(64)).max(PLUGIN_BOUNDS.maxConfigKeys).default([]),
  }),
  /** `yes`: the removal is confirmed; without it, a channel plugin whose connections are owed a purge is refused, with what would go. */
  z.strictObject({ action: z.literal("remove"), pluginId: pluginIdField, version: versionField.optional(), yes: z.boolean().optional() }),
  /**
   * The UI contributions the canvas may load now: enabled plugins' approved
   * versions. With `pluginId` and
   * `contentHash`, whether that exact one still may — the bridge asks before
   * serving each document, so a revoked plugin is never served again.
   */
  z.strictObject({
    action: z.literal("ui"),
    pluginId: pluginIdField.optional(),
    contentHash: PluginContentHashSchema.optional(),
    workspaceId: readWorkspaceField,
  }),
  /** What each plugin running in the owner's process would lose as a confined worker. */
  z.strictObject({ action: z.literal("audit") }),
]);
export type PluginsPayload = z.infer<typeof PluginsPayloadSchema>;
export const PLUGINS_ACTIONS = [
  "list",
  "show",
  "install",
  "approve",
  "reject",
  "enable",
  "disable",
  "config",
  "remove",
  "ui",
  "audit",
] as const;
