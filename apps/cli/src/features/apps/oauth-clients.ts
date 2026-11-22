import { keyedError } from "@tavi/contracts";

import { createLocalCredentialStore, credentialsEncrypted, serializeCredentialAction } from "../credentials/store.js";

/**
 * One OAuth client per provider, shared by every app of it: a Google *Desktop app* client from
 * the person's own Cloud project signs in Calendar, a second Calendar account
 * and a Gmail channel. A Desktop client comes back to any loopback port (RFC 8252 §7.3), so no
 * redirect is registered and no port kept. Kept in the credential store, never in a
 * plugin's settings, so no plugin config names it.
 */

/** The most a client file is read for: Google's is a few hundred bytes. */
export const CLIENT_FILE_MAX = 8_192;

/**
 * The id and secret in a client file as a provider's console downloads it (Google's
 * `client_secret_….json`, `{ "installed": { "client_id", "client_secret", … } }`). Only a Desktop
 * (`installed`) client is taken: a Web client registers one exact redirect, which no free port matches.
 */
export function parseClientFile(text: string): { readonly clientId: string; readonly clientSecret?: string } {
  if (text.length > CLIENT_FILE_MAX) throw keyedError("INVALID_INPUT", "error.apps.clientFile.tooLarge");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw keyedError("INVALID_INPUT", "error.apps.clientFile.notJson");
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (record["web"] !== undefined) throw keyedError("INVALID_INPUT", "error.apps.clientFile.webClient");
  const installed = record["installed"];
  const client = typeof installed === "object" && installed !== null ? (installed as Record<string, unknown>) : undefined;
  const clientId = client?.["client_id"];
  if (typeof clientId !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(clientId))
    throw keyedError("INVALID_INPUT", "error.apps.clientFile.noDesktopClient");
  const clientSecret = client?.["client_secret"];
  if (clientSecret !== undefined && (typeof clientSecret !== "string" || clientSecret.length > 512))
    throw keyedError("INVALID_INPUT", "error.apps.clientFile.badSecret");
  return { clientId, ...(typeof clientSecret === "string" && clientSecret !== "" ? { clientSecret } : {}) };
}

export function oauthClientCredentialRefs(provider: string): { readonly id: string; readonly secret: string } {
  return { id: `oauth-clients.${provider}.id`, secret: `oauth-clients.${provider}.secret` };
}

/** The shared client for `provider`, when one is stored; a store that cannot be read fails, never reading as no client or no secret. */
export async function readSharedOAuthClient(
  resolveSecret: (reference: string) => Promise<string | null>,
  provider: string,
): Promise<{ readonly clientId: string; readonly clientSecret?: string } | undefined> {
  const refs = oauthClientCredentialRefs(provider);
  const clientId = await resolveSecret(refs.id);
  if (clientId === null || clientId === "") return undefined;
  const clientSecret = await resolveSecret(refs.secret);
  return { clientId, ...(clientSecret === null || clientSecret === "" ? {} : { clientSecret }) };
}

/** Stores the shared client; a secret only into an encrypted store, as a channel's OAuth app is. */
export async function saveSharedOAuthClient(
  dataDirectory: string,
  provider: string,
  client: { readonly clientId: string; readonly clientSecret?: string },
): Promise<void> {
  if (client.clientSecret !== undefined && !credentialsEncrypted(dataDirectory)) {
    throw keyedError("NOT_CONFIGURED", "error.apps.clientSecretNeedsEncryption");
  }
  const refs = oauthClientCredentialRefs(provider);
  await serializeCredentialAction(dataDirectory, async () => {
    const store = createLocalCredentialStore(dataDirectory);
    // Unreadable is another client: its secret is dropped below, the safe side, and the new client is stored.
    const previous = await store.getSecret(refs.id).catch(() => undefined);
    await store.setSecret(refs.id, client.clientId);
    // A form never shows a stored secret: left blank for the same client, the one kept stays; a new client drops it.
    if (client.clientSecret !== undefined) await store.setSecret(refs.secret, client.clientSecret);
    else if (previous !== client.clientId) await store.deleteSecret(refs.secret);
  });
}
