import { join } from "node:path";

import { DomainSourceRecordSchema, type DomainSourceRecord } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUDGETS_TABLE_SQL,
  SOURCE_HEALTH_TABLE_SQL,
  SOURCE_PAUSE_FAILURES,
  SOURCE_PAUSE_MS,
  createBudgetLedger,
  createSourceHealth,
  domainCovers,
  domainSourceProblems,
  migrate,
  openDomainStore,
  storeVersion,
  takeBudget,
} from "../src/index.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());
const storePath = () => {
  const directory = temp.create("tavi-domain-kit-");
  return join(directory, "store.db");
};

const V1 = { version: 1, sql: `CREATE TABLE postings (id TEXT PRIMARY KEY) STRICT; ${BUDGETS_TABLE_SQL}` };
const V2 = { version: 2, sql: "ALTER TABLE postings ADD COLUMN title TEXT" };

describe("a domain store's migrations", () => {
  it("brings a new store to the last version, and an older one forward from where it is", () => {
    const path = storePath();
    const first = openDomainStore(path, [V1]);
    expect(storeVersion(first)).toBe(1);
    first.prepare("INSERT INTO postings (id) VALUES ('a')").run();
    first.close();
    const second = openDomainStore(path, [V1, V2]);
    expect(storeVersion(second)).toBe(2);
    expect(second.prepare("SELECT id, title FROM postings").all()).toEqual([{ id: "a", title: null }]);
    second.close();
  });

  it("refuses a store a newer version wrote, and a list that skips a version", () => {
    const path = storePath();
    openDomainStore(path, [V1, V2]).close();
    expect(() => openDomainStore(path, [V1])).toThrow(/past this plugin's 1/);
    expect(() => openDomainStore(storePath(), [V1, { version: 3, sql: "" }])).toThrow(/numbered 3/);
  });

  it("leaves a store at its last good version when a migration fails", () => {
    const path = storePath();
    const db = openDomainStore(path, [V1]);
    expect(() => migrate(db, [V1, { version: 2, sql: "ALTER TABLE postings ADD COLUMN title TEXT; THIS IS NOT SQL" }])).toThrow();
    expect(storeVersion(db)).toBe(1);
    expect((db.prepare("PRAGMA table_info(postings)").all() as { name: string }[]).map((column) => column.name)).toEqual(["id"]);
    db.close();
  });
});

describe("a source's budget", () => {
  const budget = { perSecond: 0.5, perDay: 3 };
  const at = Date.parse("2026-10-16T10:00:00Z");

  it("lets one request through every 2 s at 0.5 a second, never sooner", () => {
    const first = takeBudget(budget, undefined, at);
    expect(first.ok).toBe(true);
    const soon = takeBudget(budget, first.state, at + 1_000);
    expect(soon).toMatchObject({ ok: false, reason: "per-second", retryAfterMs: 1_000 });
    expect(takeBudget(budget, first.state, at + 2_000).ok).toBe(true);
  });

  it("stops at perDay until the next UTC day", () => {
    let state = takeBudget(budget, undefined, at).state;
    for (const offset of [10_000, 20_000]) state = takeBudget(budget, state, at + offset).state;
    expect(state.usedToday).toBe(3);
    expect(takeBudget(budget, state, at + 30_000)).toMatchObject({ ok: false, reason: "per-day", retryAfterMs: 14 * 3_600_000 - 30_000 });
    expect(takeBudget(budget, state, Date.parse("2026-10-17T00:00:01Z")).ok).toBe(true);
  });

  it("is kept in the store across ledgers, as across a worker's idle stop", () => {
    const path = storePath();
    const db = openDomainStore(path, [V1]);
    expect(createBudgetLedger(db).take("adzuna", budget, at).ok).toBe(true);
    db.close();
    const reopened = openDomainStore(path, [V1]);
    const ledger = createBudgetLedger(reopened);
    expect(ledger.peek("adzuna")).toMatchObject({ usedToday: 1 });
    expect(ledger.take("adzuna", budget, at + 500).ok).toBe(false);
    expect(ledger.peek("adzuna")).toMatchObject({ usedToday: 1 });
    reopened.close();
  });
});

describe("a source's health", () => {
  const now = "2026-10-22T09:00:00.000Z";
  const open = () => createSourceHealth(openDomainStore(storePath(), [{ version: 1, sql: SOURCE_HEALTH_TABLE_SQL }]));

  it("pauses a source a day after its fifth failure in a row, and a success resets the count", () => {
    const health = open();
    for (let index = 1; index < SOURCE_PAUSE_FAILURES; index += 1) health.recordOutcome("adzuna", { ok: false, error: "503" }, now);
    expect(health.health("adzuna", now)).toMatchObject({ consecutiveFailures: SOURCE_PAUSE_FAILURES - 1, lastError: "503", callsToday: 4 });
    expect(health.health("adzuna", now).disabledUntil).toBeUndefined();
    const paused = health.recordOutcome("adzuna", { ok: false, drift: true }, now);
    expect(paused).toMatchObject({ consecutiveFailures: SOURCE_PAUSE_FAILURES, driftCount: 1, lastError: "failed" });
    expect(paused.disabledUntil).toBe(new Date(Date.parse(now) + SOURCE_PAUSE_MS).toISOString());
    const recovered = health.recordOutcome("adzuna", { ok: true }, now);
    expect(recovered).toMatchObject({ consecutiveFailures: 0, lastSuccess: now, disabledUntil: paused.disabledUntil });
    // `callsToday` counts the current UTC day only.
    expect(health.health("adzuna", "2026-10-23T09:00:00.000Z").callsToday).toBe(0);
  });

  it("pauses a source for its own pause length when it has one, and resumes it after that; a default source after a day", () => {
    const health = open();
    const hour = 3_600_000;
    const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
    for (let index = 0; index < SOURCE_PAUSE_FAILURES; index += 1) {
      health.recordOutcome("overpass", { ok: false, error: "timeout", failurePauseMs: hour }, now);
      health.recordOutcome("adzuna", { ok: false, error: "503" }, now);
    }
    expect(health.health("overpass", now).disabledUntil).toBe(at(hour));
    expect(health.health("adzuna", now).disabledUntil).toBe(at(SOURCE_PAUSE_MS));
    // Paused while `disabledUntil` is ahead of now: the hour's source is back after it, the default one only after a day.
    const pausedAt = (source: string, ms: number) => Date.parse(health.health(source, at(ms)).disabledUntil ?? "") > Date.parse(at(ms));
    expect([pausedAt("overpass", hour - 1), pausedAt("overpass", hour)]).toEqual([true, false]);
    expect([pausedAt("adzuna", hour), pausedAt("adzuna", SOURCE_PAUSE_MS - 1), pausedAt("adzuna", SOURCE_PAUSE_MS)]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("keeps a later pause already set, and lists every source", () => {
    const health = open();
    health.pause("b", "2026-10-30T00:00:00.000Z", now);
    expect(health.pause("b", "2026-10-25T00:00:00.000Z", now).disabledUntil).toBe("2026-10-30T00:00:00.000Z");
    health.recordOutcome("a", { ok: true }, now);
    expect(health.allHealth(now).map((entry) => entry.source)).toEqual(["a", "b"]);
  });
});

describe("the release check of a domain's sources", () => {
  const record = (overrides: Partial<DomainSourceRecord> = {}, terms: Partial<DomainSourceRecord["terms"]> = {}): DomainSourceRecord =>
    DomainSourceRecordSchema.parse({
      id: "adzuna",
      name: "Adzuna",
      countries: ["GB", "DE"],
      hosts: ["api.adzuna.com"],
      auth: "key-query",
      credential: ["adzunaAppKey"],
      terms: {
        url: "https://developer.adzuna.com/docs/terms_of_service",
        reviewedAt: "2026-10-16",
        licence: "Adzuna API terms",
        llmUse: "silent",
        cache: { mode: "ttl-hours", hours: 4 },
        attribution: "Jobs by Adzuna",
        displayRules: [],
        userTriggeredOnly: false,
        ...terms,
      },
      budget: { perSecond: 1, perDay: 250 },
      ...overrides,
    });
  const manifest = { networkDomains: ["api.adzuna.com", "*.greenhouse.io"], credentials: ["adzunaAppKey"], rawSecrets: ["adzunaAppKey"] };

  it("passes a record the manifest covers, reviewed within 180 days", () => {
    expect(domainSourceProblems([record()], manifest, "2027-04-14")).toEqual([]);
  });

  it("names stale terms, an uncovered host, an undeclared credential, a query key not raw, and a repeated id", () => {
    const problems = domainSourceProblems(
      [record({}, { reviewedAt: "2026-01-01" }), record({ hosts: ["api.example.com"] }), record({ credential: ["other"] })],
      { ...manifest, rawSecrets: [] },
      "2026-10-16",
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("over 180 days ago"),
        expect.stringContaining("api.example.com is not in the manifest's network.domains"),
        expect.stringContaining("credential other is not a credential setting"),
        expect.stringContaining("must be in rawSecrets"),
        expect.stringContaining("two records share this id"),
      ]),
    );
  });

  it("holds an OAuth client's id and secret raw, since a token request Base64-encodes them in its Basic auth", () => {
    const client = record({ auth: "oauth-client", credential: ["adzunaAppKey"] });
    expect(domainSourceProblems([client], { ...manifest, rawSecrets: [] }, "2026-10-16")).toEqual([
      "adzuna: oauth-client puts adzunaAppKey where the proxy cannot, so it must be in rawSecrets",
    ]);
    expect(domainSourceProblems([client], manifest, "2026-10-16")).toEqual([]);
    // A header key is the proxy's to put in place.
    expect(domainSourceProblems([record({ auth: "key-header" })], { ...manifest, rawSecrets: [] }, "2026-10-16")).toEqual([]);
  });

  it("refuses a today that is not a YYYY-MM-DD date, rather than pass every record", () => {
    expect(() => domainSourceProblems([record()], manifest, "2026-10-16T12:00:00.000Z")).toThrow(/YYYY-MM-DD/);
    expect(() => domainSourceProblems([record()], manifest, "2026-13-45")).toThrow(/YYYY-MM-DD/);
  });

  it("reads a domain pattern as the manifest does", () => {
    expect(domainCovers("*.greenhouse.io", "boards-api.greenhouse.io")).toBe(true);
    expect(domainCovers("*.greenhouse.io", "greenhouse.io")).toBe(false);
    expect(domainCovers("*.greenhouse.io", "evilgreenhouse.io")).toBe(false);
    expect(domainCovers("api.example.com:8443", "api.example.com:8443")).toBe(true);
    expect(domainCovers("api.example.com", "api.example.com:8443")).toBe(false);
  });
});
