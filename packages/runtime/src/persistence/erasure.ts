import type { Database } from "./sqlite-loader.js";

/** Per connection: what its owner does once something a person asked to forget was erased on it. */
const listeners = new WeakMap<Database, () => void>();

/** Called by the store that opened `db`; a second call replaces the first. */
export function onErasure(db: Database, listener: () => void): void {
  listeners.set(db, listener);
}

/**
 * Says that words a person asked to forget were deleted on `db` (a memory
 * forget, a chat's history forgotten or rewound, a chat's checkpoints deleted).
 * `secure_delete` has already zeroed them in the pages the deletion wrote; the
 * store then truncates the write-ahead log, whose older frames may still hold
 * them (`SqliteStore.scrubErased`). Safe inside a transaction: nothing runs
 * until the store's own timer fires, between operations.
 */
export function noteErasure(db: Database): void {
  listeners.get(db)?.();
}
