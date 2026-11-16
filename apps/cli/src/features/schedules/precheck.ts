import type { Stats } from "node:fs";
import { type FileHandle, lstat, realpath } from "node:fs/promises";
import {
  SCHEDULE_PRECHECK_FEED_IDS,
  TaviError,
  type ScheduleRecord,
  type SchedulePrecheck,
  type SchedulePrecheckResult,
  type SchedulePrecheckState,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { openNoFollow, sameIdentity, sha256Hex } from "@tavi/node-kit";
import type { ScheduleSchedulerDependencies } from "@tavi/agent-host/schedule-scheduler";

import type { SitePolicy } from "../browser/site-policy.js";

/** A file a pre-check reads is hashed whole up to this size; a larger one is compared by its size and modification time. */
const PRECHECK_FILE_HASH_BYTES = 16 * 1024 * 1024;

/** A file a pre-check hashes is read in chunks of this size. */
const PRECHECK_READ_CHUNK_BYTES = 1024 * 1024;

/** The most items a feed is read for. */
const FEED_ITEMS_MAX = 1000;

export interface SchedulePrecheckDependencies {
  /**
   * The guarded public fetch a heartbeat's watched pages are read with, dialling only `allowedHosts`: https,
   * a public address, no credentials, bounded size and time. Its status and readable text.
   */
  readonly fetchPage: (
    url: string,
    allowedHosts: readonly string[],
    signal: AbortSignal,
  ) => Promise<{ readonly status: number; readonly text: string }>;
  /** The owner's `--fs-root` rule for a file (`ChatFolders.checkReadableFile`): its real path, or a refusal. */
  readonly checkFile: (path: string) => string;
  /** The owner's site profiles, which a page or feed is held to as any unattended read is (`beforeNavigate`). */
  readonly sites?: Pick<SitePolicy, "beforeNavigate" | "taskEnded">;
  readonly now: () => string;
}

/**
 * Why the owner's site profiles refuse reading `url` unattended — a profile
 * that is not browsed or not watchable, or a path its robots.txt disallows —
 * or none when they allow it. The check is its own task, ended once made.
 */
export async function precheckSiteRefusal(
  sites: Pick<SitePolicy, "beforeNavigate" | "taskEnded">,
  input: { readonly workspaceId: string; readonly taskId: string; readonly url: string; readonly signal: AbortSignal },
): Promise<string | undefined> {
  try {
    return (await sites.beforeNavigate({ ...input, unattended: true }))?.refused;
  } finally {
    sites.taskEnded(input.taskId);
  }
}

/**
 * A schedule's pre-check, as the scheduler makes it before a fire: one read of
 * a page, a feed or a file, compared with the last reading. Read-only and
 * model-free; it runs no tool. A page or feed is fetched as a watched page is,
 * from its own host only and where its site profile allows an unattended
 * read; a file is read only where the `--fs-root` rule
 * allows, checked again at each read. Anything that stops the read — a refusal,
 * an error answer, a file gone — is `failed`, never thrown.
 */
export function createSchedulePrecheck(deps: SchedulePrecheckDependencies): NonNullable<ScheduleSchedulerDependencies["precheck"]> {
  return async (schedule, precheck, last, signal) => {
    try {
      if (precheck.kind === "file-changed") return compared(last, await fileFingerprint(deps, precheck.target), deps.now());
      const text = await fetched(deps, schedule, precheck, signal);
      if (precheck.kind === "page-changed") return compared(last, sha256Hex(text.replace(/\s+/g, " ").trim()), deps.now());
      return feedCompared(last, text, deps.now());
    } catch (error) {
      return { kind: "failed", reason: errorMessage(error) };
    }
  };
}

/** A page's or feed's text, read from its own host only and where its site profile allows; an error answer says nothing of it. */
async function fetched(
  deps: SchedulePrecheckDependencies,
  schedule: ScheduleRecord,
  precheck: SchedulePrecheck,
  signal: AbortSignal,
): Promise<string> {
  const refused =
    deps.sites === undefined
      ? undefined
      : await precheckSiteRefusal(deps.sites, {
          workspaceId: schedule.workspaceId,
          taskId: `schedule-precheck:${schedule.scheduleId}`,
          url: precheck.target,
          signal,
        });
  if (refused !== undefined) throw new TaviError("NOT_AUTHORIZED", refused);
  const host = new URL(precheck.target).hostname.toLowerCase();
  const page = await deps.fetchPage(precheck.target, [host], signal);
  if (page.status < 200 || page.status >= 300) throw new TaviError("UNAVAILABLE", `${precheck.target} answered ${String(page.status)}`);
  return page.text;
}

/** A fingerprint against the last reading's. */
function compared(last: SchedulePrecheckState | undefined, fingerprint: string, now: string): SchedulePrecheckResult {
  const state = { fingerprint, checkedAt: now };
  if (last === undefined) return { kind: "first", state };
  return { kind: last.fingerprint === fingerprint ? "unchanged" : "changed", state };
}

/**
 * A file's fingerprint: its content's hash, or its size and modification time when it is too large to hash.
 * A symlink at the watched path is followed, by design: the checks are on the path it resolves to, which must
 * be a regular file. The open neither follows a link put there since (`O_NOFOLLOW`) nor blocks on a FIFO
 * (`O_NONBLOCK`), and what it opened must be the file checked, by device and inode. `O_NOFOLLOW` covers only the
 * last segment, so once open the checked path must still resolve to itself, to what was opened: a folder above it
 * swapped for a link since the check would have led the open elsewhere (`stillAt`). At most one byte past the
 * hash limit is read, so a file that grew past it after the check is fingerprinted as a large one.
 */
async function fileFingerprint(deps: SchedulePrecheckDependencies, path: string): Promise<string> {
  const real = deps.checkFile(path);
  const checked = await lstat(real);
  if (!checked.isFile()) throw new TaviError("INVALID_INPUT", `${path} is not a file`);
  const handle = await openNoFollow(real, "read");
  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new TaviError("INVALID_INPUT", `${path} is not a file`);
    if (!sameIdentity(status, checked)) throw new TaviError("NOT_AUTHORIZED", `${path} changed while it was being opened`);
    if (!(await stillAt(real, status))) throw new TaviError("NOT_AUTHORIZED", `${path} changed while it was being opened`);
    const bySize = (stats: Stats) => sha256Hex(`size:${String(stats.size)}:mtime:${String(stats.mtimeMs)}`);
    if (status.size > PRECHECK_FILE_HASH_BYTES) return bySize(status);
    const bytes = await readAtMost(handle, PRECHECK_FILE_HASH_BYTES + 1);
    return bytes.byteLength > PRECHECK_FILE_HASH_BYTES ? bySize(await handle.stat()) : sha256Hex(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Whether `real`, the checked real path, still resolves to itself (no folder above it is now a link) and names
 * `opened`, by device and inode (`sameIdentity`). Either failing means the open may have landed outside what was checked.
 */
async function stillAt(real: string, opened: Pick<Stats, "dev" | "ino" | "birthtimeMs">): Promise<boolean> {
  try {
    if ((await realpath(real)) !== real) return false;
    const now = await lstat(real);
    return sameIdentity(now, opened);
  } catch {
    return false;
  }
}

/** Up to `limit` bytes from the start of an open file, fewer when it ends sooner, read in chunks so a small file costs little. */
async function readAtMost(handle: FileHandle, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let filled = 0;
  while (filled < limit) {
    const chunk = Buffer.allocUnsafe(Math.min(PRECHECK_READ_CHUNK_BYTES, limit - filled));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, filled);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    filled += bytesRead;
  }
  return Buffer.concat(chunks, filled);
}

/** One item of a feed: its identity (a guid, an id, a link or a title) and its date, when it has one. */
interface FeedItem {
  readonly id: string;
  readonly at?: number;
}

/**
 * A feed against the last reading: new when it lists an item not seen then, and not older than the newest seen.
 * Only the items remembered are compared: the newest when they have dates, else the first in the feed's order.
 */
function feedCompared(last: SchedulePrecheckState | undefined, text: string, now: string): SchedulePrecheckResult {
  const listed = feedItems(text);
  const ordered = listed.some((item) => item.at !== undefined) ? [...listed].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) : listed;
  const items = ordered.slice(0, SCHEDULE_PRECHECK_FEED_IDS);
  const ids = items.map((item) => sha256Hex(item.id).slice(0, 32));
  const newestAt = items.reduce<number | undefined>(
    (newest, item) => (item.at === undefined || (newest !== undefined && newest >= item.at) ? newest : item.at),
    undefined,
  );
  const latest = newestAt === undefined ? undefined : new Date(newestAt).toISOString();
  const state: SchedulePrecheckState = {
    fingerprint: sha256Hex(ids.join("\n")),
    checkedAt: now,
    ...(latest === undefined ? {} : { latest }),
    ...(ids.length === 0 ? {} : { ids }),
  };
  if (last === undefined) return { kind: "first", state };
  const seen = new Set(last.ids ?? []);
  const newest = last.latest === undefined ? undefined : Date.parse(last.latest);
  const fresh = items.filter(
    (item) => !seen.has(sha256Hex(item.id).slice(0, 32)) && (newest === undefined || item.at === undefined || item.at >= newest),
  );
  return fresh.length === 0 ? { kind: "unchanged", state } : { kind: "changed", state, newItems: fresh.length };
}

/** Where the first `</name>` at or after `from` starts, in any case; -1 when there is none. */
function closingTag(text: string, name: string, from: number): number {
  const close = new RegExp(`</${name}>`, "gi");
  close.lastIndex = from;
  return close.exec(text)?.index ?? -1;
}

/** Text with each closed CDATA section unwrapped, in one pass. */
function withoutCdata(text: string): string {
  let unwrapped = "";
  let at = 0;
  for (let start = text.indexOf("<![CDATA["); start !== -1; start = text.indexOf("<![CDATA[", at)) {
    const end = text.indexOf("]]>", start + "<![CDATA[".length);
    if (end === -1) break;
    unwrapped += text.slice(at, start) + text.slice(start + "<![CDATA[".length, end);
    at = end + "]]>".length;
  }
  return unwrapped + text.slice(at);
}

/** The text of an element's first `name` child, CDATA unwrapped and entities left as they are (they only identify). */
function childText(block: string, name: string): string | undefined {
  const open = new RegExp(`<${name}(?:\\s[^<>]*)?>`, "i").exec(block);
  if (open === null) return undefined;
  const start = open.index + open[0].length;
  const end = closingTag(block, name, start);
  if (end === -1) return undefined;
  const raw = withoutCdata(block.slice(start, end)).trim();
  return raw === "" ? undefined : raw;
}

/**
 * An RSS or Atom feed's items, in the feed's order, at most `FEED_ITEMS_MAX`.
 * Read with patterns, not a parser: only identities and dates are wanted, and
 * nothing read is kept but their hashes. Each tag is found with one forward
 * scan, so the work grows with the text, never with its square. Text that is
 * neither is refused, so a page that moved is a failed check rather than an
 * empty feed.
 */
export function feedItems(text: string): readonly FeedItem[] {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text)) throw new TaviError("UNSUPPORTED", "the address did not answer an RSS or Atom feed");
  const items: FeedItem[] = [];
  // An element with no closing tag after one opening has none after any later one either.
  const unclosed = new Set<string>();
  const open = /<(item|entry)(?:\s[^<>]*)?>/gi;
  for (let match = open.exec(text); match !== null && items.length < FEED_ITEMS_MAX; match = open.exec(text)) {
    const name = (match[1] ?? "").toLowerCase();
    if (unclosed.has(name)) continue;
    const end = closingTag(text, name, open.lastIndex);
    if (end === -1) {
      unclosed.add(name);
      continue;
    }
    const block = text.slice(open.lastIndex, end);
    open.lastIndex = end + `</${name}>`.length;
    const href = /<link\b[^<>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(block)?.[1];
    const id = childText(block, "guid") ?? childText(block, "id") ?? href ?? childText(block, "link") ?? childText(block, "title");
    if (id === undefined) continue;
    const date = childText(block, "pubDate") ?? childText(block, "updated") ?? childText(block, "published") ?? childText(block, "dc:date");
    const at = date === undefined ? Number.NaN : Date.parse(date);
    items.push({ id, ...(Number.isFinite(at) ? { at } : {}) });
  }
  return items;
}
