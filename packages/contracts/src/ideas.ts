import { z } from "zod";

import type { MemoryExcerpt } from "./heartbeat.js";
import type { AsyncRepository } from "./persistence-types.js";

import { IdSchema, TimestampSchema } from "./ids.js";
import { defineProviderError } from "./util.js";

/**
 * Ideas: things Tavi offers to do for a person,
 * written for them, grounded in what it knows of them and checked against
 * what it can do. Generative and never urgent — Heartbeat stays the responsive
 * surface. One ranked pool feeds the Ideas tab, the empty chat's
 * suggested prompts and the opt-in channel digest, so a dismissal anywhere is
 * a dismissal everywhere.
 *
 * Who writes the ideas is a **provider**: the built-in one or any
 * approved plugin (`provides: ["ideas"]`), chosen per workspace. The host owns
 * everything around it — what the provider is given, the capability census,
 * validation, the ledger, storage and delivery — so a provider can be
 * replaced without weakening any of the rules here.
 */

// ------------------------------------------------------------------ limits

/** Active ideas one workspace holds at once. */
export const IDEA_MAX_ACTIVE = 12;
/** Ideas the tab's "For you" list shows. */
export const IDEA_FOR_YOU_MAX = 4;
/** Suggested prompts one empty chat shows (the "Continue" chip counts toward them). */
export const IDEA_CHIPS_MAX = 3;
/** How long an unpinned idea stays active. */
export const IDEA_TTL_MS = 7 * 24 * 60 * 60_000;
/** *Not now*. */
export const IDEA_SNOOZE_MS = 7 * 24 * 60 * 60_000;
/** The tokens a workspace's ideas runs may spend in a local day, unless its settings say otherwise. */
export const IDEA_DAILY_TOKENS_DEFAULT = 20_000;
/** The longest answer one model turn may write. */
export const IDEA_TURN_MAX_OUTPUT_TOKENS = 2_000;
/** The window the category priors read. */
export const IDEA_PRIOR_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** The week auto-volume reads its acceptance over. */
export const IDEA_ACCEPTANCE_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Auto-volume: below 10 % of shown ideas tried, the run asks for half as many (not under 4); above 40 %, twice as many (up to 12). */
export const IDEA_VOLUME_MIN = 4;
export const IDEA_VOLUME_LOW = 0.1;
export const IDEA_VOLUME_HIGH = 0.4;
/** Fewer shown than this in the window says nothing about acceptance: the volume stays. */
export const IDEA_VOLUME_MIN_SHOWN = 8;

/**
 * A prepared first step: up to `IDEA_PREPARE_PER_DAY` top
 * ideas a day whose every use is one of these read-only capabilities, whose
 * every basis is `general`, with no [part] left to fill, are run once ahead
 * of time — read-only tools only, unattended, under the lower of
 * `IDEA_PREPARE_DAILY_TOKENS` and the workspace's `dailyTokens` — and the
 * answer given to the first turn of the chat *Try it* starts for
 * `IDEA_PREPARED_FRESH_MS`.
 */
export const IDEA_PREPARABLE_CAPABILITIES = ["web", "places", "trends", "jobs", "travel"] as const;
export const IDEA_PREPARE_PER_DAY = 2;
export const IDEA_PREPARE_DAILY_TOKENS = 40_000;
export const IDEA_PREPARED_FRESH_MS = 24 * 60 * 60_000;
/** A prepared answer's length: what the first turn of the chat *Try it* starts is given of it. */
export const IDEA_PREPARED_TEXT_MAX = 1_600;
/** The steps a prepared run may take. */
export const IDEA_PREPARE_MAX_STEPS = 6;
/**
 * What one prepared run may spend, at worst — every step's answer at its cap,
 * and the pages it read — reserved against the day's tokens before it starts,
 * so no run starts that could carry the day past them. A run that spends
 * past it anyway is cancelled.
 */
export const IDEA_PREPARE_RUN_RESERVE_TOKENS = 15_000;
/** A prepared answer this old is looked up again by the day's run, before it goes stale: one a day stays fresh. */
export const IDEA_PREPARE_AGAIN_MS = 20 * 60 * 60_000;

/**
 * The weekly digest: at most this many ideas. One reply in its
 * chat picks one: `try 2` for a week after, a bare `2` only within a day (a
 * later bare number answers something else).
 */
export const IDEA_DIGEST_MAX = 3;
export const IDEA_DIGEST_REPLY_MS = 7 * 24 * 60 * 60_000;
export const IDEA_DIGEST_BARE_REPLY_MS = 24 * 60 * 60_000;

/** The model turns one run may take; the rest are refused as over budget. */
export const IDEA_TURNS_PER_RUN = 3;
/** The longest system or user text a turn may send. */
export const IDEA_TURN_INPUT_MAX = 32_000;

/** An idea counts as shown once in this long, however many refreshes offer it meanwhile. */
export const IDEA_SHOWN_EVERY_MS = 20 * 60 * 60_000;
/** A key shown on this many days and never opened is suppressed for `IDEA_IGNORED_SUPPRESS_MS`. */
export const IDEA_IGNORED_RUNS = 3;
export const IDEA_IGNORED_SUPPRESS_MS = 14 * 24 * 60 * 60_000;
/** Refreshes one workspace may ask for in an hour. */
export const IDEA_REFRESH_PER_HOUR = 3;

export const IDEA_TITLE_MAX = 80;
export const IDEA_PITCH_MAX = 320;
export const IDEA_LABEL_MAX = 40;
export const IDEA_PROMPT_MAX = 600;
export const IDEA_BASIS_EXCERPT_MAX = 120;
export const IDEA_BASIS_MAX = 4;
export const IDEA_USES_MAX = 6;
export const IDEA_KEY_MAX = 128;
/** The person's Ideas brief, read verbatim by the generator. */
export const IDEA_BRIEF_MAX = 2_000;

// ------------------------------------------------------------------ vocabulary

/** The tab's sections; the use-case catalogue's 19 domains collapse into these. */
export const IDEA_CATEGORIES = ["productivity", "work", "learning", "health-home", "travel", "shopping", "people"] as const;
export type IdeaCategory = (typeof IDEA_CATEGORIES)[number];
export const IdeaCategorySchema = z.enum(IDEA_CATEGORIES);

/** Each section's heading. */
export const IDEA_CATEGORY_LABELS: Readonly<Record<IdeaCategory, string>> = {
  productivity: "Productivity",
  work: "Work & career",
  learning: "Learning & hobbies",
  "health-home": "Health & home",
  travel: "Travel & errands",
  shopping: "Shopping & style",
  people: "People & culture",
};

/**
 * What an idea needs Tavi to be able to do. The census resolves each
 * against what is installed, enabled and connected; an idea needing one that
 * is missing is never shown.
 */
export const IDEA_CAPABILITIES = [
  "web", // web search and fetch, `http.request`
  "browser", // the agent's browser, with takeover
  "memory",
  "reminders",
  "routines",
  "files", // a working folder under `--fs-root`
  "sandbox",
  "pdf",
  "image", // `artifacts.view_image`
  "video",
  // What plugins prove (a tool's or a channel's `proves`, a mailbox channel's accounts): categories, never plugin names.
  "places", // finding places
  "care", // finding care: clinics, carers
  "jobs", // job search
  "trends", // tracked topics
  "mailbox", // a mail account the agent may search
  "calendar", // the Google Calendar MCP preset
  "travel", // flights and trips
  "home", // smart home: the Home Assistant MCP preset
  "messaging", // a chat channel the agent is reached on
] as const;
export type IdeaCapability = (typeof IDEA_CAPABILITIES)[number];
export const IdeaCapabilitySchema = z.enum(IDEA_CAPABILITIES);

/**
 * What a plugin's tool or channel may declare it proves (`proves`): the categories plugins bring. Tavi's own
 * capabilities (`web`, `browser`, `files`, …) are proven by its own tools only, so no plugin tool joins a prepared
 * step's web search, nor makes Ideas offer what is not installed.
 */
export const IDEA_PLUGIN_CAPABILITIES = ["places", "care", "jobs", "trends", "travel", "mailbox", "calendar", "home", "messaging"] as const;
export const IdeaPluginCapabilitySchema = z.enum(IDEA_PLUGIN_CAPABILITIES);

/** Each capability as a card's *Uses* line names it. */
export const IDEA_CAPABILITY_LABELS: Readonly<Record<IdeaCapability, string>> = {
  web: "Web",
  browser: "Browser",
  memory: "Memory",
  reminders: "Reminders",
  routines: "Routines",
  files: "Files",
  sandbox: "Sandbox",
  pdf: "PDFs",
  image: "Images",
  video: "Video",
  places: "Places",
  care: "Care finder",
  jobs: "Job finder",
  trends: "Trends",
  mailbox: "Mail",
  calendar: "Calendar",
  travel: "Travel",
  home: "Smart home",
  messaging: "Messaging",
};

/** The icons an idea may carry: one emoji each, so a model cannot put arbitrary text in the icon slot. */
export const IDEA_ICONS = [
  "💡",
  "📋",
  "🗂️",
  "📥",
  "📅",
  "🌅",
  "🧾",
  "🔧",
  "💼",
  "📈",
  "🔎",
  "📚",
  "🎓",
  "🗣️",
  "🧠",
  "🎨",
  "🌱",
  "🍳",
  "🎸",
  "📷",
  "🪚",
  "✍️",
  "🏃",
  "🥗",
  "😴",
  "💊",
  "🏠",
  "⚡",
  "♻️",
  "🏘️",
  "🐾",
  "🚗",
  "🚲",
  "✈️",
  "🏨",
  "🚆",
  "⛽",
  "🗺️",
  "🛂",
  "🛒",
  "👕",
  "🧵",
  "🎲",
  "🌳",
  "🎬",
  "🎟️",
  "💬",
  "👋",
  "🩺",
  "🦷",
  "🧒",
  "📰",
] as const;
const withoutVariationSelector = (text: string): string => text.replace(/\uFE0F/gu, "");
/** An icon written without its variation selector (`✈` for `✈️`) is the same icon. */
export const IdeaIconSchema = z.preprocess(
  (value) =>
    typeof value === "string"
      ? (IDEA_ICONS.find((icon) => withoutVariationSelector(icon) === withoutVariationSelector(value)) ?? value)
      : value,
  z.enum(IDEA_ICONS),
);

export const IDEA_STATUSES = ["active", "tried", "done", "snoozed", "dismissed", "expired"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export const IdeaStatusSchema = z.enum(IDEA_STATUSES);

export const IDEA_CADENCES = ["daily", "weekly", "monthly"] as const;
export type IdeaCadence = (typeof IDEA_CADENCES)[number];
export const IdeaCadenceSchema = z.enum(IDEA_CADENCES);

// ------------------------------------------------------------------ the idea

/** A dotted, lower-case dedup key starting with its section: `<category>.<name>[:<subject>]`, e.g. `travel.fare-watch:sofia-lisbon`. */
export const IdeaKeySchema = z
  .string()
  .min(1)
  .max(IDEA_KEY_MAX)
  .regex(/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/, "an idea key is lower-case words joined by . _ - with an optional :subject");

/**
 * The provider's own name for the template an idea came from, opaque to the
 * host: the built-in provider uses the research doc's use-case ids (`6.1`).
 */
export const IdeaTemplateIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/** C0 and C1 controls (but a newline), line and paragraph separators, and bidirectional marks and overrides: never in text a person reads. */
const UNSAFE_TEXT = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/** A prompt the person sent after editing an idea's: kept as an example, held to the same text rules. */
export const IdeaEditedPromptSchema = z
  .string()
  .min(1)
  .max(IDEA_PROMPT_MAX * 2)
  .refine((text) => !UNSAFE_TEXT.test(text), "no control or bidirectional characters");

/** One line of plain text, whatever its source wrote: what the host quotes and reports. */
export function ideaPlainText(text: string): string {
  return text.replace(/\s+/gu, " ").replace(new RegExp(UNSAFE_TEXT.source, "gu"), "").trim();
}
/** Plain text a person reads, trimmed and bounded: no control or bidirectional characters, one line unless `lines` (ideas, onboarding copy, a name). */
export const plainTextSchema = (max: number, lines: boolean) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (text) => !UNSAFE_TEXT.test(text) && (lines || !text.includes("\n")),
      lines ? "no control or bidirectional characters" : "one line, with no control or bidirectional characters",
    );

export const IDEA_BASIS_KINDS = ["memory", "task", "brief", "general"] as const;
export type IdeaBasisKind = (typeof IDEA_BASIS_KINDS)[number];

/**
 * Why an idea was offered: a memory record, a chat's summary, the
 * person's brief, or `general` — nothing personal behind it, which the tab
 * says plainly. The host resolves every personal `ref` against what it gave
 * the provider, and writes the excerpt itself from that source, so a provider
 * can neither cite nor quote what it was not given.
 */
export const IdeaBasisRefSchema = z.string().min(1).max(128);

export const IdeaBasisSchema = z.strictObject({
  kind: z.enum(IDEA_BASIS_KINDS),
  /** A memory record id, a task id, `brief`, or for `general` the idea's template id (or `general`). */
  ref: IdeaBasisRefSchema.refine(
    (ref) => !UNSAFE_TEXT.test(ref) && !ref.includes("\n"),
    "a basis ref has no control or bidirectional characters",
  ),
  excerpt: z
    .string()
    .trim()
    .max(IDEA_BASIS_EXCERPT_MAX)
    .refine(
      (text) => !UNSAFE_TEXT.test(text) && !text.includes("\n"),
      "an excerpt is one line, with no control or bidirectional characters",
    )
    .optional(),
});
export type IdeaBasis = z.infer<typeof IdeaBasisSchema>;

/**
 * What an idea will use, and whether that asks first. The host sets
 * `approval` from the capability itself when it stores the idea, whatever
 * the provider said: a card never says "no approval" for what will ask.
 */
export const IdeaUseSchema = z.strictObject({
  capability: IdeaCapabilitySchema,
  approval: z.boolean(),
});

/**
 * Capabilities that act on the person's behalf beyond Tavi (send, write,
 * submit, switch): an idea using one is always shown as asking first, since
 * those tools ask under the default policy (*Uses*).
 */
/**
 * How long after setup is finished its promise holds: until a scheduled run
 * has generated, for at most this long. Home says
 * it for as long, so the two never disagree; 36 hours covers the next day's
 * window whatever the clock or a restart did.
 */
export const IDEA_FRESH_AFTER_SETUP_MS = 36 * 60 * 60_000;

/**
 * The capability each app preset proves once its tools are registered (the census, and setup's "New with <app>"). A
 * mailbox is proven by its search tool instead, and a calendar by a Google account's list_events tool.
 */
export const IDEA_PRESET_CAPABILITIES: Readonly<Record<string, IdeaCapability>> = {
  homeassistant: "home",
};

export const IDEA_ASKING_CAPABILITIES: readonly IdeaCapability[] = ["browser", "files", "mailbox", "messaging", "home"];

export type IdeaUse = z.infer<typeof IdeaUseSchema>;

const IdeaDraftShape = {
  key: IdeaKeySchema,
  templateId: IdeaTemplateIdSchema.optional(),
  category: IdeaCategorySchema,
  icon: IdeaIconSchema,
  /** A first-person offer: "I can watch Sofia–Lisbon fares…". */
  title: plainTextSchema(IDEA_TITLE_MAX, false),
  pitch: plainTextSchema(IDEA_PITCH_MAX, true),
  /** The chip's text. */
  label: plainTextSchema(IDEA_LABEL_MAX, false),
  /**
   * The starter prompt put in the composer; never sent without the person —
   * save as an idea's prepared first step, an unattended, read-only,
   * tainted run of it.
   */
  prompt: plainTextSchema(IDEA_PROMPT_MAX, true),
  basis: z.array(IdeaBasisSchema).min(1).max(IDEA_BASIS_MAX).readonly(),
  uses: z.array(IdeaUseSchema).min(1).max(IDEA_USES_MAX).readonly(),
  /** Offered as *Make it recurring*. */
  recurring: z.strictObject({ cadence: IdeaCadenceSchema }).optional(),
} as const;

/**
 * A key starts with its section, so dismissing it (by key) and muting its
 * section (by category) agree; and a `general` basis names the idea's
 * own template (or `general`), never free text a provider chose to show.
 */
const keyInSection = (
  idea: { readonly key: string; readonly category: string; readonly templateId?: string | undefined; readonly basis: readonly IdeaBasis[] },
  context: z.core.$RefinementCtx,
): void => {
  if (idea.key.split(/[.:]/u)[0] !== idea.category)
    context.addIssue({ code: "custom", path: ["key"], message: `an idea's key starts with its section, ${idea.category}.` });
  for (const [index, basis] of idea.basis.entries()) {
    if (basis.kind === "general" && basis.ref !== "general" && basis.ref !== idea.templateId)
      context.addIssue({
        code: "custom",
        path: ["basis", index, "ref"],
        message: "a general basis names the idea's templateId, or general",
      });
  }
};

/** An idea as a provider writes it, before the host adds ids, score and status. */
export const IdeaDraftSchema = z.strictObject(IdeaDraftShape).superRefine(keyInSection);
export type IdeaDraft = z.infer<typeof IdeaDraftSchema>;

export const IdeaSchema = z.strictObject({
  ...IdeaDraftShape,
  id: IdSchema,
  workspaceId: IdSchema,
  runId: IdSchema,
  /** The provider that wrote it; a stored idea from before providers names the built-in one. */
  providerId: z.string().min(1).max(128),
  /** 0..1 after ranking; higher first. */
  score: z.number().min(0).max(1),
  status: IdeaStatusSchema,
  pinned: z.boolean(),
  /** Runs that offered this key without the person opening it (*Ignored*). */
  shownRuns: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  snoozedUntil: TimestampSchema.optional(),
  /** Its first step, run ahead of time: the run, its answer and when; absent once a day old. */
  prepared: z.strictObject({ taskId: IdSchema, text: z.string().min(1).max(IDEA_PREPARED_TEXT_MAX), at: TimestampSchema }).optional(),
});
export type Idea = z.infer<typeof IdeaSchema>;

// ------------------------------------------------------------------ feedback

/** What a person (or what they did) said about an idea. */
export const IDEA_SIGNALS = [
  "tried", // *Try it*, from the tab or a chip
  "edited", // sent after editing the prompt
  "done", // the chat it seeded finished
  "ignored", // shown `IDEA_IGNORED_RUNS` times, never opened
  "not-now",
  "not-interested",
  "mute-category",
  "unmute-category",
  "exclude-basis", // *Don't use this* on one basis
  "include-basis",
  "more-like-this",
] as const;
export type IdeaSignal = (typeof IDEA_SIGNALS)[number];
export const IdeaSignalSchema = z.enum(IDEA_SIGNALS);

export const IdeaFeedbackSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  ideaId: IdSchema.optional(),
  key: IdeaKeySchema.optional(),
  category: IdeaCategorySchema.optional(),
  basisRef: IdeaBasisRefSchema.optional(),
  signal: IdeaSignalSchema,
  /** For `edited`: what was sent, an example for the next run. */
  editedPrompt: IdeaEditedPromptSchema.optional(),
  at: TimestampSchema,
});
export type IdeaFeedback = z.infer<typeof IdeaFeedbackSchema>;

// ------------------------------------------------------------------ runs and settings

export const IDEA_RUN_OUTCOMES = ["running", "generated", "unchanged", "skipped", "failed"] as const;
export type IdeaRunOutcome = (typeof IDEA_RUN_OUTCOMES)[number];

export const IDEA_RUN_REASON_MAX = 500;
export const IDEA_RUN_HASH_MAX = 128;

/** One generation; `unchanged` made no model call. */
export const IdeaRunSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  /** The provider asked; absent for a run skipped before one was chosen. */
  providerId: z.string().min(1).max(128).optional(),
  trigger: z.enum(["schedule", "refresh"]),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  outcome: z.enum(IDEA_RUN_OUTCOMES),
  /** Why a run was skipped or failed, in words a person reads. */
  reason: z.string().max(IDEA_RUN_REASON_MAX).optional(),
  inputsHash: z.string().max(IDEA_RUN_HASH_MAX).optional(),
  generated: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type IdeaRun = z.infer<typeof IdeaRunSchema>;

// ------------------------------------------------------------------ providers

/** The built-in provider's plugin id (`@tavi/plugin-defaults/ideas`). */
export const BUILTIN_IDEAS_PROVIDER_ID = "tavi.ideasagent";

/**
 * What a provider may be given: what its manifest's `receives` lists
 * *and* the person's switches allow (`IdeaSettings.sources`; `ledger` has no
 * switch, it is what the person said about ideas). The census of
 * capabilities, the limits and the time are always given.
 */
export const IDEAS_RECEIVES = ["memory", "tasks", "brief", "ledger"] as const;
export type IdeasReceive = (typeof IDEAS_RECEIVES)[number];

/** A recent chat, as its summary has it. */
export interface IdeaTaskExcerpt {
  readonly taskId: string;
  readonly title: string;
  readonly summary?: string;
}

/** A frozen copy; what the provider does not receive is absent. */
export interface IdeasGenerateRequest {
  readonly workspaceId: string;
  readonly now: string;
  readonly timezone: string;
  /** What Tavi can do here now: an idea using anything else is dropped. */
  readonly capabilities: readonly IdeaCapability[];
  /** Approved, normal-sensitivity records of the person's own scopes; a `memory` basis cites a `recordId`. */
  readonly memory?: readonly MemoryExcerpt[];
  /** Recent chats; a `task` basis cites a `taskId`. */
  readonly tasks?: readonly IdeaTaskExcerpt[];
  /** The person's brief, verbatim; a `brief` basis cites `brief`. */
  readonly brief?: string;
  /** What the person steered away from, and the keys active now. */
  readonly ledger?: IdeaLedger & { readonly active: readonly { readonly key: string; readonly category: IdeaCategory }[] };
  readonly limits: { readonly maxIdeas: number; readonly deadlineMs: number };
  /**
   * Present for a provider whose manifest declares `usesTurns`: one
   * metered, tool-less model call on the workspace's `fast` model, within the
   * day's token budget. It refuses with `IdeasProviderError("budget")` past
   * the budget, and `UNAVAILABLE` when no fast model is set; a provider falls
   * back to what it can write without one. What the model writes comes back to
   * the provider as text and is validated like everything it proposes.
   */
  readonly host?: {
    runTurn(input: {
      readonly system: string;
      readonly user: string;
      readonly maxOutputTokens?: number;
    }): Promise<{ readonly text: string }>;
  };
  readonly signal: AbortSignal;
}

/** An idea a provider proposes, with its rank (0..1, higher first). */
export interface ProposedIdea {
  readonly idea: IdeaDraft;
  readonly score: number;
}

export interface IdeasGenerateResult {
  readonly ideas: readonly ProposedIdea[];
}

export interface IdeasProviderStatus {
  readonly ready: boolean;
  readonly detail?: string;
}

/**
 * Writes ideas for one workspace. It never stores, sends or runs anything:
 * the host validates what it proposes (schema, census, basis, ledger) and
 * drops the rest, counting them.
 */
export interface IdeasProvider {
  generate(request: IdeasGenerateRequest): Promise<IdeasGenerateResult>;
  status?(): IdeasProviderStatus;
}

export const IDEAS_PROVIDER_FAILURES = ["transport", "invalid", "budget"] as const;
export type IdeasProviderFailure = (typeof IDEAS_PROVIDER_FAILURES)[number];

/** Thrown by a provider to report a failure; any other throw counts as `transport`. */
export class IdeasProviderError extends defineProviderError<IdeasProviderFailure>() {}

/** The failure a thrown value carries, whatever class it has; `transport` when it carries none. */
export function ideasProviderFailure(error: unknown): IdeasProviderFailure {
  try {
    const reason = (error as { readonly reason?: unknown } | null)?.reason;
    return typeof reason === "string" && (IDEAS_PROVIDER_FAILURES as readonly string[]).includes(reason)
      ? (reason as IdeasProviderFailure)
      : "transport";
  } catch {
    // A thrown value whose `reason` itself throws is still a failure to record.
    return "transport";
  }
}

/** The ideas provider contract a plugin is built for; a change that would break one is a new ABI. */
export const IDEAS_ABI = "tavi.ideas/1";

/** A plugin's ideas provider as its manifest declares it, reviewed before its code runs. */
export const PluginIdeasDeclarationSchema = z.strictObject({
  abi: z.literal(IDEAS_ABI),
  receives: z
    .array(z.enum(IDEAS_RECEIVES))
    .max(IDEAS_RECEIVES.length)
    .refine((receives) => new Set(receives).size === receives.length, "a receive is listed twice"),
  /** Whether its generation may call `host.runTurn`, a metered model turn on the workspace's fast model. */
  usesTurns: z.boolean().default(false),
  /** The longest one generation may take; the host stops it after this. */
  maxRunSeconds: z.number().int().min(1).max(120).default(30),
  /** What the person is told at approval about where their data goes. */
  disclosure: z.string().max(1_000).optional(),
});
export type PluginIdeasDeclaration = z.infer<typeof PluginIdeasDeclarationSchema>;

const IDEAS_RECEIVE_DISCLOSURES: Readonly<Record<IdeasReceive, string>> = {
  memory: "your approved, non-sensitive preferences, facts and lessons",
  tasks: "your recent chats' titles and summaries, and prompts you edited before sending",
  brief: "the ideas brief you write",
  ledger: "which ideas you dismissed, snoozed, muted or asked more of",
};

/** What the person is shown when they review an ideas provider: what it may receive, and that it only proposes. */
export function describeIdeasDeclaration(ideas: z.input<typeof PluginIdeasDeclarationSchema>): string {
  // Every receive but the ledger has a per-workspace switch: said where it applies.
  const receives =
    ideas.receives.length === 0
      ? "nothing of yours: only what Tavi can do here"
      : ideas.receives
          .map((field) => `${IDEAS_RECEIVE_DISCLOSURES[field]}${field === "ledger" ? "" : " (while its switch is on)"}`)
          .join("; ");
  return `Ideas provider: it may receive ${receives}. It proposes ideas only; Tavi checks each one and never lets it send or run anything.${ideas.usesTurns === true ? " It may ask your fast model, within the day's ideas budget." : ""}${ideas.disclosure === undefined ? "" : ` It says: ${ideas.disclosure}`}`;
}

// ------------------------------------------------------------------ settings

/** Which signals the generator may read. Sensitive and run-local memory is never read, whatever these say. */
export const IdeaSourcesSchema = z.strictObject({
  memory: z.boolean(),
  tasks: z.boolean(),
  brief: z.boolean(),
});
export type IdeaSources = z.infer<typeof IdeaSourcesSchema>;

export const IdeaSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** The provider that writes this workspace's ideas, by plugin id. */
  provider: z.string().min(1).max(128).default(BUILTIN_IDEAS_PROVIDER_ID),
  /** How many ideas a run asks for: auto-volume moves it with how many the person takes up; not set by a person. */
  volume: z.number().int().min(IDEA_VOLUME_MIN).max(IDEA_MAX_ACTIVE).default(IDEA_MAX_ACTIVE),
  /** When auto-volume last moved it: it moves at most once a week, on that week's take-up alone. */
  volumeAt: TimestampSchema.optional(),
  /** The tokens its model turns may spend in a local day; past it, a run's turns are refused and it writes without one. */
  dailyTokens: z.number().int().min(0).max(1_000_000).default(IDEA_DAILY_TOKENS_DEFAULT),
  /** The local hours the daily run may start in, in the workspace's zone. */
  hours: z
    .strictObject({ start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u), end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u) })
    .refine((hours) => hours.start !== hours.end, "the hours' start and end must differ")
    .default({ start: "08:00", end: "22:00" }),
  /** The empty chat's suggested prompts. */
  chips: z.boolean(),
  /**
   * The operator's egress switch for an external provider that reads more than the ledger (memory, tasks, the
   * brief): its ideas may then be prepared, an unattended read-only run whose searches carry its words, which may
   * hold the person's notes. Absent: off. The built-in, and a provider that reads only the ledger, prepare anyway.
   */
  prepareExternal: z.boolean().optional(),
  sources: IdeaSourcesSchema,
  /** The weekly channel digest; absent, none — it is off by default. `channel` is a messaging connection's id. */
  digest: z.strictObject({ channel: z.string().min(1).max(128), weekday: z.number().int().min(0).max(6) }).optional(),
  /**
   * The last digest sent: its local date and instant, the chat it went
   * to, the ideas it listed in order — which one reply there picks from — and
   * whether one was picked. Not set by a person.
   */
  digestSent: z
    .strictObject({
      on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      at: TimestampSchema,
      connectionId: z.string().min(1).max(128),
      chatId: z.string().min(1).max(256),
      ideaIds: z.array(IdSchema).min(1).max(IDEA_DIGEST_MAX),
      picked: z.literal(true).optional(),
    })
    .optional(),
  /** The digest's sends the channel refused today: each next attempt has a key of its own, a crash after a send none. Not set by a person. */
  digestTries: z.strictObject({ on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), refused: z.number().int().min(0).max(1_000) }).optional(),
});
export type IdeaSettings = z.infer<typeof IdeaSettingsSchema>;

export const IDEA_DEFAULT_SETTINGS: IdeaSettings = {
  enabled: true,
  provider: BUILTIN_IDEAS_PROVIDER_ID,
  volume: IDEA_MAX_ACTIVE,
  dailyTokens: IDEA_DAILY_TOKENS_DEFAULT,
  hours: { start: "08:00", end: "22:00" },
  chips: true,
  sources: { memory: true, tasks: true, brief: true },
};

export const IdeaBriefSchema = z.string().max(IDEA_BRIEF_MAX);

// ------------------------------------------------------------------ repository

/** A run still `running` after this is taken for one an owner lost mid-way: a new run marks it failed. */
export const IDEA_RUN_STALE_MS = 10 * 60_000;
/** Ideas, runs and feedback older than this are pruned; a dismissal, mute or exclusion is kept until reset. */
export const IDEA_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** An idea a run hands to the store: a validated draft, its id if new, and its rank. */
export interface StoreIdeaInput {
  readonly id: string;
  readonly draft: IdeaDraft;
  readonly score: number;
}

export interface StoreIdeasInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly providerId: string;
  /**
   * Store only while Ideas is on and `providerId` is still the workspace's
   * provider: a run that outlived a switch or a turn-off stores nothing
   * (`CONFLICT`), rather than bring the retired provider's ideas back.
   */
  readonly whileSelected?: boolean;
  /** With `whileSelected`: the person's switches the run read through; one switched off since refuses the store too. */
  readonly usedSources?: readonly ("memory" | "tasks" | "brief")[];
  /** With `whileSelected`: the brief the run read; one rewritten since refuses the store, as its quotes would be of the old one. */
  readonly briefRead?: string;
  readonly ideas: readonly StoreIdeaInput[];
  readonly now: string;
}

export interface StoreIdeasResult {
  /** The active ideas the run offered, as stored: a key already active keeps its id and counts one more run shown. */
  readonly stored: readonly Idea[];
  /**
   * Keys the ledger refused, never stored (invariant 5): dismissed,
   * snoozed, a muted section's, resting on an excluded basis, tried or done
   * lately, or ignored — offered `IDEA_IGNORED_RUNS` times and never opened.
   */
  readonly refused: readonly string[];
  /** Active ideas expired to stay within `IDEA_MAX_ACTIVE`, lowest score first; pinned ones never are. */
  readonly evicted: readonly string[];
}

export interface ListIdeasInput {
  readonly workspaceId: string;
  readonly now: string;
  readonly category?: IdeaCategory;
  /** Also tried, done, snoozed and dismissed ones; expired ones never. */
  readonly includeInactive?: boolean;
}

/**
 * A signal and its effect, applied with its ledger row in one transaction:
 * `tried`/`done` set the status; `not-now` snoozes until `snoozedUntil`;
 * `not-interested` dismisses (an expired idea too, so a stale tab loses
 * nothing) and unpins; `mute-category` and `exclude-basis` expire the
 * unpinned active ideas they now hide; the rest only record.
 */
export interface IdeaFeedbackInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly signal: IdeaSignal;
  readonly ideaId?: string;
  readonly category?: IdeaCategory;
  readonly basisRef?: string;
  readonly editedPrompt?: string;
  /** For `not-now`. */
  readonly snoozedUntil?: string;
  readonly now: string;
}

/** What the person has steered toward and away from, as a provider and the tab read it. */
export interface IdeaLedger {
  /** Keys marked *Not interested*, by feedback or by a dismissed idea. */
  readonly dismissedKeys: readonly string[];
  /** Keys snoozed until a time still ahead. */
  readonly snoozedKeys: readonly string[];
  /** Keys offered `IDEA_IGNORED_RUNS` times and never opened, for `IDEA_IGNORED_SUPPRESS_MS`. */
  readonly suppressedKeys: readonly string[];
  /** Keys tried or done within `IDEA_TTL_MS`: not offered again so soon. */
  readonly recentKeys: readonly string[];
  readonly mutedCategories: readonly IdeaCategory[];
  readonly excludedBasis: readonly string[];
  /** *More like this*: the keys and their sections, newest first. */
  readonly boostedKeys: readonly string[];
  readonly boostedCategories: readonly IdeaCategory[];
  /** Prompts the person edited before sending, newest first (at most 5): how they like to ask. A provider gets them only with `tasks`. */
  readonly examples: readonly string[];
  /**
   * How much each section's ideas were taken up in the last `IDEA_PRIOR_WINDOW_MS`:
   * *Try it* +1, edited before sending +0.5, the chat finished +2. A
   * provider may rank by it; absent from an older store.
   */
  readonly categoryPriors?: Readonly<Partial<Record<IdeaCategory, number>>>;
}

/** What the person did with an idea, in the chat it started. */
export interface SeedIdeaChatInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly ideaId: string;
  readonly taskId: string;
  /** What was sent: an edit of the idea's prompt is recorded as `edited`, its words kept as an example. */
  readonly sent: string;
  readonly now: string;
}

export interface StartIdeaRunInput {
  readonly runId: string;
  readonly workspaceId: string;
  readonly trigger: IdeaRun["trigger"];
  readonly providerId?: string;
  /** For a refresh: refused (`QUOTA_EXCEEDED`) when this many refreshes already started in the last hour, counted in the same transaction. */
  readonly refreshesPerHour?: number;
  readonly now: string;
}

export interface FinishIdeaRunInput {
  readonly runId: string;
  readonly outcome: Exclude<IdeaRunOutcome, "running">;
  readonly reason?: string;
  readonly inputsHash?: string;
  readonly generated?: number;
  readonly dropped?: number;
  readonly tokens?: number;
  readonly usd?: number;
  readonly now: string;
}

export interface IdeaSettingsRecord {
  readonly settings: IdeaSettings;
  readonly brief: string;
  /** Absent until first saved: the defaults. */
  readonly updatedAt?: string;
}

export interface SaveIdeaSettingsInput {
  readonly workspaceId: string;
  readonly settings?: IdeaSettings;
  /**
   * Fields to change, merged into what is saved inside the store's own
   * transaction (`sources` field by field), so a host's note (volume, the
   * digest sent) and a person's edit never overwrite each other. With
   * `settings`, refused.
   */
  readonly patch?: Partial<Omit<IdeaSettings, "sources">> & { readonly sources?: Partial<IdeaSettings["sources"]> };
  /** Optional fields the patch removes (the digest turned off, and what it last sent). */
  readonly clear?: readonly ("digest" | "digestSent" | "volumeAt")[];
  readonly brief?: string;
  readonly now: string;
}

export interface ResetIdeasInput {
  readonly workspaceId: string;
  /** `ledger`: dismissals, snoozes, exclusions and ignored keys; `categories`: muted sections. */
  readonly what: "ledger" | "categories";
  readonly now: string;
}

/**
 * Ideas, their runs, their feedback and their settings.
 * Every idea is read and written within its workspace: one named in another
 * is `NOT_FOUND`.
 *
 * - `list`, `store` and every write settle time first: an unpinned active or
 *   tried idea past `expiresAt` is `expired`, and a snooze that has run out
 *   makes its idea `active` again with a fresh lifetime.
 * - Whatever can make an idea active (`store`, a snooze ending, `restore`,
 *   an unpin, a reset) keeps at most `IDEA_MAX_ACTIVE` active, expiring the
 *   lowest scores; pinned ones never are, and at most that many may be pinned.
 * - `store` upserts by key over the active ideas and refuses what the ledger
 *   rules out; a snooze that ends comes back only if the ledger still allows it.
 * - A dismissal also ends every other row of its key, and drops the excerpts
 *   the dismissed idea quoted: the ledger keeps the key, not the words.
 */
interface IdeaRepositoryPortDefinition {
  store(input: StoreIdeasInput): StoreIdeasResult;
  get(workspaceId: string, ideaId: string): Idea | undefined;
  list(input: ListIdeasInput): readonly Idea[];
  /** Apply a signal's effect and record it; the idea as it is now, when one was named. */
  feedback(input: IdeaFeedbackInput): Idea | undefined;
  /** Undo a dismissal or a snooze: the idea is active again, and its key leaves the ledger. */
  restore(workspaceId: string, ideaId: string, now: string): Idea;
  setPinned(workspaceId: string, ideaId: string, pinned: boolean, now: string): Idea;
  ledger(workspaceId: string, now: string): IdeaLedger;
  reset(input: ResetIdeasInput): number;
  /** Expire the unpinned active ideas another provider wrote, when the workspace changes provider. */
  retireProvider(workspaceId: string, keep: string, now: string): number;
  /** Delete every idea citing `ref` (a forgotten memory record or chat), in any workspace. */
  forgetBasis(ref: string): number;
  /** Delete expired ideas, finished runs and feedback (but the ledger's) older than `before`. */
  /** Past retention; with `now`, also the runs of prepared steps no idea offers any more, once a day old. */
  prune(before: string, now?: string): number;
  /**
   * A source the provider may no longer quote — the brief rewritten, or the
   * memory, chats or brief switched off: unpinned active and snoozed ideas
   * citing it expire, and every other idea's excerpt of it is dropped.
   * `ref` names one source; `kind` all of a kind.
   */
  unquote(input: {
    readonly workspaceId: string;
    readonly ref?: string;
    readonly kind?: "memory" | "task" | "brief";
    readonly now: string;
  }): number;
  /** Refused with `CONFLICT` while another run of the workspace is under way; one older than `IDEA_RUN_STALE_MS` is marked failed. */
  startRun(input: StartIdeaRunInput): IdeaRun;
  finishRun(input: FinishIdeaRunInput): IdeaRun;
  /** The newest run, or the newest of one trigger: the daily schedule reads its own. */
  lastRun(workspaceId: string, trigger?: IdeaRun["trigger"]): IdeaRun | undefined;
  /** The inputs hash of the newest run that generated or found nothing new: what a scheduled run compares against. */
  lastInputsHash(workspaceId: string): string | undefined;
  /** Whether a scheduled run that started at or after `since` asked its provider and generated: setup's promise kept. */
  generatedSince(workspaceId: string, since: string): boolean;
  /** Runs a person asked for since `since`: the refresh rate limit. */
  refreshesSince(workspaceId: string, since: string): number;
  /**
   * The sources the person set aside, with the kind each was when they did —
   * read from the idea they set it aside on, which no longer quotes it — so
   * Settings → Ideas can name a chat as a chat. A kind is absent once that
   * idea is gone (pruned, or deleted with what it quoted).
   */
  excludedSources(workspaceId: string, now: string): readonly { readonly ref: string; readonly kind?: IdeaBasisKind }[];
  /** What runs spent since `since`: the daily budget. */
  spentSince(workspaceId: string, since: string): { readonly tokens: number; readonly usd: number };
  /** A chat *Try it* started: linked to the idea, and an edited prompt recorded. Another workspace's idea is `NOT_FOUND`. */
  seedChat(input: SeedIdeaChatInput): Idea;
  /** A chat's turn finished without failure: the idea that started it is `done`. Undefined when no idea did. */
  chatFinished(taskId: string, id: string, now: string): Idea | undefined;
  /** A look found nothing changed: the active ideas stay offered another `IDEA_TTL_MS`. How many there are. */
  keepOffered(workspaceId: string, now: string): number;
  /**
   * An idea's first step was run ahead of time: its run and answer.
   * Undefined when the idea is gone or no longer active, or, given `ranFor`,
   * when its words or uses changed while the step ran: that answer is for
   * another idea.
   */
  prepared(input: {
    readonly workspaceId: string;
    readonly ideaId: string;
    readonly taskId: string;
    readonly text: string;
    readonly ranFor?: { readonly prompt: string; readonly uses: Idea["uses"] };
    readonly now: string;
  }): Idea | undefined;
  /** How many ideas were prepared since `since`, and what that spent: the day's cap. */
  preparedSince(workspaceId: string, since: string): { readonly count: number; readonly tokens: number };
  /** Ideas counted as shown, and *Try it*s, since `since`: auto-volume's acceptance. */
  acceptance(workspaceId: string, since: string): { readonly shown: number; readonly tried: number };
  settings(workspaceId: string): IdeaSettingsRecord;
  saveSettings(input: SaveIdeaSettingsInput): IdeaSettingsRecord;
}
export type IdeaRepositoryPort = AsyncRepository<IdeaRepositoryPortDefinition>;
