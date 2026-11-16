import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_RETENTION_DAYS,
  MAX_MEMORY_BODY_BYTES,
  MAX_MEMORY_TITLE_CHARS,
  MAX_PREFERENCE_KEY_CHARS,
  MAX_SOURCE_IDS,
  MAX_TOPIC_KEY_CHARS,
  MEMORY_NEAR_MATCH_JACCARD,
  MEMORY_SEARCH_MAX,
  memoryScopeKey,
  memoryTextSimilarity,
  type MemoryActor,
  type MemoryKind,
  type MemoryScope,
  type MemoryServicePort,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

/**
 * The conformance suite every `MemoryServicePort` passes (docs/MEMORY.md
 * invariant 15): the built-in `MemoryService`, and any service
 * an embedder passes as `memoryOverride`. It holds a port to what the owner
 * relies on: a model proposes and a person approves; an edit is a
 * compare-and-set; every read is scoped by the actor, a delegated worker sees
 * only what it was granted and a group chat only its notes; forget erases;
 * preferences resolve by precedence; quotas and bounds are typed refusals;
 * dedup, end dates and the sweep behave as docs/MEMORY.md says; the operator's
 * views are the operator's alone; and a tidy-up's `supersedes`
 * changes nothing until approved, then supersedes its inputs at their
 * revisions, or refuses.
 *
 * Every case reads the port only. What the port cannot write — a record in a
 * workspace's shared scope, an evidence source and its revocation — the
 * harness writes (`MemoryPortHarness`). Errors are matched by their
 * `TaviError` code, never their wording.
 *
 * Test-only: it imports vitest, so it is exported for tests and never built.
 */

/** Where a case starts: Thursday 1 January 2026. "Until Friday" ends as Saturday 3 January begins. */
const THURSDAY = "2026-01-01T00:00:00.000Z";
const END_OF_FRIDAY = "2026-01-03T00:00:00.000Z";
const SATURDAY = "2026-01-03T09:00:00.000Z";
const DAY = 86_400_000;
const daysAfter = (base: string, days: number): string => new Date(Date.parse(base) + days * DAY).toISOString();
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** What a case asks of the service it is given. */
export interface MemoryPortEnvironment {
  /** The case's clock: the service stamps and judges time by it, read on every call. */
  readonly now: () => string;
  /** The quotas each principal's writes are charged against; absent, the service's own defaults. */
  readonly quotas?: { readonly maxRecords: number; readonly maxBytes: number };
  /** Who holds the reader grant of a workspace's shared scope (`memory:read-shared`); nobody else does. */
  readonly sharedReaders: readonly { readonly principalId: string; readonly workspaceId: string }[];
}

/** A service under test, and what it needs written that the port never writes. */
export interface MemoryPortHarness {
  readonly port: MemoryServicePort;
  /** An approved record in a workspace's shared scope, as an explicit share writes it. */
  share(input: {
    readonly recordId: string;
    readonly workspaceId: string;
    readonly kind: MemoryKind;
    readonly body: string;
  }): void | Promise<void>;
  /**
   * An evidence source in a scope that a record may cite, active or already
   * revoked; `recordId` ties it to that record (absent: to none).
   */
  addSource(input: {
    readonly sourceId: string;
    readonly scopeKey: string;
    readonly revoked?: boolean;
    readonly recordId?: string;
    readonly observedAt?: string;
  }): void | Promise<void>;
  /** The source is revoked after the fact, as an external revocation would. */
  revokeSource(sourceId: string): void | Promise<void>;
  close?(): void | Promise<void>;
}

/** Builds a fresh service for one case. */
export type MemoryPortFactory = (environment: MemoryPortEnvironment) => MemoryPortHarness | Promise<MemoryPortHarness>;

interface CaseContext {
  readonly port: MemoryServicePort;
  readonly harness: MemoryPortHarness;
  /** Move the case's clock. */
  readonly at: (now: string) => void;
}

interface Case {
  readonly group: string;
  readonly title: string;
  readonly quotas?: MemoryPortEnvironment["quotas"];
  /** Alice holds the reader grant of w1's shared scope. */
  readonly aliceReadsShared?: true;
  readonly run: (context: CaseContext) => Promise<void>;
}

const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", agentId: "agent-main", caller: "cli", authority: "operator" };
const bob: MemoryActor = { ...alice, principalId: "bob" };
const model: MemoryActor = { ...alice, caller: "model", authority: "model" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };
const aliceWorkspace: MemoryScope = { kind: "personal_workspace", principalId: "alice", workspaceId: "w1" };
const shared: MemoryScope = { kind: "shared_workspace", workspaceId: "w1" };
const runLocal = (runId: string): MemoryScope => ({ kind: "run_local", principalId: "alice", workspaceId: "w1", runId });

type ProposeInput = Parameters<MemoryServicePort["propose"]>[0];

/** The refusal a call answers, by its code; a call that succeeds fails the case. */
async function refusal(call: () => unknown): Promise<{ readonly code: unknown; readonly message: string }> {
  try {
    await call();
  } catch (error) {
    return { code: (error as { readonly code?: unknown } | null)?.code, message: errorMessage(error) };
  }
  expect.fail("expected the call to be refused, and it succeeded");
}

async function refused(call: () => unknown, code: string): Promise<void> {
  const answer = await refusal(call);
  expect(answer.code, answer.message).toBe(code);
}

async function approved(port: MemoryServicePort, input: ProposeInput) {
  const proposal = await port.propose(input);
  return await port.approve({ actor: input.actor, recordId: proposal.recordId });
}

const ids = (records: readonly { readonly recordId: string }[]): string[] => records.map((record) => record.recordId);

const CASES: readonly Case[] = [
  // ── proposal and review ─────────────────────────────────────────────
  {
    group: "proposal and review",
    title: "memory invariant 1: stores a proposal without approving it, then approves one exact revision with a review bound to it",
    run: async ({ port }) => {
      const proposed = await port.propose({ actor: model, scope: personal, kind: "fact", body: "Alice keeps a garden", sourceIds: ["s1"] });
      expect(proposed.status).toBe("proposed");
      expect(proposed.currentRevisionId).toBeUndefined();
      expect((await port.get({ actor: alice, recordId: proposed.recordId })).status).toBe("proposed");
      const kept = await port.approve({ actor: alice, recordId: proposed.recordId, reason: "explicit remember" });
      expect(kept.status).toBe("approved");
      expect(kept.currentRevisionId).toBeDefined();
      expect((await port.list({ actor: alice }))[0]?.status).toBe("approved");
      const history = await port.history({ actor: alice, recordId: proposed.recordId });
      expect(history.reviews.map((review) => review.decision)).toEqual(["approved"]);
      expect(history.reviews[0]?.revisionId).toBe(kept.currentRevisionId);
      const keptRevision = history.revisions.find((revision) => revision.revisionId === kept.currentRevisionId);
      expect(keptRevision).toBeDefined();
      expect(history.reviews[0]?.revisionHash).toEqual(expect.any(String));
      expect(history.reviews[0]?.revisionHash).not.toBe("");
      expect(history.reviews[0]?.revisionHash).toBe(keptRevision?.contentHash);
    },
  },
  {
    group: "proposal and review",
    title: "approve is idempotent: a second call answers the record unchanged and records no second review",
    run: async ({ port }) => {
      const proposed = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "a fact" });
      const first = await port.approve({ actor: alice, recordId: proposed.recordId });
      expect(await port.approve({ actor: alice, recordId: proposed.recordId })).toEqual(first);
      expect((await port.history({ actor: alice, recordId: proposed.recordId })).reviews).toHaveLength(1);
    },
  },
  {
    group: "proposal and review",
    title: "refuses to reject approved memory and to correct a mere proposal, and a revision id that is not the record's",
    run: async ({ port }) => {
      const kept = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "a fact" });
      await refused(() => port.reject({ actor: alice, recordId: kept.recordId }), "CONFLICT");
      const other = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "another" });
      await refused(() => port.correct({ actor: alice, recordId: other.recordId, body: "changed" }), "CONFLICT");
      await refused(() => port.approve({ actor: alice, recordId: other.recordId, expectedRevisionId: "nope" }), "REVISION_CONFLICT");
      expect((await port.get({ actor: alice, recordId: other.recordId })).status).toBe("proposed");
    },
  },
  {
    group: "proposal and review",
    title: "rejects a proposal and keeps the rejection visible",
    run: async ({ port }) => {
      const proposed = await port.propose({ actor: alice, scope: personal, kind: "lesson", body: "probably wrong" });
      expect((await port.reject({ actor: alice, recordId: proposed.recordId, reason: "not supported" })).status).toBe("rejected");
      expect((await port.history({ actor: alice, recordId: proposed.recordId })).reviews.map((review) => review.decision)).toEqual([
        "rejected",
      ]);
    },
  },
  {
    group: "proposal and review",
    title: "memory invariant 1: a model cannot approve, reject, correct, revoke, forget or remember",
    run: async ({ port }) => {
      const proposal = await port.propose({ actor: model, scope: personal, kind: "fact", body: "model claim" });
      await refused(() => port.approve({ actor: model, recordId: proposal.recordId }), "NOT_AUTHORIZED");
      await refused(() => port.reject({ actor: model, recordId: proposal.recordId }), "NOT_AUTHORIZED");
      await refused(() => port.remember({ actor: model, scope: personal, kind: "fact", body: "x" }), "NOT_AUTHORIZED");
      const kept = await port.approve({ actor: alice, recordId: proposal.recordId });
      await refused(() => port.correct({ actor: model, recordId: kept.recordId, body: "x" }), "NOT_AUTHORIZED");
      await refused(() => port.revoke({ actor: model, recordId: kept.recordId, reason: "x" }), "NOT_AUTHORIZED");
      await refused(() => port.forget({ actor: model, recordId: kept.recordId, reason: "x" }), "NOT_AUTHORIZED");
      expect((await port.get({ actor: alice, recordId: kept.recordId })).status).toBe("approved");
    },
  },
  {
    group: "proposal and review",
    title: "remember proposes and approves in one operator call",
    run: async ({ port }) => {
      const remembered = await port.remember({ actor: alice, scope: personal, kind: "fact", body: "remembered directly" });
      expect(remembered.status).toBe("approved");
      expect((await port.history({ actor: alice, recordId: remembered.recordId })).reviews.map((review) => review.decision)).toEqual([
        "approved",
      ]);
    },
  },

  // ── correction ──────────────────────────────────────────────────────
  {
    group: "correction",
    title: "supersedes the previous revision, closing its interval, and conflicts on a stale expectation",
    run: async ({ port }) => {
      const record = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice is in Berlin" });
      const first = record.currentRevisionId ?? "";
      const corrected = await port.correct({
        actor: alice,
        recordId: record.recordId,
        expectedRevisionId: first,
        body: "Alice moved to Lisbon",
        reason: "operator correction",
      });
      expect(corrected.currentRevisionId).not.toBe(first);
      expect(corrected.status).toBe("approved");
      await refused(
        () => port.correct({ actor: alice, recordId: record.recordId, expectedRevisionId: first, body: "Alice is in Porto" }),
        "REVISION_CONFLICT",
      );
      const revisions = (await port.history({ actor: alice, recordId: record.recordId })).revisions;
      expect(revisions).toHaveLength(2);
      const previous = revisions.find((revision) => revision.revisionId === first);
      expect(previous).toMatchObject({ status: "superseded", supersededByRevisionId: corrected.currentRevisionId, validTo: THURSDAY });
      expect(revisions.find((revision) => revision.revisionId === corrected.currentRevisionId)?.status).toBe("active");
    },
  },
  {
    group: "correction",
    title: "lists each record with its current revision when asked, and without one otherwise",
    run: async ({ port }) => {
      const record = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice is in Berlin" });
      const corrected = await port.correct({ actor: alice, recordId: record.recordId, body: "Alice moved to Lisbon" });
      const [listed] = await port.list({ actor: alice, withCurrentRevision: true });
      const current = (await port.history({ actor: alice, recordId: record.recordId })).revisions.find(
        (revision) => revision.revisionId === corrected.currentRevisionId,
      );
      expect(listed?.currentRevision).toEqual(current);
      expect(listed?.currentRevision?.body).toBe("Alice moved to Lisbon");
      expect((await port.list({ actor: alice }))[0]?.currentRevision).toBeUndefined();
    },
  },
  {
    group: "correction",
    title: "writes nothing when its expectation is already stale",
    run: async ({ port }) => {
      const record = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "v1" });
      await port.correct({ actor: alice, recordId: record.recordId, body: "v2" });
      await refused(
        () =>
          port.correct({
            actor: alice,
            recordId: record.recordId,
            expectedRevisionId: record.currentRevisionId ?? "",
            body: "PHANTOM-CORRECTION",
          }),
        "REVISION_CONFLICT",
      );
      const revisions = (await port.history({ actor: alice, recordId: record.recordId })).revisions;
      expect(revisions).toHaveLength(2);
      expect(revisions.some((revision) => revision.body === "PHANTOM-CORRECTION")).toBe(false);
    },
  },
  {
    group: "correction",
    title: "carries a preference's typed value forward on a body-only correction, and refuses a value on any other kind",
    run: async ({ port }) => {
      const preference = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "ui.theme",
        preference: { valueType: "string", value: "dark" },
        body: "prefers dark mode",
      });
      const corrected = await port.correct({ actor: alice, recordId: preference.recordId, body: "prefers dark mode, always" });
      const current = (await port.history({ actor: alice, recordId: preference.recordId })).revisions.find(
        (revision) => revision.revisionId === corrected.currentRevisionId,
      );
      expect(current?.preference?.value).toBe("dark");
      const fact = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "v1" });
      await refused(
        () => port.correct({ actor: alice, recordId: fact.recordId, preference: { valueType: "string", value: "x" } }),
        "INVALID_INPUT",
      );
    },
  },
  {
    group: "correction",
    title: "charges a correction only for its byte delta, never a record slot",
    quotas: { maxRecords: 1, maxBytes: 1_000 },
    run: async ({ port }) => {
      const record = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "short" });
      expect((await port.correct({ actor: alice, recordId: record.recordId, body: "still short" })).status).toBe("approved");
    },
  },
  {
    group: "correction",
    title: "refuses a correction whose byte delta would exceed the quota",
    quotas: { maxRecords: 10, maxBytes: 20 },
    run: async ({ port }) => {
      const record = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "short" });
      await refused(
        () => port.correct({ actor: alice, recordId: record.recordId, body: "a much, much longer replacement body" }),
        "QUOTA_EXCEEDED",
      );
    },
  },

  // ── authorization ───────────────────────────────────────────────────
  {
    group: "authorization",
    title: "one principal cannot read, search, propose into, approve, reject, correct, revoke, forget or export another's memory",
    run: async ({ port }) => {
      const proposal = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "Alice's proposal" });
      const record = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice's private note" });
      // Existence is not disclosed: every call on another's record is NOT_FOUND.
      await refused(() => port.get({ actor: bob, recordId: record.recordId }), "NOT_FOUND");
      await refused(() => port.history({ actor: bob, recordId: record.recordId }), "NOT_FOUND");
      expect(await port.list({ actor: bob })).toEqual([]);
      expect((await port.search({ actor: bob, query: "private" })).hits).toEqual([]);
      await refused(() => port.propose({ actor: bob, scope: personal, kind: "fact", body: "x" }), "NOT_AUTHORIZED");
      await refused(() => port.approve({ actor: bob, recordId: proposal.recordId }), "NOT_FOUND");
      await refused(() => port.reject({ actor: bob, recordId: proposal.recordId }), "NOT_FOUND");
      await refused(() => port.correct({ actor: bob, recordId: record.recordId, body: "hijacked" }), "NOT_FOUND");
      await refused(() => port.revoke({ actor: bob, recordId: record.recordId, reason: "x" }), "NOT_FOUND");
      await refused(() => port.forget({ actor: bob, recordId: record.recordId, reason: "x" }), "NOT_FOUND");
      expect((await port.export({ actor: bob })).records).toEqual([]);
      expect((await port.get({ actor: alice, recordId: record.recordId })).status).toBe("approved");
      expect((await port.get({ actor: alice, recordId: proposal.recordId })).status).toBe("proposed");
    },
  },
  {
    group: "authorization",
    title: "refuses to write into the shared scope, even with a read grant",
    aliceReadsShared: true,
    run: async ({ port }) => {
      await refused(() => port.propose({ actor: alice, scope: shared, kind: "fact", body: "publish me" }), "NOT_AUTHORIZED");
    },
  },
  {
    group: "authorization",
    title: "refuses to read the shared scope without the reader grant, and another workspace's at all",
    run: async ({ port, harness }) => {
      await harness.share({ recordId: "shared-1", workspaceId: "w1", kind: "fact", body: "shared guidance" });
      await refused(() => port.list({ actor: alice, scope: shared }), "NOT_AUTHORIZED");
      // The implicit read path leaves the shared scope out instead of failing.
      expect(await port.list({ actor: alice })).toEqual([]);
      expect((await port.search({ actor: alice, query: "guidance" })).hits).toEqual([]);
      await refused(() => port.list({ actor: alice, scope: { kind: "shared_workspace", workspaceId: "w9" } }), "NOT_AUTHORIZED");
    },
  },
  {
    group: "authorization",
    title: "reads shared records through every path once the actor holds the reader grant, and not without it",
    aliceReadsShared: true,
    run: async ({ port, harness }) => {
      await harness.share({ recordId: "shared-1", workspaceId: "w1", kind: "fact", body: "shared guidance" });
      expect(ids(await port.list({ actor: alice, scope: shared }))).toEqual(["shared-1"]);
      expect(ids(await port.list({ actor: alice }))).toContain("shared-1");
      expect((await port.search({ actor: alice, scope: shared, query: "guidance" })).hits).toHaveLength(1);
      expect(ids((await port.export({ actor: alice, scope: shared })).records)).toEqual(["shared-1"]);
      expect((await port.get({ actor: alice, recordId: "shared-1" })).recordId).toBe("shared-1");
      await refused(() => port.list({ actor: bob, scope: shared }), "NOT_AUTHORIZED");
      await refused(() => port.search({ actor: bob, scope: shared, query: "guidance" }), "NOT_AUTHORIZED");
      await refused(() => port.export({ actor: bob, scope: shared }), "NOT_AUTHORIZED");
      await refused(() => port.get({ actor: bob, recordId: "shared-1" }), "NOT_FOUND");
    },
  },
  {
    group: "authorization",
    title: "keeps run-local memory inside its run",
    run: async ({ port }) => {
      await refused(() => port.propose({ actor: alice, scope: runLocal("run-1"), kind: "summary", body: "temporary" }), "NOT_AUTHORIZED");
      const inRun: MemoryActor = { ...alice, runId: "run-1" };
      const proposed = await port.propose({ actor: inRun, scope: runLocal("run-1"), kind: "summary", body: "temporary" });
      expect(proposed.scopeKey).toBe(memoryScopeKey(runLocal("run-1")));
      expect(await port.list({ actor: inRun })).toHaveLength(1);
      expect(await port.list({ actor: { ...alice, runId: "run-2" } })).toEqual([]);
    },
  },
  {
    group: "authorization",
    title: "reads a persona's own memory only for the actor that acts as it",
    run: async ({ port }) => {
      await approved(port, {
        actor: alice,
        scope: { kind: "personal_agent", principalId: "alice", agentId: "agent-main", workspaceId: "w1" },
        kind: "fact",
        body: "Researcher notes on Lisbon",
      });
      expect((await port.search({ actor: alice, query: "lisbon", match: "any" })).hits).toHaveLength(1);
      const { agentId: _agent, ...noAgent } = alice;
      expect((await port.search({ actor: noAgent, query: "lisbon", match: "any" })).hits).toHaveLength(0);
      expect((await port.search({ actor: { ...alice, agentId: "other" }, query: "lisbon", match: "any" })).hits).toHaveLength(0);
      expect((await port.search({ actor: { ...alice, scopeRestricted: true }, query: "lisbon", match: "any" })).hits).toHaveLength(0);
    },
  },

  // ── worker-scoped delegation ────────────────────────────────────────
  {
    group: "worker-scoped delegation",
    title: "a scope-restricted worker reads no personal scope, keeping run-local and shared",
    aliceReadsShared: true,
    run: async ({ port, harness }) => {
      const mine = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "alice's private note" });
      await approved(port, { actor: alice, scope: aliceWorkspace, kind: "fact", body: "workspace note" });
      await approved(port, {
        actor: alice,
        scope: { kind: "personal_agent", principalId: "alice", agentId: "agent-main", workspaceId: "w1" },
        kind: "fact",
        body: "agent-scoped note",
      });
      await harness.share({ recordId: "shared-1", workspaceId: "w1", kind: "fact", body: "shared guidance" });
      const inRun: MemoryActor = { ...alice, runId: "run-1" };
      await approved(port, { actor: inRun, scope: runLocal("run-1"), kind: "summary", body: "run summary" });
      const worker: MemoryActor = { ...alice, runId: "run-1", scopeRestricted: true };
      expect(ids(await port.list({ actor: worker }))).not.toContain(mine.recordId);
      expect((await port.search({ actor: worker, query: "workspace note" })).hits).toEqual([]);
      expect((await port.search({ actor: worker, query: "agent-scoped" })).hits).toEqual([]);
      expect((await port.search({ actor: worker, query: "shared guidance" })).hits).toHaveLength(1);
      expect((await port.search({ actor: worker, query: "run summary" })).hits).toHaveLength(1);
      expect((await port.list({ actor: alice })).length).toBeGreaterThanOrEqual(3);
    },
  },
  {
    group: "worker-scoped delegation",
    title: "a record granted by id is readable through get, search and preferences, and an ungranted one is not",
    run: async ({ port }) => {
      const granted = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "formal" },
        body: "prefers a formal tone",
      });
      const ungranted = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "a private fact never shared" });
      const worker: MemoryActor = { ...alice, scopeRestricted: true, allowedRecordIds: [granted.recordId] };
      expect((await port.get({ actor: worker, recordId: granted.recordId })).recordId).toBe(granted.recordId);
      await refused(() => port.get({ actor: worker, recordId: ungranted.recordId }), "NOT_FOUND");
      expect(ids((await port.search({ actor: worker, query: "formal tone" })).hits)).toEqual([granted.recordId]);
      expect((await port.search({ actor: worker, query: "private fact" })).hits).toEqual([]);
      expect((await port.resolvePreferences({ actor: worker, keys: ["tone"] })).preferences.map((entry) => entry.winner.recordId)).toEqual([
        granted.recordId,
      ]);
    },
  },
  {
    group: "worker-scoped delegation",
    title: "a forgotten record stays gone though its id is still granted",
    run: async ({ port }) => {
      const granted = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "will be forgotten" });
      await port.forget({ actor: alice, recordId: granted.recordId, reason: "no longer needed" });
      const worker: MemoryActor = { ...alice, scopeRestricted: true, allowedRecordIds: [granted.recordId] };
      await refused(() => port.get({ actor: worker, recordId: granted.recordId }), "NOT_FOUND");
      expect((await port.search({ actor: worker, query: "forgotten" })).hits).toEqual([]);
    },
  },
  {
    group: "worker-scoped delegation",
    title: "a granted record matches its query's terms in any order, within the caller's limit",
    run: async ({ port }) => {
      const lisbon = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice moved to Lisbon last year" });
      const widgets: string[] = [];
      for (let index = 0; index < 3; index += 1)
        widgets.push(
          (await approved(port, { actor: alice, scope: personal, kind: "fact", body: `shared note about widgets ${index}` })).recordId,
        );
      expect(
        ids(
          (await port.search({ actor: { ...alice, scopeRestricted: true, allowedRecordIds: [lisbon.recordId] }, query: "Lisbon Alice" }))
            .hits,
        ),
      ).toEqual([lisbon.recordId]);
      expect(
        (await port.search({ actor: { ...alice, scopeRestricted: true, allowedRecordIds: widgets }, query: "widgets", limit: 2 })).hits,
      ).toHaveLength(2);
    },
  },

  // ── a group's reach ─────────────────────────────────────────────────
  {
    group: "chat-only reach",
    title: "memory invariant 5: a group reads no personal memory or preference, only its chat's notes, and its side chat its parent's",
    aliceReadsShared: true,
    run: async ({ port }) => {
      const group: MemoryActor = { ...alice, runId: "group-home", authority: "model", reach: "chat-only" };
      const fact = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "wombat: alice lives in Lisbon" });
      const preference = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "short" },
        body: "wombat tone short",
      });
      const persona = await approved(port, {
        actor: alice,
        scope: { kind: "personal_agent", principalId: "alice", agentId: "agent-main" },
        kind: "fact",
        body: "wombat persona fact",
      });
      const note = await approved(port, {
        actor: { ...alice, runId: "group-home" },
        scope: runLocal("group-home"),
        durable: true,
        kind: "fact",
        body: "wombat: the group meets on Fridays",
      });
      expect(ids((await port.search({ actor: group, query: "wombat" })).hits)).toEqual([note.recordId]);
      expect(ids(await port.list({ actor: group }))).toEqual([note.recordId]);
      expect((await port.resolvePreferences({ actor: group })).preferences).toEqual([]);
      for (const record of [fact, preference, persona])
        await refused(() => port.get({ actor: group, recordId: record.recordId }), "NOT_FOUND");
      expect((await port.get({ actor: group, recordId: note.recordId })).recordId).toBe(note.recordId);
      await refused(() => port.list({ actor: group, scope: personal }), "NOT_AUTHORIZED");
      await refused(() => port.search({ actor: group, query: "wombat", scope: shared }), "NOT_AUTHORIZED");
      const topic: MemoryActor = { ...alice, runId: "topic-1", parentChatId: "group-home", authority: "model", reach: "chat-only" };
      expect(ids((await port.search({ actor: topic, query: "wombat" })).hits)).toEqual([note.recordId]);
      expect(ids((await port.search({ actor: { ...alice, runId: "home" }, query: "wombat" })).hits).sort()).toEqual(
        [fact.recordId, preference.recordId, persona.recordId].sort(),
      );
    },
  },
  {
    group: "chat-only reach",
    title: "memory invariant 5: a group proposes only its chat's notes",
    run: async ({ port }) => {
      const group: MemoryActor = { ...alice, runId: "group-home", authority: "model", reach: "chat-only" };
      await refused(() => port.propose({ actor: group, scope: personal, kind: "fact", body: "a member said so" }), "NOT_AUTHORIZED");
      await refused(() => port.propose({ actor: group, scope: aliceWorkspace, kind: "fact", body: "a member said so" }), "NOT_AUTHORIZED");
      expect(
        (await port.propose({ actor: group, scope: runLocal("group-home"), durable: true, kind: "fact", body: "meets on Fridays" })).status,
      ).toBe("proposed");
    },
  },

  // ── eligibility by id ───────────────────────────────────────────────
  {
    group: "eligibility by id",
    title: "memory invariant 4: answers an eligible record whatever its words, rendered as search renders it, in the order asked",
    run: async ({ port }) => {
      const garden = await approved(port, { actor: alice, scope: personal, kind: "fact", title: "Garden", body: "Alice keeps a garden" });
      const roses = await approved(port, { actor: alice, scope: aliceWorkspace, kind: "fact", body: "Alice grows roses" });
      const [found] = (await port.search({ actor: alice, query: "garden" })).hits;
      const checked = await port.eligible({ actor: alice, recordIds: [roses.recordId, garden.recordId, roses.recordId] });
      expect(ids(checked)).toEqual([roses.recordId, garden.recordId]);
      // The same hit, with the same title and excerpt, the search's own rows render.
      expect(checked[1]).toEqual(found);
      expect(checked[0]).toMatchObject({
        revisionId: roses.currentRevisionId,
        snippet: "Alice grows roses",
        superseded: false,
        conflict: false,
      });
      expect(await port.eligible({ actor: alice, recordIds: [] })).toEqual([]);
    },
  },
  {
    group: "eligibility by id",
    title:
      "memory invariant 4: leaves out another person's, a proposed, rejected, revoked, forgotten, sensitive, ended or expired record, and an unknown id, without naming it",
    run: async ({ port, at }) => {
      const kept = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "kept" });
      const bobs = await approved(port, { actor: bob, scope: { kind: "personal", principalId: "bob" }, kind: "fact", body: "bob's own" });
      const proposed = await port.propose({ actor: model, scope: personal, kind: "fact", body: "waiting" });
      const rejected = await port.propose({ actor: model, scope: personal, kind: "fact", body: "turned down" });
      await port.reject({ actor: alice, recordId: rejected.recordId });
      const revoked = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "taken back" });
      await port.revoke({ actor: alice, recordId: revoked.recordId, reason: "no longer true" });
      const forgotten = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "erased" });
      await port.forget({ actor: alice, recordId: forgotten.recordId, reason: "operator request" });
      const sensitive = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "confidential detail",
        sensitivity: "sensitive",
      });
      const ended = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "in Lisbon until Friday",
        validTo: END_OF_FRIDAY,
      });
      const expiring = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "lesson",
        body: "short answers this week",
        expiryAt: END_OF_FRIDAY,
      });
      const asked = [kept, bobs, proposed, rejected, revoked, forgotten, sensitive, ended, expiring].map((record) => record.recordId);
      expect(ids(await port.eligible({ actor: alice, recordIds: [...asked, "mem-unknown"] }))).toEqual([
        kept.recordId,
        ended.recordId,
        expiring.recordId,
      ]);
      // Sensitive only when asked for, as search's `includeSensitive`.
      expect(ids(await port.eligible({ actor: alice, recordIds: [sensitive.recordId], includeSensitive: true }))).toEqual([
        sensitive.recordId,
      ]);
      at(SATURDAY);
      expect(ids(await port.eligible({ actor: alice, recordIds: asked }))).toEqual([kept.recordId]);
    },
  },
  {
    group: "eligibility by id",
    title: "memory invariant 4: answers a corrected record at its current revision, and drops one citing a revoked source",
    run: async ({ port, harness }) => {
      await harness.addSource({ sourceId: "src-1", scopeKey: memoryScopeKey(personal) });
      const record = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice keeps a garden" });
      const corrected = await port.correct({ actor: alice, recordId: record.recordId, body: "Alice keeps a vegetable garden" });
      const cited = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice grows roses", sourceIds: ["src-1"] });
      const before = await port.eligible({ actor: alice, recordIds: [record.recordId, cited.recordId] });
      expect(before.map((hit) => hit.revisionId)).toEqual([corrected.currentRevisionId, cited.currentRevisionId]);
      await harness.revokeSource("src-1");
      expect(ids(await port.eligible({ actor: alice, recordIds: [record.recordId, cited.recordId] }))).toEqual([record.recordId]);
    },
  },
  {
    group: "eligibility by id",
    title: "memory invariant 4: a delegated worker is answered only what it was granted, a group only its chat's notes",
    run: async ({ port }) => {
      const granted = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "shared with the worker" });
      const ungranted = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "never shared" });
      const worker: MemoryActor = { ...alice, scopeRestricted: true, allowedRecordIds: [granted.recordId] };
      expect(ids(await port.eligible({ actor: worker, recordIds: [granted.recordId, ungranted.recordId] }))).toEqual([granted.recordId]);
      const note = await approved(port, {
        actor: { ...alice, runId: "group-home" },
        scope: runLocal("group-home"),
        durable: true,
        kind: "fact",
        body: "the group meets on Fridays",
      });
      const group: MemoryActor = { ...alice, runId: "group-home", authority: "model", reach: "chat-only" };
      expect(ids(await port.eligible({ actor: group, recordIds: [granted.recordId, note.recordId] }))).toEqual([note.recordId]);
    },
  },
  {
    group: "eligibility by id",
    title: "refuses more ids than one search answers",
    run: async ({ port }) => {
      await refused(
        () => port.eligible({ actor: alice, recordIds: Array.from({ length: MEMORY_SEARCH_MAX + 1 }, (_, index) => `mem-${index}`) }),
        "INVALID_INPUT",
      );
    },
  },

  // ── erasure ─────────────────────────────────────────────────────────
  {
    group: "erasure",
    title: "forgets a record completely, with a receipt that carries no content",
    run: async ({ port }) => {
      const record = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "SECRETBODY here" });
      const deletion = await port.forget({ actor: alice, recordId: record.recordId, reason: "operator request" });
      expect(deletion).toMatchObject({ recordId: record.recordId, cleanupStatus: "complete", scopeKey: memoryScopeKey(personal) });
      expect(JSON.stringify(deletion)).not.toContain("SECRETBODY");
      await refused(() => port.get({ actor: alice, recordId: record.recordId }), "NOT_FOUND");
      await refused(() => port.history({ actor: alice, recordId: record.recordId }), "NOT_FOUND");
      expect((await port.search({ actor: alice, query: "SECRETBODY", includeSensitive: true })).hits).toEqual([]);
      expect(JSON.stringify(await port.export({ actor: alice }))).not.toContain("SECRETBODY");
    },
  },
  {
    group: "erasure",
    title: "answers each forget with its own receipt",
    run: async ({ port }) => {
      const first = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "A" });
      const second = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "B" });
      const deletionA = await port.forget({ actor: alice, recordId: first.recordId, reason: "erase A" });
      const deletionB = await port.forget({ actor: alice, recordId: second.recordId, reason: "erase B" });
      expect(deletionA.recordId).toBe(first.recordId);
      expect(deletionB.recordId).toBe(second.recordId);
      expect(deletionA.deletionId).not.toBe(deletionB.deletionId);
    },
  },
  {
    group: "erasure",
    title: "revokes without erasing: out of recall, kept for audit, idempotent, and only for approved memory",
    run: async ({ port }) => {
      const record = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "revocable note" });
      expect((await port.revoke({ actor: alice, recordId: record.recordId, reason: "access withdrawn" })).status).toBe("revoked");
      expect((await port.revoke({ actor: alice, recordId: record.recordId, reason: "again" })).status).toBe("revoked");
      expect((await port.search({ actor: alice, query: "revocable" })).hits).toEqual([]);
      expect((await port.history({ actor: alice, recordId: record.recordId })).revisions).toHaveLength(1);
      expect((await port.forget({ actor: alice, recordId: record.recordId, reason: "now erase" })).cleanupStatus).toBe("complete");
      const proposal = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "unapproved" });
      await refused(() => port.revoke({ actor: alice, recordId: proposal.recordId, reason: "too soon" }), "CONFLICT");
    },
  },

  // ── preferences ─────────────────────────────────────────────────────
  {
    group: "preferences",
    title: "resolve by precedence, answering the value and what it overrode",
    run: async ({ port }) => {
      const general = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "ui.theme",
        preference: { valueType: "string", value: "dark" },
        body: "dark",
      });
      const here = await approved(port, {
        actor: alice,
        scope: aliceWorkspace,
        kind: "preference",
        preferenceKey: "ui.theme",
        preference: { valueType: "string", value: "light" },
        body: "light",
      });
      const resolved = (await port.resolvePreferences({ actor: alice })).preferences;
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.winner.recordId).toBe(here.recordId);
      expect(ids(resolved[0]?.overridden ?? [])).toEqual([general.recordId]);
      expect(resolved[0]?.value).toBe("light");
      expect(resolved[0]?.conflict).toBe(false);
    },
  },
  {
    group: "preferences",
    title: "an unapproved preference does not resolve, nor a sensitive one unless asked",
    run: async ({ port }) => {
      await port.propose({ actor: alice, scope: personal, kind: "preference", preferenceKey: "ui.density", body: "compact" });
      expect((await port.resolvePreferences({ actor: alice })).preferences).toEqual([]);
      await approved(port, {
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "secret.setting",
        preference: { valueType: "string", value: "hidden" },
        body: "hidden",
        sensitivity: "sensitive",
      });
      expect((await port.resolvePreferences({ actor: alice })).preferences).toEqual([]);
      expect((await port.resolvePreferences({ actor: alice, includeSensitive: true })).preferences).toHaveLength(1);
    },
  },
  {
    group: "preferences",
    title: "a persona's preference in this workspace outranks its workspace-agnostic one, with no conflict in resolution or search",
    run: async ({ port }) => {
      const anywhere = await approved(port, {
        actor: alice,
        scope: { kind: "personal_agent", principalId: "alice", agentId: "agent-main" },
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "formal" },
        body: "formal tone setting",
      });
      const here = await approved(port, {
        actor: alice,
        scope: { kind: "personal_agent", principalId: "alice", agentId: "agent-main", workspaceId: "w1" },
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "casual" },
        body: "casual tone setting",
      });
      await approved(port, { actor: alice, scope: personal, kind: "fact", body: "unrelated tone fact" });
      const resolved = (await port.resolvePreferences({ actor: alice })).preferences;
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ conflict: false, value: "casual" });
      expect(resolved[0]?.winner.recordId).toBe(here.recordId);
      expect(ids(resolved[0]?.overridden ?? [])).toEqual([anywhere.recordId]);
      const hits = (await port.search({ actor: alice, query: "tone" })).hits;
      expect(hits.filter((hit) => hit.kind === "preference").length).toBeGreaterThan(0);
      expect(hits.every((hit) => !hit.conflict)).toBe(true);
    },
  },
  {
    group: "preferences",
    title: "falls back to a current lower-precedence value when the higher one has expired",
    run: async ({ port, at }) => {
      await approved(port, {
        actor: alice,
        scope: { kind: "personal_agent", principalId: "alice", agentId: "agent-main" },
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "formal" },
        body: "formal",
        expiryAt: END_OF_FRIDAY,
      });
      const general = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "casual" },
        body: "casual",
      });
      expect((await port.resolvePreferences({ actor: alice })).preferences[0]?.value).toBe("formal");
      at(SATURDAY);
      const resolved = (await port.resolvePreferences({ actor: alice })).preferences;
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        value: "casual",
        conflict: false,
        winner: expect.objectContaining({ recordId: general.recordId }),
      });
    },
  },

  // ── export ──────────────────────────────────────────────────────────
  {
    group: "export",
    title: "never includes a forgotten record, and scopes evidence to the records it exports",
    run: async ({ port, harness }) => {
      const kept = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "kept" });
      const gone = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "to be forgotten" });
      await port.forget({ actor: alice, recordId: gone.recordId, reason: "erase it" });
      await harness.addSource({ sourceId: "src-foreign", scopeKey: memoryScopeKey(personal), recordId: "some-other-record" });
      const result = await port.export({ actor: alice });
      expect(ids(result.records)).toEqual([kept.recordId]);
      expect(result.records.some((record) => record.status === "deleted")).toBe(false);
      expect(result.evidence.some((source) => source.sourceId === "src-foreign")).toBe(false);
      expect(result.truncated).toBe(false);
    },
  },

  // ── quotas and bounds ───────────────────────────────────────────────
  {
    group: "quotas and bounds",
    title: "refuses a write past the record quota instead of evicting",
    quotas: { maxRecords: 1, maxBytes: 1_000_000 },
    run: async ({ port }) => {
      const first = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "first" });
      await refused(() => port.propose({ actor: alice, scope: personal, kind: "fact", body: "second" }), "QUOTA_EXCEEDED");
      expect((await port.usage({ actor: alice })).records).toBe(1);
      expect((await port.get({ actor: alice, recordId: first.recordId })).status).toBe("proposed");
    },
  },
  {
    group: "quotas and bounds",
    title: "bounds a page to what was asked, and refuses a fractional or negative offset",
    run: async ({ port }) => {
      for (let index = 0; index < 3; index += 1) await port.propose({ actor: alice, scope: personal, kind: "fact", body: `note ${index}` });
      expect(await port.list({ actor: alice, limit: 100_000 })).toHaveLength(3);
      expect(await port.list({ actor: alice, limit: 2 })).toHaveLength(2);
      expect((await port.list({ actor: alice, limit: 0 })).length).toBeLessThanOrEqual(1);
      expect(await port.list({ actor: alice, offset: 1_000_000 })).toEqual([]);
      await refused(() => port.list({ actor: alice, offset: 1.5 }), "INVALID_INPUT");
      await refused(() => port.list({ actor: alice, offset: -1 }), "INVALID_INPUT");
    },
  },
  {
    group: "quotas and bounds",
    title: "answers no matches as complete coverage, refuses a blank or over-long query, and reads query syntax as words",
    run: async ({ port }) => {
      await approved(port, { actor: alice, scope: personal, kind: "fact", body: 'findable quotes "and" stars *' });
      const found = await port.search({ actor: alice, query: "findable" });
      expect(found.coverage).toBe("complete");
      expect(found.hits).toHaveLength(1);
      expect(await port.search({ actor: alice, query: "nothing-matches-this" })).toMatchObject({ coverage: "complete", hits: [] });
      await refused(() => port.search({ actor: alice, query: "  " }), "INVALID_INPUT");
      await refused(() => port.search({ actor: alice, query: "x".repeat(600) }), "INVALID_INPUT");
      expect((await port.search({ actor: alice, query: '"unterminated NEAR(' })).coverage).toBe("complete");
      expect((await port.search({ actor: alice, query: 'findable OR "NEAR(', match: "any" })).coverage).toBe("complete");
    },
  },
  {
    group: "quotas and bounds",
    title: "finds a record by a multi-word query in any order",
    run: async ({ port }) => {
      await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice moved to Lisbon last year" });
      expect((await port.search({ actor: alice, query: "Lisbon Alice" })).hits).toHaveLength(1);
    },
  },
  {
    group: "quotas and bounds",
    title: "memory invariant 7: leaves sensitive records out of search unless asked",
    run: async ({ port }) => {
      await approved(port, { actor: alice, scope: personal, kind: "fact", body: "confidential detail", sensitivity: "sensitive" });
      expect((await port.search({ actor: alice, query: "confidential" })).hits).toEqual([]);
      expect((await port.search({ actor: alice, query: "confidential", includeSensitive: true })).hits).toHaveLength(1);
    },
  },
  {
    group: "quotas and bounds",
    title: "refuses bodies, titles, keys, sources, dates and reasons past their bounds, and accepts each at its bound",
    run: async ({ port }) => {
      const over = async (extra: Partial<ProposeInput>) =>
        await refused(() => port.propose({ actor: alice, scope: personal, kind: "fact", body: "ok", ...extra }), "INVALID_INPUT");
      await over({ body: "x".repeat(MAX_MEMORY_BODY_BYTES + 1) });
      await over({ title: "x".repeat(MAX_MEMORY_TITLE_CHARS + 1) });
      await over({
        kind: "preference",
        preferenceKey: "x".repeat(MAX_PREFERENCE_KEY_CHARS + 1),
        preference: { valueType: "string", value: "v" },
      });
      await over({ topicKey: "k".repeat(MAX_TOPIC_KEY_CHARS + 1) });
      await over({ sourceIds: Array.from({ length: MAX_SOURCE_IDS + 1 }, (_, index) => `s${index}`) });
      await over({ observedAt: "not-a-date" });
      await over({ expiryAt: "not-a-date" });
      // A body is bounded in UTF-8 bytes, not characters.
      const emoji = "\u{1F600}".repeat(MAX_MEMORY_BODY_BYTES / 4 + 1);
      expect(emoji.length).toBeLessThan(MAX_MEMORY_BODY_BYTES);
      await over({ body: emoji });
      for (const atBound of [
        { body: "x".repeat(MAX_MEMORY_BODY_BYTES) },
        { body: "\u{1F600}".repeat(MAX_MEMORY_BODY_BYTES / 4) },
        { title: "x".repeat(MAX_MEMORY_TITLE_CHARS) },
        {
          kind: "preference" as const,
          preferenceKey: "x".repeat(MAX_PREFERENCE_KEY_CHARS),
          preference: { valueType: "string" as const, value: "v" },
        },
        { sourceIds: Array.from({ length: MAX_SOURCE_IDS }, (_, index) => `s${index}`) },
      ]) {
        const accepted = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "ok", ...atBound });
        expect(accepted.status).toBe("proposed");
        if (atBound.body !== undefined) expect(utf8Bytes(atBound.body)).toBe(MAX_MEMORY_BODY_BYTES);
      }
      const record = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "note" });
      await refused(() => port.revoke({ actor: alice, recordId: record.recordId, reason: "  " }), "INVALID_INPUT");
      await refused(() => port.forget({ actor: alice, recordId: record.recordId, reason: "x".repeat(501) }), "INVALID_INPUT");
      expect((await port.revoke({ actor: alice, recordId: record.recordId, reason: "x".repeat(500) })).status).toBe("revoked");
    },
  },

  // ── match any ───────────────────────────────────────────────────────
  {
    group: "match any",
    title:
      "finds a record holding one term, the fuller match first, and an all search falls back to partial matches when no record holds every word",
    run: async ({ port }) => {
      const lives = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice lives in Lisbon" });
      const books = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice books hotels near Lisbon cathedral" });
      const fallback = await port.search({ actor: alice, query: "hotels lisbon cathedral budget" });
      expect(fallback.match).toBe("any");
      expect(ids(fallback.hits)).toEqual([books.recordId, lives.recordId]);
      expect(ids((await port.search({ actor: alice, query: "hotels lisbon cathedral budget", match: "any" })).hits)).toEqual([
        books.recordId,
        lives.recordId,
      ]);
      const none = await port.search({ actor: alice, query: "porto garden" });
      expect(none.hits).toHaveLength(0);
      expect(none.match).toBeUndefined();
    },
  },

  // ── typed conflicts ─────────────────────────────────────────────────
  {
    group: "typed conflicts",
    title: "a second active value for a preference key in the same scope is MEMORY_CONFLICT",
    run: async ({ port }) => {
      const first = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "ui.theme",
        preference: { valueType: "string", value: "dark" },
        body: "dark",
      });
      const second = await port.propose({
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "ui.theme",
        preference: { valueType: "string", value: "light" },
        body: "light",
      });
      await refused(() => port.approve({ actor: alice, recordId: second.recordId }), "MEMORY_CONFLICT");
      expect((await port.get({ actor: alice, recordId: first.recordId })).status).toBe("approved");
      expect((await port.get({ actor: alice, recordId: second.recordId })).status).toBe("proposed");
    },
  },

  // ── contradictory facts ─────────────────────────────────────────────
  {
    group: "contradictory facts",
    title: "keeps a topic key through propose and get",
    run: async ({ port }) => {
      const record = await port.propose({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice's favorite color is blue",
        topicKey: "alice.favorite-color",
      });
      expect(record.topicKey).toBe("alice.favorite-color");
      expect((await port.get({ actor: alice, recordId: record.recordId })).topicKey).toBe("alice.favorite-color");
    },
  },
  {
    group: "contradictory facts",
    title: "flags facts sharing a topic key as a conflict with no winner, whichever is newer, and one alone as none",
    run: async ({ port }) => {
      const lisbon = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice lives in Lisbon",
        topicKey: "alice.city",
      });
      const porto = await approved(port, {
        actor: alice,
        scope: aliceWorkspace,
        kind: "fact",
        body: "Alice lives in Porto",
        topicKey: "alice.city",
      });
      const braga = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice lives in Braga",
        topicKey: "alice.city",
      });
      await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice keeps a garden", topicKey: "alice.hobby" });
      const groups = await port.resolveFactConflicts({ actor: alice });
      const city = groups.find((group) => group.topicKey === "alice.city");
      expect(city?.conflict).toBe(true);
      expect(new Set(ids(city?.records ?? []))).toEqual(new Set([lisbon.recordId, porto.recordId, braga.recordId]));
      expect(groups.find((group) => group.topicKey === "alice.hobby")).toMatchObject({
        conflict: false,
        records: [expect.objectContaining({ topicKey: "alice.hobby" })],
      });
      expect((await port.resolveFactConflicts({ actor: alice, topicKeys: ["alice.city"] })).map((group) => group.topicKey)).toEqual([
        "alice.city",
      ]);
    },
  },
  {
    group: "contradictory facts",
    title: "a search hit names the records it conflicts with, and a hit with none is not flagged",
    run: async ({ port }) => {
      const lisbon = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice lives in Lisbon",
        topicKey: "alice.city",
      });
      const porto = await approved(port, {
        actor: alice,
        scope: aliceWorkspace,
        kind: "fact",
        body: "Alice lives in Porto",
        topicKey: "alice.city",
      });
      const garden = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice keeps a garden",
        topicKey: "alice.hobby",
      });
      const hits = (await port.search({ actor: alice, query: "Alice" })).hits;
      expect(hits.find((hit) => hit.recordId === lisbon.recordId)).toMatchObject({ conflict: true, conflictsWith: [porto.recordId] });
      expect(hits.find((hit) => hit.recordId === porto.recordId)).toMatchObject({ conflict: true, conflictsWith: [lisbon.recordId] });
      const hobby = hits.find((hit) => hit.recordId === garden.recordId);
      expect(hobby?.conflict).toBe(false);
      expect(hobby).not.toHaveProperty("conflictsWith");
    },
  },
  {
    group: "contradictory facts",
    title: "excerpts a hit as its whole body up to 300 characters, else a window around the match, with its title",
    run: async ({ port }) => {
      const short = `Alice's Lisbon flat: ${"a".repeat(170)} rent is 900`;
      const long = `${"filler words ".repeat(40)}the Lisbon garden ${"more filler ".repeat(40)}`;
      const shortId = (await port.remember({ actor: alice, scope: personal, kind: "fact", title: "Flat", body: short })).recordId;
      const longId = (await port.remember({ actor: alice, scope: personal, kind: "fact", body: long })).recordId;
      const hits = (await port.search({ actor: alice, query: "Lisbon" })).hits;
      expect(hits.find((hit) => hit.recordId === shortId)).toMatchObject({ title: "Flat", snippet: short });
      const longHit = hits.find((hit) => hit.recordId === longId);
      expect(longHit?.snippet).toContain("Lisbon");
      expect(longHit?.snippet.length).toBeLessThan(long.length);
    },
  },
  {
    group: "contradictory facts",
    title: "leaves sensitive facts out of conflicts unless asked, dropping only them from a group",
    run: async ({ port }) => {
      const visible = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice lives in Lisbon",
        topicKey: "alice.city",
      });
      await approved(port, {
        actor: alice,
        scope: aliceWorkspace,
        kind: "fact",
        body: "Alice lives in Porto",
        topicKey: "alice.city",
        sensitivity: "sensitive",
      });
      await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice was born in Faro",
        topicKey: "alice.birthplace",
        sensitivity: "sensitive",
      });
      const plain = await port.resolveFactConflicts({ actor: alice });
      expect(plain.find((group) => group.topicKey === "alice.birthplace")).toBeUndefined();
      expect(plain.find((group) => group.topicKey === "alice.city")).toMatchObject({
        conflict: false,
        records: [expect.objectContaining({ recordId: visible.recordId })],
      });
      const all = await port.resolveFactConflicts({ actor: alice, includeSensitive: true });
      expect(all.find((group) => group.topicKey === "alice.city")).toMatchObject({ conflict: true });
      expect(all.find((group) => group.topicKey === "alice.city")?.records).toHaveLength(2);
    },
  },

  // ── sources ─────────────────────────────────────────────────────────
  {
    group: "source availability",
    title: "refuses to propose a record citing a revoked source, and not one citing an unknown id",
    run: async ({ port, harness }) => {
      await harness.addSource({ sourceId: "src-1", scopeKey: memoryScopeKey(personal), revoked: true });
      await refused(
        () => port.propose({ actor: alice, scope: personal, kind: "fact", body: "cites it", sourceIds: ["src-1"] }),
        "SOURCE_UNAVAILABLE",
      );
      expect(
        (await port.propose({ actor: alice, scope: personal, kind: "fact", body: "cites unknown", sourceIds: ["src-x"] })).status,
      ).toBe("proposed");
    },
  },
  {
    group: "revoked-source rechecking",
    title: "a hit whose source is revoked after approval leaves search; one citing no source or an active one stays",
    run: async ({ port, harness }) => {
      await harness.addSource({ sourceId: "src-1", scopeKey: memoryScopeKey(personal) });
      await harness.addSource({ sourceId: "src-2", scopeKey: memoryScopeKey(personal) });
      const cited = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice keeps a garden",
        sourceIds: ["src-1"],
      });
      const active = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice grows garden roses",
        sourceIds: ["src-2"],
      });
      const uncited = await approved(port, { actor: alice, scope: personal, kind: "fact", body: "Alice enjoys garden walks" });
      expect(ids((await port.search({ actor: alice, query: "garden" })).hits).sort()).toEqual(
        [cited.recordId, active.recordId, uncited.recordId].sort(),
      );
      await harness.revokeSource("src-1");
      expect(ids((await port.search({ actor: alice, query: "garden" })).hits).sort()).toEqual([active.recordId, uncited.recordId].sort());
    },
  },
  {
    group: "revoked-source rechecking",
    title: "a preference whose source is revoked stops resolving, and a lower one takes its place",
    run: async ({ port, harness }) => {
      const agent: MemoryScope = { kind: "personal_agent", principalId: "alice", agentId: "agent-main" };
      await harness.addSource({ sourceId: "src-top", scopeKey: memoryScopeKey(agent) });
      await harness.addSource({ sourceId: "src-theme", scopeKey: memoryScopeKey(personal) });
      await approved(port, {
        actor: alice,
        scope: agent,
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "formal" },
        body: "formal tone",
        sourceIds: ["src-top"],
      });
      const lower = await approved(port, {
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "casual" },
        body: "casual tone",
      });
      await approved(port, {
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "ui.theme",
        preference: { valueType: "string", value: "dark" },
        body: "dark mode",
        sourceIds: ["src-theme"],
      });
      const before = (await port.resolvePreferences({ actor: alice })).preferences;
      expect(before.find((entry) => entry.key === "tone")?.value).toBe("formal");
      expect(before.find((entry) => entry.key === "ui.theme")).toBeDefined();
      await harness.revokeSource("src-top");
      await harness.revokeSource("src-theme");
      const after = (await port.resolvePreferences({ actor: alice })).preferences;
      expect(after.find((entry) => entry.key === "tone")).toMatchObject({
        value: "casual",
        winner: expect.objectContaining({ recordId: lower.recordId }),
      });
      expect(after.find((entry) => entry.key === "ui.theme")).toBeUndefined();
    },
  },
  {
    group: "revoked-source rechecking",
    title: "a fact whose source is revoked leaves its conflict group",
    run: async ({ port, harness }) => {
      await harness.addSource({ sourceId: "src-1", scopeKey: memoryScopeKey(personal) });
      await approved(port, {
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice lives in Lisbon",
        topicKey: "alice.city",
        sourceIds: ["src-1"],
      });
      await approved(port, { actor: alice, scope: aliceWorkspace, kind: "fact", body: "Alice lives in Porto", topicKey: "alice.city" });
      expect((await port.resolveFactConflicts({ actor: alice })).find((group) => group.topicKey === "alice.city")?.conflict).toBe(true);
      await harness.revokeSource("src-1");
      const after = (await port.resolveFactConflicts({ actor: alice })).find((group) => group.topicKey === "alice.city");
      expect(after?.records).toHaveLength(1);
      expect(after?.conflict).toBe(false);
    },
  },

  // ── sweepExpired ────────────────────────────────────────────────────
  {
    group: "sweepExpired",
    title: "expires a proposal nobody reviewed in its window and erases a stale rejection, then the lapsed proposal a window later",
    run: async ({ port, at }) => {
      const stale = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "stale proposal" });
      const rejected = await port.reject({
        actor: alice,
        recordId: (await port.propose({ actor: alice, scope: personal, kind: "fact", body: "stale rejection" })).recordId,
      });
      at("2026-01-25T00:00:00.000Z");
      const fresh = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "fresh proposal" });
      const later = "2026-02-01T00:00:00.000Z";
      at(later);
      const swept = await port.sweepExpired({ actor: alice });
      expect(swept.map((entry) => [entry.recordId, entry.outcome])).toEqual([
        [stale.recordId, "expired"],
        [rejected.recordId, "forgotten"],
      ]);
      expect(swept.every((entry) => entry.reason.startsWith("retention:"))).toBe(true);
      expect(await port.get({ actor: alice, recordId: stale.recordId })).toMatchObject({ status: "expired", updatedAt: later });
      await refused(() => port.get({ actor: alice, recordId: rejected.recordId }), "NOT_FOUND");
      expect((await port.get({ actor: alice, recordId: fresh.recordId })).status).toBe("proposed");
      await refused(() => port.approve({ actor: alice, recordId: stale.recordId }), "CONFLICT");
      at("2026-03-05T00:00:00.000Z");
      expect((await port.sweepExpired({ actor: alice })).find((entry) => entry.recordId === stale.recordId)?.outcome).toBe("forgotten");
      await refused(() => port.get({ actor: alice, recordId: stale.recordId }), "NOT_FOUND");
    },
  },
  {
    group: "sweepExpired",
    title: "expires a proposal at its own earlier end, and never an approved record that has none",
    run: async ({ port, at }) => {
      const short = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "until Friday", expiryAt: END_OF_FRIDAY });
      const kept = await port.remember({ actor: alice, scope: personal, kind: "fact", body: "keeps a garden" });
      at("2026-01-04T00:00:00.000Z");
      expect((await port.sweepExpired({ actor: alice })).map((entry) => [entry.recordId, entry.outcome])).toEqual([
        [short.recordId, "expired"],
      ]);
      at("2026-06-01T00:00:00.000Z");
      expect(ids(await port.sweepExpired({ actor: alice }))).not.toContain(kept.recordId);
      expect((await port.get({ actor: alice, recordId: kept.recordId })).status).toBe("approved");
    },
  },
  {
    group: "sweepExpired",
    title: "erases a run-local record past its default once, even when it is also a stale proposal, and leaves approved personal memory",
    run: async ({ port, at }) => {
      const inRun: MemoryActor = { ...alice, runId: "run-1" };
      const note = await port.remember({ actor: inRun, scope: runLocal("run-1"), kind: "fact", body: "temp note" });
      const kept = await port.remember({ actor: alice, scope: personal, kind: "fact", body: "keeps a garden" });
      const inOther: MemoryActor = { ...alice, runId: "run-2" };
      const both = await port.propose({ actor: inOther, scope: runLocal("run-2"), kind: "fact", body: "still proposed" });
      at(daysAfter(THURSDAY, DEFAULT_MEMORY_RETENTION_DAYS.runLocal + 1));
      const swept = await port.sweepExpired({ actor: inRun });
      expect(ids(swept)).toEqual([note.recordId]);
      expect(swept[0]?.reason).toContain("run-local");
      await refused(() => port.get({ actor: alice, recordId: note.recordId }), "NOT_FOUND");
      expect((await port.get({ actor: alice, recordId: kept.recordId })).status).toBe("approved");
      at(daysAfter(THURSDAY, DEFAULT_MEMORY_RETENTION_DAYS.proposedOrRejected + 1));
      const dual = await port.sweepExpired({ actor: inOther });
      expect(ids(dual)).toEqual([both.recordId]);
      expect(dual[0]?.reason).toContain("run-local");
    },
  },
  {
    group: "sweepExpired",
    title: "takes an explicit policy, and refuses a model",
    run: async ({ port, at }) => {
      const proposal = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "x" });
      at("2026-01-02T00:00:00.000Z");
      expect(await port.sweepExpired({ actor: alice })).toEqual([]);
      const untouched = await port.propose({ actor: alice, scope: personal, kind: "fact", body: "y" });
      await refused(() => port.sweepExpired({ actor: model, policy: { proposedOrRejected: 0, runLocal: 0 } }), "NOT_AUTHORIZED");
      expect(
        (await port.sweepExpired({ actor: alice, policy: { proposedOrRejected: 1, runLocal: 1 } })).map((entry) => [
          entry.recordId,
          entry.outcome,
        ]),
      ).toEqual([[proposal.recordId, "expired"]]);
      expect((await port.get({ actor: alice, recordId: untouched.recordId })).status).toBe("proposed");
    },
  },

  // ── dedup ───────────────────────────────────────────────────────────
  {
    group: "dedup",
    title:
      "memory invariant 16: the same proposal filed twice is one record, folded for case and space, against a proposal or a kept record",
    run: async ({ port }) => {
      const first = await port.propose({ actor: model, scope: personal, kind: "fact", body: "You're vegetarian" });
      expect(first.known).toBeUndefined();
      expect(await port.propose({ actor: model, scope: personal, kind: "fact", body: "  YOU'RE   vegetarian " })).toMatchObject({
        recordId: first.recordId,
        known: "exact",
        status: "proposed",
      });
      await port.approve({ actor: alice, recordId: first.recordId });
      expect(await port.propose({ actor: model, scope: personal, kind: "fact", body: "you're vegetarian" })).toMatchObject({
        recordId: first.recordId,
        known: "exact",
        status: "approved",
      });
      expect(await port.remember({ actor: alice, scope: personal, kind: "fact", body: "You're vegetarian" })).toMatchObject({
        recordId: first.recordId,
        known: "exact",
      });
      // Another kind, scope or preference value is another record.
      expect((await port.propose({ actor: model, scope: personal, kind: "lesson", body: "You're vegetarian" })).known).toBeUndefined();
      expect(
        (
          await port.propose({
            actor: { ...model, runId: "chat" },
            scope: runLocal("chat"),
            kind: "fact",
            body: "You're vegetarian",
            durable: true,
          })
        ).known,
      ).toBeUndefined();
      const spanish = await port.propose({
        actor: model,
        scope: personal,
        kind: "preference",
        preferenceKey: "reply.language",
        preference: { valueType: "string", value: "es" },
        body: "Reply language",
      });
      expect(
        (
          await port.propose({
            actor: model,
            scope: personal,
            kind: "preference",
            preferenceKey: "reply.language",
            preference: { valueType: "string", value: "fr" },
            body: "Reply language",
          })
        ).recordId,
      ).not.toBe(spanish.recordId);
      expect(
        (
          await port.propose({
            actor: model,
            scope: personal,
            kind: "preference",
            preferenceKey: "reply.language",
            preference: { valueType: "string", value: "ES" },
            body: "reply   language",
          })
        ).known,
      ).toBe("exact");
      expect(
        (await port.list({ actor: alice })).filter((record) => record.kind === "fact" && record.scopeKey === memoryScopeKey(personal)),
      ).toHaveLength(1);
    },
  },
  {
    group: "dedup",
    title: "remember of words waiting as a proposal approves that proposal",
    run: async ({ port }) => {
      const waiting = await port.propose({ actor: model, scope: personal, kind: "fact", body: "Owns a kayak" });
      expect(await port.remember({ actor: alice, scope: personal, kind: "fact", body: "Owns a kayak" })).toMatchObject({
        recordId: waiting.recordId,
        status: "approved",
        known: "exact",
      });
    },
  },
  {
    group: "dedup",
    title: "matches only what is pending or in force: an ended fact, a rejection and a forgotten record are not known",
    run: async ({ port, at }) => {
      const trip = await port.remember({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Travelling to Lisbon until Friday",
        validTo: END_OF_FRIDAY,
      });
      const allergy = await port.remember({ actor: alice, scope: personal, kind: "fact", body: "Allergic to peanuts" });
      await port.forget({ actor: alice, recordId: allergy.recordId, reason: "test" });
      expect((await port.propose({ actor: model, scope: personal, kind: "fact", body: "Allergic to peanuts" })).known).toBeUndefined();
      at("2026-02-02T09:00:00.000Z");
      const again = await port.propose({ actor: model, scope: personal, kind: "fact", body: "Travelling to Lisbon until Friday" });
      expect(again.known).toBeUndefined();
      expect(again.recordId).not.toBe(trip.recordId);
      expect(await port.get({ actor: alice, recordId: trip.recordId })).toMatchObject({ status: "approved", validTo: END_OF_FRIDAY });
      await port.reject({ actor: alice, recordId: again.recordId });
      expect(
        (await port.propose({ actor: model, scope: personal, kind: "fact", body: "Travelling to Lisbon until Friday" })).known,
      ).toBeUndefined();
    },
  },
  {
    group: "dedup",
    title: "a correction changes what is known",
    run: async ({ port }) => {
      const record = await port.remember({ actor: alice, scope: personal, kind: "fact", body: "Works at Acme" });
      await port.correct({ actor: alice, recordId: record.recordId, body: "Works at Initech" });
      expect((await port.propose({ actor: model, scope: personal, kind: "fact", body: "works at INITECH" })).known).toBe("exact");
      expect((await port.propose({ actor: model, scope: personal, kind: "fact", body: "Works at Acme" })).known).toBeUndefined();
    },
  },
  {
    group: "dedup",
    title: "capture's near-match drop files nothing for a near match of a fact in force, only when asked, and never for an update",
    run: async ({ port }) => {
      const body = "Alice lives in Lisbon with her two cats and a dog";
      const near = "Alice lives in Lisbon with her two cats and dog";
      expect(memoryTextSimilarity(near, body)).toBeGreaterThanOrEqual(MEMORY_NEAR_MATCH_JACCARD);
      const kept = await port.remember({ actor: alice, scope: personal, kind: "fact", body });
      expect(await port.propose({ actor: model, scope: personal, kind: "fact", body: near, nearMatch: "drop" })).toMatchObject({
        recordId: kept.recordId,
        known: "near",
      });
      expect(
        (await port.propose({ actor: model, scope: personal, kind: "fact", body: "Alice moved to Porto last spring", nearMatch: "drop" }))
          .known,
      ).toBeUndefined();
      expect((await port.propose({ actor: model, scope: personal, kind: "fact", body: near })).known).toBeUndefined();
      const british = "Prefers British English spelling in every reply and every written summary";
      const american = "Prefers American English spelling in every reply and every written summary";
      await port.remember({
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "spelling",
        preference: { valueType: "string", value: "British" },
        body: british,
      });
      expect(
        (
          await port.propose({
            actor: model,
            scope: personal,
            kind: "preference",
            preferenceKey: "spelling",
            preference: { valueType: "string", value: "American" },
            body: american,
            nearMatch: "drop",
          })
        ).known,
      ).toBeUndefined();
    },
  },

  // ── end dates ───────────────────────────────────────────────────────
  {
    group: "end dates",
    title: "a fact with validTo leaves recall when it ends and stays approved under past through every sweep",
    run: async ({ port, at }) => {
      const trip = await port.remember({
        actor: alice,
        scope: personal,
        kind: "fact",
        title: "Lisbon",
        body: "Travelling to Lisbon until Friday",
        validTo: END_OF_FRIDAY,
      });
      expect(trip).toMatchObject({ status: "approved", validTo: END_OF_FRIDAY });
      expect(ids((await port.search({ actor: alice, query: "Lisbon" })).hits)).toEqual([trip.recordId]);
      expect(await port.list({ actor: alice, past: true })).toEqual([]);
      for (const later of [SATURDAY, daysAfter(SATURDAY, 40), daysAfter(SATURDAY, 400)]) {
        at(later);
        expect((await port.search({ actor: alice, query: "Lisbon" })).hits).toEqual([]);
        expect(await port.sweepExpired({ actor: alice })).toEqual([]);
        expect(await port.get({ actor: alice, recordId: trip.recordId })).toMatchObject({ status: "approved", validTo: END_OF_FRIDAY });
        expect(ids(await port.list({ actor: alice, past: true }))).toEqual([trip.recordId]);
      }
    },
  },
  {
    group: "end dates",
    title: "an undecided proposal past its validTo is expired by the sweep, never approved into past",
    run: async ({ port, at }) => {
      const proposal = await port.propose({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Travelling to Lisbon until Friday",
        validTo: END_OF_FRIDAY,
      });
      at(SATURDAY);
      expect((await port.sweepExpired({ actor: alice })).map((entry) => [entry.recordId, entry.outcome])).toEqual([
        [proposal.recordId, "expired"],
      ]);
      await refused(() => port.approve({ actor: alice, recordId: proposal.recordId }), "CONFLICT");
      expect(await port.list({ actor: alice, past: true })).toEqual([]);
    },
  },
  {
    group: "end dates",
    title: "correct keeps a date it is not given, null clears it, a past date is refused, and a preference takes expiryAt, not validTo",
    run: async ({ port, at }) => {
      const trip = await port.remember({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Travelling to Lisbon until Friday",
        validTo: END_OF_FRIDAY,
      });
      expect(
        (await port.correct({ actor: alice, recordId: trip.recordId, body: "Travelling to Lisbon and Porto until Friday" })).validTo,
      ).toBe(END_OF_FRIDAY);
      await refused(() => port.correct({ actor: alice, recordId: trip.recordId, validTo: "2025-12-01T00:00:00.000Z" }), "INVALID_INPUT");
      expect((await port.correct({ actor: alice, recordId: trip.recordId, validTo: null })).validTo).toBeUndefined();
      await refused(
        () =>
          port.propose({
            actor: alice,
            scope: personal,
            kind: "preference",
            body: "Reply in French",
            preferenceKey: "reply.language",
            preference: { valueType: "string", value: "fr" },
            validTo: END_OF_FRIDAY,
          }),
        "INVALID_INPUT",
      );
      const german = await port.remember({
        actor: alice,
        scope: personal,
        kind: "preference",
        body: "Reply in German",
        preferenceKey: "reply.language",
        preference: { valueType: "string", value: "de" },
      });
      await refused(() => port.correct({ actor: alice, recordId: german.recordId, validTo: END_OF_FRIDAY }), "INVALID_INPUT");
      expect(await port.correct({ actor: alice, recordId: german.recordId, expiryAt: END_OF_FRIDAY })).toMatchObject({
        expiryAt: END_OF_FRIDAY,
      });
      at(daysAfter(SATURDAY, 10));
      expect(ids((await port.search({ actor: alice, query: "Porto" })).hits)).toEqual([trip.recordId]);
    },
  },
  {
    group: "end dates",
    title:
      "a preference with expiryAt stops applying, is marked expired by the sweep and erased a window after the mark; while it applies a second value conflicts",
    run: async ({ port, at }) => {
      const spanish = await port.remember({
        actor: alice,
        scope: personal,
        kind: "preference",
        body: "Reply in es",
        preferenceKey: "reply.language",
        preference: { valueType: "string", value: "es" },
        expiryAt: END_OF_FRIDAY,
      });
      expect(spanish).toMatchObject({ status: "approved", expiryAt: END_OF_FRIDAY });
      expect(spanish.validTo).toBeUndefined();
      expect((await port.resolvePreferences({ actor: alice })).preferences.map((entry) => entry.value)).toEqual(["es"]);
      await refused(
        () =>
          port.remember({
            actor: alice,
            scope: personal,
            kind: "preference",
            body: "Reply in fr",
            preferenceKey: "reply.language",
            preference: { valueType: "string", value: "fr" },
          }),
        "MEMORY_CONFLICT",
      );
      at(SATURDAY);
      expect((await port.resolvePreferences({ actor: alice })).preferences).toEqual([]);
      expect((await port.sweepExpired({ actor: alice })).map((entry) => [entry.recordId, entry.outcome])).toContainEqual([
        spanish.recordId,
        "expired",
      ]);
      expect(await port.get({ actor: alice, recordId: spanish.recordId })).toMatchObject({ status: "expired", updatedAt: SATURDAY });
      expect(ids(await port.list({ actor: alice, past: true }))).toEqual([spanish.recordId]);
      const window = DEFAULT_MEMORY_RETENTION_DAYS.proposedOrRejected;
      at(daysAfter(SATURDAY, window - 1));
      expect(ids(await port.sweepExpired({ actor: alice }))).not.toContain(spanish.recordId);
      at(daysAfter(SATURDAY, window));
      expect((await port.sweepExpired({ actor: alice })).find((entry) => entry.recordId === spanish.recordId)?.outcome).toBe("forgotten");
      await refused(() => port.get({ actor: alice, recordId: spanish.recordId }), "NOT_FOUND");
    },
  },
  {
    group: "end dates",
    title: "after a preference's end, a new value is approved before any sweep and the old one is expired",
    run: async ({ port, at }) => {
      const old = await port.remember({
        actor: alice,
        scope: personal,
        kind: "preference",
        body: "Reply in es",
        preferenceKey: "reply.language",
        preference: { valueType: "string", value: "es" },
        expiryAt: END_OF_FRIDAY,
      });
      at(SATURDAY);
      const next = await port.remember({
        actor: alice,
        scope: personal,
        kind: "preference",
        body: "Reply in en",
        preferenceKey: "reply.language",
        preference: { valueType: "string", value: "en" },
      });
      expect(next.status).toBe("approved");
      expect((await port.get({ actor: alice, recordId: old.recordId })).status).toBe("expired");
      expect((await port.resolvePreferences({ actor: alice })).preferences.map((entry) => entry.value)).toEqual(["en"]);
    },
  },
  {
    group: "end dates",
    title: "keep longer revives an expired preference with a new date, and conflicts when another value was kept meanwhile",
    run: async ({ port, at }) => {
      const spanish = await port.remember({
        actor: alice,
        scope: personal,
        kind: "preference",
        body: "Reply in es",
        preferenceKey: "reply.language",
        preference: { valueType: "string", value: "es" },
        expiryAt: END_OF_FRIDAY,
      });
      const lesson = await port.remember({
        actor: alice,
        scope: personal,
        kind: "lesson",
        body: "Send drafts before noon this week",
        expiryAt: END_OF_FRIDAY,
      });
      at(SATURDAY);
      const swept = await port.sweepExpired({ actor: alice });
      expect(swept.map((entry) => [entry.recordId, entry.outcome])).toEqual(
        expect.arrayContaining([
          [spanish.recordId, "expired"],
          [lesson.recordId, "expired"],
        ]),
      );
      await refused(() => port.correct({ actor: alice, recordId: spanish.recordId, body: "Reply in Spanish" }), "CONFLICT");
      const kept = await port.correct({ actor: alice, recordId: spanish.recordId, expiryAt: "2026-02-01T00:00:00.000Z" });
      expect(kept).toMatchObject({ status: "approved", expiryAt: "2026-02-01T00:00:00.000Z" });
      expect((await port.resolvePreferences({ actor: alice })).preferences.map((entry) => entry.value)).toEqual(["es"]);
      expect(await port.list({ actor: alice, past: true, kinds: ["preference"] })).toEqual([]);
      // Expired again, then another value is kept: keeping the old one longer conflicts.
      at("2026-02-02T00:00:00.000Z");
      await port.sweepExpired({ actor: alice });
      const english = await port.remember({
        actor: alice,
        scope: personal,
        kind: "preference",
        body: "Reply in en",
        preferenceKey: "reply.language",
        preference: { valueType: "string", value: "en" },
      });
      await refused(
        () => port.correct({ actor: alice, recordId: spanish.recordId, expiryAt: "2026-03-01T00:00:00.000Z" }),
        "MEMORY_CONFLICT",
      );
      expect((await port.get({ actor: alice, recordId: spanish.recordId })).status).toBe("expired");
      expect((await port.get({ actor: alice, recordId: english.recordId })).status).toBe("approved");
    },
  },

  // ── the operator's views ────────────────────────────────────────────
  {
    group: "operator view",
    title: "reads every scope of the operator's page, an agent's among them, and nothing of another person's",
    run: async ({ port }) => {
      const operator: MemoryActor = { principalId: "operator", workspaceId: "w1", caller: "test", authority: "operator" };
      const view = { actor: operator, view: "operator" } as const;
      const chat = (runId: string): MemoryScope => ({ kind: "run_local", principalId: "operator", workspaceId: "w1", runId });
      const mine = await port.remember({
        actor: operator,
        scope: { kind: "personal", principalId: "operator" },
        kind: "fact",
        body: "Lives in Lisbon",
      });
      const chief = await port.remember({
        actor: { ...operator, agentId: "chief" },
        scope: { kind: "personal_agent", principalId: "operator", agentId: "chief", workspaceId: "w1" },
        kind: "lesson",
        body: "Lead with the answer",
      });
      const note = await port.remember({
        actor: { ...operator, runId: "t1" },
        scope: chat("t1"),
        kind: "fact",
        body: "The budget is 40k",
        durable: true,
        originTaskId: "t1",
      });
      const scratch = await port.remember({ actor: { ...operator, runId: "t1" }, scope: chat("t1"), kind: "fact", body: "Working memory" });
      const theirs = await port.remember({ actor: { ...operator, principalId: "alice" }, scope: personal, kind: "fact", body: "Alice's" });
      await refused(() => port.get({ actor: operator, recordId: chief.recordId }), "NOT_FOUND");
      expect((await port.get({ ...view, recordId: chief.recordId })).recordId).toBe(chief.recordId);
      expect((await port.get({ ...view, recordId: note.recordId })).recordId).toBe(note.recordId);
      for (const hidden of [scratch, theirs]) {
        await refused(() => port.get({ ...view, recordId: hidden.recordId }), "NOT_FOUND");
        await refused(() => port.history({ ...view, recordId: hidden.recordId }), "NOT_FOUND");
      }
      const page = await port.operatorView({ actor: operator });
      expect(page.scopes.map((scope) => scope.target).sort()).toEqual(["agent:chief", "personal"]);
      expect(ids(await port.list({ ...view })).sort()).toEqual([chief.recordId, mine.recordId].sort());
      const personalKey = page.scopes.find((scope) => scope.target === "personal")?.scopeKey ?? "";
      expect(ids(await port.list({ ...view, scopeKeys: [personalKey] }))).toEqual([mine.recordId]);
      expect(await port.list({ ...view, scopeKeys: [memoryScopeKey(personal)] })).toEqual([]);
      expect(ids(await port.list({ ...view, scopeKeys: [], chats: ["t1"] }))).toEqual([note.recordId]);
      expect(ids(await port.list({ ...view, chatNotes: true }))).toEqual([note.recordId]);
      expect((await port.usage({ ...view })).records).toBe(2);
    },
  },
  {
    group: "operator view",
    title: "counts the rail's proposals and each chat's notes, names the workspace's people, and relates a waiting update",
    run: async ({ port }) => {
      const operator: MemoryActor = { principalId: "operator", workspaceId: "w1", caller: "test", authority: "operator" };
      const asModel: MemoryActor = { ...operator, authority: "model" };
      const own: MemoryScope = { kind: "personal", principalId: "operator" };
      const kept = await port.remember({
        actor: operator,
        scope: own,
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "brief" },
        body: "Prefers brief answers",
      });
      const update = await port.propose({
        actor: asModel,
        scope: own,
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "warm" },
        body: "Prefers warm answers",
      });
      await port.propose({
        actor: asModel,
        scope: { kind: "personal_workspace", principalId: "operator", workspaceId: "w1" },
        kind: "fact",
        body: "Two",
      });
      await port.remember({
        actor: { ...operator, runId: "t1" },
        scope: { kind: "run_local", principalId: "operator", workspaceId: "w1", runId: "t1" },
        kind: "fact",
        body: "Note",
        durable: true,
      });
      await port.propose({ actor: { ...asModel, principalId: "alice" }, scope: aliceWorkspace, kind: "fact", body: "Alice's" });
      expect(await port.counts({ actor: operator, taskIds: ["t1", "t2"] })).toEqual({ proposed: 2, chatNotes: { t1: 1 } });
      expect(await port.principals({ actor: operator, statuses: ["proposed"] })).toEqual(["alice", "operator"]);
      expect((await port.operatorView({ actor: operator })).otherProposals).toEqual([{ principalId: "alice", count: 1 }]);
      expect(await port.related({ actor: operator, view: "operator", recordId: update.recordId })).toMatchObject({
        updates: { recordId: kept.recordId },
      });
      expect(await port.related({ actor: operator, view: "operator", recordId: kept.recordId })).toEqual({});
      const history = await port.history({ actor: operator, view: "operator", recordId: kept.recordId });
      expect(history.revisions.map((revision) => revision.revisionId)).toEqual([kept.currentRevisionId]);
    },
  },
  {
    group: "operator view",
    title: "is the operator's alone: a model or a restricted actor reads no operator view, counts or people",
    run: async ({ port }) => {
      const operator: MemoryActor = { principalId: "operator", workspaceId: "w1", caller: "test", authority: "operator" };
      const record = await port.remember({
        actor: operator,
        scope: { kind: "personal", principalId: "operator" },
        kind: "fact",
        body: "Kept",
      });
      for (const actor of [
        { ...operator, authority: "model" },
        { ...operator, reach: "chat-only" },
        { ...operator, scopeRestricted: true },
        { ...operator, allowedRecordIds: [record.recordId] },
      ] satisfies MemoryActor[]) {
        for (const call of [
          () => port.get({ actor, recordId: record.recordId, view: "operator" }),
          () => port.history({ actor, recordId: record.recordId, view: "operator" }),
          () => port.related({ actor, recordId: record.recordId, view: "operator" }),
          () => port.list({ actor, view: "operator" }),
          () => port.search({ actor, query: "Kept", view: "operator" }),
          () => port.usage({ actor, view: "operator" }),
          () => port.operatorView({ actor }),
          () => port.counts({ actor }),
          () => port.principals({ actor, statuses: ["proposed"] }),
        ]) {
          await refused(call, "NOT_AUTHORIZED");
        }
      }
      await refused(() => port.list({ actor: operator, chats: ["t1"] }), "INVALID_INPUT");
      await refused(() => port.list({ actor: operator, chatNotes: true }), "INVALID_INPUT");
      await refused(() => port.search({ actor: operator, query: "Kept", scopeKeys: ["personal|p=operator"] }), "INVALID_INPUT");
      await refused(
        () => port.list({ actor: operator, view: "operator", scope: { kind: "personal", principalId: "operator" } }),
        "INVALID_INPUT",
      );
    },
  },
  // ── supersession ────────────────────────────────────────────────────
  {
    group: "supersession",
    title:
      "memory invariant 8: a tidy-up is only a proposal; approving it supersedes each input at its revision, whose revisions stay readable",
    run: async ({ port }) => {
      const first = await port.remember({
        actor: alice,
        scope: aliceWorkspace,
        kind: "fact",
        title: "Garden",
        body: "Alice keeps a vegetable garden",
      });
      const second = await port.remember({
        actor: alice,
        scope: aliceWorkspace,
        kind: "fact",
        title: "Tomatoes",
        body: "Alice grows tomatoes in her garden",
      });
      const supersedes = [first, second].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId as string }));
      const merged = await port.propose({
        actor: { ...model, caller: "provider:tavi.memoryprovider:consolidate" },
        scope: aliceWorkspace,
        kind: "fact",
        title: "Garden",
        body: "Alice keeps a vegetable garden where she grows tomatoes",
        supersedes,
      });
      // Filing it changes nothing: the inputs stay approved and recalled, and it waits for a person.
      expect(merged.status).toBe("proposed");
      for (const input of [first, second]) expect((await port.get({ actor: alice, recordId: input.recordId })).status).toBe("approved");
      const related = await port.related({ actor: alice, recordId: merged.recordId });
      expect(related.supersedes?.map((entry) => [entry.recordId, entry.revisionId, entry.stale])).toEqual(
        supersedes.map((entry) => [entry.recordId, entry.revisionId, false]),
      );
      expect(related.supersedes?.map((entry) => entry.title)).toEqual(["Garden", "Tomatoes"]);
      // Its own inputs are never what it updates or is similar to.
      expect(related.updates).toBeUndefined();
      expect(related.similarTo).toBeUndefined();
      expect((await port.history({ actor: alice, recordId: merged.recordId })).revisions[0]?.author).toBe(
        "provider:tavi.memoryprovider:consolidate",
      );
      const kept = await port.approve({ actor: alice, recordId: merged.recordId });
      expect(kept.status).toBe("approved");
      for (const input of [first, second]) {
        const after = await port.get({ actor: alice, recordId: input.recordId });
        expect(after.status).toBe("superseded");
        // Nothing deleted or rewritten: the revision approved before is read as it was.
        const revisions = (await port.history({ actor: alice, recordId: input.recordId })).revisions;
        expect(revisions.find((revision) => revision.revisionId === input.currentRevisionId)?.body).toBeDefined();
        expect(revisions).toHaveLength(1);
      }
      expect(ids((await port.search({ actor: alice, query: "garden" })).hits)).toEqual([kept.recordId]);
      // Approved, it waits no more: `related` names nothing.
      expect(await port.related({ actor: alice, recordId: merged.recordId })).toEqual({});
    },
  },
  {
    group: "supersession",
    title: "refuses to approve a tidy-up whose input changed since (REVISION_CONFLICT), and changes nothing",
    run: async ({ port }) => {
      const first = await port.remember({ actor: alice, scope: aliceWorkspace, kind: "fact", body: "Alice runs on Mondays" });
      const second = await port.remember({ actor: alice, scope: aliceWorkspace, kind: "fact", body: "Alice runs on Thursdays" });
      const merged = await port.propose({
        actor: model,
        scope: aliceWorkspace,
        kind: "fact",
        body: "Alice runs on Mondays and Thursdays",
        supersedes: [first, second].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId as string })),
      });
      await port.correct({ actor: alice, recordId: first.recordId, body: "Alice runs on Mondays and Fridays" });
      expect((await port.related({ actor: alice, recordId: merged.recordId })).supersedes?.map((entry) => entry.stale)).toEqual([
        true,
        false,
      ]);
      await refused(() => port.approve({ actor: alice, recordId: merged.recordId }), "REVISION_CONFLICT");
      expect((await port.get({ actor: alice, recordId: merged.recordId })).status).toBe("proposed");
      expect((await port.get({ actor: alice, recordId: first.recordId })).status).toBe("approved");
      expect((await port.get({ actor: alice, recordId: second.recordId })).status).toBe("approved");
    },
  },
  {
    group: "supersession",
    title: "memory invariant 9: erases a waiting tidy-up when a record it merges is forgotten, and keeps the other inputs",
    run: async ({ port }) => {
      // The tidy-up holds a merge of the forgotten words, so it is forgotten with them: its body is gone.
      const third = await port.remember({ actor: alice, scope: aliceWorkspace, kind: "fact", body: "Alice swims on Sundays" });
      const fourth = await port.remember({ actor: alice, scope: aliceWorkspace, kind: "fact", body: "Alice swims in the sea" });
      const ending = await port.propose({
        actor: model,
        scope: aliceWorkspace,
        kind: "fact",
        body: "Alice swims in the sea on Sundays",
        validTo: daysAfter(THURSDAY, 30),
        supersedes: [third, fourth].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId as string })),
      });
      await port.forget({ actor: alice, recordId: third.recordId, reason: "test" });
      await refused(() => port.get({ actor: alice, recordId: ending.recordId }), "NOT_FOUND");
      await refused(() => port.approve({ actor: alice, recordId: ending.recordId }), "NOT_FOUND");
      expect(ids(await port.list({ actor: alice, statuses: ["proposed", "rejected"] }))).not.toContain(ending.recordId);
      expect((await port.get({ actor: alice, recordId: fourth.recordId })).status).toBe("approved");
      expect(ids((await port.search({ actor: alice, query: "sea" })).hits)).toEqual([fourth.recordId]);
    },
  },
  {
    group: "supersession",
    title: "files a tidy-up only over approved records the actor reads, at their current revision, in its scope and kind, at most 20",
    run: async ({ port }) => {
      const kept = await port.remember({ actor: alice, scope: aliceWorkspace, kind: "fact", body: "Alice keeps bees" });
      const at = { recordId: kept.recordId, revisionId: kept.currentRevisionId as string };
      await refused(
        () =>
          port.propose({
            actor: model,
            scope: aliceWorkspace,
            kind: "fact",
            body: "Bees",
            supersedes: [{ ...at, revisionId: "memrev-other" }],
          }),
        "REVISION_CONFLICT",
      );
      await refused(() => port.propose({ actor: model, scope: personal, kind: "fact", body: "Bees", supersedes: [at] }), "INVALID_INPUT");
      await refused(
        () => port.propose({ actor: model, scope: aliceWorkspace, kind: "lesson", body: "Bees", supersedes: [at] }),
        "INVALID_INPUT",
      );
      await refused(
        () => port.propose({ actor: model, scope: aliceWorkspace, kind: "fact", body: "Bees", supersedes: [at, at] }),
        "INVALID_INPUT",
      );
      const many = Array.from({ length: 21 }, (_, index) => ({ recordId: `mem-${index}`, revisionId: `memrev-${index}` }));
      await refused(
        () => port.propose({ actor: model, scope: aliceWorkspace, kind: "fact", body: "Bees", supersedes: many }),
        "INVALID_INPUT",
      );
      // Another person's record is not found, whatever it supersedes.
      const bobs = await port.remember({
        actor: bob,
        scope: { kind: "personal_workspace", principalId: "bob", workspaceId: "w1" },
        kind: "fact",
        body: "Bob keeps bees",
      });
      await refused(
        () =>
          port.propose({
            actor: model,
            scope: aliceWorkspace,
            kind: "fact",
            body: "Bees",
            supersedes: [{ recordId: bobs.recordId, revisionId: bobs.currentRevisionId as string }],
          }),
        "NOT_FOUND",
      );
      // A proposal still waiting is not a record to supersede.
      const waiting = await port.propose({ actor: model, scope: aliceWorkspace, kind: "fact", body: "Alice sells honey" });
      await refused(
        () =>
          port.propose({
            actor: model,
            scope: aliceWorkspace,
            kind: "fact",
            body: "Honey",
            supersedes: [{ recordId: waiting.recordId, revisionId: "memrev-any" }],
          }),
        "REVISION_CONFLICT",
      );
    },
  },
  {
    group: "supersession",
    title: "dedup never answers a tidy-up with its own input, and answers the same tidy-up filed twice with the first",
    run: async ({ port }) => {
      const kept = await port.remember({ actor: alice, scope: aliceWorkspace, kind: "fact", body: "Alice is travelling to Lisbon" });
      const input = {
        actor: model,
        scope: aliceWorkspace,
        kind: "fact" as const,
        body: "Alice is travelling to Lisbon",
        validTo: END_OF_FRIDAY,
        supersedes: [{ recordId: kept.recordId, revisionId: kept.currentRevisionId as string }],
      };
      const ending = await port.propose(input);
      expect(ending.recordId).not.toBe(kept.recordId);
      expect(ending.known).toBeUndefined();
      const again = await port.propose(input);
      expect(again.recordId).toBe(ending.recordId);
      expect(again.known).toBe("exact");
      // Approved, the end date replaces the open-ended record: it holds through Friday, then ends.
      const approvedEnding = await port.approve({ actor: alice, recordId: ending.recordId });
      expect(approvedEnding.validTo).toBe(END_OF_FRIDAY);
      expect((await port.get({ actor: alice, recordId: kept.recordId })).status).toBe("superseded");
    },
  },
];

const fullTitle = (entry: Case): string => `${entry.group} › ${entry.title}`;

/** Every case's title, `group › title`, as the suite names them. */
export function memoryServiceConformanceCases(): readonly string[] {
  return CASES.map(fullTitle);
}

async function runCase(entry: Case, factory: MemoryPortFactory): Promise<void> {
  let now = THURSDAY;
  const harness = await factory({
    now: () => now,
    ...(entry.quotas === undefined ? {} : { quotas: entry.quotas }),
    sharedReaders: entry.aliceReadsShared === true ? [{ principalId: "alice", workspaceId: "w1" }] : [],
  });
  try {
    await entry.run({
      port: harness.port,
      harness,
      at: (next) => {
        now = next;
      },
    });
  } finally {
    await harness.close?.();
  }
}

/**
 * One case by its full title (`memoryServiceConformanceCases`): how a kit's
 * own tests show a deliberately broken port fails the case that names its
 * fault. Rejects with the case's failure.
 */
export async function runMemoryServiceConformanceCase(title: string, factory: MemoryPortFactory): Promise<void> {
  const entry = CASES.find((candidate) => fullTitle(candidate) === title);
  if (entry === undefined) throw new Error(`No memory port conformance case is titled ${JSON.stringify(title)}`);
  await runCase(entry, factory);
}

/** The port suite: every case against a fresh service from `factory`. */
export function describeMemoryServiceConformance(name: string, factory: MemoryPortFactory): void {
  describe(`memory port conformance: ${name}`, () => {
    for (const group of [...new Set(CASES.map((entry) => entry.group))]) {
      describe(group, () => {
        for (const entry of CASES.filter((candidate) => candidate.group === group)) {
          it(entry.title, async () => await runCase(entry, factory));
        }
      });
    }
  });
}
