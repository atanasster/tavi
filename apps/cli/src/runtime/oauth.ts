import { PairingRegistry } from "@tavi/runtime";
import { channelDescriptorOf } from "../features/channels/catalog.js";
import { connectionOptIns } from "../features/channels/oauth.js";
import { OpenRouterSignIns } from "../features/onboard/openrouter.js";
import { errorMessage } from "@tavi/contracts/util";
import { createRoomInvitations } from "../features/channels/group-pairing.js";
import { workspaceLocaleOf } from "../features/channels/channel-words.js";
import type { ConnectWaits } from "../features/apps/connect-waits.js";
import { OAuthFlows, boundAccountOf } from "../features/oauth/flow.js";
import { OAuthCallbackRouter } from "../features/oauth/core.js";
import { ChatGptSignIns, chatGptCredentialOf, chatGptHostId } from "../features/onboard/chatgpt.js";
import { OAuthBroker } from "../features/oauth/broker.js";
import { APPS_CALENDAR_SETTING, APPS_MAILBOX_SETTING, parseCalendar, parseMailbox } from "../features/apps/sharing.js";
import type { ModelsContext } from "./models.js";

/** OAuth sign-ins and their callbacks, pairings, the token broker and room invitations. */
export function composeOauth(composed: ModelsContext) {
  const { clock, late, logger, mcpHost, options, overrides, persistencePort, secrets, store } = composed;
  // What an account turned on asks for its scopes too, at its next sign-in: taking mail in or its mailbox, and its calendar.
  const optInsOf = async (connectionId: string) => {
    const record = await persistencePort.repositories.messagingConnections.get(connectionId);
    return connectionOptIns(
      record?.settings,
      parseMailbox(await store.getMeta(APPS_MAILBOX_SETTING))[connectionId] !== undefined,
      parseCalendar(await store.getMeta(APPS_CALENDAR_SETTING)).has(connectionId),
    );
  };

  // Messaging connectors: the service is always
  // built (cheap, no I/O until a connection actually opens) so a future
  // connector needs only registration + an `options.<provider>` config
  // block, not new composition plumbing. `readSecret` reuses the
  // exact same `secrets` chain model credentials already resolve through —
  // no separate connector-credential storage mechanism.
  /**
   * OAuth sign-ins in progress: a connected account is
   * recorded on its connection, with its token's reference, and the
   * connection opened.
   */
  const oauthFlows = new OAuthFlows({
    dataDirectory: options.dataDirectory,
    fetch: overrides.oauthFetchOverride ?? globalThis.fetch,
    now: () => Date.parse(clock.now()),
    descriptorOf: channelDescriptorOf,
    optInsOf,
    connected: async ({ connectionId, workspaceId, accountIdentity, tokenRef }) => {
      // In one step, and never on a connection removed meanwhile.
      if (
        !(await persistencePort.repositories.messagingConnections.markConnected({
          connectionId,
          workspaceId,
          accountIdentity,
          tokenRef,
          now: clock.now(),
        }))
      )
        return false;
      await reloadChannelsRef.current?.(workspaceId);
      // The tasks waiting for this account go on.
      await connectWaitsRef.current
        ?.connected(connectionId)
        .catch((error: unknown) =>
          logger.warn("the tasks waiting for a connection could not go on", { connectionId, error: errorMessage(error) }),
        );
      return true;
    },
    signedInAccount: async (connectionId) => {
      const record = await persistencePort.repositories.messagingConnections.get(connectionId);
      return record === undefined ? undefined : boundAccountOf(record);
    },
    // The listener a public sign-in kept open closes once none waits.
    onPublicFlowsChanged: () =>
      void late.ingress.ensure().catch((error: unknown) => logger.warn("the webhook listener could not follow a sign-in", { error })),
  });
  // Every OAuth callback, from any of its three entry points, reaches the sign-in that owns its state.
  // The canvas's Sign in with OpenRouter: its states come back through the same router.
  const onboardingSignIns = new OpenRouterSignIns({
    now: () => Date.parse(clock.now()),
    ...(overrides.oauthFetchOverride === undefined ? {} : { fetch: overrides.oauthFetchOverride }),
  });
  // The account a canvas sign-in is for when one is kept: its client id is reused, and only it accepted.
  const keptChatGpt = async () => chatGptCredentialOf((await secrets.getSecret("chatgpt").catch(() => null)) ?? "");
  const chatGptSignIns = new ChatGptSignIns({
    hostId: async () => await chatGptHostId(options.dataDirectory),
    now: () => Date.parse(clock.now()),
    ...(overrides.oauthFetchOverride === undefined ? {} : { fetch: overrides.oauthFetchOverride }),
  });
  const oauthCallbacks = new OAuthCallbackRouter([mcpHost.oauth.logins, onboardingSignIns], oauthFlows);
  /** Set once the runtime's reload exists: a sign-in that completes opens its connection. */
  const reloadChannelsRef: { current?: (workspaceId: string) => Promise<unknown> } = {};
  /** Set once the workflow exists: an account that signs in settles the connect waits for it. */
  const connectWaitsRef: { current?: ConnectWaits } = {};
  late.connectWaitsRef = connectWaitsRef;
  // Pairing codes waiting to be sent: kept by the owner for their ten minutes.
  const pairings = new PairingRegistry(() => Date.parse(clock.now()));
  /**
   * The token broker behind every OAuth connector's `accessToken()`:
   * a sign-in that lapses for good closes its connection, which
   * the Command Center then asks the operator to reconnect.
   */
  const oauthBroker = new OAuthBroker({
    dataDirectory: options.dataDirectory,
    fetch: overrides.oauthFetchOverride ?? globalThis.fetch,
    now: () => Date.parse(clock.now()),
    descriptorOf: channelDescriptorOf,
    optInsOf,
    setAuthState: async (connectionId, authState) => {
      const row = await persistencePort.repositories.messagingConnections.get(connectionId);
      // Needing consent, it keeps running on what it was granted: no reopen.
      const closes = authState !== "needs-consent";
      if (
        row === undefined ||
        !(await persistencePort.repositories.messagingConnections.setAuthState({
          connectionId,
          authState,
          reopen: closes,
          now: clock.now(),
        }))
      )
        return;
      logger.warn("an OAuth connection needs to be reconnected", { connectionId, authState });
      // Scheduled, not awaited: the token may have been asked for by a connection the host is opening right now.
      if (closes)
        void reloadChannelsRef
          .current?.(row.workspaceId)
          .catch((error: unknown) => logger.error("channels could not be reloaded after a sign-in lapsed", { connectionId, error }));
    },
  });
  // Rooms a group channel's agent was added to, or that spoke while unlisted, and a flooding room's notice.
  const roomInvitations = createRoomInvitations({
    now: () => clock.now(),
    messaging: {
      send: (message) => late.messaging.send(message),
      buildReplyDestination: (connectionId, replyTo) => late.messaging.buildReplyDestination(connectionId, replyTo),
    },
    workspaceOf: async (connectionId) =>
      late.messaging
        .connectionsOf(late.messaging.providerOf(connectionId) ?? "")
        .find((connection) => connection.connectionId === connectionId)?.workspaceId,
    log: (message, fields) => logger.warn(message, fields),
    localeOf: workspaceLocaleOf(persistencePort.repositories.workspaceSettings),
  });
  return {
    chatGptSignIns,
    connectWaitsRef,
    keptChatGpt,
    oauthBroker,
    oauthCallbacks,
    oauthFlows,
    onboardingSignIns,
    pairings,
    reloadChannelsRef,
    roomInvitations,
  };
}

export type OauthContext = ModelsContext & ReturnType<typeof composeOauth>;
