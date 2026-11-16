import { MemoryService } from "../src/memory/service.js";
import { DEFAULT_MEMORY_RETENTION_DAYS, TaviError, type MemoryActor, type MemoryScope } from "@tavi/contracts";

import { SqliteStore } from "../src/persistence/store.js";
import { describe, expect, it } from "vitest";

/**
 * End dates by kind: a fact's
 * `validTo` *ends* it — out of recall, kept approved under *Past*, never the
 * sweep's — while a preference's or lesson's `expiryAt` *expires* it: the
 * sweep marks it `expired` and erases it `proposalDays` after that mark.
 * `correct` keeps the dates it is not given, and *Keep longer* revives.
 */

/** Thursday 1 Jan 2026; "until Friday" holds through Friday 2 Jan, so it ends as Saturday 3 Jan begins. */
const THURSDAY = "2026-01-01T00:00:00.000Z";
const END_OF_FRIDAY = "2026-01-03T00:00:00.000Z";
const SATURDAY = "2026-01-03T09:00:00.000Z";
const DAY = 86_400_000;
const at = (base: string, days: number): string => new Date(Date.parse(base) + days * DAY).toISOString();

const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };
const days = DEFAULT_MEMORY_RETENTION_DAYS.proposedOrRejected;

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const persistence = store.asPort();
  let counter = 0;
  const newId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
  /** The same database, read and written at `now`. */
  const when = (now: string): MemoryService => new MemoryService(persistence, { now: () => now, newId });
  return { store, persistence, when };
}

describe("a fact ends, and is kept", () => {
  it("'Travelling to Lisbon until Friday' carries validTo, leaves recall after Friday, and stays approved under Past through any number of sweeps", () => {
    const { store, when } = fixture();
    const thursday = when(THURSDAY);
    const trip = thursday.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Lisbon",
      body: "Travelling to Lisbon until Friday",
      validTo: END_OF_FRIDAY,
    });
    expect(trip).toMatchObject({ status: "approved", validTo: END_OF_FRIDAY });
    expect(thursday.search({ actor: alice, query: "Lisbon" }).hits.map((hit) => hit.recordId)).toEqual([trip.recordId]);
    expect(thursday.list({ actor: alice, past: true })).toEqual([]);

    const saturday = when(SATURDAY);
    expect(saturday.search({ actor: alice, query: "Lisbon" }).hits).toEqual([]);
    for (const later of [SATURDAY, at(SATURDAY, 40), at(SATURDAY, 400)]) {
      expect(when(later).sweepExpired({ actor: alice })).toEqual([]);
      expect(when(later).get({ actor: alice, recordId: trip.recordId })).toMatchObject({ status: "approved", validTo: END_OF_FRIDAY });
      expect(
        when(later)
          .list({ actor: alice, past: true })
          .map((record) => record.recordId),
      ).toEqual([trip.recordId]);
    }
    store.close();
  });

  it("a fact proposal 'until Friday' left undecided past Friday is expired by the next sweep, never approved into Past", () => {
    const { store, when } = fixture();
    const proposal = when(THURSDAY).propose({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Travelling to Lisbon until Friday",
      validTo: END_OF_FRIDAY,
    });
    const saturday = when(SATURDAY);
    expect(saturday.sweepExpired({ actor: alice }).map((entry) => [entry.recordId, entry.outcome])).toEqual([
      [proposal.recordId, "expired"],
    ]);
    expect(() => saturday.approve({ actor: alice, recordId: proposal.recordId })).toThrowError(/expired and cannot be approved/);
    // Nothing nobody approved is history.
    expect(saturday.list({ actor: alice, past: true })).toEqual([]);
    store.close();
  });

  it("correcting a fact's body keeps its validTo; validTo: null clears it", () => {
    const { store, when } = fixture();
    const thursday = when(THURSDAY);
    const trip = thursday.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Travelling to Lisbon until Friday",
      validTo: END_OF_FRIDAY,
    });
    const edited = thursday.correct({ actor: alice, recordId: trip.recordId, body: "Travelling to Lisbon and Porto until Friday" });
    expect(edited.validTo).toBe(END_OF_FRIDAY);
    const open = thursday.correct({ actor: alice, recordId: trip.recordId, validTo: null });
    expect(open.validTo).toBeUndefined();
    expect(
      when(at(SATURDAY, 10))
        .search({ actor: alice, query: "Porto" })
        .hits.map((hit) => hit.recordId),
    ).toEqual([trip.recordId]);
    store.close();
  });

  it("refuses a date in the past on correct", () => {
    const { store, when } = fixture();
    const thursday = when(THURSDAY);
    const trip = thursday.remember({ actor: alice, scope: personal, kind: "fact", body: "Travelling to Lisbon", validTo: END_OF_FRIDAY });
    expect(() => thursday.correct({ actor: alice, recordId: trip.recordId, validTo: "2025-12-01T00:00:00.000Z" })).toThrowError(
      /must be in the future/,
    );
    store.close();
  });
});

describe("a preference or lesson expires, then is erased", () => {
  /** `expiryAt: null` for a value with no end. */
  const spanish = (service: MemoryService, value = "es", expiryAt: string | null = END_OF_FRIDAY) =>
    service.remember({
      actor: alice,
      scope: personal,
      kind: "preference",
      body: `Reply in ${value}`,
      preferenceKey: "reply.language",
      preference: { valueType: "string", value },
      ...(expiryAt === null ? {} : { expiryAt }),
    });

  it("'Reply in Spanish until Friday' carries expiryAt, stops applying after Friday, is marked expired by the next sweep and erased proposalDays after the mark; while it applies a second value is a conflict", () => {
    const { store, when } = fixture();
    const thursday = when(THURSDAY);
    const preference = spanish(thursday);
    expect(preference).toMatchObject({ status: "approved", expiryAt: END_OF_FRIDAY });
    expect(preference.validTo).toBeUndefined();
    expect(thursday.resolvePreferences({ actor: alice }).preferences.map((entry) => entry.value)).toEqual(["es"]);
    // While it applies, a second value for the key is refused.
    expect(() => spanish(thursday, "fr", null)).toThrowError(TaviError);
    try {
      spanish(thursday, "de", null);
    } catch (error) {
      expect(TaviError.from(error).code).toBe("MEMORY_CONFLICT");
    }

    const saturday = when(SATURDAY);
    expect(saturday.resolvePreferences({ actor: alice }).preferences).toEqual([]);
    expect(saturday.sweepExpired({ actor: alice }).map((entry) => [entry.recordId, entry.outcome])).toEqual([
      [preference.recordId, "expired"],
    ]);
    expect(saturday.get({ actor: alice, recordId: preference.recordId })).toMatchObject({ status: "expired", updatedAt: SATURDAY });
    expect(saturday.list({ actor: alice, past: true }).map((record) => record.recordId)).toEqual([preference.recordId]);

    // Kept for the window after the mark, then erased.
    // (The two refused values above are proposals still, which lapse in their own time.)
    const mine = (swept: readonly { readonly recordId: string; readonly outcome: string }[]) =>
      swept.filter((entry) => entry.recordId === preference.recordId).map((entry) => entry.outcome);
    expect(mine(when(at(SATURDAY, days - 1)).sweepExpired({ actor: alice }))).toEqual([]);
    expect(
      when(at(SATURDAY, days - 1))
        .list({ actor: alice, past: true })
        .map((record) => record.recordId),
    ).toEqual([preference.recordId]);
    expect(mine(when(at(SATURDAY, days)).sweepExpired({ actor: alice }))).toEqual(["forgotten"]);
    expect(() => when(at(SATURDAY, days)).get({ actor: alice, recordId: preference.recordId })).toThrowError(/does not exist/);
    store.close();
  });

  it("then on Saturday, before any sweep, a new reply.language value is approved and the old one is expired", () => {
    const { store, when } = fixture();
    const old = spanish(when(THURSDAY));
    const saturday = when(SATURDAY);
    const next = spanish(saturday, "en", null);
    expect(next.status).toBe("approved");
    expect(saturday.get({ actor: alice, recordId: old.recordId }).status).toBe("expired");
    expect(saturday.resolvePreferences({ actor: alice }).preferences.map((entry) => entry.value)).toEqual(["en"]);
    store.close();
  });

  it("Keep longer racing the sweep: the record ends approved with the new date", () => {
    const { store, persistence, when } = fixture();
    const preference = spanish(when(THURSDAY));
    const saturday = when(SATURDAY);
    const repository = persistence.repositories.memory;
    const original = repository.listRecords.bind(repository);
    const later = "2026-01-10T00:00:00.000Z";
    let raced = false;
    // *Keep longer* lands between the sweep's read and its mark: the mark's compare-and-set loses.
    repository.listRecords = (input) => {
      const rows = original(input);
      if (!raced && input.lapsedExpiry !== undefined) {
        raced = true;
        saturday.correct({ actor: alice, recordId: preference.recordId, expiryAt: later });
      }
      return rows;
    };
    const sweeping = new MemoryService(persistence, { now: () => SATURDAY });
    expect(sweeping.sweepExpired({ actor: alice })).toEqual([]);
    expect(raced).toBe(true);
    repository.listRecords = original;
    expect(saturday.get({ actor: alice, recordId: preference.recordId })).toMatchObject({ status: "approved", expiryAt: later });
    expect(saturday.resolvePreferences({ actor: alice }).preferences.map((entry) => entry.value)).toEqual(["es"]);
    store.close();
  });

  it("Keep longer racing the erasure: a record revived after the sweep's read is not erased", () => {
    const { store, persistence, when } = fixture();
    const preference = spanish(when(THURSDAY));
    when(SATURDAY).sweepExpired({ actor: alice });
    const erasing = at(SATURDAY, days);
    const repository = persistence.repositories.memory;
    const original = repository.listRecords.bind(repository);
    const later = at(erasing, 30);
    let raced = false;
    // *Keep longer* lands between the sweep's read of lapsed records and its erasure.
    repository.listRecords = (input) => {
      const rows = original(input);
      if (!raced && input.statuses?.includes("expired") === true) {
        raced = true;
        when(erasing).correct({ actor: alice, recordId: preference.recordId, expiryAt: later });
      }
      return rows;
    };
    const sweeping = new MemoryService(persistence, { now: () => erasing });
    expect(sweeping.sweepExpired({ actor: alice }).filter((entry) => entry.recordId === preference.recordId)).toEqual([]);
    expect(raced).toBe(true);
    repository.listRecords = original;
    expect(when(erasing).get({ actor: alice, recordId: preference.recordId })).toMatchObject({ status: "approved", expiryAt: later });
    store.close();
  });

  it("the sweep's mark reads only lapsed expiries, so ended facts never use up its cap", () => {
    const { store, persistence, when } = fixture();
    const thursday = when(THURSDAY);
    thursday.remember({ actor: alice, scope: personal, kind: "fact", body: "Travelling to Lisbon until Friday", validTo: END_OF_FRIDAY });
    const preference = spanish(thursday);
    const repository = persistence.repositories.memory;
    const original = repository.listRecords.bind(repository);
    const marked: string[] = [];
    repository.listRecords = (input) => {
      const rows = original(input);
      if (input.lapsedExpiry !== undefined) marked.push(...rows.map((record) => record.recordId));
      return rows;
    };
    new MemoryService(persistence, { now: () => SATURDAY }).sweepExpired({ actor: alice });
    repository.listRecords = original;
    expect(marked).toEqual([preference.recordId]);
    store.close();
  });

  it("refuses validTo on a preference: it expires instead", () => {
    const { store, when } = fixture();
    const thursday = when(THURSDAY);
    expect(() =>
      thursday.propose({
        actor: alice,
        scope: personal,
        kind: "preference",
        body: "Reply in French",
        preferenceKey: "reply.language",
        preference: { valueType: "string", value: "fr" },
        validTo: END_OF_FRIDAY,
      }),
    ).toThrowError(/use expiryAt/);
    const kept = spanish(thursday, "de", null);
    expect(() => thursday.correct({ actor: alice, recordId: kept.recordId, validTo: END_OF_FRIDAY })).toThrowError(/use expiryAt/);
    expect(thursday.correct({ actor: alice, recordId: kept.recordId, expiryAt: END_OF_FRIDAY })).toMatchObject({ expiryAt: END_OF_FRIDAY });
    store.close();
  });

  it("Keep longer on an expired preference returns it to approved, in recall again", () => {
    const { store, when } = fixture();
    const preference = spanish(when(THURSDAY));
    const saturday = when(SATURDAY);
    saturday.sweepExpired({ actor: alice });
    expect(saturday.get({ actor: alice, recordId: preference.recordId }).status).toBe("expired");
    // An expired record is corrected only with a date that keeps it.
    expect(() => saturday.correct({ actor: alice, recordId: preference.recordId, body: "Reply in Spanish" })).toThrowError(
      /give it a new date/,
    );
    const kept = saturday.correct({ actor: alice, recordId: preference.recordId, expiryAt: "2026-02-01T00:00:00.000Z" });
    expect(kept).toMatchObject({ status: "approved", expiryAt: "2026-02-01T00:00:00.000Z" });
    expect(saturday.resolvePreferences({ actor: alice }).preferences.map((entry) => entry.value)).toEqual(["es"]);
    expect(saturday.search({ actor: alice, query: "Reply" }).hits.map((hit) => hit.recordId)).toEqual([preference.recordId]);
    expect(saturday.list({ actor: alice, past: true })).toEqual([]);
    store.close();
  });

  it("Keep longer on an expired preference answers MEMORY_CONFLICT when another value for its key was kept meanwhile", () => {
    const { store, when } = fixture();
    const preference = spanish(when(THURSDAY));
    const saturday = when(SATURDAY);
    saturday.sweepExpired({ actor: alice });
    const english = spanish(saturday, "en", null);
    let code: string | undefined;
    try {
      saturday.correct({ actor: alice, recordId: preference.recordId, expiryAt: "2026-02-01T00:00:00.000Z" });
    } catch (error) {
      code = TaviError.from(error).code;
    }
    expect(code).toBe("MEMORY_CONFLICT");
    expect(saturday.get({ actor: alice, recordId: preference.recordId }).status).toBe("expired");
    expect(saturday.get({ actor: alice, recordId: english.recordId }).status).toBe("approved");
    store.close();
  });

  it("a lesson expires like a preference", () => {
    const { store, when } = fixture();
    const lesson = when(THURSDAY).remember({
      actor: alice,
      scope: personal,
      kind: "lesson",
      body: "Send drafts before noon this week",
      expiryAt: END_OF_FRIDAY,
    });
    expect(
      when(SATURDAY)
        .sweepExpired({ actor: alice })
        .map((entry) => [entry.recordId, entry.outcome]),
    ).toEqual([[lesson.recordId, "expired"]]);
    store.close();
  });
});
