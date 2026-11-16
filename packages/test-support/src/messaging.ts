import { z } from "zod";

import type {
  InboundEvent,
  MessagingCapabilities,
  MessagingConnection,
  MessagingConnectorDefinition,
  MessagingConnectorInstance,
  MessagingConnectionStatus,
  OutboundMessage,
  SendOutcome,
} from "@tavi/contracts";

/**
 * Fixture messaging connector — no network,
 * deterministic send outcomes, an injectable inbound event queue. What
 * the messaging tests and any future connector package's
 * contract-compliance suite run against, the same role
 * `./fakes.ts`'s fixture `ModelPort` plays for the model contract.
 */

export interface FixtureMessagingConnectorInstance extends MessagingConnectorInstance {
  /** Test-only: drives an inbound event through the registered `onInboundEvent` handler, or no-ops if none is registered yet. */
  deliverInbound(event: InboundEvent): Promise<void>;
  /** Test-only: every message this instance's `send` was called with, in order. */
  readonly sent: readonly OutboundMessage[];
}

export interface FixtureMessagingConnectorOptions {
  readonly providerId?: string;
  readonly capabilities?: Partial<MessagingCapabilities>;
  /** Deterministic outcome for each `send` call; defaults to "accepted" for every part. */
  readonly sendOutcome?: (message: OutboundMessage) => SendOutcome;
  readonly now?: () => string;
  /** Test hook: called with each instance as `createConnection` builds it, so a test can assert on `instance.sent` (e.g. exactly-once connector invocation across a retried `send()`). */
  readonly onInstanceCreated?: (instance: FixtureMessagingConnectorInstance) => void;
}

const DEFAULT_CAPABILITIES: MessagingCapabilities = {
  receiveMode: "poll",
  send: true,
  editOrProgress: false,
  formats: ["plain"],
  attachments: false,
  maxAttachmentBytes: 0,
  maxPartsPerMessage: 10,
  threads: false,
  interactions: false,
  deliveryReceipts: false,
  maxTextLength: 4096,
  approvals: "none",
};

function defaultSendOutcome(message: OutboundMessage): SendOutcome {
  return {
    status: "accepted",
    retryable: false,
    parts: message.parts.map((_, index) => ({ index, status: "accepted", providerMessageId: `pm-${message.effectId}-${index}` })),
  };
}

/**
 * A `MessagingConnectorDefinition` whose instances never touch the
 * network — `createConnection` builds a `FixtureMessagingConnectorInstance`
 * exposing `deliverInbound`/`sent` for a test to drive/inspect directly.
 */
export function createFixtureMessagingConnectorDefinition(options: FixtureMessagingConnectorOptions = {}): MessagingConnectorDefinition {
  return {
    providerId: options.providerId ?? "fixture",
    version: "1.0.0",
    configSchema: z.record(z.string(), z.unknown()),
    capabilities: { ...DEFAULT_CAPABILITIES, ...options.capabilities },
    createConnection: ({ connection }) => {
      const instance = createFixtureConnectorInstance(connection, options);
      options.onInstanceCreated?.(instance);
      return instance;
    },
    // A send that answers nothing goes to the target as a chat id, in its thread when one is named.
    destinationFor: (target) => ({ chatId: target.to, ...(target.threadId === undefined ? {} : { threadId: target.threadId }) }),
  };
}

function createFixtureConnectorInstance(
  _connection: MessagingConnection,
  options: FixtureMessagingConnectorOptions,
): FixtureMessagingConnectorInstance {
  const now = options.now ?? ((): string => new Date().toISOString());
  const sendOutcome = options.sendOutcome ?? defaultSendOutcome;
  let status: MessagingConnectionStatus = { state: "stopped", since: now() };
  let handler: ((event: InboundEvent) => Promise<void>) | undefined;
  const sent: OutboundMessage[] = [];

  return {
    async start(): Promise<void> {
      status = { state: "running", since: now() };
    },
    async stop(): Promise<void> {
      status = { state: "stopped", since: now() };
    },
    status(): MessagingConnectionStatus {
      return status;
    },
    async probe() {
      return { ok: status.state === "running" };
    },
    async send(message: OutboundMessage): Promise<SendOutcome> {
      if (status.state !== "running") {
        throw new Error(`fixture connector is not running (state: ${status.state})`);
      }
      sent.push(message);
      return sendOutcome(message);
    },
    onInboundEvent(next: (event: InboundEvent) => Promise<void>): void {
      handler = next;
    },
    async deliverInbound(event: InboundEvent): Promise<void> {
      await handler?.(event);
    },
    sent,
  };
}
