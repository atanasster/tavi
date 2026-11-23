import {
  type MODEL_ROLES,
  RHUMB_CREDENTIAL_REF,
  type ModelReplacements,
  type ModelUse,
  type ModelUseKind,
  type ReplacementKind,
} from "@tavi/contracts";

import type { UiKey } from "../../locales/en.js";
import { translateNow } from "../../lib/i18n.js";
import { ask, mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { credentialActions } from "./credentials-api.js";

export const RHUMB_SIGN_UP_URL = "https://rhumbdata.com/sign-up";

export type { ModelReplacements };

/** One model in use that warns, as `models sync` and `models lifecycle` answer it. */
interface LifecycleWarningRow {
  readonly connectionId: string;
  readonly model: string;
  readonly level: "error" | "warning" | "info";
  readonly says: readonly string[];
  /** Absent for an info notice, and from an older owner. */
  readonly replacements?: ModelReplacements;
}

const USES: Readonly<Record<ReplacementKind, UiKey>> = {
  agent: "settings.lifecycle.use.agent",
  cheap: "settings.lifecycle.use.cheap",
  embedding: "settings.lifecycle.use.embedding",
  video: "settings.lifecycle.use.video",
};

/** The replacements as the banner says them: the provider's choice, then Rhumb's picks; none when there are none. */
export function replacementLines(replacements: ModelReplacements | undefined): readonly string[] {
  if (replacements === undefined) return [];
  return [
    ...(replacements.provider === undefined
      ? []
      : [translateNow("settings.lifecycle.providerChoice", { model: replacements.provider.model })]),
    // A kind this page does not know (a newer owner) is said without its use rather than as "undefined".
    ...replacements.rhumb.map((pick) =>
      Object.hasOwn(USES, pick.for)
        ? translateNow("settings.lifecycle.rhumbSuggestsFor", { model: pick.model, use: translateNow(USES[pick.for]) })
        : translateNow("settings.lifecycle.rhumbSuggests", { model: pick.model }),
    ),
  ];
}

/**
 * The replacements `models lifecycle` knows, by `connection/model`: what the
 * last sync picked. Empty when the owner cannot say (an older one) or fails:
 * the banner still names each model.
 */
export async function loadReplacements(client: SettingsClient): Promise<ReadonlyMap<string, ModelReplacements>> {
  const report = await ask<{ readonly warnings?: unknown }>(client, "models", { action: "lifecycle" });
  if (!report.ok || !Array.isArray(report.value?.warnings)) return new Map();
  return new Map(
    (report.value.warnings as LifecycleWarningRow[]).flatMap((warning) =>
      warning.replacements === undefined || !Array.isArray(warning.replacements.rhumb)
        ? []
        : [[`${warning.connectionId}/${warning.model}`, warning.replacements] as const],
    ),
  );
}

type SyncAnswer =
  | { readonly skipped: "no-key"; readonly hint: string }
  | { readonly warnings: readonly LifecycleWarningRow[]; readonly unread: readonly string[] };

/** `models sync` on the owner: what Rhumb says of the models in use, in one line. */
export async function syncLifecycle(client: SettingsClient): Promise<Outcome<string | undefined>> {
  const synced = await ask<SyncAnswer>(client, "models", { action: "sync" }, { timeoutMs: 120_000 });
  return mapOutcome(synced, (answer) => {
    if ("skipped" in answer) return answer.hint;
    if (answer.warnings.length === 0) return translateNow("settings.lifecycle.checkedNone");
    return translateNow("settings.lifecycle.checked", {
      warnings: answer.warnings.map((warning) => `${warning.connectionId}/${warning.model} ${warning.says.join("; ")}`).join(" · "),
    });
  });
}

/** The key crosses the bridge once, to the owner's credential store, and is never sent back. */
export async function storeRhumbKey(client: SettingsClient, key: string): Promise<Outcome<string | undefined>> {
  const stored = await credentialActions.set(client, { reference: RHUMB_CREDENTIAL_REF, value: key });
  return mapOutcome(stored, () => translateNow("settings.lifecycle.keyStored"));
}

/** A model as the owner names it. */
export interface ModelRef {
  readonly connectionId: string;
  readonly model: string;
}

/** One place a model is used, as `models replace` answers it: a newer owner may name a kind this page does not know. */
interface ModelUseRow extends Omit<ModelUse, "kind"> {
  readonly kind: ModelUseKind | (string & {});
}

interface ReplaceAnswer {
  readonly usedBy: readonly ModelUseRow[];
  readonly unread?: readonly string[];
  readonly notes?: readonly string[];
  readonly changed?: readonly ModelUseRow[];
  readonly skipped?: readonly { readonly use: ModelUseRow; readonly reason: string }[];
  readonly failed?: readonly { readonly use: ModelUseRow; readonly error: string }[];
}

/** A role's name in the reader's language: its id in English ("main"), a word of its own in Bulgarian ("основен"). */
const ROLE_NAMES = {
  main: "settings.modelsPage.role.main",
  extraction: "settings.modelsPage.role.extraction",
  compaction: "settings.modelsPage.role.compaction",
  fast: "settings.modelsPage.role.fast",
  embedding: "settings.modelsPage.role.embedding",
} as const satisfies Readonly<Record<(typeof MODEL_ROLES)[number], UiKey>>;

/** A role's name; a role this page does not know reads as its id. */
export const modelRoleName = (role: string): string =>
  Object.hasOwn(ROLE_NAMES, role) ? translateNow(ROLE_NAMES[role as (typeof MODEL_ROLES)[number]]) : role;

/** A place a model is used, in words, as the replace dialog lists it. */
function useInWords(use: ModelUseRow): string {
  const detail = use.detail ?? "";
  switch (use.kind) {
    case "connection-default":
      return translateNow("settings.lifecycle.where.connectionDefault");
    case "video":
      return translateNow("settings.lifecycle.where.video");
    case "workspace-default":
      return translateNow("settings.lifecycle.where.workspaceDefault");
    case "role":
      return translateNow("settings.lifecycle.where.role", { detail: modelRoleName(detail) });
    case "role-fallback":
      return translateNow("settings.lifecycle.where.roleFallback", { detail: modelRoleName(detail) });
    case "routine":
      return translateNow("settings.lifecycle.where.routine", { detail });
    case "routine-fallback":
      return translateNow("settings.lifecycle.where.routineFallback", { detail });
    case "heartbeat":
      return translateNow("settings.lifecycle.where.heartbeat");
    case "activity-summary":
      return translateNow("settings.lifecycle.where.activitySummary");
    case "chat":
      return translateNow("settings.lifecycle.where.chats", { count: use.count ?? 1 });
    default:
      return use.kind;
  }
}

const replacePayload = (from: ModelRef, to: ModelRef) => ({
  action: "replace" as const,
  connectionId: from.connectionId,
  model: from.model,
  replaceWith: to,
});

/** What `models replace` would change, in words, and where the uses could not be read: read only. */
export async function previewReplace(
  client: SettingsClient,
  from: ModelRef,
  to: ModelRef,
): Promise<Outcome<{ readonly uses: readonly string[]; readonly unread: readonly string[] }>> {
  const preview = await ask<ReplaceAnswer>(client, "models", replacePayload(from, to), { timeoutMs: 120_000 });
  return mapOutcome(preview, (answer) => ({
    uses: Array.isArray(answer.usedBy) ? answer.usedBy.map(useInWords) : [],
    unread: Array.isArray(answer.unread) ? answer.unread : [],
  }));
}

/**
 * Moves every use of `from` to `to`, and says what moved and what did not: a
 * refusal's tone when a place failed or could not be read, so a partial
 * change is never said as a success.
 */
export async function replaceModel(client: SettingsClient, from: ModelRef, to: ModelRef): Promise<Outcome<string>> {
  const done = await ask<ReplaceAnswer>(client, "models", { ...replacePayload(from, to), confirmed: true }, { timeoutMs: 120_000 });
  if (!done.ok) return done;
  const answer = done.value;
  const moved = answer.changed?.length ?? 0;
  const failed = [
    ...(answer.failed ?? []).map(({ use, error }) => translateNow("settings.lifecycle.useFailed", { use: useInWords(use), error })),
    ...(answer.unread ?? []).map((source) => translateNow("settings.lifecycle.unread", { source })),
  ];
  const left = (answer.skipped ?? []).map(({ use, reason }) => `${useInWords(use)}: ${reason}`);
  const message = [
    translateNow("settings.lifecycle.replaced", {
      from: `${from.connectionId}/${from.model}`,
      to: `${to.connectionId}/${to.model}`,
      count: moved,
    }),
    ...(left.length === 0 ? [] : [translateNow("settings.lifecycle.notMoved", { list: left.join("; ") })]),
    ...(failed.length === 0 ? [] : [translateNow("settings.lifecycle.notDone", { list: failed.join("; ") })]),
    ...(answer.notes ?? []),
  ].join(" ");
  return failed.length === 0 ? { ok: true, value: message } : { ok: false, message };
}

const PICK_USES: Readonly<Record<string, UiKey>> = {
  agent: "settings.lifecycle.pick.agent",
  cheap: "settings.lifecycle.pick.cheap",
  embedding: "settings.lifecycle.pick.embedding",
  video: "settings.lifecycle.pick.video",
};

/** Each model that may take over, with what it was suggested for: the provider's choice first, each model once. */
export function replacementChoices(
  replacements: ModelReplacements | undefined,
  current: string,
): readonly { readonly model: string; readonly why: string }[] {
  const choices = new Map<string, string[]>();
  const add = (model: string, why: string): void => {
    if (model === current) return;
    choices.set(model, [...(choices.get(model) ?? []), why]);
  };
  if (replacements?.provider !== undefined) add(replacements.provider.model, translateNow("settings.lifecycle.pick.provider"));
  for (const pick of replacements?.rhumb ?? []) {
    const use = Object.hasOwn(PICK_USES, pick.for) ? PICK_USES[pick.for] : undefined;
    add(pick.model, translateNow(use ?? "settings.lifecycle.pick.rhumb"));
  }
  return [...choices].map(([model, why]) => ({ model, why: why.join(", ") }));
}
