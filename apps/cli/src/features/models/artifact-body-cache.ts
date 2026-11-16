/**
 * The artifact bodies `runtime/models.ts` sends a model — an image
 * `artifacts.view_image` named, `pdf.view`'s document, a whole video — kept
 * between steps, so a run that re-sends the same file every step does not
 * read it from storage again each time. Only the body is kept: the record
 * (its review state, whether a model may see it) is read again on every
 * step, and a body is served only for the record's own `sha256`.
 */

/** The bytes the cache holds at most: three files at the views' 20 MiB cap, or a dozen images at theirs. */
const ARTIFACT_BODY_CACHE_BYTES = 64 * 1024 * 1024;

interface Entry {
  readonly sha256: string;
  readonly data: Uint8Array;
}

/**
 * Bodies by artifact id, least recently read dropped first past `maxBytes`;
 * a body larger than that is never kept. A read that a `delete` or `clear`
 * overtook while it loaded is not kept (it may have read what was erased).
 */
export class ArtifactBodyCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maxBytes: number;
  #bytes = 0;
  #epoch = 0;

  constructor(maxBytes = ARTIFACT_BODY_CACHE_BYTES) {
    this.#maxBytes = maxBytes;
  }

  /** The bytes held now. */
  get bytes(): number {
    return this.#bytes;
  }

  /**
   * The body of `artifact`, an artifact its caller has just read and found
   * sendable: the kept one when it was kept for this `sha256`, else `load`'s.
   */
  async read(
    artifact: { readonly artifactId: string; readonly sha256: string },
    load: () => Promise<Uint8Array | undefined>,
  ): Promise<Uint8Array | undefined> {
    const kept = this.#entries.get(artifact.artifactId);
    if (kept !== undefined && kept.sha256 === artifact.sha256) {
      // Read again: moved to the most recent end.
      this.#entries.delete(artifact.artifactId);
      this.#entries.set(artifact.artifactId, kept);
      return kept.data;
    }
    if (kept !== undefined) this.#drop(artifact.artifactId);
    const epoch = this.#epoch;
    const data = await load();
    if (data === undefined || epoch !== this.#epoch || data.byteLength > this.#maxBytes) return data;
    this.#drop(artifact.artifactId);
    this.#entries.set(artifact.artifactId, { sha256: artifact.sha256, data });
    this.#bytes += data.byteLength;
    for (const [artifactId] of this.#entries) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#drop(artifactId);
    }
    return data;
  }

  delete(artifactIds: readonly string[]): void {
    this.#epoch += 1;
    for (const artifactId of artifactIds) this.#drop(artifactId);
  }

  clear(): void {
    this.#epoch += 1;
    this.#entries.clear();
    this.#bytes = 0;
  }

  #drop(artifactId: string): void {
    const entry = this.#entries.get(artifactId);
    if (entry === undefined) return;
    this.#entries.delete(artifactId);
    this.#bytes -= entry.data.byteLength;
  }
}

/** What a settled database request (`DatabaseClient.onSettled`) took from the artifacts a model may be sent. */
export type ArtifactBodyWrite = { readonly kind: "artifacts"; readonly artifactIds: readonly string[] } | { readonly kind: "all" };

/** A method that may take artifacts with it: a chat's `forget`, `pruneVideo`, a sender's `forgetSender`. */
const REMOVES = /erase|prune|purge|forget|delete|remove/i;

/**
 * Whether a settled request erased, pruned or reviewed artifacts: an erasure
 * or review names its artifacts; a prune (by age) may have taken any, as may
 * any other request whose method removes something.
 */
export function artifactBodyWrite(operation: string, input: unknown): ArtifactBodyWrite | undefined {
  const first = Array.isArray(input) ? (input[0] as unknown) : undefined;
  if (operation === "store.pruneArtifacts") return { kind: "all" };
  if (operation === "store.eraseArtifacts")
    return Array.isArray(first) ? { kind: "artifacts", artifactIds: first.filter((id) => typeof id === "string") } : { kind: "all" };
  if (operation === "store.setReviewState" || operation === "repository.artifacts.setReviewState") {
    const artifactId = (first as { readonly artifactId?: unknown } | undefined)?.artifactId;
    return typeof artifactId === "string" ? { kind: "artifacts", artifactIds: [artifactId] } : { kind: "all" };
  }
  return REMOVES.test(operation.split(".").at(-1) ?? "") ? { kind: "all" } : undefined;
}
