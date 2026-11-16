import { CONNECTION_ID_PATTERN, SECRET_KEY_REF_PATTERN, type ModelsPayload } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import { restartNote, SETTINGS_BOUNDS } from "./common.js";
import type { ConnectionSummary } from "./models-api.js";
import { credentialActions } from "./credentials-api.js";
import { ask, mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/** What a key over the owner's bound is refused with, before the owner is asked. */
const KEY_TOO_LONG = "The key must be at most 16 KiB.";

export interface ConnectionForm {
  readonly connectionId: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly localOnly: boolean;
  readonly key: string;
  readonly requiresKey: boolean;
}
export function connectionProblem(form: ConnectionForm): string | undefined {
  if (!CONNECTION_ID_PATTERN.test(form.connectionId) || form.connectionId.length > 64)
    return "Connection name must be a lowercase slug, at most 64 characters.";
  if (!form.label.trim() || form.label.length > 120) return "Enter a label of at most 120 characters.";
  try {
    const url = new URL(form.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || form.baseUrl.length > 500)
      throw new Error();
  } catch {
    return "Enter an HTTP(S) endpoint without credentials, query or fragment.";
  }
  if (form.requiresKey && !form.key.trim()) return "Enter the provider key.";
  if (form.key.trim().length > SETTINGS_BOUNDS.value) return KEY_TOO_LONG;
  return undefined;
}
function modelRequest<T>(client: SettingsClient, payload: ModelsPayload): Promise<Outcome<T>> {
  return ask<T>(client, "models", { ...payload }, { refused: "Model action refused." });
}
export async function modelWrite(client: SettingsClient, payload: ModelsPayload): Promise<Outcome<string | undefined>> {
  const result = await modelRequest<unknown>(client, payload);
  return mapOutcome(result, (value) => restartNote(value, "models") ?? "Saved.");
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
    return { ok: false, message: "This connection name already exists. Pick another name." };
  if (
    credentials.value.credentials.includes(baseReference) ||
    credentials.value.unusable.includes(baseReference) ||
    connections.value.some((row) => row.credentialRef === baseReference)
  )
    return {
      ok: false,
      message: `Credential ${reference} already exists or is in use. Pick another connection name or manage it in Credentials.`,
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
  if (!added.ok)
    return { ok: false, message: `${added.message} The key was stored as ${reference}; manage it in Credentials before retrying.` };
  const found = await modelRequest<{ models?: unknown[] }>(client, { action: "discover", connectionId: form.connectionId });
  return {
    ok: true,
    value: `${added.value ?? "Connection added."} ${found.ok ? `Discovered ${plural(found.value.models?.length ?? 0, "model")}.` : `Connection saved, but discovery failed: ${found.message} Use Rediscover to retry.`}`,
  };
}
export async function rebindModel(
  client: SettingsClient,
  connectionId: string,
  reference: string,
  key: string,
): Promise<Outcome<string | undefined>> {
  if (!SECRET_KEY_REF_PATTERN.test(reference) || reference.length > 128)
    return { ok: false, message: "Enter a valid credential reference." };
  if (key.trim().length > SETTINGS_BOUNDS.value) return { ok: false, message: KEY_TOO_LONG };
  if (key.trim()) {
    const stored = await credentialActions.set(client, { reference, value: key.trim() });
    if (!stored.ok) return stored;
  }
  const result = await modelWrite(client, { action: "rebind", connectionId, credentialRef: reference });
  return !result.ok && key.trim()
    ? { ok: false, message: `${result.message} The value was already stored as ${reference}; manage it in Credentials.` }
    : result;
}
