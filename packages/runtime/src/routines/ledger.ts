import {
  RoutineEnvelopeSchema,
  TaviError,
  redactSecretsInText,
  scrubCredentialText,
  type RoutineEnvelope,
  type RoutineLedgerEvent,
  type RoutineLedgerVerdict,
  type RoutineRun,
  type RoutineScope,
} from "@tavi/contracts";
import { prefixedId } from "@tavi/node-kit";
import { canonicalRoutineJson, routineHash, type RoutineService } from "./service.js";

type RoutineDatabase = RoutineService["store"]["handle"];

/** What a ledger event keeps beside its envelope: a redacted prompt or evidence text, stored once and hashed. */
export interface RoutineLedgerDetailInput {
  readonly kind: "prompt" | "evidence";
  readonly text: string;
}

/** A detail payload's bound: one at most 32 KiB, a run's together at most 1 MiB; a larger one is left out of the ledger. */
const DETAIL_MAX_BYTES = 32_768;
const RUN_DETAIL_MAX_BYTES = 1_048_576;

/**
 * Append one event to a routine's hash chain.
 *
 * Immediate: a checkpoint is recorded mid-turn, while the turn's own writes go
 * through another connection; a deferred read-then-write would fail on their
 * commit rather than wait for it. The head read and the insert share the
 * transaction, so a concurrent writer cannot interleave a sequence number.
 */
export function appendRoutineEvent(
  db: RoutineDatabase,
  now: () => string,
  run: Pick<RoutineRun, "routineId" | "runId">,
  input: RoutineEnvelope,
  attemptId: string | null = null,
  detail?: RoutineLedgerDetailInput,
): void {
  db.transaction(() => {
    const envelope = RoutineEnvelopeSchema.parse(input);
    const head = db
      .prepare("SELECT sequence,event_hash FROM tavi_routine_events WHERE routine_id=? ORDER BY sequence DESC LIMIT 1")
      .get(run.routineId) as { sequence: number; event_hash: string } | undefined;
    const sequence = (head?.sequence ?? 0) + 1;
    const eventId = prefixedId("routine-event");
    const at = now();
    let detailId: string | null = null;
    let detailHash: string | null = null;
    if (detail !== undefined) {
      const text = redactSecretsInText(scrubCredentialText(detail.text));
      const payload = canonicalRoutineJson({ kind: detail.kind, text });
      const bytes = Buffer.byteLength(payload);
      const sum = db.prepare("SELECT COALESCE(SUM(byte_size),0) AS total FROM tavi_routine_details WHERE run_id=?").get(run.runId) as {
        total: number;
      };
      if (bytes <= DETAIL_MAX_BYTES && sum.total + bytes <= RUN_DETAIL_MAX_BYTES) {
        detailId = prefixedId("routine-detail");
        detailHash = routineHash(payload);
        db.prepare("INSERT INTO tavi_routine_details VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(
          detailId,
          run.routineId,
          run.runId,
          detailHash,
          payload,
          bytes,
          at,
        );
      }
    }
    const previousHash = head?.event_hash ?? "0".repeat(64);
    const retained = {
      version: 1,
      routineId: run.routineId,
      sequence,
      eventId,
      runId: run.runId,
      attemptId,
      at,
      envelope,
      detailId,
      detailHash,
      previousHash,
    };
    db.prepare("INSERT INTO tavi_routine_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      run.routineId,
      sequence,
      eventId,
      run.runId,
      attemptId,
      envelope.code,
      at,
      canonicalRoutineJson(envelope),
      detailId,
      detailHash,
      previousHash,
      routineHash(retained),
    );
  }).immediate();
}

/** A page of a routine's ledger after `afterSequence`, oldest first; one run's events only when `runId` is given. */
export function routineLedgerPage(
  db: RoutineDatabase,
  routineId: string,
  afterSequence: number,
  limit: number,
  runId?: string,
): readonly RoutineLedgerEvent[] {
  return (
    db
      .prepare("SELECT * FROM tavi_routine_events WHERE routine_id=? AND sequence>? AND (? IS NULL OR run_id=?) ORDER BY sequence LIMIT ?")
      .all(routineId, afterSequence, runId ?? null, runId ?? null, limit) as {
      sequence: number;
      event_id: string;
      run_id: string | null;
      attempt_id: string | null;
      at: string;
      envelope_json: string;
      previous_hash: string;
      event_hash: string;
      detail_id: string | null;
      detail_hash: string | null;
    }[]
  ).map((row) => ({
    sequence: row.sequence,
    eventId: row.event_id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    at: row.at,
    envelope: RoutineEnvelopeSchema.parse(JSON.parse(row.envelope_json)),
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    detailId: row.detail_id,
    detailHash: row.detail_hash,
  }));
}

/** One detail payload of a routine's ledger: `null` once it was pruned, its hash kept either way. */
export function routineLedgerDetail(
  db: RoutineDatabase,
  routineId: string,
  detailId: string,
): { payload: string | null; hash: string; prunedAt: string | null } {
  const row = db
    .prepare("SELECT payload,hash,pruned_at FROM tavi_routine_details WHERE routine_id=? AND detail_id=?")
    .get(routineId, detailId) as { payload: string | null; hash: string; pruned_at: string | null } | undefined;
  if (row === undefined) throw new TaviError("NOT_FOUND", "Routine detail is unavailable");
  return { payload: row.payload, hash: row.hash, prunedAt: row.pruned_at };
}

/**
 * Verify a routine's local hash chain.
 *
 * The verdict is exactly as strong as a local chain can be, and the return
 * value says so: the scope it covered, how many events, the head hash it
 * reached, how many detail payloads have been pruned, and the limitation that
 * survives all of it. A **coherently truncated tail verifies** — the remaining
 * chain is internally consistent — and a full rewrite of the table does too;
 * neither is detectable without an anchor outside the database, which this
 * build deliberately does not have.
 */
export function verifyRoutineLedger(db: RoutineDatabase, scope: RoutineScope, routineId: string): RoutineLedgerVerdict {
  let previousHash = "0".repeat(64);
  let cursor = 0;
  let prunedDetails = 0;
  let valid = true;
  for (;;) {
    const page = routineLedgerPage(db, routineId, cursor, 100);
    if (page.length === 0) break;
    for (const event of page) {
      const { eventHash, ...fields } = event;
      if (
        event.sequence !== cursor + 1 ||
        event.previousHash !== previousHash ||
        routineHash({ version: 1, routineId, ...fields }) !== eventHash
      )
        valid = false;
      if (event.detailId !== null) {
        const detail = routineLedgerDetail(db, routineId, event.detailId);
        if (detail.payload === null) prunedDetails++;
        else if (routineHash(detail.payload) !== event.detailHash) valid = false;
      }
      previousHash = eventHash;
      cursor = event.sequence;
    }
  }
  return {
    valid,
    scope: { workspaceId: scope.workspaceId, principalId: scope.principalId, routineId },
    events: cursor,
    headHash: previousHash,
    prunedDetails,
    chain: "local",
    anchored: false,
    limitation:
      "Local chain only. A change to an event, or a removal from the middle of the ledger, is detected; a rewrite of the whole ledger, or a truncation of its tail, is not detectable without an anchor stored outside this database, and this build does not write one.",
  };
}
