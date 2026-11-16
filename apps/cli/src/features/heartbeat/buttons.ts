import type { HeartbeatLedgerRow, InboundEvent, MemoryActor, MessagingServicePort, PersistencePort } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { pressOf } from "../channels/button-press.js";
import { HEARTBEAT_OPEN_HINT } from "./delivery.js";

/**
 * Open, Snooze 1 h and Don't tell me under a heartbeat item on a channel with
 * buttons, handled next to the
 * reminders' presses and like them: only the person the item is for can use
 * them, a press older than ten minutes is not acted on, a press on a settled
 * item gets a calm receipt, and a press that acts replaces the buttons with
 * what it did.
 */

/** A press's data: `h:<button token>:<o|s|m>`. */
const HEARTBEAT_BUTTON = /^h:([A-Za-z0-9_-]{16}):([osm])$/;
const SNOOZE_MS = 60 * 60_000;

/** Whether an inbound event is a press of a heartbeat item's button. */
export function isHeartbeatPress(event: InboundEvent): boolean {
  return event.kind === "interaction" && HEARTBEAT_BUTTON.test(event.interaction?.data ?? "");
}

export interface HeartbeatButtonDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "heartbeats">;
  readonly messaging: Pick<MessagingServicePort, "answerInteraction" | "buildReplyDestination" | "editMessage">;
  readonly now: () => string;
  readonly onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
}

/** What a press on an item that no longer waits says, instead of acting. */
function settledReceipt(row: HeartbeatLedgerRow, now: number): string | undefined {
  if (row.state === "resolved") return "Already resolved.";
  if (row.state === "muted") return "Already muted: you won't hear about this again.";
  if (row.state === "snoozed" && row.snoozedUntil !== undefined && Date.parse(row.snoozedUntil) > now) return "Already snoozed.";
  return undefined;
}

export function createHeartbeatButtons(deps: HeartbeatButtonDependencies): {
  handleInteraction(input: { readonly actor: MemoryActor; readonly event: InboundEvent }): Promise<boolean>;
} {
  return {
    async handleInteraction({ actor, event }) {
      const match = HEARTBEAT_BUTTON.exec(event.interaction?.data ?? "");
      if (match === null) return false;
      const press = pressOf(
        deps.messaging,
        event,
        { press: "a heartbeat button press", message: "a heartbeat item's message" },
        deps.onDiagnostic,
      );
      const answer = press.answer;
      const now = deps.now();
      if (press.tooOld(now)) {
        await answer("This button press is too old to act on.");
        return true;
      }
      const row = await deps.repositories.heartbeats.itemByToken(match[1] ?? "");
      if (row === undefined) {
        await answer("This item is no longer available.");
        return true;
      }
      if (actor.workspaceId !== row.workspaceId || actor.principalId !== row.principalId) {
        await answer("Only the person this item is for can use its buttons.");
        return true;
      }
      if (match[2] === "o") {
        await answer(HEARTBEAT_OPEN_HINT);
        return true;
      }
      const settled = settledReceipt(row, Date.parse(now));
      if (settled !== undefined) {
        await answer(settled);
        return true;
      }
      const settle = (note: string): Promise<void> => press.settle(() => `${row.title}\n\n${note}`);
      const scope = { workspaceId: row.workspaceId, principalId: row.principalId, itemId: row.itemId, now };
      try {
        if (match[2] === "s") {
          await deps.repositories.heartbeats.setItemState({
            ...scope,
            state: "snoozed",
            snoozedUntil: new Date(Date.parse(now) + SNOOZE_MS).toISOString(),
          });
          await answer("Snoozed for an hour.");
          await settle("Snoozed for an hour");
        } else {
          await deps.repositories.heartbeats.setItemState({ ...scope, state: "muted" });
          await answer("Muted: you won't hear about this again.");
          await settle("Muted");
        }
      } catch (error) {
        await answer(errorMessage(error).slice(0, 190));
      }
      return true;
    },
  };
}
