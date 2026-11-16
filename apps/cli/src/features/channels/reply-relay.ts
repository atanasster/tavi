import type { AdmissionOutcome, MessagingServicePort, PersistencePort } from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";

/**
 * A one-to-one chat's answer, sent when the turn sent none itself.
 *
 * A message-started task replies with `messaging.send`,
 * and the system prompt tells it to; a model that answers in plain text
 * anyway would leave the person on the channel with silence, while the
 * answer sits in Tavi. The workflow decides from the turn itself whether one
 * is owed (`AdmissionOutcome.channelReply`: no send tried, the gate lets a
 * `messaging.send` of it through, disarmed under taint) and to whom — the
 * turn's own message, so an email answer keeps its subject and thread. This
 * sends it, once per admission. A group or thread is left to the model.
 */
export interface ChannelReplyRelay {
  /** After an admission left `taskId` completed or failed, with how it ended. Best effort: a failed send is logged, never thrown. */
  onTaskEnded(taskId: string, admissionId?: string, outcome?: AdmissionOutcome): Promise<void>;
}

export interface ChannelReplyRelayDeps {
  readonly repositories: Pick<PersistencePort["repositories"], "tasks">;
  readonly messaging: Pick<MessagingServicePort, "send" | "buildReplyDestination">;
  readonly isLocalConnection: (connectionId: string) => boolean;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
}

export function createChannelReplyRelay(deps: ChannelReplyRelayDeps): ChannelReplyRelay {
  return {
    async onTaskEnded(taskId, admissionId, outcome) {
      const reply = outcome?.status === "completed" ? outcome.channelReply : undefined;
      // Keyed by the admission, so a replayed end sends nothing twice; the owner's own front ends show the answer.
      if (reply === undefined || admissionId === undefined || deps.isLocalConnection(reply.replyTo.connectionId)) return;
      const { replyTo } = reply;
      const task = await deps.repositories.tasks.get(taskId);
      if (task === undefined) return;
      // Addressed as the turn's own `messaging.send` would be.
      const destination = deps.messaging.buildReplyDestination(replyTo.connectionId, {
        externalConversationId: replyTo.externalConversationId,
        externalSenderId: replyTo.externalSenderId,
        ...definedOnly({
          externalMessageId: replyTo.externalMessageId,
          externalReferences: replyTo.externalReferences,
          externalThreadId: replyTo.externalThreadId,
          subject: replyTo.subject,
        }),
      });
      if (destination === undefined) return;
      try {
        const sent = await deps.messaging.send({
          effectId: `turn-reply:${taskId}:${admissionId}`,
          connectionId: replyTo.connectionId,
          workspaceId: task.workspaceId,
          destination,
          parts: [{ content: reply.content }],
        });
        if (sent.status === "rejected")
          deps.warn("a chat's answer could not be relayed to its channel", {
            taskId,
            connectionId: replyTo.connectionId,
            outcome: sent.status,
          });
      } catch (error) {
        deps.warn("a chat's answer could not be relayed to its channel", {
          taskId,
          connectionId: replyTo.connectionId,
          error: errorMessage(error),
        });
      }
    },
  };
}
