import { z } from "zod";

import { TaviError } from "./errors.js";
import { canvasCoreEnglish, type CanvasCoreT } from "./locales/core-canvas.js";
import { MEMORY_PROPOSAL_TTL_DAYS } from "./memory.js";
import { BUILTIN_MEMORY_PROVIDER_ID } from "./memory-provider.js";

/**
 * The workspace's `memory` settings section: stored as the key `memory` of
 * `WorkspaceSettingsSchema`, so it shares
 * that document's revision and compare-and-set. Every field is optional and an
 * absent one means its default, so an absent section is exactly the behaviour
 * from before the section existed.
 *
 * This build knows
 * `enabled`, `capture`, `digest`, `sensitive`, `retrieval`,
 * `limits.*`, `provider` and `providerEgress`, which
 * only `tavi memory set-provider` and `tavi memory egress` change, each after
 * its disclosure, `consolidation` and `autoApprove`. The schema is strict,
 * so an unknown key is refused and no setting is ever accepted that does
 * nothing.
 *
 * Only the workspace operator writes it (the `workspace-settings` IPC already
 * requires that), and it applies to every person in the workspace from the
 * next model call.
 */

/** Bounds and defaults of each limit. */
export const MEMORY_LIMIT_BOUNDS = {
  /** The budget for a call's system text (base, persona, chat instructions, runtime facts) and its memory manifest together; the manifest rides in the call's context block. */
  contextTokens: { min: 2_000, max: 32_000, default: 8_000 },
  /** How many retrieved records a call's manifest may carry; 0 retrieves none. */
  evidence: { min: 0, max: 20, default: 10 },
  /** How many days a proposal waits for a person before it expires. */
  proposalDays: { min: 7, max: 90, default: MEMORY_PROPOSAL_TTL_DAYS },
  /** How many records a person may keep across the scopes they read; the byte quota follows it. */
  maxRecords: { min: 10, max: 20_000, default: 5_000 },
} as const;

export type MemoryLimitName = keyof typeof MEMORY_LIMIT_BOUNDS;
export const MEMORY_LIMIT_NAMES = ["contextTokens", "evidence", "proposalDays", "maxRecords"] as const satisfies readonly MemoryLimitName[];

/** The byte quota at the default record quota: 32 MiB at 5,000 records (about 6.5 KiB a record). */
export const DEFAULT_MEMORY_MAX_BYTES = 32 * 1024 * 1024;

const limit = (name: MemoryLimitName) => z.number().int().min(MEMORY_LIMIT_BOUNDS[name].min).max(MEMORY_LIMIT_BOUNDS[name].max);

export const MEMORY_CAPTURE_MODES = ["suggest", "off"] as const;
export type MemoryCaptureMode = (typeof MEMORY_CAPTURE_MODES)[number];

/**
 * The kinds the operator may have kept without asking: each opt-in, none by
 * default. Only the operator's own proposals,
 * from an attended, untainted, non-messaging turn or idle review whose words
 * the person typed, are ever approved this way; everything else waits.
 */
export const MEMORY_AUTO_APPROVE_KINDS = ["preference", "fact", "lesson"] as const;
export type MemoryAutoApproveKind = (typeof MEMORY_AUTO_APPROVE_KINDS)[number];

/** `kinds` in canonical order, each once. */
export function canonicalAutoApprove(kinds: readonly MemoryAutoApproveKind[] | undefined): readonly MemoryAutoApproveKind[] {
  return MEMORY_AUTO_APPROVE_KINDS.filter((kind) => kinds?.includes(kind) === true);
}

/** The review digest before proposals expire: weekly, or never. */
export const MEMORY_DIGEST_MODES = ["weekly", "off"] as const;
export type MemoryDigestMode = (typeof MEMORY_DIGEST_MODES)[number];

/** Weekly tidy-up suggestions: proposals that merge, replace or end kept records, or none. Off by default. */
export const MEMORY_CONSOLIDATION_MODES = ["off", "weekly"] as const;
export type MemoryConsolidationMode = (typeof MEMORY_CONSOLIDATION_MODES)[number];

/** What automatic capture does with a sensitive draft: drop it, or file it marked sensitive. */
export const MEMORY_SENSITIVE_MODES = ["skip", "suggest"] as const;
export type MemorySensitiveMode = (typeof MEMORY_SENSITIVE_MODES)[number];

/**
 * How turn and tool recall find records: by their words alone,
 * or by words and meaning (`hybrid`, through the bound `embedding` model role,
 * with lexical fallback).
 */
export const MEMORY_RETRIEVAL_MODES = ["lexical", "hybrid"] as const;
export type MemoryRetrievalMode = (typeof MEMORY_RETRIEVAL_MODES)[number];

/** The `details.reason` of the refusal that asks for the disclosure to be accepted first. */
export const MEMORY_EMBEDDING_DISCLOSURE_REASON = "memory-embedding-disclosure";

/** The `details.reason` of the refusal that asks for personal memory's own embedding disclosure to be accepted first. */
export const MEMORY_EMBEDDING_PERSONAL_DISCLOSURE_REASON = "memory-embedding-personal-disclosure";

/**
 * What turning hybrid recall on says first when the embedding connection is
 * remote (invariant 14): what is sent where, and how many of this
 * workspace's records the backfill sends. Personal memory is not sent: it has
 * its own opt-in (`retrievalPersonal`, `memoryPersonalEmbeddingDisclosure`),
 * and until then it is matched by its words there.
 */
export function memoryEmbeddingDisclosure(
  input: { readonly connectionId: string; readonly records: number },
  t: CanvasCoreT = canvasCoreEnglish,
): string {
  return t("memory.disclosure.embedding", { connection: input.connectionId, count: input.records });
}

/**
 * What embedding personal memory through a remote connection says first:
 * the accepting operator's
 * own personal memory, shared by all their workspaces, of which `personal`
 * approved records would be sent to `connectionId` now, each new one as
 * approved. Other people's personal memory is never sent by this opt-in.
 */
export function memoryPersonalEmbeddingDisclosure(
  input: { readonly connectionId: string; readonly personal: number },
  t: CanvasCoreT = canvasCoreEnglish,
): string {
  return t("memory.disclosure.personalEmbedding", { connection: input.connectionId, count: input.personal });
}

/**
 * What a workspace's external memory provider may receive,
 * each off by default: `records`, approved memory (snapshots, candidates and
 * `sync`) of every scope but `personal`; `conversation`, recall queries and
 * capture spans; `includePersonal`, `personal` records too, meaningful only
 * with `records`. The built-in provider is the host's own and reads none of them.
 */
export const MemoryProviderEgressSchema = z.strictObject({
  records: z.boolean().optional(),
  conversation: z.boolean().optional(),
  includePersonal: z.boolean().optional(),
});
export type MemoryProviderEgress = { readonly records: boolean; readonly conversation: boolean; readonly includePersonal: boolean };

/** The switches `tavi memory egress <field> on|off` names; `personal` is `includePersonal`. */
export const MEMORY_EGRESS_FIELDS = ["records", "conversation", "personal"] as const;
export type MemoryEgressField = (typeof MEMORY_EGRESS_FIELDS)[number];

/** The `details.reason` of the refusal that asks for a provider or egress disclosure to be accepted first. */
export const MEMORY_PROVIDER_DISCLOSURE_REASON = "memory-provider-disclosure";

/**
 * What turning `includePersonal` on says first: personal memory
 * is the person's own, shared by every workspace they use, and would reach
 * this workspace's provider.
 */
export function memoryPersonalDisclosure(providerId: string, t: CanvasCoreT = canvasCoreEnglish): string {
  return t("memory.disclosure.personal", { provider: providerId });
}

export const MemoryLimitsSchema = z.strictObject({
  contextTokens: limit("contextTokens").optional(),
  evidence: limit("evidence").optional(),
  proposalDays: limit("proposalDays").optional(),
  maxRecords: limit("maxRecords").optional(),
});

export const MemorySettingsSchema = z.strictObject({
  /** `false` pauses memory: nothing is recalled or captured anywhere; records are kept. Absent: on. */
  enabled: z.boolean().optional(),
  /**
   * `"suggest"`: the model may propose memory (`memory.propose`) and a rollover
   * flushes what it folds. `"off"`: only what a person writes themselves; no
   * flush, and `memory.propose` is not offered. Absent: `"suggest"`.
   */
  capture: z.enum(MEMORY_CAPTURE_MODES).optional(),
  /**
   * The kinds kept without asking: a proposal of one of them
   * is approved at once, with operator authority and the review note
   * `auto-approve (settings revision N)`, only under the auto-approve rule (the
   * operator's own attended, untainted, non-messaging turn or idle review;
   * the host's quote check over what the person typed; no reserved
   * preference key; not sensitive, an update or a near match). It is shown
   * as *Saved* with *Undo*. Absent or empty: every proposal waits.
   */
  autoApprove: z.array(z.enum(MEMORY_AUTO_APPROVE_KINDS)).max(MEMORY_AUTO_APPROVE_KINDS.length).optional(),
  /**
   * `"weekly"`: what waits for a person is gathered into a digest, weekly and
   * before a proposal expires. `"off"`: none. Absent: `"weekly"`.
   * Sent while memory is paused too: it is about decisions, not recall.
   */
  digest: z.enum(MEMORY_DIGEST_MODES).optional(),
  /**
   * `"skip"`: automatic capture (the flush and the idle review)
   * drops a draft the model marked sensitive or the host's category list
   * matches (health, beliefs, money…). `"suggest"`: it is filed marked
   * sensitive, so it is masked on every surface and never recalled
   * automatically. A person's own request (`memory.propose` because they
   * asked, `/remember`) is filed either way. Absent: `"skip"`.
   */
  sensitive: z.enum(MEMORY_SENSITIVE_MODES).optional(),
  /**
   * `"lexical"`: recall matches words (bm25). `"hybrid"`: turn and tool recall
   * also rank by meaning, through the bound `embedding` role, fused with the
   * words (RRF), falling back to words alone when a vector is missing or the
   * call fails. Turning it on with a remote embedding connection shows a
   * disclosure first. Absent: `"lexical"`.
   */
  retrieval: z.enum(MEMORY_RETRIEVAL_MODES).optional(),
  /**
   * `"weekly"`: once a week, at the first `tavi.memory` tick after 03:00 in
   * the workspace's zone, the memory provider reads each person's approved,
   * normal records (never a chat) and drafts tidy-ups — merge, replace, end —
   * filed as proposals the person decides, never auto-approved. `"off"`:
   * none. Absent: `"off"`.
   */
  consolidation: z.enum(MEMORY_CONSOLIDATION_MODES).optional(),
  /**
   * The remote embedding connection whose disclosure was accepted when hybrid
   * recall was turned on (or accepted again). Written by the owner alone, never
   * as a client sent it: a remote `embedding` role on any other connection
   * sends nothing until its disclosure is accepted (invariant 14).
   */
  retrievalConnection: z.string().min(1).optional(),
  /**
   * The remote embedding connection through which personal memory may be
   * embedded too: written by the
   * owner alone when the person accepts personal memory's own disclosure,
   * never as a client sent it, and only for the accepted
   * `retrievalConnection`. Another connection embeds no personal record
   * until it is accepted again; a local one needs none. Absent: off.
   */
  retrievalPersonal: z.string().min(1).optional(),
  limits: MemoryLimitsSchema.optional(),
  /**
   * The workspace's memory provider: an installed plugin's id
   * that provides `memory`, or `tavi.memoryprovider`, the built-in. Changed
   * only by `tavi memory set-provider` (and the Center's *Provider*), which
   * shows its disclosure first; an unavailable one falls back to the
   * built-in, visibly. Absent: the built-in.
   */
  provider: z.string().min(1).max(128).optional(),
  /** What an external provider may receive (`MemoryProviderEgressSchema`); changed only by `tavi memory egress`. Absent: nothing. */
  providerEgress: MemoryProviderEgressSchema.optional(),
});
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;

/** The settings in effect, every default filled in. */
export interface EffectiveMemorySettings {
  readonly enabled: boolean;
  readonly capture: MemoryCaptureMode;
  /** The kinds kept without asking, in canonical order; none by default. */
  readonly autoApprove: readonly MemoryAutoApproveKind[];
  readonly digest: MemoryDigestMode;
  readonly sensitive: MemorySensitiveMode;
  readonly retrieval: MemoryRetrievalMode;
  /** Weekly tidy-up suggestions; off by default. */
  readonly consolidation: MemoryConsolidationMode;
  /** The remote embedding connection whose disclosure was accepted; absent when none was. */
  readonly retrievalConnection?: string | undefined;
  /** The remote connection personal memory's disclosure was accepted for; absent when none was. */
  readonly retrievalPersonal?: string | undefined;
  readonly limits: {
    readonly contextTokens: number;
    readonly evidence: number;
    readonly proposalDays: number;
    readonly maxRecords: number;
  };
  /** The workspace's memory provider's id; the built-in's by default. */
  readonly provider: string;
  /** What an external provider may receive; every switch off by default. */
  readonly providerEgress: MemoryProviderEgress;
}

export const EffectiveMemorySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  capture: z.enum(MEMORY_CAPTURE_MODES),
  // Optional so a page reads an older owner; this build always sends it.
  autoApprove: z.array(z.enum(MEMORY_AUTO_APPROVE_KINDS)).max(MEMORY_AUTO_APPROVE_KINDS.length).readonly().optional(),
  digest: z.enum(MEMORY_DIGEST_MODES),
  sensitive: z.enum(MEMORY_SENSITIVE_MODES),
  retrieval: z.enum(MEMORY_RETRIEVAL_MODES),
  // Optional so a page reads an older owner; this build always sends it.
  consolidation: z.enum(MEMORY_CONSOLIDATION_MODES).optional(),
  retrievalConnection: z.string().min(1).optional(),
  retrievalPersonal: z.string().min(1).optional(),
  limits: z.strictObject({
    contextTokens: z.number().int().positive(),
    evidence: z.number().int().nonnegative(),
    proposalDays: z.number().int().positive(),
    maxRecords: z.number().int().positive(),
  }),
  // Optional so a page reads an older owner; this build always sends them.
  provider: z.string().min(1).max(128).optional(),
  providerEgress: z.strictObject({ records: z.boolean(), conversation: z.boolean(), includePersonal: z.boolean() }).optional(),
});

/**
 * The section in effect. `defaults.contextTokens` is an embedder's own budget
 * (the composition's `maxContextTokens`), which stays the default of
 * `limits.contextTokens`; absent, `MEMORY_LIMIT_BOUNDS.contextTokens.default`.
 */
export function effectiveMemorySettings(
  section: MemorySettings | undefined,
  defaults: { readonly contextTokens?: number | undefined } = {},
): EffectiveMemorySettings {
  const limits = section?.limits;
  return {
    enabled: section?.enabled !== false,
    capture: section?.capture ?? "suggest",
    autoApprove: canonicalAutoApprove(section?.autoApprove),
    digest: section?.digest ?? "weekly",
    sensitive: section?.sensitive ?? "skip",
    retrieval: section?.retrieval ?? "lexical",
    consolidation: section?.consolidation ?? "off",
    ...(section?.retrievalConnection === undefined ? {} : { retrievalConnection: section.retrievalConnection }),
    ...(section?.retrievalPersonal === undefined ? {} : { retrievalPersonal: section.retrievalPersonal }),
    limits: {
      contextTokens: limits?.contextTokens ?? defaults.contextTokens ?? MEMORY_LIMIT_BOUNDS.contextTokens.default,
      evidence: limits?.evidence ?? MEMORY_LIMIT_BOUNDS.evidence.default,
      proposalDays: limits?.proposalDays ?? MEMORY_LIMIT_BOUNDS.proposalDays.default,
      maxRecords: limits?.maxRecords ?? MEMORY_LIMIT_BOUNDS.maxRecords.default,
    },
    provider: section?.provider ?? BUILTIN_MEMORY_PROVIDER_ID,
    providerEgress: memoryProviderEgressOf(section),
  };
}

/** The egress switches in effect: each off unless set; `includePersonal` only with `records`. */
export function memoryProviderEgressOf(section: Pick<MemorySettings, "providerEgress"> | undefined): MemoryProviderEgress {
  const egress = section?.providerEgress;
  const records = egress?.records === true;
  return { records, conversation: egress?.conversation === true, includePersonal: records && egress?.includePersonal === true };
}

/**
 * The section with another provider selected (`tavi memory set-provider`):
 * its egress starts off again, since what the old provider was
 * allowed to receive is not the new one's (as the heartbeat's). The
 * built-in is stored as no key.
 */
export function withMemoryProvider(section: MemorySettings | undefined, providerId: string): MemorySettings {
  const { provider: _provider, providerEgress: _egress, ...rest } = section ?? {};
  return providerId === BUILTIN_MEMORY_PROVIDER_ID ? rest : { ...rest, provider: providerId };
}

/**
 * The section with one egress switch changed (`tavi memory egress`).
 * `personal` is refused while `records` is off, where it would mean nothing;
 * turning `records` off turns `personal` off with it, so turning `records`
 * on later never sends personal memory without its own disclosure.
 */
export function withMemoryEgress(section: MemorySettings | undefined, field: MemoryEgressField, on: boolean): MemorySettings {
  const current = memoryProviderEgressOf(section);
  if (field === "personal" && on && !current.records) {
    throw new TaviError(
      "INVALID_INPUT",
      "Personal memory goes to the provider only with records: turn records on first (tavi memory egress records on)",
      { details: { field } },
    );
  }
  const next: MemoryProviderEgress =
    field === "records"
      ? { ...current, records: on, includePersonal: on && current.includePersonal }
      : field === "conversation"
        ? { ...current, conversation: on }
        : { ...current, includePersonal: on };
  const { providerEgress: _egress, ...rest } = section ?? {};
  const stored = {
    ...(next.records ? { records: true } : {}),
    ...(next.conversation ? { conversation: true } : {}),
    ...(next.includePersonal ? { includePersonal: true } : {}),
  };
  return Object.keys(stored).length === 0 ? rest : { ...rest, providerEgress: stored };
}

/** The record and byte quotas `maxRecords` gives: the byte quota scales with it, 32 MiB at the default 5,000. */
export function memoryQuotasOf(settings: Pick<EffectiveMemorySettings, "limits">): {
  readonly maxRecords: number;
  readonly maxBytes: number;
} {
  const maxRecords = settings.limits.maxRecords;
  return { maxRecords, maxBytes: Math.round((maxRecords * DEFAULT_MEMORY_MAX_BYTES) / MEMORY_LIMIT_BOUNDS.maxRecords.default) };
}

/** The keys `tavi memory config <key> <value>` changes, as the CLI spells them. */
export const MEMORY_CONFIG_KEYS = [
  "enabled",
  "capture",
  "auto-approve",
  "sensitive",
  "retrieval",
  "digest",
  "consolidation",
  "limits.contextTokens",
  "limits.evidence",
  "limits.proposalDays",
  "limits.maxRecords",
] as const;
export type MemoryConfigKey = (typeof MEMORY_CONFIG_KEYS)[number];

/** One key's value in effect, as the CLI prints and parses it. */
export function memoryConfigValue(
  settings: Pick<EffectiveMemorySettings, "enabled" | "capture" | "digest" | "sensitive" | "retrieval" | "limits"> & {
    readonly consolidation?: MemoryConsolidationMode | undefined;
    readonly autoApprove?: readonly MemoryAutoApproveKind[] | undefined;
  },
  key: MemoryConfigKey,
): string {
  switch (key) {
    case "enabled":
      return settings.enabled ? "on" : "off";
    case "capture":
      return settings.capture;
    case "auto-approve": {
      const kinds = canonicalAutoApprove(settings.autoApprove);
      return kinds.length === 0 ? "none" : kinds.join(",");
    }
    case "digest":
      return settings.digest;
    case "sensitive":
      return settings.sensitive;
    case "retrieval":
      return settings.retrieval;
    case "consolidation":
      return settings.consolidation ?? "off";
    default:
      return String(settings.limits[key.slice("limits.".length) as MemoryLimitName]);
  }
}

/** Whether `key` is set in `section` (rather than its default). */
export function memoryConfigKeySet(section: MemorySettings | undefined, key: MemoryConfigKey): boolean {
  if (key === "auto-approve") return section?.autoApprove !== undefined;
  if (key === "enabled" || key === "capture" || key === "digest" || key === "sensitive" || key === "retrieval" || key === "consolidation")
    return section?.[key] !== undefined;
  return section?.limits?.[key.slice("limits.".length) as MemoryLimitName] !== undefined;
}

/**
 * The section with one key changed: `value` as typed (`on`/`off` for
 * `enabled`, `suggest`/`off` for `capture`, a comma list of `preference`,
 * `fact` and `lesson` (plurals too) or `none` for `auto-approve`,
 * `weekly`/`off` for `digest`,
 * `skip`/`suggest` for `sensitive`, `lexical`/`hybrid` for `retrieval`,
 * `off`/`weekly` for `consolidation`, a whole number for a limit), or
 * `default` to clear the key. A value out of bounds is refused with the
 * bounds, naming what was typed.
 */
export function withMemoryConfig(section: MemorySettings | undefined, key: MemoryConfigKey, value: string): MemorySettings {
  const typed = value.trim().toLowerCase();
  const cleared = typed === "default";
  const refuse = (expected: string): never => {
    throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not a value for memory ${key}; expected ${expected}, or default`, {
      details: { key },
    });
  };
  const next: { -readonly [K in keyof MemorySettings]: MemorySettings[K] } = { ...section };
  if (key === "enabled") {
    if (cleared) delete next.enabled;
    else if (["on", "true", "yes", "1"].includes(typed)) next.enabled = true;
    else if (["off", "false", "no", "0", "paused", "pause"].includes(typed)) next.enabled = false;
    else refuse("on or off");
    return next;
  }
  if (key === "capture") {
    if (cleared) delete next.capture;
    else if ((MEMORY_CAPTURE_MODES as readonly string[]).includes(typed)) next.capture = typed as MemoryCaptureMode;
    else refuse(MEMORY_CAPTURE_MODES.join(" or "));
    return next;
  }
  if (key === "auto-approve") {
    if (cleared || typed === "none" || typed === "") {
      delete next.autoApprove;
      return next;
    }
    const kinds: MemoryAutoApproveKind[] = [];
    for (const word of typed.split(/[\s,]+/).filter((piece) => piece !== "")) {
      const kind = MEMORY_AUTO_APPROVE_KINDS.find((known) => word === known || word === `${known}s`);
      if (kind === undefined) refuse("a comma list of preference, fact and lesson, or none");
      else kinds.push(kind);
    }
    next.autoApprove = [...canonicalAutoApprove(kinds)];
    return next;
  }
  if (key === "digest") {
    if (cleared) delete next.digest;
    else if ((MEMORY_DIGEST_MODES as readonly string[]).includes(typed)) next.digest = typed as MemoryDigestMode;
    else refuse(MEMORY_DIGEST_MODES.join(" or "));
    return next;
  }
  if (key === "sensitive") {
    if (cleared) delete next.sensitive;
    else if ((MEMORY_SENSITIVE_MODES as readonly string[]).includes(typed)) next.sensitive = typed as MemorySensitiveMode;
    else refuse(MEMORY_SENSITIVE_MODES.join(" or "));
    return next;
  }
  if (key === "retrieval") {
    if (cleared) delete next.retrieval;
    else if ((MEMORY_RETRIEVAL_MODES as readonly string[]).includes(typed)) next.retrieval = typed as MemoryRetrievalMode;
    else refuse(MEMORY_RETRIEVAL_MODES.join(" or "));
    return next;
  }
  if (key === "consolidation") {
    if (cleared) delete next.consolidation;
    else if ((MEMORY_CONSOLIDATION_MODES as readonly string[]).includes(typed)) next.consolidation = typed as MemoryConsolidationMode;
    else refuse(MEMORY_CONSOLIDATION_MODES.join(" or "));
    return next;
  }
  const name = key.slice("limits.".length) as MemoryLimitName;
  const bounds = MEMORY_LIMIT_BOUNDS[name];
  const limits: Record<string, number> = {};
  for (const [known, count] of Object.entries(section?.limits ?? {})) if (count !== undefined) limits[known] = count;
  if (cleared) delete limits[name];
  else {
    const digits = typed.replace(/[,_]/g, "");
    const count = /^\d{1,6}$/.test(digits) ? Number(digits) : Number.NaN;
    if (!Number.isInteger(count) || count < bounds.min || count > bounds.max)
      refuse(`a whole number from ${bounds.min.toLocaleString("en-US")} to ${bounds.max.toLocaleString("en-US")}`);
    limits[name] = count;
  }
  if (Object.keys(limits).length === 0) delete next.limits;
  else next.limits = limits;
  return next;
}

/**
 * What doctor shows of the section: on or paused, `capture`,
 * every kind kept without asking (`autoApprove`, always shown, even when
 * none: it relaxes the approval gate), every other key set to
 * something other than its default, and the accepted
 * remote embedding connections (`retrievalConnection`, and `retrievalPersonal`
 * for personal memory, each written by the owner alone) when stored.
 */
export function memorySettingsDoctor(section: MemorySettings | undefined): {
  readonly state: "on" | "paused";
  readonly capture: MemoryCaptureMode;
  readonly autoApprove: readonly MemoryAutoApproveKind[];
  readonly changed: Readonly<Record<string, string>>;
} {
  const effective = effectiveMemorySettings(section);
  const defaults = effectiveMemorySettings(undefined);
  const changed: Record<string, string> = {};
  for (const key of MEMORY_CONFIG_KEYS) {
    if (key === "enabled" || key === "capture" || key === "auto-approve") continue;
    if (memoryConfigValue(effective, key) !== memoryConfigValue(defaults, key)) changed[key] = memoryConfigValue(effective, key);
  }
  if (effective.retrievalConnection !== undefined) changed["retrievalConnection"] = effective.retrievalConnection;
  if (effective.retrievalPersonal !== undefined) changed["retrievalPersonal"] = effective.retrievalPersonal;
  return { state: effective.enabled ? "on" : "paused", capture: effective.capture, autoApprove: effective.autoApprove, changed };
}
