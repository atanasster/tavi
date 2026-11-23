import { randomUUID } from "node:crypto";

import {
  DEFAULT_CHANNEL_INGRESS,
  TaviError,
  keyedError,
  TEXT_REF_DEPTH_MAX,
  textRef,
  type TextRef,
  type TextRefParams,
  channelAccountOf,
  channelIdentity,
  grantInForce,
  grantRefusal,
  ToolPatternSchema,
  type ChannelsGrantsAnswer,
  type ChannelConnectionView,
  type ChannelDescriptor,
  type ChannelField,
  type ChannelIngressSettings,
  type ChannelsCatalogAnswer,
  type ChannelsIngressAnswer,
  type ChannelsShareClientAnswer,
  type ChannelsListAnswer,
  type ChannelsOAuthDisconnectAnswer,
  type ChannelsPayload,
  type ChannelsOAuthStartAnswer,
  type ChannelsOAuthDeviceStartAnswer,
  type ChannelsOAuthStatusAnswer,
  type ChannelsPairAnswer,
  type ChannelsPairingAnswer,
  type ChannelsPeopleAnswer,
  type ChannelsProbeAnswer,
  type ChannelsRemovePreviewAnswer,
  type ChannelsForgetSenderAnswer,
  type ChannelsDeleteAnswer,
  type ChannelsRoomsAnswer,
  type ChannelsSaveAnswer,
  type ChannelsTestAnswer,
  type OAuthClientStatus,
  type MessagingServicePort,
  type PersistencePort,
  isLocalConnectionId,
  RESERVED_CHANNEL_CONNECTION_IDS,
} from "@tavi/contracts";
import type { CoreKey } from "@tavi/contracts/locales/core";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { type ChannelHost, type ChannelRecord, isTrustedProxyEntry, type PairingRegistry } from "@tavi/runtime";

import {
  CHANNELS_INGRESS_TRUSTED_PROXIES_SETTING,
  CHANNELS_SHARED_CLIENTS_SETTING,
  channelDescriptorOf,
  channelDescriptors,
  channelPluginOf,
  channelPluginVersionOf,
  parseSharedClients,
  parseTrustedProxies,
  setSharedClientBindings,
  signsInAtProvider,
} from "./catalog.js";
import { accountSetup } from "../apps/sources/channel.js";
import { MESSAGING_PROFILE_TOOLS } from "./profile.js";
import { channelRooms, type ChannelRoomsDependencies } from "./rooms.js";
import { cancelPurgesFor, purgePreview, rememberAccounts, rememberedAccount, schedulePurge } from "./purge.js";
import {
  APPS_CALENDAR_SETTING,
  APPS_MAILBOX_SETTING,
  APPS_SHARING_SETTING,
  parseCalendar,
  parseMailbox,
  parseSharing,
} from "../apps/sharing.js";
import { boundAccountOf } from "../oauth/flow.js";
import { channelSecretRef } from "./settings.js";
import { readSharedOAuthClient, saveSharedOAuthClient } from "../apps/oauth-clients.js";
import { clearOAuthClient, oauthClientOf, oauthClientStatus, oauthSpecOf, saveOAuthClient, sharedProviderOf } from "./oauth.js";
import type { OAuthFlows } from "../oauth/flow.js";
import { createLocalCredentialStore, credentialsEncrypted, listCredentialRefs, serializeCredentialAction } from "../credentials/store.js";

/** Field labels joined as "a and b and c", by key, so each language joins them its own way; past the reference depth, as English text. */
function fieldList(labels: readonly string[]): string | TextRef {
  const [first, ...rest] = labels;
  if (first === undefined || labels.length >= TEXT_REF_DEPTH_MAX) return labels.join(" and ");
  return rest.reduce<string | TextRef>((joined, last) => textRef("error.channels.fieldsJoined", { first: joined, last }), first);
}
/**
 * The `channels` IPC command: every
 * channel's connections, configured from its descriptor. Answered only on the
 * operator's own connection (the bridge or the CLI), never by a tool.
 */
export interface ChannelsCommandDependencies {
  readonly dataDirectory: string;
  readonly repositories: Pick<
    PersistencePort["repositories"],
    | "messagingConnections"
    | "messagingIdentityBindings"
    | "channelIngress"
    | "messagingOutbox"
    | "channelRooms"
    | "channelPurges"
    | "messagingGrants"
  >;
  readonly channels: Pick<ChannelHost, "list" | "configured">;
  readonly messaging: Pick<
    MessagingServicePort,
    | "send"
    | "buildDestination"
    | "providerOf"
    | "statusOf"
    | "buildReplyDestination"
    | "buildDirectDestination"
    | "capabilitiesOf"
    | "listRooms"
    | "leaveRoom"
    | "roomDrops"
    | "roomDetails"
    | "fetchRecent"
    | "probe"
  >;
  /** Rooms waiting for the operator (group pairing): a room added or left waits no more. */
  readonly roomInvitations?: ChannelRoomsDependencies["roomInvitations"];
  /** The catalog as the canvas reads it: each plugin channel's words from its language pack (`features/plugins/localized.ts`). */
  readonly localizeCatalog?: (descriptors: readonly ChannelDescriptor[]) => readonly ChannelDescriptor[];
  /** The workspace's operator, whom a room's introduction names. */
  readonly operatorOf?: (workspaceId: string) => string | undefined;
  /** Erases artifacts, rows and bodies (a forgotten sender's files). */
  readonly eraseArtifacts?: (artifactIds: readonly string[]) => Promise<{ readonly artifacts: number }>;
  /** Forgets what a person's own conversation tasks taught (their notes and memory); answers how many records went. Absent offline. */
  readonly forgetNotes?: (principalId: string, taskIds: readonly string[]) => Promise<number>;
  /** How many chat notes these conversation tasks taught (a running owner's), for a removal's preview. */
  readonly countNotes?: (taskIds: readonly string[]) => Promise<number>;
  /** Applies saved changes now; answers the workspace's connections that could not open, and the purges the connections that opened cancelled. */
  readonly reload: (workspaceId: string) => Promise<ChannelsReloaded>;
  /** Moves the webhook listener to the saved ingress settings now. */
  readonly applyIngress: () => Promise<void>;
  /** OAuth sign-ins in progress. */
  readonly oauth: Pick<OAuthFlows, "start" | "startDevice" | "status" | "callback" | "finish" | "cancel">;
  /** Signs a connection out at its provider and deletes its token. */
  readonly revokeToken: (
    connection: { readonly connectionId: string; readonly providerId: string },
    options?: { readonly upstream?: boolean; readonly client?: { readonly clientId: string; readonly clientSecret?: string } },
  ) => Promise<void>;
  /**
   * The workspace's accounts another app shares a provider grant with, each
   * with those apps (`keptBy`): their disconnect deletes
   * the token here only. Without it, a disconnect revokes upstream.
   */
  readonly sharedGrants?: (workspaceId: string) => Promise<ReadonlyMap<string, readonly string[]>>;
  /** The pairing codes waiting to be sent. */
  readonly pairings: Pick<PairingRegistry, "start" | "get" | "end">;
  readonly now: () => string;
  /** The owner's settings: the shared client a channel's sign-ins were last made with (`reconcileSharedClients`). */
  readonly meta?: {
    readonly get: (key: string) => Promise<string | undefined>;
    readonly set: (key: string, value: string) => Promise<void>;
  };
}

/**
 * The account handle a channel's deep link names, read from its test's setup link: what follows the template's text
 * before `{account}` (`https://t.me/` for Telegram), when that is all a handle.
 */
export function pairingAccountOf(pairing: NonNullable<ChannelDescriptor["pairing"]>, setupLink: string | undefined): string | undefined {
  const prefix = pairing.deepLinkTemplate.slice(0, pairing.deepLinkTemplate.indexOf("{account}"));
  if (setupLink === undefined || !setupLink.startsWith(prefix)) return undefined;
  const account = setupLink.slice(prefix.length);
  return /^[A-Za-z0-9_.-]{1,64}$/u.test(account) ? account : undefined;
}

/** A removed account's choices on its app's page, forgotten with it. */
async function forgetAccountChoices(deps: ChannelsCommandDependencies, accountId: string): Promise<void> {
  if (deps.meta === undefined) return;
  // Each choice by account, as its setting keeps it.
  const readers: readonly [string, (raw: string | undefined) => Record<string, unknown>][] = [
    [APPS_MAILBOX_SETTING, (raw) => ({ ...parseMailbox(raw) })],
    [APPS_SHARING_SETTING, (raw) => ({ ...parseSharing(raw) })],
    [APPS_CALENDAR_SETTING, (raw) => Object.fromEntries([...parseCalendar(raw)].map((id) => [id, true]))],
  ];
  for (const [key, read] of readers) {
    const choices = read(await deps.meta.get(key));
    if (!(accountId in choices)) continue;
    delete choices[accountId];
    await deps.meta.set(key, JSON.stringify(choices));
  }
}

/** The other apps that keep a connection's grant at its provider, as Connected apps weighs it. */
async function keptByOf(
  deps: ChannelsCommandDependencies,
  record: Parameters<typeof sharesGrant>[0] & { readonly workspaceId: string; readonly connectionId: string },
): Promise<readonly string[]> {
  if (!sharesGrant(record)) return [];
  return (await deps.sharedGrants?.(record.workspaceId))?.get(record.connectionId) ?? [];
}

/** A signed-in connection of a provider whose apps share one grant. */
const sharesGrant = (record: {
  readonly providerId: string;
  readonly credentialRefs: Readonly<Record<string, string>>;
  readonly deletedAt?: string | undefined;
}): boolean =>
  sharedProviderOf(record.providerId) !== undefined && record.deletedAt === undefined && record.credentialRefs["oauth"] !== undefined;

/** The most pending sends a delete settles for its connection. */
const PENDING_SWEEP_LIMIT = 10_000;

type Answer =
  | ChannelsCatalogAnswer
  | ChannelsListAnswer
  | ChannelsRoomsAnswer
  | ChannelsGrantsAnswer
  | ChannelsRemovePreviewAnswer
  | ChannelsForgetSenderAnswer
  | ChannelsDeleteAnswer
  | ChannelsOAuthDisconnectAnswer
  | ChannelsSaveAnswer
  | ChannelsTestAnswer
  | ChannelsProbeAnswer
  | ChannelsPeopleAnswer
  | ChannelsIngressAnswer
  | ChannelsShareClientAnswer
  | ChannelsPairAnswer
  | ChannelsPairingAnswer
  | ChannelsOAuthStartAnswer
  | ChannelsOAuthDeviceStartAnswer
  | ChannelsOAuthStatusAnswer
  | { readonly ok: boolean; readonly message?: string };

export async function channelsCommand(
  deps: ChannelsCommandDependencies,
  payload: ChannelsPayload,
): Promise<{ readonly ok: true; readonly result: Answer }> {
  const result = await answer(deps, payload);
  return { ok: true, result };
}

async function answer(deps: ChannelsCommandDependencies, payload: ChannelsPayload): Promise<Answer> {
  const { messagingConnections: connections, messagingIdentityBindings: bindings, channelIngress: ingress } = deps.repositories;
  switch (payload.action) {
    case "catalog":
      return { channels: deps.localizeCatalog?.(channelDescriptors()) ?? channelDescriptors() };
    case "list": {
      const stored = new Set((await listCredentialRefs(deps.dataDirectory)).valid);
      const rows = await connections.list(payload.workspaceId);
      const authStates = new Map(rows.map((row) => [row.connectionId, row.authState]));
      // Read only when a provider's apps share grants here; a projection that fails leaves the list as it was.
      const kept = rows.some(sharesGrant) ? await deps.sharedGrants?.(payload.workspaceId).catch(() => undefined) : undefined;
      const views = deps.channels
        .list()
        .filter((view) => view.workspaceId === payload.workspaceId)
        .map((view): ChannelConnectionView => {
          const descriptor = channelDescriptorOf(view.providerId);
          const fields = descriptor === undefined || descriptor.auth.kind === "none" ? [] : (descriptor.auth.fields ?? []);
          return {
            connectionId: view.connectionId,
            providerId: view.providerId,
            label: view.label,
            workspaceId: view.workspaceId,
            accountIdentity: view.accountIdentity,
            settings: view.settings,
            secretsStored: Object.fromEntries(fields.map((field) => [field.key, stored.has(view.credentialRefs[field.key] ?? "")])),
            enabled: view.enabled,
            authState: authStates.get(view.connectionId) ?? "none",
            ...((kept?.get(view.connectionId) ?? []).length === 0 ? {} : { keptBy: kept?.get(view.connectionId) ?? [] }),
            status: {
              state: view.status.state,
              ...definedOnly({
                detail: view.status.detail,
                lastInboundAt: view.status.lastInboundAt,
                lastSendAt: view.status.lastSendAt,
                lastError: view.status.lastError,
              }),
            },
          };
        });
      const oauthClients: Record<string, OAuthClientStatus> = {};
      for (const descriptor of channelDescriptors()) {
        const status = oauthClientStatus(stored, descriptor);
        if (status !== undefined) oauthClients[descriptor.providerId] = status;
      }
      return {
        connections: views,
        oauthClients,
        credentialsEncrypted: credentialsEncrypted(deps.dataDirectory),
        ingress: await effectiveIngress(deps),
        ...(await trustedProxiesOf(deps)),
      };
    }
    case "save": {
      const descriptor = channelDescriptorOf(payload.providerId);
      if (descriptor === undefined) throw keyedError("NOT_FOUND", "error.channels.notInstalled", { providerId: payload.providerId });
      // Removed connections too: an id is its connection's for good, so a reused one is checked against it.
      const existing =
        payload.connectionId === undefined
          ? undefined
          : (await connections.list(undefined, { includeDeleted: true })).find((record) => record.connectionId === payload.connectionId);
      if (existing !== undefined && existing.workspaceId !== payload.workspaceId)
        throw keyedError("NOT_AUTHORIZED", "error.channels.noConnection");
      if (existing !== undefined && existing.providerId !== descriptor.providerId)
        throw keyedError("CONFLICT", "error.channels.otherChannel", {
          connectionId: existing.connectionId,
          channel: channelDescriptorOf(existing.providerId)?.label ?? existing.providerId,
        });
      if (existing === undefined && payload.connectionId !== undefined && RESERVED_CHANNEL_CONNECTION_IDS.has(payload.connectionId))
        throw keyedError("INVALID_INPUT", "error.channels.reservedId", { connectionId: payload.connectionId });
      const connectionId = payload.connectionId ?? `${payload.providerId}-${randomUUID().slice(0, 8)}`;
      const settings = checkedSettings(descriptor, payload.settings);
      const fields = descriptor.auth.kind === "none" ? [] : (descriptor.auth.fields ?? []);
      for (const key of Object.keys(payload.secrets ?? {})) {
        if (!fields.some((field) => field.key === key)) throw new TaviError("INVALID_INPUT", `${descriptor.label} has no secret ${key}`);
      }
      // A signed-in connection keeps its token and the account it signed in as: a save changes neither.
      const signedIn = existing?.credentialRefs["oauth"];
      const credentialRefs: Record<string, string> = Object.fromEntries(
        fields.map((field) => [field.key, channelSecretRef(connectionId, field.key)]),
      );
      if (signedIn !== undefined) credentialRefs["oauth"] = signedIn;
      await serializeCredentialAction(deps.dataDirectory, async () => {
        const store = createLocalCredentialStore(deps.dataDirectory);
        const stored = new Set((await listCredentialRefs(deps.dataDirectory)).valid);
        // An enabled connection needs every secret: given now, or stored before.
        const missing = payload.enabled
          ? fields.filter((field) => payload.secrets?.[field.key] === undefined && !stored.has(credentialRefs[field.key] ?? ""))
          : [];
        if (missing.length > 0)
          throw keyedError("INVALID_INPUT", "error.channels.enterBeforeEnabling", {
            fields: fieldList(missing.map((field) => field.label)),
            channel: descriptor.label,
          });
        for (const [key, value] of Object.entries(payload.secrets ?? {})) {
          const reference = credentialRefs[key];
          if (reference === undefined) throw new TaviError("INVALID_INPUT", `${descriptor.label} has no field ${JSON.stringify(key)}`);
          await store.setSecret(reference, value);
        }
        await connections.save(
          {
            connectionId,
            providerId: descriptor.providerId,
            workspaceId: payload.workspaceId,
            ...(payload.label === undefined ? {} : { label: payload.label }),
            // The account it is bound to stays, a sign-in's or an expired one's (a client change drops the token, not the account).
            accountIdentity:
              existing !== undefined && (signedIn !== undefined || boundAccountOf(existing) !== undefined)
                ? existing.accountIdentity
                : channelAccountOf(descriptor, settings),
            settings,
            credentialRefs,
            enabled: payload.enabled,
            authState: existing?.authState ?? "none",
          },
          deps.now(),
        );
      });
      const reload = await reloaded(deps, payload.workspaceId, connectionId);
      const failed = reload.failed.find((failure) => failure.connectionId === connectionId);
      // The same platform account back within a removed connection's grace: its purge is cancelled, by the
      // owner's reload as it opens; one that cannot open now cancels it when it does, at a later reload or start.
      const accountRef = deps.messaging.statusOf(connectionId)?.accountRef;
      // Only this workspace's: the reload opens every workspace's connections, and says what each cancelled.
      const reloadCancelled: string[] = [];
      for (const purged of reload.purgeCancelled)
        if ((await deps.repositories.channelPurges.get(purged))?.workspaceId === payload.workspaceId) reloadCancelled.push(purged);
      const opener = { connectionId, createdAt: existing?.createdAt ?? deps.now() };
      const cancelled = [
        ...reloadCancelled,
        ...(failed === undefined
          ? await cancelPurgesFor({ repositories: deps.repositories, now: deps.now }, descriptor.providerId, accountRef, opener)
          : []),
      ];
      if (deps.meta !== undefined)
        await rememberAccounts(deps.meta, [{ connectionId, providerId: descriptor.providerId }], () => accountRef);
      return {
        connectionId,
        ...(failed === undefined ? {} : { notApplied: failed.detail }),
        ...(cancelled.length === 0 ? {} : { purgeCancelled: cancelled }),
      };
    }
    case "delete": {
      const existing = await connections.get(payload.connectionId);
      if (existing === undefined || existing.workspaceId !== payload.workspaceId)
        throw keyedError("NOT_FOUND", "error.channels.noConnection");
      // The platform's own id for the account, read while it is still open, else as remembered while it ran: what a
      // later re-add cancels the purge by. Remembered too is whether its channel purges, when the catalog no longer says.
      const accountRef = deps.messaging.statusOf(payload.connectionId)?.accountRef;
      const remembered = await rememberedAccount(deps.meta, payload.connectionId);
      // Signed out at the provider first, while its token is still there to name: there only when no other app keeps its grant.
      if (existing.credentialRefs["oauth"] !== undefined)
        await deps.revokeToken(existing, (await keptByOf(deps, existing)).length > 0 ? { upstream: false } : {});
      await connections.remove(payload.connectionId, deps.now());
      // Its grants go with it, on every channel: a connection saved again under the same id starts with none.
      await deps.repositories.messagingGrants.removeForConnection(payload.connectionId);
      // Nobody reaches the agent through it any more.
      for (const binding of await bindings.list(payload.workspaceId)) {
        if (binding.connectionId === payload.connectionId) await bindings.unbind(binding.connectionId, binding.externalSenderId);
      }
      await serializeCredentialAction(deps.dataDirectory, async () => {
        const store = createLocalCredentialStore(deps.dataDirectory);
        for (const reference of Object.values(existing.credentialRefs)) await store.deleteSecret(reference);
      });
      // Removed either way: a reload that fails leaves it closed at the next one.
      await reloaded(deps, payload.workspaceId, payload.connectionId);
      // Closed now, so what its sends did is settled; a row still pending may have gone out before a crash, so it is
      // settled as uncertain, never as not sent, and is not tried again.
      for (const pending of await deps.repositories.messagingOutbox.listPending(PENDING_SWEEP_LIMIT, payload.connectionId)) {
        await deps.repositories.messagingOutbox.resolve({
          effectId: pending.effectId,
          outcome: {
            status: "uncertain",
            retryable: false,
            parts: [{ index: 0, status: "uncertain", error: "connection deleted before the send was confirmed" }],
          },
          now: { fixed: deps.now() },
        });
      }
      // Its mailbox opt-in and sharing go with it: a connection saved again under the same id starts off and Personal.
      await forgetAccountChoices(deps, payload.connectionId);
      // A channel whose terms end with the app: what it brought in is erased after the grace.
      const purge = await schedulePurge({ repositories: deps.repositories, now: deps.now }, existing, accountRef, remembered);
      return { ok: true as const, ...(purge === undefined ? {} : { purgeAfter: purge.purgeAfter }) };
    }
    case "forget-sender": {
      const existing = await connections.get(payload.connectionId);
      if (existing === undefined || existing.workspaceId !== payload.workspaceId)
        throw keyedError("NOT_FOUND", "error.channels.noConnection");
      const descriptor = channelDescriptorOf(existing.providerId);
      const sender = descriptor === undefined ? payload.sender : (channelIdentity(payload.sender, descriptor.sender) ?? payload.sender);
      // Their notes need the owner's memory: offline it is refused, never done by halves.
      if (deps.forgetNotes === undefined || deps.eraseArtifacts === undefined)
        throw keyedError("UNAVAILABLE", "error.channels.forgetNeedsOwner");
      // Read first, and the messages and binding that say who they were and where they spoke go last:
      // a step that fails leaves enough for the same request to finish the job.
      const footprint = await deps.repositories.channelPurges.senderFootprint(payload.connectionId, sender);
      const files = footprint.artifactIds.length === 0 ? { artifacts: 0 } : await deps.eraseArtifacts(footprint.artifactIds);
      const taskIds = [...new Set(footprint.conversations.flatMap((conversation) => conversation.taskIds))];
      const notes = footprint.principalId === undefined ? 0 : await deps.forgetNotes(footprint.principalId, taskIds);
      const forgotten = await deps.repositories.channelPurges.forgetSender(payload.connectionId, sender);
      return {
        sender,
        messages: forgotten.messages,
        quoted: forgotten.quoted,
        files: files.artifacts,
        bindingRemoved: forgotten.bindingRemoved,
        notes,
        stillInTurns: footprint.conversations,
      };
    }
    case "grants": {
      const existing = await connections.get(payload.connectionId);
      if (existing === undefined || existing.deletedAt !== undefined || existing.workspaceId !== payload.workspaceId)
        throw keyedError("NOT_FOUND", "error.channels.noConnection");
      const grants = deps.repositories.messagingGrants;
      const answer = async (): Promise<ChannelsGrantsAnswer> => {
        const at = deps.now();
        return {
          grants: (await grants.listForConnection(payload.connectionId)).map((grant) => ({ ...grant, inForce: grantInForce(grant, at) })),
        };
      };
      if (payload.op === "list") return await answer();
      if (payload.op === "revoke") {
        const grant = payload.grantId === undefined ? undefined : await grants.get(payload.grantId);
        if (grant === undefined || grant.connectionId !== payload.connectionId)
          throw payload.grantId === undefined
            ? keyedError("NOT_FOUND", "error.channels.grantNotOfConnection", { connectionId: payload.connectionId })
            : keyedError("NOT_FOUND", "error.channels.grantIdNotOfConnection", {
                grantId: payload.grantId,
                connectionId: payload.connectionId,
              });
        await grants.revoke(grant.grantId, deps.now());
        return await answer();
      }
      if (payload.scopeKind === undefined || payload.scopeId === undefined || payload.toolId === undefined || payload.mode === undefined)
        throw new TaviError("INVALID_INPUT", "a grant names its scope (a room or a contact), its id, its tool and allow or deny");
      const descriptor = channelDescriptorOf(existing.providerId);
      // A contact as a binding names them; a room is one listed on the connection.
      const scopeId =
        payload.scopeKind === "contact" && descriptor !== undefined ? channelIdentity(payload.scopeId, descriptor.sender) : payload.scopeId;
      if (scopeId === undefined)
        throw descriptor === undefined
          ? keyedError("INVALID_INPUT", "error.channels.notASenderAny", { scopeId: payload.scopeId, channel: existing.providerId })
          : keyedError("INVALID_INPUT", "error.channels.notASender", {
              scopeId: payload.scopeId,
              sender: descriptor.sender.label.toLowerCase(),
              channel: descriptor.label,
            });
      if (payload.scopeKind === "room" && (await deps.repositories.channelRooms.get(payload.connectionId, scopeId)) === undefined)
        throw keyedError("NOT_FOUND", "error.channels.notARoom", { scopeId, connectionId: payload.connectionId });
      const toolId = ToolPatternSchema.safeParse(payload.toolId);
      if (!toolId.success) throw new TaviError("INVALID_INPUT", `${payload.toolId} is not a tool id`);
      const refused = grantRefusal({ scopeKind: payload.scopeKind, toolId: toolId.data, mode: payload.mode });
      if (refused !== undefined) throw new TaviError("INVALID_INPUT", refused);
      // An allow lifts the messaging profile only in a chat channel's one-to-one chat: an email thread is none.
      if (payload.mode === "allow" && descriptor?.kind !== "chat")
        throw keyedError("INVALID_INPUT", "error.channels.grantOnlyDenies", { channel: descriptor?.label ?? existing.providerId });
      // An allow lifts what the messaging profile holds back; any other tool is already offered in a chat.
      if (payload.mode === "allow" && !MESSAGING_PROFILE_TOOLS.includes(toolId.data))
        throw keyedError("INVALID_INPUT", "error.channels.toolNotHeldBack", {
          toolId: toolId.data,
          tools: MESSAGING_PROFILE_TOOLS.join(", "),
        });
      if (payload.expiresAt !== undefined && Date.parse(payload.expiresAt) <= Date.parse(deps.now()))
        throw keyedError("INVALID_INPUT", "error.channels.grantExpiryFuture");
      await grants.put({
        grantId: prefixedId("grant"),
        workspaceId: payload.workspaceId,
        connectionId: payload.connectionId,
        scopeKind: payload.scopeKind,
        scopeId,
        toolId: toolId.data,
        mode: payload.mode,
        createdBy: deps.operatorOf?.(payload.workspaceId) ?? "operator",
        createdAt: deps.now(),
        ...(payload.expiresAt === undefined ? {} : { expiresAt: new Date(payload.expiresAt).toISOString() }),
      });
      return await answer();
    }
    case "remove-preview": {
      const existing = await connections.get(payload.connectionId);
      if (existing === undefined || existing.deletedAt !== undefined || existing.workspaceId !== payload.workspaceId)
        throw keyedError("NOT_FOUND", "error.channels.noConnection");
      return await purgePreview(deps, existing, await rememberedAccount(deps.meta, existing.connectionId));
    }
    case "test": {
      const record = configuredIn(deps, payload.workspaceId, payload.connectionId);
      const descriptor = channelDescriptorOf(record.providerId);
      const destination =
        payload.direct === true ? await directTestDestination(deps, payload, record) : testDestination(deps, payload, record);
      if (destination === undefined) throw keyedError("UNAVAILABLE", "error.channels.notOpen", { connectionId: payload.connectionId });
      const outcome = await deps.messaging.send({
        effectId: prefixedId("channel-test"),
        connectionId: payload.connectionId,
        workspaceId: payload.workspaceId,
        destination,
        parts: [{ content: payload.text ?? "This is a test message from Tavi: the connection works." }],
      });
      const detail = outcome.parts.find((part) => part.error !== undefined)?.error;
      // What setting it up still asks, as its probe says now; a link only to a host its channel declares.
      const probed = await deps.messaging.probe?.(payload.connectionId).catch(() => undefined);
      return {
        status: outcome.status,
        ...(detail === undefined ? {} : { detail }),
        ...accountSetup(probed?.setup, descriptor?.hosts ?? []),
      };
    }
    case "probe": {
      const record = configuredIn(deps, payload.workspaceId, payload.connectionId);
      const descriptor = channelDescriptorOf(record.providerId);
      const probed = await deps.messaging
        .probe?.(payload.connectionId)
        .catch((error: unknown) => ({ ok: false, detail: errorMessage(error), setup: undefined }));
      if (probed === undefined) throw keyedError("UNAVAILABLE", "error.channels.cannotCheck", { connectionId: payload.connectionId });
      return {
        ok: probed.ok,
        ...(probed.detail === undefined ? {} : { detail: probed.detail.slice(0, 500) }),
        ...accountSetup(probed.setup, descriptor?.hosts ?? []),
      };
    }
    case "ingress": {
      if (payload.trustedProxies !== undefined) {
        const refused = payload.trustedProxies.find((entry) => !isTrustedProxyEntry(entry));
        if (refused !== undefined) throw keyedError("INVALID_INPUT", "error.channels.notAnAddress", { value: JSON.stringify(refused) });
        if (deps.meta === undefined) throw new TaviError("UNAVAILABLE", "The owner's settings cannot be written here");
        await deps.meta.set(CHANNELS_INGRESS_TRUSTED_PROXIES_SETTING, JSON.stringify([...new Set(payload.trustedProxies)]));
      }
      const current = await ingress.get();
      await ingress.set(
        {
          host: current?.host ?? DEFAULT_CHANNEL_INGRESS.host,
          port: payload.port,
          ...(payload.publicUrl ? { publicUrl: payload.publicUrl } : {}),
        },
        deps.now(),
      );
      try {
        await deps.applyIngress();
      } catch (error) {
        return { applied: false, notApplied: errorMessage(error) };
      }
      return { applied: true };
    }
    case "rooms":
      return await channelRooms(deps, payload);
    case "people": {
      const operator = deps.operatorOf?.(payload.workspaceId);
      return {
        people: (await bindings.list(payload.workspaceId)).filter((binding) => !isLocalConnectionId(binding.connectionId)),
        ...(operator === undefined ? {} : { operator }),
      };
    }
    case "allow":
      await allowSender(deps, payload);
      return { ok: true };
    case "pair": {
      const { record } = descriptorForSenderAction(deps, payload.workspaceId, payload.connectionId, payload.trustUnverified);
      refuseUnlessListening(deps, payload.connectionId);
      const pairing = deps.pairings.start({
        connectionId: payload.connectionId,
        workspaceId: payload.workspaceId,
        principalId: payload.principalId,
        ...(payload.name === undefined ? {} : { name: payload.name }),
        ...(payload.trustUnverified === undefined ? {} : { trustUnverified: payload.trustUnverified }),
      });
      // A channel with a deep link names its account from the connection's test, as its descriptor says.
      const linking = channelDescriptorOf(record.providerId)?.pairing;
      const probed = linking === undefined ? undefined : await deps.messaging.probe?.(payload.connectionId).catch(() => undefined);
      const account = linking === undefined || probed?.ok !== true ? undefined : pairingAccountOf(linking, probed.setup?.link?.url);
      const shown = `${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}`;
      const linkUrl =
        linking === undefined || account === undefined
          ? undefined
          : linking.deepLinkTemplate.replace("{account}", encodeURIComponent(account)).replace("{code}", encodeURIComponent(shown));
      return {
        pairingId: pairing.pairingId,
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        ...(account === undefined ? {} : { account }),
        ...(linkUrl === undefined || linking === undefined ? {} : { linkUrl, openLabel: linking.openLabel }),
      };
    }
    case "pairing": {
      const found = pairingIn(deps, payload.workspaceId, payload.pairingId);
      if (found === undefined) return { state: "gone" };
      return {
        state: found.state,
        connectionId: found.pairing.connectionId,
        principalId: found.pairing.principalId,
        expiresAt: found.pairing.expiresAt,
        ...(found.pairing.claimedBy === undefined ? {} : { sender: found.pairing.claimedBy }),
        ...(found.pairing.claimedName === undefined ? {} : { senderName: found.pairing.claimedName }),
      };
    }
    case "confirm-pair": {
      const found = pairingIn(deps, payload.workspaceId, payload.pairingId);
      const sender = found?.state === "claimed" ? found.pairing.claimedBy : undefined;
      if (found === undefined || sender === undefined) throw keyedError("CONFLICT", "error.channels.codeNotSent");
      const { pairing } = found;
      const name = pairing.name ?? pairing.claimedName;
      await allowSender(deps, {
        workspaceId: pairing.workspaceId,
        connectionId: pairing.connectionId,
        sender,
        principalId: pairing.principalId,
        ...(name === undefined ? {} : { name }),
        ...(pairing.trustUnverified === undefined ? {} : { trustUnverified: pairing.trustUnverified }),
      });
      deps.pairings.end(pairing.pairingId);
      return { ok: true };
    }
    case "oauth-client": {
      const descriptor = channelDescriptorOf(payload.providerId);
      if (descriptor === undefined) throw keyedError("NOT_FOUND", "error.channels.notInstalled", { providerId: payload.providerId });
      // A client secret is a secret like a sign-in's token: kept only in an encrypted store.
      if (payload.clientSecret !== undefined && !credentialsEncrypted(deps.dataDirectory)) {
        throw keyedError("NOT_CONFIGURED", "error.channels.clientSecretNeedsEncryption", { app: descriptor.app?.name ?? descriptor.label });
      }
      const leaving = await signOutForClientChange(deps, descriptor, payload.clientId);
      // Those signed out are reloaded whether or not the save then succeeds.
      try {
        const client = {
          clientId: payload.clientId,
          ...(payload.clientSecret === undefined ? {} : { clientSecret: payload.clientSecret }),
        };
        // A provider whose apps share one client keeps it once, for all of them.
        const provider = sharedProviderOf(descriptor.providerId);
        if (provider === undefined) await saveOAuthClient(deps.dataDirectory, descriptor, client);
        else await saveSharedOAuthClient(deps.dataDirectory, provider, client);
      } finally {
        await afterClientChange(deps, leaving);
      }
      return { ok: true };
    }
    case "share-client": {
      if (deps.meta === undefined) throw new TaviError("UNSUPPORTED", "this owner keeps no settings to bind a client in");
      const bindings = new Map(parseSharedClients(await deps.meta.get(CHANNELS_SHARED_CLIENTS_SETTING)));
      const before = bindings.get(payload.provider);
      const asking = channelDescriptors().filter(
        (descriptor) => descriptor.app?.provider === payload.provider && channelPluginOf(descriptor.providerId) === payload.pluginId,
      );
      if (payload.pluginId !== null && asking.length === 0)
        throw keyedError("NOT_FOUND", "error.channels.noChannelAsksClient", { pluginId: payload.pluginId, provider: payload.provider });
      // The shared secret goes to a channel's token address: only to the provider's own.
      const elsewhere = asking.find((descriptor) => !signsInAtProvider(descriptor, payload.provider));
      if (elsewhere !== undefined)
        throw keyedError("CONFLICT", "error.channels.signsInElsewhere", { channel: elsewhere.label, provider: payload.provider });
      const version = asking[0] === undefined ? undefined : channelPluginVersionOf(asking[0].providerId);
      if (payload.pluginId !== null && version === undefined)
        throw keyedError("UNAVAILABLE", "error.channels.approvedVersionUnknown", { pluginId: payload.pluginId });
      const next = payload.pluginId === null || version === undefined ? undefined : { pluginId: payload.pluginId, version };
      if (before?.pluginId === next?.pluginId && before?.version === next?.version)
        return { sharedClient: { provider: payload.provider, pluginId: payload.pluginId } };
      // Sign-ins made with one client are never carried to another: the channels gaining or losing it sign out first.
      const affected = channelDescriptors().filter((descriptor) => {
        const owner = channelPluginOf(descriptor.providerId);
        return (
          descriptor.app?.provider === payload.provider && owner !== undefined && (owner === before?.pluginId || owner === payload.pluginId)
        );
      });
      const leaving = (await Promise.all(affected.map(async (descriptor) => await signOutSignedIn(deps, descriptor)))).flat();
      if (next === undefined) bindings.delete(payload.provider);
      else bindings.set(payload.provider, next);
      await deps.meta.set(CHANNELS_SHARED_CLIENTS_SETTING, JSON.stringify(Object.fromEntries(bindings)));
      setSharedClientBindings(bindings);
      await afterClientChange(deps, leaving);
      return { sharedClient: { provider: payload.provider, pluginId: payload.pluginId, signedOut: leaving.length } };
    }
    case "oauth-client-clear": {
      const descriptor = channelDescriptorOf(payload.providerId);
      const provider = sharedProviderOf(payload.providerId);
      // The shared client signs other apps in too: it is changed, not forgotten, from one of them.
      if (
        provider !== undefined &&
        (await readSharedOAuthClient((reference) => createLocalCredentialStore(deps.dataDirectory).getSecret(reference), provider)) !==
          undefined
      ) {
        throw keyedError("CONFLICT", "error.channels.sharedClient", { channel: descriptor?.label ?? payload.providerId, provider });
      }
      const leaving = descriptor === undefined ? [] : await signOutForClientChange(deps, descriptor, undefined);
      try {
        await clearOAuthClient(deps.dataDirectory, payload.providerId);
      } finally {
        await afterClientChange(deps, leaving);
      }
      return { ok: true };
    }
    case "oauth-start": {
      const record = configuredIn(deps, payload.workspaceId, payload.connectionId);
      const descriptor = channelDescriptorOf(record.providerId);
      const spec = descriptor === undefined ? undefined : oauthSpecOf(descriptor);
      if (descriptor === undefined || spec === undefined)
        throw keyedError("INVALID_INPUT", "error.oauth.notOAuth", { channel: descriptor?.label ?? record.providerId });
      // A sign-in keeps a refresh token: it is kept only in an encrypted store.
      if (!credentialsEncrypted(deps.dataDirectory)) {
        throw keyedError("NOT_CONFIGURED", "error.channels.signInNeedsEncryption", { channel: descriptor.label });
      }
      // A sign-in by code needs no redirect back, nor a listener for one (RFC 8628).
      if (payload.device === true)
        return await deps.oauth.startDevice({
          connectionId: payload.connectionId,
          workspaceId: payload.workspaceId,
          providerId: record.providerId,
        });
      // A Desktop client (Google's) takes any loopback port: the redirect is this page's own address.
      const mode = payload.public === true ? "public" : spec.redirect;
      // A Desktop client comes back to this computer only: never through a public address.
      if (mode === "public" && spec.redirect === "loopback-any-port" && sharedProviderOf(descriptor.providerId) !== undefined)
        throw keyedError("INVALID_INPUT", "error.channels.desktopClient", { channel: descriptor.label });
      const redirectUri = await redirectUriFor(deps, descriptor.label, mode, payload.origin);
      const started = await deps.oauth.start({
        connectionId: payload.connectionId,
        workspaceId: payload.workspaceId,
        providerId: record.providerId,
        redirectUri,
      });
      // The listener the provider's redirect comes back to, when it comes through the public address.
      if (mode === "public") await deps.applyIngress();
      return started;
    }
    case "oauth-finish":
      // The address is never echoed: only whether it worked.
      return await deps.oauth.finish(payload.flowId, payload.workspaceId, payload.address);
    case "oauth-cancel":
      return { ok: deps.oauth.cancel(payload.flowId, payload.workspaceId) };
    case "oauth-status": {
      const status = deps.oauth.status(payload.flowId, payload.workspaceId);
      if (status === undefined) return { state: "gone" };
      return {
        state: status.state,
        ...(status.accountIdentity === undefined ? {} : { accountIdentity: status.accountIdentity }),
        ...(status.detail === undefined ? {} : { detail: status.detail }),
      };
    }
    case "oauth-disconnect": {
      const existing = await connections.get(payload.connectionId);
      if (existing === undefined || existing.workspaceId !== payload.workspaceId)
        throw keyedError("NOT_FOUND", "error.channels.noConnection");
      // Another app signed in with the same grant keeps it: only this connection's token goes, as on Connected apps.
      const keptBy =
        payload.upstream === false || !sharesGrant(existing)
          ? []
          : ((await deps.sharedGrants?.(payload.workspaceId))?.get(payload.connectionId) ?? []);
      await deps.revokeToken(existing, payload.upstream === false || keptBy.length > 0 ? { upstream: false } : {});
      await connections.setAuthState({ connectionId: payload.connectionId, authState: "revoked", dropToken: true, now: deps.now() });
      await reloaded(deps, payload.workspaceId, payload.connectionId);
      return { ok: true, keptBy };
    }
    case "oauth-callback":
      return await deps.oauth.callback({
        state: payload.state,
        ...definedOnly({ code: payload.code, error: payload.error, iss: payload.iss }),
      });
    case "cancel-pair":
      if (pairingIn(deps, payload.workspaceId, payload.pairingId) !== undefined) deps.pairings.end(payload.pairingId);
      return { ok: true };
    case "revoke": {
      const previous = await bindings.get(payload.connectionId, payload.sender);
      if (previous === undefined || previous.workspaceId !== payload.workspaceId || isLocalConnectionId(payload.connectionId))
        throw keyedError("NOT_AUTHORIZED", "error.channels.noAllowedPerson");
      await bindings.unbind(payload.connectionId, payload.sender);
      return { ok: true };
    }
  }
}

/**
 * A sign-in is the OAuth app's it was made with: its refresh token is refused
 * with another. Before the app changes, each of the channel's signed-in
 * connections is signed out at the provider with the app it was made with, and
 * marked to be connected again — never left failing quietly.
 */
async function signOutForClientChange(
  deps: ChannelsCommandDependencies,
  descriptor: ChannelDescriptor,
  nextClientId: string | undefined,
): Promise<readonly { readonly connectionId: string; readonly workspaceId: string }[]> {
  const spec = oauthSpecOf(descriptor);
  if (spec === undefined) return [];
  let current: { readonly clientId: string } | undefined;
  try {
    current = await oauthClientOf(deps.dataDirectory, descriptor, spec);
  } catch (error) {
    // No client of its own yet signed nothing in. One that cannot be read (UNAVAILABLE) may have: they are signed
    // out, the safe side. Anything else is not this rule's to absorb.
    const code = TaviError.from(error).code;
    if (code === "UNAVAILABLE") return await signOutSignedIn(deps, descriptor);
    if (code !== "NOT_CONFIGURED") throw error;
  }
  if (current === undefined || current.clientId === nextClientId) return [];
  return await signOutSignedIn(deps, descriptor);
}

/** Each of the channel's signed-in connections, signed out at the provider and marked to be connected again. */
async function signOutSignedIn(
  deps: ChannelsCommandDependencies,
  descriptor: ChannelDescriptor,
  madeWith?: { readonly clientId: string; readonly clientSecret?: string },
): Promise<readonly { readonly connectionId: string; readonly workspaceId: string }[]> {
  const signedIn = (await deps.repositories.messagingConnections.list()).filter(
    (record) => record.providerId === descriptor.providerId && record.credentialRefs["oauth"] !== undefined,
  );
  for (const record of signedIn) {
    // Its token goes; its grant at the provider only when no other app keeps it.
    await deps.revokeToken(
      record,
      (await keptByOf(deps, record)).length > 0 ? { upstream: false } : madeWith === undefined ? {} : { client: madeWith },
    );
    await deps.repositories.messagingConnections.setAuthState({
      connectionId: record.connectionId,
      authState: "expired",
      dropToken: true,
      now: deps.now(),
    });
  }
  return signedIn.map((record) => ({ connectionId: record.connectionId, workspaceId: record.workspaceId }));
}

async function afterClientChange(
  deps: ChannelsCommandDependencies,
  leaving: readonly { readonly connectionId: string; readonly workspaceId: string }[],
): Promise<void> {
  for (const workspaceId of new Set(leaving.map((record) => record.workspaceId))) await deps.reload(workspaceId);
}

/**
 * Where the provider sends the browser back: the page's own
 * loopback address, the saved fixed port for a channel that takes one exact
 * redirect, or the public address through the ingress.
 */
async function redirectUriFor(
  deps: ChannelsCommandDependencies,
  label: string,
  mode: "loopback-any-port" | "public",
  origin: string | undefined,
): Promise<string> {
  if (mode === "public") {
    const publicUrl = (await effectiveIngress(deps)).publicUrl;
    if (publicUrl === undefined) throw keyedError("NOT_CONFIGURED", "error.channels.needsPublicAddress", { channel: label });
    return `${publicUrl.replace(/\/+$/, "")}/oauth/callback`;
  }
  if (origin === undefined) throw keyedError("INVALID_INPUT", "error.channels.connectFromPage", { channel: label });
  return `${origin}/oauth/callback`;
}

/** Where a test to a target goes, as its channel names one. */
function testDestination(
  deps: ChannelsCommandDependencies,
  payload: { readonly connectionId: string; readonly to: string },
  record: ChannelRecord,
): unknown {
  const descriptor = channelDescriptorOf(record.providerId);
  const to = descriptor === undefined ? payload.to : channelIdentity(payload.to, descriptor.target);
  if (to === undefined)
    throw descriptor === undefined
      ? keyedError("INVALID_INPUT", "error.channels.notATargetAny", { to: payload.to, channel: record.providerId })
      : keyedError("INVALID_INPUT", "error.channels.notATarget", {
          to: payload.to,
          target: descriptor.target.label.toLowerCase(),
          channel: descriptor.label,
        });
  return deps.messaging.buildDestination(payload.connectionId, { to, subject: "A test message from Tavi" });
}

/**
 * Where a test to a person allowed on the connection goes: their own chat, as
 * the channel reaches a sender one-to-one (a Telegram user's private chat, a
 * Discord DM), or, on a channel that has none, their sender id as a target.
 */
async function directTestDestination(
  deps: ChannelsCommandDependencies,
  payload: { readonly workspaceId: string; readonly connectionId: string; readonly to: string },
  record: ChannelRecord,
): Promise<unknown> {
  const descriptor = channelDescriptorOf(record.providerId);
  const sender = descriptor === undefined ? payload.to : channelIdentity(payload.to, descriptor.sender);
  const bound = sender === undefined ? undefined : await deps.repositories.messagingIdentityBindings.get(payload.connectionId, sender);
  if (sender === undefined || bound === undefined || bound.workspaceId !== payload.workspaceId)
    throw keyedError("NOT_FOUND", "error.channels.notAllowedOn", { to: payload.to, connectionId: record.connectionId });
  return (
    deps.messaging.buildDirectDestination?.(payload.connectionId, sender, payload.workspaceId) ?? testDestination(deps, payload, record)
  );
}

/** A pairing of this workspace's, or `undefined`: another workspace's is not this page's to see or end. */
function pairingIn(deps: ChannelsCommandDependencies, workspaceId: string, pairingId: string): ReturnType<PairingRegistry["get"]> {
  const found = deps.pairings.get(pairingId);
  return found?.pairing.workspaceId === workspaceId ? found : undefined;
}

/** Resolves a workspace connection's descriptor and checks `trustUnverified` against its sender authentication mode. */
/** A code is handed out only for a connection that can take its message in: one that failed or is stopped never could. */
function refuseUnlessListening(deps: ChannelsCommandDependencies, connectionId: string): void {
  const view = deps.channels.list().find((candidate) => candidate.connectionId === connectionId);
  if (view === undefined || (view.status.state !== "failed" && view.status.state !== "stopped")) return;
  // The canvas says it in its own words, with a link (QA 2033), from the details.
  const details = { details: { notListening: true, label: view.label } };
  throw view.status.detail === undefined
    ? keyedError("NOT_CONFIGURED", "error.channels.notListening", { channel: view.label }, details)
    : keyedError("NOT_CONFIGURED", "error.channels.notListeningWhy", { channel: view.label, why: view.status.detail }, details);
}

function descriptorForSenderAction(
  deps: ChannelsCommandDependencies,
  workspaceId: string,
  connectionId: string,
  trustUnverified: boolean | undefined,
): { readonly record: ChannelRecord; readonly descriptor: ChannelDescriptor } {
  const record = configuredIn(deps, workspaceId, connectionId);
  const descriptor = channelDescriptorOf(record.providerId);
  if (descriptor === undefined) throw keyedError("NOT_FOUND", "error.channels.notInstalled", { providerId: record.providerId });
  if (trustUnverified !== undefined && descriptor.sender.authentication !== "per-message") {
    throw keyedError("INVALID_INPUT", "error.channels.verifiesEverySender", { channel: descriptor.label });
  }
  return { record, descriptor };
}

/** Allows a sender on a connection as a person, in its channel's sender form. */
async function allowSender(
  deps: ChannelsCommandDependencies,
  input: {
    readonly workspaceId: string;
    readonly connectionId: string;
    readonly sender: string;
    readonly principalId: string;
    readonly name?: string | undefined;
    readonly trustUnverified?: boolean | undefined;
  },
): Promise<void> {
  const bindings = deps.repositories.messagingIdentityBindings;
  const { descriptor } = descriptorForSenderAction(deps, input.workspaceId, input.connectionId, input.trustUnverified);
  const sender = channelIdentity(input.sender, descriptor.sender);
  if (sender === undefined)
    throw keyedError("INVALID_INPUT", "error.channels.enterSender", {
      sender: descriptor.sender.label.toLowerCase(),
      channel: descriptor.label,
      example: descriptor.sender.placeholder,
    });
  const previous = await bindings.get(input.connectionId, sender);
  if (previous !== undefined && previous.workspaceId !== input.workspaceId) throw keyedError("CONFLICT", "error.channels.senderElsewhere");
  await bindings.bind({
    connectionId: input.connectionId,
    externalSenderId: sender,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    approvedBy: "local settings operator",
    createdAt: deps.now(),
    ...(input.name === undefined ? {} : { displayName: input.name }),
  });
  if (input.trustUnverified !== undefined) {
    await bindings.setTrustUnverified(
      input.connectionId,
      sender,
      input.trustUnverified ? { setBy: "local settings operator", setAt: deps.now() } : null,
    );
  }
}

/** What a reload did: the connections that could not open, each with why, and the purges the ones that opened cancelled. */
interface ChannelsReloaded {
  readonly failed: readonly { readonly connectionId: string; readonly detail: string }[];
  readonly purgeCancelled: readonly string[];
}

/**
 * Applies a stored change now. It is stored either way, so a reload that
 * fails is reported with the change rather than as its failure.
 */
function reloaded(deps: ChannelsCommandDependencies, workspaceId: string, connectionId: string): Promise<ChannelsReloaded> {
  return deps
    .reload(workspaceId)
    .catch((error: unknown) => ({ failed: [{ connectionId, detail: errorMessage(error) }], purgeCancelled: [] }));
}

/** The trusted proxies saved for the ingress, for `list`: left out when there are none. */
async function trustedProxiesOf(deps: ChannelsCommandDependencies): Promise<{ trustedProxies?: readonly string[] }> {
  const trustedProxies = parseTrustedProxies(await deps.meta?.get(CHANNELS_INGRESS_TRUSTED_PROXIES_SETTING));
  return trustedProxies.length === 0 ? {} : { trustedProxies };
}

/** The ingress settings in effect: the saved ones, else the default. */
async function effectiveIngress(deps: ChannelsCommandDependencies): Promise<ChannelIngressSettings> {
  return (await deps.repositories.channelIngress.get()) ?? DEFAULT_CHANNEL_INGRESS;
}

/** A connection this owner is configured with, in the workspace named. */
function configuredIn(deps: ChannelsCommandDependencies, workspaceId: string, connectionId: string): ChannelRecord {
  const record = deps.channels.configured().find((candidate) => candidate.connectionId === connectionId);
  if (record === undefined || record.workspaceId !== workspaceId) throw keyedError("NOT_FOUND", "error.channels.noConnection");
  return record;
}

/** The settings a descriptor declares, each checked against its field: required, type, choices, pattern. Unknown keys are refused. */
function checkedSettings(
  descriptor: ChannelDescriptor,
  given: Readonly<Record<string, string | number | boolean>>,
): Record<string, string | number | boolean> {
  for (const key of Object.keys(given)) {
    if (!descriptor.settings.some((field) => field.key === key))
      throw keyedError("INVALID_INPUT", "error.channels.noSetting", { channel: descriptor.label, key });
  }
  const settings: Record<string, string | number | boolean> = {};
  for (const field of descriptor.settings) {
    const value = given[field.key] ?? field.default;
    if (value === undefined || value === "") {
      if (field.required === true)
        throw keyedError("INVALID_INPUT", "error.channels.enterField", { field: field.label, channel: descriptor.label });
      continue;
    }
    settings[field.key] = checkedValue(descriptor, field, value);
  }
  return settings;
}

function checkedValue(descriptor: ChannelDescriptor, field: ChannelField, value: string | number | boolean): string | number | boolean {
  const names = { channel: descriptor.label, field: field.label };
  const refuse = (key: CoreKey, params: TextRefParams = {}): never => {
    throw keyedError("INVALID_INPUT", key, { ...names, ...params });
  };
  if (field.type === "choice")
    return typeof value === "string" && (field.choices ?? []).includes(value)
      ? value
      : refuse("error.channels.fieldChoice", { choices: (field.choices ?? []).join(", ") });
  if (typeof value !== field.type) return refuse("error.channels.fieldType", { type: textRef(`error.channels.type.${field.type}`) });
  if (typeof value === "string" && field.pattern !== undefined && !new RegExp(`^(?:${field.pattern})$`, "u").test(value))
    return refuse("error.channels.fieldForm");
  return value;
}
