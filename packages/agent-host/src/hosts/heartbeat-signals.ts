import {
  HEARTBEAT_LIMITS,
  HeartbeatSignalSchema,
  heartbeatCollected,
  PLUGIN_STATE_MAX_CHARS,
  TaviError,
  redactToolOutput,
  type HeartbeatProvider,
  type HeartbeatReceive,
  type HeartbeatSignal,
  type HeartbeatSignalSource,
  type MemoryExcerpt,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

/**
 * What a heartbeat tick looks at: the registered providers and signal
 * sources, each provider's small saved state, and the signals collected from
 * the sources (bounded, deduplicated and redacted) with the memory excerpts
 * it may read.
 */

/** How a provider was installed: built in, or by an approved plugin. */
export interface HeartbeatProviderEntry {
  readonly provider: HeartbeatProvider;
  readonly kind: "builtin" | "plugin";
  readonly receives: readonly HeartbeatReceive[];
  readonly usesTurns: boolean;
  readonly maxTickSeconds: number;
  /** Loaded by `serve --dev-plugin`: its reloads get a grace, and its ticks are marked. */
  readonly dev?: boolean;
  /** Its plugin's lifetime: aborted when the plugin stops, which stops a tick it is answering. */
  readonly signal?: AbortSignal;
}

/** How long a dev provider's reload may leave it missing before its heartbeats pause. */
export const HEARTBEAT_DEV_RELOAD_GRACE_MS = 30_000;

/** The providers that may answer a heartbeat, by plugin id; withdrawn when their plugin stops. */
export class HeartbeatProviderRegistry {
  readonly #entries = new Map<string, HeartbeatProviderEntry>();
  /** Dev providers withdrawn lately, by when their grace ends: a save reloads them, and nothing pauses meanwhile. */
  readonly #reloading = new Map<string, number>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  install(id: string, entry: HeartbeatProviderEntry): () => void {
    this.#entries.set(id, entry);
    this.#reloading.delete(id);
    return () => {
      if (this.#entries.get(id) !== entry) return;
      this.#entries.delete(id);
      if (entry.dev === true) this.#reloading.set(id, this.#now().getTime() + HEARTBEAT_DEV_RELOAD_GRACE_MS);
    };
  }

  get(id: string): HeartbeatProviderEntry | undefined {
    return this.#entries.get(id);
  }

  /** Whether `id` is a dev provider between a withdrawal and its reload, within the grace. */
  reloading(id: string): boolean {
    const until = this.#reloading.get(id);
    if (until === undefined) return false;
    if (this.#now().getTime() < until) return true;
    this.#reloading.delete(id);
    return false;
  }

  ids(): readonly string[] {
    return [...this.#entries.keys()];
  }

  /** Every installed provider, with its id. */
  list(): readonly (HeartbeatProviderEntry & { readonly id: string })[] {
    return [...this.#entries.entries()].map(([id, entry]) => ({ ...entry, id }));
  }
}

/**
 * The signal sources the host collects from: built-in and plugin ones
 * alike, each under its id, which prefixes its keys so no source can stand in
 * for another's signal. Withdrawn when their plugin stops.
 */
interface HeartbeatSignalEntry {
  readonly source: HeartbeatSignalSource;
  readonly kind: "builtin" | "plugin";
  readonly label?: string;
}

export class HeartbeatSignalRegistry {
  readonly #sources = new Map<string, HeartbeatSignalEntry>();

  /** `label` is what *Signal sources* names a plugin's source by; a built-in's is the canvas's own. */
  install(id: string, source: HeartbeatSignalSource, kind: "builtin" | "plugin", label?: string): () => void {
    const entry: HeartbeatSignalEntry = label === undefined ? { source, kind } : { source, kind, label };
    this.#sources.set(id, entry);
    return () => {
      if (this.#sources.get(id) === entry) this.#sources.delete(id);
    };
  }

  list(): readonly (HeartbeatSignalEntry & { readonly id: string })[] {
    return [...this.#sources.entries()].map(([id, entry]) => ({ id, ...entry }));
  }
}

/** What a provider may publish for its panel: this many keys a person, the newest kept. */
export const HEARTBEAT_PROVIDER_STATE_KEYS = 16;
const PROVIDER_STATE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * What each provider published for its own panel in Center → Heartbeat,
 * per person and provider: in memory, so a restart shows nothing until its
 * next check publishes again.
 */
export class HeartbeatProviderStates {
  readonly #values = new Map<string, Map<string, unknown>>();

  /** Validate and keep one value: masked, JSON within the plugin state limit, the oldest key dropped past the limit. */
  publish(scope: { readonly workspaceId: string; readonly principalId: string }, providerId: string, key: string, value: unknown): void {
    if (typeof key !== "string" || !PROVIDER_STATE_KEY.test(key))
      throw new TaviError("INVALID_INPUT", "a published key is 1-64 letters, digits, dots, dashes or underscores");
    let json: string | undefined;
    try {
      json = JSON.stringify(redactToolOutput(value ?? null).value);
    } catch {
      json = undefined;
    }
    if (json === undefined || json.length > PLUGIN_STATE_MAX_CHARS)
      throw new TaviError("INVALID_INPUT", `a published value is JSON of at most ${PLUGIN_STATE_MAX_CHARS} characters`);
    const slot = `${scope.workspaceId}\u0000${scope.principalId}\u0000${providerId}`;
    const values = this.#values.get(slot) ?? new Map<string, unknown>();
    values.delete(key);
    values.set(key, JSON.parse(json) as unknown);
    while (values.size > HEARTBEAT_PROVIDER_STATE_KEYS) {
      const oldest = values.keys().next().value;
      if (oldest === undefined) break;
      values.delete(oldest);
    }
    this.#values.set(slot, values);
  }

  /** What `providerId` published for this person, by key; undefined for nothing. */
  get(workspaceId: string, principalId: string, providerId: string): Readonly<Record<string, unknown>> | undefined {
    const values = this.#values.get(`${workspaceId}\u0000${principalId}\u0000${providerId}`);
    return values === undefined || values.size === 0 ? undefined : Object.fromEntries(values);
  }

  /** Forget everything published for this person (Forget heartbeat history). */
  forget(workspaceId: string, principalId: string): void {
    const prefix = `${workspaceId}\u0000${principalId}\u0000`;
    for (const slot of this.#values.keys()) if (slot.startsWith(prefix)) this.#values.delete(slot);
  }
}

/** One collection: the bounded, redacted signals, the sources that failed or answered badly, and those whose earlier signals must stay seen. */
export interface HeartbeatCollection {
  readonly signals: readonly HeartbeatSignal[];
  readonly errors: readonly { readonly source: string; readonly error: string }[];
  /** Sources that failed or were cut short: their key prefixes, kept seen (`observeSignals` `keep`). */
  readonly incomplete: readonly string[];
  /** The sources that answered this time (`observeSignals` `sources`): only theirs are seeded or can be gone. */
  readonly sources: readonly string[];
  /** Sources whose signals leave by age (`retracts: false`): a key gone from one resolves nothing. */
  readonly expiring: readonly string[];
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Outside words (a provider's error, its memo) with anything secret-shaped masked, and bounded. */
export function maskedText(text: string, max: number): string {
  return (redactToolOutput({ text }).value as { text: string }).text.slice(0, max);
}

/** Mask what reads like a secret in a signal's title and data (core masks tool results, not signals). */
/** A provider's memo as kept: masked, and only while it fits its 4 KiB once masked. */
export function storedMemo(memo: string): string | null {
  const masked = (redactToolOutput({ memo }).value as { memo: string }).memo;
  return new TextEncoder().encode(masked).length <= HEARTBEAT_LIMITS.memoBytes ? masked : null;
}

function redactSignal(signal: HeartbeatSignal): HeartbeatSignal | undefined {
  // A key is matched and stored as it is, so one that looks like a secret is left out rather than masked.
  if ((redactToolOutput({ key: signal.key }).value as { key: string }).key !== signal.key) return undefined;
  const { value } = redactToolOutput({ title: signal.title, source: signal.source, data: signal.data });
  const masked = value as { title: string; source: string; data?: unknown };
  return { ...signal, title: masked.title, source: masked.source, ...(signal.data === undefined ? {} : { data: masked.data }) };
}

/**
 * Collect every source once: each within 5 s, 50 signals and 32 KiB,
 * its keys prefixed by its id, every signal validated and redacted. A source
 * that throws, times out or answers badly is reported, never the tick's failure.
 */
export async function collectHeartbeatSignals(
  registry: HeartbeatSignalRegistry,
  input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly now: string;
    readonly timezone: string;
    readonly skip?: readonly string[];
  },
): Promise<HeartbeatCollection> {
  const signals: HeartbeatSignal[] = [];
  const errors: { source: string; error: string }[] = [];
  const incomplete: string[] = [];
  // A source the heartbeat turned off is not run; what it saw before stays seen, so nothing it found is taken for gone.
  const skip = new Set(input.skip ?? []);
  // One list for the whole collection: a source installed meanwhile waits for the next.
  const installed = registry.list();
  /** Sources that answered: only these are seeded, or can say a key is gone. */
  const answered: string[] = [];
  for (const { id } of installed) if (skip.has(id)) incomplete.push(`${id}:`);
  await Promise.all(
    installed
      .filter(({ id }) => !skip.has(id))
      .map(async ({ id, source }) => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const answer = await Promise.race([
            source.collect({
              workspaceId: input.workspaceId,
              principalId: input.principalId,
              now: input.now,
              timezone: input.timezone,
              signal: controller.signal,
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                controller.abort(new Error("the signal source ran past its time"));
                reject(new Error(`ran past ${HEARTBEAT_LIMITS.sourceDeadlineMs} ms`));
              }, HEARTBEAT_LIMITS.sourceDeadlineMs);
            }),
          ]);
          const collected = heartbeatCollected(JSON.parse(JSON.stringify(answer ?? [])));
          if (collected === undefined) throw new Error("did not answer a list of signals");
          answered.push(id);
          const raw = collected.signals;
          // It saw only part: what it found is used, and what it did not see stays seen.
          if (collected.incomplete) incomplete.push(`${id}:`);
          let bytes = 0;
          let invalid = 0;
          let secret = 0;
          let cut = raw.length > HEARTBEAT_LIMITS.signalsPerSource;
          for (const candidate of raw.slice(0, HEARTBEAT_LIMITS.signalsPerSource)) {
            const prefixed =
              candidate !== null && typeof candidate === "object" && typeof (candidate as { key?: unknown }).key === "string"
                ? { ...(candidate as Record<string, unknown>), key: `${id}:${(candidate as { key: string }).key}` }
                : candidate;
            const parsed = HeartbeatSignalSchema.safeParse(prefixed);
            if (!parsed.success) {
              invalid += 1;
              continue;
            }
            bytes += utf8Bytes(JSON.stringify(parsed.data));
            if (bytes > HEARTBEAT_LIMITS.sourceBytes) {
              cut = true;
              break;
            }
            const redacted = redactSignal(parsed.data);
            if (redacted === undefined) secret += 1;
            else signals.push(redacted);
          }
          if (secret > 0) errors.push({ source: id, error: `${secret} signal(s) whose key looked like a secret were left out` });
          if (invalid > 0) errors.push({ source: id, error: `${invalid} signal(s) outside the signal contract were left out` });
          // A signal left out (outside the contract, a secret-shaped key) is unseen, not gone: what it was stays seen.
          if (cut || invalid > 0 || secret > 0) {
            if (!collected.incomplete) incomplete.push(`${id}:`);
          }
          if (cut) {
            errors.push({
              source: id,
              error: `more than ${HEARTBEAT_LIMITS.signalsPerSource} signals or ${HEARTBEAT_LIMITS.sourceBytes} bytes; the rest were left out`,
            });
          }
        } catch (error) {
          incomplete.push(`${id}:`);
          errors.push({ source: id, error: errorMessage(error).slice(0, 200) });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }),
  );
  return {
    signals,
    errors,
    incomplete,
    sources: answered,
    expiring: installed.filter(({ id, source }) => answered.includes(id) && source.retracts === false).map(({ id }) => id),
  };
}

/** Bound and mask a tick's memory: at most 10 records and 4 KiB, secrets as placeholders. */
export function boundHeartbeatMemory(records: readonly MemoryExcerpt[]): readonly MemoryExcerpt[] {
  const kept: MemoryExcerpt[] = [];
  let bytes = 0;
  for (const record of records.slice(0, HEARTBEAT_LIMITS.memoryRecords)) {
    const text = redactToolOutput(record.text).value as string;
    bytes += utf8Bytes(text);
    if (bytes > HEARTBEAT_LIMITS.memoryBytes) break;
    kept.push({ ...record, text });
  }
  return kept;
}
