import {
  LOCAL_PROVIDER_ID,
  TaviError,
  type InboundEvent,
  type MessagingCapabilities,
  type MessagingConnection,
  type MessagingConnectorDefinition,
  type MessagingConnectorInstance,
  type MessagingInboundHandler,
  type MessagingIngestHooks,
  type MessagingIngestReceipt,
  type OutboundMessage,
  type SendOutcome,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { z } from "zod";

/** The local connection's identity is the host's too: it lives in contracts, and is named here for this plugin's users. */
export { LOCAL_CONNECTION_PREFIX, LOCAL_PROVIDER_ID, isLocalConnectionId, localConnectionId } from "@tavi/contracts";

/**
 * The local messaging connection: the
 * channel of the owner's own front ends — `tavi chat`, and later the web
 * canvas — over IPC.
 *
 * One connection per workspace, `local-<workspaceId>`; each IPC run opens a
 * conversation on it, keyed by the run's operation key, so `operator.ask_user`
 * in an IPC-started run replies into that conversation, and the IPC `reply`
 * command is this connection's inbound transport. Nothing here knows about
 * IPC: the owner hands inbound messages to `deliver`, which passes them to
 * the messaging service exactly as a chat connector's poll loop does, so the
 * reply is correlated and settled by the service's one path.
 *
 * Sending is accepted once the service has written the message to its
 * durable outbox — which it does before calling `send` — so a question
 * reaches its record whether or not a front end is attached; a front end
 * attaching later reads the question off the task's `task.waiting` event.
 *
 * The connection is never a destination a model may name: the owner
 * leaves it out of the connections the allowlist knows, so it is reachable
 * only by replying into one of its own conversations.
 */

const CAPABILITIES: MessagingCapabilities = {
  receiveMode: "local",
  send: true,
  editOrProgress: false,
  formats: ["plain"],
  attachments: false,
  maxAttachmentBytes: 0,
  maxPartsPerMessage: 64,
  threads: false,
  interactions: false,
  deliveryReceipts: false,
  // The chat panel shows any length; this only bounds one message.
  maxTextLength: 100_000,
  // Rounds raised by a local chat are decided in the app, not by a reply.
  approvals: "none",
};

/** Where a local message goes: the conversation, which is the IPC run's operation key. */
export const LocalDestinationSchema = z.object({ conversationId: z.string().min(1).max(256) }).strict();

/** A local connection as the owner holds it: a connector instance, and the way in. */
export interface LocalConnectorInstance extends MessagingConnectorInstance {
  /**
   * Hand an inbound message to the owning service, as a chat connector's poll
   * loop hands it an update: recorded (deduplicated by its
   * `providerEventId`), correlated to its conversation's task, and admitted.
   * Resolves when the service has finished with it — the whole turn — and
   * `hooks.onRecorded` is called as soon as it is recorded. It rejects when
   * the admitted turn fails, after `onRecorded`: nothing redelivers a local
   * message, so the inbox row stays `received` for an operator to replay
   * (`tavi inbox replay`), and the caller logs the failure.
   */
  deliver(event: InboundEvent, hooks?: MessagingIngestHooks): Promise<MessagingIngestReceipt>;
}

export interface LocalConnectorOptions {
  /** Called with each connection the service opens, so its owner can `deliver` into it. */
  readonly onInstanceCreated?: (connectionId: string, instance: LocalConnectorInstance) => void;
}

export function createLocalConnectorDefinition(options: LocalConnectorOptions = {}): MessagingConnectorDefinition {
  return {
    providerId: LOCAL_PROVIDER_ID,
    version: "1.0.0",
    configSchema: z.object({}).strict(),
    capabilities: CAPABILITIES,
    // `ask_user` replies into the conversation an IPC run opened.
    destinationFromInbound: (replyTo) => ({ conversationId: replyTo.externalConversationId }),
    createConnection: ({ connection }) => {
      const instance = createInstance(connection);
      options.onInstanceCreated?.(connection.connectionId, instance);
      return instance;
    },
  };
}

function createInstance(connection: MessagingConnection): LocalConnectorInstance {
  let handler: MessagingInboundHandler | undefined;
  let running = false;
  let since = nowTimestamp();
  return {
    async start() {
      running = true;
      since = nowTimestamp();
    },
    async stop() {
      running = false;
      since = nowTimestamp();
    },
    status() {
      return { state: running ? "running" : "stopped", since };
    },
    async probe() {
      return running ? { ok: true } : { ok: false, detail: "the local connection is not running" };
    },
    async send(message: OutboundMessage): Promise<SendOutcome> {
      const destination = LocalDestinationSchema.safeParse(message.destination);
      if (!destination.success) {
        throw new TaviError("INVALID_INPUT", `local destination for effect ${message.effectId} is invalid: ${destination.error.message}`, {
          details: { effectId: message.effectId },
        });
      }
      // Recorded in the service's outbox before this is called; that record is
      // the delivery. A front end reads the question off the task's stream.
      return {
        status: "accepted",
        retryable: false,
        parts: message.parts.map((_part, index) => ({ index, status: "accepted" as const })),
      };
    },
    onInboundEvent(next: MessagingInboundHandler): void {
      handler = next;
    },
    async deliver(event: InboundEvent, hooks?: MessagingIngestHooks): Promise<MessagingIngestReceipt> {
      if (!running || handler === undefined) {
        throw new TaviError("UNAVAILABLE", `the local connection ${connection.connectionId} is not open`);
      }
      if (event.connectionId !== connection.connectionId) {
        throw new TaviError("INVALID_INPUT", `connection ${connection.connectionId} was handed an event for ${event.connectionId}`);
      }
      const receipt = await handler(event, hooks);
      if (receipt === undefined) throw new TaviError("INTERNAL", "the messaging service answered no receipt for a local message");
      return receipt;
    },
  };
}
