import type {
  MemoryItem,
  MemoryKind,
  MemoryLimitName,
  MemoryListAnswer,
  MemoryScopeTarget,
  MemoryUsageAnswer,
  SystemPromptLayer,
} from "@tavi/contracts";

import { decimal, formatBytes } from "../../lib/format.js";
import { canvasCoreEnglish, type CanvasCoreKey } from "@tavi/contracts/locales/core-canvas";
import { translateCore, translateNow } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { saidLabels } from "./model.js";

/**
 * Soul & memory's pure reads: what a layer says
 * about where it came from, what a scope is called, how records group, and the
 * usage line. Kept free of React so each is asserted on its own.
 */

/** A record's line: its title, or what stands in for one the page may not show. */
export function recordTitle(record: Pick<MemoryItem, "redacted" | "title" | "body">): string {
  if (record.redacted) return translateNow("center.memoryModel.sensitiveRecord");
  return record.title ?? record.body?.split("\n", 1)[0] ?? translateNow("center.memoryModel.untitled");
}

/** A group of the table, its name said in the page's language when read. */
function group(kind: MemoryKind, key: UiKey): { readonly kind: MemoryKind; readonly label: string } {
  return {
    kind,
    get label() {
      return translateNow(key);
    },
  };
}

/** The order groups are shown in, and what each is called. */
export const MEMORY_GROUPS: readonly { readonly kind: MemoryKind; readonly label: string }[] = [
  group("fact", "center.memoryModel.group.fact"),
  group("preference", "center.memoryModel.group.preference"),
  group("lesson", "center.memoryModel.group.lesson"),
  group("summary", "center.memoryModel.group.summary"),
];

const KIND_KEYS: Readonly<Record<MemoryKind, UiKey>> = {
  fact: "center.memoryModel.kind.fact",
  preference: "center.memoryModel.kind.preference",
  lesson: "center.memoryModel.kind.lesson",
  summary: "center.memoryModel.kind.summary",
};

/** A kind in the singular, in the page's language when read; every kind the contract knows has one. */
export const KIND_LABELS: Readonly<Record<MemoryKind, string>> = saidLabels(KIND_KEYS);

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
  if (target === "personal") return translateNow("center.memoryModel.scope.personal");
  if (target === "workspace") return translateNow("center.memoryModel.scope.workspace");
  if (target === "shared") return translateNow("center.memoryModel.scope.shared");
  const agentId = target.slice("agent:".length);
  return translateNow("center.memoryModel.scope.agent", { agent: agentNames[agentId] ?? agentId });
}

/** The shared scope is published by an explicit share: nothing here changes it. */
export const readOnly = (record: Pick<MemoryItem, "target">): boolean => record.target === "shared";

const KIB = 1024;
const MIB = 1024 * 1024;

/** A limit, a whole number written without a trailing ".0": "32 MiB", "1.5 MiB". */
function formatLimit(bytes: number): string {
  if (bytes < KIB) return formatBytes(bytes);
  const [key, size]: readonly [UiKey, number] = bytes >= MIB ? ["common.bytes.mib", bytes / MIB] : ["common.bytes.kib", bytes / KIB];
  const whole = size.toFixed(1).endsWith(".0");
  return translateNow(key, { size: whole ? size.toFixed(0) : decimal(size) });
}

/**
 * The usage line. With the operator's quota (the one a record they write is
 * charged to): "11 records · 3.1 KiB of 32 MiB". An older owner names no
 * quota, so none is claimed: "11 records · 3.1 KiB".
 */
export function usageLine(usage: MemoryUsageAnswer): string {
  const quota = usage.quota;
  if (quota === undefined) return translateNow("center.memoryModel.usage", { count: usage.records, used: formatBytes(usage.bytes) });
  return translateNow("center.memoryModel.usageOfQuota", {
    count: quota.records,
    used: formatBytes(quota.bytes),
    limit: formatLimit(quota.maxBytes),
  });
}

/** "3 proposals from 2 other people wait for review (Khan 2, Bob 1).", or nothing when none wait. */
export function otherProposalsLine(
  others: MemoryListAnswer["otherProposals"],
  people: Readonly<Record<string, string>>,
): string | undefined {
  if (others === undefined || others.length === 0) return undefined;
  const total = others.reduce((sum, person) => sum + person.count, 0);
  const who = others.map((person) => `${people[person.principalId] ?? person.principalId} ${person.count}`).join(", ");
  return others.length === 1
    ? translateNow("center.memoryModel.otherProposals.onePerson", { count: total, who })
    : translateNow("center.memoryModel.otherProposals.people", { count: total, people: others.length, who });
}

/** "Also stored for 2 other people: 5 records (alice 3, bob 2)", or nothing when nobody else has memory here. */
export function otherPeopleLine(others: MemoryListAnswer["otherPeople"], people: Readonly<Record<string, string>>): string | undefined {
  if (others.length === 0) return undefined;
  const total = others.reduce((sum, person) => sum + person.count, 0);
  const who = others.map((person) => `${people[person.principalId] ?? person.principalId} ${person.count}`).join(", ");
  return others.length === 1
    ? translateNow("center.memoryModel.otherPeople.onePerson", { count: total, who })
    : translateNow("center.memoryModel.otherPeople.people", { count: total, people: others.length, who });
}

/** A layer's words as a `core` key: what the owner writes in English, said by `t`. */
type LayerWords = readonly [CanvasCoreKey, Record<string, string>?];

/** The key a layer's label is written with, by its kind and what it names. */
function labelWords(layer: SystemPromptLayer): LayerWords | undefined {
  switch (layer.kind) {
    case "base":
      if (layer.source === "workspace")
        return layer.revision === undefined
          ? ["prompt.layer.workspace"]
          : ["prompt.layer.workspaceRevision", { revision: String(layer.revision) }];
      if (layer.source === "explicit") return ["prompt.layer.explicit"];
      return layer.templateVersion === undefined
        ? ["prompt.layer.shipped"]
        : ["prompt.layer.shippedVersion", { version: layer.templateVersion }];
    case "persona":
      return layer.name === undefined ? undefined : ["prompt.layer.persona", { name: layer.name }];
    case "chat":
      return layer.revision === undefined ? undefined : ["prompt.layer.chat", { revision: String(layer.revision) }];
    case "facts":
      return ["prompt.layer.facts"];
    case "context":
      return ["prompt.layer.context"];
    default:
      return undefined;
  }
}

/** The details the owner writes for a layer, each with its key. */
const DETAIL_KEYS: readonly CanvasCoreKey[] = [
  "prompt.layer.replacedWorkspace",
  "prompt.layer.replacedExplicit",
  "prompt.layer.personaBlank",
  "prompt.layer.personaDisabled",
  "prompt.layer.chatCleared",
  "prompt.layer.factsDetail",
  "prompt.layer.contextDetail",
];

/**
 * `written` in the reader's language when it is what `words` says in English;
 * else as the owner wrote it (an older or newer owner's words).
 */
function said(written: string, words: LayerWords | undefined): string {
  if (words === undefined) return written;
  const [key, params] = words;
  return canvasCoreEnglish(key, params) === written ? translateCore(key, params) : written;
}

/** A layer's label in the reader's language: "Shipped default (tavi-default-5)" is "Вградените инструкции (tavi-default-5)". */
export function layerLabel(layer: SystemPromptLayer): string {
  return said(layer.label, labelWords(layer));
}

/** A layer's detail in the reader's language, when the owner wrote it; a sample rendering is shown as it is. */
export function layerDetail(layer: SystemPromptLayer): string | undefined {
  const detail = layer.detail;
  if (detail === undefined || layer.sample === true) return detail;
  const key = DETAIL_KEYS.find((candidate) => canvasCoreEnglish(candidate) === detail);
  return key === undefined ? detail : translateCore(key);
}

/** Where a layer's text comes from, in a line under its label. */
export function layerSource(layer: SystemPromptLayer): string {
  if (layer.generated) return translateNow("center.memoryModel.layer.generated");
  if (!layer.active && layer.detail !== undefined) return layerDetail(layer) ?? layer.detail;
  switch (layer.kind) {
    case "base":
      return translateNow(
        layer.source === "workspace"
          ? "center.memoryModel.layer.workspace"
          : layer.source === "explicit"
            ? "center.memoryModel.layer.explicit"
            : "center.memoryModel.layer.shipped",
      );
    case "persona":
      return translateNow("center.memoryModel.layer.persona");
    default:
      return layerDetail(layer) ?? "";
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

/** A limit's field, its label and hint said in the page's language when read. */
function limitField(name: MemoryLimitName): { readonly name: MemoryLimitName; readonly label: string; readonly hint: string } {
  return {
    name,
    get label() {
      return translateNow(`center.memoryModel.limit.${name}.label`);
    },
    get hint() {
      return translateNow(`center.memoryModel.limit.${name}.hint`);
    },
  };
}

/** The limits under the settings card's *More*, in order, with what each bounds. */
export const MEMORY_LIMIT_FIELDS: readonly { readonly name: MemoryLimitName; readonly label: string; readonly hint: string }[] = [
  limitField("contextTokens"),
  limitField("evidence"),
  limitField("proposalDays"),
  limitField("maxRecords"),
];
