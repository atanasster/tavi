import { expect, it } from "vitest";
import { RoutineCreateSchema, isPrimarySourceHost, routineDefaults } from "@tavi/contracts";
import {
  CLUSTERING_ACCEPTANCE_RULE,
  PUBLISHER_REGISTRY,
  PUBLISHER_REGISTRY_REVIEWED_AT,
  PUBLISHER_REGISTRY_VERSION,
  ROUTINE_CLUSTERING,
  loadRoutineCorpus,
  materialChangeFingerprint,
  mayCorroborate,
  publisherIdentity,
  samePublisher,
  sentenceOverlap,
  sweepClusteringThreshold,
  syndicationVerdict,
} from "@tavi/runtime";
import { RoutineExecutionService } from "../src/routines/runs.js";
import { RoutineNewsService } from "../src/routines/news.js";
import { RoutineService } from "../src/routines/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Publisher identity, syndication, and a measured clustering threshold.
 *
 * The clustering number in the code is asserted equal to the number the sweep
 * chose over the frozen corpus, so the constant cannot drift from its measurement.
 */
const scope = { workspaceId: "default", principalId: "operator" };
const corpus = loadRoutineCorpus();

it("sweeps the near-duplicate threshold over the frozen corpus and keeps the chosen value", () => {
  const sweep = sweepClusteringThreshold(corpus);
  // The measurement, not a preference: the lowest threshold that clears the rule.
  expect(sweep).toMatchObject({
    method: "sentence-containment",
    corpusVersion: ROUTINE_CLUSTERING.corpusVersion,
    rule: CLUSTERING_ACCEPTANCE_RULE,
  });

  const accepted = sweep.rows.filter((row) => row.precision >= 0.95 && row.recall >= 0.8);
  expect(accepted.length).toBeGreaterThan(0);
  expect(sweep.chosen).toBe(Math.min(...accepted.map((row) => row.threshold)));
  // The constant in use is the value the sweep chose.
  expect(ROUTINE_CLUSTERING.threshold).toBe(sweep.chosen);
  // The row below the chosen threshold is rejected for precision and the chosen
  // row clears both bars, which is what makes this a measurement.
  const below = sweep.rows.filter((row) => row.threshold < sweep.chosen);
  for (const row of below) expect(row.precision).toBeLessThan(0.95);
  const chosenRow = sweep.rows.find((row) => row.threshold === sweep.chosen)!;
  expect(chosenRow.precision).toBeGreaterThanOrEqual(0.95);
  expect(chosenRow.recall).toBeGreaterThanOrEqual(0.8);
});

it("identifies a publisher, and refuses to call an unlisted host independent", () => {
  expect(publisherIdentity("blog.google")).toMatchObject({ publisher: "Google", ownership: "publisher", source: "registry" });
  expect(publisherIdentity("deepmind.google")).toMatchObject({ publisher: "Google DeepMind", ownership: "publisher" });
  expect(publisherIdentity("medium.com")).toMatchObject({ ownership: "syndicator" });
  expect(publisherIdentity("arxiv.org")).toMatchObject({ ownership: "aggregator" });
  // An unlisted host is explicitly unknown, never a default "independent".
  expect(publisherIdentity("nobody-reviewed-this.example")).toMatchObject({
    ownership: "unknown",
    source: "unknown",
    publisher: "nobody-reviewed-this.example",
  });
  // Independence is stricter than corroboration: only a first-party publisher is
  // independent, and `ownership` is where the registry answers that question.
  expect(publisherIdentity("openai.com").ownership).toBe("publisher");
  expect(publisherIdentity("medium.com").ownership).toBe("syndicator");
  expect(publisherIdentity("nobody-reviewed-this.example").ownership).toBe("unknown");
  // Corroboration is weaker than independence: an unreviewed host may still
  // contribute (with the caveat rendered), while a known syndicator may not.
  expect(mayCorroborate("nobody-reviewed-this.example")).toBe(true);
  expect(mayCorroborate("medium.com")).toBe(false);
  expect(mayCorroborate("arxiv.org")).toBe(false);
  expect(mayCorroborate("openai.com")).toBe(true);
  // Membership is evidence, not proof: the entry says where it came from.
  for (const entry of PUBLISHER_REGISTRY) expect(entry.provenance.length).toBeGreaterThan(10);
  expect(PUBLISHER_REGISTRY_REVIEWED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(PUBLISHER_REGISTRY_VERSION).toBeGreaterThan(0);
  // Same organisation, different host: one publisher, not two sources.
  expect(samePublisher("blog.google", "research.google")).toBe(true);
  expect(samePublisher("blog.google", "openai.com")).toBe(false);
  // Two hosts that share only a public suffix are not one organisation: the
  // fallback label for an unlisted host is its registrable domain, so a two-label
  // suffix like `co.uk` cannot become an identity.
  expect(publisherIdentity("a.co.uk").publisher).toBe("a.co.uk");
  expect(publisherIdentity("b.co.uk").publisher).toBe("b.co.uk");
  expect(publisherIdentity("news.sky.co.uk").publisher).toBe("sky.co.uk");
  expect(samePublisher("a.co.uk", "b.co.uk")).toBe(false);
  expect(samePublisher("news.sky.co.uk", "www.sky.co.uk")).toBe(true);
});

it("keeps egress permission and independence as two lists that disagree on purpose", () => {
  // `isPrimarySourceHost` answers whether the `primary_sources` network mode may
  // fetch a host; the publisher registry answers who may corroborate. They are
  // separately reviewed lists for different questions, and these pins are the
  // disagreements that show they are not one list wearing two names.
  expect(isPrimarySourceHost("arxiv.org")).toBe(true);
  expect(publisherIdentity("arxiv.org").ownership).toBe("aggregator");
  expect(mayCorroborate("arxiv.org")).toBe(false);
  // The converse: a registry publisher that this egress mode does not admit.
  expect(publisherIdentity("reuters.com").ownership).toBe("publisher");
  expect(isPrimarySourceHost("reuters.com")).toBe(false);
  // A host on neither list is unknown for independence and refused for egress.
  expect(publisherIdentity("nobody-reviewed-this.example").ownership).toBe("unknown");
  expect(isPrimarySourceHost("nobody-reviewed-this.example")).toBe(false);
});

it("detects syndication by publisher, by text and by publication order", () => {
  const at = "2026-09-20T05:00:00Z";
  const body = "Alpha Model version 2 is now available. It supports a longer context window. It also ships with three new tools.";
  // Same publisher on two of its own hosts.
  expect(
    syndicationVerdict(
      { publisher: "blog.google", excerpt: body, publishedAt: at, retrievedAt: at },
      { publisher: "research.google", excerpt: "Unrelated text entirely.", publishedAt: at, retrievedAt: at },
    ),
  ).toMatchObject({ syndicated: true, reason: "same-publisher" });
  // Near-identical text under different publishers.
  expect(
    syndicationVerdict(
      { publisher: "a.example", excerpt: body, publishedAt: at, retrievedAt: at },
      { publisher: "b.example", excerpt: `${body} Extra sentence.`, publishedAt: at, retrievedAt: at },
    ),
  ).toMatchObject({ syndicated: true, reason: "near-duplicate-text" });
  // A rewrite that follows the original within the window, sharing most sentences.
  // Shares one sentence of three, which is below the duplicate bar and above the
  // publication-order bar: the case the third rule exists for.
  const rewritten = "Alpha Model version 2 is now available. Reported by our staff. Coverage continues elsewhere.";
  expect(
    syndicationVerdict(
      { publisher: "a.example", excerpt: body, publishedAt: "2026-09-20T04:00:00Z", retrievedAt: at },
      { publisher: "b.example", excerpt: rewritten, publishedAt: at, retrievedAt: at },
    ),
  ).toMatchObject({ syndicated: true, reason: "published-after" });
  // Two genuinely different releases are not a duplicate, whatever the threshold.
  expect(
    syndicationVerdict(
      { publisher: "a.example", excerpt: "Alpha Model version 2 is now available.", publishedAt: at, retrievedAt: at },
      { publisher: "b.example", excerpt: "The local bakery is now open.", publishedAt: at, retrievedAt: at },
    ),
  ).toEqual({ syndicated: false });
  expect(sentenceOverlap("One. Two.", "One. Two.")).toBe(1);
  expect(sentenceOverlap("", "One.")).toBe(0);
});

it("treats a material change inside one release identity as a new story", () => {
  const first = materialChangeFingerprint([{ text: "Alpha Model version 2 is now available." }]);
  const same = materialChangeFingerprint([{ text: "Alpha Model version 2 is now available." }]);
  const versioned = materialChangeFingerprint([{ text: "Alpha Model version 3 is now available." }]);
  const benchmarked = materialChangeFingerprint([{ text: "Alpha Model version 2 is now available and scores 90 on MMLU." }], true);
  const dated = materialChangeFingerprint([{ text: "Alpha Model version 2 is now available as of 2026-09-20." }]);
  expect(same).toBe(first);
  expect(versioned).not.toBe(first);
  expect(benchmarked).not.toBe(first);
  expect(dated).not.toBe(first);
  // An LLM benchmark is material only to a model release; any other story records none.
  const scored = [{ text: "Alpha Model version 2 scores 90 on MMLU." }];
  expect(JSON.parse(materialChangeFingerprint(scored, true)).benchmarks).toEqual(["mmlu"]);
  expect(JSON.parse(materialChangeFingerprint(scored)).benchmarks).toEqual([]);
});

function fixture(clustering?: { threshold: number; method: string } | null) {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const routines = new RoutineService(store, {
    executionAvailable: true,
    authorizeTarget: () => true,
    nextOccurrence: () => "2026-09-21T06:00:00.000Z",
  });
  const runs = new RoutineExecutionService(routines, {
    ownerEpoch: "c6",
    now: () => "2026-09-20T06:00:00.000Z",
    authorized: () => true,
    researchReady: () => ({ ready: true as const }),
  });
  const news = new RoutineNewsService(runs, clustering === undefined ? {} : { clustering });
  const created = routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...routineDefaults("Europe/Sofia"),
      operationKey: "c6",
      name: "News",
      objective: "Find news",
      agent: { agentId: "news", name: "News", instructions: "Find evidence" },
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
      skills: [],
      models: {
        research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
        synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      },
      permissions: {
        revision: 1,
        researchTools: ["http.request"],
        allowedHosts: ["openai.com", "reuters.com", "medium.com", "example.com"],
        networkMode: "allowlist",
      },
    }),
  );
  routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  const run = runs.request(scope, created.routine.routineId, "manual");
  const fence = runs.start(scope, run.runId)!;
  return { store, news, runs, fence, run, close: () => store.close() };
}

const page = (_title: string, body: string, at = "2026-09-20T05:00:00Z") => ({
  ok: true,
  body: `<meta property="article:published_time" content="${at}"><p>${body}</p>`,
});
const selection = (text: string, sourceId: string, releaseIdentity = "Alpha Model version 2") => ({
  stories: [{ title: "Release", releaseIdentity, eventKind: "release" as const, claims: [{ text, sourceId }] }],
});

it("counts a syndicated copy as one publisher, and a syndicator host as none", () => {
  const f = fixture();
  try {
    const copy = "Alpha Model version 2 is now available.";
    const first = f.news.capture(f.fence, "http.request", { url: "https://openai.com/a" }, page("A", copy)) as { sourceId: string };
    // The same material on a hosting platform: not independent.
    const second = f.news.capture(f.fence, "http.request", { url: "https://medium.com/b" }, page("B", copy)) as { sourceId: string };
    const report = f.news.select(
      scope,
      f.run.runId,
      {
        stories: [
          {
            title: "Release",
            releaseIdentity: "Alpha Model version 2",
            eventKind: "release",
            claims: [
              { text: copy, sourceId: first.sourceId },
              { text: copy, sourceId: second.sourceId },
            ],
          },
        ],
      },
      "2026-09-20T06:00:00.000Z",
    );
    expect(report.stories[0]).toMatchObject({ independentlyCorroborated: false });
    expect(report.stories[0]!.caveats.join(" ")).toContain("non-independent");
    // An unlisted host is a different statement again: nobody has reviewed it.
    const third = f.news.capture(
      f.fence,
      "http.request",
      { url: "https://example.com/c" },
      page("C", "Alpha Model version 2 is now available according to a blog."),
    ) as { sourceId: string };
    const unreviewed = f.news.capture(
      f.fence,
      "http.request",
      { url: "https://example.com/d" },
      page("D", "Alpha Model version 2 is now available, per a second blog."),
    ) as { sourceId: string };
    const blogged = f.news.select(
      scope,
      f.run.runId,
      {
        stories: [
          {
            title: "Release",
            releaseIdentity: "Alpha Model version 2",
            eventKind: "release",
            claims: [
              { text: "Alpha Model version 2 is now available according to a blog.", sourceId: third.sourceId },
              { text: "Alpha Model version 2 is now available, per a second blog.", sourceId: unreviewed.sourceId },
            ],
          },
        ],
      },
      "2026-09-20T06:00:00.000Z",
    );
    expect(blogged.stories[0]!.caveats.join(" ")).toContain("not in the curated registry");
  } finally {
    f.close();
  }
});

it("counts two different publishers as independent", () => {
  const f = fixture();
  try {
    const copy = "Alpha Model version 2 is now available.";
    const paraphrase = "Alpha Model version 2 has been released, the company said.";
    const first = f.news.capture(f.fence, "http.request", { url: "https://openai.com/a" }, page("A", copy)) as { sourceId: string };
    const second = f.news.capture(f.fence, "http.request", { url: "https://reuters.com/b" }, page("B", paraphrase)) as { sourceId: string };
    const report = f.news.select(
      scope,
      f.run.runId,
      {
        stories: [
          {
            title: "Release",
            releaseIdentity: "Alpha Model version 2",
            eventKind: "release",
            claims: [
              { text: copy, sourceId: first.sourceId },
              { text: paraphrase, sourceId: second.sourceId },
            ],
          },
        ],
      },
      "2026-09-20T06:00:00.000Z",
    );
    expect(report.stories[0]).toMatchObject({ independentlyCorroborated: true, caveats: [] });
    // Under strict corroboration, a single source is refused rather than caveated.
    const strict = f.news.select(scope, f.run.runId, selection(copy, first.sourceId), "2026-09-20T06:00:00.000Z");
    expect(strict.stories[0]!.caveats).toContain("Single-source or non-independent coverage");
  } finally {
    f.close();
  }
});

it("records why a story was suppressed, and labels a clustering fallback", () => {
  const f = fixture();
  try {
    const text = "Alpha Model version 2 is now available.";
    const source = f.news.capture(f.fence, "http.request", { url: "https://openai.com/a" }, page("A", text)) as { sourceId: string };
    const first = f.news.select(scope, f.run.runId, selection(text, source.sourceId), "2026-09-20T06:00:00.000Z");
    expect(first.suppressions).toEqual([]);
    f.store.handle
      .prepare("UPDATE tavi_routine_state SET state_json=?")
      .run(JSON.stringify({ dedup: [{ key: first.stories[0]!.dedupKey, at: "2026-09-20T06:00:00.000Z" }] }));
    const repeat = f.news.select(scope, f.run.runId, selection(text, source.sourceId), "2026-09-20T06:00:00.000Z");
    expect(repeat.stories).toHaveLength(0);
    expect(repeat.suppressions).toEqual([
      { releaseIdentity: "Alpha Model version 2", reason: expect.stringContaining("already reported") },
    ]);
  } finally {
    f.close();
  }

  const fallback = fixture(null);
  try {
    const text = "Alpha Model version 2 is now available.";
    const source = fallback.news.capture(fallback.fence, "http.request", { url: "https://openai.com/a" }, page("A", text)) as {
      sourceId: string;
    };
    const report = fallback.news.select(scope, fallback.run.runId, selection(text, source.sourceId), "2026-09-20T06:00:00.000Z");
    expect(report.coverage.gaps.join(" ")).toContain("clustering is unavailable");
    expect(report.stories[0]!.caveats.join(" ")).toContain("clustering was unavailable");
    // The provenance of the policy actually in force is on the run, for its production publication to record.
    const data = JSON.parse(
      (
        fallback.store.handle.prepare("SELECT data_json FROM tavi_routine_runs WHERE run_id=?").get(fallback.run.runId) as {
          data_json: string;
        }
      ).data_json,
    ) as { clustering: { threshold: number | null; method: string | null; registryVersion: number } };
    expect(data.clustering).toMatchObject({ threshold: null, method: null, registryVersion: PUBLISHER_REGISTRY_VERSION });
  } finally {
    fallback.close();
  }
});

it("records the threshold, method and registry provenance the report was produced under", () => {
  const f = fixture();
  try {
    const text = "Alpha Model version 2 is now available.";
    const source = f.news.capture(f.fence, "http.request", { url: "https://openai.com/a" }, page("A", text)) as { sourceId: string };
    f.news.select(scope, f.run.runId, selection(text, source.sourceId), "2026-09-20T06:00:00.000Z");
    const data = JSON.parse(
      (f.store.handle.prepare("SELECT data_json FROM tavi_routine_runs WHERE run_id=?").get(f.run.runId) as { data_json: string })
        .data_json,
    ) as { clustering: { threshold: number; method: string; registryVersion: number; registryReviewedAt: string; corpusVersion: number } };
    expect(data.clustering).toEqual({
      threshold: ROUTINE_CLUSTERING.threshold,
      method: ROUTINE_CLUSTERING.method,
      registryVersion: PUBLISHER_REGISTRY_VERSION,
      registryReviewedAt: PUBLISHER_REGISTRY_REVIEWED_AT,
      corpusVersion: ROUTINE_CLUSTERING.corpusVersion,
      at: "2026-09-20T06:00:00.000Z",
    });
  } finally {
    f.close();
  }
});
