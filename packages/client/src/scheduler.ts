/**
 * Time, as the client's host provides it.
 *
 * The root entry compiles with no host library, so it cannot name
 * `setTimeout`: reconnect backoff and request deadlines take a `Scheduler`, and
 * each host entry supplies one over its own timers. A test supplies a manual
 * one, so time-bound behaviour is checked without waiting for it.
 */
export interface Scheduler {
  /** Run `callback` once after `ms` milliseconds; the returned function cancels it (a no-op once it has run). */
  delay(ms: number, callback: () => void): () => void;
}
