import {
  type ChannelHostServices,
  type ChannelMailboxKit,
  type MessagingConversationTask,
  TaviError,
  DEFAULT_CHANNEL_INGRESS,
  type ChannelIngressSettings,
  channelIdentity,
  type InboundEvent,
  type ChannelDescriptor,
  type MessagingConnectorDefinition,
  type ReachableChannel,
  isModelVisibleArtifact,
  LOCAL_CONNECTION_PREFIX,
  isLocalConnectionId,
  localConnectionId,
} from "@tavi/contracts";
import {
  applyIngressServerLimits,
  ChannelHost,
  createChannelIngress,
  createIngressGuards,
  type ChannelView,
  createMessagingService,
} from "@tavi/runtime";
import { BUILTIN_CHANNELS, type BuiltinChannel } from "../features/plugins/catalog.js";
import {
  CHANNELS_INGRESS_TRUSTED_PROXIES_SETTING,
  CHANNELS_SHARED_CLIENTS_SETTING,
  channelDescriptorOf,
  channelDescriptors,
  parseSharedClients,
  parseTrustedProxies,
  recordedConnectionProviders,
  registerBuiltinChannelDescriptor,
  registerChannelDescriptor,
  setSharedClientBindings,
  unregisterChannelDescriptor,
} from "../features/channels/catalog.js";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { registerGroupTools } from "../features/channels/group-tools.js";
import { isHeartbeatPress } from "../features/heartbeat/buttons.js";
import { isReminderPress } from "../features/reminders/delivery.js";
import { createLocalConnectorDefinition, type LocalConnectorInstance } from "@tavi/plugin-local/connector";
import { createApprovalLinkHandler } from "../features/approvals/links.js";
import { isScheduleWebhookPath } from "../features/schedules/webhook.js";
import { isMemoryPress } from "../features/memory/channel-cards.js";
import { registerMessagingTools } from "../features/channels/tools.js";
import { createChannelReplyRelay } from "../features/channels/reply-relay.js";
import { oauthCallbackPage } from "../features/oauth/flow.js";
import { MCP_CLIENT_METADATA_PATH, clientMetadataDocument } from "../features/mcp/oauth-provider.js";
import { isSignInSecret } from "../features/oauth/broker.js";
import { allowedTargetsOf, assertDestinationEntries, type DestinationChannels } from "../features/channels/destination.js";
import { sha256Hex } from "@tavi/node-kit";
import { externalConnectionsOf, withChannelDestinations } from "./channel-destinations.js";
import type { LocalMessaging } from "./types.js";
import type { OauthContext } from "./oauth.js";

/** The messaging service, the channel host and its connections, the ingress, and the messaging tools. */
export async function composeChannels(composed: OauthContext) {
  const {
    disabledBuiltins,
    access,
    clock,
    folderPromotion,
    hasModelTransport,
    late,
    logger,
    mcpHost,
    oauthBroker,
    oauthCallbacks,
    oauthFlows,
    overrides,
    pairings,
    persistencePort,
    refreshPeople,
    roomInvitations,
    secrets,
    tools,
  } = composed;
  let { options } = composed;
  const messaging = createMessagingService(persistencePort, {
    now: () => clock.now(),
    pairing: pairings,
    // The room policy, from each channel's descriptor.
    groupPolicyOf: (connectionId) => channelDescriptorOf(messaging.providerOf(connectionId))?.groups,
    operatorOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
    onRoomNotice: (notice) => roomInvitations.notice(notice),
    ...(overrides.messagingFloodLimits === undefined ? {} : { floodLimits: overrides.messagingFloodLimits }),
    accessToken: (connection) => oauthBroker.accessToken(connection),
    hiddenCredential: isSignInSecret,
    readSecret: (reference) => secrets.getSecret(reference),
    // What each channel takes in as attachments, from its descriptor.
    mediaPolicyOf: (connectionId) => channelDescriptorOf(messaging.providerOf(connectionId))?.media,
    senderOf: (connectionId) => channelDescriptorOf(messaging.providerOf(connectionId))?.sender,
    // Each connection's send pace, from its descriptor.
    sendRateOf: (connectionId) => channelDescriptorOf(messaging.providerOf(connectionId))?.sendRate,
    admit: async (input) => {
      // Done and Snooze under a reminder need no model, so they are
      // handled before admission, which an owner without one never opens.
      if (input.event.kind === "interaction" && (await late.reminderButtons.handleInteraction(input))) return;
      if (input.event.kind === "interaction" && (await late.heartbeatButtons.handleInteraction(input))) return;
      // A memory card's Keep, Discard, Undo and Open, likewise.
      if (input.event.kind === "interaction" && (await late.memoryChannelCards.handleInteraction(input))) return;
      // The sender's binding was just read: a person allowed since the last read acts from this message on.
      await refreshPeople([input.actor.workspaceId]);
      await late.messagingAdmitImpl?.(input);
    },
    // So a replay can say "admission is closed" rather than reporting a success
    // that never admitted anything. `ingest` keeps its no-op behaviour:
    // a fresh message must be held, not rejected into an endless provider retry.
    // A reminder's button press is always handled, as above.
    admissionOpen: (event) =>
      late.messagingAdmitImpl !== undefined || isReminderPress(event) || isHeartbeatPress(event) || isMemoryPress(event),
    // A message a schedule's email trigger takes fires that schedule, and is not also a conversation's.
    takeMessage: (event) => late.scheduleEmailTriggers?.(event) ?? Promise.resolve(undefined),
    // A bound person's mail the provider could not verify is held.
    // They hear why at most once a day per connection: the effect id
    // is the day, so the outbox answers a repeat with the first send's outcome.
    onUnverified: async ({ event, actor }) => {
      const destination = messaging.buildReplyDestination(event.connectionId, {
        externalConversationId: event.externalConversationId,
        externalSenderId: event.externalSenderId,
        ...(event.subject === undefined || event.subject.trim() === "" ? {} : { subject: event.subject }),
        ...(event.externalMessageId === undefined ? {} : { externalMessageId: event.externalMessageId }),
      });
      if (destination === undefined) return;
      const sender = sha256Hex(event.externalSenderId).slice(0, 16);
      await messaging.send({
        effectId: `unverified:${event.connectionId}:${sender}:${clock.now().slice(0, 10)}`,
        connectionId: event.connectionId,
        workspaceId: actor.workspaceId,
        destination,
        parts: [
          {
            content:
              "Your message arrived, but it could not be verified as coming from you (its sender authentication did not pass), so it was not acted on. If your mail provider is set up correctly this was not you; otherwise ask the operator to trust your unverified mail in Allowed people.",
          },
        ],
      });
    },
  });
  late.messaging = messaging;
  /**
   * Every connection's provider this data directory has recorded, kept current
   * as conversations are recorded: what names a connection that is not open
   * (now) the same way the offline reader does.
   */
  const recordedProviders = new Map(await recordedConnectionProviders(persistencePort.repositories));
  /**
   * A send target in its channel's own form, or
   * `undefined` when it is not one there. A connection whose channel no
   * descriptor names (the local one, or one not open) takes it as given; its
   * send then fails on its own terms.
   */
  const channelTarget = (connectionId: string, to: string): string | undefined => {
    const descriptor = channelDescriptorOf(messaging.providerOf(connectionId));
    return descriptor === undefined ? to : channelIdentity(to, descriptor.target);
  };
  /** What a conversation is recorded with: its connection's provider and its own kind. */
  const providerAndKind = (event: InboundEvent): Pick<MessagingConversationTask, "providerId" | "conversationKind"> => {
    const providerId = messaging.providerOf(event.connectionId);
    if (providerId !== undefined) recordedProviders.set(event.connectionId, providerId);
    return {
      ...(providerId === undefined ? {} : { providerId }),
      ...(event.conversationKind === undefined ? {} : { conversationKind: event.conversationKind }),
    };
  };
  /**
   * Installs a channel: a plugin's joins the catalog (a
   * builtin's is in it already) and its connector the messaging service. The
   * function returned withdraws it.
   */
  const installChannel = (
    descriptor: ChannelDescriptor,
    definition: MessagingConnectorDefinition,
    trust: "builtin" | { readonly pluginId: string; readonly version: string; readonly mailbox?: ChannelMailboxKit<typeof fetch> },
  ): (() => Promise<void>) => {
    // A built-in channel's descriptor is held from composition (`builtinDescriptors` below); a plugin's joins now.
    if (trust !== "builtin") registerChannelDescriptor(descriptor, trust.pluginId, trust.mailbox, trust.version);
    try {
      messaging.registerConnector(definition);
    } catch (error) {
      if (trust !== "builtin") unregisterChannelDescriptor(descriptor.providerId);
      throw error;
    }
    return async () => {
      await messaging.unregisterConnector(descriptor.providerId);
      if (trust !== "builtin") unregisterChannelDescriptor(descriptor.providerId);
    };
  };
  /**
   * How a channel's file part becomes bytes is decided here, not in
   * a connector, because it depends on the artifact store:
   *
   * * `approved` only — the same rule `tavi reports open` applies to the same
   *   bytes: a `pending` artifact (the 64 KiB tool-output archive above all) is
   *   precisely what the review gate exists to hold back from release.
   * * the *requesting* workspace — `artifactId` is a model-authored tool
   *   argument, so without this a model could name another workspace's
   *   document by id and have it delivered: an exfiltration path needing no
   *   credential and no allowlisted host.
   *
   * The size check comes before the read on purpose: `readArtifactBody` is a
   * full read, so comparing after it would allocate an unbounded buffer only to
   * reject it. The connector's own gate stays as defence in depth.
   */
  const readChannelArtifact: ChannelHostServices<typeof fetch>["readArtifact"] = async (artifactId, workspaceId, maxBytes) => {
    const record = await persistencePort.repositories.artifacts.getArtifact(artifactId);
    // A browser thumbnail is internal: never delivered.
    if (record === undefined || !isModelVisibleArtifact(record) || record.workspaceId !== workspaceId || record.reviewState !== "approved")
      return undefined;
    if (record.byteSize > maxBytes) return undefined;
    const bytes = await persistencePort.repositories.artifacts.readArtifactBody(artifactId);
    return bytes === undefined ? undefined : { bytes, contentType: record.contentType };
  };
  /**
   * The services a channel's connector gets, builtin or a plugin's:
   * its own `fetch` override in tests, else the global one, looked up at each
   * call as a connector's own default would.
   */
  const channelServices = (providerIds: readonly string[]): ChannelHostServices<typeof fetch> => ({
    now: () => clock.now(),
    fetch:
      providerIds.map((providerId) => overrides.channelFetch?.[providerId]).find((fetch) => fetch !== undefined) ??
      ((input, init) => globalThis.fetch(input, init)),
    readArtifact: readChannelArtifact,
  });
  /**
   * The built-in channels whose plugins are enabled, named from composition on, so what composition reads of a
   * channel (an allowlist entry's target, a connection's credential) knows them before their plugins start. Each is
   * released when its plugin stops, or when the owner closes (`releaseBuiltinChannels`); a disabled one is never named.
   */
  // Which channel plugin each shared provider's client is bound to, before anything asks a channel's grants.
  setSharedClientBindings(parseSharedClients(await composed.store.getMeta(CHANNELS_SHARED_CLIENTS_SETTING)));
  const builtinDescriptors = new Map<string, () => void>();
  const releaseBuiltinChannels = (): void => {
    for (const release of builtinDescriptors.values()) release();
    builtinDescriptors.clear();
  };
  // Set before the first hold is taken: a registration that fails leaves the ones before it to release.
  late.releaseBuiltinChannels = releaseBuiltinChannels;
  for (const channel of BUILTIN_CHANNELS)
    if (!disabledBuiltins.has(channel.pluginId))
      builtinDescriptors.set(channel.pluginId, registerBuiltinChannelDescriptor(channel.descriptor));
  /**
   * A built-in channel, as its plugin (`tavi.telegram`, …) starts: through the same installation a channel plugin's
   * goes through, with builtin trust. The function returned withdraws it, and its descriptor.
   */
  const installBuiltinChannel = (channel: BuiltinChannel): (() => Promise<void>) => {
    const withdraw = installChannel(channel.descriptor, channel.connector(channelServices([channel.descriptor.providerId])), "builtin");
    return async () => {
      await withdraw();
      builtinDescriptors.get(channel.pluginId)?.();
      builtinDescriptors.delete(channel.pluginId);
    };
  };
  // Every messaging connection this owner opens, saved in Settings → Channels,
  // opened by `tavi.channelhost` once the channel plugins installed their channels.
  const channels = new ChannelHost({
    messaging,
    connections: persistencePort.repositories.messagingConnections,
    workspaceIds: options.openSavedChannels === true ? options.workspaces.map((grant) => grant.workspaceId) : [],
    descriptorOf: channelDescriptorOf,
    log: logger,
    now: () => clock.now(),
    ...(options.messagingOpenAttempts === undefined ? {} : { openAttempts: options.messagingOpenAttempts }),
  });
  await channels.load();
  options = withChannelDestinations(options, channels);
  // `hasModelTransport` false means no admission will ever run: a connector
  // configured with no model connection records inbound messages forever, and
  // nothing else would otherwise signal that to an operator.
  if (!hasModelTransport && channels.configured().some((record) => record.enabled)) {
    logger.warn(
      "messaging connector configured with no model provider connection; inbound messages will be recorded but never admitted to a task",
    );
  }
  // One replay cache and one set of rate limits for every handler and the schedules' webhooks: a new public address
  // forgets no signature seen.
  const ingressGuards = createIngressGuards({ now: () => clock.now() });
  /**
   * The channels' webhook ingress: one listener for
   * every connection whose channel receives webhooks, and for approval
   * emails' confirmation pages. It listens while such a connection is
   * open, where the saved ingress settings say, and moves when they change.
   */
  const ingress = (() => {
    let listening: { readonly server: Server; readonly host: string; readonly port: number } | undefined;
    let current: ChannelIngressSettings = DEFAULT_CHANNEL_INGRESS;
    /** What the listener answers with: rebuilt when the public address changes, without moving the listener. */
    let handle: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
    let built: string | undefined;
    let queue: Promise<void> = Promise.resolve();
    /** The settings in effect: the saved ones, else the default. */
    const settings = async (): Promise<ChannelIngressSettings> =>
      (await persistencePort.repositories.channelIngress.get()) ?? DEFAULT_CHANNEL_INGRESS;
    const receiving = (): readonly ChannelView[] =>
      channels.list().filter((view) => view.status.state === "running" && (channelDescriptorOf(view.providerId)?.ingress?.length ?? 0) > 0);
    /** Answers `<prefix>/oauth/callback`: a sign-in coming back through the public address. */
    /** Decided before anything is awaited, so any other request reaches the ingress as it came. */
    const isOAuthCallback = (req: IncomingMessage, publicUrl: string | undefined): boolean => {
      if (req.method !== "GET") return false;
      const path = new URL(req.url ?? "/", "http://ingress.invalid").pathname;
      const prefix = publicUrl === undefined ? "" : new URL(publicUrl).pathname.replace(/\/+$/, "");
      return path === "/oauth/callback" || path === `${prefix}/oauth/callback`;
    };
    /** An MCP authorization server reading Tavi's CIMD document: only with a public https address. */
    const isClientMetadata = (req: IncomingMessage, publicUrl: string | undefined): boolean => {
      if (req.method !== "GET" || publicUrl?.startsWith("https://") !== true) return false;
      const path = new URL(req.url ?? "/", "http://ingress.invalid").pathname;
      const prefix = new URL(publicUrl).pathname.replace(/\/+$/, "");
      return path === `${prefix}${MCP_CLIENT_METADATA_PATH}`;
    };
    const clientMetadataAt = async (res: ServerResponse, publicUrl: string | undefined): Promise<boolean> => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(clientMetadataDocument(publicUrl ?? "")));
      return true;
    };
    const oauthCallbackAt = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const url = new URL(req.url ?? "/", "http://ingress.invalid");
      // Bounded as the bridge's and the CLI's callbacks are: a longer state is no flow's, a longer code no provider's.
      const state = url.searchParams.get("state")?.slice(0, 128) ?? null;
      const code = url.searchParams.get("code")?.slice(0, 4096) ?? null;
      const error = url.searchParams.get("error")?.slice(0, 256) ?? null;
      const iss = url.searchParams.get("iss");
      const page = oauthCallbackPage(
        state === null
          ? { ok: false, message: "This sign-in link is no longer valid." }
          : await oauthCallbacks.callback({
              state,
              ...(code === null ? {} : { code }),
              ...(error === null ? {} : { error }),
              ...(iss === null ? {} : { iss: iss.slice(0, 512) }),
            }),
      );
      res.writeHead(page.status, page.headers);
      res.end(page.body);
      return true;
    };
    /** The request handler for a public address: its path prefix, and the approval links under it. */
    const handlerFor = (publicUrl: string | undefined) => {
      const prefix = publicUrl === undefined ? undefined : new URL(publicUrl).pathname.replace(/\/+$/, "");
      const links = createApprovalLinkHandler(late.channelApprovals, { ...(publicUrl === undefined ? {} : { publicUrl }) });
      return createChannelIngress({
        messaging,
        guards: ingressGuards,
        descriptorOf: channelDescriptorOf,
        ...(prefix === undefined ? {} : { pathPrefix: prefix }),
        // An OAuth sign-in that comes back through the public address, a schedule's webhook, then the approval links.
        before: (req, res) =>
          isOAuthCallback(req, publicUrl)
            ? oauthCallbackAt(req, res)
            : isClientMetadata(req, publicUrl)
              ? clientMetadataAt(res, publicUrl)
              : late.scheduleWebhooks !== undefined && isScheduleWebhookPath(req.url ?? "/", prefix)
                ? late.scheduleWebhooks(req, res, prefix)
                : links(req, res),
        now: () => clock.now(),
        log: logger,
      });
    };
    const closeNow = async (): Promise<void> => {
      const open = listening;
      listening = undefined;
      if (open !== undefined)
        await new Promise<void>((resolve, reject) => open.server.close((error) => (error === undefined ? resolve() : reject(error))));
    };
    /** One change at a time: two reloads never both start a listener. */
    const serial = (work: () => Promise<void>): Promise<void> => {
      const run = queue.then(work);
      // Ordering only: the work's own failure reaches its caller through the promise it was handed.
      queue = run.catch(() => undefined);
      return run;
    };
    return {
      /** The public address in effect, for approval links. */
      publicUrl: (): string | undefined => current.publicUrl,
      /** The public address the settings name now, whether or not the listener is up (an MCP login's redirect). */
      configuredPublicUrl: async (): Promise<string | undefined> => (await settings()).publicUrl,
      close: (): Promise<void> => serial(closeNow),
      /** Listens if a receiving connection is open, where the settings say; closes if none is. */
      ensure: (): Promise<void> =>
        serial(async () => {
          current = await settings();
          // The proxies whose X-Forwarded-For names the caller, for schedule webhooks as well as channels.
          ingressGuards.trustedProxies.set(parseTrustedProxies(await composed.store.getMeta(CHANNELS_INGRESS_TRUSTED_PROXIES_SETTING)));
          // The schedules whose webhook is on, reloaded at the owner's start and after each webhook change: a call is
          // looked up only for these, whether the listener is open for them or for a channel.
          const webhooks =
            late.scheduleWebhookIds === undefined
              ? await persistencePort.repositories.schedules.hasWebhooks()
              : (await late.scheduleWebhookIds.load()) > 0;
          // Open while a channel receives, a sign-in waits, an MCP server's sign-in names Tavi by its public client
          // document, which its authorization server may read again at a refresh, or a schedule's webhook is on.
          if (
            receiving().length === 0 &&
            !oauthFlows.waitingPublic() &&
            !mcpHost.oauth.logins.waitingPublic() &&
            !(await mcpHost.oauth.publicClientInUse()) &&
            !webhooks
          )
            return closeNow();
          if (handle === undefined || built !== current.publicUrl) {
            handle = handlerFor(current.publicUrl);
            built = current.publicUrl;
          }
          if (listening !== undefined && listening.host === current.host && listening.port === current.port) return;
          await closeNow();
          const listener: RequestListener = (req, res) => {
            void (handle ?? (async () => {}))(req, res).catch((error: unknown) => {
              logger.error("ingress: request failed", { error });
              if (!res.headersSent) res.statusCode = 500;
              res.end();
            });
          };
          const server = (overrides.ingressCreateServerOverride ?? createServer)(listener);
          // Slow headers and bodies cut off, and connections capped, in all and per address (a trusted proxy's in all only):
          // schedule webhooks' as well as channels'.
          applyIngressServerLimits(server, ingressGuards.trustedProxies.trusts);
          const { host, port } = current;
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, host, () => {
              server.removeListener("error", reject);
              resolve();
            });
          });
          listening = { server, host, port };
          logger.info("channel ingress listening", { host, port });
        }),
    };
  })();
  late.ingress = ingress;
  // The local connections: opened by
  // `tavi.localmessaging` below, one per workspace, and kept here so the
  // owner's IPC `reply` can hand them a message.
  const localInstances = new Map<string, LocalConnectorInstance>();
  messaging.registerConnector(
    createLocalConnectorDefinition({ onInstanceCreated: (connectionId, instance) => localInstances.set(connectionId, instance) }),
  );
  const localMessaging: LocalMessaging = {
    connectionFor: (workspaceId) => {
      const connectionId = localConnectionId(workspaceId);
      return localInstances.get(connectionId)?.status().state === "running" ? connectionId : undefined;
    },
    deliver: (workspaceId, event, hooks) => {
      const connectionId = localConnectionId(workspaceId);
      const instance = localInstances.get(connectionId);
      if (instance === undefined)
        return Promise.reject(new TaviError("UNAVAILABLE", `workspace ${workspaceId} has no local connection open`));
      return instance.deliver({ ...event, connectionId }, hooks);
    },
  };
  // `messaging.send`: registered unconditionally,
  // matching `sandbox.run`/`browser.*`'s own "register regardless, fail
  // closed if unconfigured" precedent — a task not admitted from a
  // message simply never has `context.messagingReplyTo` set, so the tool
  // itself refuses rather than needing conditional registration here.
  //
  // `messaging.send_to`'s destination allowlist is
  // operator configuration with the same deny-by-default shape as
  // `httpAllowedHosts`: unset refuses every destination, so a runtime nobody
  // configured cannot be talked into sending the report somewhere by a
  // model-authored chat id.
  //
  // The entries are parsed once, here, for the same reason `assertHostEntries`
  // validates the host allowlist: an entry the matcher can never accept would
  // fail closed and silently, and an ambiguity an operator cannot see (a
  // `chatId` reachable through a second connector) is best
  // resolved at startup. The same predicate serves `operator.ask_user`'s
  // no-inbound-conversation branch below, which also sends to a model-authored
  // destination.
  const messagingConnectionIds = externalConnectionsOf(channels).map((connection) => connection.connectionId);
  // The local connections own their prefix: another connection under it would
  // be taken for one — refused as a destination, spared keyword decisions.
  for (const connectionId of messagingConnectionIds) {
    if (isLocalConnectionId(connectionId)) {
      throw new TaviError(
        "INVALID_INPUT",
        `connection id ${connectionId} is reserved: \`${LOCAL_CONNECTION_PREFIX}\` names the owner's local connections`,
      );
    }
  }
  const messagingAllowedDestinations = assertDestinationEntries(
    options.messagingAllowedDestinations ?? [],
    messagingConnectionIds,
    "--messaging-allow-destination",
    channelDescriptors().map((descriptor) => descriptor.providerId),
  );
  /** The connection ids a bare allowlist entry is judged against: what is configured now, Settings saves included. */
  const currentConnectionIds = (): readonly string[] => externalConnectionsOf(channels).map((connection) => connection.connectionId);
  /**
   * A connection's channel and a target in its form, for the allowlist's
   * `providerId:*` and `*:chatId` — from its configured
   * record, so a connection not open yet is still known by its channel.
   */
  const destinationChannels: DestinationChannels = {
    providerOf: (connectionId) =>
      channels.configured().find((record) => record.connectionId === connectionId)?.providerId ?? messaging.providerOf(connectionId),
    targetOf: (connectionId, to) => {
      const descriptor = channelDescriptorOf(destinationChannels.providerOf(connectionId));
      return descriptor === undefined ? to : channelIdentity(to, descriptor.target);
    },
  };
  /**
   * The connections a workspace can send through now:
   * open, with a channel the catalog names, and the targets the allowlist
   * gives each. What the agent is told, in its runtime facts and by
   * `messaging.channels`.
   */
  const reachableChannels = (workspaceId: string): readonly ReachableChannel[] => {
    const connectionIds = currentConnectionIds();
    return channels.list().flatMap((view) => {
      const descriptor = channelDescriptorOf(view.providerId);
      const capabilities = messaging.capabilitiesOf(view.connectionId);
      if (
        view.workspaceId !== workspaceId ||
        view.status.state !== "running" ||
        descriptor === undefined ||
        capabilities === undefined ||
        !capabilities.send
      )
        return [];
      return [
        {
          connectionId: view.connectionId,
          label: view.label,
          channel: descriptor.label,
          kind: descriptor.kind,
          target: descriptor.target.label,
          buttons: capabilities.interactions,
          files: capabilities.attachments,
          maxTextLength: capabilities.maxTextLength,
          allowedTargets: allowedTargetsOf(view.connectionId, messagingAllowedDestinations, connectionIds, destinationChannels),
        },
      ];
    });
  };
  const channelReplyRelay = createChannelReplyRelay({
    repositories: persistencePort.repositories,
    messaging,
    isLocalConnection: isLocalConnectionId,
    warn: (message, fields) => logger.warn(message, fields),
  });
  registerMessagingTools(tools, messaging, (prefix) => clock.newId(prefix), {
    allowedDestinations: messagingAllowedDestinations,
    connectionIds: currentConnectionIds,
    targetOf: channelTarget,
    providerOf: destinationChannels.providerOf,
    reachable: reachableChannels,
    promotion: folderPromotion,
    // The workspace's bound people, by name: only those the allowlist already reaches.
    bindings: persistencePort.repositories.messagingIdentityBindings,
  });
  // The neutral group tools: offered where a workspace's open channel has the feature.
  registerGroupTools(tools, messaging, {
    newId: (prefix) => clock.newId(prefix),
    now: () => clock.now(),
    repositories: persistencePort.repositories,
    // `messaging.recent` reads only a room the operator set to `context: "recent"`.
    rooms: persistencePort.repositories.channelRooms,
    // A channel turn's own connection decides; outside one — a routine's grant, a listing — any of the workspace's.
    // A turn no channel message started (Home, the terminal, the canvas) has no room to post in: not offered; nor is a
    // one-to-one turn (`messagingConversationKind`), which `registerGroupTools` refuses before asking here.
    offeredIn: (context, feature) =>
      context.outsideConversation !== true &&
      channels
        .configured()
        .some(
          (record) =>
            record.enabled &&
            record.workspaceId === context.workspaceId &&
            (context.messagingConnectionId === undefined || record.connectionId === context.messagingConnectionId) &&
            messaging.capabilitiesOf(record.connectionId)?.groups?.[feature] !== undefined,
        ),
  });
  return {
    channelReplyRelay,
    channelServices,
    channelTarget,
    channels,
    currentConnectionIds,
    destinationChannels,
    ingress,
    ingressGuards,
    installBuiltinChannel,
    installChannel,
    releaseBuiltinChannels,
    localInstances,
    localMessaging,
    messaging,
    messagingAllowedDestinations,
    options,
    providerAndKind,
    reachableChannels,
    recordedProviders,
  };
}

export type ChannelsContext = OauthContext & Awaited<ReturnType<typeof composeChannels>>;
