import { z } from "zod";

import { TimestampSchema } from "./ids.js";
import { coreEnglish, type CoreT } from "./locales/core.js";
import type { CoreKey } from "./locales/core-en.js";

/**
 * A model's lifecycle on one provider, as Rhumb (https://rhumbdata.com) last
 * reported it: whether it is retired, retiring, or answered by another model,
 * and when. `unknown` is a model Rhumb's catalog does not list.
 *
 * Rhumb's `retires_not_before` is not kept: it is the provider's promise that
 * nothing ends before that day, never an end.
 */
export const MODEL_LIFECYCLE_STATUSES = ["preview", "ga", "deprecated", "retired", "unknown"] as const;
export type ModelLifecycleStatus = (typeof MODEL_LIFECYCLE_STATUSES)[number];

/** A calendar day, `YYYY-MM-DD`. */
const DaySchema = z.iso.date();

export const ModelLifecycleSchema = z.strictObject({
  status: z.enum(MODEL_LIFECYCLE_STATUSES),
  /** The end the provider confirmed. */
  retiresOn: DaySchema.optional(),
  /** An end a catalog claims that the provider has not confirmed. */
  endClaimedOn: DaySchema.optional(),
  deprecatedOn: DaySchema.optional(),
  /** New accounts cannot use it from this day; existing ones still can. */
  closedToNewOn: DaySchema.optional(),
  /**
   * The provider answers this id with `to` and bills it as `to`: from `on`, or
   * already when `on` is absent. `via` names the upstream a router passes it from.
   */
  redirect: z
    .strictObject({
      on: DaySchema.optional(),
      to: z.string().min(1).max(256),
      via: z.string().min(1).max(64).optional(),
    })
    .optional(),
  /** The next price the provider has announced, per million units, as decimal strings. */
  nextPrice: z
    .strictObject({
      effectiveFrom: DaySchema,
      per1m: z.record(z.string().min(1).max(64), z.string().min(1).max(32)),
    })
    .optional(),
  /** The Rhumb catalog version these facts are from. */
  catalogVersion: z.string().min(1).max(64),
  checkedAt: TimestampSchema,
});
export type ModelLifecycle = z.infer<typeof ModelLifecycleSchema>;

/** A lifecycle as stored: one model of one connection. */
export const ModelLifecycleEntrySchema = z.strictObject({
  connectionId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(256),
  lifecycle: ModelLifecycleSchema,
});
export type ModelLifecycleEntry = z.infer<typeof ModelLifecycleEntrySchema>;

export const LIFECYCLE_LEVELS = ["error", "warning", "info"] as const;
export type LifecycleLevel = (typeof LIFECYCLE_LEVELS)[number];

export const LIFECYCLE_CODES = [
  "retired",
  "redirected",
  "retires_soon",
  "redirects_soon",
  "end_claimed",
  "deprecated",
  "price_changes",
] as const;
export type LifecycleCode = (typeof LIFECYCLE_CODES)[number];

interface LifecycleWarningBase {
  readonly level: LifecycleLevel;
  /** The day it happens or happened, when one is known. */
  readonly date?: string;
  /** Days from today to `date`; negative once it has passed. */
  readonly days?: number;
}

/** A redirect: the model that answers instead, and the upstream a router passes it from. */
interface RedirectWarning extends LifecycleWarningBase {
  readonly code: "redirected" | "redirects_soon";
  readonly to: string;
  readonly via?: string;
}

interface DatedWarning extends LifecycleWarningBase {
  readonly code: Exclude<LifecycleCode, RedirectWarning["code"]>;
}

export type LifecycleWarning = RedirectWarning | DatedWarning;

/** Where a Rhumb key is kept in the credential store, for the lifecycle sync, when `RHUMB_KEY` is not set. */
export const RHUMB_CREDENTIAL_REF = "rhumb";

/** Within this many days, a coming end or redirect is a warning. */
export const LIFECYCLE_WARNING_DAYS = 30;
/** Within this many days, a coming end, redirect or price change is worth a notice. */
export const LIFECYCLE_NOTICE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `warning` within {@link LIFECYCLE_WARNING_DAYS}, `info` within {@link LIFECYCLE_NOTICE_DAYS}, else nothing. */
function nearness(days: number): LifecycleLevel | undefined {
  return days <= LIFECYCLE_WARNING_DAYS ? "warning" : days <= LIFECYCLE_NOTICE_DAYS ? "info" : undefined;
}

/**
 * What the owner should hear about a model on `today` (`YYYY-MM-DD`), most
 * severe first; empty when nothing is coming. A retired model is only that:
 * nothing else about it matters any more.
 */
export function lifecycleWarnings(lifecycle: ModelLifecycle, today: string): LifecycleWarning[] {
  const { retiresOn, endClaimedOn, deprecatedOn, redirect, nextPrice } = lifecycle;
  const at = (date: string) => ({ date, days: daysBetween(today, date) });
  if (lifecycle.status === "retired" || (retiresOn !== undefined && retiresOn <= today))
    return [{ level: "error", code: "retired", ...(retiresOn === undefined ? {} : at(retiresOn)) }];

  const warnings: LifecycleWarning[] = [];
  if (redirect !== undefined) {
    const target = { to: redirect.to, ...(redirect.via === undefined ? {} : { via: redirect.via }) };
    if (redirect.on === undefined || redirect.on <= today)
      warnings.push({ level: "warning", code: "redirected", ...target, ...(redirect.on === undefined ? {} : at(redirect.on)) });
    else {
      const level = nearness(daysBetween(today, redirect.on));
      if (level !== undefined) warnings.push({ level, code: "redirects_soon", ...target, ...at(redirect.on) });
    }
  }
  let ending = false;
  if (retiresOn !== undefined) {
    const level = nearness(daysBetween(today, retiresOn));
    if (level !== undefined) {
      warnings.push({ level, code: "retires_soon", ...at(retiresOn) });
      ending = true;
    }
  } else if (endClaimedOn !== undefined) {
    // A claimed end that has passed stays a notice: the model may be gone, and only a call would tell.
    const days = daysBetween(today, endClaimedOn);
    if (days <= 0 || nearness(days) !== undefined) {
      warnings.push({ level: "info", code: "end_claimed", ...at(endClaimedOn) });
      ending = true;
    }
  }
  if (lifecycle.status === "deprecated" && !ending)
    warnings.push({ level: "info", code: "deprecated", ...(deprecatedOn === undefined ? {} : at(deprecatedOn)) });
  if (nextPrice !== undefined && nextPrice.effectiveFrom > today && nearness(daysBetween(today, nextPrice.effectiveFrom)) !== undefined)
    warnings.push({ level: "info", code: "price_changes", ...at(nextPrice.effectiveFrom) });
  return warnings.sort((left, right) => LIFECYCLE_LEVELS.indexOf(left.level) - LIFECYCLE_LEVELS.indexOf(right.level));
}

/** The most severe level among `warnings`, or `undefined` when there are none. */
export function worstLifecycleLevel(warnings: readonly LifecycleWarning[]): LifecycleLevel | undefined {
  return LIFECYCLE_LEVELS.find((level) => warnings.some((warning) => warning.level === level));
}

/**
 * One line for a warning, for a log, a doctor report or a badge's title: a
 * clause about the model ("retired on 2026-11-19"), what follows "This model"
 * in the canvas's picker.
 */
export function lifecycleWarningText(warning: LifecycleWarning, t: CoreT = coreEnglish): string {
  const date = warning.date;
  const dated = (bare: CoreKey, on: CoreKey): string => (date === undefined ? t(bare) : t(on, { date }));
  switch (warning.code) {
    case "retired":
      return dated("model.lifecycle.retired", "model.lifecycle.retiredOn");
    case "redirected":
    case "redirects_soon": {
      const to = warning.via === undefined ? warning.to : t("model.lifecycle.via", { to: warning.to, via: warning.via });
      if (warning.code === "redirected")
        return date === undefined ? t("model.lifecycle.redirected", { to }) : t("model.lifecycle.redirectedSince", { to, date });
      return date === undefined ? t("model.lifecycle.redirectsSoon", { to }) : t("model.lifecycle.redirectsSoonOn", { to, date });
    }
    case "retires_soon":
      return dated("model.lifecycle.retires", "model.lifecycle.retiresOn");
    case "end_claimed":
      return warning.days !== undefined && warning.days <= 0
        ? dated("model.lifecycle.mayHaveRetired", "model.lifecycle.mayHaveRetiredOn")
        : dated("model.lifecycle.mayRetire", "model.lifecycle.mayRetireOn");
    case "deprecated":
      return dated("model.lifecycle.deprecated", "model.lifecycle.deprecatedOn");
    case "price_changes":
      return dated("model.lifecycle.priceChanges", "model.lifecycle.priceChangesOn");
  }
}

/** Where a model is used: what a lifecycle check covers and `models replace` moves. */
export const MODEL_USE_KINDS = [
  "connection-default",
  "video",
  "workspace-default",
  "role",
  "role-fallback",
  "routine",
  "routine-fallback",
  "heartbeat",
  "activity-summary",
  "chat",
] as const;
export type ModelUseKind = (typeof MODEL_USE_KINDS)[number];

/** One place a model is used. */
export interface ModelUse {
  readonly kind: ModelUseKind;
  readonly workspaceId?: string;
  /** The role, or the routine's name and stage. */
  readonly detail?: string;
  /** For `chat`: how many chats chose the model. */
  readonly count?: number;
}

/** What a use asks of a model that replaces a retiring one. */
export const REPLACEMENT_KINDS = ["agent", "cheap", "embedding", "video"] as const;
export type ReplacementKind = (typeof REPLACEMENT_KINDS)[number];

/** Rhumb's pick for one kind of use. */
export interface ReplacementPick {
  readonly for: ReplacementKind;
  readonly model: string;
  readonly reason?: string;
}

/** What may replace a model that retires or is redirected: suggestions, never applied. */
export interface ModelReplacements {
  /** The provider's redirect target: its choice, which can be a smaller model. */
  readonly provider?: { readonly model: string; readonly via?: string };
  /** Rhumb's pick per kind of use, the old model left out. */
  readonly rhumb: readonly ReplacementPick[];
}
