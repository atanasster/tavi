import type { HeartbeatSignalSource, InboundEvent, MessagingServicePort, PersistencePort } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import type { RoomNotice } from "@tavi/runtime";

/**
 * Group pairing: the
 * rooms a group channel's agent was added to, or that spoke while nobody listed
 * them, kept for the operator to add as a room or leave. Nothing of the room is
 * recorded but its ids and the platform's name for it (display only): the
 * room policy dropped its messages. Kept in memory, bounded: a room still
 * unlisted after a restart is named again the next time it speaks.
 *
 * Also the one notice a flooding room gets, at most once an hour,
 * which the room policy decides.
 */

/** The most rooms kept waiting; the oldest goes first. */
const MAX_INVITATIONS = 200;
/** How long an invitation waits for the operator before it lapses. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const FLOOD_NOTICE = "I'm getting a lot of messages here, so I'm skipping some. I'll pick up again in a minute.";

interface RoomInvitation {
  readonly connectionId: string;
  readonly conversationId: string;
  /** Who added the agent, or who spoke, as the platform names them (an id, untrusted). */
  readonly by: string;
  /** The platform's name for the room, display only and untrusted. */
  readonly roomName?: string;
  /** `added`: the platform said the agent was added; `spoke`: a message came from it while unlisted. */
  readonly how: "added" | "spoke";
  readonly at: string;
}

export interface RoomInvitations {
  /** Takes in a room policy notice; a flood notice is answered in the room. */
  notice(notice: { readonly kind: RoomNotice; readonly event: InboundEvent }): Promise<void>;
  /** The rooms waiting on a connection, newest first, lapsed ones left out. */
  list(connectionId: string): readonly RoomInvitation[];
  /** The operator added or left the room: it waits no more. */
  settle(connectionId: string, conversationId: string): void;
}

export interface RoomInvitationsDependencies {
  readonly now: () => string;
  readonly messaging: Pick<MessagingServicePort, "send" | "buildReplyDestination">;
  /** A connection's workspace, for the flood notice's send; undefined for one no longer configured. */
  readonly workspaceOf: (connectionId: string) => Promise<string | undefined>;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
}

export function createRoomInvitations(deps: RoomInvitationsDependencies): RoomInvitations {
  const waiting = new Map<string, RoomInvitation>();
  const keyOf = (connectionId: string, conversationId: string): string => `${connectionId}\u0000${conversationId}`;
  const live = (invitation: RoomInvitation): boolean => Date.parse(deps.now()) - Date.parse(invitation.at) < INVITATION_TTL_MS;

  const keep = (invitation: RoomInvitation): void => {
    const key = keyOf(invitation.connectionId, invitation.conversationId);
    const earlier = waiting.get(key);
    waiting.delete(key);
    // Being added is what the operator is asked about; a later message from the room does not hide it.
    waiting.set(key, earlier?.how === "added" && invitation.how === "spoke" ? { ...earlier, at: invitation.at } : invitation);
    if (waiting.size > MAX_INVITATIONS) {
      const oldest = waiting.keys().next().value;
      if (oldest !== undefined) waiting.delete(oldest);
    }
  };

  async function floodNotice(event: InboundEvent): Promise<void> {
    const workspaceId = await deps.workspaceOf(event.connectionId);
    const destination = deps.messaging.buildReplyDestination(event.connectionId, {
      externalConversationId: event.externalConversationId,
      externalSenderId: event.externalSenderId,
      ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
    });
    if (workspaceId === undefined || destination === undefined) return;
    const room = sha256Hex(`${event.connectionId}\u0000${event.externalConversationId}`).slice(0, 16);
    await deps.messaging.send({
      // One per room an hour, as the room policy tells it: a redelivered notice is answered from the outbox.
      effectId: `room-flood:${room}:${deps.now().slice(0, 13)}`,
      connectionId: event.connectionId,
      workspaceId,
      destination,
      parts: [{ content: FLOOD_NOTICE }],
    });
  }

  return {
    async notice({ kind, event }) {
      if (kind === "flood") {
        await floodNotice(event).catch((error: unknown) =>
          deps.log?.("a room's flood notice could not be sent", { connectionId: event.connectionId, error: errorMessage(error) }),
        );
        return;
      }
      if (kind === "membership" && event.membership?.change === "removed") {
        waiting.delete(keyOf(event.connectionId, event.externalConversationId));
        return;
      }
      keep({
        connectionId: event.connectionId,
        conversationId: event.externalConversationId,
        by: event.externalSenderId,
        ...(event.membership?.roomName === undefined ? {} : { roomName: event.membership.roomName.slice(0, 120) }),
        how: kind === "membership" ? "added" : "spoke",
        at: deps.now(),
      });
    },
    list(connectionId) {
      return [...waiting.values()].filter((invitation) => invitation.connectionId === connectionId && live(invitation)).reverse();
    },
    settle(connectionId, conversationId) {
      waiting.delete(keyOf(connectionId, conversationId));
    },
  };
}

/**
 * The heartbeat's `rooms` source: a room waiting to be added or left, told to
 * the workspace's operator only, naming who added the agent: once per room
 * until it is settled, and an unlisted room that keeps talking again each day
 * it does.
 */
export function roomInvitationsSource(deps: {
  readonly invitations: RoomInvitations;
  readonly connections: Pick<PersistencePort["repositories"]["messagingConnections"], "list">;
  readonly operatorOf: (workspaceId: string) => string | undefined;
}): HeartbeatSignalSource {
  return {
    id: "rooms",
    async collect(scope) {
      if (deps.operatorOf(scope.workspaceId) !== scope.principalId) return [];
      const connections = await deps.connections.list(scope.workspaceId);
      return connections.flatMap((connection) =>
        deps.invitations.list(connection.connectionId).map((invitation) => ({
          key: `room:${sha256Hex(`${invitation.connectionId}\u0000${invitation.conversationId}`).slice(0, 32)}`,
          // The day it last spoke (or was added) is in the hash: told again the next day it talks, never twice a day.
          hash: `${invitation.how}:${invitation.at.slice(0, 10)}`,
          // The room's name and who added the agent are the platform's: shown as untrusted, as every signal title is.
          title: (invitation.how === "added"
            ? `${invitation.by} added Tavi to a room on ${connection.label ?? connection.providerId}${invitation.roomName === undefined ? "" : ` (${invitation.roomName})`}: add it or leave`
            : `A room nobody listed on ${connection.label ?? connection.providerId} is talking to Tavi: add it or leave`
          ).slice(0, 120),
          at: invitation.at,
          source: "Channels",
          data: { connectionId: invitation.connectionId, conversationId: invitation.conversationId },
        })),
      );
    },
  };
}
