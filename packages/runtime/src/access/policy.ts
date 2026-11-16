import { SecretAccessError, TaviError, type AccessPolicyPort, type InvocationContext, type SecretStorePort } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { privacyProblem, privateExpectation } from "@tavi/node-kit";

export interface WorkspaceGrant {
  readonly workspaceId: string;
  readonly principalId: string;
  /** Permission scopes the workspace operator granted. */
  readonly permissions: readonly string[];
}

/**
 * Trusted access/policy implementation.
 *
 * Missing policy denies execution: an unknown workspace is not "open", and a
 * permission not explicitly granted is not implied. Every service owns its own
 * authorization; this port is the shared source of grants.
 */
export class AccessPolicy implements AccessPolicyPort {
  readonly #grants = new Map<string, WorkspaceGrant>();
  /** The people the operator allowed in each workspace, under principals of their own (Allowed people). */
  #people = new Map<string, ReadonlySet<string>>();

  constructor(grants: readonly WorkspaceGrant[]) {
    for (const grant of grants) {
      if (this.#grants.has(grant.workspaceId)) {
        throw new TaviError("DUPLICATE", `Duplicate workspace grant for ${grant.workspaceId}`);
      }
      this.#grants.set(grant.workspaceId, {
        workspaceId: grant.workspaceId,
        principalId: grant.principalId,
        permissions: [...grant.permissions],
      });
    }
  }

  resolveWorkspace(workspaceId: string): { readonly principalId: string } | undefined {
    const grant = this.#grants.get(workspaceId);
    return grant === undefined ? undefined : { principalId: grant.principalId };
  }

  /** Every workspace this owner serves, in grant order. */
  workspaceIds(): readonly string[] {
    return [...this.#grants.keys()];
  }

  /**
   * The people allowed in a workspace besides its principal, as its bindings
   * name them now: each acts with the workspace's grant, under a principal of
   * its own. Replaces the workspace's list; an empty one takes them all away.
   */
  setPeople(workspaceId: string, principalIds: Iterable<string>): void {
    this.#people.set(workspaceId, new Set(principalIds));
  }

  /** The people allowed in a workspace besides its principal. */
  peopleOf(workspaceId: string): readonly string[] {
    return [...(this.#people.get(workspaceId) ?? [])];
  }

  /** Whether the principal acts in the workspace: its own principal, or a person allowed there. */
  actsIn(workspaceId: string, principalId: string): boolean {
    const grant = this.#grants.get(workspaceId);
    if (grant === undefined) return false;
    return grant.principalId === principalId || this.#people.get(workspaceId)?.has(principalId) === true;
  }

  permissionsFor(workspaceId: string): readonly string[] {
    return this.#grants.get(workspaceId)?.permissions ?? [];
  }

  /**
   * Authorization for an invocation.
   *
   * Returns the missing permissions rather than throwing so callers can report a
   * typed `NOT_AUTHORIZED` error and never leak whether the object exists.
   */
  missingPermissions(context: InvocationContext, required: readonly string[]): readonly string[] {
    const grant = this.#grants.get(context.workspaceId);
    if (grant === undefined) return [...required];
    if (!this.actsIn(context.workspaceId, context.principalId)) return [...required];
    const granted = new Set(grant.permissions);
    return required.filter((permission) => !granted.has(permission));
  }

  /** Effective invocation context, or a typed denial. */
  authorize(context: InvocationContext, required: readonly string[]): TaviError | undefined {
    const missing = this.missingPermissions(context, required);
    if (missing.length === 0) return undefined;
    return new TaviError("NOT_AUTHORIZED", "The caller is not authorized for this operation", {
      details: { missingPermissions: missing },
    });
  }
}

/** A single credential binding: a literal value or a file read at resolve time. */
export type SecretBinding = { readonly fromFile: string } | { readonly value: string };

export interface SecretReaderOptions {
  /**
   * Explicit per-reference bindings. A reference with no binding is treated as
   * absent (`null`); a reference that is bound but unreadable is a typed error.
   */
  readonly bindings: Readonly<Record<string, SecretBinding>>;
}

/**
 * Non-Electron `SecretStore` for the headless launcher.
 *
 * Credential material is never stored in the settings database, argv or logs;
 * this reader only resolves explicitly bound references on demand.
 */
export function createSecretReader(options: SecretReaderOptions): SecretStorePort {
  return {
    // Read-only by contract: an explicit binding list has no rotation path, so a
    // caller that needs to write asks for a writable store instead.
    access: "read-only",
    async getSecret(keyRef: string): Promise<string | null> {
      const binding = options.bindings[keyRef];
      if (binding === undefined) return null;
      if ("value" in binding) {
        const value = binding.value.trim();
        // An empty binding is a misconfiguration, not a credential: reporting it
        // as absent produces the typed missing-configuration outcome
        // instead of a confusing provider authentication failure.
        return value === "" ? null : value;
      }
      return readSecretFile(keyRef, binding.fromFile);
    },
  };
}

/**
 * Read a file-backed credential binding.
 *
 * The single owner of the read/trim/typed-failure behavior; the composition root
 * uses this reader rather than duplicating the logic.
 *
 * A file that exists but holds no value is a typed failure, not an absent
 * credential: the operator did declare a source, and
 * unattended mode must fail clearly when a declared source is unavailable. The
 * common cause is `printf '%s' "$UNSET_VAR" > file`, so the message says so.
 */
export async function readSecretFile(keyRef: string, path: string): Promise<string> {
  const { readFile, lstat } = await import("node:fs/promises");
  // The same rules the credential-directory store applies: a symlink could
  // redirect the read, and a file other accounts can read is a leak. Applying
  // them in one reader is what keeps every binding path equivalent.
  const stats = await lstat(path).catch((error: unknown) => {
    throw new SecretAccessError(
      `Credential reference ${keyRef} is bound to ${path}, which could not be read: ${errorMessage(error)}`,
      "UNAVAILABLE",
    );
  });
  if (stats.isSymbolicLink()) {
    throw new SecretAccessError(`Credential reference ${keyRef} points at a symlink; refusing to follow it`, "NOT_AUTHORIZED");
  }
  const shared = privacyProblem(path, stats);
  if (shared !== undefined) {
    throw new SecretAccessError(
      `Credential file for ${keyRef} is readable by other users (${shared}); ${privateExpectation("600")}`,
      "NOT_AUTHORIZED",
    );
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new SecretAccessError(
      `Credential reference ${keyRef} is bound to ${path}, which could not be read: ${errorMessage(error)}`,
      "UNAVAILABLE",
    );
  }
  const value = raw.trim();
  // An encrypted credential file is ciphertext, not the secret: bound as one,
  // it would be sent to a provider as the key.
  if (value.startsWith("tavi-enc:")) {
    throw new SecretAccessError(
      `Credential reference ${keyRef} is bound to ${path}, which holds an encrypted credential; bind a file with the plain value, or let the credentials directory resolve it`,
      "INVALID_INPUT",
    );
  }
  if (value === "") {
    throw new SecretAccessError(
      `Credential reference ${keyRef} is bound to ${path}, but that file is empty. ` +
        "Check that the variable you wrote it from is actually set " +
        '(for example `printf %s "$OPENAI_API_KEY" > file` writes an empty file when the variable is unset).',
      "UNAVAILABLE",
    );
  }
  return value;
}

/**
 * Environment-backed bindings for development.
 *
 * This is an explicit, named binding list, never an ambient fallback: only the
 * environment variables an operator named in configuration are consulted.
 */
export function createSecretReaderFromEnv(
  referenceToEnvVar: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv = process.env,
): SecretStorePort {
  return {
    access: "read-only",
    async getSecret(keyRef: string): Promise<string | null> {
      const envVar = referenceToEnvVar[keyRef];
      if (envVar === undefined) return null;
      const value = env[envVar];
      return value === undefined || value === "" ? null : value;
    },
  };
}
