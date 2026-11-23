import { z } from "zod";

import type { ChannelField } from "./channels.js";
import { APP_ACCESS, APP_CATEGORIES, AppScopeSchema } from "./app-basics.js";
import { ConfidentialitySchema } from "./content-label.js";
import { IdSchema } from "./ids.js";
import { canvasCoreEnglish, type CanvasCoreT } from "./locales/core-canvas.js";
import { LOOPBACK_ORIGIN_PATTERN } from "./mcp-ipc.js";
import { MCP_PRESET_IDS } from "./mcp-manifest.js";
import type { PluginConfigField } from "./plugin-registry.js";
import { snapshotPath } from "./plugin-ui.js";
import { TextRefSchema } from "./text-ref.js";
import type { ProviderDeclaration } from "./provider-config.js";
import { RiskLevelSchema } from "./tool-policy.js";
import { ToolEffectSchema, ToolSinkSchema } from "./tools.js";

/**
 * Connected apps: one read model
 * that MCP servers, channels and external plugins all project into, so
 * the canvas draws any app the owner holds without code of its own per app.
 * The sources stay the truth: this is the shape the owner answers
 * with, plus the manifest's optional `apps` block, which only presents.
 */

/** The `apps` block's own ABI, so the manifest's `schemaVersion` stays as it is (mods.ts's convention). */
export const APPS_ABI = "tavi.apps/1" as const;

export { APP_ACCESS, APP_CATEGORIES, AppScopeSchema, type AppAccess, type AppCategory, type AppScope } from "./app-basics.js";

export const APP_SOURCE_KINDS = ["mcp", "channel", "plugin"] as const;
export type AppSourceKind = (typeof APP_SOURCE_KINDS)[number];
export const APP_AUTH_KINDS = ["oauth", "api-key", "device", "none"] as const;
export type AppAuthKind = (typeof APP_AUTH_KINDS)[number];
/** Closed and ordered worst → best: an app's health is its worst account's, or its own when it has none. */
export const APP_HEALTH = ["error", "needs-sign-in", "needs-access", "needs-review", "not-set-up", "paused", "off", "ready"] as const;
export type AppHealth = (typeof APP_HEALTH)[number];
/** The household rule: a Personal account is never offered to other people or group chats. */
export const APP_SHARING = ["personal", "shared"] as const;
export type AppSharing = (typeof APP_SHARING)[number];
/** The radio a person picks per tool; the owner resolves it into the smallest rule change. */
export const APP_PERMISSION_TARGETS = ["allow", "ask", "block"] as const;
export type AppPermissionTarget = (typeof APP_PERMISSION_TARGETS)[number];

/** The worse of two health words. */
export function worseHealth(a: AppHealth, b: AppHealth): AppHealth {
  return APP_HEALTH.indexOf(a) <= APP_HEALTH.indexOf(b) ? a : b;
}

/** A generated form field: the union of the plugin, channel and provider field schemas. */
export const AppSettingFieldSchema = z.strictObject({
  /** A plugin's (up to 64), a channel's or a provider's setting name (which may hold `-`). */
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  label: z.string().min(1).max(60),
  help: z.string().max(300).optional(),
  type: z.enum(["string", "url", "number", "boolean", "choice", "strings", "credential"]),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  choices: z
    .array(z.strictObject({ value: z.string().max(200), label: z.string().max(80) }))
    .max(64)
    .optional(),
  /** A channel's pattern whole (up to 512): a regex cut short means something else. */
  pattern: z.string().max(512).optional(),
  placeholder: z.string().max(120).optional(),
  /** Folded under "More settings". */
  advanced: z.boolean().default(false),
});
export type AppSettingField = z.infer<typeof AppSettingFieldSchema>;

/*
 * One settings shape for every kind of app: a plugin's config field, a
 * channel's field and a provider factory's
 * settings each become `AppSettingField`s, so an app's page draws them with one
 * renderer. Text is cut to the field's bounds, never refused.
 */

/** A plugin manifest's `config` field. */
export function appSettingFromPluginConfig(key: string, field: PluginConfigField): AppSettingField {
  return {
    key,
    label: (field.label ?? key).slice(0, 60),
    ...(field.description === undefined ? {} : { help: field.description.slice(0, 300) }),
    type: field.type,
    required: field.required === true,
    advanced: field.advanced === true,
  };
}

/** A channel descriptor's setting. */
export function appSettingFromChannelField(field: ChannelField): AppSettingField {
  return {
    key: field.key,
    label: field.label.slice(0, 60),
    ...(field.help === undefined ? {} : { help: field.help.slice(0, 300) }),
    type: field.type,
    required: field.required === true,
    ...(field.default === undefined ? {} : { default: field.default }),
    ...(field.choices === undefined ? {} : { choices: field.choices.map((choice) => ({ value: choice, label: choice })) }),
    ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
    advanced: false,
  };
}

/** A provider factory's settings, then its credentials, one field each. */
export function appSettingsFromProvider(declaration: ProviderDeclaration): AppSettingField[] {
  const settings = Object.entries(declaration.settings).map(([key, field]): AppSettingField => {
    // Only a text setting becomes a pick from its choices: a number's or a flag's keeps its type, and a list stays a list.
    const pick = field.type === "string" && field.choices !== undefined;
    return {
      key,
      label: key.slice(0, 60),
      help: field.description.slice(0, 300),
      type: pick ? "choice" : field.type,
      required: field.required,
      ...(pick
        ? { choices: (field.choices ?? []).map((choice) => ({ value: String(choice).slice(0, 200), label: String(choice).slice(0, 80) })) }
        : {}),
      advanced: false,
    };
  });
  const credentials = declaration.credentials.map(
    (key): AppSettingField => ({ key, label: key.slice(0, 60), type: "credential", required: true, advanced: false }),
  );
  return [...settings, ...credentials];
}

/** One step of making a provider's client or getting a key: its words, and the console page it opens, when it has one. */
export const AppClientSetupStepSchema = z.strictObject({
  text: z.string().min(1).max(400),
  link: z.strictObject({ label: z.string().min(1).max(60), url: z.string().url().max(512) }).optional(),
  /** Values the step asks the person to type, each shown with a copy button. */
  values: z
    .array(z.strictObject({ label: z.string().min(1).max(60), value: z.string().min(1).max(300) }))
    .max(6)
    .optional(),
});
export type AppClientSetupStep = z.infer<typeof AppClientSetupStepSchema>;

/** How an app's accounts sign in. `client` says where an OAuth client comes from. */
export const AppAuthSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("oauth"),
    client: z.enum(["own", "shared-provider", "metadata-document", "registration"]),
    /** Groups accounts and the shared client: `google`. */
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .optional(),
    scopes: z.array(AppScopeSchema).max(32).default([]),
    /** Asked only when a feature needs them. */
    stepUp: z.array(AppScopeSchema).max(16).default([]),
    redirect: z.enum(["loopback-any-port", "public"]).optional(),
    /** A docs anchor, never a URL the page fetches. */
    setupGuide: z.string().max(80).optional(),
    /** Read the account's email from the id_token; the login adds `openid email`. */
    identity: z.enum(["oidc-email"]).optional(),
  }),
  z.strictObject({
    kind: z.literal("api-key"),
    fields: z.array(AppSettingFieldSchema).max(4),
    /** Tavi's own steps for getting the key, each with the page it opens: absent for a server Tavi knows no steps for. */
    keySteps: z.array(AppClientSetupStepSchema).max(8).optional(),
  }),
  z.strictObject({ kind: z.literal("device"), scopes: z.array(AppScopeSchema).max(32).default([]) }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type AppAuth = z.infer<typeof AppAuthSchema>;

/** Whether an app's accounts sign in: through the browser (`oauth`) or with a code (`device`). */
export function signsIn(auth: AppAuth): auth is Extract<AppAuth, { readonly kind: "oauth" | "device" }> {
  return auth.kind === "oauth" || auth.kind === "device";
}

/** App ids the canvas's routes keep for themselves (`/settings/apps/discover`). */
export const RESERVED_APP_IDS: ReadonlySet<string> = new Set(["discover"]);

export const AppIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9.-]{1,63}$/, "an app id is lowercase letters, digits, dots and dashes, starting with a letter")
  .refine((id) => !RESERVED_APP_IDS.has(id), "that app id is reserved");

/** A path inside the plugin's snapshot, checked as a UI contribution's icon is. */
export const AppIconPathSchema = snapshotPath(["svg", "png"], "an icon");

/** What a plugin author, a preset or a built-in declares; every field but identity is optional. */
export const AppPresentationSchema = z.strictObject({
  /** Stable: instances sharing it group into one app. */
  id: AppIdSchema,
  name: z.string().min(1).max(60),
  summary: z.string().max(200).default(""),
  icon: AppIconPathSchema.optional(),
  category: z.enum(APP_CATEGORIES).default("other"),
  publisher: z.string().max(60).optional(),
  scopes: z.array(AppScopeSchema).max(32).default([]),
  /** Titles and sentences for its tools, by tool name: the author's words, shown as such. */
  tools: z
    .record(z.string().min(1).max(256), z.strictObject({ title: z.string().min(1).max(60), says: z.string().max(160).optional() }))
    .default({}),
  /** `personal` for mail and calendar: the tools' results are labelled so. */
  dataClass: ConfidentialitySchema.exclude(["secret"]).optional(),
  /** Per-person accounts are a later plan; until then the household rule applies. */
  accountScope: z.enum(["owner", "person", "either"]).default("owner"),
  binds: z.strictObject({ channel: z.string().min(1).max(48).optional(), mcp: z.boolean().optional() }).optional(),
});
export type AppPresentation = z.infer<typeof AppPresentationSchema>;

/** The manifest's `apps` block. Reviewed and hash-pinned with the version; its text is the author's. */
export const PluginAppsBlockSchema = z.strictObject({
  abi: z.literal(APPS_ABI),
  apps: z.array(AppPresentationSchema).min(1).max(4),
});
export type PluginAppsBlock = z.infer<typeof PluginAppsBlockSchema>;

/**
 * How an `apps` block is listed for review, one line per app. Every
 * piece of its text is the author's, quoted (JSON-escaped) and said to be,
 * never Tavi's own words: the name, publisher and summary, the scope
 * sentences, and each tool's title — the label Connected apps shows — with
 * its sentence.
 */
export function describePluginApps(block: PluginAppsBlock, t: CanvasCoreT = canvasCoreEnglish): string[] {
  // The author's words, escaped as a JSON string is (no line breaks, quotes escaped), inside the language's quotes.
  // JSON leaves typographic quotes alone, so the language's own marks (and the nested „‚‘ pair) are escaped too:
  // the author's text can never close the quote around it.
  const wrapper = [...t("app.plugin.word.quoted", { text: "" })].filter((mark) => mark !== '"');
  const marks = new Set(wrapper.length === 0 ? [] : [...wrapper, "„", "“", "‚", "‘"]);
  const escapeMarks = (text: string) =>
    [...text].map((c) => (marks.has(c) ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c)).join("");
  const quote = (text: string) => t("app.plugin.word.quoted", { text: escapeMarks(JSON.stringify(text).slice(1, -1)) });
  return block.apps.map((app) => {
    const words = [
      t("app.plugin.word.name", { value: quote(app.name) }),
      ...(app.publisher === undefined ? [] : [t("app.plugin.word.publisher", { value: quote(app.publisher) })]),
      ...(app.summary.length === 0 ? [] : [t("app.plugin.word.summary", { value: quote(app.summary) })]),
      ...app.scopes.map((scope) => t("app.plugin.word.scope", { scope: scope.scope, access: scope.access, says: quote(scope.says) })),
      ...Object.entries(app.tools).map(([name, tool]) =>
        tool.says === undefined
          ? t("app.plugin.word.tool", { name, title: quote(tool.title) })
          : t("app.plugin.word.toolSays", { name, title: quote(tool.title), says: quote(tool.says) }),
      ),
    ].join("; ");
    return app.dataClass === undefined
      ? t("app.plugin.describe", { id: app.id, category: app.category, words })
      : t("app.plugin.describeData", { id: app.id, category: app.category, dataClass: app.dataClass, words });
  });
}

// ——— the read model the canvas renders ———

export const APP_TOOL_STATES = ["offered", "pending-review", "withheld", "disabled"] as const;
export const APP_DECISION_REASONS = [
  "default-read",
  "default-write",
  "rule",
  "never-always",
  "critical",
  "taint-asks",
  "review-disabled",
  "set-in-cli",
] as const;

export const AppToolViewSchema = z.strictObject({
  toolId: z.string().min(1).max(256),
  /** The preset's or the manifest's title, else the tool's name. */
  title: z.string().min(1).max(256),
  /** Reviewed text only. */
  says: z.string().max(2_000).optional(),
  saysSource: z.enum(["tavi", "author", "server-approved"]).optional(),
  access: z.enum(APP_ACCESS),
  effect: ToolEffectSchema,
  floor: RiskLevelSchema.optional(),
  sink: ToolSinkSchema,
  state: z.enum(APP_TOOL_STATES),
  /** Effective, from the gate's static part. */
  decision: z.enum(APP_PERMISSION_TARGETS),
  because: z.array(z.enum(APP_DECISION_REASONS)).max(8),
  /** `allow` only when reachable without adding an allow rule. */
  canSetHere: z.array(z.enum(APP_PERMISSION_TARGETS)).max(3),
});
export type AppToolView = z.infer<typeof AppToolViewSchema>;

export const AppAccountOwnerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner") }),
  z.strictObject({ kind: z.literal("person"), principalId: IdSchema }),
]);

/** What the agent may do in a mailbox account: nothing, read and draft, or that and send drafts it approves. */
export const APP_MAILBOX_ACCESS = ["off", "read", "send"] as const;
export type AppMailboxAccess = (typeof APP_MAILBOX_ACCESS)[number];

export const AppAccountViewSchema = z.strictObject({
  /** MCP: the plugin id; a channel: its connection id; a plugin: its id, or `<id>.<instance>`. */
  accountId: z.string().min(1).max(256),
  label: z.string().min(1).max(120),
  identity: z.string().max(254).optional(),
  owner: AppAccountOwnerSchema,
  health: z.enum(APP_HEALTH),
  grantedScopes: z.array(z.string().max(256)).max(64).default([]),
  missingScopes: z.array(z.string().max(256)).max(64).default([]),
  signedInAt: z.string().max(64).optional(),
  /** A Google client in Testing: the 7-day lapse is forecast. */
  expiresWeekly: z.boolean().default(false),
  nextSignInBy: z.string().max(64).optional(),
  lastUsedAt: z.string().max(64).optional(),
  lastError: z.strictObject({ code: z.string().max(64), message: z.string().max(300), at: z.string().max(64) }).optional(),
  /** Where its tools are offered. */
  workspaces: z.array(z.string().max(128)).max(64),
  /** Bound people act with this account. */
  people: z.boolean(),
  sharing: z.enum(APP_SHARING),
  /** A channel connection the apps page lists but connects through Settings → Channels. */
  readOnly: z.boolean().default(false),
  /** A plugin's or a server's account that is turned on, which its page can turn off. Absent for a channel's. */
  on: z.boolean().optional(),
  /**
   * A mailbox the agent may use: `read` reads and drafts, `send` also sends drafts the person
   * approves. Absent for an account with no mailbox; off by default.
   */
  mailbox: z.enum(APP_MAILBOX_ACCESS).optional(),
  /**
   * Whether the agent may use the account's calendar (its read, find-free-time and event tools, each write asked
   * first). Absent for an account with no calendar; off by default. Turning it on asks the provider for its access
   * at the account's next sign-in.
   */
  calendar: z.boolean().optional(),
  /** Whether a channel account takes messages in (its channel's `receive` setting); absent for a channel that always does. */
  receives: z.boolean().optional(),
  /**
   * The other apps signed in with the same provider project and account: disconnecting this one
   * leaves the provider's grant for them, and only the last one revokes it.
   */
  keptBy: z.array(z.string().max(80)).max(16).optional(),
  /**
   * A channel connection's setup notes, from its last probe: what setting it up still asks, and a link
   * the page shows only when its host is one of the channel's declared hosts.
   */
  setup: z
    .strictObject({
      lines: z.array(z.string().max(200)).max(6),
      link: z.strictObject({ label: z.string().max(60), url: z.string().url().max(512) }).optional(),
    })
    .optional(),
});
export type AppAccountView = z.infer<typeof AppAccountViewSchema>;

export const APP_REPAIR_KINDS = [
  "finish-setup",
  "sign-in",
  "grant-access",
  "review-tools",
  "enable",
  "turn-on",
  "retry",
  "cli-only",
  "sharing",
] as const;
export type AppRepairKind = (typeof APP_REPAIR_KINDS)[number];

export const AppRepairSchema = z.strictObject({
  kind: z.enum(APP_REPAIR_KINDS),
  accountId: z.string().max(256).optional(),
  title: z.string().max(120),
  /** The cause, in words. */
  detail: z.string().max(300),
  /** The same fix, as a command. */
  cli: z.string().max(200),
  /**
   * The title and the detail by key, beside their English, so the canvas says them in its language. Absent from
   * an owner before them, and for a detail that is a server's own words (why it failed), shown as it is.
   */
  titleRef: TextRefSchema.optional(),
  detailRef: TextRefSchema.optional(),
});
export type AppRepair = z.infer<typeof AppRepairSchema>;

/** One of an app's site profiles as Connected apps lists it under "Sites this app may browse": what it allows, and whether it is on. */
export const AppSiteViewSchema = z.strictObject({
  siteId: z.string().max(40),
  name: z.string().max(80),
  hosts: z.array(z.string().max(253)).max(8),
  mode: z.enum(["read", "assist-only", "stage", "none"]),
  navigate: z.boolean(),
  watchable: z.boolean(),
  reason: z.string().max(300),
  termsUrl: z.string().max(2_048),
  on: z.boolean(),
});
export type AppSiteView = z.infer<typeof AppSiteViewSchema>;

export const ConnectableAppSchema = z.strictObject({
  appId: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
  summary: z.string().max(500),
  /** The summary is Tavi's own line for a server that describes itself nowhere: never shown as its author's words. */
  summaryByTavi: z.literal(true).optional(),
  category: z.enum(APP_CATEGORIES),
  /** A bridge path under `/plugin-ui/<id>/<hash>/`, or absent for a monogram. */
  icon: z.string().max(512).optional(),
  publisher: z.string().max(60).optional(),
  source: z.strictObject({
    kind: z.enum(APP_SOURCE_KINDS),
    pluginIds: z.array(z.string().max(128)).max(16),
    preset: z.string().max(64).optional(),
    verified: z.enum(["tavi-preset", "built-in", "reviewed", "unreviewed"]),
    isolation: z.enum(["sandboxed", "unsandboxed", "remote", "in-process"]),
  }),
  auth: AppAuthSchema,
  channel: z.strictObject({ kinds: z.array(z.string().max(32)).max(8), receives: z.boolean(), sends: z.boolean() }).optional(),
  tools: z.array(AppToolViewSchema).max(256),
  egress: z.strictObject({ hosts: z.array(z.string().max(256)).max(64), lan: z.boolean(), anyNetwork: z.boolean() }),
  /** Names only; `raw` is a credential handed over as itself (`rawSecrets`). */
  credentials: z.array(z.strictObject({ name: z.string().max(128), raw: z.boolean() })).max(32),
  settings: z.array(AppSettingFieldSchema).max(64),
  trust: z.strictObject({ output: z.enum(["untrusted", "trusted"]), source: z.string().max(32), confidentiality: ConfidentialitySchema }),
  accounts: z.array(AppAccountViewSchema).max(32),
  /** Its site profiles, each off until the operator turns it on; absent for an app with none. */
  sites: z.array(AppSiteViewSchema).max(32).optional(),
  health: z.enum(APP_HEALTH),
  repairs: z.array(AppRepairSchema).max(32),
  /** Warnings that are no health state (an MCP tool budget). */
  warnings: z.array(z.string().max(300)).max(8).default([]),
  /**
   * How to make the provider's shared OAuth client, as Tavi's own steps for it, so the page says them
   * without knowing any provider: each step's words and the console page it opens; and whether one is stored.
   */
  clientSetup: z
    .strictObject({
      provider: z.string().max(32),
      title: z.string().max(80),
      steps: z.array(AppClientSetupStepSchema).max(8),
      ready: z.boolean(),
    })
    .optional(),
});
export type ConnectableApp = z.infer<typeof ConnectableAppSchema>;

// ——— the catalog ———

export const CatalogRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preset"), id: z.enum(MCP_PRESET_IDS) }),
  z.strictObject({
    kind: z.literal("registry"),
    name: z.string().min(1).max(256),
    version: z.string().min(1).max(64),
    option: z.string().regex(/^(?:npm|pypi|mcpb|remote)(?:-\d{1,2})?$/),
  }),
  z.strictObject({ kind: z.literal("channel"), providerId: z.string().min(1).max(48) }),
  z.strictObject({ kind: z.literal("installed"), pluginId: z.string().min(1).max(128) }),
]);
export type CatalogRef = z.infer<typeof CatalogRefSchema>;

export const CATALOG_BADGES = ["tavi-preset", "built-in", "own-client", "remote", "runs-here", "unreviewed-listing", "lan"] as const;
export type CatalogBadge = (typeof CATALOG_BADGES)[number];

export const CatalogEntrySchema = z.strictObject({
  ref: CatalogRefSchema,
  name: z.string().min(1).max(256),
  summary: z.string().max(500),
  category: z.enum(APP_CATEGORIES),
  icon: z.string().max(512).optional(),
  auth: z.enum(APP_AUTH_KINDS),
  badges: z.array(z.enum(CATALOG_BADGES)).max(8),
  installed: z.boolean(),
  /** The installed app it is, when it is. */
  appId: z.string().max(128).optional(),
  /** The other ways to add a registry entry (its options). */
  options: z.array(z.string().max(32)).max(16).default([]),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const AppsCatalogSectionSchema = z.strictObject({
  section: z.enum(["presets", "installed", "channels", "registry"]),
  entries: z.array(CatalogEntrySchema).max(200),
});

export const AppsCatalogAnswerSchema = z.strictObject({
  sections: z.array(AppsCatalogSectionSchema).max(4),
  /** The registry's next page, when there is one. */
  cursor: z.string().max(1024).optional(),
  /** Why the registry part is empty (unreachable), in words. */
  registryNote: z.string().max(300).optional(),
});
export type AppsCatalogAnswer = z.infer<typeof AppsCatalogAnswerSchema>;

// ——— activity ———

export const AppActivityRowSchema = z.strictObject({
  /** The effect's key, the approval's id or the call's key, with its kind: unique among an app's rows. */
  id: z.string().max(512),
  at: z.string().max(64),
  taskId: IdSchema,
  toolId: z.string().max(256),
  accountId: z.string().max(256),
  /** `read`: a call of one of its read-only tools, whatever came of it. */
  kind: z.enum(["effect", "approval", "read"]),
  /** An effect's ledger state, an approval's outcome, or `called` for a read. */
  state: z.string().max(32),
  title: z.string().max(300),
});
export type AppActivityRow = z.infer<typeof AppActivityRowSchema>;

export const AppsActivityAnswerSchema = z.strictObject({
  rows: z.array(AppActivityRowSchema).max(200),
  /** Where the next page starts in each source it reads. */
  cursor: z.string().max(1024).optional(),
  /** Always true: reads are listed, though calls recorded without their tool are not. */
  readsListed: z.boolean(),
});
export type AppsActivityAnswer = z.infer<typeof AppsActivityAnswerSchema>;

// ——— the `apps` command ———

const appId = z.string().min(1).max(128);
const accountId = z.string().min(1).max(256);
const flowId = z.string().min(1).max(64);

export const AppsPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list"), workspaceId: IdSchema.default("default") }),
  z.strictObject({ action: z.literal("show"), appId, workspaceId: IdSchema.default("default") }),
  z.strictObject({
    action: z.literal("catalog"),
    query: z.string().max(200).default(""),
    cursor: z.string().max(1024).optional(),
    workspaceId: IdSchema.default("default"),
  }),
  z.strictObject({
    action: z.literal("add"),
    entry: CatalogRefSchema,
    /** A preset that is another way into a server already added (Todoist's sign-in or token): switch that server to it. */
    switch: z.literal(true).optional(),
    workspaceId: IdSchema.default("default"),
  }),
  z.strictObject({
    action: z.literal("configure"),
    appId,
    accountId: accountId.optional(),
    values: z.record(z.string().min(1).max(64), z.union([z.string().max(4096), z.number(), z.boolean()])).default({}),
    /**
     * The provider's client file as its console downloads it (Google's `client_secret_….json`), read for the
     * shared client's id and secret in place of `clientId` and `clientSecret`.
     */
    clientFile: z.string().min(1).max(8192).optional(),
    workspaceId: IdSchema.default("default"),
  }),
  z.strictObject({
    action: z.literal("connect"),
    appId,
    /** Reconnect this account; absent, the app's first account, or a new one with `addAccount`. */
    accountId: accountId.optional(),
    addAccount: z.boolean().default(false),
    via: z.enum(["here", "public", "paste"]),
    origin: z.string().regex(LOOPBACK_ORIGIN_PATTERN).optional(),
    workspaceId: IdSchema.default("default"),
  }),
  /** `workspaceId`: a channel's sign-in is its workspace's; an MCP one needs none. */
  z.strictObject({ action: z.literal("connect-status"), flowId, workspaceId: IdSchema.optional() }),
  /** Paste-back: the address the browser landed on, bound to this flow's `state`. */
  z.strictObject({ action: z.literal("connect-finish"), flowId, address: z.string().min(1).max(8192), workspaceId: IdSchema.optional() }),
  z.strictObject({ action: z.literal("connect-cancel"), flowId, workspaceId: IdSchema.optional() }),
  z.strictObject({ action: z.literal("test"), appId, accountId, workspaceId: IdSchema.default("default") }),
  z.strictObject({
    action: z.literal("permission"),
    appId,
    toolId: z.string().min(1).max(256),
    target: z.enum(APP_PERMISSION_TARGETS),
    workspaceId: IdSchema.default("default"),
  }),
  z.strictObject({
    action: z.literal("activity"),
    appId,
    accountId: accountId.optional(),
    cursor: z.string().max(1024).optional(),
    workspaceId: IdSchema.default("default"),
  }),
  z.strictObject({
    action: z.literal("sharing"),
    appId,
    accountId,
    sharing: z.enum(APP_SHARING),
    workspaceId: IdSchema.default("default"),
  }),
  z.strictObject({
    action: z.literal("disconnect"),
    appId,
    accountId,
    remove: z.boolean().default(false),
    workspaceId: IdSchema.default("default"),
  }),
  z.strictObject({ action: z.literal("remove"), appId, workspaceId: IdSchema.default("default") }),
  /** *Not now* for one task's connect need: only that task's wait settles, `declined`. */
  z.strictObject({ action: z.literal("decline-connect"), waitId: IdSchema, workspaceId: IdSchema.default("default") }),
  /** What the agent may do in an account's mailbox. */
  z.strictObject({
    action: z.literal("mailbox"),
    appId,
    accountId,
    mailbox: z.enum(APP_MAILBOX_ACCESS),
    workspaceId: IdSchema.default("default"),
  }),
  /** Whether a channel account takes messages in: off, it only carries what its other opt-ins use (a mailbox, a calendar). */
  z.strictObject({ action: z.literal("receive"), appId, accountId, on: z.boolean(), workspaceId: IdSchema.default("default") }),
  /** Whether the agent may use an account's calendar. */
  z.strictObject({ action: z.literal("calendar"), appId, accountId, on: z.boolean(), workspaceId: IdSchema.default("default") }),
  /** A site profile the app may browse: off until the operator turns it on. */
  z.strictObject({
    action: z.literal("sites"),
    appId,
    siteId: z.string().min(1).max(40),
    on: z.boolean(),
    workspaceId: IdSchema.default("default"),
  }),
]);
export type AppsPayload = z.infer<typeof AppsPayloadSchema>;

/** `connect`'s answer: where to send the browser, and the flow to poll or finish. */
/** A device sign-in's code, as the person enters it (RFC 8628 §3.2). */
export const AppDeviceCodeSchema = z.strictObject({
  userCode: z.string().min(1).max(64),
  verificationUri: z.string().url().max(2048),
  /** When the code stops working. */
  expiresAt: z.string().max(64),
});
export type AppDeviceCode = z.infer<typeof AppDeviceCodeSchema>;

export const AppsConnectAnswerSchema = z.strictObject({
  flowId,
  authorizeUrl: z.string().url().max(8192),
  /** The redirect the client must have registered, shown with a copy button. */
  redirectUri: z.string().max(2048),
  via: z.enum(["here", "public", "paste"]),
  /** The account signing in: a new one when `addAccount` added it. */
  accountId: z.string().max(256),
  /**
   * A sign-in by code (RFC 8628): the code to enter at `verificationUri` on any device. Then
   * `authorizeUrl` is that address too (with the code in it when the provider gives one), and nothing comes back to a redirect.
   */
  device: AppDeviceCodeSchema.optional(),
});
export type AppsConnectAnswer = z.infer<typeof AppsConnectAnswerSchema>;

export const APP_CONNECT_STATES = ["pending", "done", "failed", "expired"] as const;
export const AppsConnectStatusSchema = z.strictObject({
  state: z.enum(APP_CONNECT_STATES),
  message: z.string().max(500).optional(),
  accountId: z.string().max(256).optional(),
  identity: z.string().max(254).optional(),
});
export type AppsConnectStatus = z.infer<typeof AppsConnectStatusSchema>;

/** Every app the workspace holds, worst health first. */
export const AppsListAnswerSchema = z.strictObject({ apps: z.array(ConnectableAppSchema).max(256) });
export type AppsListAnswer = z.infer<typeof AppsListAnswerSchema>;
