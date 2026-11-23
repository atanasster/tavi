import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";
import { MAX_MEMORY_TITLE_CHARS, MEMORY_KINDS, MemoryProvenanceSchema, memoryProvenanceLine, memoryProvenanceUntrusted } from "./memory.js";
import { MemoryRelatedSchema, MemoryScopeTargetSchema } from "./memory-ipc.js";
import { canvasCoreEnglish, isCoreEnglish, type CanvasCoreT } from "./locales/core-canvas.js";
// The terminal's line and a chat app's card say the chat apps' words too (`channel.memory.*`): the server's alone.
import { coreEnglish, type CoreT } from "./locales/core.js";
import { englishShortDayText } from "./reminders.js";
import { navPath } from "./nav.js";
import { englishOf, renderTextRef } from "./text-ref.js";
import type { CanvasCoreKey } from "./locales/core-canvas-en.js";

/**
 * Memory cards: the *Proposed ·
 * Keep / Edit / Discard* and *Saved · Undo* cards a chat shows after a turn
 * that proposed memory, and after an epoch's flush.
 *
 * A card is a `memory` chat notice, posted read (display-only), so no turn
 * ever claims it into a model's context (invariant 19). **It holds ids, not
 * text** (invariant 22): the notice row says only how many things it holds,
 * and its records are its `tavi_memory_prompts` rows (`MemoryPromptRow`).
 * Title, excerpt and state are rendered from the canonical memory rows each
 * time a card is read, so a card decided elsewhere shows the current state,
 * and a forgotten record shows "Forgotten", never its old text.
 *
 * The wording lives here, in one place shared by the canvas, the terminal
 * and the channels.
 */

/** The most records one card holds: a turn's proposals, or a flush's five. */
export const MEMORY_CARD_ITEMS_MAX = 20;
/** A card item's excerpt, at most: the body, cut. */
export const MEMORY_CARD_EXCERPT_CHARS = 300;
/** A short title made from a body that has none. */
const MEMORY_CARD_TITLE_FROM_BODY_CHARS = 80;
/** Days a settled card's rows are kept, the press-age limit; the retention sweep deletes them after. */
export const MEMORY_PROMPT_KEEP_DAYS = 7;
/**
 * A card's stored summary once a forget took its last row: a word,
 * never a record's text (invariant 22). The sweep deletes a decided card's
 * rows too, so this is what tells a card whose records were all forgotten
 * from one whose rows a week's sweep took.
 */
export const MEMORY_CARD_FORGOTTEN_SUMMARY = "Forgotten";

/** A card row's token: opaque, short enough for a channel callback (`y:<token>:<k>`, ≤ 64 bytes). */
export const MemoryPromptTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{8,32}$/);

/**
 * One record on a card, as stored (`tavi_memory_prompts`): ids and a number,
 * never the record's text. `number` is the item's place on its card, which
 * `/memory keep <n>` names. `settledAt` is when the retention sweep
 * first found its record decided; the rows of a card all settled more than
 * `MEMORY_PROMPT_KEEP_DAYS` ago are deleted, and forgetting a record deletes
 * its rows at once.
 */
export interface MemoryPromptRow {
  readonly token: string;
  readonly noticeId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly recordId: string;
  /** The chat the card is in. */
  readonly taskId: string;
  readonly number: number;
  readonly createdAt: string;
  readonly settledAt?: string;
}

/** What a card's post takes: the records to add to the card under `sourceKey` (one card per turn, or per flush). */
export interface PostMemoryCardInput {
  readonly noticeId: string;
  readonly taskId: string;
  /** `memory:<admissionId>` for a turn's card, `memory:flush:e<N>` for a flush's. Posting again adds to the same card. */
  readonly sourceKey: string;
  readonly createdAt: string;
  /** Whose records they are, each once; a record already on the card is not added again. */
  readonly records: readonly { readonly recordId: string; readonly workspaceId: string; readonly principalId: string }[];
  /**
   * A digest's card: how many proposals wait in all, of which
   * `records` are the listed ones, and when the oldest expires as the
   * workspace's clock says it ("Thu 15 Oct"). Its words say only that.
   */
  readonly digest?: { readonly waiting: number; readonly oldestExpires: string };
}

/**
 * The review digest: a memory card
 * posted to a person's Home (or, for someone other than the operator, their
 * direct conversation's Home) under `memory:digest:<local date>`, listing at
 * most `MEMORY_DIGEST_ITEMS_MAX` of what waits for them, titles only. Like
 * every card it holds ids; its words say how many wait and when the oldest
 * expires.
 */
export const MEMORY_DIGEST_KEY_PREFIX = "memory:digest:";
/** The most proposals a digest lists; the rest are counted ("and N more — Review"). */
export const MEMORY_DIGEST_ITEMS_MAX = 10;
/** A proposal this close to expiring, and not yet in a digest, brings the next one forward. */
export const MEMORY_DIGEST_NEAR_EXPIRY_DAYS = 7;
/** The weekly cadence: a digest goes out at most this many days after the last. */
export const MEMORY_DIGEST_EVERY_DAYS = 7;
/** A digest goes out at the first memory tick at or after this hour of the workspace's day. */
export const MEMORY_DIGEST_HOUR = 9;

/** A digest's source key: one per local date (`YYYY-MM-DD`) and chat. */
export function memoryDigestKey(localDate: string): string {
  return `${MEMORY_DIGEST_KEY_PREFIX}${localDate}`;
}

/**
 * A digest's stored words (invariant 22: counts and a date, never a record's
 * text): "3 things waiting to be remembered — the oldest expires Thu 15 Oct",
 * or "10 of 14 things …" when more wait than are listed. The number it starts
 * with is the listed count, as every card's is.
 */
export function memoryDigestNoticeText(
  input: { readonly listed: number; readonly waiting: number; readonly oldestExpires: string },
  t: CanvasCoreT = canvasCoreEnglish,
): {
  readonly title: string;
  readonly summary: string;
} {
  const waiting = Math.max(input.listed, input.waiting);
  return {
    title:
      waiting > input.listed
        ? t("memory.digest.titleOf", { listed: String(input.listed), count: waiting, n: String(waiting), date: input.oldestExpires })
        : t("memory.digest.title", { count: input.listed, n: String(input.listed), date: input.oldestExpires }),
    summary: "",
  };
}

/** What a digest card's words say it is: how many waited in all; undefined for any other card. */
export function memoryDigestOf(title: string): { readonly waiting: number } | undefined {
  const match = /^(\d+)(?: of (\d+))? things? waiting to be remembered\b/.exec(title);
  if (match === null) return undefined;
  return { waiting: Number.parseInt((match[2] ?? match[1]) as string, 10) };
}

/**
 * A listing's source key: `/memory review` and `/forget <words>`
 * number what they list under `memory:list:<surface>`, one per front end or
 * channel in a chat, so a listing in the terminal never renumbers what a
 * Telegram chat was shown. Its notice is never shown as a card.
 */
export const MEMORY_LISTING_KEY_PREFIX = "memory:list:";

/** The source key of a surface's listing: `ipc`, `web`, or a messaging connection's id. */
export function memoryListingKey(surface: string): string {
  return `${MEMORY_LISTING_KEY_PREFIX}${surface}`;
}

/**
 * A command receipt's source key prefix: the *Saved* card that
 * `/remember` or `/memory keep all` posts is keyed
 * `memory:cmd:<surface>:<id>`, so its numbers count only on the surface it
 * was typed on and never renumber what another surface was shown.
 */
export const MEMORY_COMMAND_RECEIPT_KEY_PREFIX = "memory:cmd:";

/** The source key of a command receipt posted from `surface`: `memory:cmd:<surface>:<id>`. */
export function memoryCommandReceiptKey(surface: string, id: string): string {
  return `${memoryCommandReceiptSurfacePrefix(surface)}${id}`;
}

/** What every command receipt posted from `surface` has its source key start with. */
export function memoryCommandReceiptSurfacePrefix(surface: string): string {
  return `${MEMORY_COMMAND_RECEIPT_KEY_PREFIX}${surface}:`;
}

/** What a listing's post takes: the records it numbered, in order, at most `MEMORY_CARD_ITEMS_MAX`. */
export interface PostMemoryListingInput {
  readonly noticeId: string;
  readonly taskId: string;
  /** Where it was typed: the front end, or the messaging connection. */
  readonly surface: string;
  readonly createdAt: string;
  readonly records: readonly { readonly recordId: string; readonly workspaceId: string; readonly principalId: string }[];
}

/**
 * What a card says about each record now: the record's lifecycle in the
 * words a person reads. `hidden` is a record the reader may not see (another
 * person's), shown with no text.
 */
export const MEMORY_CARD_STATES = ["proposed", "saved", "discarded", "expired", "revoked", "replaced", "forgotten", "hidden"] as const;
export type MemoryCardState = (typeof MEMORY_CARD_STATES)[number];

/** The record lifecycle a card state is read from: a record gone (or deleted) is forgotten. */
export function memoryCardStateOf(status: string | undefined): MemoryCardState {
  switch (status) {
    case "proposed":
      return "proposed";
    case "approved":
      return "saved";
    case "rejected":
      return "discarded";
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    case "superseded":
      return "replaced";
    default:
      return "forgotten";
  }
}

export const MemoryCardItemSchema = z.strictObject({
  token: MemoryPromptTokenSchema,
  number: z.number().int().positive(),
  recordId: IdSchema,
  state: z.enum(MEMORY_CARD_STATES),
  /** Absent once the record is forgotten, and for a hidden one. */
  kind: z.enum(MEMORY_KINDS).optional(),
  target: MemoryScopeTargetSchema.optional(),
  /** A sensitive record's title and excerpt are never on a card. */
  sensitive: z.boolean(),
  /** The current revision's title, else the start of its body; null when forgotten, hidden or sensitive. */
  title: z.string().max(MAX_MEMORY_TITLE_CHARS).nullable(),
  excerpt: z.string().max(MEMORY_CARD_EXCERPT_CHARS).nullable(),
  /** The revision a *Keep* or *Edit* is held to. */
  currentRevisionId: IdSchema.optional(),
  /** A proposal only: when it expires unreviewed. */
  expiresAt: TimestampSchema.optional(),
  /** A proposal that updates a record in force: decided by *Replace* or, a fact, *Keep both* — never by *Keep all*. */
  updates: MemoryRelatedSchema.optional(),
  /** A proposed fact akin to a kept fact in its scope: decided by *Replace* or *Keep both* — never by *Keep all*. */
  mayUpdate: MemoryRelatedSchema.optional(),
  /** A proposal near a record in force in its scope: "similar to …". */
  similarTo: MemoryRelatedSchema.optional(),
  /**
   * A tidy-up: it replaces records already kept, so it is kept only
   * in the app, with its before and after side by side — never by *Keep* on
   * a channel or the terminal, nor by any *Keep all*. A card shows no "before".
   */
  tidyUp: z.literal(true).optional(),
  /**
   * A proposal made after its chat read untrusted content, or a tidy-up of
   * one: what it read, shown with it
   * (`memoryProvenanceLine`). It is kept one at a time, never by *Keep all*.
   */
  provenance: MemoryProvenanceSchema.optional(),
});
export type MemoryCardItem = z.infer<typeof MemoryCardItemSchema>;

/**
 * Whether a waiting card item may be kept by its own *Keep* on a channel or
 * the terminal: not sensitive, not an update and not a tidy-up — those need
 * a look in the app. One proposed after the chat read a
 * page may: its card says what the chat read.
 */
export function memoryCardItemKeepable(item: Pick<MemoryCardItem, "state" | "sensitive" | "updates" | "mayUpdate" | "tidyUp">): boolean {
  return item.state === "proposed" && !item.sensitive && item.updates === undefined && item.mayUpdate === undefined && item.tidyUp !== true;
}

/**
 * Whether a waiting card item is a **plain** proposal (the one *Keep all*
 * rule): keepable (`memoryCardItemKeepable`), and not proposed after its chat
 * read untrusted content. Only a plain one is kept by any *Keep all*;
 * the others need a look.
 */
export function memoryCardItemIsPlain(
  item: Pick<MemoryCardItem, "state" | "sensitive" | "updates" | "mayUpdate" | "tidyUp" | "provenance">,
): boolean {
  return memoryCardItemKeepable(item) && !memoryProvenanceUntrusted(item.provenance);
}

/** What a card says of an item proposed after its chat read untrusted content; undefined for any other. */
export function memoryCardProvenanceLine(
  item: Pick<MemoryCardItem, "provenance" | "tidyUp">,
  t: CanvasCoreT = canvasCoreEnglish,
): string | undefined {
  return memoryProvenanceLine(item.provenance, { tidyUp: item.tidyUp === true }, t);
}

/** What a waiting tidy-up says on a card, a channel message, the terminal and `/memory review`. */
export const MEMORY_TIDY_UP_LOOK = canvasCoreEnglish("memory.card.tidyUpLook");

/** What a single *Keep* of a tidy-up answers on a card, a channel or a command: it is kept in the Center. */
export const MEMORY_TIDY_UP_NEEDS_LOOK = canvasCoreEnglish("memory.card.tidyUpNeedsLook");

/** What an update says it replaces: "updates: Reply in Spanish". */
export function memoryUpdatesLine(updates: { readonly title: string | null }, t: CanvasCoreT = canvasCoreEnglish): string {
  return t("memory.card.updates", { title: updates.title ?? t("memory.card.aKeptMemory") });
}

/** What a near-matched fact says it may replace: "may update: Lives in Lisbon". */
export function memoryMayUpdateLine(mayUpdate: { readonly title: string | null }, t: CanvasCoreT = canvasCoreEnglish): string {
  return t("memory.card.mayUpdate", { title: mayUpdate.title ?? t("memory.card.aKeptMemory") });
}

/** `memory {action: "card", noticeId}`: the card rendered now from the canonical rows. */
export const MemoryCardAnswerSchema = z.strictObject({
  noticeId: IdSchema,
  taskId: IdSchema,
  /** The notice's own words: counts only. */
  title: z.string().min(1).max(160),
  /** The card's records still on it. Empty once every row was deleted, a week after the card settled. */
  items: z.array(MemoryCardItemSchema).max(MEMORY_CARD_ITEMS_MAX),
  /** Records forgotten since the card was posted: their rows went with them, so only the count is left. */
  forgotten: z.number().int().nonnegative(),
  /** A digest's card: how many waited for the person when it was sent, the listed ones included. */
  digest: z.strictObject({ waiting: z.number().int().nonnegative() }).optional(),
});
export type MemoryCardAnswer = z.infer<typeof MemoryCardAnswerSchema>;

/** A card notice's stored words: how many things it holds, never what they are (invariant 22). */
export function memoryCardNoticeText(
  input: { readonly count: number; readonly flush: boolean },
  t: CanvasCoreT = canvasCoreEnglish,
): {
  readonly title: string;
  readonly summary: string;
} {
  return {
    title: t(input.flush ? "memory.card.thingsFlush" : "memory.card.things", { count: input.count, n: String(input.count) }),
    summary: "",
  };
}

/**
 * A card's stored English title (`memoryCardNoticeText`,
 * `memoryDigestNoticeText`) in `t`'s language: read back from its counts and date, and
 * left as stored when it is not one of those.
 */
export function memoryCardTitleText(title: string, t: CanvasCoreT = canvasCoreEnglish): string {
  if (isCoreEnglish(t)) return title;
  const digest = /^(\d+)(?: of (\d+))? things? waiting to be remembered — the oldest expires (.+)$/.exec(title);
  if (digest !== null) {
    const listed = Number.parseInt(digest[1] as string, 10);
    return memoryDigestNoticeText(
      {
        listed,
        waiting: Number.parseInt(digest[2] ?? (digest[1] as string), 10),
        oldestExpires: englishShortDayText(digest[3] as string, t) ?? (digest[3] as string),
      },
      t,
    ).title;
  }
  const card = /^(\d+) things? to remember( from before this chat rolled over)?$/.exec(title);
  if (card === null) return title;
  return memoryCardNoticeText({ count: Number.parseInt(card[1] as string, 10), flush: card[2] !== undefined }, t).title;
}

/** How many records a card was posted with: the count its title starts with (`memoryCardNoticeText`). */
export function memoryCardCountOf(title: string): number {
  const match = /^(\d+) /.exec(title);
  return match === null ? 0 : Number.parseInt(match[1] as string, 10);
}

/** A record's title as a card shows it: its own title, else the start of its body on one line. */
export function memoryCardTitleOf(revision: { readonly title?: string | undefined; readonly body?: string | undefined }): string | null {
  const title = revision.title?.replace(/\s+/g, " ").trim();
  if (title !== undefined && title !== "") return title.slice(0, MAX_MEMORY_TITLE_CHARS);
  const body = revision.body?.replace(/\s+/g, " ").trim() ?? "";
  if (body === "") return null;
  return body.length <= MEMORY_CARD_TITLE_FROM_BODY_CHARS ? body : `${body.slice(0, MEMORY_CARD_TITLE_FROM_BODY_CHARS - 1)}…`;
}

/** Where a kept record applies, as a card's heading says it. */
export function memoryCardScopeLabel(target: string | undefined, t: CanvasCoreT = canvasCoreEnglish): string {
  return t(target?.startsWith("chat:") === true ? "memory.card.scope.chat" : "memory.card.scope.everywhere");
}

const STATE_LABELS: Readonly<Record<MemoryCardState, CanvasCoreKey>> = {
  proposed: "memory.card.state.proposed",
  saved: "memory.card.state.saved",
  discarded: "memory.card.state.discarded",
  expired: "memory.card.state.expired",
  revoked: "memory.card.state.revoked",
  replaced: "memory.card.state.replaced",
  forgotten: "memory.card.state.forgotten",
  hidden: "memory.card.state.hidden",
};

/** A state's word on a card. */
export function memoryCardStateLabel(state: MemoryCardState, t: CanvasCoreT = canvasCoreEnglish): string {
  return t(STATE_LABELS[state]);
}

/** What a card item is called: its title, or what stands in for text the card never shows. */
export function memoryCardItemName(
  item: Pick<MemoryCardItem, "title" | "sensitive" | "state">,
  t: CanvasCoreT = canvasCoreEnglish,
): string {
  if (item.state === "forgotten") return t("memory.card.state.forgotten");
  if (item.state === "hidden") return t("memory.card.item.hidden");
  if (item.sensitive) return t("memory.card.item.sensitive");
  return item.title ?? t("memory.card.item.untitled");
}

/** A card's heading: "Proposed · remember everywhere", "Saved", "2 things to remember", or its receipt once decided. */
export function memoryCardHeading(
  card: Pick<MemoryCardAnswer, "title" | "items" | "forgotten" | "digest">,
  t: CanvasCoreT = canvasCoreEnglish,
): string {
  const items = card.items;
  // A digest says what it said when it was sent while anything on it still waits.
  if (card.digest !== undefined && items.some((item) => item.state === "proposed")) return memoryCardTitleText(card.title, t);
  if (items.length === 0)
    return card.forgotten > 0
      ? card.forgotten === 1
        ? t("memory.card.state.forgotten")
        : t("memory.card.heading.forgottenCount", { count: String(card.forgotten) })
      : t("memory.card.heading.titleDecided", { title: memoryCardTitleText(card.title, t) });
  const [only] = items;
  if (items.length === 1 && card.forgotten === 0 && only !== undefined)
    return only.state === "proposed"
      ? t("memory.card.heading.proposed", { scope: memoryCardScopeLabel(only.target, t) })
      : t(STATE_LABELS[only.state]);
  const waiting = items.filter((item) => item.state === "proposed").length;
  if (waiting > 0) return t("memory.card.things", { count: waiting, n: String(waiting) });
  const states = new Set([...items.map((item) => item.state), ...(card.forgotten > 0 ? ["forgotten" as const] : [])]);
  const [state] = [...states];
  return states.size === 1 && state !== undefined
    ? t("memory.card.heading.stateCount", { state: t(STATE_LABELS[state]), count: String(items.length + card.forgotten) })
    : t("memory.card.heading.decided");
}

/** Records a saved turn names, and those counted past them. */
interface MemoryCounted {
  readonly records: readonly unknown[];
  readonly more: number;
}

/**
 * How many memories an answer used, from its saved turn's
 * `memoryUsed`: the records it names and those counted past them; 0 for a
 * turn that recorded none, or none used.
 */
export function memoryUsedCount(used: MemoryCounted | undefined): number {
  return used === undefined ? 0 : used.records.length + used.more;
}

/** Every memory an answer's saved turn names, used or only looked through: whether it has anything to say. */
export function memorySeenCount(used: (MemoryCounted & { readonly listed?: MemoryCounted | undefined }) | undefined): number {
  return memoryUsedCount(used) + memoryUsedCount(used?.listed);
}

/** The heading over what a listing showed: "Looked through 6 memories", or "Looked through 5 more" beside those used. */
export function memoryListedHeading(listed: number, used: number, t: CanvasCoreT = canvasCoreEnglish): string {
  return t(used > 0 ? "memory.used.lookedThroughMore" : "memory.used.lookedThrough", { count: listed, n: String(listed) });
}

/** The canvas chip under an answer: "Used 3 memories", "Looked through 6 memories", "Used 1 memory · looked through 5 more". */
export function memoryUsedLabel(count: number, listed = 0, t: CanvasCoreT = canvasCoreEnglish): string {
  if (count === 0 && listed > 0) return memoryListedHeading(listed, 0, t);
  return listed === 0
    ? t("memory.used.used", { count, n: String(count) })
    : t("memory.used.usedAndLooked", { count, n: String(count), listed: String(listed) });
}

/** The terminal's dim line after an answer: "memory: 3 used · /why", "memory: 6 looked through · /why". */
export function memoryUsedLine(count: number, listed = 0, t: CanvasCoreT = canvasCoreEnglish): string {
  const parts = [
    ...(count > 0 || listed === 0 ? [t("memory.usedLine.used", { count, n: String(count) })] : []),
    ...(listed > 0 ? [t("memory.usedLine.looked", { count: listed, n: String(listed) })] : []),
  ];
  return t("memory.usedLine", { parts: parts.join(", ") });
}

/**
 * The terminal's one line for a card: what it holds by state, named
 * by title — never a sensitive or forgotten record's text — and, while
 * anything waits, how to decide it: `/memory keep <n>` for a plain
 * proposal, the app for a sensitive one. A card of more than one item puts
 * each item's number before its name, so `/memory keep 2` decides one.
 */
export function memoryCardLine(card: Pick<MemoryCardAnswer, "title" | "items" | "forgotten" | "digest">, t: CoreT = coreEnglish): string {
  const title = memoryCardTitleText(card.title, t);
  if (card.items.length === 0 && card.forgotten === 0) return `◆ ${t("memory.line.decided", { title })}`;
  // A digest is always numbered, and says first what it is while anything on it waits.
  const digest = card.digest !== undefined;
  const numbered = card.items.length > 1 || digest;
  const parts: string[] = digest && card.items.some((item) => item.state === "proposed") ? [title] : [];
  for (const state of MEMORY_CARD_STATES) {
    const items = card.items.filter((item) => item.state === state);
    const count = items.length + (state === "forgotten" ? card.forgotten : 0);
    if (count === 0) continue;
    if (state === "forgotten" || state === "hidden") {
      parts.push(`${t(STATE_LABELS[state])}: ${t("memory.line.items", { count, n: String(count) })}`);
      continue;
    }
    // A waiting tidy-up is marked: it is compared in the app. One proposed after the chat read
    // untrusted content says what it read.
    const tidy = (item: MemoryCardItem): string => {
      if (state !== "proposed") return "";
      const read = item.sensitive ? undefined : memoryCardProvenanceLine(item);
      return `${item.tidyUp === true ? ` ${t("memory.line.tidyUp")}` : ""}${read === undefined ? "" : ` (${read})`}`;
    };
    if (numbered) {
      parts.push(
        `${t(STATE_LABELS[state])}: ${items.map((item) => `${item.number}. ${item.sensitive ? t("memory.line.sensitiveItem") : (item.title ?? t("memory.card.item.untitled"))}${tidy(item)}`).join("; ")}`,
      );
      continue;
    }
    const sensitive = items.filter((item) => item.sensitive).length;
    const names = [
      ...items.filter((item) => !item.sensitive).map((item) => `${item.title ?? t("memory.card.item.untitled")}${tidy(item)}`),
      ...(sensitive > 0 ? [t("memory.line.sensitiveItems", { count: sensitive, n: String(sensitive) })] : []),
    ];
    parts.push(`${t(STATE_LABELS[state])}: ${names.join("; ")}`);
  }
  const keepable = card.items.filter(memoryCardItemKeepable);
  const plain = card.items.filter(memoryCardItemIsPlain);
  const sensitiveWaiting = card.items.some((item) => item.state === "proposed" && item.sensitive);
  // An update is replaced in the app, and a tidy-up compared there: neither is kept from here.
  const updateWaiting = card.items.some(
    (item) => item.state === "proposed" && !item.sensitive && (item.updates !== undefined || item.mayUpdate !== undefined),
  );
  const tidyWaiting = card.items.some(
    (item) =>
      item.state === "proposed" && !item.sensitive && item.updates === undefined && item.mayUpdate === undefined && item.tidyUp === true,
  );
  const commands = memoryCardCommands(keepable, plain.length, digest, t);
  const looks = [
    ...(sensitiveWaiting
      ? [t(keepable.length === 0 && !updateWaiting && !tidyWaiting ? "memory.line.openToReview" : "memory.line.openForSensitive")]
      : []),
    ...(updateWaiting ? [t("memory.line.openToReplace")] : []),
    ...(tidyWaiting ? [t("memory.line.openToCompare")] : []),
  ];
  const hint = [...commands, ...looks].join(" · ");
  return `◆ ${parts.join(" · ")}${hint === "" ? "" : ` — ${hint}`}`;
}

/**
 * The `/memory` commands a card's waiting items take: one item's own
 * keep and discard, else by number — and *keep all* only while a plain one
 * waits, since it keeps nothing else. In `t`'s words, as `/memory` takes them in every language.
 */
function memoryCardCommands(keepable: readonly MemoryCardItem[], plain: number, digest: boolean, t: CoreT): string[] {
  const [only] = keepable;
  if (keepable.length === 0 || only === undefined) return [];
  if (keepable.length === 1 && !digest)
    return [t("channel.memory.cmd.keep", { n: String(only.number) }), t("channel.memory.cmd.discard", { n: String(only.number) })];
  const any = "<n>";
  return [
    t("channel.memory.cmd.keep", { n: any }),
    ...(plain > 0 ? [t("channel.memory.cmd.keepAll")] : []),
    t("channel.memory.cmd.discard", { n: any }),
  ];
}

/** What a listed item proposed after its chat read untrusted content adds: *Keep all* leaves it waiting. */
export const MEMORY_PROVENANCE_KEEP_ALONE = canvasCoreEnglish("memory.card.keepAllLeavesIt");

/**
 * A channel card's button press: `y:<token>:<op>`, at most 36
 * bytes, well within a channel's 64. `token` is one of the card's
 * `tavi_memory_prompts` rows; a lower-case op acts on that row's record
 * (`k` keep, `d` discard, `u` undo), an upper-case one on every record of
 * the row's card (`K` keep all, `D` discard all, `U` undo all), and `o`
 * says where to open it.
 */
export const MEMORY_CARD_PRESS = /^y:([A-Za-z0-9_-]{8,32}):([kduoKDU])$/;
export type MemoryCardPressOp = "k" | "d" | "u" | "o" | "K" | "D" | "U";

/** A press's callback data. */
export function memoryCardPressData(token: string, op: MemoryCardPressOp): string {
  return `y:${token}:${op}`;
}

/** Where a channel card is opened: the owner knows no address for the canvas. */
export const MEMORY_CARD_OPEN_HINT = `Open Tavi to review: ${englishOf(navPath("nav.route.center", "nav.center.identity"))}.`;

/** `MEMORY_CARD_OPEN_HINT` in `t`'s words. */
export function memoryCardOpenHint(t: CoreT = coreEnglish): string {
  return t("channel.memory.card.openHint", { path: renderTextRef(navPath("nav.route.center", "nav.center.identity"), t) ?? "" });
}

/**
 * How a channel shows a card: `buttons` where it has interactions,
 * `text` with the `/memory` commands where it has none, `email` with no
 * actions at all (a From address can be forged).
 */
export type MemoryCardChannelMode = "buttons" | "text" | "email";

export interface MemoryCardChannelMessage {
  readonly text: string;
  /** One row, at most 3 buttons (the house rule); empty when nothing on the card can be acted on. */
  readonly buttons: readonly { readonly label: string; readonly data: string }[];
}

/**
 * A card as a channel message, rendered from what the card
 * holds now. Buttons depend on that: one plain proposal gets *Keep* /
 * *Discard* / *Open*, two or more items *Keep all* / *Discard all* / *Open*
 * with the items numbered so `/memory keep 2` decides one, and saved
 * records *Undo* / *Open*. Never more than 3. A sensitive record is never
 * named: "1 sensitive item waiting — open Tavi to review", and it gets no
 * *Keep* (*Keep all* leaves it waiting). Nor does an update: it names what
 * it updates and is replaced in the app; nor a
 * tidy-up, marked to be compared in the app.
 */
export function memoryCardChannelMessage(
  card: Pick<MemoryCardAnswer, "title" | "items" | "forgotten" | "digest">,
  mode: MemoryCardChannelMode,
  t: CoreT = coreEnglish,
): MemoryCardChannelMessage {
  const items = card.items;
  const waiting = items.filter((item) => item.state === "proposed");
  const plain = waiting.filter(memoryCardItemIsPlain);
  const saved = items.filter((item) => item.state === "saved");
  const lines: string[] = [memoryCardHeading(card, t)];
  const [only] = items;
  // A digest is always a numbered list of titles, with *Review* for its Open, whatever it holds.
  const digest = card.digest !== undefined;
  const more = digest ? Math.max(0, (card.digest?.waiting ?? 0) - items.length - card.forgotten) : 0;
  const open = t(digest ? "channel.memory.button.review" : "channel.memory.button.open");
  if (items.length === 1 && only !== undefined && !digest) {
    if (only.sensitive && only.state === "proposed") lines.push(t("channel.memory.card.oneSensitive"));
    else if (only.state !== "forgotten") {
      lines.push(memoryCardItemName(only, t));
      if (!only.sensitive && only.excerpt !== null) lines.push(only.excerpt);
      const read = only.state === "proposed" && !only.sensitive ? memoryCardProvenanceLine(only, t) : undefined;
      if (read !== undefined) lines.push(read);
      if (only.state === "proposed" && only.updates !== undefined)
        lines.push(t("channel.memory.card.itReplace", { line: memoryUpdatesLine(only.updates, t) }));
      else if (only.state === "proposed" && only.mayUpdate !== undefined)
        lines.push(t("channel.memory.card.itReplace", { line: memoryMayUpdateLine(only.mayUpdate, t) }));
      else if (only.state === "proposed" && only.tidyUp === true) lines.push(t("channel.memory.card.tidyUp"));
    }
  } else {
    for (const item of items) {
      const read = item.state === "proposed" && !item.sensitive ? memoryCardProvenanceLine(item, t) : undefined;
      const suffix =
        item.state === "proposed"
          ? (item.sensitive
              ? t("channel.memory.review.openToReview")
              : item.updates !== undefined
                ? t("channel.memory.review.replace", { line: memoryUpdatesLine(item.updates, t) })
                : item.mayUpdate !== undefined
                  ? t("channel.memory.review.replace", { line: memoryMayUpdateLine(item.mayUpdate, t) })
                  : item.tidyUp === true
                    ? ` — ${t("memory.card.tidyUpLook")}`
                    : "") + (read === undefined ? "" : ` — ${read}; ${t("memory.card.keepAllLeavesIt")}`)
          : ` — ${memoryCardStateLabel(item.state, t).toLowerCase()}`;
      lines.push(
        `${item.number}. ${item.state === "proposed" && item.sensitive ? t("memory.card.item.sensitive") : memoryCardItemName(item, t)}${suffix}`,
      );
    }
    if (card.forgotten > 0 && items.length > 0)
      lines.push(t("channel.memory.card.forgottenItems", { count: card.forgotten, n: String(card.forgotten) }));
    if (more > 0 && waiting.length > 0) lines.push(t("channel.memory.card.more", { n: String(more) }));
  }
  if (mode === "email") {
    if (waiting.length > 0) lines.push(t("channel.memory.card.openEmail"));
    return { text: lines.join("\n"), buttons: [] };
  }
  if (mode === "text") {
    const hint = memoryCardCommands(items.filter(memoryCardItemKeepable), plain.length, digest, t);
    const [kept] = saved;
    if (waiting.length === 0 && saved.length === 1 && kept !== undefined)
      hint.push(t("channel.memory.card.forgetUndoes", { n: String(kept.number) }));
    if (hint.length > 0) lines.push(hint.join(" · "));
    return { text: lines.join("\n"), buttons: [] };
  }
  const buttons = (ops: readonly (readonly [string, MemoryCardPressOp])[], token: string) =>
    ops.map(([label, op]) => ({ label, data: memoryCardPressData(token, op) }));
  if (items.length === 1 && only !== undefined && !digest) {
    if (only.state === "proposed") {
      // One proposed after the chat read a page is kept by its own *Keep*: the card says what the chat read.
      const ops: readonly (readonly [string, MemoryCardPressOp])[] = only.sensitive
        ? [[open, "o"]]
        : !memoryCardItemKeepable(only)
          ? [
              [t("channel.memory.button.discard"), "d"],
              [open, "o"],
            ]
          : [
              [t("channel.memory.button.keep"), "k"],
              [t("channel.memory.button.discard"), "d"],
              [open, "o"],
            ];
      return { text: lines.join("\n"), buttons: buttons(ops, only.token) };
    }
    if (only.state === "saved")
      return {
        text: lines.join("\n"),
        buttons: buttons(
          [
            [t("channel.memory.button.undo"), "u"],
            [open, "o"],
          ],
          only.token,
        ),
      };
    return { text: lines.join("\n"), buttons: [] };
  }
  const [first] = items;
  if (first === undefined) return { text: lines.join("\n"), buttons: [] };
  if (waiting.length > 0)
    return {
      text: lines.join("\n"),
      buttons: buttons(
        plain.length > 0
          ? [
              [t("channel.memory.button.keepAll"), "K"],
              [t("channel.memory.button.discardAll"), "D"],
              [open, "o"],
            ]
          : [
              [t("channel.memory.button.discardAll"), "D"],
              [open, "o"],
            ],
        first.token,
      ),
    };
  if (saved.length > 0)
    return {
      text: lines.join("\n"),
      buttons: buttons(
        [
          [t("channel.memory.button.undo"), "U"],
          [open, "o"],
        ],
        first.token,
      ),
    };
  return { text: lines.join("\n"), buttons: [] };
}

/**
 * `memory {action: "card-all"}`: a card's *Keep all* or *Discard
 * all* in the app, under the one *Keep all* rule — *Keep all* keeps only the plain
 * proposals on the card; a sensitive one, or one whose key or topic another
 * kept value holds, stays waiting and is counted in `needsLook`. A *Keep all*
 * that kept anything posts a *Saved · N* receipt card (`receiptNoticeId`)
 * whose Undo forgets exactly those.
 */
export const MemoryCardAllAnswerSchema = z.strictObject({
  kept: z.number().int().nonnegative(),
  discarded: z.number().int().nonnegative(),
  needsLook: z.number().int().nonnegative(),
  receiptNoticeId: IdSchema.optional(),
});
export type MemoryCardAllAnswer = z.infer<typeof MemoryCardAllAnswerSchema>;

/** What a *Keep all* says: "Kept 4", or "Kept 4 · 1 needs a look — open Tavi to review". */
export function memoryKeptAllText(kept: number, needsLook: number, t: CanvasCoreT = canvasCoreEnglish): string {
  return needsLook === 0
    ? t("memory.card.keptAll", { count: String(kept) })
    : t("memory.card.keptAllNeedsLook", { kept: String(kept), count: needsLook, n: String(needsLook) });
}
