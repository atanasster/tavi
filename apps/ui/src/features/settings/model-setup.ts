import { CONNECTION_ID_PATTERN, SECRET_KEY_REF_PATTERN, type ModelsPayload } from "@tavi/contracts";
import { translateNow } from "../../lib/i18n.js";
import { restartNote, SETTINGS_BOUNDS } from "./common.js";
import type { ConnectionSummary } from "./models-api.js";
import { credentialActions } from "./credentials-api.js";
import { ask, mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/** What a key over the owner's bound is refused with, before the owner is asked. */
const keyTooLong = (): string => translateNow("settings.setup.keyTooLong");

export interface ConnectionForm {
  readonly connectionId: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly localOnly: boolean;
  readonly key: string;
  readonly requiresKey: boolean;
}
/** Whether a `connectionProblem` is about the key field rather than a folded one. */
export function isKeyProblem(problem: string | undefined): boolean {
  return problem === translateNow("settings.setup.needsKey") || problem === keyTooLong();
}
export function connectionProblem(form: ConnectionForm): string | undefined {
  if (!CONNECTION_ID_PATTERN.test(form.connectionId) || form.connectionId.length > 64)
    return translateNow("settings.setup.badConnectionName");
  if (!form.label.trim() || form.label.length > 120) return translateNow("settings.setup.badLabel");
  try {
    const url = new URL(form.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || form.baseUrl.length > 500)
      throw new Error();
  } catch {
    return translateNow("settings.setup.badEndpoint");
  }
  if (form.requiresKey && !form.key.trim()) return translateNow("settings.setup.needsKey");
  if (form.key.trim().length > SETTINGS_BOUNDS.value) return keyTooLong();
  return undefined;
}
function modelRequest<T>(client: SettingsClient, payload: ModelsPayload): Promise<Outcome<T>> {
  return ask<T>(client, "models", { ...payload }, { refused: translateNow("settings.setup.refused") });
}
export async function modelWrite(client: SettingsClient, payload: ModelsPayload): Promise<Outcome<string | undefined>> {
  const result = await modelRequest<unknown>(client, payload);
  return mapOutcome(result, (value) => restartNote(value, "models") ?? translateNow("settings.setup.saved"));
}
/** Credential first. A new connection never overwrites another connection or stored key. */
export async function addModelConnection(client: SettingsClient, form: ConnectionForm): Promise<Outcome<string | undefined>> {
  const problem = connectionProblem(form);
  if (problem) return { ok: false, message: problem };
  const baseReference = `${form.connectionId}.apiKey`;
  const reference = `${baseReference}.${crypto.randomUUID()}`;
  const [connections, credentials] = await Promise.all([
    modelRequest<readonly ConnectionSummary[]>(client, { action: "list" }),
    credentialActions.list(client),
  ]);
  if (!connections.ok) return connections;
  if (!credentials.ok) return credentials;
  if (connections.value.some((row) => row.connectionId === form.connectionId))
    return { ok: false, message: translateNow("settings.setup.nameTaken") };
  if (
    credentials.value.credentials.includes(baseReference) ||
    credentials.value.unusable.includes(baseReference) ||
    connections.value.some((row) => row.credentialRef === baseReference)
  )
    return {
      ok: false,
      message: translateNow("settings.setup.credentialTaken", { reference }),
    };
  // The transport requires a binding even for keyless local APIs; this public placeholder is not a cloud credential.
  const stored = await credentialActions.set(client, { reference, value: form.key.trim() || "local-no-key" });
  if (!stored.ok) return stored;
  const added = await modelWrite(client, {
    action: "add",
    connectionId: form.connectionId,
    label: form.label.trim(),
    // No kind: the owner gives a new connection its preset's (Anthropic's own Messages API for Anthropic's endpoint).
    baseUrl: form.baseUrl.trim(),
    localOnly: form.localOnly,
    credentialRef: reference,
  });
  if (!added.ok) return { ok: false, message: translateNow("settings.setup.notAdded", { message: added.message, reference }) };
  const found = await modelRequest<{ models?: unknown[] }>(client, { action: "discover", connectionId: form.connectionId });
  const discovered = found.ok
    ? translateNow("settings.models.discovered", { count: found.value.models?.length ?? 0 })
    : translateNow("settings.setup.discoveryFailed", { message: found.message });
  return { ok: true, value: `${added.value ?? translateNow("settings.setup.added")} ${discovered}` };
}
export async function rebindModel(
  client: SettingsClient,
  connectionId: string,
  reference: string,
  key: string,
): Promise<Outcome<string | undefined>> {
  if (!SECRET_KEY_REF_PATTERN.test(reference) || reference.length > 128)
    return { ok: false, message: translateNow("settings.setup.badReference") };
  if (key.trim().length > SETTINGS_BOUNDS.value) return { ok: false, message: keyTooLong() };
  if (key.trim()) {
    const stored = await credentialActions.set(client, { reference, value: key.trim() });
    if (!stored.ok) return stored;
  }
  const result = await modelWrite(client, { action: "rebind", connectionId, credentialRef: reference });
  return !result.ok && key.trim()
    ? { ok: false, message: translateNow("settings.setup.notRebound", { message: result.message, reference }) }
    : result;
}
