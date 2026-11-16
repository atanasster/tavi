import type {
  MemoryItem,
  MemoryKind,
  MemoryLimitName,
  MemoryListAnswer,
  MemoryScopeTarget,
  MemoryUsageAnswer,
  SystemPromptLayer,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import { formatBytes, formatCount } from "../../lib/format.js";

/**
 * Soul & memory's pure reads: what a layer says
 * about where it came from, what a scope is called, how records group, and the
 * usage line. Kept free of React so each is asserted on its own.
 */

/** A record's line: its title, or what stands in for one the page may not show. */
export function recordTitle(record: Pick<MemoryItem, "redacted" | "title" | "body">): string {
  if (record.redacted) return "Sensitive record";
  return record.title ?? record.body?.split("\n", 1)[0] ?? "Untitled";
}

/** The order groups are shown in, and what each is called. */
export const MEMORY_GROUPS: readonly { readonly kind: MemoryKind; readonly label: string }[] = [
  { kind: "fact", label: "Facts" },
  { kind: "preference", label: "Preferences" },
  { kind: "lesson", label: "Lessons" },
  { kind: "summary", label: "Summaries" },
];

/** A kind in the singular; a record typed so every kind the contract knows has one. */
export const KIND_LABELS: Readonly<Record<MemoryKind, string>> = {
  fact: "Fact",
  preference: "Preference",
  lesson: "Lesson",
  summary: "Summary",
};

/** Records under their kind, in `MEMORY_GROUPS` order, empty groups left out. */
export function groupByKind(
  records: readonly MemoryItem[],
): readonly { readonly kind: MemoryKind; readonly label: string; readonly records: readonly MemoryItem[] }[] {
  return MEMORY_GROUPS.map((group) => ({
    kind: group.kind,
    label: group.label,
    records: records.filter((record) => record.kind === group.kind),
  })).filter((group) => group.records.length > 0);
}

/** What a scope chip says: Personal, Workspace, Shared, or the agent's name. */
export function scopeLabel(target: MemoryScopeTarget, agentNames: Readonly<Record<string, string>>): string {
  if (target === "personal") return "Personal";
  if (target === "workspace") return "Workspace";
  if (target === "shared") return "Shared";
  const agentId = target.slice("agent:".length);
  return `Agent: ${agentNames[agentId] ?? agentId}`;
}

/** The shared scope is published by an explicit share: nothing here changes it. */
export const readOnly = (record: Pick<MemoryItem, "target">): boolean => record.target === "shared";

/** A limit, without a trailing ".0": "32 MiB". */
const formatLimit = (bytes: number): string => formatBytes(bytes).replace(".0 ", " ");

const recordsText = (records: number): string => `${formatCount(records)} ${records === 1 ? "record" : "records"}`;

/**
 * The usage line. With the operator's quota (the one a record they write is
 * charged to): "11 records · 3.1 KiB of 32 MiB". An older owner names no
 * quota, so none is claimed: "11 records · 3.1 KiB".
 */
export function usageLine(usage: MemoryUsageAnswer): string {
  const quota = usage.quota;
  if (quota === undefined) return `${recordsText(usage.records)} · ${formatBytes(usage.bytes)}`;
  return `${recordsText(quota.records)} · ${formatBytes(quota.bytes)} of ${formatLimit(quota.maxBytes)}`;
}

/** "3 proposals from 2 other people wait for review (Khan 2, Bob 1).", or nothing when none wait. */
export function otherProposalsLine(
  others: MemoryListAnswer["otherProposals"],
  people: Readonly<Record<string, string>>,
): string | undefined {
  if (others === undefined || others.length === 0) return undefined;
  const total = others.reduce((sum, person) => sum + person.count, 0);
  const who = others.map((person) => `${people[person.principalId] ?? person.principalId} ${person.count}`).join(", ");
  return `${plural(total, "proposal")} from ${plural(others.length, "other person", "other people")} ${total === 1 ? "waits" : "wait"} for review (${who}).`;
}

/** "Also stored for 2 other people: 5 records (alice 3, bob 2)", or nothing when nobody else has memory here. */
export function otherPeopleLine(others: MemoryListAnswer["otherPeople"], people: Readonly<Record<string, string>>): string | undefined {
  if (others.length === 0) return undefined;
  const total = others.reduce((sum, person) => sum + person.count, 0);
  const who = others.map((person) => `${people[person.principalId] ?? person.principalId} ${person.count}`).join(", ");
  return `Also stored for ${plural(others.length, "other person", "other people")}: ${plural(total, "record")} (${who})`;
}

/** Where a layer's text comes from, in a line under its label. */
export function layerSource(layer: SystemPromptLayer): string {
  if (layer.generated) return "Written per response";
  if (!layer.active && layer.detail !== undefined) return layer.detail;
  switch (layer.kind) {
    case "base":
      return layer.source === "workspace"
        ? "Your prompt"
        : layer.source === "explicit"
          ? "An adapter's explicit prompt"
          : "Shipped with Tavi";
    case "persona":
      return "Agent definition, appended";
    default:
      return layer.detail ?? "";
  }
}

/** The approved records as loaded: every page read so far, and where the next begins. */
export interface ListedRecords {
  readonly records: readonly MemoryItem[];
  readonly nextCursor: string | undefined;
}

/**
 * A live refresh over what is held. The refresh reads as many records as are
 * held (up to one request's bound, `limit`), so a reader who loaded more keeps
 * them: the fresh records replace the first `limit` held, and older held ones
 * past the bound stay with the cursor that follows them. A record open for
 * correction (`keep`) stays even when the refresh no longer lists it, so its
 * draft is not lost under the reader.
 */
export function refreshRecords<T extends ListedRecords>(held: T | undefined, page: T, limit: number, keep: ReadonlySet<string>): T {
  if (held === undefined) return page;
  const fresh = new Set(page.records.map((record) => record.recordId));
  const covered = held.records.slice(0, limit);
  const beyond = held.records.slice(limit).filter((record) => !fresh.has(record.recordId));
  const kept = covered.filter((record) => keep.has(record.recordId) && !fresh.has(record.recordId));
  return {
    ...page,
    records: [...page.records, ...kept, ...beyond],
    nextCursor: held.records.length > limit ? held.nextCursor : page.nextCursor,
  };
}

/** The version a revealed text belongs to: a refresh that moves it makes the text stale. */
export const revealKey = (record: Pick<MemoryItem, "currentRevisionId" | "updatedAt">): string =>
  `${record.currentRevisionId ?? ""}|${record.updatedAt}`;

/** The limits under the settings card's *More*, in order, with what each bounds. */
export const MEMORY_LIMIT_FIELDS: readonly { readonly name: MemoryLimitName; readonly label: string; readonly hint: string }[] = [
  {
    name: "contextTokens",
    label: "Context budget (tokens)",
    hint: "The budget for a call's instructions and memory together; memory gets what the instructions leave.",
  },
  { name: "evidence", label: "Memories recalled per call", hint: "0 recalls none by search." },
  { name: "proposalDays", label: "Days a proposal waits", hint: "Then it expires unreviewed." },
  { name: "maxRecords", label: "Records per person", hint: "The storage quota follows it." },
];
