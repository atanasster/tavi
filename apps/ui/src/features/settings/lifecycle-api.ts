import { RHUMB_CREDENTIAL_REF } from "@tavi/contracts";

import { ask, mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { credentialActions } from "./credentials-api.js";

export const RHUMB_SIGN_UP_URL = "https://rhumbdata.com/sign-up";

/** What may replace a model that retires or is redirected: suggestions, never applied. */
export interface ModelReplacements {
  /** The provider's redirect target: its choice, which can be a smaller model. */
  readonly provider?: { readonly model: string; readonly via?: string };
  /** Rhumb's pick per kind of use. */
  readonly rhumb: readonly { readonly for: "agent" | "cheap" | "embedding" | "video"; readonly model: string; readonly reason?: string }[];
}

/** One model in use that warns, as `models sync` and `models lifecycle` answer it. */
export interface LifecycleWarningRow {
  readonly connectionId: string;
  readonly model: string;
  readonly level: "error" | "warning" | "info";
  readonly says: readonly string[];
  /** Absent for an info notice, and from an older owner. */
  readonly replacements?: ModelReplacements;
}

const USES: Readonly<Record<ModelReplacements["rhumb"][number]["for"], string>> = {
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
