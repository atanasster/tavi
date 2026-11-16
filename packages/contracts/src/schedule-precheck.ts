import { z } from "zod";

import { watchablePage } from "./heartbeat.js";

/**
 * A schedule's pre-check: one read-only, deterministic look before a fire runs,
 * so a fire with nothing new to work on makes no model call.
 *
 * - `page-changed`: the page's readable text, normalised, hashes differently
 *   from the last reading.
 * - `feed-has-new`: an RSS or Atom feed lists an item not seen at the last
 *   reading, and none older than its newest.
 * - `file-changed`: a file under one of the owner's `--fs-root` folders has
 *   different content (by hash) from the last reading.
 *
 * Off unless a schedule names one. A page or feed is fetched as a heartbeat's
 * watched page is (the guarded public fetch: https, a public address, no
 * credentials, bounded size and time), dialling only the address's own host;
 * a file is read only under an `--fs-root`, checked when the schedule is saved
 * and again at each check. The check runs no tool and no model, and what it
 * read never reaches the run: the run is told only what changed — the address
 * or the path — and fetches or reads it itself, under its own tool policy.
 */
export const SCHEDULE_PRECHECK_KINDS = ["page-changed", "feed-has-new", "file-changed"] as const;
export type SchedulePrecheckKind = (typeof SCHEDULE_PRECHECK_KINDS)[number];

/** The longest pre-check target: an address or a path. */
const SCHEDULE_PRECHECK_TARGET_MAX = 2048;

/** Why a pre-check's target is not one its kind can check, in words; none for one that is. */
export function schedulePrecheckProblem(precheck: { readonly kind: SchedulePrecheckKind; readonly target: string }): string | undefined {
  const { kind, target } = precheck;
  if (kind === "file-changed") {
    if (!/^(\/|[A-Za-z]:[\\/])/.test(target)) return `${kind} needs an absolute path under an --fs-root`;
    // A path is stated to a run on one line.
    if (/[\u0000-\u001f\u007f]/.test(target)) return `${kind}'s path has a line break or a control character`;
    return undefined;
  }
  const page = watchablePage(target);
  if (page === undefined) return `${kind} needs an https address with a named host, no port and no credentials`;
  if (page.url !== target) return `${kind}'s address is written ${page.url}`;
  return undefined;
}

export const SchedulePrecheckSchema = z
  .strictObject({
    kind: z.enum(SCHEDULE_PRECHECK_KINDS),
    /** The https address (`page-changed`, `feed-has-new`) or the absolute path (`file-changed`). */
    target: z.string().min(1).max(SCHEDULE_PRECHECK_TARGET_MAX),
  })
  .superRefine((precheck, context) => {
    const problem = schedulePrecheckProblem(precheck);
    if (problem !== undefined) context.addIssue({ code: "custom", path: ["target"], message: problem });
  });
export type SchedulePrecheck = z.infer<typeof SchedulePrecheckSchema>;

/** The text that turns a schedule's pre-check off: `--precheck none`, the tools' and the form's "none". */
export const SCHEDULE_PRECHECK_NONE = "none";

/**
 * A pre-check as it is typed — `page-changed:https://…`, `feed-has-new:https://…`,
 * `file-changed:/path` (a space after the kind works as the colon does) — or
 * `none` (`null`): the CLI's `--precheck`, the tools' `precheck` and the web
 * form all take this one text. A page's address is written as it is fetched
 * (`watchablePage`); a path is taken as given, and the owner checks it is under
 * an `--fs-root` when the schedule is saved.
 */
export function parseSchedulePrecheck(
  text: string,
): { readonly ok: true; readonly precheck: SchedulePrecheck | null } | { readonly ok: false; readonly message: string } {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === SCHEDULE_PRECHECK_NONE || trimmed === "") return { ok: true, precheck: null };
  const match = /^([a-z-]+)(?::|\s+)\s*(.+)$/i.exec(trimmed);
  const kind = match?.[1]?.toLowerCase();
  if (match?.[2] === undefined || !(SCHEDULE_PRECHECK_KINDS as readonly string[]).includes(kind ?? ""))
    return {
      ok: false,
      message: `a pre-check is ${SCHEDULE_PRECHECK_KINDS.map((name) => `${name}:<${name === "file-changed" ? "path" : "https address"}>`).join(", ")} or ${SCHEDULE_PRECHECK_NONE}`,
    };
  const raw = match[2].trim();
  const target = kind === "file-changed" ? raw : (watchablePage(raw)?.url ?? raw);
  const parsed = SchedulePrecheckSchema.safeParse({ kind, target });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
  return { ok: true, precheck: parsed.data };
}

/** A pre-check as it is typed back: `page-changed:https://…`. */
export function schedulePrecheckText(precheck: SchedulePrecheck): string {
  return `${precheck.kind}:${precheck.target}`;
}

/** What a pre-check does, in words: the CLI's `show`, the tools' answers and the web page say it alike. */
export function schedulePrecheckSentence(precheck: SchedulePrecheck | undefined): string {
  if (precheck === undefined) return "none: every fire runs";
  if (precheck.kind === "page-changed") return `runs only when the page ${precheck.target} has changed since the last check`;
  if (precheck.kind === "feed-has-new") return `runs only when the feed ${precheck.target} has new items since the last check`;
  return `runs only when the file ${precheck.target} has changed since the last check`;
}

/** How many of a feed's item ids a pre-check remembers, newest first. */
export const SCHEDULE_PRECHECK_FEED_IDS = 100;

/**
 * What a pre-check last read, kept per schedule: a fingerprint of the page's
 * text, the feed's items or the file's content, and for a feed the hashed ids
 * of its newest items and the newest item's date. Forgotten whenever the
 * pre-check changes.
 */
export const SchedulePrecheckStateSchema = z.strictObject({
  /** SHA-256 hex of what the check compares: the normalised page text, the feed's item ids, the file's content. */
  fingerprint: z.string().min(1).max(128),
  /** When this reading was taken, ISO-8601 UTC. */
  checkedAt: z.string().min(1).max(40),
  /** A feed's newest item date, ISO-8601 UTC, when its items have dates. */
  latest: z.string().min(1).max(40).optional(),
  /** A feed's newest item ids, each hashed. */
  ids: z.array(z.string().min(1).max(64)).max(SCHEDULE_PRECHECK_FEED_IDS).optional(),
});
export type SchedulePrecheckState = z.infer<typeof SchedulePrecheckStateSchema>;

/**
 * What one pre-check found:
 *
 * - `first`: there was no earlier reading (a new or changed pre-check): the fire runs, and this reading becomes the baseline.
 * - `changed`: something differs from the last reading: the fire runs, told what changed (`newItems` for a feed).
 * - `unchanged`: nothing differs: no run, no model call; `state` is the same reading, checked again.
 * - `failed`: the check could not be made — refused by the egress guard or the `--fs-root` rule, or the page or file could not be read.
 */
export type SchedulePrecheckResult =
  | { readonly kind: "first"; readonly state: SchedulePrecheckState }
  | { readonly kind: "changed"; readonly state: SchedulePrecheckState; readonly newItems?: number }
  | { readonly kind: "unchanged"; readonly state: SchedulePrecheckState }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * What a fire's run is told of its pre-check: what changed — the address or the
 * path, never what was read there — and that it reads it itself.
 */
export function schedulePrecheckNote(
  precheck: SchedulePrecheck,
  result: Extract<SchedulePrecheckResult, { kind: "first" | "changed" }>,
  lastCheckedAt: string | undefined,
): string {
  const what =
    precheck.kind === "page-changed"
      ? `the page ${precheck.target}`
      : precheck.kind === "feed-has-new"
        ? `the feed ${precheck.target}`
        : `the file ${precheck.target}`;
  if (result.kind === "first")
    return `Pre-check: this is the first check of ${what}, so there is no earlier reading to compare with. Its content is not included here: read it yourself if the task needs it.`;
  const since = lastCheckedAt === undefined ? "since the last check" : `since the last check (${lastCheckedAt})`;
  const change =
    precheck.kind === "feed-has-new"
      ? `${what} has ${result.newItems === undefined ? "new items" : `${String(result.newItems)} new ${result.newItems === 1 ? "item" : "items"}`} ${since}`
      : `${what} has changed ${since}`;
  return `Pre-check: ${change}. Its content is not included here: read it yourself if the task needs it.`;
}
