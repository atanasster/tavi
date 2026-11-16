import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { adzunaRecord, greenhouseRecord, normalizePosting, openJobsStore, type JobSourceRecord, type RawPosting } from "../src/index.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());
const path = () => {
  const directory = temp.create("tavi-jobs-store-");
  return join(directory, "jobs.db");
};
const NOW = "2026-10-16T12:00:00.000Z";
const later = (hours: number) => new Date(Date.parse(NOW) + hours * 3_600_000).toISOString();
const raw = (extra: Partial<RawPosting> = {}): RawPosting => ({
  source: "greenhouse",
  sourceRef: "acme/1",
  tenant: "acme",
  url: "https://boards.greenhouse.io/acme/jobs/1",
  title: "Senior Backend Engineer",
  company: "Acme",
  locations: ["Berlin, Germany"],
  workplace: "hybrid",
  descriptionText: "Build services in Go.",
  reqId: "R-1",
  attribution: "Acme via Greenhouse",
  ...extra,
});
const posting = (extra: Partial<RawPosting> = {}) => normalizePosting(raw(extra), NOW);
const records: ReadonlyMap<string, JobSourceRecord> = new Map([
  ["greenhouse", greenhouseRecord],
  ["adzuna", adzunaRecord],
]);

describe("the jobs store", () => {
  it("keeps a posting and updates it when seen again, keeping its first sighting", () => {
    const store = openJobsStore(path(), records);
    const [first] = store.upsert([posting()], NOW);
    store.upsert([posting({ title: "Senior Backend Engineer (Go)" })], later(1));
    const kept = store.get(first?.postingId ?? "", NOW);
    expect(kept).toMatchObject({ firstSeen: NOW, lastSeen: later(1), removed: false, posting: { title: "Senior Backend Engineer (Go)" } });
    store.close();
  });

  it("joins the same job on another host by its canonical URL, and a repost with a new id by its fingerprint", () => {
    const store = openJobsStore(path(), records);
    const [original] = store.upsert([posting()], NOW);
    const [otherHost] = store.upsert(
      [posting({ sourceRef: "acme/1-mirror", url: "https://job-boards.greenhouse.io/acme/jobs/1?gh_src=x", reqId: undefined })],
      NOW,
    );
    const [repost] = store.upsert(
      [posting({ source: "adzuna", sourceRef: "DE/99", tenant: undefined, url: "https://www.adzuna.de/land/ad/99", reqId: undefined })],
      NOW,
    );
    const [other] = store.upsert(
      [posting({ sourceRef: "acme/2", url: "https://boards.greenhouse.io/acme/jobs/2", reqId: "R-2", title: "Data Engineer" })],
      NOW,
    );
    expect(otherHost?.clusterId).toBe(original?.clusterId);
    expect(repost?.clusterId).toBe(original?.clusterId);
    expect(other?.clusterId).not.toBe(original?.clusterId);
    store.close();
  });

  it("joins by ATS identity when the URL and fingerprint differ, and by URL when the title changed", () => {
    const store = openJobsStore(path(), records);
    const [original] = store.upsert([posting()], NOW);
    const [byAts] = store.upsert(
      [posting({ sourceRef: "acme/1-copy", url: "https://careers.acme.com/jobs?gh_jid=1", title: "Backend Engineer, Payments" })],
      NOW,
    );
    const [byUrl] = store.upsert(
      [
        posting({
          source: "lever",
          sourceRef: "acme/x",
          tenant: "acme",
          url: "https://boards.greenhouse.io/acme/jobs/1",
          reqId: undefined,
          title: "Platform Engineer",
        }),
      ],
      NOW,
    );
    expect(byAts?.clusterId).toBe(original?.clusterId);
    expect(byUrl?.clusterId).toBe(original?.clusterId);
    store.close();
  });

  it("keeps two openings with one title apart: on the same board, or with different requisitions", () => {
    const store = openJobsStore(path(), records);
    const [first] = store.upsert([posting()], NOW);
    const [sameBoard] = store.upsert(
      [posting({ sourceRef: "acme/7", url: "https://boards.greenhouse.io/acme/jobs/7", reqId: "R-7" })],
      NOW,
    );
    const [otherReq] = store.upsert(
      [posting({ source: "lever", sourceRef: "acme/z", url: "https://jobs.lever.co/acme/z", reqId: "R-9" })],
      NOW,
    );
    expect(sameBoard?.clusterId).not.toBe(first?.clusterId);
    expect(otherReq?.clusterId).not.toBe(first?.clusterId);
    store.close();
  });

  it("never writes an ids-only source's text, and blanks an expired one on read before retention runs", () => {
    const idsOnly: JobSourceRecord = {
      ...greenhouseRecord,
      id: "idsonly",
      terms: { ...greenhouseRecord.terms, cache: { mode: "ids-only" } },
    };
    const store = openJobsStore(path(), new Map([...records, ["idsonly", idsOnly]]));
    const [ids] = store.upsert(
      [posting({ source: "idsonly", sourceRef: "a/1", url: "https://ids.example/1", reqId: undefined, title: "Ids Only" })],
      NOW,
    );
    expect(
      (
        store.db.prepare("SELECT description, record FROM postings WHERE posting_id = ?").get(ids?.postingId ?? "") as {
          description: string;
          record: string;
        }
      ).description,
    ).toBe("");
    expect(store.get(ids?.postingId ?? "", NOW)?.posting.excerpt).toBe("");
    const [adzuna] = store.upsert(
      [
        posting({
          source: "adzuna",
          sourceRef: "DE/1",
          tenant: undefined,
          url: "https://www.adzuna.de/land/ad/1",
          reqId: undefined,
          company: "Other",
        }),
      ],
      NOW,
    );
    expect(store.get(adzuna?.postingId ?? "", later(3))?.description).toBe("Build services in Go.");
    expect(store.get(adzuna?.postingId ?? "", later(5))).toMatchObject({ description: "", posting: { excerpt: "" } });
    store.close();
  });

  it("counts calls today only for today", () => {
    const store = openJobsStore(path(), records);
    store.recordOutcome("lever", { ok: true }, NOW);
    store.recordOutcome("lever", { ok: true }, NOW);
    expect(store.health("lever", NOW).callsToday).toBe(2);
    expect(store.health("lever", later(24)).callsToday).toBe(0);
    expect(store.recordOutcome("lever", { ok: true }, later(24)).callsToday).toBe(1);
    store.close();
  });

  it("tracks an application through its states with a history, and counts the pipeline", () => {
    const store = openJobsStore(path(), records);
    const [saved] = store.upsert([posting()], NOW);
    store.track({ postingId: saved?.postingId ?? "", state: "saved", note: "Looks good", actor: "agent" }, NOW);
    const applied = store.track({ postingId: saved?.postingId ?? "", state: "applied", actor: "person" }, later(2));
    expect(applied).toMatchObject({
      state: "applied",
      note: "Looks good",
      appliedAt: later(2),
      history: [
        { state: "saved", actor: "agent" },
        { state: "applied", actor: "person" },
      ],
    });
    expect(store.counts()).toMatchObject({ saved: 0, applied: 1 });
    expect(store.applications(["applied"]).map((each) => each.postingId)).toEqual([saved?.postingId]);
    expect(() => store.track({ postingId: "nope", state: "saved", actor: "agent" }, NOW)).toThrow(/no posting/);
    store.close();
  });

  it("pauses a source after five failures in a row for a day, and a success resets them", () => {
    const store = openJobsStore(path(), records);
    for (let index = 0; index < 4; index += 1) store.recordOutcome("lever", { ok: false, error: "503" }, NOW);
    expect(store.health("lever", NOW)).toMatchObject({ consecutiveFailures: 4 });
    expect(store.health("lever", NOW).disabledUntil).toBeUndefined();
    expect(store.recordOutcome("lever", { ok: false, error: "503" }, NOW)).toMatchObject({
      consecutiveFailures: 5,
      disabledUntil: later(24),
      lastError: "503",
    });
    expect(store.recordOutcome("lever", { ok: true }, later(25))).toMatchObject({ consecutiveFailures: 0, lastSuccess: later(25) });
    expect(store.recordOutcome("lever", { ok: false, pauseUntil: later(26) }, later(25)).disabledUntil).toBe(later(26));
    store.close();
  });

  it("keeps the last 500 outbound requests, keywords only", () => {
    const store = openJobsStore(path(), records);
    for (let index = 0; index < 510; index += 1)
      store.log({ source: "greenhouse", host: "boards-api.greenhouse.io", at: NOW, status: 200, bytes: index, keywords: "backend" });
    const recent = store.recentFetches(20);
    expect(recent).toHaveLength(20);
    expect(recent[0]).toMatchObject({ bytes: 509, keywords: "backend" });
    expect((store.db.prepare("SELECT count(*) AS n FROM fetch_log").get() as { n: number }).n).toBe(500);
    store.close();
  });

  it("blanks Adzuna's text 4 hours after fetching, keeping its identifiers, title, company and link", () => {
    const store = openJobsStore(path(), records);
    const [adzuna] = store.upsert(
      [
        posting({
          source: "adzuna",
          sourceRef: "DE/1",
          tenant: undefined,
          url: "https://www.adzuna.de/land/ad/1",
          reqId: undefined,
          company: "Other",
        }),
      ],
      NOW,
    );
    expect(store.retain(later(3))).toEqual({ deleted: 0, blanked: 0 });
    expect(store.retain(later(5))).toEqual({ deleted: 0, blanked: 1 });
    expect(store.get(adzuna?.postingId ?? "", NOW)).toMatchObject({
      description: "",
      posting: { excerpt: "", title: "Senior Backend Engineer", company: "Other", url: "https://www.adzuna.de/land/ad/1" },
    });
    store.close();
  });

  it("deletes a posting 60 days after last seen and blanks its text after 14, unless it is in the pipeline", () => {
    const store = openJobsStore(path(), records);
    const [gone, tracked] = store.upsert(
      [posting(), posting({ sourceRef: "acme/2", url: "https://boards.greenhouse.io/acme/jobs/2", reqId: "R-2", title: "Data Engineer" })],
      NOW,
    );
    store.track({ postingId: tracked?.postingId ?? "", state: "saved", actor: "agent" }, NOW);
    expect(store.retain(later(15 * 24))).toEqual({ deleted: 0, blanked: 1 });
    expect(store.retain(later(61 * 24))).toEqual({ deleted: 1, blanked: 0 });
    expect(store.get(gone?.postingId ?? "", NOW)).toBeUndefined();
    expect(store.get(tracked?.postingId ?? "", NOW)?.description).toBe("Build services in Go.");
    store.close();
  });

  it("hides a removed posting at once, and brings it back if seen again", () => {
    const store = openJobsStore(path(), records);
    const [kept] = store.upsert([posting()], NOW);
    store.remove([kept?.postingId ?? ""], NOW);
    expect(store.many([kept?.postingId ?? ""], NOW)).toEqual([]);
    store.upsert([posting()], later(1));
    expect(store.many([kept?.postingId ?? ""], NOW)).toHaveLength(1);
    store.close();
  });

  it("forgets everything when asked, and survives a reopen otherwise", () => {
    const file = path();
    const store = openJobsStore(file, records);
    const [kept] = store.upsert([posting()], NOW);
    store.close();
    const again = openJobsStore(file, records);
    expect(again.get(kept?.postingId ?? "", NOW)).toBeDefined();
    again.forget();
    expect(again.get(kept?.postingId ?? "", NOW)).toBeUndefined();
    again.close();
  });
});
