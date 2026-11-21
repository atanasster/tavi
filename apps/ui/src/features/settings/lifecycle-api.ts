import { RHUMB_CREDENTIAL_REF, type ModelReplacements, type ModelUse, type ModelUseKind, type ReplacementKind } from "@tavi/contracts";

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

const USES: Readonly<Record<ReplacementKind, string>> = {
  agent: "with tools",
  cheap: "background, cheaper",
  embedding: "embeddings",
  video: "with video",
};

/** The replacements as the banner says them: the provider's choice, then Rhumb's picks; none when there are none. */
export function replacementLines(replacements: ModelReplacements | undefined): readonly string[] {
  if (replacements === undefined) return [];
  return [
    ...(replacements.provider === undefined ? [] : [`Provider's choice: ${replacements.provider.model}`]),
    // A kind this page does not know (a newer owner) is said without its use rather than as "undefined".
    ...replacements.rhumb.map((pick) => `Rhumb suggests ${pick.model}${pick.for in USES ? ` (${USES[pick.for]})` : ""}`),
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
    if (answer.warnings.length === 0) return "Checked: no model in use is retiring or redirected.";
    return `Checked: ${answer.warnings.map((warning) => `${warning.connectionId}/${warning.model} ${warning.says.join("; ")}`).join(" · ")}`;
  });
}

/** The key crosses the bridge once, to the owner's credential store, and is never sent back. */
export async function storeRhumbKey(client: SettingsClient, key: string): Promise<Outcome<string | undefined>> {
  const stored = await credentialActions.set(client, { reference: RHUMB_CREDENTIAL_REF, value: key });
  return mapOutcome(stored, () => "Rhumb key stored: Tavi checks your models daily.");
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

/** A place a model is used, in words, as the replace dialog lists it. */
function useInWords(use: ModelUseRow): string {
  const detail = use.detail ?? "";
  switch (use.kind) {
    case "connection-default":
      return "The connection's default";
    case "video":
      return "Native video on its connection (turned on per model, so not moved)";
    case "workspace-default":
      return "The workspace default";
    case "role":
      return `The ${detail} role`;
    case "role-fallback":
      return `A fallback of the ${detail} role`;
    case "routine":
      return `The routine ${detail}`;
    case "routine-fallback":
      return `A fallback of the routine ${detail}`;
    case "heartbeat":
      return "A heartbeat";
    case "activity-summary":
      return "Activity summaries";
    case "chat": {
      const count = use.count ?? 1;
      return `${count} chat${count === 1 ? "" : "s"} that chose it`;
    }
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
    ...(answer.failed ?? []).map(({ use, error }) => `${useInWords(use)} failed: ${error}`),
    ...(answer.unread ?? []).map((source) => `${source} could not be read`),
  ];
  const left = (answer.skipped ?? []).map(({ use, reason }) => `${useInWords(use)}: ${reason}`);
  const message = [
    `Replaced ${from.connectionId}/${from.model} with ${to.connectionId}/${to.model} in ${moved} place${moved === 1 ? "" : "s"}.`,
    ...(left.length === 0 ? [] : [`Not moved: ${left.join("; ")}.`]),
    ...(failed.length === 0 ? [] : [`Not done: ${failed.join("; ")}.`]),
    ...(answer.notes ?? []),
  ].join(" ");
  return failed.length === 0 ? { ok: true, value: message } : { ok: false, message };
}

const PICK_USES: Readonly<Record<string, string>> = {
  agent: "with tools",
  cheap: "background",
  embedding: "embeddings",
  video: "video",
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
  if (replacements?.provider !== undefined) add(replacements.provider.model, "provider's choice");
  for (const pick of replacements?.rhumb ?? []) add(pick.model, PICK_USES[pick.for] ?? "Rhumb's pick");
  return [...choices].map(([model, why]) => ({ model, why: why.join(", ") }));
}
