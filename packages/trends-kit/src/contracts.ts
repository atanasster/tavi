import { DomainSourceRecordSchema, checkDomainSourceRecord } from "@tavi/contracts";
import { z } from "zod";

/**
 * The trends domain's records.
 */

/**
 * A source's independence family: a spike is `confirmed` only when two
 * or more families pass. `reference` (Wikidata) expands a topic's terms and
 * never votes.
 */
export const TRENDS_SOURCE_KINDS = ["news", "community", "social", "attention", "search", "markets", "research", "reference"] as const;
export type TrendsSourceKind = (typeof TRENDS_SOURCE_KINDS)[number];

/** A source of trend signals: the shared record with what trends needs to know of it. */
export const TrendsSourceRecordSchema = DomainSourceRecordSchema.extend({
  kind: z.enum(TRENDS_SOURCE_KINDS),
  trends: z.strictObject({
    /** BCP-47 language codes the source covers, or `*`. */
    languages: z.union([z.array(z.string().min(2).max(12)).min(1), z.literal("*")]),
    shape: z.strictObject({ counts: z.boolean(), samples: z.boolean(), fullText: z.boolean() }),
    /** How far back its counts reach on the first read (0: forward only). */
    backfillDays: z.number().int().min(0).max(4_000),
    /** How late its newest count usually is. */
    lagMinutes: z.number().int().min(0),
    cost: z.strictObject({
      unit: z.enum(["none", "request", "item", "credit"]),
      usdPerUnit: z.number().min(0),
      freeUnitsPerDay: z.number().min(0),
    }),
    /** The longest any series from it is kept (YouTube's statistics: 30). */
    seriesMaxDays: z.number().int().min(1).max(400),
    /** The source must delete content its author deleted (X, Bluesky): its items live a day. */
    deletionOnRequest: z.boolean(),
    commercial: z.enum(["allowed", "permission", "prohibited"]),
    /** The day its access ends (Reddit's public API); refused after it. */
    sunset: z.iso.date().optional(),
    /** Needs the operator's `contact` in its User-Agent (Wikimedia's policy, Reddit's rules). */
    needsContact: z.boolean().default(false),
  }),
}).superRefine(checkDomainSourceRecord);
export type TrendsSourceRecord = z.infer<typeof TrendsSourceRecordSchema>;

/** A bucket's width: an hour or a UTC day. */
export const BUCKET_SECONDS = { hour: 3_600, day: 86_400 } as const;
export type Bucket = keyof typeof BUCKET_SECONDS;

/** How much a count can be trusted: `missing` is never a zero. */
export const COUNT_QUALITIES = ["ok", "approximate", "partial", "missing"] as const;
export type CountQuality = (typeof COUNT_QUALITIES)[number];

/** One bucket of one series, as an adapter reads it. */
export interface CountPoint {
  /** The bucket's start, ISO UTC, aligned to its width. */
  readonly start: string;
  readonly value: number;
  readonly quality: CountQuality;
  /** The source's own total for the bucket (GDELT's `norm`), to normalise by. */
  readonly norm?: number;
}

/** Where an item came from: an adapter's read, or rows the agent relayed from the browser (never counted). */
export const ITEM_ORIGINS = ["adapter", "agent"] as const;
export type ItemOrigin = (typeof ITEM_ORIGINS)[number];

/** An item as an adapter reads it, before it is stored. */
export interface RawItem {
  /** The source's own id for it, stable across reads. */
  readonly ref: string;
  readonly url: string;
  readonly title: string;
  /** Plain text, already cleaned of markup. */
  readonly text?: string;
  readonly publishedAt?: string;
  readonly language?: string;
  /** The author's handle or id: only ever stored as a daily-salted hash. */
  readonly author?: string;
  /** Other names the author goes by here (a handle beside an id): kept only as hashes for the day, so `watch` can refuse them. */
  readonly authorNames?: readonly string[];
  /** Points, comments, views, a rank: numbers only. */
  readonly metrics?: Readonly<Record<string, number>>;
}

/** An item as the store keeps it and a reply shows it. */
export interface StoredItem {
  readonly itemId: string;
  readonly source: string;
  readonly origin: ItemOrigin;
  readonly url: string;
  /** The URL's host, the outlet the brief names. */
  readonly outlet: string;
  readonly title: string;
  readonly text: string;
  readonly publishedAt?: string;
  readonly language?: string;
  readonly authorHash?: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

/** What is trending now on a source for a country (`snapshot`). */
export interface TrendEntry {
  readonly title: string;
  readonly url?: string;
  readonly rank: number;
  /** The source's own volume figure (Google's approximate traffic, Bluesky's post count). */
  readonly volume?: number;
  readonly volumeLabel?: string;
}

/** A topic's terms by BCP-47 language, at most 20 a language. */
export const TopicTermsSchema = z.record(
  z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
  z.array(z.string().trim().min(1).max(100)).min(1).max(20),
);

/** What a spike alerts on: the growth on the 24 h window, and how many families must agree. */
export const TopicAlertSchema = z.strictObject({
  growth: z.number().min(0.5).max(100).default(3),
  corroboration: z.enum(["two_independent", "allow_single_with_caveat"]).default("two_independent"),
});
export type TopicAlert = z.infer<typeof TopicAlertSchema>;

/** A tracked topic as `watch` takes it: never a person. */
export const TopicInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  terms: TopicTermsSchema,
  exclude: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  wikidata: z
    .string()
    .regex(/^Q\d{1,12}$/)
    .optional(),
  /** Wikipedia article per project: `en.wikipedia` → `Solid-state_battery`. */
  articles: z.record(z.string().regex(/^[a-z-]{2,12}\.wikipedia$/), z.string().min(1).max(256)).optional(),
  countries: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .max(10)
    .default([]),
  /** Source ids to use; absent, every one turned on. */
  sources: z.array(z.string().min(1).max(40)).max(24).optional(),
  alert: TopicAlertSchema.default({ growth: 3, corroboration: "two_independent" }),
});
export type TopicInput = z.infer<typeof TopicInputSchema>;

export const TOPIC_STATES = ["quiet", "signal", "confirmed"] as const;
export type TopicState = (typeof TOPIC_STATES)[number];

export interface Topic extends TopicInput {
  readonly topicId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly paused: boolean;
  readonly state: TopicState;
  /** When `state` last changed. */
  readonly stateSince?: string;
  /** Sweeps in a row below one standard deviation: a raised topic falls quiet after two. */
  readonly quietSweeps: number;
  /** When it last fell quiet: it is not raised again within the cooldown. */
  readonly quietSince?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Who a call is for: topics and signals are kept apart by principal and workspace. */
export interface TopicScope {
  readonly principalId: string;
  readonly workspaceId: string;
}

/** A handle, an account or a mention: a person, which `watch` refuses as a topic. */
export function personShapedTerm(term: string): boolean {
  return /^[@＠]\S+$/.test(term.trim()) || /^\/?u\/\S+$/i.test(term.trim()) || /^did:(plc|web):/i.test(term.trim());
}
