import type { ClientEvent, IpcCursor } from "@tavi/contracts";

/**
 * Where a client keeps each task's cursor: the last event it delivered.
 * The client writes it on every event and resubscribes from it
 * after a reconnect; a host that wants cursors to outlive the process supplies
 * a store that persists them, and subscribes `from` what it reads back.
 */
export interface CursorStore {
  get(taskId: string): IpcCursor | undefined;
  set(taskId: string, cursor: IpcCursor): void;
}

/** A store that lives as long as the client: what a reconnect needs, and no more. */
export function memoryCursorStore(): CursorStore {
  const cursors = new Map<string, IpcCursor>();
  return {
    get: (taskId) => cursors.get(taskId),
    set: (taskId, cursor) => {
      cursors.set(taskId, cursor);
    },
  };
}

/**
 * Whether a subscription at `cursor` has already delivered `event`.
 *
 * True only within one epoch: a cursor from another owner session says nothing
 * about this one's numbering. A `resync.required` is never "seen" — it shares
 * its sequence with the stream's last real event, and it is a reset, not an
 * entry of the stream.
 */
export function alreadyDelivered(event: ClientEvent, cursor: IpcCursor | undefined): boolean {
  return cursor !== undefined && event.kind !== "resync.required" && event.epoch === cursor.epoch && event.sequence <= cursor.sequence;
}
