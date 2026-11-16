import { z } from "zod";

import {
  IDEA_BASIS_KINDS,
  IDEA_CHIPS_MAX,
  IDEA_LABEL_MAX,
  IDEA_PROMPT_MAX,
  IDEAS_RECEIVES,
  IdeaBasisRefSchema,
  IdeaBriefSchema,
  IdeaCadenceSchema,
  IdeaCategorySchema,
  IdeaRunSchema,
  IdeaSchema,
  IdeaSettingsSchema,
  IdeaSourcesSchema,
} from "./ideas.js";
import { IdSchema, TimestampSchema } from "./ids.js";

/**
 * `ideas`: one workspace's ideas — listed, tried,
 * given feedback, pinned, turned into a routine or a reminder, refreshed —
 * and its brief and settings. Nothing here sends a message or starts a run:
 * `try` hands back the prompt for the composer, and `recur` hands
 * back a routine draft that the routine's own approval decides.
 */

const scope = { workspaceId: IdSchema.optional() } as const;

/** The signals a person gives through the tab's menu; the rest (`tried`, `done`, `ignored`, `edited`) the owner records itself. */
export const IDEA_PERSON_SIGNALS = [
  "not-now",
  "not-interested",
  "mute-category",
  "unmute-category",
  "exclude-basis",
  "include-basis",
  "more-like-this",
] as const;

export const IdeasPayloadSchema = z.discriminatedUnion("action", [
  /** Active ideas, best first; `includeInactive` adds tried, done, snoozed and dismissed ones (Settings → Ideas' undo). */
  z.strictObject({ action: z.literal("list"), ...scope, category: IdeaCategorySchema.optional(), includeInactive: z.boolean().optional() }),
  z.strictObject({ action: z.literal("chips"), ...scope, limit: z.number().int().min(1).max(IDEA_CHIPS_MAX).optional() }),
  z.strictObject({ action: z.literal("try"), ...scope, id: IdSchema }),
  z
    .strictObject({
      action: z.literal("feedback"),
      ...scope,
      signal: z.enum(IDEA_PERSON_SIGNALS),
      /** The idea it is about; `mute-category`/`unmute-category` may name the category alone, `include-basis` the basis alone. */
      id: IdSchema.optional(),
      category: IdeaCategorySchema.optional(),
      basisRef: IdeaBasisRefSchema.optional(),
    })
    .superRefine((payload, context) => {
      const needs = (path: "id" | "category" | "basisRef", message: string) => context.addIssue({ code: "custom", path: [path], message });
      switch (payload.signal) {
        case "mute-category":
        case "unmute-category":
          if (payload.id === undefined && payload.category === undefined)
            needs("category", "a category signal needs the idea or the category");
          break;
        case "exclude-basis":
          if (payload.id === undefined) needs("id", "exclude-basis needs the idea");
          if (payload.basisRef === undefined) needs("basisRef", "exclude-basis needs the basis");
          break;
        case "include-basis":
          if (payload.basisRef === undefined) needs("basisRef", "include-basis needs the basis");
          break;
        default:
          if (payload.id === undefined) needs("id", `${payload.signal} needs the idea`);
      }
    }),
  /** Undo a dismissal or a snooze: active again, and its key leaves the ledger. */
  z.strictObject({ action: z.literal("restore"), ...scope, id: IdSchema }),
  z.strictObject({ action: z.literal("pin"), ...scope, id: IdSchema }),
  z.strictObject({ action: z.literal("unpin"), ...scope, id: IdSchema }),
  z.strictObject({ action: z.literal("recur"), ...scope, id: IdSchema }),
  /** The routine `recur` drafted was created (through `routines create` and its evaluation): the idea is done. */
  z.strictObject({ action: z.literal("made-recurring"), ...scope, id: IdSchema, routineId: IdSchema }),
  z.strictObject({ action: z.literal("remind"), ...scope, id: IdSchema, at: TimestampSchema }),
  z.strictObject({ action: z.literal("refresh"), ...scope }),
  z.strictObject({ action: z.literal("brief"), ...scope }),
  z.strictObject({ action: z.literal("set-brief"), ...scope, text: IdeaBriefSchema }),
  z.strictObject({ action: z.literal("settings"), ...scope }),
  z.strictObject({
    action: z.literal("set-settings"),
    ...scope,
    changes: z.strictObject({
      enabled: z.boolean().optional(),
      /** The provider that writes this workspace's ideas: one installed here, by plugin id. */
      provider: z.string().min(1).max(128).optional(),
      chips: z.boolean().optional(),
      prepareExternal: z.boolean().optional(),
      sources: IdeaSourcesSchema.partial().optional(),
      dailyTokens: IdeaSettingsSchema.shape.dailyTokens.unwrap().optional(),
      hours: IdeaSettingsSchema.shape.hours.unwrap().optional(),
      /** `null` turns the digest off. */
      digest: IdeaSettingsSchema.shape.digest.unwrap().nullable().optional(),
    }),
  }),
  /** `ledger` forgets every dismissal, snooze and excluded basis; `categories` unmutes every section. */
  z.strictObject({ action: z.literal("reset"), ...scope, what: z.enum(["ledger", "categories"]) }),
]);
export type IdeasPayload = z.infer<typeof IdeasPayloadSchema>;

// ------------------------------------------------------------------ answers

/** An installed provider as the tab and `tavi ideas provider` show it. */
export const IdeasProviderViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["builtin", "plugin"]),
  receives: z.array(z.enum(IDEAS_RECEIVES)).readonly(),
  ready: z.boolean(),
  disclosure: z.string().max(1_000).optional(),
});
export type IdeasProviderView = z.infer<typeof IdeasProviderViewSchema>;

export const IdeasListAnswerSchema = z.object({
  ideas: z.array(IdeaSchema).readonly(),
  /** The sections the person muted. */
  mutedCategories: z.array(IdeaCategorySchema).readonly(),
  /** The basis refs the person excluded. */
  excludedBasis: z.array(z.string()).readonly(),
  /** The same, each with the kind it was when set aside (Settings → Ideas names a chat as a chat); absent from an older owner. */
  excludedSources: z
    .array(z.object({ ref: z.string(), kind: z.enum(IDEA_BASIS_KINDS).optional(), title: z.string().max(200).optional() }))
    .readonly()
    .optional(),
  /** Whether Ideas is on: off, the tab says so and nothing is looked for. Absent from an older owner. */
  enabled: z.boolean().optional(),
  lastRun: IdeaRunSchema.optional(),
  /** When the next scheduled run is due; absent while Ideas is off or no owner runs the host. */
  nextAt: TimestampSchema.optional(),
  /** Whether the workspace has a fast model to word ideas for the person; absent where the owner cannot tell. */
  modelSet: z.boolean().optional(),
  /** The provider this workspace uses, and the ones installed here. */
  provider: z.string(),
  providers: z.array(IdeasProviderViewSchema).readonly(),
});
export type IdeasListAnswer = z.infer<typeof IdeasListAnswerSchema>;

export const IdeaChipSchema = z.object({
  /** Absent for a chip that is not an idea's, e.g. a capability fallback. */
  ideaId: IdSchema.optional(),
  /** "Continue: <title>": the chat it opens, rather than a prompt to fill. */
  taskId: IdSchema.optional(),
  label: z.string().min(1).max(IDEA_LABEL_MAX),
  prompt: z.string().min(1).max(IDEA_PROMPT_MAX),
  /** What the idea's prompt uses, for the *Uses* line onboarding shows under a chip; absent for a fallback chip and from an older owner. */
  uses: IdeaSchema.shape.uses.optional(),
});
export type IdeaChip = z.infer<typeof IdeaChipSchema>;
export const IdeasChipsAnswerSchema = z.object({ chips: z.array(IdeaChipSchema).max(IDEA_CHIPS_MAX).readonly() });
export type IdeasChipsAnswer = z.infer<typeof IdeasChipsAnswerSchema>;

/** `try`: the prompt for the composer, and the idea now `tried`. */
export const IdeasTryAnswerSchema = z.object({ prompt: z.string().min(1).max(IDEA_PROMPT_MAX), idea: IdeaSchema });
export type IdeasTryAnswer = z.infer<typeof IdeasTryAnswerSchema>;

/** `feedback`, `pin`, `unpin`: the idea as it is now, when the signal named one. */
export const IdeasIdeaAnswerSchema = z.object({ idea: IdeaSchema.optional() });
export type IdeasIdeaAnswer = z.infer<typeof IdeasIdeaAnswerSchema>;

/** `recur`: a routine draft for the routine's own approval; nothing is created yet. */
export const IdeasRecurAnswerSchema = z.object({
  draft: z.object({ name: z.string().min(1), prompt: z.string().min(1), cadence: IdeaCadenceSchema }),
});
export type IdeasRecurAnswer = z.infer<typeof IdeasRecurAnswerSchema>;

export const IdeasRemindAnswerSchema = z.object({ reminderId: IdSchema });
export type IdeasRemindAnswer = z.infer<typeof IdeasRemindAnswerSchema>;

/**
 * `started`; `queued`, a run here is under way and this one follows it; `busy`, a run is open in the store from
 * elsewhere (another process, or one an owner lost minutes ago) and nothing is started.
 */
export const IdeasRefreshAnswerSchema = z.object({ status: z.enum(["started", "queued", "busy"]) });
export type IdeasRefreshAnswer = z.infer<typeof IdeasRefreshAnswerSchema>;

export const IdeasBriefAnswerSchema = z.object({ text: IdeaBriefSchema });
export type IdeasBriefAnswer = z.infer<typeof IdeasBriefAnswerSchema>;

export const IdeasSettingsAnswerSchema = z.object({ settings: IdeaSettingsSchema });
export type IdeasSettingsAnswer = z.infer<typeof IdeasSettingsAnswerSchema>;

export const IdeasResetAnswerSchema = z.object({ cleared: z.number().int().nonnegative() });
export type IdeasResetAnswer = z.infer<typeof IdeasResetAnswerSchema>;
