import { z } from "zod";

import { SUPPORTED_LOCALES } from "./i18n.js";
import { coreEnglish, type CoreT } from "./locales/core.js";
import { PLUGIN_ID_PATTERN, PluginVersionSchema } from "./plugin-ids.js";
import { PLUGIN_MESSAGES_MAX, PluginMessageKeySchema, PluginMessageSchema } from "./plugin-messages.js";

/**
 * UI plugins: what a plugin's
 * manifest may contribute to the web canvas, and where.
 *
 * The host owns every hook — the slots a contribution can be placed in, the
 * roles one can fill, the data channels it can receive — and a plugin only
 * declares which it uses. Its document runs in a sandboxed, opaque-origin
 * iframe and talks to the canvas through the `tavi.ui/1` message ABI only; it
 * never runs in the canvas's own document. A UI-only plugin runs no owner
 * code at all.
 */

export const PLUGIN_UI_ABI = "tavi.ui/1";

/**
 * Data a contribution may receive. `browser.live`: live frames and addresses of
 * the agent's pages; `browser.control`: driving a page the operator took over;
 * `mod.state`: what the plugin's own code publishes for the chat in view
 * (`ui.publish`), each message `{ key, value }`.
 */
export const PLUGIN_UI_CHANNELS = ["browser.live", "browser.control", "mod.state"] as const;
export const PluginUiChannelSchema = z.enum(PLUGIN_UI_CHANNELS);
export type PluginUiChannel = z.infer<typeof PluginUiChannelSchema>;

/**
 * What the operator is told before a plugin may receive its channels: its
 * own disclosure, and for `browser.control` what that asks for —
 * driving pages the operator takes over, sign-in pages included. Tavi's own
 * takeover surface is the one that drives them, so the operator is told the
 * plugin is not given them: the channel is declared, never delivered.
 */
export function channelDisclosure(channels: readonly PluginUiChannel[], disclosure: string | undefined, t: CoreT = coreEnglish): string {
  const said = disclosure ?? t("plugin.ui.channels.receives", { channels: channels.join(", ") });
  if (!channels.includes("browser.control")) return said;
  // Two whole sentences: the plugin's own (or what it receives), then what control asks for.
  return `${said} ${t("plugin.ui.channels.control")}`;
}

/** Exclusive roles: one plugin fills each per workspace (`uiRoles`), as the router fills its slot. */
export const PLUGIN_UI_ROLES = ["browser-view"] as const;
export const PluginUiRoleSchema = z.enum(PLUGIN_UI_ROLES);
export type PluginUiRole = z.infer<typeof PluginUiRoleSchema>;

/** Where a contribution can be shown. */
/** `onboarding.step`: an onboarding flow plugin's own explanatory step on the canvas's Welcome, receiving no channel. */
export const PLUGIN_UI_SLOTS = [
  "chat.panel.top",
  "chat.panel.tab",
  "overlay.takeover",
  "center.browser",
  "center.heartbeat",
  "onboarding.step",
] as const;
export const PluginUiSlotSchema = z.enum(PLUGIN_UI_SLOTS);
export type PluginUiSlot = z.infer<typeof PluginUiSlotSchema>;

/** `while-active`: only while a session of the chat's task tree is open and its task running, then its last frame for a moment. */
export const PLUGIN_UI_SHOW = ["while-active", "always"] as const;

/** The built-in browser view's id: the role's default. */
export const BUILTIN_BROWSER_VIEW_PLUGIN = "tavi.browserview";

/** Contributions one plugin may declare. */
export const PLUGIN_UI_MAX_CONTRIBUTIONS = 8;

/** A path inside the plugin's snapshot: relative, no `..`, no leading slash, ending in one of `extensions`. */
export function snapshotPath(extensions: readonly string[], what: string) {
  const pattern = new RegExp(`^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9_./-]+\\.(?:${extensions.join("|")})$`);
  return z
    .string()
    .max(256)
    .regex(pattern, `${what} is a relative ${extensions.map((extension) => `.${extension}`).join(" or ")} path inside the plugin`);
}

export const PluginUiHeightSchema = z
  .strictObject({
    min: z.number().int().min(48).max(2000),
    default: z.number().int().min(48).max(2000),
    max: z.number().int().min(48).max(2000),
  })
  .refine((height) => height.min <= height.default && height.default <= height.max, "height needs min ≤ default ≤ max");

export const PluginUiPlacementSchema = z.strictObject({
  slot: PluginUiSlotSchema,
  show: z.enum(PLUGIN_UI_SHOW).optional(),
  height: PluginUiHeightSchema.optional(),
});
export type PluginUiPlacement = z.infer<typeof PluginUiPlacementSchema>;

export const ContributionIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/, "a contribution id is a lower-case slug");

export const PluginUiContributionSchema = z
  .strictObject({
    id: ContributionIdSchema,
    role: PluginUiRoleSchema.optional(),
    title: z.string().min(1).max(40),
    icon: snapshotPath(["svg", "png"], "icon").optional(),
    document: snapshotPath(["html"], "document"),
    channels: z.array(PluginUiChannelSchema).max(PLUGIN_UI_CHANNELS.length).default([]),
    placements: z.array(PluginUiPlacementSchema).min(1).max(PLUGIN_UI_SLOTS.length),
    /** What the operator is told the contribution receives; required with any channel. */
    disclosure: z.string().min(1).max(500).optional(),
  })
  .superRefine((contribution, context) => {
    if (contribution.channels.length > 0 && contribution.disclosure === undefined) {
      context.addIssue({
        code: "custom",
        path: ["disclosure"],
        message: "a contribution that receives a channel says what it receives (disclosure)",
      });
    }
    if (new Set(contribution.channels).size !== contribution.channels.length)
      context.addIssue({ code: "custom", path: ["channels"], message: "a channel is listed twice" });
    if (new Set(contribution.placements.map((placement) => placement.slot)).size !== contribution.placements.length) {
      context.addIssue({ code: "custom", path: ["placements"], message: "a slot is listed twice" });
    }
    // Setup's frame is told nothing: no live page, no published state, no secret.
    if (contribution.placements.some((placement) => placement.slot === "onboarding.step") && contribution.channels.length > 0) {
      context.addIssue({ code: "custom", path: ["channels"], message: "an onboarding.step contribution receives no channel" });
    }
    if (contribution.channels.includes("browser.control") && !contribution.channels.includes("browser.live")) {
      context.addIssue({
        code: "custom",
        path: ["channels"],
        message: "browser.control needs browser.live: a page is driven only while it is seen",
      });
    }
  });
export type PluginUiContribution = z.infer<typeof PluginUiContributionSchema>;

/** A manifest's `ui` block. */
export const PluginUiSchema = z
  .strictObject({
    abi: z.literal(PLUGIN_UI_ABI),
    contributions: z.array(PluginUiContributionSchema).min(1).max(PLUGIN_UI_MAX_CONTRIBUTIONS),
  })
  .superRefine((ui, context) => {
    if (new Set(ui.contributions.map((contribution) => contribution.id)).size !== ui.contributions.length) {
      context.addIssue({ code: "custom", path: ["contributions"], message: "a contribution id is used twice" });
    }
  });
export type PluginUi = z.infer<typeof PluginUiSchema>;

/** A plugin snapshot's sha256, as the registry records it: what a `/plugin-ui/` URL is keyed by. */
export const PluginContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/, "expected a sha256 hex digest");

/** The language a canvas shows a contribution in: one Tavi has a pack for. */
export const PluginUiLocaleSchema = z.enum(SUPPORTED_LOCALES);

/**
 * A contribution's own words in one language, as the host resolved them from
 * the plugin's verified language packs (`locales/<lang>.json` `messages`): that
 * language's message for each key, else its English pack's. A string with
 * `{param}`s, or a plural object chosen by a count; held to a pack's own shape and bounds.
 */
export const PluginUiMessagesSchema = z
  .record(PluginMessageKeySchema, PluginMessageSchema)
  .refine((messages) => Object.keys(messages).length <= PLUGIN_MESSAGES_MAX, "too many messages");
export type PluginUiMessages = z.infer<typeof PluginUiMessagesSchema>;

/** One plugin's contributions the canvas may load: what `plugins ui` answers. */
export const PluginUiEntrySchema = z.strictObject({
  pluginId: z.string().min(3).max(64).regex(PLUGIN_ID_PATTERN),
  kind: z.enum(["builtin", "external"]),
  /** The approved version that runs; absent for a built-in. A directory name, so held to the version shape. */
  version: PluginVersionSchema.optional(),
  contentHash: PluginContentHashSchema,
  ui: PluginUiSchema,
  /**
   * The language `messages` (and the overlaid `ui` titles) are in: the
   * workspace's, for the canvas, when it is not English. Absent: English as installed.
   */
  locale: PluginUiLocaleSchema.optional(),
  /** Its own words in `locale`, from its hash-verified language packs; absent when it has none. */
  messages: PluginUiMessagesSchema.optional(),
});
export type PluginUiEntry = z.infer<typeof PluginUiEntrySchema>;

/**
 * An installed plugin's app icons the canvas may load: its enabled,
 * approved version's `apps` block icons, served
 * from the same hash-pinned snapshot as a UI contribution's files, and nothing
 * else of it.
 */
export const PluginAppIconsEntrySchema = z.strictObject({
  pluginId: z.string().min(3).max(64).regex(PLUGIN_ID_PATTERN),
  version: PluginVersionSchema,
  contentHash: PluginContentHashSchema,
  paths: z
    .array(snapshotPath(["svg", "png"], "an icon"))
    .min(1)
    .max(4),
});
export type PluginAppIconsEntry = z.infer<typeof PluginAppIconsEntrySchema>;

export const PluginUiAnswerSchema = z.strictObject({
  entries: z.array(PluginUiEntrySchema).max(256),
  icons: z.array(PluginAppIconsEntrySchema).max(256).optional(),
});
export type PluginUiAnswer = z.infer<typeof PluginUiAnswerSchema>;

/** Where a contribution's file is served: `/plugin-ui/<id>/<hash>/<path>`. */
export const PLUGIN_UI_PATH_PREFIX = "/plugin-ui/";
export function pluginUiUrl(entry: Pick<PluginUiEntry, "pluginId" | "contentHash">, path: string): string {
  return `${PLUGIN_UI_PATH_PREFIX}${entry.pluginId}/${entry.contentHash}/${path}`;
}

/** Every file a `ui` block names, for the install to check they exist. */
export function pluginUiFiles(ui: PluginUi): readonly string[] {
  return [
    ...new Set(
      ui.contributions.flatMap((contribution) => [contribution.document, ...(contribution.icon === undefined ? [] : [contribution.icon])]),
    ),
  ];
}

/** How a contribution is listed for review: `id (role) → slots; channels; disclosure`. */
export function describePluginUiContribution(contribution: PluginUiContribution, t: CoreT = coreEnglish): string {
  const name =
    contribution.role === undefined
      ? contribution.id
      : t("plugin.ui.contribution.withRole", { id: contribution.id, role: contribution.role });
  const slots = contribution.placements.map((placement) => placement.slot).join(", ");
  const channels =
    contribution.channels.length === 0
      ? t("plugin.ui.contribution.noChannels")
      : t("plugin.ui.contribution.receives", { channels: contribution.channels.join(", ") });
  return contribution.disclosure === undefined
    ? t("plugin.ui.contribution.line", { name, slots, channels })
    : t("plugin.ui.contribution.lineDisclosure", { name, slots, channels, disclosure: contribution.disclosure });
}

// ---------------------------------------------------------------------------
// Workspace settings: which plugin fills a role, and where contributions go.
// ---------------------------------------------------------------------------

/** `uiRoles`: per role, a plugin id (built-in or external, dotted lower case) or `off`. Absent: the built-in. */
export const UiRolesSettingSchema = z.partialRecord(
  PluginUiRoleSchema,
  z.union([z.literal("off"), z.string().min(3).max(64).regex(PLUGIN_ID_PATTERN, "expected a plugin id such as acme.browserview, or off")]),
);
export type UiRolesSetting = z.infer<typeof UiRolesSettingSchema>;

/** A contribution's key in `uiPlacements`: `<pluginId>/<contributionId>`. */
export const UiContributionKeySchema = z
  .string()
  .min(3)
  .max(170)
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z][a-z0-9-]*$/, "expected <plugin-id>/<contribution-id>");

/** `uiPlacements`: per contribution, the slots the operator chose instead of the manifest's, or `hidden`. */
export const UiPlacementsSettingSchema = z
  .record(
    UiContributionKeySchema,
    z.union([z.literal("hidden"), z.strictObject({ slots: z.array(PluginUiPlacementSchema).min(1).max(PLUGIN_UI_SLOTS.length) })]),
  )
  .refine((placements) => Object.keys(placements).length <= 64, "at most 64 placement overrides");
export type UiPlacementsSetting = z.infer<typeof UiPlacementsSettingSchema>;

/**
 * A contribution placed in `slots` instead of its manifest's places: a slot
 * it already had keeps its height and timing; `show` (when a top slot shows)
 * applies to `chat.panel.top` only.
 */
export function uiPlacementsFor(
  slots: readonly PluginUiSlot[],
  manifest: readonly PluginUiPlacement[],
  show?: PluginUiPlacement["show"],
): PluginUiPlacement[] {
  return slots.map((slot) => {
    const own = manifest.find((placement) => placement.slot === slot);
    const when = slot === "chat.panel.top" ? (show ?? own?.show) : own?.show;
    return { slot, ...(own?.height === undefined ? {} : { height: own.height }), ...(when === undefined ? {} : { show: when }) };
  });
}

/** A contribution as a slot shows it. */
export interface ResolvedContribution {
  readonly pluginId: string;
  readonly contentHash: string;
  readonly builtin: boolean;
  readonly contribution: PluginUiContribution;
  /** Where it shows: the operator's choice, else its manifest's. */
  readonly placements: readonly PluginUiPlacement[];
  /** The language its entry was served in (`PluginUiEntry.locale`). */
  readonly locale?: PluginUiEntry["locale"];
  /** Its plugin's own words in `locale` (`PluginUiEntry.messages`), for its `init`. */
  readonly messages?: PluginUiMessages;
}

/** A role whose chosen plugin could not fill it, so the built-in (or nothing) does. */
export interface RoleFallback {
  readonly role: PluginUiRole;
  readonly wanted: string;
  /** The plugin that fills it instead; absent when not even the built-in can. */
  readonly using?: string;
}

/** The built-in that fills each role when nothing else is chosen. */
export const BUILTIN_ROLE_PLUGINS: Readonly<Record<PluginUiRole, string>> = { "browser-view": BUILTIN_BROWSER_VIEW_PLUGIN };

/**
 * Which contributions show where, for the canvas and `tavi plugins ui`
 * alike: the owner's loadable contributions (`plugins ui`), narrowed by the
 * workspace's roles and placements.
 *
 * - **Roles are exclusive.** A contribution that declares a role shows only
 *   when its plugin fills that role: the one `uiRoles` names, else the
 *   built-in. `off` shows none. A named plugin that cannot fill it — not
 *   loadable now (disabled, rejected, removed) or not declaring the role —
 *   falls back to the built-in, and the fallback is reported.
 * - **A contribution without a role is additive**: every one shows.
 * - **Placements.** `uiPlacements["<plugin>/<contribution>"]` replaces the
 *   manifest's slots, or hides the contribution.
 */
export function resolveContributions(
  entries: readonly PluginUiEntry[],
  settings: { readonly uiRoles?: UiRolesSetting | undefined; readonly uiPlacements?: UiPlacementsSetting | undefined },
): { readonly contributions: readonly ResolvedContribution[]; readonly fallbacks: readonly RoleFallback[] } {
  const declares = (pluginId: string, role: PluginUiRole): boolean =>
    entries.some((entry) => entry.pluginId === pluginId && entry.ui.contributions.some((contribution) => contribution.role === role));
  const fallbacks: RoleFallback[] = [];
  const filling = new Map<PluginUiRole, string | undefined>();
  for (const role of PLUGIN_UI_ROLES) {
    const wanted = settings.uiRoles?.[role];
    const builtin = BUILTIN_ROLE_PLUGINS[role];
    const fallback = declares(builtin, role) ? builtin : undefined;
    if (wanted === "off") filling.set(role, undefined);
    else if (wanted === undefined || declares(wanted, role)) filling.set(role, wanted ?? fallback);
    else {
      filling.set(role, fallback);
      fallbacks.push({ role, wanted, ...(fallback === undefined ? {} : { using: fallback }) });
    }
  }
  const contributions: ResolvedContribution[] = [];
  for (const entry of entries) {
    for (const contribution of entry.ui.contributions) {
      if (contribution.role !== undefined && filling.get(contribution.role) !== entry.pluginId) continue;
      const override = settings.uiPlacements?.[`${entry.pluginId}/${contribution.id}`];
      if (override === "hidden") continue;
      contributions.push({
        pluginId: entry.pluginId,
        contentHash: entry.contentHash,
        builtin: entry.kind === "builtin",
        contribution,
        // A person's placement may not put a contribution that receives anything in setup's slot.
        placements: (override?.slots ?? contribution.placements).filter(
          (placement) => placement.slot !== "onboarding.step" || contribution.channels.length === 0,
        ),
        ...(entry.locale === undefined ? {} : { locale: entry.locale }),
        ...(entry.messages === undefined ? {} : { messages: entry.messages }),
      });
    }
  }
  return { contributions, fallbacks };
}

// ---------------------------------------------------------------------------
// The `tavi.ui/1` message ABI: what the canvas and a plugin's iframe
// say to each other by `postMessage`, both directions validated per message.
// ---------------------------------------------------------------------------

/** The largest message a plugin may send the host, as serialized JSON. */
export const PLUGIN_UI_MAX_MESSAGE_BYTES = 64 * 1024;
/** Messages a plugin may send per second before the host pauses it. */
export const PLUGIN_UI_MAX_MESSAGES_PER_SECOND = 200;
/** How long a hidden contribution keeps its watch before the host ends it. */
export const PLUGIN_UI_HIDDEN_UNWATCH_MS = 2_000;

/**
 * The canvas's theme variables a plugin gets, as the canvas computes them: an
 * iframe cannot read its parent's CSS. Colours are HSL components
 * (`120 14% 96%`, for `hsl(var(--primary) / var(--tint-medium))`); the type
 * scale, spacing, radii and icon sizes are lengths; weights, leadings and
 * opacities are numbers; durations are times; the `--line-*` hairlines are
 * whole colours; `--tint-*` and `--alpha-*` are the alpha steps a colour
 * takes. Fonts are not passed but for `--font-system` and `--font-mono`,
 * stacks of system faces: a plugin uses them or ships its own.
 * `plugin-base.css` defines every one, light and dark, for a page shown
 * before (or without) the host's.
 */
export const PLUGIN_UI_THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--destructive",
  "--positive",
  "--warning",
  "--info",
  "--border",
  "--ring",
  "--font-mono",
  "--radius",
  "--radius-lg",
  "--radius-sm",
  "--radius-xs",
  "--radius-2xs",
  "--radius-xl",
  "--radius-full",
  "--text-2xs",
  "--text-xs",
  "--text-sm",
  "--text-meta",
  "--text-base",
  "--text-md",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
  "--text-3xl",
  "--text-4xl",
  "--weight-regular",
  "--weight-medium",
  "--weight-strong",
  "--weight-semibold",
  "--weight-bold",
  "--space-0-5",
  "--space-1",
  "--space-1-5",
  "--space-2",
  "--space-2-5",
  "--space-3",
  "--space-3-5",
  "--space-4",
  "--space-4-5",
  "--space-5",
  "--space-6",
  "--space-7",
  "--space-8",
  "--space-10",
  "--space-12",
  "--font-system",
  "--text-5xl",
  "--leading-none",
  "--leading-tight",
  "--leading-snug",
  "--leading-normal",
  "--leading-relaxed",
  "--leading-4",
  "--leading-4-5",
  "--leading-5",
  "--duration-fast",
  "--duration-base",
  "--duration-slow",
  "--duration-pulse",
  "--duration-bounce",
  "--duration-ping",
  "--ease-standard",
  "--ease-out",
  "--ease-in-out",
  "--line-strong",
  "--line-firm",
  "--line",
  "--line-soft",
  "--line-faint",
  "--line-fainter",
  "--line-faintest",
  "--tint-subtle",
  "--tint-soft",
  "--tint-medium",
  "--tint-strong",
  "--tint-heavy",
  "--alpha-faint",
  "--alpha-half",
  "--alpha-muted",
  "--alpha-strong",
  "--alpha-firm",
  "--alpha-hover",
  "--opacity-faint",
  "--opacity-disabled",
  "--opacity-soft",
  "--opacity-muted",
  "--radius-round",
  "--icon-size",
  "--icon-size-sm",
  "--icon-size-xs",
  "--icon-size-2xs",
  "--stripe-width",
  "--stripe-width-lg",
  "--border-width",
  "--border-width-thick",
  "--outline-width",
  "--space-px",
] as const;

/** Host shortcuts a plugin may forward (they would otherwise stop at the iframe): Escape, and the panel toggle. */
export const PLUGIN_UI_SHORTCUTS = ["Escape", "toggle-panel"] as const;
export type PluginUiShortcut = (typeof PLUGIN_UI_SHORTCUTS)[number];

const Abi = z.literal(PLUGIN_UI_ABI);
const Px = z.number().int().min(0).max(100_000);

export const PluginUiContextSchema = z.strictObject({
  workspaceId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).optional(),
});
export type PluginUiContext = z.infer<typeof PluginUiContextSchema>;

export const PluginUiThemeSchema = z.strictObject({
  tokens: z.record(
    z
      .string()
      .regex(/^--[a-z0-9-]+$/)
      .max(48),
    z.string().max(200),
  ),
  colorScheme: z.enum(["light", "dark"]),
});
export type PluginUiTheme = z.infer<typeof PluginUiThemeSchema>;

/** What the host sends a plugin. `channel` messages carry only channels the contribution declared and was granted. */
export const HostToPluginMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    abi: Abi,
    type: z.literal("init"),
    pluginId: z.string().min(3).max(64).regex(PLUGIN_ID_PATTERN),
    contributionId: ContributionIdSchema,
    slot: PluginUiSlotSchema,
    context: PluginUiContextSchema,
    channels: z.array(PluginUiChannelSchema).max(PLUGIN_UI_CHANNELS.length),
    theme: PluginUiThemeSchema,
    size: z.strictObject({ width: Px, height: Px }),
    reducedMotion: z.boolean(),
    visible: z.boolean(),
    /** The canvas's language. Absent from an older host: English. */
    locale: PluginUiLocaleSchema.optional(),
    /** The plugin's own words in `locale`, from its verified language packs; absent when it has none for it. */
    messages: PluginUiMessagesSchema.optional(),
  }),
  z.strictObject({ abi: Abi, type: z.literal("theme"), theme: PluginUiThemeSchema }),
  /** The canvas's language changed: the new one, and the plugin's words in it (absent: none, so its English). */
  z.strictObject({ abi: Abi, type: z.literal("locale"), locale: PluginUiLocaleSchema, messages: PluginUiMessagesSchema.optional() }),
  z.strictObject({ abi: Abi, type: z.literal("size"), width: Px, height: Px }),
  z.strictObject({ abi: Abi, type: z.literal("visibility"), visible: z.boolean() }),
  z.strictObject({ abi: Abi, type: z.literal("context"), context: PluginUiContextSchema }),
  z.strictObject({
    abi: Abi,
    type: z.literal("channel"),
    channel: PluginUiChannelSchema,
    seq: z.number().int().nonnegative(),
    message: z.unknown(),
  }),
]);
export type HostToPluginMessage = z.infer<typeof HostToPluginMessageSchema>;

/** Where a plugin may ask the host to go; the host navigates, a plugin cannot open URLs or windows. */
export const PluginUiNavigationSchema = z.discriminatedUnion("to", [
  z.strictObject({ to: z.literal("tool-call"), callId: z.string().min(1).max(256) }),
  z.strictObject({ to: z.literal("center.browser") }),
  z.strictObject({ to: z.literal("slot"), slot: PluginUiSlotSchema }),
]);
export type PluginUiNavigation = z.infer<typeof PluginUiNavigationSchema>;

/** What a plugin sends the host. Anything else, or anything malformed, is dropped. */
export const PluginToHostMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ abi: Abi, type: z.literal("ready") }),
  z.strictObject({
    abi: Abi,
    type: z.literal("watch"),
    channel: PluginUiChannelSchema,
    sessionId: z.string().min(1).max(128).optional(),
    maxWidth: z.number().int().positive().max(4096).optional(),
  }),
  z.strictObject({ abi: Abi, type: z.literal("unwatch"), channel: PluginUiChannelSchema }),
  z.strictObject({ abi: Abi, type: z.literal("ack"), seq: z.number().int().nonnegative() }),
  z.strictObject({ abi: Abi, type: z.literal("requestHeight"), px: Px }),
  z.strictObject({ abi: Abi, type: z.literal("badge"), count: z.number().int().min(0).max(999).optional(), dot: z.boolean().optional() }),
  z.strictObject({ abi: Abi, type: z.literal("navigate"), target: PluginUiNavigationSchema }),
  z.strictObject({ abi: Abi, type: z.literal("shortcut"), key: z.enum(PLUGIN_UI_SHORTCUTS) }),
]);
export type PluginToHostMessage = z.infer<typeof PluginToHostMessageSchema>;
