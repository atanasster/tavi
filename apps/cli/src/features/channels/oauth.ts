import { TaviError, pluginClientSecretRef, type ChannelDescriptor, type OAuth2Spec, type OAuthClientStatus } from "@tavi/contracts";

import { channelDescriptors, channelGrantsOf, isBuiltinChannel } from "./catalog.js";
import { oauthClientCredentialRefs } from "../apps/oauth-clients.js";
import { createLocalCredentialStore, serializeCredentialAction } from "../credentials/store.js";

/**
 * The OAuth app a channel connects through. Tavi registers none: the plugin ships its author's
 * client id (`client.source: "plugin"`), or the operator enters their own,
 * stored once per provider and shared by every connection of it. An
 * operator's own client is used in place of the plugin's whenever it is
 * stored — "Use a different OAuth app".
 *
 * A channel of a provider whose apps share one client (Gmail's Google)
 * connects with that shared client only.
 */

/** The provider whose shared client a channel connects with, when its apps share one. */
export function sharedProviderOf(providerId: string): string | undefined {
  // A plugin channel shares a provider's client only once the operator bound that client to it.
  return channelGrantsOf(providerId)?.provider;
}

/**
 * What a shared provider's channels declare of it in their OAuth specs: whether its device flow is refused,
 * and how its client ids name their project. Read from the channels sharing its client, not from its hosts.
 */
export function sharedProviderFacts(provider: string): {
  readonly disallowsDeviceFlow: boolean;
  readonly clientProjectPattern?: string;
} {
  const sharing = channelDescriptors().filter((descriptor) => sharedProviderOf(descriptor.providerId) === provider);
  const specs = sharing.flatMap((descriptor) => oauthSpecOf(descriptor) ?? []);
  // How revocation groups grants is this build's to say: a bound plugin's pattern is never run.
  const pattern = sharing
    .filter((descriptor) => isBuiltinChannel(descriptor.providerId))
    .flatMap((descriptor) => oauthSpecOf(descriptor)?.clientProjectPattern ?? [])[0];
  return {
    disallowsDeviceFlow: specs.some((spec) => spec.disallowsDeviceFlow === true),
    ...(pattern === undefined ? {} : { clientProjectPattern: pattern }),
  };
}

/** Whether a channel offers a sign-in by code: it declares a device address, and its shared provider does not refuse one. */
export function signsInByCode(descriptor: ChannelDescriptor): boolean {
  const spec = oauthSpecOf(descriptor);
  if (spec?.deviceAuthorizationUrl === undefined) return false;
  const provider = sharedProviderOf(descriptor.providerId);
  return provider === undefined || !sharedProviderFacts(provider).disallowsDeviceFlow;
}

/** Where an operator's client for `providerId` is kept in the credential store. */
function oauthClientRefs(providerId: string): { readonly id: string; readonly secret: string } {
  return { id: `channels.oauth-client.${providerId}.id`, secret: `channels.oauth-client.${providerId}.secret` };
}

/** What an account turned on that asks for more access: taking mail in or its mailbox, and its calendar. */
export interface OAuthOptIns {
  readonly mail?: boolean;
  readonly calendar?: boolean;
}

/**
 * What a connection has on that asks for more access: mail while it takes mail in (its `receive` setting, on unless
 * set off) or its mailbox's tools are on, and its calendar while its calendar's tools are.
 */
export function connectionOptIns(
  settings: Readonly<Record<string, unknown>> | undefined,
  mailboxOn: boolean,
  calendarOn: boolean,
): OAuthOptIns {
  return { mail: settings?.["receive"] !== false || mailboxOn, calendar: calendarOn };
}

/** Every scope a connection asks for: the channel's own, and those of each opt-in it has on. */
export function requiredScopes(spec: OAuth2Spec, optIns: OAuthOptIns): readonly string[] {
  return [
    ...new Set([
      ...spec.scopes,
      ...(optIns.mail === true ? (spec.optInScopes?.mail ?? []) : []),
      ...(optIns.calendar === true ? (spec.optInScopes?.calendar ?? []) : []),
    ]),
  ];
}

export function oauthSpecOf(descriptor: ChannelDescriptor): OAuth2Spec | undefined {
  return descriptor.auth.kind === "oauth2" ? descriptor.auth.oauth : undefined;
}

/** `stored`: the credential references the store holds, read once by a caller asking for several channels. */
export function oauthClientStatus(stored: ReadonlySet<string>, descriptor: ChannelDescriptor): OAuthClientStatus | undefined {
  const spec = oauthSpecOf(descriptor);
  if (spec === undefined) return undefined;
  const provider = sharedProviderOf(descriptor.providerId);
  // A channel whose provider's apps share a client signs in with that one alone.
  const own =
    provider === undefined ? stored.has(oauthClientRefs(descriptor.providerId).id) : stored.has(oauthClientCredentialRefs(provider).id);
  return { source: spec.client.source, own, ready: own || spec.client.source === "plugin" };
}

/**
 * The client a channel connects with: the operator's own when stored, else the plugin's. Never given to a plugin.
 * Absent (`null`) is the only answer that moves on to the next client: a store that cannot be read fails the
 * sign-in, never signing in with another app or without the secret that was kept.
 */
export async function oauthClientOf(
  dataDirectory: string,
  descriptor: ChannelDescriptor,
  spec: OAuth2Spec,
): Promise<{ readonly clientId: string; readonly clientSecret?: string; readonly shared?: true }> {
  const store = createLocalCredentialStore(dataDirectory);
  const provider = sharedProviderOf(descriptor.providerId);
  if (provider !== undefined) {
    const sharedRefs = oauthClientCredentialRefs(provider);
    const sharedId = await store.getSecret(sharedRefs.id);
    if (sharedId === null || sharedId === "")
      throw new TaviError("NOT_CONFIGURED", `${descriptor.label} signs in with your ${provider} client: set it up first`);
    const sharedSecret = await store.getSecret(sharedRefs.secret);
    return { clientId: sharedId, ...(sharedSecret === null || sharedSecret === "" ? {} : { clientSecret: sharedSecret }), shared: true };
  }
  const refs = oauthClientRefs(descriptor.providerId);
  const ownId = await store.getSecret(refs.id);
  if (ownId !== null) {
    const ownSecret = await store.getSecret(refs.secret);
    return { clientId: ownId, ...(ownSecret === null ? {} : { clientSecret: ownSecret }) };
  }
  if (spec.client.source === "operator")
    throw new TaviError("NOT_CONFIGURED", `${descriptor.label} connects through an OAuth app of your own: enter it first`);
  // Only the channel's own client secret: the host sends it to the channel's token address.
  if (spec.client.clientSecretRef !== undefined && spec.client.clientSecretRef !== pluginClientSecretRef(descriptor.providerId))
    throw new TaviError(
      "NOT_AUTHORIZED",
      `${descriptor.label}'s OAuth client secret must be kept at ${pluginClientSecretRef(descriptor.providerId)}`,
    );
  const pluginSecret = spec.client.clientSecretRef === undefined ? null : await store.getSecret(spec.client.clientSecretRef);
  return { clientId: spec.client.clientId, ...(pluginSecret === null ? {} : { clientSecret: pluginSecret }) };
}

/** A token request's client authentication, as the channel's `tokenAuthMethod` says: in the body, as Basic, or the id alone. */
export function withClientAuth(
  spec: OAuth2Spec,
  client: { readonly clientId: string; readonly clientSecret?: string },
  body: URLSearchParams,
  headers: Record<string, string>,
): void {
  if (spec.tokenAuthMethod === "client_secret_basic" && client.clientSecret !== undefined) {
    headers["authorization"] =
      `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
    return;
  }
  body.set("client_id", client.clientId);
  if (spec.tokenAuthMethod === "client_secret_post" && client.clientSecret !== undefined) body.set("client_secret", client.clientSecret);
}

/** Stores the operator's own client for a provider: its id, and its secret when the provider has one. */
export async function saveOAuthClient(
  dataDirectory: string,
  descriptor: ChannelDescriptor,
  client: { readonly clientId: string; readonly clientSecret?: string },
): Promise<void> {
  if (oauthSpecOf(descriptor) === undefined) throw new TaviError("INVALID_INPUT", `${descriptor.label} does not connect with OAuth`);
  const refs = oauthClientRefs(descriptor.providerId);
  await serializeCredentialAction(dataDirectory, async () => {
    const store = createLocalCredentialStore(dataDirectory);
    await store.setSecret(refs.id, client.clientId);
    // A client without a secret (a public, PKCE-only one) has none stored, not an old one kept.
    if (client.clientSecret === undefined) await store.deleteSecret(refs.secret);
    else await store.setSecret(refs.secret, client.clientSecret);
  });
}

/** Forgets the operator's own client: a plugin one connects with the plugin's again, an operator one with none. */
export async function clearOAuthClient(dataDirectory: string, providerId: string): Promise<void> {
  const refs = oauthClientRefs(providerId);
  await serializeCredentialAction(dataDirectory, async () => {
    const store = createLocalCredentialStore(dataDirectory);
    await store.deleteSecret(refs.id);
    await store.deleteSecret(refs.secret);
  });
}
