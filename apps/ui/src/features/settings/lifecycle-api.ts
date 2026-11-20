import { RHUMB_CREDENTIAL_REF } from "@tavi/contracts";

import { ask, mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { credentialActions } from "./credentials-api.js";

export const RHUMB_SIGN_UP_URL = "https://rhumbdata.com/sign-up";

/** One model in use that warns, as `models sync` answers it. */
export interface LifecycleWarningRow {
  readonly connectionId: string;
  readonly model: string;
  readonly level: "error" | "warning" | "info";
  readonly says: readonly string[];
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
