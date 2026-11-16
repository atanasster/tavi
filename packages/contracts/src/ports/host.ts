import type { TaviErrorCode } from "../errors.js";
import type { InvocationContext } from "./invocation.js";

/**
 * Credential access.
 *
 * `null` means the reference is absent. Locked, unavailable or denied storage
 * returns a typed error instead of masquerading as a missing key.
 */
export type SecretReaderPort = {
  getSecret(keyRef: string): Promise<string | null>;
};

/**
 * A secret source, with mutability in the type rather than an always-throwing
 * setter on every reader.
 *
 * Mutability is a backend capability: a service-manager-injected credential
 * directory is read-only because rotation belongs to the service manager, while
 * a session store is writable because its contents are transient. A caller that
 * needs to write asks for the read-write variant; the service boundary refuses a
 * forged write to a read-only store.
 */
export type SecretStorePort = SecretReaderPort &
  (
    | { readonly access: "read-only" }
    | {
        readonly access: "read-write";
        setSecret(keyRef: string, secret: string): Promise<void>;
        deleteSecret(keyRef: string): Promise<void>;
      }
  );

/**
 * Where a secret source gets its values; safe to advertise to an attached client.
 *
 * `chain` describes several sources consulted in order (an injected credential
 * directory, then declared launcher bindings), which is what the headless
 * composition actually uses.
 */
export type SecretSourceKind = "file" | "environment" | "session" | "chain";

/**
 * Non-secret metadata about the active secret source.
 *
 * Settings and attached clients use this to disable unsupported writes before
 * asking for a secret, and to explain which owner holds the binding
 * ("attached-client credential ownership"). It never carries a value.
 */
export interface SecretSourceCapability {
  readonly access: "read-only" | "read-write";
  readonly kind: SecretSourceKind;
  readonly writable: boolean;
  /** Operator-facing description; must not include a path or a value. */
  readonly description: string;
}

export { SECRET_KEY_REF_PATTERN, assertSecretKeyRef } from "../ids.js";

export class SecretAccessError extends Error {
  readonly code: TaviErrorCode;

  constructor(message: string, code: TaviErrorCode = "NOT_AUTHORIZED") {
    super(message);
    this.name = "SecretAccessError";
    this.code = code;
  }
}

export type AccessPolicyPort = {
  /** Resolve the effective policy for a workspace; policy itself is trusted data. */
  resolveWorkspace(workspaceId: string): { readonly principalId: string } | undefined;
  /** Returns the list of missing permissions, empty when the call is allowed. */
  missingPermissions(context: InvocationContext, required: readonly string[]): readonly string[];
};

export type LoggerPort = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

/** Clock and id generation are injected so plugins stay deterministic in tests. */
export type ClockPort = {
  now(): string;
  /** Monotonic epoch id for a client stream. */
  newEpochId(): string;
  newId(prefix: string): string;
};
