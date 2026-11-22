import { SECRET_KEY_REF_PATTERN } from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { ask, mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { SETTINGS_BOUNDS, type FormErrors } from "./common.js";

export interface CredentialFormValues {
  readonly reference: string;
  readonly value: string;
}

export function validateCredentialForm(values: CredentialFormValues): FormErrors<CredentialFormValues> {
  const errors: { -readonly [K in keyof CredentialFormValues]?: string } = {};
  if (!SECRET_KEY_REF_PATTERN.test(values.reference) || values.reference.length > SETTINGS_BOUNDS.reference) {
    errors.reference = translateNow("settings.credentials.badReference");
  }
  const value = values.value.trim();
  if (value === "") errors.value = translateNow("settings.credentials.needsValue");
  else if (value.length > SETTINGS_BOUNDS.value) errors.value = translateNow("settings.credentials.tooLong");
  return errors;
}

/** Where `tavi credentials key` says the at-rest key is: none (the store is plain), the key file, or an OS keychain. */
export interface CredentialEncryptionStatus {
  readonly kept: "none" | "file" | "keychain";
  /** For `keychain`: which one, as people call it ("the macOS Keychain"). */
  readonly keychain?: string;
}

export const credentialActions = {
  /** The references stored, never their values, and where the at-rest key is kept (an older owner says nothing). */
  list: (client: SettingsClient) =>
    ask<{
      readonly credentials: readonly string[];
      readonly unusable: readonly string[];
      readonly encryption?: CredentialEncryptionStatus;
    }>(client, "credentials", { action: "list" }),
  /** The value crosses the bridge once, to the owner, and is never sent back. */
  async set(client: SettingsClient, values: CredentialFormValues): Promise<Outcome<string | undefined>> {
    const stored = await ask<unknown>(client, "credentials", { action: "set", reference: values.reference, value: values.value.trim() });
    return mapOutcome(stored, () => translateNow("settings.credentials.stored", { reference: values.reference }));
  },
  async remove(client: SettingsClient, reference: string): Promise<Outcome<string | undefined>> {
    const removed = await ask<unknown>(client, "credentials", { action: "delete", reference });
    return mapOutcome(removed, () => translateNow("settings.credentials.deleted", { reference }));
  },
};
