/**
 * What `runtime/models.ts` remembers of a chat's locality between reads, so
 * a turn and every memory read it makes do not ask the database again: each
 * memo is dropped when a write that could change what it holds settles.
 */

/** The most entries one memo keeps; past it the oldest is dropped (a memo per chat would otherwise grow with every chat touched). */
const MEMO_ENTRIES = 1024;

/**
 * Reads remembered by key. A read that rejects is not kept (its caller's
 * fail-closed answer is never remembered), nor one that a `delete` or `clear`
 * overtook while it ran: it may have read what the write replaced.
 */
export class SettledMemo<K, V> {
  readonly #values = new Map<K, V>();
  #epoch = 0;

  /** The remembered value for `key`, else `load`'s, kept unless `keep` says it may not be (a degraded read). */
  async read(key: K, load: () => Promise<V>, keep: (value: V) => boolean = () => true): Promise<V> {
    if (this.#values.has(key)) return this.#values.get(key) as V;
    const epoch = this.#epoch;
    const value = await load();
    if (epoch === this.#epoch && keep(value)) this.#remember(key, value);
    return value;
  }

  /**
   * `read` for many keys at once: the remembered values, and one `load` of all the others. What `load`
   * answers is kept as `read` keeps it; a key it leaves out is not in the answer, and a `load` that
   * rejects rejects the whole call, keeping nothing.
   */
  async readMany(keys: readonly K[], load: (missing: readonly K[]) => Promise<ReadonlyMap<K, V>>): Promise<ReadonlyMap<K, V>> {
    const values = new Map<K, V>();
    const missing: K[] = [];
    for (const key of new Set(keys)) {
      if (this.#values.has(key)) values.set(key, this.#values.get(key) as V);
      else missing.push(key);
    }
    if (missing.length === 0) return values;
    const epoch = this.#epoch;
    const loaded = await load(missing);
    for (const key of missing) {
      if (!loaded.has(key)) continue;
      const value = loaded.get(key) as V;
      values.set(key, value);
      if (epoch === this.#epoch) this.#remember(key, value);
    }
    return values;
  }

  #remember(key: K, value: V): void {
    if (this.#values.size >= MEMO_ENTRIES) this.#values.delete(this.#values.keys().next().value as K);
    this.#values.set(key, value);
  }

  delete(key: K): void {
    this.#epoch += 1;
    this.#values.delete(key);
  }

  clear(): void {
    this.#epoch += 1;
    this.#values.clear();
  }
}

/** The model configuration reads: every other `modelConfig` operation may change a connection's, a role's or a default's locality. */
const MODEL_CONFIG_READS = new Set([
  "listConnections",
  "getConnection",
  "referencedConnectionIds",
  "listCatalog",
  "getWorkspaceDefault",
  "listRoleBindings",
  "getRoleBinding",
  "resolveRole",
]);

/** What a settled database request may have changed of a chat's locality. */
export type LocalityWrite =
  | { readonly kind: "config" }
  | { readonly kind: "routes" }
  | { readonly kind: "attempts"; readonly runId: string | undefined };

/**
 * Whether a settled request (`DatabaseClient.onSettled`) may have changed
 * what the locality memos hold: a model configuration write, a saved
 * route, or a run's recorded (or deleted) attempts.
 */
export function localityWrite(operation: string, input: unknown): LocalityWrite | undefined {
  const config = /^(?:repository|service)\.modelConfig\.(\w+)$/.exec(operation);
  if (config !== null) return MODEL_CONFIG_READS.has(config[1] ?? "") ? undefined : { kind: "config" };
  if (operation === "service.router.saveRoute" || operation === "service.router.chooseRoute") return { kind: "routes" };
  // An attempt is recorded by `begin`, or by `beginPriced` (the model step's, which prices it in the same request).
  if (operation === "service.accounting.begin" || operation === "service.accounting.beginPriced") {
    const attempt = Array.isArray(input) ? (input[0] as { readonly runId?: unknown } | undefined) : undefined;
    return { kind: "attempts", runId: typeof attempt?.runId === "string" ? attempt.runId : undefined };
  }
  if (operation === "service.accounting.deleteRun") {
    const runId = Array.isArray(input) ? input[0] : undefined;
    return { kind: "attempts", runId: typeof runId === "string" ? runId : undefined };
  }
  return undefined;
}
