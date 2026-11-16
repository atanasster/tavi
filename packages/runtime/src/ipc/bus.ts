import {
  CLIENT_PROTOCOL_VERSION,
  ClientEventSchema,
  type ClientEvent,
  TaviError,
  type IpcCursor,
  type UnsequencedClientEvent,
  boundEventPayloads,
  utf8ByteLength,
} from "@tavi/contracts";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";

/**
 * Per-task event bus.
 *
 * Events are keyed by **task**, not by run: `runId` *is* the task id, and a task
 * spans many admissions (start, approval, reply, deadline, wake). A client
 * attaching between two admissions must see one continuous stream, so the
 * sequence is assigned here, per task, rather than by whichever admission
 * happened to produce the event.
 *
 * `epoch` is the owner session. A daemon restart therefore invalidates every
 * cursor: the events a client holds came from an epoch that no longer exists, and
 * the honest answer is `resync.required` rather than a silently discontinuous
 * stream.
 *
 * Rings are bounded by **encoded bytes**, never by event count: `text.delta.text`
 * is capped at 64 KiB *characters* by schema, which is up to ~192 KiB of UTF-8
 * before JSON escaping, so a count-based budget under-counts by an unbounded
 * factor.
 */

/** Bound on one task's retained ring, in encoded bytes. */
export const RUN_EVENT_RING_BYTES = 2 * 1024 * 1024;

/** Bound on every retained ring together, in encoded bytes. */
export const RUN_EVENT_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Bound on how many rings the bus keeps.
 *
 * An emptied or completed ring still costs an entry, and a long-lived daemon
 * sees an unbounded number of tasks, so the byte cap alone does not bound the
 * map. Beyond this, empty rings nobody watches go first, then completed rings,
 * then — as a last resort — the oldest ring nobody watches, whatever it holds
 * (a late attach to that task sees a truncated transcript and is told so). A
 * ring somebody watches is never evicted for count, so the bound holds whenever
 * fewer tasks than this are watched at once — which the IPC limits guarantee
 * (`IPC_MAX_CONNECTIONS` × `IPC_MAX_SUBSCRIPTIONS_PER_CONNECTION` is far below
 * it). Every evicted ring that published leaves a watermark, so its task keeps
 * its numbering.
 */
const RUN_EVENT_MAX_RINGS = 4096;

/** The encoded size of one event, measured rather than inferred. */
export function encodedEventBytes(event: ClientEvent): number {
  return utf8ByteLength(JSON.stringify(event));
}

export interface RunEventBusOptions {
  /** The owner session; becomes every event's `epoch`. */
  readonly epoch: string;
  readonly ringBytes?: number;
  readonly totalBytes?: number;
  readonly maxRings?: number;
  readonly now?: () => string;
  readonly newSubscriptionId?: () => string;
  readonly onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface RunEventSubscription {
  readonly subscriptionId: string;
  readonly taskId: string;
  /**
   * The last sequence this subscriber has — a reconnect cursor.
   *
   * `undefined` when it has nothing to resume from (it joined a stream that had
   * assigned no sequence yet and has received nothing since): reconnect with the
   * same `from` it subscribed with. Never `0` by default: a cursor at 0 means
   * "sequence 0 was seen", and replaying from it would skip that event —
   * typically the stream's `run.started`.
   */
  readonly delivered: () => number | undefined;
  unsubscribe(): void;
}

export interface SubscribeResult {
  readonly subscription: RunEventSubscription;
  /**
   * Events replayed from the ring, in order, before live delivery.
   *
   * Empty when the caller asked for "from now" (`from` absent) or when the cursor
   * has been evicted (`resync` is then set instead). The caller delivers these,
   * then `resync`, **before** any live event: the bus hands them back rather than
   * pushing them so a transport can order them after its own response.
   */
  readonly replayed: readonly ClientEvent[];
  /**
   * Present when the ring can no longer answer the cursor.
   *
   * A `resync.required` for **this subscriber only** — never published, so no
   * other subscriber of the task sees it and no later replay contains it.
   *
   * Its sequence is the stream's head: the last sequence assigned, which it
   * therefore *shares* with the last real event (retained or not). A client must
   * treat the marker as a reset of its state, never as an entry of it: keyed by
   * `(epoch, sequence)`, a later `"beginning"` replay would collide with it. A
   * client that stores the marker's sequence as its cursor is caught up, and the
   * next live event is numbered above it. For a stream that has assigned nothing
   * yet, one sequence is reserved for the marker, so the same holds.
   *
   * The prefix of the transcript is *not* recoverable; replay from the
   * checkpointed store is not implemented.
   */
  readonly resync: ClientEvent | null;
  /**
   * Whether the stream this subscriber receives is missing its beginning.
   *
   * True for a resync, and for a `"beginning"` replay that does not start at the
   * task's first event of this epoch — its ring was trimmed or evicted — or that
   * retains nothing although events were published. A late attach says so on
   * screen rather than presenting a transcript as whole.
   */
  readonly truncated: boolean;
}

/**
 * One retained event with the size measured when it was accepted.
 *
 * The size travels with the event rather than being recomputed at drop time, and
 * the event is a detached copy of what was measured (see `envelopeOf`), so a
 * producer that mutates its own object after `publish` changes neither.
 */
interface Retained {
  readonly event: ClientEvent;
  readonly bytes: number;
}

interface Ring {
  readonly taskId: string;
  events: Retained[];
  bytes: number;
  /** The next sequence this ring will assign. */
  sequence: number;
  /**
   * The first sequence this task assigns in this epoch, or `null` when earlier
   * history exists that this ring does not know the start of (it was recreated
   * from a watermark). What `truncated` is measured against.
   */
  firstSequence: number | null;
  /**
   * The sequence reserved for resync markers while the ring has assigned
   * nothing this epoch. Reserved once and shared: a second stale subscriber
   * reserving its own would leave the first one's next event a sequence
   * further on than its marker promised.
   */
  reservedMarker?: number;
  /** The attempt the newest event belongs to, for bus-generated markers. */
  lastAttemptId?: string;
  completed: boolean;
  /**
   * Monotonic ordering for eviction.
   *
   * `sequence` is not an age: a ring recreated after eviction starts above zero,
   * and a ring trimmed to its tail has a high first sequence, so ordering by it
   * would drop the *newest* data first. This counter is assigned when the ring is
   * created and is the only reliable "older than" comparison.
   */
  readonly bornAt: number;
  /** When the ring was marked completed, for completed-first ordering. */
  completedAt: number;
}

/** Whether a ring has assigned any sequence of its own this epoch. */
function hasAssigned(ring: Ring): boolean {
  return ring.firstSequence === null || ring.sequence > ring.firstSequence;
}

export interface RunEventBusStats {
  readonly tasks: number;
  readonly bytes: number;
  readonly subscriptions: number;
}

export interface RunEventBus {
  /** Validate, sequence and retain one event; deliver it to every subscriber. */
  publish(taskId: string, event: UnsequencedClientEvent): ClientEvent;
  subscribe(input: {
    readonly taskId: string;
    /**
     * Where to start.
     *
     * `undefined` means "from now" — the caller has nothing and wants only what
     * happens next. `"beginning"` replays everything still retained. A cursor
     * replays from that sequence, exclusive, or answers `resync.required` when
     * the ring can no longer honor it (a cursor cannot express "from the start":
     * `IpcCursorSchema.sequence` is non-negative).
     */
    readonly from?: IpcCursor | "beginning";
    readonly deliver: (event: ClientEvent) => void;
  }): SubscribeResult;
  /**
   * The task's stream position: the cursor of the newest event this epoch
   * assigned it, or `undefined` when its ring holds nothing a cursor could be
   * answered from (it never published here, or its ring was evicted). A
   * subscription `from` it yields exactly what is published after this call.
   */
  head(taskId: string): IpcCursor | undefined;
  /** Mark a task finished, so its ring is evicted before a live one's. */
  markCompleted(taskId: string): void;
  /**
   * The attempt the task's newest event named: what an event about the task
   * between its turns carries. `undefined` when the bus holds nothing for it.
   */
  lastAttempt(taskId: string): string | undefined;
  /**
   * What the task did last, as far as its retained events say: the newest
   * tool call's name, or the newest text block's tail, cut to `maxChars`.
   * `undefined` when the ring holds neither. A backwards scan of one ring,
   * for the agent tree's row; never a tool's input or output.
   */
  latestActivity(taskId: string, maxChars: number): { readonly kind: "tool" | "text"; readonly text: string } | undefined;
  /**
   * Call `listener` each time a task is marked finished (a turn that completed
   * or failed), whether or not its ring is still held. Returns how to stop.
   * The live browser view ends a task's streams on it.
   */
  onCompleted(listener: (taskId: string) => void): () => void;
  /**
   * Whether the bus still holds any event for the task in this epoch — false for
   * a task it never saw, or whose ring was evicted. A producer re-reporting a
   * recorded outcome (a replay) needs it only on an empty stream: one that holds
   * events already carries its own end, or the progress past it.
   */
  retains(taskId: string): boolean;
  /** Drop a task's ring entirely (its task record was deleted). */
  forget(taskId: string): void;
  /**
   * Let go of what a task's ring retains from before `before` (an instant), or
   * of all of it when absent (its chat's saved history was erased): a
   * late subscriber is no longer replayed it. The numbering and every attached
   * subscriber stay; one that resumes from an earlier cursor learns of the gap
   * from `truncated`/`resync`. Answers how many events went.
   */
  dropRetained(taskId: string, before?: string): number;
  stats(): RunEventBusStats;
}

/**
 * A byte-bounded, per-task event bus.
 *
 * One instance serves a whole daemon: `epoch` is fixed at construction because it
 * identifies the owner session, and a new epoch is a new process.
 */
export function createRunEventBus(options: RunEventBusOptions): RunEventBus {
  const ringBytes = options.ringBytes ?? RUN_EVENT_RING_BYTES;
  const totalBytes = options.totalBytes ?? RUN_EVENT_TOTAL_BYTES;
  const maxRings = options.maxRings ?? RUN_EVENT_MAX_RINGS;
  const now = options.now ?? nowTimestamp;
  const newSubscriptionId = options.newSubscriptionId ?? defaultSubscriptionId();

  /**
   * A subscriber's state, shared with its handle.
   *
   * `delivered()` reads `last` from this object, not from the registry, so it
   * stays right after the subscriber is released (it used to revert to the
   * subscribe-time value once the bus dropped a throwing subscriber).
   */
  interface Subscriber {
    readonly taskId: string;
    readonly deliver: (event: ClientEvent) => void;
    last: number | undefined;
  }

  const rings = new Map<string, Ring>();
  /**
   * Subscribers indexed by task, so publishing and "is anyone watching?" cost
   * the task's own subscribers rather than a scan of every subscriber.
   */
  const subscribersByTask = new Map<string, Map<string, Subscriber>>();
  let subscriberCount = 0;
  /**
   * The next sequence for a task whose ring is gone.
   *
   * Eviction removes a ring; the task may still be live (a task spans several
   * admissions), and recreating its ring at 0 would deliver a *decreasing*
   * sequence to a subscriber that is still attached — a silent discontinuity,
   * which is the one thing the epoch/sequence design exists to prevent. Written
   * only for an evicted ring that assigned something (a zero watermark carries no
   * information and would only crowd real ones out), and taken back when the ring
   * is recreated. Bounded: beyond the limit the oldest watermark of a task nobody
   * watches is dropped, and `droppedFloor` remembers the highest one dropped.
   */
  const sequenceWatermark = new Map<string, number>();
  const WATERMARK_LIMIT = 4096;
  /**
   * Where a ring with no watermark starts numbering.
   *
   * A dropped watermark means some task's numbering was forgotten; starting every
   * later ring at or above the highest one dropped means a same-epoch cursor from
   * that task's earlier numbering can never be answered against a restarted
   * stream — it falls below the ring's first sequence and resyncs.
   */
  let droppedFloor = 0;
  let totalRetained = 0;
  let completionCounter = 0;
  const completedListeners = new Set<(taskId: string) => void>();
  let ringCounter = 0;

  const report = (message: string, fields?: Record<string, unknown>): void => {
    try {
      options.onDiagnostic?.(message, fields);
    } catch {
      // A diagnostic sink that throws must not break publishing.
    }
  };

  const watched = (taskId: string): boolean => (subscribersByTask.get(taskId)?.size ?? 0) > 0;

  const addSubscriber = (id: string, subscriber: Subscriber): void => {
    let forTask = subscribersByTask.get(subscriber.taskId);
    if (forTask === undefined) {
      forTask = new Map();
      subscribersByTask.set(subscriber.taskId, forTask);
    }
    forTask.set(id, subscriber);
    subscriberCount += 1;
  };

  const removeSubscriber = (taskId: string, id: string): void => {
    const forTask = subscribersByTask.get(taskId);
    if (forTask === undefined || !forTask.delete(id)) return;
    subscriberCount -= 1;
    if (forTask.size === 0) subscribersByTask.delete(taskId);
  };

  /** Keep an evicted ring's numbering. */
  const rememberSequence = (taskId: string, sequence: number): void => {
    sequenceWatermark.set(taskId, sequence);
    if (sequenceWatermark.size <= WATERMARK_LIMIT) return;
    // Oldest first, skipping a task somebody still watches: its subscriber would
    // see the numbering restart if the ring were later recreated.
    for (const [candidate, value] of sequenceWatermark) {
      if (candidate === taskId || watched(candidate)) continue;
      sequenceWatermark.delete(candidate);
      droppedFloor = Math.max(droppedFloor, value);
      return;
    }
  };

  const ringFor = (taskId: string): Ring => {
    const existing = rings.get(taskId);
    if (existing !== undefined) return existing;
    ringCounter += 1;
    // A recreated ring takes its numbering back from the watermark, which the
    // ring then carries itself; its earlier history is unknown to it.
    const watermark = sequenceWatermark.get(taskId);
    sequenceWatermark.delete(taskId);
    const created: Ring = {
      taskId,
      events: [],
      bytes: 0,
      sequence: watermark ?? droppedFloor,
      firstSequence: watermark === undefined ? droppedFloor : null,
      completed: false,
      bornAt: ringCounter,
      completedAt: 0,
    };
    rings.set(taskId, created);
    return created;
  };

  /**
   * Remove a ring, keeping its numbering.
   *
   * Subscribers stay attached: they have already received everything the ring
   * held, so eviction costs them nothing, and the watermark keeps the next event's
   * sequence contiguous with what they saw. Only a *late* subscriber loses the
   * evicted history, and it learns so from `truncated`/`resync`.
   */
  const evict = (ring: Ring): void => {
    totalRetained -= ring.bytes;
    rings.delete(ring.taskId);
    if (hasAssigned(ring)) rememberSequence(ring.taskId, ring.sequence);
  };

  /** Bring the retained total and the ring count back under their bounds. */
  const enforceCap = (): void => {
    const overBytes = (): boolean => totalRetained > totalBytes;
    const overCount = (): boolean => rings.size > maxRings;
    if (!overBytes() && !overCount()) return;
    // Each candidate list is built once per call rather than per dropped event:
    // the order does not change while this runs, and re-sorting every ring for
    // every event trimmed made publishing slow down with the number of tasks.
    const byBirth = (left: Ring, right: Ring): number => left.bornAt - right.bornAt;
    const evictWhile = (candidates: readonly Ring[], over: () => boolean): void => {
      for (const ring of candidates) {
        if (!over()) return;
        if (rings.get(ring.taskId) === ring) evict(ring);
      }
    };
    const completed = (): Ring[] =>
      [...rings.values()].filter((ring) => ring.completed).sort((left, right) => left.completedAt - right.completedAt);

    // Byte pressure: completed tasks first, oldest completion first — a finished
    // transcript is worth less than a live one, and dropping it cannot lose an
    // event an attached subscriber is still waiting for.
    if (overBytes()) evictWhile(completed(), overBytes);
    // Count pressure: rings that hold nothing and that nobody watches cost only
    // an entry, so they go before any transcript; then completed transcripts;
    // then, as a last resort, the oldest ring nobody watches.
    if (overCount()) {
      evictWhile([...rings.values()].filter((ring) => ring.events.length === 0 && !watched(ring.taskId)).sort(byBirth), overCount);
      if (overCount())
        evictWhile(
          completed().filter((ring) => !watched(ring.taskId)),
          overCount,
        );
      if (overCount()) evictWhile([...rings.values()].filter((ring) => !watched(ring.taskId)).sort(byBirth), overCount);
    }
    if (!overBytes()) return;
    // Nothing completed left: trim the oldest live rings' heads, keeping their
    // tails (the part a late subscriber can still make sense of) and their
    // sequences, so subsequent events stay correctly numbered. Only rings that
    // still hold something: an emptied ring would otherwise be re-selected
    // forever while other live rings still hold droppable events.
    for (const ring of [...rings.values()].filter((candidate) => candidate.events.length > 0).sort(byBirth)) {
      while (overBytes() && ring.events.length > 0) {
        const dropped = ring.events.shift();
        if (dropped === undefined) break;
        ring.bytes -= dropped.bytes;
        totalRetained -= dropped.bytes;
        report("trimmed the oldest live event ring to stay under the cap", {
          taskId: ring.taskId,
          droppedSequence: dropped.event.sequence,
          remaining: totalRetained,
        });
      }
      if (!overBytes()) return;
    }
  };

  /**
   * Validate an event at `sequence` and return it with its encoding.
   *
   * The event returned is safe to retain. Zod builds new objects for everything
   * it validates *except* the `z.unknown()` payloads (`input`, `output`), which it
   * passes through by reference — so an event carrying one is re-parsed from the
   * encoding that was measured, detaching it from the producer's object. (A
   * producer that mutated its object after `publish` used to change what the ring
   * held and replayed while the byte counters never learned of it.) The others
   * skip the re-parse: strings are immutable.
   */
  const envelopeOf = (sequence: number, event: UnsequencedClientEvent): { event: ClientEvent; encoded: string } => {
    const { at, ...rest } = event;
    // Bounded here as well as in the CLI sink: the schema types `input`/`output`
    // as `z.unknown()`, so a producer that skipped the sink could otherwise
    // publish an unbounded payload, and the bus is a public runtime surface.
    const bounded = boundEventPayloads(rest as Record<string, unknown>);
    const validated = ClientEventSchema.parse({
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      epoch: options.epoch,
      sequence,
      at: at ?? now(),
      ...bounded,
    });
    const encoded = JSON.stringify(validated);
    const carriesPayload = "input" in validated || "output" in validated;
    return { event: carriesPayload ? (JSON.parse(encoded) as ClientEvent) : validated, encoded };
  };

  const publish = (taskId: string, event: UnsequencedClientEvent): ClientEvent => {
    const ring = ringFor(taskId);
    const { event: envelope, encoded } = envelopeOf(ring.sequence, event);
    ring.sequence += 1;
    ring.lastAttemptId = envelope.attemptId;
    // A completed task that publishes again is live again — a chat reply resumes
    // a completed conversation's task — so it must not keep its place at the head
    // of the eviction order while somebody may be watching it run.
    // A note about a finished task (a person handed its browser back) is not a run: it stays finished.
    if (
      ring.completed &&
      envelope.kind !== "task.completed" &&
      envelope.kind !== "task.failed" &&
      envelope.kind !== "task.stopped" &&
      envelope.kind !== "browser.controlled"
    ) {
      ring.completed = false;
      ring.completedAt = 0;
    }

    // Measured once, from the same encoding that was retained, and the
    // measurement is what the ring and the counters both use.
    const size = utf8ByteLength(encoded);
    ring.events.push({ event: envelope, bytes: size });
    ring.bytes += size;
    totalRetained += size;
    // The per-ring bound first: a single long run must not be able to hold more
    // than its own budget however much room the global cap has left. Its head is
    // dropped and its tail kept, and the sequence is untouched, so a later event
    // is still numbered correctly and a subscriber sees a contiguous run.
    while (ring.bytes > ringBytes && ring.events.length > 1) {
      const dropped = ring.events.shift();
      if (dropped === undefined) break;
      ring.bytes -= dropped.bytes;
      totalRetained -= dropped.bytes;
    }
    enforceCap();

    // A snapshot of this task's subscribers, so a `deliver` that subscribes or
    // unsubscribes cannot mutate the map mid-iteration — which would also hand
    // the in-flight event to a subscriber that joined during it.
    const forTask = subscribersByTask.get(taskId);
    if (forTask === undefined) return envelope;
    for (const [id, subscriber] of [...forTask.entries()]) {
      if (!forTask.has(id)) continue;
      // A throwing subscriber must not escape: it would abort the run's own event
      // emission, and one bad client would starve every later subscriber. It is
      // dropped, with a diagnostic.
      try {
        subscriber.deliver(envelope);
        subscriber.last = envelope.sequence;
      } catch (error) {
        report("dropping a subscriber whose delivery threw", {
          taskId,
          reason: errorMessage(error),
        });
        removeSubscriber(taskId, id);
      }
    }
    return envelope;
  };

  return {
    publish,

    subscribe(input): SubscribeResult {
      if (typeof input.from === "object") {
        const { epoch, sequence } = input.from;
        if (!Number.isSafeInteger(sequence) || sequence < 0) {
          throw new TaviError("INVALID_INPUT", `subscribe cursor sequence must be a non-negative integer, got ${String(sequence)}`);
        }
        if (typeof epoch !== "string" || epoch === "") {
          throw new TaviError("INVALID_INPUT", "subscribe cursor epoch must be a non-empty string");
        }
      }
      const ring = ringFor(input.taskId);
      const subscriptionId = newSubscriptionId();
      const replayed: ClientEvent[] = [];
      let resync: ClientEvent | null = null;
      let truncated = false;
      /** The next sequence this stream will assign. */
      const next = ring.sequence;
      const oldestRetained = ring.events[0]?.event.sequence ?? next;

      if (input.from === "beginning") {
        replayed.push(...ring.events.map((retained) => retained.event));
        // Whole only when the replay starts at the task's first event of this
        // epoch (or nothing was ever assigned); anything else means its head was
        // trimmed or its ring evicted.
        truncated = ring.firstSequence === null ? hasAssigned(ring) : oldestRetained > ring.firstSequence;
      } else if (input.from !== undefined) {
        const { epoch, sequence } = input.from;
        // Answerable when the cursor is from this epoch, not in the future, and
        // everything after it is still retained. An emptied ring is answerable
        // exactly for a caught-up cursor (`sequence + 1 === next`): a client that
        // had seen everything used to be told to resync because nothing was left.
        const cursorIsAnswerable = epoch === options.epoch && sequence + 1 <= next && sequence + 1 >= oldestRetained;
        if (cursorIsAnswerable) {
          // Replay from the requested sequence, exclusive.
          for (const retained of ring.events) {
            if (retained.event.sequence > sequence) replayed.push(retained.event);
          }
        } else {
          // For this subscriber only: publishing it broadcast a spurious resync to
          // every healthy subscriber of the task and left it in later replays.
          // Numbered at the head, so re-subscribing from it is caught up; a
          // stream that has assigned nothing reserves one sequence for it, and
          // its first real event is then the one after.
          let head: number;
          if (hasAssigned(ring)) {
            head = ring.sequence - 1;
          } else if (ring.reservedMarker !== undefined) {
            // Another stale subscriber reserved it: every marker shares it, as
            // markers share the head once events exist.
            head = ring.reservedMarker;
          } else {
            head = ring.sequence;
            ring.reservedMarker = head;
            ring.sequence += 1;
            ring.firstSequence = ring.sequence;
          }
          resync = envelopeOf(head, {
            kind: "resync.required",
            runId: input.taskId,
            attemptId: ring.lastAttemptId ?? "resync",
            reason:
              epoch !== options.epoch
                ? "the owner restarted; events from the previous session cannot be replayed"
                : "the requested sequence is no longer retained",
          }).event;
          truncated = true;
        }
      }

      const cursorSequence = typeof input.from === "object" ? input.from.sequence : undefined;
      const subscriber: Subscriber = {
        taskId: input.taskId,
        deliver: input.deliver,
        last: replayed.at(-1)?.sequence ?? resync?.sequence ?? cursorSequence ?? (hasAssigned(ring) ? ring.sequence - 1 : undefined),
      };
      addSubscriber(subscriptionId, subscriber);
      // A subscription may be what pushed the ring count over its bound; the ring
      // it watches is never the one evicted for it.
      enforceCap();
      return {
        subscription: {
          subscriptionId,
          taskId: input.taskId,
          delivered: () => subscriber.last,
          unsubscribe: () => removeSubscriber(input.taskId, subscriptionId),
        },
        replayed,
        resync,
        truncated,
      };
    },

    lastAttempt(taskId: string): string | undefined {
      return rings.get(taskId)?.lastAttemptId;
    },

    latestActivity(taskId: string, maxChars: number): { readonly kind: "tool" | "text"; readonly text: string } | undefined {
      const events = rings.get(taskId)?.events ?? [];
      let text = "";
      let blockId: string | undefined;
      // Newest first, stopping early: the ring is not copied for a look at its tail.
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]?.event;
        if (event === undefined) continue;
        if (event.kind === "text.delta") {
          if (blockId !== undefined && event.blockId !== blockId) break;
          blockId = event.blockId;
          text = event.text + text;
          if (text.length >= maxChars * 2) break;
          continue;
        }
        // Any other event (a usage report, a wait settling) says nothing of what the task did: past it.
        if (event.kind !== "tool.started" && event.kind !== "tool.completed" && event.kind !== "tool.failed") continue;
        if (blockId !== undefined) break;
        return { kind: "tool", text: event.toolName.slice(0, maxChars) };
      }
      const line = text.replace(/\s+/g, " ").trim();
      if (line === "") return undefined;
      return { kind: "text", text: line.length <= maxChars ? line : `…${line.slice(line.length - maxChars + 1)}` };
    },

    head(taskId: string): IpcCursor | undefined {
      const ring = rings.get(taskId);
      if (ring === undefined || !hasAssigned(ring)) return undefined;
      return { epoch: options.epoch, sequence: ring.sequence - 1 };
    },

    onCompleted(listener: (taskId: string) => void): () => void {
      completedListeners.add(listener);
      return () => completedListeners.delete(listener);
    },

    markCompleted(taskId: string): void {
      for (const listener of completedListeners) {
        try {
          listener(taskId);
        } catch (error) {
          report("a task-completed listener threw", { taskId, reason: errorMessage(error) });
        }
      }
      const ring = rings.get(taskId);
      // Idempotent: re-marking an already-completed ring must not push it behind
      // a younger one in the eviction order.
      if (ring === undefined || ring.completed) return;
      ring.completed = true;
      completionCounter += 1;
      ring.completedAt = completionCounter;
      // A ring that just became evictable may be what brings the totals back
      // under their bounds.
      enforceCap();
    },

    forget(taskId: string): void {
      const ring = rings.get(taskId);
      if (ring !== undefined) {
        totalRetained -= ring.bytes;
        rings.delete(taskId);
      }
      // The task is gone, so its watermark and its subscribers are not needed.
      sequenceWatermark.delete(taskId);
      const forTask = subscribersByTask.get(taskId);
      if (forTask !== undefined) {
        subscriberCount -= forTask.size;
        subscribersByTask.delete(taskId);
      }
    },

    dropRetained(taskId: string, before?: string): number {
      const ring = rings.get(taskId);
      if (ring === undefined) return 0;
      // The oldest first, and only a run of them: what stays is still one contiguous tail.
      let dropped = 0;
      while (ring.events.length > 0) {
        const head = ring.events[0];
        if (head === undefined || (before !== undefined && head.event.at >= before)) break;
        ring.events.shift();
        ring.bytes -= head.bytes;
        totalRetained -= head.bytes;
        dropped += 1;
      }
      return dropped;
    },

    retains(taskId: string): boolean {
      return (rings.get(taskId)?.events.length ?? 0) > 0;
    },

    stats(): RunEventBusStats {
      return { tasks: rings.size, bytes: totalRetained, subscriptions: subscriberCount };
    },
  };
}

/** Subscription ids are per-process sequential, never reused. */
function defaultSubscriptionId(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `sub-${counter}`;
  };
}
