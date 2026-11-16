/**
 * The page's optional storage: a reader's conveniences (a width, a tab, what
 * was seen) kept in this browser's `localStorage` — or the tab's
 * `sessionStorage` — when it can be. A private window, blocked site data or a
 * full store throws, and then nothing is kept: every read here answers
 * `undefined` and every write is dropped, so the page works without it.
 * Tests hand their own `storage`.
 */

/** Which of the browser's stores, or one a test hands in. */
export type StorageArea<S> = S | "local" | "session";

function storeOf<S>(storage: StorageArea<S>): S | Storage | undefined {
  if (typeof storage === "object") return storage;
  if (typeof window === "undefined") return undefined;
  return storage === "session" ? window.sessionStorage : window.localStorage;
}

/** What is stored under `key`, or `undefined`: nothing, or no storage to read. */
export function readStored(key: string, storage: StorageArea<Pick<Storage, "getItem">> = "local"): string | undefined {
  try {
    return storeOf(storage)?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Keep `value` under `key`, when there is storage to keep it in. */
export function writeStored(key: string, value: string, storage: StorageArea<Pick<Storage, "setItem">> = "local"): void {
  try {
    storeOf(storage)?.setItem(key, value);
  } catch {
    /* Optional storage */
  }
}

/** The JSON stored under `key`, parsed, or `undefined`: nothing, no storage, or text that is not JSON. */
export function readStoredJson(key: string, storage: StorageArea<Pick<Storage, "getItem">> = "local"): unknown {
  const raw = readStored(key, storage);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Keep `value` as JSON under `key`, when there is storage to keep it in. */
export function writeStoredJson(key: string, value: unknown, storage: StorageArea<Pick<Storage, "setItem">> = "local"): void {
  writeStored(key, JSON.stringify(value), storage);
}

/** Forget what is stored under `key`, when there is storage to forget it from. */
export function removeStored(key: string, storage: StorageArea<Pick<Storage, "removeItem">> = "local"): void {
  try {
    storeOf(storage)?.removeItem(key);
  } catch {
    /* Optional storage */
  }
}
