import {
  TaviError,
  normalizeChannelIdentity,
  type ChannelEventInput,
  type ChannelRoomListing,
  type ChannelGroupPolicy,
  type ChannelPollInput,
  type ChannelPollState,
  senderAuthenticationAdmits,
  type ChannelNormalization,
  type DeliveryEvent,
  type InboundEvent,
  type MemoryActor,
  type MessagingCapabilities,
  type MessagingConnection,
  type MessagingConnectionStatus,
  type MessagingCredentials,
  type MessagingIngress,
  type IngressContext,
  type MessagingConnectorDefinition,
  type MessagingConnectorInstance,
  type MessagingIngestHooks,
  type MessagingIngestReceipt,
  type MessagingProbeResult,
  type RecentRoomMessage,
  type MessagingReplayOutcome,
  type MessagingServicePort,
  type MessagingTarget,
  type OutboundButton,
  type OutboundMessage,
  type PersistencePort,
  type SendOutcome,
  type SendOutcomePartReceipt,
  withoutControls,
} from "@tavi/contracts";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
import { sleep } from "@tavi/node-kit";
import { createRoomPolicy, type FloodLimits, type RoomNotice } from "./room-policy.js";
import { senderActorFromBinding } from "./identity.js";
import { takeInMedia, type MediaPolicy } from "./media-intake.js";
import { createSendPacer, type SendRate } from "./send-pacer.js";
import type { PairingRegistry } from "./pairing.js";

/** How often a send the provider asked to slow down is tried again, and the longest wait taken for it. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;
/** The longest a provider's wait holds a connection's other sends. */
const RATE_LIMIT_MAX_BACKOFF_MS = 10 * 60_000;
const LAST_ERROR_MAX = 300;
import { splitMessage } from "./split-text.js";

/**
 * The one trusted messaging service. Owns connector registration,
 * connection lifecycle, and durable inbound/outbound state; provider plugins never touch the model/agent
 * directly and never bypass this service to deliver an event or send a
 * message. Mirrors `MemoryService`'s relationship to
 * `MemoryRepositoryPort` — one trusted service, a replaceable
 * repository/provider underneath — by taking a `PersistencePort` rather
 * than a concrete store.
 *
 * What this service does and does not do:
 *
 *  - **Credential resolution**: `openConnection` passes `credentials`
 *    to `createConnection`, answering the connection's own secret fields
 *    through `MessagingServiceOptions.readSecret` below, which the
 *    composition root supplies from its own `SecretStorePort` chain, the same pattern
 *    `createAiSdkModelAdapter`'s `readSecret` option uses for model
 *    credentials — the default (unset) resolves `null`, so a caller that
 *    configures no real connector (the fixture, or any connector this
 *    option isn't wired for) gets no credential.
 *  - **`recordDelivery`** correlates a provider's delivery, read, bounce or
 *    failure status with the send it names, by the message id each part was
 *    accepted under; a status never goes
 *    back, and one for a message this owner did not send records nothing.
 *  - **`OutboundMessage.destination` validation**: deliberately typed
 *    `unknown` in the contract ("validated by the connector's own
 *    configSchema-adjacent addressing rules"). `send()` here performs no
 *    shape-checking of `destination` at all before handing it to
 *    `entry.instance.send` — that is left to each connector.
 */

export interface MessagingServiceOptions {
  readonly now?: () => string;
  /**
   * A channel's group policy, from its descriptor: with it, `ingest` puts
   * each of the channel's events through the room policy before anything of it is fetched or recorded. Absent, or
   * undefined for a connection: no room policy, as before the seam.
   */
  readonly groupPolicyOf?: (connectionId: string) => ChannelGroupPolicy | undefined;
  /** A workspace's operator, for a room only its operator may speak in. */
  readonly operatorOf?: (workspaceId: string) => string | undefined;
  /** The room policy's flood bounds; defaults to `DEFAULT_FLOOD_LIMITS`. */
  readonly floodLimits?: FloodLimits;
  /**
   * Told when the agent is added to or removed from a room, when an unlisted
   * room speaks (once a day per room), and on a room's first flood drop (at
   * most once an hour). Contained: a failure here drops nothing more.
   */
  readonly onRoomNotice?: (notice: { readonly kind: RoomNotice; readonly event: InboundEvent }) => void | Promise<void>;
  /**
   * Checked before any `connector.send` call — a denied operation makes no
   * call. Defaults to always-granted, matching how a caller with no grant model
   * configured gets today's (pre-messaging) unrestricted behavior rather
   * than a surprising new default-deny.
   */
  readonly hasGrant?: (message: OutboundMessage) => boolean;
  /**
   * Resolves a connection's `credentialRef` to a real secret value for a
   * real connector's `createConnection`. Defaults to always resolving
   * `null` — safe for the fixture connector
   * (which never has a `credentialRef` bound) and for any connector that
   * isn't wired to a real `SecretStorePort` yet.
   */
  readonly readSecret?: (reference: string) => Promise<string | null>;
  /**
   * Admits a workflow turn for a newly-recorded inbound event whose
   * sender resolved to a real actor — the
   * conversation-continuity/task-admission logic itself (start vs. reply,
   * recording the `(connectionId, externalConversationId)` → `taskId`
   * mapping) lives in the composition root's real implementation of this
   * callback, not here: `MessagingService` (`packages/runtime`) must not
   * import `@tavi/agent-host`' `WorkflowPort` implementation directly, so this
   * is an injected callback, architecturally identical to
   * `AgentCommunicationServiceOptions.workflow`/`.cancelTask`
   * (`packages/agent-host/src/agents/agent-communication.ts`). Defaults to a no-op,
   * matching `readSecret`/`hasGrant`'s "safe default when unset"
   * precedent — `ingest()`'s behavior (record + resolve identity, nothing
   * more) is unchanged when this is omitted. Never called for an unbound
   * sender (`actor` is only ever a real, resolved `MemoryActor`) or for a
   * duplicate/redelivered event (only a genuinely new event admits a
   * turn).
   */
  readonly admit?: (input: { readonly event: InboundEvent; readonly actor: MemoryActor }) => Promise<void>;
  /**
   * What a connection's channel takes in as attachments (its descriptor's
   * `media`); absent, or answering nothing, an event's
   * media are all skipped with a note.
   */
  readonly mediaPolicyOf?: (connectionId: string) => MediaPolicy | undefined;
  /**
   * What a connection's senders are, from its descriptor:
   * how an id is written, so a sender is looked up as a binding names it, and
   * whether each message carries its own proof — on such a channel one that
   * says nothing of it is unverified, never admitted.
   */
  readonly senderOf?: (
    connectionId: string,
  ) => { readonly normalize: ChannelNormalization; readonly authentication: "provider" | "per-message" } | undefined;
  /** A connection's send pace (its descriptor's `sendRate`); absent, sends are not paced. */
  readonly sendRateOf?: (connectionId: string) => SendRate | undefined;
  /** How a paced send waits; a timer unless a test gives another. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** A connection's OAuth access token, from the host's broker; absent, none is. */
  readonly accessToken?: (connection: MessagingConnection) => Promise<string>;
  /** Credential references a connector is never given: its OAuth app's and its refresh token's. */
  readonly hiddenCredential?: (reference: string) => boolean;
  /** Pairing codes a message from a sender nobody allowed yet may carry. */
  readonly pairing?: Pick<PairingRegistry, "claim">;
  /**
   * Whether admission is actually open, for `replay`.
   *
   * Composition always supplies an `admit` wrapper, and that wrapper is a no-op
   * when the deployment has no model transport — deliberately, because a
   * *fresh* message must be held rather than rejected into an endless provider
   * retry. A replay is different: the operator asked for it, so it must report
   * `admission-closed` instead of claiming a success that never admitted
   * anything and marking the row processed. Asked about the held event, since
   * some events (a reminder's button press) are handled without a model.
   */
  readonly admissionOpen?: (event: InboundEvent) => boolean;
  /**
   * Told about a new message from a bound sender that the provider could not
   * verify as theirs (`MessagingIngestReceipt.unverified`), which is held
   * rather than admitted — composition answers the sender once a day, so a
   * real person with a broken mail setup learns why nothing happened.
   * Best effort: a throw is contained and never unrecords the event.
   */
  readonly onUnverified?: (input: { readonly event: InboundEvent; readonly actor: MemoryActor }) => Promise<void>;
  /**
   * Offered each new message once it is recorded, before its sender's
   * binding admits anything, and held while it decides, so a redelivery
   * meanwhile admits nothing: what it fires when it took the message (a
   * schedule's email trigger did). A taken message is marked processed
   * first, and never admitted, held or answered as a conversation's; its
   * fire runs after, contained and never waited on. Any other message
   * (`undefined`), or one it throws on, goes on as it would without it.
   */
  readonly takeMessage?: (event: InboundEvent) => Promise<MessageTaken | undefined>;
}

/** A message a trigger took (`MessagingServiceOptions.takeMessage`): what it starts once the message is done with. */
export interface MessageTaken {
  readonly fire: () => Promise<void>;
}

interface OpenConnection {
  readonly connection: MessagingConnection;
  readonly instance: MessagingConnectorInstance;
  readonly credentials: MessagingCredentials;
  closing?: boolean;
  /** Sends in the connector now; a close waits for them. */
  inFlight: number;
  readonly idle: (() => void)[];
}

/** How long a close waits for sends in flight, and a send waits for a connection being reopened. */
const REOPEN_WAIT_MS = 30_000;

function timer(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}

/**
 * How long a replay claim is honoured before another replay may take it.
 *
 * Long enough that a slow admission is not stolen, short enough that a crashed
 * replay does not strand the message: after this, the row is claimable again.
 */
const REPLAY_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * A connector's probe answer within what the host keeps and shows: its
 * detail and at most 6 setup lines of 200 characters, and a link that is an
 * https URL. Anything else of it is left out.
 */
function boundedProbe(answer: MessagingProbeResult): MessagingProbeResult {
  const lines = Array.isArray(answer.setup?.lines)
    ? answer.setup.lines
        .filter((line): line is string => typeof line === "string" && line.trim() !== "")
        .slice(0, 6)
        .map((line) => line.slice(0, 200))
    : [];
  const link = answer.setup?.link;
  let url: URL | undefined;
  try {
    url = typeof link?.url === "string" && link.url.length <= 512 ? new URL(link.url) : undefined;
    if (url !== undefined && url.href.length > 512) url = undefined;
  } catch {
    url = undefined;
  }
  const kept =
    url !== undefined && url.protocol === "https:" && typeof link?.label === "string" && link.label.trim() !== ""
      ? { label: link.label.slice(0, 60), url: url.href }
      : undefined;
  return {
    ok: answer.ok === true,
    ...(typeof answer.detail === "string" ? { detail: answer.detail.slice(0, 1000) } : {}),
    ...(lines.length === 0 && kept === undefined ? {} : { setup: { lines, ...(kept === undefined ? {} : { link: kept }) } }),
  };
}
/**
 * How often the agent is shown typing while a message's turn runs: within the
 * 5 s Telegram shows it (Discord shows it for 10 s, and its connector skips an
 * ask that comes sooner than it needs).
 */
const TYPING_EVERY_MS = 4000;

export function createMessagingService(persistence: PersistencePort, options: MessagingServiceOptions = {}): MessagingServicePort {
  const now = options.now ?? nowTimestamp;
  const hasGrant = options.hasGrant ?? ((): boolean => true);
  const readSecret = options.readSecret ?? ((): Promise<string | null> => Promise.resolve(null));
  const definitions = new Map<string, MessagingConnectorDefinition>();
  const openConnections = new Map<string, OpenConnection>();
  const activity = new Map<string, { readonly lastInboundAt?: string; readonly lastSendAt?: string; readonly lastError?: string }>();
  /** Connections closed to be reopened: a send waits on `opened`. */
  const reopens = new Map<string, { readonly opened: Promise<void>; readonly release: () => void }>();
  const pause = options.sleep ?? sleep;
  const pacer = createSendPacer(() => Date.parse(now()), pause);
  const groupPolicyOf = options.groupPolicyOf;
  const roomPolicy =
    groupPolicyOf === undefined
      ? undefined
      : createRoomPolicy({
          repositories: persistence.repositories,
          groupPolicyOf,
          ...(options.operatorOf === undefined ? {} : { operatorOf: options.operatorOf }),
          now: () => Date.parse(now()),
          ...(options.floodLimits === undefined ? {} : { limits: options.floodLimits }),
        });

  function registerConnector(definition: MessagingConnectorDefinition): void {
    if (definitions.has(definition.providerId)) {
      throw new TaviError("DUPLICATE", `Messaging connector for provider ${definition.providerId} is already registered`);
    }
    definitions.set(definition.providerId, definition);
  }

  async function openConnection(input: { readonly connection: MessagingConnection; readonly config: unknown }): Promise<void> {
    if (openConnections.has(input.connection.connectionId)) {
      throw new TaviError("DUPLICATE", `Connection ${input.connection.connectionId} is already open`);
    }
    const definition = definitions.get(input.connection.providerId);
    if (definition === undefined) {
      throw new TaviError("NOT_FOUND", `No messaging connector registered for provider ${input.connection.providerId}`);
    }
    const parsedConfig = definition.configSchema.safeParse(input.config);
    if (!parsedConfig.success) {
      throw new TaviError("INVALID_INPUT", `Invalid configuration for connection ${input.connection.connectionId}`, {
        details: { issues: parsedConfig.error.issues.map((issue) => issue.message) },
      });
    }
    const connection = input.connection;
    // A connector reads its own secrets, never the OAuth token's store nor its app: it asks for an access token.
    const hidden = (reference: string): boolean =>
      reference === connection.credentialRefs?.["oauth"] || options.hiddenCredential?.(reference) === true;
    // Its own secrets only: another connection's, a model's or a plugin's are never a channel's to read.
    const own = new Set([
      ...Object.values(connection.credentialRefs ?? {}),
      ...(connection.credentialRef === undefined ? [] : [connection.credentialRef]),
    ]);
    const connectorCredential = async (reference: string): Promise<string | null> => {
      if (hidden(reference))
        throw new TaviError(
          "NOT_AUTHORIZED",
          "A channel reads its access token through credentials.accessToken(), never its sign-in's own secrets",
        );
      if (!own.has(reference)) throw new TaviError("NOT_AUTHORIZED", `Connection ${connection.connectionId} reads only its own secrets`);
      return readSecret(reference);
    };
    const credentials: MessagingCredentials = {
      get: async (key) => {
        const reference = connection.credentialRefs?.[key];
        return reference === undefined ? null : connectorCredential(reference);
      },
      accessToken: () =>
        options.accessToken?.(connection) ??
        Promise.reject(new TaviError("NOT_CONFIGURED", `Connection ${connection.connectionId} has no OAuth token`)),
    };
    const instance = definition.createConnection({
      connection,
      config: parsedConfig.data,
      credentials,
    });
    // Registered before `start()`, so a connector that begins receiving as it
    // starts (Telegram's poll loop) can never deliver into an unset handler.
    // Until this existed nothing registered one at all, and Telegram's loop
    // treated each update as handled and advanced past it — every inbound chat
    // message was acknowledged and lost. The rejection is deliberately not
    // caught: a connector keys its acknowledgement on this promise (Telegram
    // leaves the poll offset in place), so a failed `ingest` gets redelivered,
    // and `ingest`'s own dedup makes the redelivery safe. Mailgun implements
    // this as a no-op; its webhook calls `ingest` directly.
    instance.onInboundEvent?.(async (event, hooks) => {
      // Bindings and the inbox are keyed by connection, so a connector must not
      // be able to deliver on another connection's behalf.
      if (event.connectionId !== input.connection.connectionId) {
        throw new TaviError(
          "INVALID_INPUT",
          `Connection ${input.connection.connectionId} delivered an event for connection ${event.connectionId}`,
        );
      }
      return ingest(event, hooks);
    });
    await instance.start();
    openConnections.set(input.connection.connectionId, { connection: input.connection, instance, credentials, inFlight: 0, idle: [] });
    releaseReopen(input.connection.connectionId);
    // A reopened connection's notes are taken again when next read.
    probes.delete(input.connection.connectionId);
  }

  /** Each open connection's last probe, as its connector answered it (bounded: its notes are short), and when. */
  const probes = new Map<string, { readonly answer: MessagingProbeResult; readonly at: number }>();
  /** A kept probe older than this is retaken when it is read: what a connector learns as it runs (or an operator fixes) shows. */
  const PROBE_FRESH_MS = 60_000;
  const probing = new Set<string>();

  /**
   * An open connection's last probe, taken in the background when it is
   * read with none kept, or one over a minute old: nothing calls a provider
   * for it unless someone looks, and the look answers what is kept meanwhile.
   */
  function probeOf(connectionId: string): MessagingProbeResult | undefined {
    const kept = probes.get(connectionId);
    if (
      openConnections.has(connectionId) &&
      (kept === undefined || Date.parse(now()) - kept.at > PROBE_FRESH_MS) &&
      !probing.has(connectionId)
    ) {
      probing.add(connectionId);
      void probe(connectionId).finally(() => probing.delete(connectionId));
    }
    return kept?.answer;
  }

  async function probe(connectionId: string): Promise<MessagingProbeResult | undefined> {
    const entry = openConnections.get(connectionId);
    if (entry === undefined) return undefined;
    let answer: MessagingProbeResult;
    try {
      answer = boundedProbe(await entry.instance.probe());
    } catch (error) {
      answer = { ok: false, detail: errorMessage(error).slice(0, 300) };
    }
    // Kept only while that same connection is open: one closed meanwhile has no probe.
    if (openConnections.get(connectionId) === entry) probes.set(connectionId, { answer, at: Date.parse(now()) });
    return answer;
  }

  /**
   * The event with its attachments taken in: only for
   * a sender allowed and, where the channel checks each message, verified;
   * never for one already recorded, whose redelivery records nothing new.
   */
  async function withMediaTakenIn(event: InboundEvent): Promise<InboundEvent> {
    if (event.media === undefined || event.media.length === 0) return event;
    if ((await persistence.repositories.messagingInbox.get(event.connectionId, event.providerEventId)) !== undefined) {
      const { media: _received, ...recorded } = event;
      return recorded;
    }
    const binding = await persistence.repositories.messagingIdentityBindings.get(event.connectionId, event.externalSenderId);
    return takeInMedia({
      event,
      allowedIn: binding !== undefined && senderAuthenticationAdmits(event, binding) ? binding.workspaceId : undefined,
      policy: options.mediaPolicyOf?.(event.connectionId),
      instance: openConnections.get(event.connectionId)?.instance,
      artifacts: persistence.repositories.artifacts,
    });
  }

  async function unregisterConnector(providerId: string): Promise<boolean> {
    if (!definitions.has(providerId)) return false;
    // Each closed on its own, and the channel withdrawn whatever a connector's stop() did: a failing one must not keep it installed.
    const failures: unknown[] = [];
    for (const [connectionId, entry] of [...openConnections]) {
      if (entry.connection.providerId !== providerId) continue;
      await closeConnection(connectionId).catch((error: unknown) => void failures.push(error));
    }
    definitions.delete(providerId);
    if (failures.length > 0) throw failures[0];
    return true;
  }

  async function closeConnection(connectionId: string, closeOptions: { readonly reopening?: boolean } = {}): Promise<void> {
    if (closeOptions.reopening === true && !reopens.has(connectionId)) {
      let release = (): void => undefined;
      const opened = new Promise<void>((resolve) => {
        release = resolve;
      });
      reopens.set(connectionId, { opened, release });
    }
    const entry = openConnections.get(connectionId);
    if (entry !== undefined) {
      // Await cleanup before reporting successful removal —
      // the map entry is deleted only after `stop()` resolves.
      entry.closing = true;
      // What is already in the connector finishes first, within bounds.
      if (entry.inFlight > 0) await Promise.race([new Promise<void>((resolve) => void entry.idle.push(resolve)), timer(REOPEN_WAIT_MS)]);
      try {
        await entry.instance.stop();
      } finally {
        // Gone even when its stop() failed: left in place, it would be "already open" to every reopen, and its held sends would wait for nothing.
        openConnections.delete(connectionId);
        probes.delete(connectionId);
        if (closeOptions.reopening !== true) releaseReopen(connectionId);
      }
      return;
    }
    if (closeOptions.reopening !== true) releaseReopen(connectionId);
  }

  /** Lets sends held for a reopen go on: to the new connection, or refused for there being none. */
  function releaseReopen(connectionId: string): void {
    reopens.get(connectionId)?.release();
    reopens.delete(connectionId);
  }

  /**
   * The connection a send goes through now: the one it was admitted on, or —
   * when that one is closing to be reopened — the new one, once it is open.
   * A send whose grant was revoked, or whose connection is gone, is refused.
   */
  async function liveEntry(entry: OpenConnection, message: OutboundMessage): Promise<OpenConnection> {
    let current = entry;
    if (current.closing === true || openConnections.get(message.connectionId) !== current) {
      const reopen = reopens.get(message.connectionId);
      if (reopen !== undefined) await Promise.race([reopen.opened, timer(REOPEN_WAIT_MS)]);
      // The reopened connection, whether this send waited for it or it opened while the send waited its turn.
      const fresh = openConnections.get(message.connectionId);
      if (fresh !== undefined && fresh.closing !== true) current = fresh;
    }
    await refuseIfGone(current, message);
    return current;
  }

  async function ingest(given: InboundEvent, hooks?: MessagingIngestHooks): Promise<MessagingIngestReceipt> {
    const read = asItsChannelSays(given);
    // Before its media is fetched or anything of it is recorded: a
    // dropped event leaves no trace but a count, and the connector acknowledges it.
    const verdict = roomPolicy === undefined ? undefined : await roomPolicy.decide(read);
    if (verdict !== undefined && !verdict.admit) {
      if (verdict.notice !== undefined && options.onRoomNotice !== undefined) {
        // Not awaited: a notice may send into the room, and the connector's answer must not wait on that send.
        try {
          const pending: unknown = options.onRoomNotice({ kind: verdict.notice, event: read });
          // Contained, not awaited: the hook reports its own failure; a rejection never unrecords the event or goes unhandled.
          if (pending instanceof Promise) pending.catch(() => undefined);
        } catch {
          // Contained: the drop stands.
        }
      }
      return { accepted: true, duplicate: false, dropped: verdict.reason };
    }
    const event = await withMediaTakenIn(verdict?.autoThread === true ? inItsThread(read) : read);
    // Persist the event/dedup key before acknowledging upstream —
    // `record`'s idempotency by (connectionId, providerEventId) is
    // what makes a duplicate/reordered inbound event a safe no-op rather
    // than double-processed.
    const { created } = await persistence.repositories.messagingInbox.record({
      connectionId: event.connectionId,
      providerEventId: event.providerEventId,
      kind: event.kind,
      payload: event,
      now: { fixed: now() },
    });
    // A provider's word on a message sent earlier: recorded on that send, never a message to admit.
    if (event.kind === "delivery") {
      if (created && event.delivery !== undefined) {
        await recordDelivery({
          connectionId: event.connectionId,
          providerMessageId: event.delivery.providerMessageId,
          status: event.delivery.status,
          occurredAt: event.occurredAt,
          ...(event.delivery.detail === undefined ? {} : { detail: event.delivery.detail }),
        });
      }
      return { accepted: true, duplicate: !created };
    }
    noteActivity(event.connectionId, { lastInboundAt: now() });
    // Identity resolution — durably recorded on every
    // call, not only the first: a sender's binding can change between a
    // duplicate event's original delivery and its redelivery, and this
    // reflects the CURRENT binding state rather than whatever was true
    // the first time this (connectionId, providerEventId) was seen. Never
    // gates `accepted`/`duplicate` — an unbound sender's event is still
    // durably held for an operator to inspect and bind, not dropped.
    const binding = await persistence.repositories.messagingIdentityBindings.get(event.connectionId, event.externalSenderId);
    const actor = senderActorFromBinding(binding, event.connectionId);
    // A bound sender whose message the provider could not verify as theirs
    // (a forged email From) is held, never admitted — unless the operator
    // trusts this person's unverified mail.
    const unverified = actor !== undefined && !senderAuthenticationAdmits(event, binding);
    const receipt: MessagingIngestReceipt = {
      accepted: true,
      duplicate: !created,
      ...(actor === undefined ? {} : { resolvedPrincipalId: actor.principalId }),
      ...(unverified ? { unverified: true as const } : {}),
    };
    // Recorded, so a caller waiting on that alone — the local connection's
    // IPC `reply` — is answered now, while the
    // turn it admits runs below. Its failure is its own: the record stands.
    if (hooks?.onRecorded !== undefined) {
      try {
        // Contained whether it throws or its promise rejects: a broken hook
        // must not unrecord or un-admit the event, nor go unhandled.
        const pending: unknown = hooks.onRecorded(receipt);
        // Contained, not awaited: the hook reports its own failure; a rejection never unrecords the event or goes unhandled.
        if (pending instanceof Promise) pending.catch(() => undefined);
      } catch {
        // Contained, as above.
      }
    }
    // A message a schedule's email trigger took is that trigger's alone: done with before its fire starts, never a
    // conversation's turn.
    if (created && event.kind === "message" && (await takenByTrigger(event))) return receipt;
    // A pairing code from a sender nobody allowed yet claims its pairing, for the operator to confirm; held like
    // any unbound sender's message, never admitted.
    if (created && actor === undefined) options.pairing?.claim(event);
    // Workflow admission — only for a genuinely NEW
    // event (`created`, never a duplicate/redelivery: re-admitting a turn
    // for content already processed would double-process it) whose sender
    // resolved to a real actor (never for an unbound/forged sender — the
    // same denial as above). The event's durable
    // recording above is already complete by the time this runs, so a
    // thrown error here is a genuine admission/workflow failure, not a
    // reason to treat the event itself as unrecorded — deliberately not
    // caught here. This is NOT safe by default: a caller MUST handle a
    // thrown `ingest()` itself (5xx + let the provider retry for a
    // webhook, equivalent for a poll loop) or an uncaught rejection here
    // can crash the whole process — `packages/builtin/mailgun/src/webhook.ts` handles
    // it this way. The other caller is
    // the handler `openConnection` registers, whose connector owns that
    // handling (Telegram's poll loop backs off and leaves its offset
    // unadvanced). Any future caller of `ingest` must do the same.
    //
    // A redelivery of an event still held (`created` false) is admitted
    // below as a replay is — its first admission failed, or its sender was
    // allowed since — under the same claim, so never twice.
    // A button pressed by someone with no binding decides nothing, but the
    // press is still answered: unanswered, the presser's client spins until
    // Telegram gives up. Best effort; the press stays held.
    if (created && actor === undefined && event.kind === "interaction" && event.interaction?.callbackId !== undefined) {
      try {
        await openConnections
          .get(event.connectionId)
          ?.instance.answerInteraction?.(event.interaction.callbackId, "You are not allowed to decide this.");
      } catch {
        // Presentation only: the held record is what matters.
      }
    }
    if (created && unverified && options.onUnverified !== undefined) {
      try {
        await options.onUnverified({ event, actor });
      } catch {
        // Presentation only: the held record is what matters.
      }
    }
    // Redelivered while still held — its first admission failed, or its sender was allowed since — it is admitted
    // now, as a replay is, under the same claim: never twice.
    if (!created && actor !== undefined && !unverified && options.admit !== undefined && event.kind !== "interaction") {
      const held = await persistence.repositories.messagingInbox.get(event.connectionId, event.providerEventId);
      // Its failure is absorbed: the event stays held for an operator's replay, and the connector acknowledges the
      // redelivery rather than retrying a message that fails every time (a poll offset that never moves on).
      if (held?.state === "received")
        await replay({ connectionId: event.connectionId, providerEventId: event.providerEventId }).catch(() => undefined);
      return receipt;
    }
    if (created && actor !== undefined && !unverified && options.admit !== undefined) {
      // Claimed while it is admitted, so a redelivery arriving meanwhile does not admit it a second time.
      const claimed = await persistence.repositories.messagingInbox.claimForReplay({
        connectionId: event.connectionId,
        providerEventId: event.providerEventId,
        now: now(),
        staleBefore: new Date(Date.parse(now()) - REPLAY_CLAIM_STALE_MS).toISOString(),
      });
      if (!claimed) return receipt;
      const stopTyping = typingWhileItRuns(event);
      try {
        await options.admit({ event, actor });
      } catch (error) {
        await persistence.repositories.messagingInbox.releaseReplayClaim(event.connectionId, event.providerEventId);
        throw error;
      } finally {
        stopTyping();
      }
      // The message is now somebody's task, so it is no longer waiting for
      // anyone: the inbox row becomes `processed`, which is what makes the
      // retention sweep's inbox predicate mean something and what separates "we
      // handled this" from "we are holding it" in `doctor`.
      //
      // Deliberately *after* the await and not before: a thrown admission leaves
      // the row `received`, so a provider redelivery — and the operator reading
      // the table — still sees it as unhandled.
      await persistence.repositories.messagingInbox.markProcessed(event.connectionId, event.providerEventId);
    }
    return receipt;
  }

  /**
   * Whether `takeMessage` took a message; a throw from it takes nothing. The
   * message is claimed while it decides, so a redelivery meanwhile is not
   * admitted, and marked processed before its fire starts, so neither a
   * redelivery while the fire is admitted nor one after a crash is admitted
   * either. The fire is contained and not waited on: ingest never waits on its
   * admission.
   */
  async function takenByTrigger(event: InboundEvent): Promise<boolean> {
    if (options.takeMessage === undefined) return false;
    const inbox = persistence.repositories.messagingInbox;
    const claimed = await inbox.claimForReplay({
      connectionId: event.connectionId,
      providerEventId: event.providerEventId,
      now: now(),
      staleBefore: new Date(Date.parse(now()) - REPLAY_CLAIM_STALE_MS).toISOString(),
    });
    if (!claimed) return false;
    let taken: MessageTaken | undefined;
    try {
      taken = await options.takeMessage(event);
    } catch {
      taken = undefined;
    }
    if (taken === undefined) {
      await inbox.releaseReplayClaim(event.connectionId, event.providerEventId);
      return false;
    }
    await inbox.markProcessed(event.connectionId, event.providerEventId);
    const fire = taken.fire;
    void Promise.resolve()
      .then(fire)
      .catch(() => undefined);
    return true;
  }

  /**
   * Shows the agent typing where its reply to a message goes, now and every
   * `TYPING_EVERY_MS` until the turn the message admitted ends, on a
   * connector that can. Presentation only: whatever it does is contained.
   * Answers what stops it.
   */
  function typingWhileItRuns(event: InboundEvent): () => void {
    const instance = openConnections.get(event.connectionId)?.instance;
    if (instance?.typing === undefined || event.kind !== "message") return () => undefined;
    const destination = buildReplyDestination(event.connectionId, {
      externalConversationId: event.externalConversationId,
      externalSenderId: event.externalSenderId,
      ...(event.externalMessageId === undefined ? {} : { externalMessageId: event.externalMessageId }),
      ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
    });
    if (destination === undefined) return () => undefined;
    const beat = (): void => {
      try {
        // Best effort: a typing indicator that fails is not worth a failed turn.
        instance.typing?.(destination).catch(() => undefined);
      } catch {
        // Contained, as above.
      }
    };
    beat();
    const timer = setInterval(beat, TYPING_EVERY_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * A room message in a room that answers in threads, as a message of
   * the thread a reply opens from it, which its connector names: the task's
   * chat is that thread (a topic of the room) from its first message. A
   * connector that names none leaves it the room's.
   */
  function inItsThread(event: InboundEvent): InboundEvent {
    const providerId = openConnections.get(event.connectionId)?.connection.providerId;
    const threadId = providerId === undefined ? undefined : definitions.get(providerId)?.autoThreadOf?.(event);
    return threadId === undefined
      ? event
      : { ...event, externalThreadId: threadId, threadIsTopic: true, conversationKind: "thread", threadOpened: true };
  }

  /**
   * An event as its channel's descriptor says to read it: the sender written as
   * a binding names it, and on a channel whose messages carry their own proof,
   * one that carries none taken as unverified. Its sender id and name are a
   * stranger's words that `tavi inbox list` and `tavi bindings` print, so
   * neither keeps a control character: the name loses them (escape sequences
   * whole), and the id has each replaced by U+FFFD, never dropped, so an id
   * with one hidden in it never reads as a bound sender's.
   */
  function asItsChannelSays(given: InboundEvent): InboundEvent {
    // Only the host opens a thread for a message (`inItsThread`): a connector's word for it is dropped.
    const { threadOpened: _claimed, ...claimed } = given;
    const event: InboundEvent = {
      ...claimed,
      externalSenderId: claimed.externalSenderId.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\ufffd"),
      ...(claimed.senderName === undefined ? {} : { senderName: withoutControls(claimed.senderName).replace(/[\n\t]/g, " ") }),
    };
    const sender = options.senderOf?.(event.connectionId);
    if (sender === undefined) return event;
    const externalSenderId = normalizeChannelIdentity(event.externalSenderId, sender.normalize) || event.externalSenderId;
    const proofless = sender.authentication === "per-message" && event.senderAuthentication === undefined;
    return externalSenderId === event.externalSenderId && !proofless
      ? event
      : { ...event, externalSenderId, ...(proofless ? { senderAuthentication: "fail" as const } : {}) };
  }

  /**
   * Admit a held event again, now that its sender may be bound.
   *
   * Deliberately the *same* two steps as a fresh message — resolve the sender
   * against the current bindings, then run the same `admit` callback — so a
   * replayed event becomes a task exactly as it would have if it had arrived
   * after the binding. The only extra step is clearing the held row, which is
   * what makes `tavi prune` able to retire it and `doctor`'s
   * `transport.inboxUnprocessed` count go down.
   */
  async function replay(input: { readonly connectionId: string; readonly providerEventId: string }): Promise<MessagingReplayOutcome> {
    const row = await persistence.repositories.messagingInbox.get(input.connectionId, input.providerEventId);
    if (row === undefined) return { outcome: "not-found" };
    if (row.state === "processed") return { outcome: "already-processed" };
    const binding = await persistence.repositories.messagingIdentityBindings.get(input.connectionId, row.payload.externalSenderId);
    const actor = senderActorFromBinding(binding, input.connectionId);
    if (actor === undefined) return { outcome: "unbound", externalSenderId: row.payload.externalSenderId };
    // The same rule as a fresh message: a replay must not admit what ingest held.
    if (!senderAuthenticationAdmits(row.payload, binding)) return { outcome: "unverified", externalSenderId: row.payload.externalSenderId };
    if (options.admit === undefined || options.admissionOpen?.(row.payload) === false) return { outcome: "admission-closed" };
    // Claimed before admitting: `markProcessed` lands after, so without this two
    // replays (or a crash plus a retry) would admit the same message twice. The
    // claim goes stale after ten minutes so a crashed replay is retryable.
    const claimed = await persistence.repositories.messagingInbox.claimForReplay({
      connectionId: input.connectionId,
      providerEventId: input.providerEventId,
      now: now(),
      staleBefore: new Date(Date.parse(now()) - REPLAY_CLAIM_STALE_MS).toISOString(),
    });
    if (!claimed) return { outcome: "in-flight" };
    try {
      await options.admit({ event: row.payload, actor });
    } catch (error) {
      // Give the claim back: the message was not admitted, so it is still held
      // and must stay replayable — otherwise a failed replay would lose it.
      await persistence.repositories.messagingInbox.releaseReplayClaim(input.connectionId, input.providerEventId);
      throw error;
    }
    await persistence.repositories.messagingInbox.markProcessed(input.connectionId, input.providerEventId);
    return { outcome: "admitted", principalId: actor.principalId };
  }

  /**
   * Sends a message, as several when its text is over its channel's
   * `maxTextLength`: each piece in turn, under its own
   * effect (`<effectId>#1`, `#2`, …), stopping at the first not accepted. The
   * message's own effect id keeps one outbox row with the pieces' combined
   * outcome — what a caller that reads the outbox by that id (a routine's
   * delivery reconciling after a crash) sees — and only once every piece is
   * settled, so a piece not yet sent is never read as delivered. A retry finds
   * each piece's own outcome, so nothing goes out twice.
   */
  async function send(message: OutboundMessage): Promise<SendOutcome> {
    const outcome = await sendWhole(message);
    noteRoomOutcome(message, outcome);
    return outcome;
  }

  async function sendWhole(message: OutboundMessage): Promise<SendOutcome> {
    // A connection being reopened is waited for, not failed.
    const reopen = reopens.get(message.connectionId);
    if (reopen !== undefined) await Promise.race([reopen.opened, timer(REOPEN_WAIT_MS)]);
    const entry = openConnections.get(message.connectionId);
    const limit = entry === undefined ? undefined : definitions.get(entry.connection.providerId)?.capabilities.maxTextLength;
    const pieces = limit === undefined ? [message] : splitMessage(message, limit);
    if (pieces.length === 1) return sendOne(message);
    admissible(message);
    const outbox = persistence.repositories.messagingOutbox;
    const { created } = await outbox.begin({
      effectId: message.effectId,
      connectionId: message.connectionId,
      message,
      now: { fixed: now() },
    });
    if (!created) {
      const existing = await outbox.get(message.effectId);
      if (existing?.state === "resolved" && existing.outcome !== undefined) return existing.outcome;
    }
    const parts: SendOutcomePartReceipt[] = [];
    let outcome: SendOutcome = { status: "accepted", retryable: false, parts };
    for (const [index, piece] of pieces.entries()) {
      let sent: SendOutcome;
      try {
        sent = await sendOne(piece);
      } catch (error) {
        // The first piece refused before dispatch sent nothing; the message's
        // row stays as the piece's did. After a piece went out, what was sent
        // stands: the message's outcome is uncertain, never a throw that would
        // have a caller resend the pieces already delivered.
        if (index === 0) {
          // Refused before anything went out: the message is not sent either, as its first piece was not — never left pending.
          if (error instanceof TaviError && (error.code === "UNAVAILABLE" || error.code === "INVALID_INPUT")) {
            await outbox.resolve({
              effectId: message.effectId,
              outcome: { status: "rejected", retryable: error.code === "UNAVAILABLE", parts: [] },
              now: { fixed: now() },
            });
          }
          throw error;
        }
        outcome = { status: "uncertain", retryable: false, parts };
        break;
      }
      parts.push(...sent.parts.map((receipt) => ({ ...receipt, index: parts.length + receipt.index })));
      if (sent.status !== "accepted") {
        outcome = { status: index === 0 ? sent.status : "uncertain", retryable: sent.retryable, parts };
        break;
      }
    }
    await outbox.resolve({ effectId: message.effectId, outcome, now: { fixed: now() } });
    return outcome;
  }

  /** The checks a send passes before anything is recorded or dispatched; the open connection it goes through. */
  function admissible(message: OutboundMessage): OpenConnection {
    // Checked before any connector method runs — "denied operations make
    // no call" (this step's exit-evidence phrase).
    if (!hasGrant(message)) {
      throw new TaviError("NOT_AUTHORIZED", `Destination for connection ${message.connectionId} is not granted`);
    }
    const entry = openConnections.get(message.connectionId);
    if (entry === undefined) {
      throw new TaviError("NOT_FOUND", `No open messaging connection ${message.connectionId}`);
    }
    // A caller that states its workspace must be sending through its own
    // connection. The connection's `workspaceId` is the identity the
    // connection was configured with, so comparing the two is what stops a
    // task in one workspace from using another workspace's connection —
    // otherwise the only identity in play is the target's, and the caller is
    // indistinguishable from a legitimate one. Absent `message.workspaceId`
    // means "no claim", not "any workspace" (contract doc).
    if (message.workspaceId !== undefined && message.workspaceId !== entry.connection.workspaceId) {
      throw new TaviError(
        "NOT_AUTHORIZED",
        `Connection ${message.connectionId} belongs to workspace ${entry.connection.workspaceId}, not ${message.workspaceId}`,
        { details: { connectionId: message.connectionId } },
      );
    }
    return entry;
  }

  async function sendOne(message: OutboundMessage): Promise<SendOutcome> {
    const entry = admissible(message);
    const outbox = persistence.repositories.messagingOutbox;
    const { created } = await outbox.begin({
      effectId: message.effectId,
      connectionId: message.connectionId,
      message,
      now: { fixed: now() },
    });
    if (!created) {
      // A retried `send()` for an already-known effect: trust a durable
      // `resolved` record over re-deriving the answer, the same "durable
      // row first" discipline `waitFor` already established for agent
      // waits. A `pending` row is NOT auto-retried — unlike a wait, whose
      // "nothing yet claims this settled" is genuinely still true at
      // `pending`, a messaging effect's `pending` row can mean the
      // connector already ran and only `resolve()` never committed (a
      // crash in that exact window). Re-invoking `entry.instance.send`
      // there would risk a real duplicate delivery to the outside world —
      // this codebase already established the right discipline for this
      // exact ambiguity in `EffectRepositoryPort.listUnresolved`'s own doc
      // comment: "surfaced for reconciliation; never retried
      // automatically." `listPending` on the outbox port is the messaging
      // equivalent of that surfacing mechanism — this function returns
      // `"uncertain"` rather than guessing.
      const existing = await outbox.get(message.effectId);
      if (existing?.state === "resolved" && existing.outcome !== undefined) {
        return existing.outcome;
      }
      if (existing?.state === "pending") {
        return { status: "uncertain", retryable: false, parts: [] };
      }
    }
    let outcome: SendOutcome;
    try {
      outcome = await paced(await liveEntry(entry, message), message);
    } catch (error) {
      noteActivity(message.connectionId, { lastError: errorMessage(error) });
      // A connector refuses before dispatch with `UNAVAILABLE` (not running) or
      // `INVALID_INPUT`; a failure in flight comes back as an `uncertain`
      // receipt, not a throw. So these two sent nothing: recorded rejected, a
      // retry under a new effect sends, and one under this effect is told so.
      // Any other throw leaves the row pending, since it may have gone out.
      if (error instanceof TaviError && (error.code === "UNAVAILABLE" || error.code === "INVALID_INPUT")) {
        await outbox.resolve({
          effectId: message.effectId,
          outcome: { status: "rejected", retryable: error.code === "UNAVAILABLE", parts: [] },
          now: { fixed: now() },
        });
      }
      throw error;
    }
    await outbox.resolve({ effectId: message.effectId, outcome, now: { fixed: now() } });
    if (outcome.status === "accepted") noteActivity(message.connectionId, { lastSendAt: now() });
    else
      noteActivity(message.connectionId, {
        lastError: outcome.parts.find((part) => part.error !== undefined)?.error ?? `the send was ${outcome.status}`,
      });
    return outcome;
  }

  /**
   * Refuses a send whose grant was revoked or whose connection closed since
   * it was admitted — checked again after every wait, so a denied send never
   * reaches the connector — and records it as sent nothing.
   */
  async function refuseIfGone(entry: OpenConnection, message: OutboundMessage): Promise<void> {
    const revoked = !hasGrant(message);
    const closed = entry.closing === true || openConnections.get(message.connectionId) !== entry;
    if (!revoked && !closed) return;
    await persistence.repositories.messagingOutbox.resolve({
      effectId: message.effectId,
      outcome: { status: "rejected", retryable: false, parts: [] },
      now: { execution: true },
    });
    throw new TaviError(
      revoked ? "NOT_AUTHORIZED" : "NOT_FOUND",
      revoked
        ? `Destination for connection ${message.connectionId} is no longer granted`
        : `Messaging connection ${message.connectionId} closed before dispatch`,
    );
  }

  /**
   * The connector's send, at the connection's pace; one the provider refused
   * as too fast (a 429 with a wait that nothing was sent under) is held back
   * and tried again, rather than failed.
   */
  async function paced(admitted: OpenConnection, message: OutboundMessage): Promise<SendOutcome> {
    let entry = admitted;
    const rate = options.sendRateOf?.(message.connectionId);
    const target =
      definitions.get(entry.connection.providerId)?.paceTargetOf?.(message.destination) ?? JSON.stringify(message.destination ?? null);
    for (let attempt = 0; ; attempt += 1) {
      if (rate !== undefined) await pacer.take(message.connectionId, rate, target);
      const through = await sendThrough(entry, message);
      entry = through.entry;
      const outcome = through.outcome;
      const wait = outcome.retryAfterMs;
      // The provider's wait holds the connection's next sends, whether or not this one is tried again.
      if (wait !== undefined) pacer.backOff(message.connectionId, Math.min(wait, RATE_LIMIT_MAX_BACKOFF_MS));
      const nothingSent = outcome.status === "rejected" && outcome.parts.every((part) => part.status !== "accepted");
      if (!nothingSent || wait === undefined || wait > RATE_LIMIT_MAX_WAIT_MS || attempt >= RATE_LIMIT_RETRIES) return outcome;
      if (rate === undefined) await pause(wait);
    }
  }

  /**
   * The connector's send, counted in flight from before the check that its
   * connection is live — with no await between the two, so a close either
   * sees it and waits, or is seen and the send moves to the reopened
   * connection (or is refused for there being none).
   */
  async function sendThrough(
    start: OpenConnection,
    message: OutboundMessage,
  ): Promise<{ readonly entry: OpenConnection; readonly outcome: SendOutcome }> {
    let entry = start;
    for (;;) {
      entry.inFlight += 1;
      if (entry.closing !== true && openConnections.get(message.connectionId) === entry && hasGrant(message)) {
        try {
          return { entry, outcome: await entry.instance.send(message) };
        } finally {
          settled(entry);
        }
      }
      settled(entry);
      entry = await liveEntry(entry, message);
    }
  }

  function settled(entry: OpenConnection): void {
    entry.inFlight -= 1;
    if (entry.inFlight === 0) for (const resolve of entry.idle.splice(0)) resolve();
  }

  /** What `statusOf` adds to a connector's own status: when it last took a message in or sent one, and why a send last failed. */
  function noteActivity(
    connectionId: string,
    change: { readonly lastInboundAt?: string; readonly lastSendAt?: string; readonly lastError?: string },
  ): void {
    const clipped = change.lastError === undefined ? change : { ...change, lastError: change.lastError.slice(0, LAST_ERROR_MAX) };
    activity.set(connectionId, { ...activity.get(connectionId), ...clipped });
  }

  async function recordDelivery(event: DeliveryEvent): Promise<boolean> {
    const recorded = await persistence.repositories.messagingOutbox.recordDelivery({
      connectionId: event.connectionId,
      providerMessageId: event.providerMessageId,
      status: event.status,
      at: event.occurredAt,
      ...(event.detail === undefined ? {} : { detail: event.detail }),
    });
    return recorded !== undefined;
  }

  /** The conversation each reply destination built in this run is for, per connection, so a refused send names its room. */
  const conversationsOfDestinations = new Map<string, Map<string, string>>();
  /** Why the last send into a room was refused, per connection and conversation; cleared when one is accepted. */
  const roomFailures = new Map<string, Map<string, string>>();
  const ROOM_DESTINATIONS_KEPT = 500;

  function rememberDestination(connectionId: string, destination: unknown, conversationId: string): void {
    let known = conversationsOfDestinations.get(connectionId);
    if (known === undefined) conversationsOfDestinations.set(connectionId, (known = new Map()));
    const key = JSON.stringify(destination);
    known.delete(key);
    known.set(key, conversationId);
    // The oldest is forgotten first: a room's detail is help for the operator, not a record.
    if (known.size > ROOM_DESTINATIONS_KEPT) known.delete(known.keys().next().value as string);
  }

  function noteRoomOutcome(message: OutboundMessage, outcome: SendOutcome): void {
    const conversationId = conversationsOfDestinations.get(message.connectionId)?.get(JSON.stringify(message.destination));
    if (conversationId === undefined) return;
    let failures = roomFailures.get(message.connectionId);
    if (failures === undefined) roomFailures.set(message.connectionId, (failures = new Map()));
    const refusal =
      outcome.status === "rejected" && !outcome.retryable ? outcome.parts.find((part) => part.error !== undefined)?.error : undefined;
    if (outcome.status === "accepted") failures.delete(conversationId);
    else if (refusal !== undefined) failures.set(conversationId, refusal);
  }

  function buildReplyDestination(
    connectionId: string,
    replyTo: {
      readonly externalConversationId: string;
      readonly externalSenderId: string;
      readonly externalMessageId?: string;
      readonly externalReferences?: readonly string[];
      readonly externalThreadId?: string;
      readonly subject?: string;
    },
  ): unknown | undefined {
    const entry = openConnections.get(connectionId);
    if (entry === undefined) return undefined;
    const definition = definitions.get(entry.connection.providerId);
    const destination = definition?.destinationFromInbound?.(replyTo, entry.connection);
    if (destination !== undefined) rememberDestination(connectionId, destination, replyTo.externalConversationId);
    return destination;
  }

  function buildDirectDestination(connectionId: string, externalSenderId: string, workspaceId: string): unknown | undefined {
    const entry = openConnections.get(connectionId);
    // Another workspace's connection reaches none of its people for this caller.
    if (entry === undefined || entry.connection.workspaceId !== workspaceId) return undefined;
    return definitions.get(entry.connection.providerId)?.directDestinationOf?.(externalSenderId, entry.connection);
  }

  /**
   * A group feature of an open connection: only for a caller of the connection's own workspace, as a send
   * is, and only where its connector implements it.
   */
  function groupEntry(connectionId: string, workspaceId: string): OpenConnection {
    const entry = openConnections.get(connectionId);
    if (entry === undefined || entry.closing === true) throw new TaviError("NOT_FOUND", `No open messaging connection ${connectionId}`);
    if (workspaceId !== entry.connection.workspaceId) {
      throw new TaviError(
        "NOT_AUTHORIZED",
        `Connection ${connectionId} belongs to workspace ${entry.connection.workspaceId}, not ${workspaceId}`,
        { details: { connectionId } },
      );
    }
    return entry;
  }

  const unsupported = (connectionId: string, feature: string): TaviError =>
    new TaviError("UNSUPPORTED", `Connection ${connectionId} does not support ${feature}`);

  /**
   * A group post's destination, held to the same grant a send is:
   * refused before the connector is asked, as a send to an ungranted
   * destination is ("denied operations make no call").
   */
  function grantedPost(connectionId: string, workspaceId: string, effectId: string, destination: unknown): void {
    if (!hasGrant({ effectId, connectionId, workspaceId, destination, parts: [] }))
      throw new TaviError("NOT_AUTHORIZED", `Destination for connection ${connectionId} is not granted`);
  }

  /**
   * What a group feature posts into a room, paced as a send to the same
   * destination is, and holding the connection's next sends back by a wait the
   * provider asked for; recorded as a send's outcome is.
   */
  async function pacedGroupPost<T extends SendOutcome>(entry: OpenConnection, destination: unknown, post: () => Promise<T>): Promise<T> {
    const connectionId = entry.connection.connectionId;
    const rate = options.sendRateOf?.(connectionId);
    const target = definitions.get(entry.connection.providerId)?.paceTargetOf?.(destination) ?? JSON.stringify(destination ?? null);
    if (rate !== undefined) await pacer.take(connectionId, rate, target);
    const outcome = await post();
    if (outcome.retryAfterMs !== undefined) pacer.backOff(connectionId, Math.min(outcome.retryAfterMs, RATE_LIMIT_MAX_BACKOFF_MS));
    if (outcome.status === "accepted") noteActivity(connectionId, { lastSendAt: now() });
    else
      noteActivity(connectionId, {
        lastError: outcome.parts.find((part) => part.error !== undefined)?.error ?? `the send was ${outcome.status}`,
      });
    return outcome;
  }

  async function fetchRecent(
    connectionId: string,
    workspaceId: string,
    destination: unknown,
    options: { readonly limit: number; readonly before?: string; readonly signal: AbortSignal },
  ): Promise<readonly RecentRoomMessage[]> {
    const entry = groupEntry(connectionId, workspaceId);
    const most = definitions.get(entry.connection.providerId)?.capabilities.groups?.recentHistory?.maxMessages;
    if (entry.instance.fetchRecent === undefined || most === undefined) throw unsupported(connectionId, "reading a room's recent messages");
    const limit = Math.max(1, Math.min(options.limit, most, 20));
    // At most what was asked, whatever the connector answers.
    return (await entry.instance.fetchRecent(destination, { ...options, limit })).slice(-limit);
  }

  async function createPoll(connectionId: string, workspaceId: string, input: ChannelPollInput): Promise<SendOutcome> {
    const entry = groupEntry(connectionId, workspaceId);
    const post = entry.instance.createPoll?.bind(entry.instance);
    if (post === undefined) throw unsupported(connectionId, "polls");
    grantedPost(connectionId, workspaceId, input.effectId, input.destination);
    return pacedGroupPost(entry, input.destination, () => post(input));
  }

  async function readPoll(connectionId: string, workspaceId: string, destination: unknown, messageId: string): Promise<ChannelPollState> {
    const entry = groupEntry(connectionId, workspaceId);
    if (entry.instance.readPoll === undefined) throw unsupported(connectionId, "reading polls");
    return entry.instance.readPoll(destination, messageId);
  }

  async function endPoll(
    connectionId: string,
    workspaceId: string,
    input: { readonly effectId: string; readonly destination: unknown; readonly messageId: string },
  ): Promise<SendOutcome> {
    const entry = groupEntry(connectionId, workspaceId);
    const post = entry.instance.endPoll?.bind(entry.instance);
    if (post === undefined) throw unsupported(connectionId, "ending polls");
    grantedPost(connectionId, workspaceId, input.effectId, input.destination);
    return pacedGroupPost(entry, input.destination, () => post(input));
  }

  async function listRooms(connectionId: string, workspaceId: string): Promise<readonly ChannelRoomListing[]> {
    const entry = groupEntry(connectionId, workspaceId);
    if (entry.instance.listRooms === undefined) throw unsupported(connectionId, "listing rooms");
    return entry.instance.listRooms();
  }

  async function leaveRoom(connectionId: string, workspaceId: string, destination: unknown): Promise<void> {
    const entry = groupEntry(connectionId, workspaceId);
    if (entry.instance.leaveRoom === undefined) throw unsupported(connectionId, "leaving rooms");
    await entry.instance.leaveRoom(destination);
  }

  async function createEvent(
    connectionId: string,
    workspaceId: string,
    input: ChannelEventInput,
  ): Promise<SendOutcome & { readonly url?: string }> {
    const entry = groupEntry(connectionId, workspaceId);
    const post = entry.instance.createEvent?.bind(entry.instance);
    if (post === undefined) throw unsupported(connectionId, "events");
    grantedPost(connectionId, workspaceId, input.effectId, input.destination);
    return pacedGroupPost(entry, input.destination, () => post(input));
  }

  function buildDestination(connectionId: string, target: MessagingTarget): unknown | undefined {
    const entry = openConnections.get(connectionId);
    if (entry === undefined) return undefined;
    return definitions.get(entry.connection.providerId)?.destinationFor?.(target, entry.connection);
  }

  function ingressOf(connectionId: string): { readonly ingress: MessagingIngress; readonly context: IngressContext } | undefined {
    const entry = openConnections.get(connectionId);
    const ingress = entry === undefined ? undefined : definitions.get(entry.connection.providerId)?.ingress;
    if (entry === undefined || ingress === undefined || entry.closing === true) return undefined;
    return { ingress, context: { connection: entry.connection, credentials: entry.credentials, now } };
  }

  function connectionsOf(providerId: string): readonly MessagingConnection[] {
    return [...openConnections.values()]
      .filter((entry) => entry.connection.providerId === providerId && entry.closing !== true)
      .map((entry) => entry.connection);
  }

  /** Room policy's drops since this run began, by reason, for a status line: counted, never recorded. */
  function dropsLine(connectionId: string): string | undefined {
    const counts = Object.entries(roomPolicy?.drops(connectionId) ?? {}).filter(([, count]) => count !== undefined && count > 0);
    return counts.length === 0
      ? undefined
      : `Dropped since start: ${counts.map(([reason, count]) => `${String(count)} ${reason}`).join(", ")}`;
  }

  function statusOf(connectionId: string): MessagingConnectionStatus | undefined {
    const status = openConnections.get(connectionId)?.instance.status();
    if (status === undefined) return undefined;
    const drops = dropsLine(connectionId);
    const detail = drops === undefined ? status.detail : status.detail === undefined ? drops : `${status.detail}. ${drops}`;
    return { ...status, ...(detail === undefined ? {} : { detail }), ...activity.get(connectionId) };
  }

  function providerOf(connectionId: string): string | undefined {
    return openConnections.get(connectionId)?.connection.providerId;
  }

  function capabilitiesOf(connectionId: string): MessagingCapabilities | undefined {
    const entry = openConnections.get(connectionId);
    return entry === undefined ? undefined : definitions.get(entry.connection.providerId)?.capabilities;
  }

  // Acknowledging a press and editing a sent message are presentation, not
  // delivery: neither goes through the outbox, and neither can change what a
  // round decided.
  async function answerInteraction(connectionId: string, callbackId: string, text: string): Promise<void> {
    await openConnections.get(connectionId)?.instance.answerInteraction?.(callbackId, text);
  }

  async function editMessage(
    connectionId: string,
    input: {
      readonly destination: unknown;
      readonly messageId: string;
      readonly text: string;
      readonly buttons?: readonly (readonly OutboundButton[])[];
    },
  ): Promise<boolean> {
    const instance = openConnections.get(connectionId)?.instance;
    if (instance?.editMessage === undefined) return false;
    await instance.editMessage(input);
    return true;
  }

  return {
    registerConnector,
    unregisterConnector,
    openConnection,
    closeConnection,
    ingest,
    replay,
    send,
    recordDelivery,
    buildReplyDestination,
    buildDirectDestination,
    buildDestination,
    providerOf,
    statusOf,
    probe,
    probeOf,
    ingressOf,
    connectionsOf,
    capabilitiesOf,
    answerInteraction,
    editMessage,
    fetchRecent,
    createPoll,
    readPoll,
    endPoll,
    createEvent,
    listRooms,
    leaveRoom,
    roomDrops: (connectionId) => roomPolicy?.drops(connectionId) ?? {},
    roomDetails: (connectionId) => Object.fromEntries(roomFailures.get(connectionId) ?? []),
  };
}
