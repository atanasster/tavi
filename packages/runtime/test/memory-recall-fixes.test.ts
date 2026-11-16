import { MEMORY_READ_SHARED_PERMISSION } from "../src/memory/access.js";
import { MemoryService } from "../src/memory/service.js";
import { SqliteStore } from "../src/persistence/store.js";
import { memoryScopeKey, type AccessPolicyPort, type MemoryActor, type MemoryKind, type MemoryScope } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

/**
 * Turn recall's floor, MMR, ranking priors and profile, as the audit of
 * MEMORY-IMPROVEMENT-PLAN steps 2.1, 2.2, 2.4 and 2.5 found them: write-time
 * keywords do not exempt a record from the rarity check, contradicting facts
 * survive MMR, the profile takes facts only from the reader's own scopes and
 * reads bounded, a corrected record can be confirmed, and replaced revisions
 * never outrank current ones.
 */

const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", agentId: "agent-main", caller: "cli", authority: "operator" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };

function fixture(options: { readonly sharedReader?: boolean } = {}) {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const persistence = store.asPort();
  let counter = 0;
  const clock = { now: "2026-01-01T00:00:00.000Z" };
  const policy: AccessPolicyPort | undefined =
    options.sharedReader === true
      ? {
          resolveWorkspace: () => undefined,
          missingPermissions: (_context, required) => required.filter((p) => p !== MEMORY_READ_SHARED_PERMISSION),
        }
      : undefined;
  const service = new MemoryService(persistence, {
    now: () => clock.now,
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
    ...(policy === undefined ? {} : { policy }),
  });
  /** An approved record written straight to the store: for scopes the service will not write as alice, and bulk fixtures. */
  const insert = (input: {
    readonly recordId: string;
    readonly scope: MemoryScope;
    readonly kind: MemoryKind;
    readonly body: string;
    readonly topicKey?: string;
  }): void => {
    persistence.repositories.memory.insertRecord({
      record: {
        recordId: input.recordId,
        kind: input.kind,
        scope: input.scope,
        scopeKey: memoryScopeKey(input.scope),
        status: "approved",
        sensitivity: "normal",
        currentRevisionId: `${input.recordId}-rev`,
        revocationGeneration: 0,
        recordedAt: clock.now,
        updatedAt: clock.now,
        ...(input.topicKey === undefined ? {} : { topicKey: input.topicKey }),
      },
      revision: {
        revisionId: `${input.recordId}-rev`,
        recordId: input.recordId,
        revisionNumber: 1,
        schemaVersion: 1,
        body: input.body,
        contentHash: `h-${input.recordId}`,
        author: "operator",
        sourceIds: [],
        recordedAt: clock.now,
        sensitivity: "normal",
        status: "active",
      },
    });
  };
  /** Chats that used `recordId`, at `at`. */
  const use = (recordId: string, taskIds: readonly string[], at: string): void => {
    for (const id of taskIds) {
      if (persistence.repositories.tasks.get(id) === undefined)
        persistence.repositories.tasks.admit({
          workspaceId: "w1",
          principalId: "alice",
          operationKey: id,
          kind: "start",
          intent: { prompt: "p" },
          checkpointNamespace: "",
          origin: "ipc",
          now: () => at,
          newTaskId: () => id,
          newThreadId: () => `thread-${id}`,
          newAdmissionId: () => `adm-${id}`,
        });
      persistence.repositories.memoryUse.record({ taskId: id, admissionId: `adm-${id}`, recordIds: [recordId], at });
    }
  };
  const fact = (
    body: string,
    extra: { readonly topicKey?: string; readonly keywords?: readonly string[]; readonly validTo?: string } = {},
  ) => service.remember({ actor: alice, scope: personal, kind: "fact", body, ...extra });
  return { store, service, persistence, clock, insert, use, fact };
}

describe("relevance floor and MMR", () => {
  it("counts a write-time keyword as a matched term without exempting the record from the rarity check", () => {
    const { store, service, fact } = fixture();
    // `deploy` is common in scope (not rare), so a single-term match needs a key or title to survive.
    for (let index = 0; index < 4; index += 1) fact(`The deploy runbook step ${index} is documented.`);
    const keywordOnly = fact("Rotates the staging credentials on Fridays.", { keywords: ["deploy"] });
    const keyed = fact("Targets the blue cluster.", { topicKey: "deploy.target", keywords: ["deploy"] });

    const unfiltered = service.search({ actor: alice, query: "deploy pipeline", match: "any", limit: 20 });
    expect(unfiltered.hits.map((hit) => hit.recordId)).toContain(keywordOnly.recordId);
    const floored = service.search({ actor: alice, query: "deploy pipeline", match: "any", limit: 20, applyFloor: true });
    const ids = floored.hits.map((hit) => hit.recordId);
    expect(ids).not.toContain(keywordOnly.recordId);
    // The record's own topic key still exempts it.
    expect(ids).toContain(keyed.recordId);
    store.close();
  });

  it("keeps contradicting facts with no shared topicKey but still drops a true near-duplicate", () => {
    const { store, service, fact } = fixture();
    const lisbon = fact("Alice lives in Lisbon now");
    const porto = fact("Alice lives in Porto now");
    const reordered = fact("Alice now lives in Lisbon");
    const hits = service.search({ actor: alice, query: "alice lives", limit: 10, applyFloor: true }).hits.map((hit) => hit.recordId);
    expect(hits).toEqual(expect.arrayContaining([lisbon.recordId, porto.recordId]));
    // The reorder holds no word the Lisbon record lacks: a repeat, dropped.
    expect(hits.filter((id) => id === lisbon.recordId || id === reordered.recordId)).toHaveLength(1);
    store.close();
  });

  it("keeps an ended fact beside the current one it near-duplicates", () => {
    const { store, service, clock, fact } = fixture();
    const ended = fact("Alice works at Acme as an engineer", { validTo: "2026-01-02T00:00:00.000Z" });
    clock.now = "2026-01-03T00:00:00.000Z";
    const current = fact("Alice works at Acme as an engineer again");
    const hits = service
      .search({ actor: alice, query: "acme engineer", limit: 10, applyFloor: true, includePast: true })
      .hits.map((hit) => hit.recordId);
    expect(hits).toEqual(expect.arrayContaining([ended.recordId, current.recordId]));
    store.close();
  });
});

describe("ranking priors", () => {
  it("confirms a corrected record by the chats that used it since its current revision", () => {
    const { store, service, clock, fact, use } = fixture();
    const plain = fact("Lisbon tram");
    const corrected = fact("Lisbon tram ride downtown on weekday mornings");
    // Without the prior, the shorter body ranks first.
    expect(service.search({ actor: alice, query: "lisbon tram", limit: 5 }).hits[0]?.recordId).toBe(plain.recordId);
    clock.now = "2026-01-02T00:00:00.000Z";
    service.correct({ actor: alice, recordId: corrected.recordId, body: "Lisbon tram ride downtown on weekday mornings, line 28" });
    // Uses before the correction do not count; two chats after it do.
    use(corrected.recordId, ["task-old"], "2026-01-01T12:00:00.000Z");
    expect(service.search({ actor: alice, query: "lisbon tram", limit: 5 }).hits[0]?.recordId).toBe(plain.recordId);
    use(corrected.recordId, ["task-1", "task-2"], "2026-01-03T00:00:00.000Z");
    expect(service.search({ actor: alice, query: "lisbon tram", limit: 5 }).hits[0]?.recordId).toBe(corrected.recordId);
    store.close();
  });
});

describe("replaced revisions under includePast", () => {
  it("ranks a replaced revision below current matches", () => {
    const { store, service, fact } = fixture();
    const replaced = fact("Alice works at Globex");
    service.correct({ actor: alice, recordId: replaced.recordId, body: "Alice works at Initech" });
    const both = fact("Globex badge renewal is due");
    const one = fact("Globex office is on Main Street");
    const hits = service.search({ actor: alice, query: "globex badge", match: "any", limit: 10, includePast: true }).hits;
    expect(hits.map((hit) => hit.recordId)).toEqual([both.recordId, one.recordId, replaced.recordId]);
    expect(hits[2]?.superseded).toBe(true);
    store.close();
  });

  it("reaches a replacement older than the 200 newest", () => {
    const { store, service, clock, fact } = fixture();
    const oldest = fact("Alice once kept a boat in Zanzibar");
    clock.now = "2026-01-01T00:00:01.000Z";
    service.correct({ actor: alice, recordId: oldest.recordId, body: "Alice keeps no boat" });
    for (let index = 0; index < 205; index += 1) {
      const other = fact(`Unrelated fact number ${index}`);
      clock.now = new Date(Date.parse("2026-01-02T00:00:00.000Z") + index * 1000).toISOString();
      service.correct({ actor: alice, recordId: other.recordId, body: `Unrelated fact number ${index}, corrected` });
    }
    const hits = service.search({ actor: alice, query: "zanzibar", limit: 5, includePast: true }).hits;
    expect(hits.map((hit) => hit.recordId)).toContain(oldest.recordId);
    store.close();
  });
});

describe("profile", () => {
  it("takes me.* facts only from the reader's personal scopes; lessons may come from the shared scope", () => {
    const { store, service, insert } = fixture({ sharedReader: true });
    const shared: MemoryScope = { kind: "shared_workspace", workspaceId: "w1" };
    insert({ recordId: "bob-city", scope: shared, kind: "fact", body: "Lives in Berlin.", topicKey: "me.home_city" });
    insert({ recordId: "team-lesson", scope: shared, kind: "lesson", body: "When deploying, tag the release." });
    insert({ recordId: "own-role", scope: personal, kind: "fact", body: "Staff engineer.", topicKey: "me.role" });
    insert({
      recordId: "agent-lang",
      scope: { kind: "personal_agent", principalId: "alice", agentId: "agent-main" },
      kind: "fact",
      body: "Speaks Portuguese.",
      topicKey: "me.languages",
    });
    const ids = service.resolveProfile({ actor: alice }).map((entry) => entry.recordId);
    expect(ids).toContain("team-lesson");
    expect(ids).toContain("own-role");
    expect(ids).toContain("agent-lang");
    expect(ids).not.toContain("bob-city");
    store.close();
  });

  it("reads the profile and the floor's rarity base bounded over 5,000 records", () => {
    const { store, service, persistence, insert } = fixture();
    persistence.transaction(() => {
      for (let index = 0; index < 5_000; index += 1) {
        const lesson = index % 2 === 0;
        insert({
          recordId: `bulk-${index}`,
          scope: personal,
          kind: lesson ? "lesson" : "fact",
          body: lesson ? `When step ${index} runs, check the gauge ${index % 50}.` : `Fact ${index} about gauge ${index % 50}.`,
          ...(lesson ? {} : { topicKey: `me.detail_${index}` }),
        });
      }
    });
    // Warm once, then take the median of five.
    service.resolvePreferences({ actor: alice, includeProfile: true });
    const time = (run: () => unknown): number => {
      const samples: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const started = performance.now();
        run();
        samples.push(performance.now() - started);
      }
      return samples.sort((a, b) => a - b)[2]!;
    };
    const profileMs = time(() => service.resolveProfile({ actor: alice }));
    const floorMs = time(() => service.search({ actor: alice, query: "gauge step", match: "any", limit: 10, applyFloor: true }));
    console.info(
      `[memory profile/floor] 5,000 records: resolveProfile ${profileMs.toFixed(1)} ms, floored search ${floorMs.toFixed(1)} ms`,
    );
    const profile = service.resolveProfile({ actor: alice });
    expect(profile.filter((entry) => entry.kind === "lesson").length).toBeLessThanOrEqual(24);
    expect(profile.filter((entry) => entry.kind === "fact").length).toBeLessThanOrEqual(24);
    expect(profileMs).toBeLessThan(250);
    expect(floorMs).toBeLessThan(1_000);
    store.close();
  });
});
