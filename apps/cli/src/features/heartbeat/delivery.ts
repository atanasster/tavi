import type { MessagingConnectionRecord, MessagingOutboxRepositoryPort, MessagingServicePort, OutboundButton } from "@tavi/contracts";
import type { HeartbeatDeliveryPort } from "@tavi/agent-host/heartbeat-delivery";

import type { ChatNotices } from "../tasks/notices.js";

/**
 * Where a heartbeat's words go in this owner:
 * Home notices through the chat notices, and channel messages through the
 * messaging service — the same outbox, pacer and grants as any send. A target
 * whose connection is deleted, not open (its provider missing) or waiting to
 * be signed in again is skipped and logged, never queued.
 */
export interface HeartbeatDeliveryDependencies {
  readonly notices: Pick<ChatNotices, "postHeartbeat">;
  readonly messaging: Pick<MessagingServicePort, "send" | "buildDestination" | "capabilitiesOf" | "editMessage">;
  readonly connections: { get(connectionId: string): Promise<MessagingConnectionRecord | undefined> };
  readonly outbox: Pick<MessagingOutboxRepositoryPort, "get">;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

/** Where an item is opened, for a channel without buttons; the owner knows no address for the canvas. */
export const HEARTBEAT_OPEN_HINT = "Open it in Tavi: Center → Heartbeat.";

/**
 * An item's buttons: at most three, labels at most 20 characters, data
 * `h:<token>:<o|s|m>` — Open, Snooze 1 h, Don't tell me — 20 bytes, well
 * within a channel's 64.
 */
export function heartbeatButtons(token: string): readonly (readonly OutboundButton[])[] {
  return [
    [
      { label: "Open", data: `h:${token}:o` },
      { label: "Snooze 1 h", data: `h:${token}:s` },
      { label: "Don't tell me", data: `h:${token}:m` },
    ],
  ];
}

export function createHeartbeatDelivery(deps: HeartbeatDeliveryDependencies): HeartbeatDeliveryPort {
  /** Why a target cannot be sent to now, or undefined when it can. */
  const unreachable = async (workspaceId: string, connectionId: string): Promise<string | undefined> => {
    const connection = await deps.connections.get(connectionId);
    if (connection === undefined || connection.deletedAt !== undefined) return "its connection was removed";
    if (connection.workspaceId !== workspaceId) return "its connection belongs to another workspace";
    if (connection.authState === "expired" || connection.authState === "needs-consent") return "its connection needs signing in again";
    if (deps.messaging.capabilitiesOf(connectionId) === undefined) return "its connection is not open (its channel may be missing)";
    return undefined;
  };

  return {
    notify: async (state, notice) =>
      await deps.notices.postHeartbeat({ workspaceId: state.workspaceId, principalId: state.principalId, ...notice }),

    async send(state, target, message) {
      const interactive = deps.messaging.capabilitiesOf(target.connectionId)?.interactions === true;
      const why = await unreachable(state.workspaceId, target.connectionId);
      const destination =
        why === undefined ? deps.messaging.buildDestination(target.connectionId, { to: target.to, subject: message.subject }) : undefined;
      if (destination === undefined) {
        deps.log("a heartbeat target was skipped", {
          workspaceId: state.workspaceId,
          connectionId: target.connectionId,
          reason: why ?? "its channel cannot be sent to except as a reply",
        });
        return "skipped";
      }
      const outcome = await deps.messaging.send({
        effectId: message.effectId,
        connectionId: target.connectionId,
        workspaceId: state.workspaceId,
        destination,
        subject: message.subject,
        // An item's message: three buttons where the channel has them, else a line saying where to open it.
        parts: [{ content: message.buttonToken === undefined || interactive ? message.text : `${message.text}\n\n${HEARTBEAT_OPEN_HINT}` }],
        ...(message.buttonToken !== undefined && interactive ? { buttons: heartbeatButtons(message.buttonToken) } : {}),
      });
      return outcome.status;
    },

    async edit(_state, target, message) {
      if (deps.messaging.capabilitiesOf(target.connectionId)?.editOrProgress !== true) return false;
      const sent = await deps.outbox.get(message.effectId);
      const messageId = sent?.outcome?.status === "accepted" ? sent.outcome.parts[0]?.providerMessageId : undefined;
      const destination = deps.messaging.buildDestination(target.connectionId, { to: target.to });
      if (messageId === undefined || destination === undefined) return false;
      return await deps.messaging.editMessage(target.connectionId, { destination, messageId, text: message.text });
    },
  };
}
