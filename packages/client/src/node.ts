/**
 * `@tavi/client/node` — the client, for a Node process.
 *
 * A superset of the root: it re-exports everything `@tavi/client` does, so a
 * Node consumer imports from one entry, and adds what only Node can supply —
 * the owner's published files, its Unix socket, and Node's timers. The owner's
 * endpoint is never derived here: it is read from the discovery record, afresh
 * before every connection attempt.
 */
import { createClient, type ClientOptions, type Dialer, type TaviClient } from "./client.js";
import { readOwner, type ReadOwnerOptions } from "./node/discovery.js";
import { isRetryableSocketError, openSocket, type OpenSocketOptions } from "./node/socket.js";
import type { Scheduler } from "./scheduler.js";

export * from "./index.js";
export { ownerFiles, readOwner, type ReadOwnerOptions } from "./node/discovery.js";
export { isRetryableSocketError, openSocket, socketChannel, type OpenSocketOptions } from "./node/socket.js";

/** Node's timers, as the root's `Scheduler`. */
export const nodeScheduler: Scheduler = {
  delay(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * Find the owner of `dataDirectory` through its discovery files (`discovery`:
 * how their privacy is judged), and reach it over its socket (`socket`: how).
 */
export function nodeDialer(dataDirectory: string, socket: OpenSocketOptions = {}, discovery: ReadOwnerOptions = {}): Dialer {
  return {
    discover: () => Promise.resolve().then(() => readOwner(dataDirectory, discovery)),
    open: (endpoint) => openSocket(endpoint, socket),
    retryable: isRetryableSocketError,
  };
}

/**
 * A connected client of the owner serving `dataDirectory`. Rejects as
 * `connect()` does — after every attempt failed, or at once for an owner that
 * speaks another protocol, with the documented remedy.
 */
export async function connectToOwner(
  dataDirectory: string,
  options: Omit<ClientOptions, "dialer" | "scheduler"> & {
    readonly socket?: OpenSocketOptions;
    readonly discovery?: ReadOwnerOptions;
  } = {},
): Promise<TaviClient> {
  const { socket, discovery, ...clientOptions } = options;
  const client = createClient({ ...clientOptions, dialer: nodeDialer(dataDirectory, socket, discovery), scheduler: nodeScheduler });
  await client.connect();
  return client;
}
