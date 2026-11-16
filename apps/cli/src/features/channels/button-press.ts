import type { InboundEvent, MessagingServicePort } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

/** A button press older than this (replayed from the held inbox) is not acted on. */
const MAX_PRESS_AGE_MS = 10 * 60_000;

/** What `pressOf` needs of the messaging service. */
export type PressMessaging = Pick<MessagingServicePort, "answerInteraction" | "buildReplyDestination" | "editMessage">;

/** One button press on a channel: its acknowledgement, its age check, and the edit of the message it was under. */
export interface ButtonPress {
  /** Acknowledges the press with `text`, best effort: a failure is a diagnostic. */
  answer(text: string): Promise<void>;
  /** Whether the press was made longer ago than `MAX_PRESS_AGE_MS` before `now`. */
  tooOld(now: string): boolean;
  /**
   * Replaces the message the press was under (and its buttons) with the text
   * `text` makes, best effort: the press already acted, and an unedited message
   * only keeps its buttons. `text` runs only when there is a message to edit,
   * and a failure making it is a diagnostic like a failed edit.
   */
  settle(text: () => string): Promise<void>;
}

/**
 * A press of one of Tavi's buttons, as heartbeat items, reminders and approval
 * rounds handle it. `what` names the press and the message in diagnostics:
 * "a reminder button press could not be acknowledged".
 */
export function pressOf(
  messaging: PressMessaging,
  event: InboundEvent,
  what: { readonly press: string; readonly message: string },
  onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void,
): ButtonPress {
  const callbackId = event.interaction?.callbackId;
  return {
    async answer(text) {
      if (callbackId === undefined) return;
      try {
        await messaging.answerInteraction(event.connectionId, callbackId, text);
      } catch (error) {
        onDiagnostic?.(`${what.press} could not be acknowledged`, { connectionId: event.connectionId, error: errorMessage(error) });
      }
    },
    tooOld(now) {
      return Date.parse(now) - Date.parse(event.receivedAt) > MAX_PRESS_AGE_MS;
    },
    async settle(text) {
      const messageId = event.interaction?.messageId;
      if (messageId === undefined) return;
      try {
        const destination = messaging.buildReplyDestination(event.connectionId, {
          externalConversationId: event.externalConversationId,
          externalSenderId: event.externalSenderId,
          ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
        });
        if (destination === undefined) return;
        await messaging.editMessage(event.connectionId, { destination, messageId, text: text() });
      } catch (error) {
        onDiagnostic?.(`${what.message} could not be edited`, { connectionId: event.connectionId, error: errorMessage(error) });
      }
    },
  };
}
