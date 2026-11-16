import { TaviError } from "./errors.js";

/**
 * What a provider's failure says about the work that met it.
 *
 * - `credentials`: a model or tool could not authenticate. Trying again changes
 *   nothing until someone fixes the key, so it is never retried.
 * - `transient`: a rate limit, or a provider fault the transport declared
 *   retryable. The same work is worth trying again a little later.
 *
 * Anything else — a model that answered badly, a request the provider refused,
 * a billing limit — is no provider weather, and has no class.
 */
export type ProviderFailureClass = "credentials" | "transient";

/** What one settled call says: a failure class, or `ok` for a call that completed. */
export type ProviderObservation = ProviderFailureClass | "ok";

/** Codes a model adapter or credential resolution uses for a missing or rejected credential. */
const CREDENTIAL_CODES: ReadonlySet<string> = new Set(["NOT_AUTHORIZED", "NOT_CONFIGURED"]);

/**
 * What a model call's outcome says: `ok` when it completed, a class for an
 * authentication failure, a rate limit or a retryable provider fault, and
 * nothing for any other failure.
 */
export function modelOutcomeObservation(outcome: {
  readonly status: string;
  readonly error?: { readonly code: string; readonly retryable?: boolean } | undefined;
}): ProviderObservation | undefined {
  if (outcome.status === "completed") return "ok";
  const failure = outcome.error;
  if (failure?.code === "auth") return "credentials";
  if (failure?.code === "rate_limit" || (failure?.code === "provider" && failure.retryable === true)) return "transient";
  return undefined;
}

/** What a thrown error says: a missing or rejected credential, or nothing. */
export function thrownProviderObservation(error: unknown): ProviderFailureClass | undefined {
  return error instanceof TaviError && CREDENTIAL_CODES.has(error.code) ? "credentials" : undefined;
}

/**
 * Add one observation to what a piece of work's providers reported, by role.
 *
 * A credential failure is sticky: it explains whatever fails after it. A
 * transient one is cleared by the role's next success, so a rate limit the
 * fallback model recovered from never excuses a later real failure.
 */
export function noteProviderObservation(
  roles: Map<string, ProviderFailureClass>,
  role: string,
  observation: ProviderObservation | undefined,
): void {
  if (observation === undefined) return;
  if (observation === "ok") {
    if (roles.get(role) === "transient") roles.delete(role);
  } else if (roles.get(role) !== "credentials") roles.set(role, observation);
}

/** How the work's failure classes add up: a credential failure outweighs a transient one. */
export function providerFailureOf(roles: ReadonlyMap<string, ProviderFailureClass> | undefined): ProviderFailureClass | undefined {
  const values = [...(roles?.values() ?? [])];
  if (values.includes("credentials")) return "credentials";
  return values.includes("transient") ? "transient" : undefined;
}

/** How many pieces of work a `ProviderFailureLog` remembers at once. */
const LOGGED_WORK = 256;

/**
 * What the providers under each piece of work (a task, keyed by its id)
 * reported, for a reader that asks once the work has ended. Only work with a
 * failure to remember holds an entry, and the oldest are forgotten past a
 * bound, so work nobody asks about costs nothing for long.
 */
export class ProviderFailureLog {
  readonly #work = new Map<string, Map<string, ProviderFailureClass>>();

  /** Add one settled call's observation, for `key`'s `role`. */
  note(key: string, role: string, observation: ProviderObservation | undefined): void {
    if (observation === undefined) return;
    let roles = this.#work.get(key);
    if (roles === undefined) {
      if (observation === "ok") return;
      roles = new Map();
      this.#work.set(key, roles);
      for (const oldest of this.#work.keys()) {
        if (this.#work.size <= LOGGED_WORK) break;
        this.#work.delete(oldest);
      }
    }
    noteProviderObservation(roles, role, observation);
    if (roles.size === 0) this.#work.delete(key);
  }

  /** What `key`'s providers came to, forgotten once read. */
  take(key: string): ProviderFailureClass | undefined {
    const roles = this.#work.get(key);
    this.#work.delete(key);
    return providerFailureOf(roles);
  }
}
