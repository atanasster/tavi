import { trendsRoutineTemplate } from "@tavi/test-support/routine-templates";
import { asyncRoutineEffects } from "./async-routine-effects.js";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import {
  ROUTINE_LLM_RELEASES_INSTRUCTIONS,
  ROUTINE_NEWS_INSTRUCTIONS,
  RoutineCreateSchema,
  routineDefaults,
  type RoutineFence,
} from "@tavi/contracts";
import { ToolRegistry, routineResearchTools, canonicalRoutineJson, routineDeliveryTime, routineHash } from "@tavi/runtime";
import { printThemeCss } from "@tavi/contracts/print-theme";
import { temporaryDirectories } from "@tavi/test-support";
import { RoutineExecutionService } from "../src/routines/runs.js";
import { RoutineService } from "../src/routines/service.js";
import { SqliteStore } from "../src/persistence/store.js";
import { RoutineNewsService } from "../src/routines/news.js";
import { REPORT_TEXT_LIMIT, RoutinePublicationService, routineReportText } from "../src/routines/publication.js";
import { renderRoutineNewsHtml } from "../src/routines/news.js";
import { RoutineDeliveryService } from "../src/routines/delivery.js";
import { RoutineDeliveryDrain } from "../src/routines/drain.js";
const stores: SqliteStore[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});
const scope = { workspaceId: "default", principalId: "operator" };
/** The worker's delivery service, drained by the loop the owner ships. */
class DrainedDelivery extends RoutineDeliveryService {
  private readonly loop = new RoutineDeliveryDrain(this, this.options);
  drain(): Promise<void> {
    return this.loop.drain();
  }
}
function fixture(
  mode: "production" | "preview" = "production",
  templateVersion: "news-v1" | "llm-releases-v1" | "trends-v1" = "news-v1",
  routine: { readonly name?: string; readonly objective?: string; readonly instructions?: string; readonly evaluated?: boolean } = {},
) {
  const dir = directories.create("routine-news-");
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true, artifactsDirectory: dir });
  stores.push(store);
  const now = "2026-09-20T06:00:00.000Z";
  const routines = new RoutineService(store, {
    executionAvailable: true,
    authorizeTarget: () => true,
    now: () => now,
    nextOccurrence: () => "2026-09-21T06:00:00.000Z",
  });
  const defaults = routineDefaults("Europe/Sofia");
  const created = routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...defaults,
      report: { ...defaults.report, templateVersion, ...(templateVersion === "trends-v1" ? { template: trendsRoutineTemplate() } : {}) },
      operationKey: "create",
      name: routine.name ?? "News",
      objective: routine.objective ?? "Find news",
      agent: { agentId: "news", name: routine.name ?? "News", instructions: routine.instructions ?? "Find evidence" },
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
      skills: [],
      models: {
        research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
        synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      },
      permissions: {
        revision: 1,
        researchTools: ["web_search", "http.request"],
        allowedHosts: ["example.com", "second.com"],
        networkMode: "allowlist",
      },
    }),
  );
  if (routine.evaluated !== false) routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  const runs = new RoutineExecutionService(routines, {
    now: () => now,
    ownerEpoch: "one",
    authorized: () => true,
    researchReady: () => ({ ready: true }),
    publicFetch: { resolve: async () => ["93.184.216.34"] },
  });
  const admitted = runs.request(scope, created.routine.routineId, "manual", mode);
  const fence = runs.start(scope, admitted.runId)!;
  const run = runs.get(scope, admitted.runId);
  const news = new RoutineNewsService(runs);
  const publication = new RoutinePublicationService(runs, { now: () => now });
  const delivery = new RoutineDeliveryService(runs, {
    now: () => now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        throw new Error("unexpected send");
      },
    },
  });
  const source = news.capture(
    fence,
    "http.request",
    { url: "https://example.com/model" },
    {
      ok: true,
      body: '<meta property="article:published_time" content="2026-09-20T05:00:00Z"><p>Model One version 2 is now available.</p>',
    },
  ) as { sourceId: string };
  const selection = {
    stories: [
      {
        title: "Release",
        releaseIdentity: "Model One version 2",
        eventKind: "release",
        claims: [{ text: "Model One version 2 is now available.", sourceId: source.sourceId }],
      },
    ],
  };
  return { store, routines, runs, run, fence, news, publication, delivery, selection, now };
}
/**
 * Admit a target into a run the fixture already started.
 *
 * Production never does this: a delivery target is part of the revision a run is
 * admitted under, so the run's pinned snapshot *and* its grant name it from
 * the first effect. The fixture needs it because these cases publish first and
 * then choose a destination, so the helper re-pins both together — exactly what
 * admission would have produced — rather than leaving the grant narrower than
 * the snapshot and calling the resulting refusal a bug.
 */
function pinDestinations(
  f: ReturnType<typeof fixture>,
  targetIds: string[],
  patch: Partial<ReturnType<typeof fixture>["run"]["snapshot"]["delivery"]> = {},
): void {
  const run = f.runs.get(scope, f.run.runId);
  const { revokedAt: _revokedAt, revokedReason: _revokedReason, ...base } = f.runs.grantFor(scope, run.runId)!;
  const grant = { ...base, destinationIds: targetIds };
  f.store.handle
    .prepare("UPDATE tavi_routine_grants SET grant_json=?,grant_hash=? WHERE run_id=?")
    .run(canonicalRoutineJson(grant), routineHash(grant), run.runId);
  if (Object.keys(patch).length > 0) {
    const formats = run.snapshot.report.formats.includes("pdf")
      ? run.snapshot.report.formats
      : [...run.snapshot.report.formats, "pdf" as const];
    f.store.handle.prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?").run(
      canonicalRoutineJson({
        ...run.snapshot,
        report: { ...run.snapshot.report, formats },
        delivery: { ...run.snapshot.delivery, targetIds, ...patch },
      }),
      run.runId,
    );
  }
}

/** The run as it would be read at enqueue time, with a target the fixture chose after admission. */
function withTarget(
  f: ReturnType<typeof fixture>,
  targetIds: string[],
  patch: Partial<ReturnType<typeof fixture>["run"]["snapshot"]["delivery"]> = {},
): ReturnType<typeof fixture>["run"] {
  const run = f.runs.get(scope, f.run.runId);
  pinDestinations(f, targetIds, patch);
  return { ...run, snapshot: { ...run.snapshot, delivery: { ...run.snapshot.delivery, targetIds, ...patch } } };
}
const mediated = (url: string, status: number, truncated: boolean) => ({
  provider: "builtin:public-fetch",
  content: {
    url,
    statusCode: status,
    truncated,
    body: {
      kind: "html",
      content: '<meta property="article:published_time" content="2026-09-20T05:00:00Z"><p>Model Two version 3 is now available.</p>',
    },
  },
  receipt: {
    version: 1,
    url,
    finalUrl: url,
    status,
    contentType: "text/html",
    bytes: 120,
    address: "93.184.216.34",
    addressClass: "public",
    redirects: [],
  },
});
it.each([
  ["truncated", 200, true],
  ["http_status", 404, false],
] as const)("records a %s mediated fetch as failed evidence outside fetched coverage", (reason, status, truncated) => {
  const f = fixture();
  const url = "https://example.com/partial";
  const source = f.news.capture(f.fence, "web_fetch", { url }, mediated(url, status, truncated));
  expect(source).toMatchObject({ state: "failed", failureReason: reason, contentHash: null, byteSize: null, excerpt: "" });
  expect(f.news.sources(scope, f.run.runId).filter((item) => item.state === "fetched")).toHaveLength(1);
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  expect(report.coverage).toMatchObject({ fetched: 1, failed: 1 });
  expect(report.coverage.gaps).toContain("1 source requests failed");
});
it("records a complete mediated fetch as fetched evidence", () => {
  const f = fixture();
  const url = "https://example.com/complete";
  expect(f.news.capture(f.fence, "web_fetch", { url }, mediated(url, 200, false))).toMatchObject({
    state: "fetched",
    addressClass: "public",
  });
  expect(f.news.sources(scope, f.run.runId).find((item) => item.originalUrl === url)?.failureReason).toBeUndefined();
});
it("accepts fetched sentence support and rejects unrelated claims or snippet citations", () => {
  const f = fixture();
  expect(f.news.select(scope, f.run.runId, f.selection, f.now).stories).toHaveLength(1);
  const unrelated = structuredClone(f.selection);
  unrelated.stories[0]!.claims[0]!.text = "Model One version 2 beats all benchmarks.";
  const rejected = f.news.select(scope, f.run.runId, unrelated, f.now);
  expect(rejected).toMatchObject({ rejected: 1, quiet: true, degraded: true });
  expect(rejected.coverage.gaps).toContain("1 proposed story lacked eligible fetched support");
  const snippets = f.news.capture(
    f.fence,
    "web_search",
    {},
    { sources: [{ url: "https://example.com/model", snippet: "Model One version 2 is now available." }] },
  ) as { sources: { sourceId: string }[] };
  unrelated.stories[0]!.claims[0] = { text: "Model One version 2 is now available.", sourceId: snippets.sources[0]!.sourceId };
  expect(f.news.select(scope, f.run.runId, unrelated, f.now).stories).toHaveLength(0);
});
it("masks a short credential fragment in a search snippet, and leaves a full-length key for the tool-output redaction to label", () => {
  const f = fixture();
  const snippet = "leaked sk-abc123def and Bearer abc12345 beside AKIAIOSFODNN7EXAMPLE";
  const result = f.news.capture(f.fence, "web_search", {}, { sources: [{ url: "https://example.com/leak", snippet }] }) as {
    sources: { excerpt: string }[];
  };
  expect(result.sources[0]!.excerpt).toBe("leaked [redacted] and Bearer [redacted] beside AKIAIOSFODNN7EXAMPLE");
  // The stored record is scrubbed whole.
  const stored = f.news.sources(scope, f.run.runId).find((source) => source.originalUrl === "https://example.com/leak");
  expect(stored?.excerpt).toBe("leaked [redacted] and Bearer [redacted] beside [redacted]");
});
it("records a granted plugin read's routineSources as fetched evidence, checked like search results, and lets anything else through unrecorded", () => {
  const f = fixture();
  const result = f.news.capture(
    f.fence,
    "trends.radar.sweep",
    { topicIds: ["t_1"] },
    {
      topics: [{ topicId: "t_1", state: "confirmed" }],
      routineSources: [
        {
          url: "https://example.com/model?utm_source=x",
          title: "Model One version 2",
          publishedAt: "2026-09-20T05:00:00Z",
          excerpt: "Model One version 2 is now available.",
        },
        { url: "https://elsewhere.example/a", title: "Off the allowlist", excerpt: "Not on this routine's hosts." },
        { url: "http://example.com/plain", title: "Not HTTPS", excerpt: "Plain HTTP." },
        { url: "https://second.com/empty", title: "No text", excerpt: "   " },
      ],
    },
    "plugin",
  ) as { topics: unknown[]; routineSources: { sourceId: string; url: string }[] };
  expect(result.topics).toEqual([{ topicId: "t_1", state: "confirmed" }]);
  expect(result.routineSources).toEqual([
    {
      sourceId: expect.stringMatching(/^source-/),
      url: "https://example.com/model",
      title: "Model One version 2",
      publishedAt: "2026-09-20T05:00:00.000Z",
      excerpt: "Model One version 2 is now available.",
    },
  ]);
  const recorded = f.news.sources(scope, f.run.runId).find((source) => source.sourceId === result.routineSources[0]?.sourceId);
  expect(recorded).toMatchObject({
    state: "fetched",
    adapter: "plugin:trends.radar.sweep",
    publisher: "example.com",
    excerpt: "Model One version 2 is now available.",
  });
  // A plugin read with no routineSources passes through, recording nothing.
  const before = f.news.sources(scope, f.run.runId).length;
  expect(f.news.capture(f.fence, "trends.radar.velocity", { topicId: "t_1" }, { series: [] }, "plugin")).toEqual({ series: [] });
  expect(f.news.sources(scope, f.run.runId)).toHaveLength(before);
  // A failed plugin read is a coverage gap; a plugin's own refusal passes through for the model to read; a tool the registry did not call a plugin read is still refused.
  expect(f.news.capture(f.fence, "trends.radar.sweep", {}, { ok: false }, "plugin")).toMatchObject({ sources: [] });
  expect(f.news.capture(f.fence, "trends.radar.brief", {}, { ok: false, problems: [{ bullet: 1, problem: "uncited" }] }, "plugin")).toEqual(
    { ok: false, problems: [{ bullet: 1, problem: "uncited" }] },
  );
  expect(() => f.news.capture(f.fence, "trends.radar.sweep", {}, { routineSources: [] })).toThrow(/Unsupported evidence adapter/);
});
it("counts one plugin read's sources as one voice, however many hosts it names, and says Tavi did not fetch them", () => {
  const f = fixture();
  const read = f.news.capture(
    f.fence,
    "trends.radar.sweep",
    {},
    {
      routineSources: [
        { url: "https://example.com/a", title: "A", publishedAt: "2026-09-20T05:00:00Z", excerpt: "Model One version 2 is now available." },
        {
          url: "https://second.com/b",
          title: "B",
          publishedAt: "2026-09-20T05:00:00Z",
          excerpt: "Model One version 2 is now available to everyone.",
        },
      ],
    },
    "plugin",
  ) as { routineSources: { sourceId: string }[] };
  const [first, second] = read.routineSources;
  const selection = structuredClone(f.selection);
  selection.stories[0]!.claims = [
    { text: "Model One version 2 is now available.", sourceId: first!.sourceId },
    { text: "Model One version 2 is now available to everyone.", sourceId: second!.sourceId },
  ];
  const report = f.news.select(scope, f.run.runId, selection, f.now);
  // Each claim quotes its excerpt word for word, and is accepted; the two hosts are one plugin's word, not two publishers'.
  expect(report.stories).toHaveLength(1);
  expect(report.stories[0]).toMatchObject({
    independentlyCorroborated: false,
    caveats: expect.arrayContaining([
      "Single-source or non-independent coverage",
      "Text from trends.radar.sweep is as the plugin reported it: Tavi did not fetch those pages",
    ]),
  });
});
it("selects a trends-v1 digest's topic stories without the release rule, titles it, renders it, and delivers trends-digest.pdf", async () => {
  const f = fixture("production", "trends-v1");
  // A topic's claims need not repeat its label, as a release's must.
  const selection = {
    stories: [
      {
        title: "Solid-state batteries",
        releaseIdentity: "Solid-state batteries",
        eventKind: "update",
        claims: f.selection.stories[0]!.claims,
      },
    ],
  };
  const report = f.news.select(scope, f.run.runId, selection, f.now);
  expect(report).toMatchObject({ title: "Trends digest", stories: [{ title: "Solid-state batteries" }] });
  // The plugin's template, as the revision carries it, gives the report its words.
  const template = trendsRoutineTemplate();
  const trends = { language: "en", sourceLinks: true, templateVersion: "trends-v1", template } as const;
  expect(renderRoutineNewsHtml(report, trends)).toContain("<title>Trends digest</title>");
  expect(renderRoutineNewsHtml(report, trends)).toContain("sources recorded.");
  // It is set in the print theme, with no colour or face of its own.
  const html = renderRoutineNewsHtml(report, trends);
  expect(html).toContain(printThemeCss("pt"));
  expect(html.replace(printThemeCss("pt"), "")).not.toMatch(/#[0-9a-f]{3,8}\b|Arial/i);
  expect(routineReportText({ ...report, quiet: true, stories: [] }, template)).toContain("No tracked topic spiked with verified sources.");
  // A template id with no template is refused, never rendered as news.
  expect(() => renderRoutineNewsHtml(report, { language: "en", sourceLinks: true, templateVersion: "x-v1" })).toThrow(/not available/);
  expect(() => renderRoutineNewsHtml(report, { ...trends, templateVersion: "other-v1" })).toThrow(/not available/);
  // The same selection under llm-releases-v1 is refused: its claims do not name the release.
  const news = fixture("production", "llm-releases-v1");
  expect(news.news.select(scope, news.run.runId, selection, news.now)).toMatchObject({ rejected: 1, stories: [] });
  const target = f.runs.routines.putTarget(scope, {
    ...scope,
    targetId: "target",
    connectionId: "tg",
    chatId: "123",
    label: "Test",
    authorizationRef: "fixture",
    enabled: true,
    createdAt: f.now,
  });
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.stage(f.fence, "pdf", Buffer.from("%PDF-fixture"));
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  const published = f.publication.publish(f.fence, report, state.version, f.delivery);
  f.delivery.enqueue(
    withTarget(f, [target.targetId], { format: "pdf" }),
    published.pdfArtifactId!,
    f.store.getArtifact(published.pdfArtifactId!)!.sha256,
    f.now,
  );
  const sent: unknown[] = [];
  const service = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, to) => ({ chatId: to.to }),
      send: async (message) => {
        sent.push(message.parts);
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "fixture-id" }] };
      },
    },
  });
  await service.drain();
  expect(sent).toEqual([[{ kind: "file", artifactId: published.pdfArtifactId, filename: "trends-digest.pdf" }]]);
});
it("refuses to save a revision naming a plugin's template it does not carry", () => {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true, artifactsDirectory: directories.create("routine-template-") });
  stores.push(store);
  const routines = new RoutineService(store, {
    executionAvailable: true,
    now: () => "2026-09-20T06:00:00.000Z",
    nextOccurrence: () => null,
  });
  const defaults = routineDefaults("Europe/Sofia");
  expect(() =>
    routines.create(
      scope,
      RoutineCreateSchema.parse({
        ...defaults,
        report: { ...defaults.report, templateVersion: "trends-v1" },
        operationKey: "create",
        name: "Trends",
        objective: "Track topics",
        agent: { agentId: "trends", name: "Trends", instructions: "Track" },
        triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
        skills: [],
        models: {
          research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
          synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
        },
        permissions: { revision: 1, researchTools: ["trends.radar.sweep"], allowedHosts: [], networkMode: "allowlist" },
      }),
    ),
  ).toThrow(/No routine template trends-v1 is installed/);
});
it("rolls publication and dedup back together after registration failure, then recovers staged bytes", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  const state = f.store.handle.prepare("SELECT * FROM tavi_routine_state").get() as { version: number };
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.store.handle.exec(
    "CREATE TRIGGER fail_artifact BEFORE INSERT ON tavi_artifacts BEGIN SELECT RAISE(ABORT, 'registration failure'); END",
  );
  expect(() => f.publication.publish(f.fence, report, state.version, f.delivery)).toThrow(/registration failure/);
  expect(f.publication.get(scope, f.run.runId)).toBeUndefined();
  expect(f.store.handle.prepare("SELECT * FROM tavi_routine_state").get()).toEqual(state);
  expect(f.publication.recoverStages()).toEqual({ removed: 0, damaged: 0 });
  f.store.handle.exec("DROP TRIGGER fail_artifact");
  const published = f.publication.publish(f.fence, report, state.version, f.delivery);
  expect(JSON.parse(f.store.readArtifactBody(published.reportArtifactId)!.toString())).toEqual(report);
  expect(f.runs.get(scope, f.run.runId).status).toBe("succeeded");
  // The run's history row carries the report's headline: its first story's title.
  expect(report.stories.length).toBeGreaterThan(0);
  expect(published.headline).toBe(report.stories[0]!.title);
  expect(f.runs.history(scope, f.run.routineId)[0]).toMatchObject({ runId: f.run.runId, headline: report.stories[0]!.title });
});
it("selects and publishes previews without changing production state and refuses mismatched JSON", () => {
  const f = fixture("preview");
  const before = f.store.handle.prepare("SELECT * FROM tavi_routine_state").get() as { version: number };
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  expect(f.store.handle.prepare("SELECT * FROM tavi_routine_state").get()).toEqual(before);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  expect(() => f.publication.publish(f.fence, { ...report, title: "changed" }, before.version, f.delivery)).toThrow(/does not match/);
  f.publication.publish(f.fence, report, before.version, f.delivery);
  expect(f.store.handle.prepare("SELECT * FROM tavi_routine_state").get()).toEqual(before);
  expect(f.delivery.list(scope, f.run.runId)).toEqual([]);
});
it("leaves a revision being evaluated inactive when a preview of it publishes a report with stories", () => {
  const f = fixture("preview", "news-v1", { evaluated: false });
  expect(f.routines.get(scope, f.run.routineId)).toMatchObject({ routine: { activeRevision: null }, evaluation: { status: "pending" } });
  const before = f.store.handle.prepare("SELECT * FROM tavi_routine_state").get() as { version: number };
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  expect(report.stories.length).toBeGreaterThan(0);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.publish(f.fence, report, before.version, f.delivery);
  expect(f.routines.get(scope, f.run.routineId)).toMatchObject({ routine: { activeRevision: null }, evaluation: { status: "pending" } });
});
it("leaves a revision being evaluated as it is when its preview finds nothing to report", () => {
  const f = fixture("preview", "news-v1", { evaluated: false });
  const before = f.store.handle.prepare("SELECT * FROM tavi_routine_state").get() as { version: number };
  const report = f.news.select(scope, f.run.runId, { stories: [] }, f.now);
  expect(report.stories).toEqual([]);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.publish(f.fence, report, before.version, f.delivery);
  expect(f.routines.get(scope, f.run.routineId)).toMatchObject({ routine: { activeRevision: null }, evaluation: { status: "pending" } });
});
it("defers to a real local window across DST and honors overnight windows", () => {
  const f = fixture();
  const deferred = {
    ...f.run,
    snapshot: { ...f.run.snapshot, delivery: { ...f.run.snapshot.delivery, outsideWindow: "next_window" as const } },
  };
  expect(routineDeliveryTime(deferred, "2026-10-24T22:00:00.000Z")).toBe("2026-10-25T05:00:00.000Z");
  expect(routineDeliveryTime(f.run, "2026-09-20T20:00:00.000Z")).toBeNull();
  const overnight = {
    ...deferred,
    snapshot: {
      ...deferred.snapshot,
      delivery: { ...deferred.snapshot.delivery, window: { start: "22:00", end: "06:00", timezone: "Europe/Sofia" } },
    },
  };
  expect(routineDeliveryTime(overnight, "2026-09-20T20:00:00.000Z")).toBe("2026-09-20T20:00:00.000Z");
});
it("recovers an uncertain send without blind retry and cancels pending delivery after publication", async () => {
  const f = fixture();
  const target = f.runs.routines.putTarget(scope, {
    ...scope,
    targetId: "telegram",
    connectionId: "tg",
    chatId: "123",
    label: "Test",
    authorizationRef: "fixture",
    enabled: true,
    createdAt: f.now,
  });
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.stage(f.fence, "pdf", Buffer.from("%PDF-fixture"));
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  const published = f.publication.publish(f.fence, report, state.version, f.delivery);
  f.delivery.enqueue(
    withTarget(f, [target.targetId]),
    published.pdfArtifactId!,
    f.store.getArtifact(published.pdfArtifactId!)!.sha256,
    f.now,
  );
  const job = f.delivery.list(scope, f.run.runId)[0]!;
  const outbox = f.store.asPort().repositories.messagingOutbox;
  outbox.begin({
    effectId: job.effectId,
    connectionId: "tg",
    message: {
      effectId: job.effectId,
      connectionId: "tg",
      workspaceId: scope.workspaceId,
      destination: { chatId: "123" },
      parts: [{ kind: "file", artifactId: published.pdfArtifactId! }],
    },
    now: () => f.now,
  });
  let calls = 0;
  const restarted = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        calls++;
        throw new Error("must not send");
      },
    },
  });
  await restarted.drain();
  await restarted.drain();
  expect(calls).toBe(0);
  expect(restarted.get(scope, job.jobId).status).toBe("uncertain");
  expect(() => restarted.resend(scope, job.jobId, "retry", false)).toThrow(/acknowledge/);
  outbox.resolve({
    effectId: job.effectId,
    outcome: { status: "uncertain", retryable: false, parts: [{ index: 0, status: "uncertain" }] },
    now: () => f.now,
  });
  const beforeHealth = f.store.handle.prepare("SELECT delivery_failures,state_json FROM tavi_routine_state").get();
  await restarted.drain();
  await restarted.drain();
  expect(f.store.handle.prepare("SELECT delivery_failures,state_json FROM tavi_routine_state").get()).toEqual(beforeHealth);
  for (let index = 0; index < 100; index++)
    f.store.handle
      .prepare(
        "INSERT INTO tavi_routine_delivery_jobs SELECT ?,run_id,?,'uncertain',not_before,expires_at,created_at,updated_at,data_json FROM tavi_routine_delivery_jobs WHERE job_id=?",
      )
      .run(`old-${index}`, `old-effect-${index}`, job.jobId);
  f.store.handle
    .prepare(
      "INSERT INTO tavi_routine_delivery_jobs SELECT 'new-send',run_id,'new-effect','pending',not_before,expires_at,created_at,updated_at,data_json FROM tavi_routine_delivery_jobs WHERE job_id=?",
    )
    .run(job.jobId);
  await restarted.drain();
  expect(calls).toBe(1);
  expect(restarted.get(scope, "new-send").status).toBe("failed");
  f.store.handle.prepare("UPDATE tavi_routine_delivery_jobs SET status='pending'").run();
  f.runs.cancel(scope, f.run.runId);
  expect(restarted.get(scope, job.jobId).status).toBe("cancelled");
});
it("suppresses an unchanged release, and keeps a material change inside one release identity visible", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.store.handle
    .prepare("UPDATE tavi_routine_state SET state_json=?")
    .run(canonicalRoutineJson({ dedup: [{ key: report.stories[0]!.dedupKey, at: f.now }] }));
  const source = f.news.capture(
    f.fence,
    "http.request",
    { url: "https://example.com/model" },
    {
      ok: true,
      body: '<meta content="2026-09-20T05:00:00Z" property="article:published_time"><p>Model One version 2 now supports tools.</p><p>Model One version 3 is now available.</p>',
    },
  ) as { sourceId: string };
  // The identical release and the identical material: suppressed, with the reason
  // recorded so an operator can see why the story was not published.
  const repeat = f.news.select(scope, f.run.runId, structuredClone(f.selection), f.now);
  expect(repeat.duplicates).toBe(1);
  expect(repeat.suppressions).toEqual([{ releaseIdentity: "Model One version 2", reason: expect.stringContaining("dedup window") }]);
  // The *same* release identity with different material — a version-2 page that now
  // says something it did not say before — is a new story, not a duplicate.
  const material = structuredClone(f.selection);
  material.stories[0]!.claims[0] = { text: "Model One version 2 now supports tools.", sourceId: source.sourceId };
  const edited = f.news.select(scope, f.run.runId, material, f.now);
  expect(edited.duplicates).toBe(0);
  expect(edited.stories[0]!.claims[0]!.text).toContain("now supports tools");
  // And a later version at the same URL is new too.
  const later = structuredClone(f.selection);
  later.stories[0]!.releaseIdentity = "Model One version 3";
  later.stories[0]!.claims[0] = { text: "Model One version 3 is now available.", sourceId: source.sourceId };
  expect(f.news.select(scope, f.run.runId, later, f.now).stories).toHaveLength(1);
});
it("expires retained excerpts and removes failed optional PDF stages without removing the local report", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.stage(f.fence, "pdf", Buffer.from("%PDF-fixture"));
  f.publication.discardOptionalPdf(f.fence);
  expect(f.store.handle.prepare("SELECT kind FROM tavi_routine_staging").all()).toEqual([{ kind: "json" }]);
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  expect(f.publication.publish(f.fence, report, state.version, f.delivery, "PDF unavailable").pdfArtifactId).toBeNull();
  expect(f.news.pruneEvidence("2027-09-20T06:00:00.000Z")).toBe(1);
  expect(f.news.sources(scope, f.run.runId)[0]!.excerpt).toBe("");
});
it("rejects unrelated and syndicated support under strict corroboration", () => {
  const f = fixture("production", "llm-releases-v1");
  f.store.handle
    .prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?")
    .run(canonicalRoutineJson({ ...f.run.snapshot, report: { ...f.run.snapshot.report, corroboration: "two_independent" } }), f.run.runId);
  const other = f.news.capture(
    f.fence,
    "http.request",
    { url: "https://second.com/article" },
    {
      ok: true,
      body: '<meta property="article:published_time" content="2026-09-20T05:00:00Z"><p>A completely unrelated product is available.</p>',
    },
  ) as { sourceId: string };
  const unrelated = structuredClone(f.selection);
  unrelated.stories[0]!.claims.push({ text: "A completely unrelated product is available.", sourceId: other.sourceId });
  expect(f.news.select(scope, f.run.runId, unrelated, f.now).stories).toHaveLength(0);
  f.store.handle.prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?").run(
    canonicalRoutineJson({
      ...f.run.snapshot,
      report: { ...f.run.snapshot.report, templateVersion: "news-v1", corroboration: "two_independent" },
    }),
    f.run.runId,
  );
  // A news-v1 claim need not name its story, but a page about something else still does not corroborate it.
  expect(f.news.select(scope, f.run.runId, unrelated, f.now).stories).toHaveLength(0);
  const copied = f.news.capture(
    f.fence,
    "http.request",
    { url: "https://second.com/copy" },
    {
      ok: true,
      body: '<meta property="article:published_time" content="2026-09-20T05:00:00Z"><h1>Different wrapper</h1><p>Model One version 2 is now available.</p>',
    },
  ) as { sourceId: string };
  const syndicated = structuredClone(f.selection);
  syndicated.stories[0]!.claims.push({ text: "Model One version 2 is now available.", sourceId: copied.sourceId });
  expect(f.news.select(scope, f.run.runId, syndicated, f.now).stories).toHaveLength(0);
});
it("pins a recovery window and preserves unresolved coverage beyond the recovery cap", () => {
  const f = fixture();
  f.store.handle.prepare("UPDATE tavi_routine_state SET state_json=?").run(
    canonicalRoutineJson({
      coverage: { to: "2026-09-18T06:00:00.000Z" },
      unresolvedCoverage: { from: "2026-09-15T06:00:00.000Z", to: "2026-09-19T06:00:00.000Z" },
    }),
  );
  const window = f.news.prepareWindow(f.fence);
  expect(window).toMatchObject({ from: "2026-09-17T06:00:00.000Z", hours: 72, gaps: [expect.stringContaining("exceeds")] });
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  expect(report.degraded).toBe(true);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  f.publication.publish(f.fence, report, state.version, f.delivery);
  const saved = JSON.parse(
    (f.store.handle.prepare("SELECT state_json FROM tavi_routine_state").get() as { state_json: string }).state_json,
  );
  expect(saved.coverage.to).toBe("2026-09-18T06:00:00.000Z");
  expect(saved.unresolvedCoverage.from).toBe("2026-09-15T06:00:00.000Z");
});
it("selects fetched expansion candidates only when the base window is empty", () => {
  const f = fixture();
  f.store.handle
    .prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?")
    .run(canonicalRoutineJson({ ...f.run.snapshot, report: { ...f.run.snapshot.report, onEmpty: "widen_lookback" } }), f.run.runId);
  const older = f.news.capture(
    f.fence,
    "http.request",
    { url: "https://example.com/older" },
    {
      ok: true,
      body: '<meta property="article:published_time" content="2026-09-18T05:00:00Z"><p>Model One version 2 is now available.</p>',
    },
  ) as { sourceId: string };
  const selection = structuredClone(f.selection);
  selection.stories[0]!.claims[0]!.sourceId = older.sourceId;
  const report = f.news.select(scope, f.run.runId, selection, f.now);
  expect(report.coverage.widened).toBe(true);
  expect(report.stories).toHaveLength(1);
});
it.each(["failures", "credentials"])("holds only the unhealthy delivery target and resumes without research: %s", async (reason) => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.stage(f.fence, "pdf", Buffer.from("%PDF-fixture"));
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  const published = f.publication.publish(f.fence, report, state.version, f.delivery);
  for (const id of ["broken", "healthy"]) {
    f.runs.routines.putTarget(scope, {
      ...scope,
      targetId: id,
      connectionId: "tg",
      chatId: id,
      label: id,
      authorizationRef: "fixture",
      enabled: true,
      createdAt: f.now,
    });
    f.delivery.enqueue(withTarget(f, [id]), published.pdfArtifactId!, f.store.getArtifact(published.pdfArtifactId!)!.sha256, f.now);
  }
  // This case exercises the delivery loop's multi-target path, which the
  // revision schema caps at one today. The grant mirrors whatever the
  // revision named, so it names both here; the health map is what holds one.
  pinDestinations(f, ["broken", "healthy"]);
  f.store.handle.prepare("UPDATE tavi_routine_state SET state_json=json_set(state_json,'$.deliveryHealth',json(?))").run(
    JSON.stringify({
      broken: {
        failures: reason === "failures" ? 3 : 0,
        blockedSince: reason === "credentials" ? "2026-09-16T06:00:00.000Z" : null,
        notified: false,
      },
    }),
  );
  let now = f.now;
  let sends = 0;
  let alerts = 0;
  // A target held on credentials is released once they work again, so they stay missing until it is resumed.
  let brokenReady = reason !== "credentials";
  const service = new DrainedDelivery(f.runs, {
    now: () => now,
    ready: (job) => job.data.targetId !== "broken" || brokenReady,
    onPaused: async () => {
      alerts++;
    },
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "fixture-id" }] };
      },
    },
  });
  await service.drain();
  expect(sends).toBe(1);
  expect(alerts).toBe(1);
  expect(service.list(scope, f.run.runId).find((job) => job.data.targetId === "broken")?.status).toBe("deferred");
  brokenReady = true;
  service.resumeTarget(scope, f.run.routineId, "broken");
  now = "2026-09-20T06:02:00.000Z";
  await service.drain();
  expect(sends).toBe(2);
  expect(f.runs.history(scope, f.run.routineId)).toHaveLength(1);
});
it.each(["revoke", "pause"])("rechecks %s after asynchronous delivery readiness", async (change) => {
  const f = fixture();
  const target = f.runs.routines.putTarget(scope, {
    ...scope,
    targetId: "target",
    connectionId: "tg",
    chatId: "123",
    label: "Test",
    authorizationRef: "fixture",
    enabled: true,
    createdAt: f.now,
  });
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.stage(f.fence, "pdf", Buffer.from("%PDF-fixture"));
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  const published = f.publication.publish(f.fence, report, state.version, f.delivery);
  f.delivery.enqueue(
    withTarget(f, [target.targetId]),
    published.pdfArtifactId!,
    f.store.getArtifact(published.pdfArtifactId!)!.sha256,
    f.now,
  );
  let sends = 0;
  const service = new DrainedDelivery(f.runs, {
    now: () => f.now,
    ready: async () => {
      await Promise.resolve();
      if (change === "revoke")
        f.store.handle
          .prepare("UPDATE tavi_routine_delivery_targets SET target_json=? WHERE target_id=?")
          .run(canonicalRoutineJson({ ...target, enabled: false }), target.targetId);
      else {
        const aggregate = f.runs.routines.get(scope, f.run.routineId).routine;
        f.runs.routines.setStatus(scope, f.run.routineId, aggregate.version, "paused");
      }
      return true;
    },
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        throw new Error("must not send");
      },
    },
  });
  await service.drain();
  expect(sends).toBe(0);
  expect(service.list(scope, f.run.runId)[0]!.status).toBe(change === "revoke" ? "failed" : "pending");
});
it("serves only retained run artifacts in bounded verified chunks and scopes timeline pages", async () => {
  const { RoutineControlService } = await import("../src/routines/control.js");
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  const bytes = Buffer.from(canonicalRoutineJson(report));
  f.publication.stage(f.fence, "json", bytes);
  const pdf = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(260000, 65)]);
  f.publication.stage(f.fence, "pdf", pdf);
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  const published = f.publication.publish(f.fence, report, state.version, f.delivery);
  const control = new RoutineControlService({
    routines: f.runs.routines,
    runs: f.runs,
    news: f.news,
    publication: f.publication,
    delivery: f.delivery,
    defaultModels: () => undefined,
    allowedHosts: [],
    wake: () => {},
  });
  const input = { ...scope, action: "artifact" as const, runId: f.run.runId, artifactKind: "pdf" as const };
  const reads = vi.spyOn(f.store, "readArtifactBody");
  const first = control.execute(input) as { base64: string; nextOffset: number };
  expect(Buffer.from(first.base64, "base64")).toEqual(pdf.subarray(0, 128 * 1024));
  const last = control.execute({ ...input, offset: first.nextOffset }) as { base64: string; nextOffset: number | null };
  expect(Buffer.concat([Buffer.from(first.base64, "base64"), Buffer.from(last.base64, "base64")])).toEqual(pdf);
  expect(last.nextOffset).toBeNull();
  expect(reads).toHaveBeenCalledTimes(1);
  expect(() => control.execute({ ...input, principalId: "other" })).toThrow(/scope/);
  expect(f.runs.ledger(scope, f.run.routineId, 0, 100, f.run.runId).every((event) => event.runId === f.run.runId)).toBe(true);
  f.store.handle.prepare("DELETE FROM tavi_routine_blob_refs WHERE artifact_id=?").run(published.pdfArtifactId);
  expect(() => control.execute(input)).toThrow(/expired/);
});
it("preserves shared references during pruning and recognizes intentionally expired artifacts", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  const published = f.publication.publish(f.fence, report, state.version, f.delivery);
  f.store.handle.prepare("UPDATE tavi_artifacts SET created_at='2020-01-01T00:00:00.000Z'").run();
  f.store.pruneArtifacts({ olderThan: "2030-01-01T00:00:00.000Z", dryRun: false });
  expect(f.store.getArtifact(published.reportArtifactId)).toBeDefined();
  const shared = f.runs.request(scope, f.run.routineId, "shared-reference", "preview");
  f.store.handle
    .prepare("INSERT INTO tavi_routine_blob_refs SELECT routine_id,?,artifact_id,hash,0 FROM tavi_routine_blob_refs WHERE run_id=?")
    .run(shared.runId, f.run.runId);
  f.store.handle.prepare("DELETE FROM tavi_routine_blob_refs WHERE run_id=?").run(f.run.runId);
  f.store.pruneArtifacts({ olderThan: "2030-01-01T00:00:00.000Z", dryRun: false });
  expect(f.store.getArtifact(published.reportArtifactId)).toBeDefined();
  f.store.handle.prepare("DELETE FROM tavi_routine_blob_refs").run();
  f.store.pruneArtifacts({ olderThan: "2030-01-01T00:00:00.000Z", dryRun: false });
  expect(f.store.getArtifact(published.reportArtifactId)).toBeUndefined();
  expect(f.publication.recoverStages()).toEqual({ removed: 1, damaged: 0 });
});
it("checks published reports by size at startup and lists them for a full hash check", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  const body = Buffer.from(canonicalRoutineJson(report));
  f.publication.stage(f.fence, "json", body);
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  const published = f.publication.publish(f.fence, report, state.version, f.delivery);
  const [listed, ...rest] = f.publication.publishedReports();
  expect(rest).toEqual([]);
  expect(listed).toMatchObject({
    routineId: f.run.routineId,
    runId: f.run.runId,
    artifactId: published.reportArtifactId,
    kind: "json",
    byteSize: body.byteLength,
    hash: createHash("sha256").update(body).digest("hex"),
  });
  expect(f.publication.recoverStages()).toEqual({ removed: 0, damaged: 0 });
  // Same size, different bytes: startup reads no report bytes, so this is left to doctor's hash check.
  const flipped = Buffer.from(body);
  flipped[0] = flipped[0]! ^ 1;
  writeFileSync(listed!.path, flipped);
  expect(f.publication.recoverStages()).toEqual({ removed: 0, damaged: 0 });
  writeFileSync(listed!.path, body.subarray(1));
  expect(f.publication.recoverStages()).toEqual({ removed: 0, damaged: 1 });
  rmSync(listed!.path);
  expect(f.publication.recoverStages()).toEqual({ removed: 0, damaged: 1 });
});
function deliveryFixture() {
  const f = fixture();
  const target = f.runs.routines.putTarget(scope, {
    ...scope,
    targetId: "receipt-chat",
    connectionId: "tg",
    chatId: "123",
    label: "Test chat",
    authorizationRef: "fixture",
    enabled: true,
    createdAt: f.now,
  });
  withTarget(f, [target.targetId], { allowResend: true });
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.stage(f.fence, "pdf", Buffer.from("%PDF-original-test"));
  const version = (f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number }).version;
  f.publication.publish(f.fence, report, version, f.delivery);
  return { ...f, job: f.delivery.list(scope, f.run.runId)[0]! };
}
it("times out uncertain, never blindly resends, and reconciles a late definitive receipt once", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T06:00:00.000Z"));
  const f = deliveryFixture();
  let sends = 0;
  const outbox = f.store.asPort().repositories.messagingOutbox;
  try {
    const delivery = new DrainedDelivery(f.runs, {
      now: () => f.now,
      messaging: {
        buildDestination: (_connectionId, target) => ({ chatId: target.to }),
        send: async (message) => {
          sends++;
          outbox.begin({ effectId: message.effectId!, connectionId: "tg", message, now: () => f.now });
          return new Promise(() => {});
        },
      },
    });
    const pending = delivery.drain();
    await vi.advanceTimersByTimeAsync(120_001);
    await pending;
    expect(delivery.get(scope, f.job.jobId).status).toBe("uncertain");
    await delivery.drain();
    expect(sends).toBe(1);
    outbox.resolve({
      effectId: f.job.effectId,
      outcome: { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "late-42" }] },
      now: () => f.now,
    });
    await delivery.drain();
    expect(delivery.get(scope, f.job.jobId)).toMatchObject({ status: "accepted", data: { providerMessageIds: ["late-42"] } });
    const events = f.runs.ledger(scope, f.run.routineId).length;
    await delivery.drain();
    expect(f.runs.ledger(scope, f.run.routineId)).toHaveLength(events);
    expect(sends).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
it("counts a timed-out send that a late receipt rejects as one failure, not two", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T06:00:00.000Z"));
  const f = deliveryFixture();
  const outbox = f.store.asPort().repositories.messagingOutbox;
  try {
    const delivery = new DrainedDelivery(f.runs, {
      now: () => f.now,
      messaging: {
        buildDestination: (_connectionId, target) => ({ chatId: target.to }),
        send: async (message) => {
          outbox.begin({ effectId: message.effectId!, connectionId: "tg", message, now: () => f.now });
          return new Promise(() => {});
        },
      },
    });
    const pending = delivery.drain();
    await vi.advanceTimersByTimeAsync(120_001);
    await pending;
    expect(delivery.get(scope, f.job.jobId).status).toBe("uncertain");
    const afterTimeout = f.store.handle.prepare("SELECT delivery_failures FROM tavi_routine_state").get() as { delivery_failures: number };
    expect(afterTimeout.delivery_failures).toBe(1);
    // The provider's definitive answer arrives late and it is a rejection: this is
    // the *same* failed send the timeout already charged, so terminalising it must
    // not move the counters again — otherwise two failed sends trip the threshold.
    outbox.resolve({
      effectId: f.job.effectId,
      outcome: { status: "rejected", retryable: false, parts: [{ index: 0, status: "rejected" }] },
      now: () => f.now,
    });
    await delivery.drain();
    expect(delivery.get(scope, f.job.jobId).status).toBe("failed");
    expect(f.store.handle.prepare("SELECT delivery_failures FROM tavi_routine_state").get()).toEqual(afterTimeout);
    const health = (
      JSON.parse((f.store.handle.prepare("SELECT state_json FROM tavi_routine_state").get() as { state_json: string }).state_json) as {
        deliveryHealth: Record<string, { failures: number }>;
      }
    ).deliveryHealth[f.job.data.targetId]!;
    expect(health.failures).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
/** A delivery fixture whose one target starts with `health`, drained on a clock the test moves. */
function pausedDelivery(health: { failures: number; blockedSince: string | null }, ready: () => boolean = () => true) {
  const f = deliveryFixture();
  f.store.handle
    .prepare("UPDATE tavi_routine_state SET state_json=json_set(state_json,'$.deliveryHealth',json(?))")
    .run(JSON.stringify({ [f.job.data.targetId]: { ...health, notified: false } }));
  const clock = { now: f.now };
  const told: { targetId: string; cause: string }[] = [];
  let sends = 0;
  const service = new DrainedDelivery(f.runs, {
    now: () => clock.now,
    ready: () => ready(),
    onPaused: async (_run, targetId, cause) => {
      told.push({ targetId, cause });
    },
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "fixture-id" }] };
      },
    },
  });
  const row = () =>
    f.store.handle.prepare("SELECT status,not_before,updated_at FROM tavi_routine_delivery_jobs WHERE job_id=?").get(f.job.jobId) as {
      status: string;
      not_before: string;
      updated_at: string;
    };
  return { ...f, clock, told, service, row, sends: () => sends };
}
it("tells a target paused on failures once, holds its job without rewriting it, and releases it when the routine is resumed", async () => {
  const f = pausedDelivery({ failures: 3, blockedSince: null });
  await f.service.drain();
  expect(f.told).toEqual([{ targetId: f.job.data.targetId, cause: "failures" }]);
  f.clock.now = "2026-09-20T06:05:00.000Z";
  await f.service.drain();
  // Told: the job now waits until it expires instead of coming back every few minutes.
  expect(f.told).toHaveLength(1);
  const held = f.row();
  expect(held).toMatchObject({ status: "deferred", not_before: f.job.expiresAt });
  f.clock.now = "2026-09-20T07:00:00.000Z";
  await f.service.drain();
  expect(f.row()).toEqual(held);
  expect(f.sends()).toBe(0);
  // Resuming the routine is how a person says the channel is fixed: before, the
  // target's health survived the resume and the job stayed held.
  const routine = f.runs.routines.get(scope, f.run.routineId).routine;
  f.runs.routines.setStatus(scope, f.run.routineId, routine.version, "active");
  await f.service.drain();
  expect(f.sends()).toBe(1);
  expect(f.delivery.get(scope, f.job.jobId).status).toBe("accepted");
});
it("releases a target paused on missing credentials as soon as they work again, checking every few minutes", async () => {
  let credentials = false;
  const f = pausedDelivery({ failures: 0, blockedSince: "2026-09-16T06:00:00.000Z" }, () => credentials);
  await f.service.drain();
  expect(f.told).toEqual([{ targetId: f.job.data.targetId, cause: "credential-grace" }]);
  f.clock.now = "2026-09-20T06:05:00.000Z";
  await f.service.drain();
  expect(f.row()).toMatchObject({ status: "deferred", not_before: "2026-09-20T06:10:00.000Z" });
  f.clock.now = "2026-09-20T06:08:00.000Z";
  await f.service.drain();
  expect(f.row().updated_at).toBe("2026-09-20T06:05:00.000Z");
  credentials = true;
  f.clock.now = "2026-09-20T06:10:00.000Z";
  await f.service.drain();
  expect(f.sends()).toBe(1);
  expect(f.told).toHaveLength(1);
  const health = (
    JSON.parse((f.store.handle.prepare("SELECT state_json FROM tavi_routine_state").get() as { state_json: string }).state_json) as {
      deliveryHealth: Record<string, { blockedSince: string | null }>;
    }
  ).deliveryHealth[f.job.data.targetId]!;
  expect(health.blockedSince).toBeNull();
});
it("keeps a delivery pause untold while its notice could not be told, and tells it on the job's next check", async () => {
  const f = pausedDelivery({ failures: 3, blockedSince: null });
  let told = 0;
  const service = new DrainedDelivery(f.runs, {
    now: () => f.clock.now,
    onPaused: async () => ++told > 1,
    messaging: f.service.options.messaging,
  });
  await service.drain();
  f.clock.now = "2026-09-20T06:04:00.000Z";
  await service.drain();
  expect(told).toBe(1);
  f.clock.now = "2026-09-20T06:05:00.000Z";
  await service.drain();
  expect(told).toBe(2);
  f.clock.now = "2026-09-20T06:10:00.000Z";
  await service.drain();
  expect(told).toBe(2);
  expect(f.row().not_before).toBe(f.job.expiresAt);
});
it("releases a paused target when a new revision changes the routine's delivery targets", async () => {
  const f = pausedDelivery({ failures: 3, blockedSince: null });
  await f.service.drain();
  f.clock.now = "2026-09-20T06:05:00.000Z";
  await f.service.drain();
  expect(f.row().not_before).toBe(f.job.expiresAt);
  const current = f.runs.routines.get(scope, f.run.routineId);
  f.runs.routines.update(scope, {
    routineId: f.run.routineId,
    expectedVersion: current.routine.version,
    operationKey: "new-targets",
    changeSummary: "Deliver to the test chat",
    snapshot: {
      ...current.revision.snapshot,
      report: { ...current.revision.snapshot.report, formats: [...current.revision.snapshot.report.formats, "pdf"] },
      delivery: { ...current.revision.snapshot.delivery, targetIds: [f.job.data.targetId] },
    },
  });
  f.runs.routines.finishEvaluation(scope, f.run.routineId, 2, true, "pass");
  const state = JSON.parse(
    (f.store.handle.prepare("SELECT state_json FROM tavi_routine_state").get() as { state_json: string }).state_json,
  ) as {
    deliveryHealth?: unknown;
  };
  expect(state.deliveryHealth).toBeUndefined();
  expect(f.row().not_before).toBe(f.now);
});
it("keeps a paused target's health when a new revision keeps the same delivery targets", async () => {
  const f = pausedDelivery({ failures: 3, blockedSince: null });
  await f.service.drain();
  f.clock.now = "2026-09-20T06:05:00.000Z";
  await f.service.drain();
  const current = f.runs.routines.get(scope, f.run.routineId);
  f.runs.routines.update(scope, {
    routineId: f.run.routineId,
    expectedVersion: current.routine.version,
    operationKey: "same-targets",
    changeSummary: "New objective",
    snapshot: { ...current.revision.snapshot, objective: "Find more news" },
  });
  f.runs.routines.finishEvaluation(scope, f.run.routineId, 2, true, "pass");
  const state = JSON.parse(
    (f.store.handle.prepare("SELECT state_json FROM tavi_routine_state").get() as { state_json: string }).state_json,
  ) as {
    deliveryHealth: Record<string, { failures: number }>;
  };
  expect(state.deliveryHealth[f.job.data.targetId]?.failures).toBe(3);
  expect(f.row().not_before).toBe(f.job.expiresAt);
});
it("expires a deferred job without sending and explicitly resends the original artifact without model work", async () => {
  const f = deliveryFixture();
  let sends = 0;
  const modelCalls = f.runs.get(scope, f.run.runId).data.modelCalls;
  f.store.handle
    .prepare("UPDATE tavi_routine_delivery_jobs SET status='deferred',not_before='2030-01-01T00:00:00.000Z',expires_at=? WHERE job_id=?")
    .run("2026-09-20T05:59:00.000Z", f.job.jobId);
  const delivery = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async (message) => {
        sends++;
        expect(message.destination).toMatchObject({ chatId: f.job.data.target.chatId });
        expect(message.parts[0]).toMatchObject({ kind: "file", artifactId: f.job.data.artifactId });
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "resent-42" }] };
      },
    },
  });
  await delivery.drain();
  expect(delivery.get(scope, f.job.jobId).status).toBe("expired");
  expect(sends).toBe(0);
  const resent = delivery.resend(scope, f.job.jobId, "explicit-resend", true);
  expect(resent.effectId).not.toBe(f.job.effectId);
  expect(resent.data).toMatchObject({
    artifactId: f.job.data.artifactId,
    hash: f.job.data.hash,
    target: f.job.data.target,
    resendOf: f.job.jobId,
  });
  expect(delivery.resend(scope, f.job.jobId, "explicit-resend", true).jobId).toBe(resent.jobId);
  await delivery.drain();
  expect(delivery.get(scope, resent.jobId).status).toBe("accepted");
  expect(sends).toBe(1);
  expect(f.runs.get(scope, f.run.runId).data.modelCalls).toBe(modelCalls);
});
it("rechecks delivery expiry after asynchronous readiness", async () => {
  const f = deliveryFixture();
  let now = f.now;
  let sends = 0;
  f.store.handle
    .prepare("UPDATE tavi_routine_delivery_jobs SET not_before=?,expires_at=? WHERE job_id=?")
    .run(now, "2026-09-20T06:01:00.000Z", f.job.jobId);
  const delivery = new DrainedDelivery(f.runs, {
    now: () => now,
    ready: async () => {
      now = "2026-09-20T06:02:00.000Z";
      return true;
    },
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        throw new Error("expired send");
      },
    },
  });
  await delivery.drain();
  expect(sends).toBe(0);
  expect(delivery.get(scope, f.job.jobId).status).toBe("expired");
});
it("does not let a full page of paused deliveries starve an active routine", async () => {
  const f = deliveryFixture();
  let sends = 0;
  f.store.handle.prepare("UPDATE tavi_routine_delivery_jobs SET not_before=?,expires_at=?").run(f.now, "2026-09-21T06:00:00.000Z");
  f.store.handle.exec(
    "INSERT INTO tavi_routines SELECT 'paused-routine',workspace_id,principal_id,name,version,active_revision,latest_revision,'paused',conversation_id,created_at,updated_at FROM tavi_routines LIMIT 1",
  );
  // Named columns: a positional `SELECT` list silently shifts meaning when the
  // table gains a column, which is exactly what `grant_id` did.
  f.store.handle.exec(
    "INSERT INTO tavi_routine_runs (run_id,routine_id,workspace_id,principal_id,occurrence_key,trigger_id,revision,snapshot_json,mode,status,generation,task_id,scheduled_for,claimed_at,started_at,ended_at,data_json,grant_id) SELECT 'paused-run','paused-routine',workspace_id,principal_id,occurrence_key,trigger_id,revision,snapshot_json,mode,status,generation,task_id,scheduled_for,claimed_at,started_at,ended_at,data_json,grant_id FROM tavi_routine_runs LIMIT 1",
  );
  for (let index = 0; index < 100; index++)
    f.store.handle
      .prepare(
        "INSERT INTO tavi_routine_delivery_jobs SELECT ?, 'paused-run', ?, 'pending', '2026-09-20T05:00:00.000Z',expires_at,created_at,updated_at,data_json FROM tavi_routine_delivery_jobs WHERE job_id=?",
      )
      .run(`held-${index}`, `held-effect-${index}`, f.job.jobId);
  const delivery = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "fixture" }] };
      },
    },
  });
  await delivery.drain();
  expect(sends).toBe(1);
  expect(delivery.get(scope, f.job.jobId).status).toBe("accepted");
  expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_delivery_jobs WHERE status='pending'").get()).toEqual({ n: 100 });
});
it.each(["pending", "uncertain"])("releases cancelled %s delivery pins only when no unresolved send remains", (status) => {
  const f = deliveryFixture();
  f.store.handle.prepare("UPDATE tavi_routine_delivery_jobs SET status=?").run(status);
  f.runs.cancel(scope, f.run.runId);
  expect(f.delivery.get(scope, f.job.jobId).status).toBe(status === "pending" ? "cancelled" : "uncertain");
  expect(f.store.handle.prepare("SELECT pinned FROM tavi_routine_blob_refs WHERE artifact_id=?").get(f.job.data.artifactId)).toEqual({
    pinned: status === "pending" ? 0 : 1,
  });
});
it.each(["web_search", "http.request"])("records thrown %s failures as incomplete coverage without retaining error secrets", async (id) => {
  const f = fixture();
  const registry = new ToolRegistry();
  registry.register({
    id,
    ...(id === "web_search" ? { sink: "search" as const } : { sink: "network" as const, urlOnly: false }),
    version: "1.0.0",
    description: "Fixture",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.strictObject({ url: z.string().optional() }),
    handler: async () => {
      throw new Error("private provider token");
    },
  });
  const tools = routineResearchTools(registry, asyncRoutineEffects(f.runs), f.run, f.fence, (tool, input, output) =>
    f.news.capture(f.fence, tool, input, output),
  );
  await expect(
    tools.get(id)!.handler({
      input: id === "http.request" ? { url: "https://example.com/failed" } : {},
      context: { ...scope, caller: "routine", runId: f.run.runId },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("private provider token");
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  expect(report).toMatchObject({ degraded: true, coverage: { failed: 1, searched: 0 } });
  expect(report.stories).toHaveLength(1);
  expect(JSON.stringify(f.news.sources(scope, f.run.runId))).not.toContain("private provider token");
});
it("does not treat a modification date as complete publication-date coverage on a quiet day", () => {
  const f = fixture();
  f.news.capture(
    f.fence,
    "http.request",
    { url: "https://example.com/modified-only" },
    {
      ok: true,
      body: '<meta property="article:modified_time" content="2026-09-20T05:00:00Z"><p>Model Two version 2 is now available.</p>',
    },
  );
  const report = f.news.select(scope, f.run.runId, { stories: [] }, f.now);
  expect(report).toMatchObject({
    quiet: true,
    degraded: true,
    coverage: { gaps: ["Some fetched pages have no verifiable publication date"] },
  });
});

it("refuses dispatch when the run's grant no longer lists the destination", async () => {
  const f = deliveryFixture();
  let sends = 0;
  pinDestinations(f, []);
  const delivery = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        throw new Error("must not send");
      },
    },
  });
  await delivery.drain();
  expect(sends).toBe(0);
  expect(delivery.get(scope, f.job.jobId).status).toBe("failed");
  expect(f.runs.ledger(scope, f.run.routineId).some((event) => event.envelope.denial === "destination-outside-grant")).toBe(true);
});

it("refuses dispatch when the run's grant is revoked before the send", async () => {
  const f = deliveryFixture();
  let sends = 0;
  f.runs.revokeGrant(scope, f.run.runId, "operator revoked");
  const delivery = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        throw new Error("must not send");
      },
    },
  });
  await delivery.drain();
  expect(sends).toBe(0);
  expect(delivery.get(scope, f.job.jobId).status).toBe("failed");
});

it.each(["before-flush", "after-flush", "before-rename", "after-rename", "before-commit"] as const)(
  "a crash at the %s publication boundary never commits a row without its bytes",
  async (boundary) => {
    const f = fixture();
    const report = f.news.select(scope, f.run.runId, f.selection, f.now);
    f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
    const version = (f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number }).version;
    let clock = f.now;
    const crashed = new RoutinePublicationService(f.runs, {
      now: () => clock,
      failAt: (point) => {
        if (point === boundary) throw new Error(`crash at ${boundary}`);
      },
    });
    expect(() => crashed.publish(f.fence, report, version, f.delivery)).toThrow(boundary);
    // No committed row, so nothing can be downloaded or delivered.
    expect(crashed.get(scope, f.run.runId)).toBeUndefined();
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_artifacts WHERE run_id=?").get(f.run.taskId)).toEqual({ n: 0 });
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_blob_refs WHERE run_id=?").get(f.run.runId)).toEqual({ n: 0 });
    // A still-running run keeps its staging intent: recovery is not a race with a
    // write that may still be completing.
    expect(crashed.recoverStages()).toEqual({ removed: 0, damaged: 0 });
    f.runs.finish(f.fence, "failed");
    // Past the grace period: a stage that looks unreferenced is only collected once
    // a write that created it could no longer be in flight.
    clock = "2026-09-20T08:00:00.000Z";
    expect(crashed.recoverStages().removed).toBeGreaterThan(0);
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_staging WHERE run_id=?").get(f.run.runId)).toEqual({ n: 0 });
  },
);

it("refuses to deliver a report whose bytes no longer match the publication manifest", async () => {
  const f = deliveryFixture();
  let sends = 0;
  const artifactId = f.publication.get(scope, f.run.runId)!.pdfArtifactId!;
  f.store.handle.prepare("UPDATE tavi_artifacts SET sha256=? WHERE artifact_id=?").run("0".repeat(64), artifactId);
  const delivery = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        throw new Error("must not send");
      },
    },
  });
  await delivery.drain();
  expect(sends).toBe(0);
  expect(delivery.get(scope, f.job.jobId)).toMatchObject({ status: "failed", data: { error: "artifact_unavailable" } });
});

it("refuses to deliver a report whose file changed in place at the same size", async () => {
  const f = deliveryFixture();
  let sends = 0;
  const artifact = f.store.getArtifact(f.publication.get(scope, f.run.runId)!.pdfArtifactId!)!;
  const path = f.store.resolveArtifactPath(artifact.relativePath);
  const bytes = readFileSync(path);
  bytes[0] = bytes[0]! ^ 1;
  writeFileSync(path, bytes);
  expect(f.publication.recoverStages()).toEqual({ removed: 0, damaged: 0 });
  const delivery = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        throw new Error("must not send");
      },
    },
  });
  await delivery.drain();
  expect(sends).toBe(0);
  expect(delivery.get(scope, f.job.jobId)).toMatchObject({ status: "failed", data: { error: "artifact_unavailable" } });
});
it("reports a pruned artifact as artifact_unavailable rather than a generic failure", async () => {
  const f = deliveryFixture();
  let sends = 0;
  f.store.handle.prepare("DELETE FROM tavi_routine_blob_refs WHERE run_id=?").run(f.run.runId);
  const delivery = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        throw new Error("must not send");
      },
    },
  });
  await delivery.drain();
  expect(sends).toBe(0);
  expect(delivery.get(scope, f.job.jobId)).toMatchObject({ status: "failed", data: { error: "artifact_unavailable" } });
});

it("keeps a JSON-only publication unaffected by the durability protocol", async () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  const version = (f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number }).version;
  const published = f.publication.publish(f.fence, report, version, f.delivery);
  expect(published).toMatchObject({ pdfArtifactId: null });
  expect(f.store.readArtifactBody(published.reportArtifactId)!.toString()).toBe(canonicalRoutineJson(report));
  expect(
    f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_staging WHERE run_id=? AND status<>'published'").get(f.run.runId),
  ).toEqual({ n: 0 });
});

it("takes the first coverage window's start from the documented fallback, not from a null instant", () => {
  const f = fixture();
  // A fresh routine's state is `coverage: { to: null }`; the first window starts
  // from the run's lookback, not from a parse of `null`.
  const state = JSON.parse(
    (f.store.handle.prepare("SELECT state_json FROM tavi_routine_state WHERE routine_id=?").get(f.run.routineId) as { state_json: string })
      .state_json,
  ) as { coverage: { to: string | null }; pruning?: unknown };
  expect(state).toEqual({ dedup: [], coverage: { to: null } });
  expect(state.pruning).toBeUndefined();
  const window = f.news.window(scope, f.run.runId, f.now);
  expect(window).toMatchObject({ to: f.now, hours: f.run.snapshot.report.lookbackHours, gaps: [] });
  expect(window.from).toBe(new Date(Date.parse(f.now) - f.run.snapshot.report.lookbackHours * 3_600_000).toISOString());
  // A covered instant is preferred *only* when it reaches further back than the
  // base window: the base window is what a routine admits, and widening is the
  // explicit exception.
  f.store.handle
    .prepare("UPDATE tavi_routine_state SET state_json=? WHERE routine_id=?")
    .run(JSON.stringify({ dedup: [], coverage: { to: "2026-09-20T04:00:00.000Z" } }), f.run.routineId);
  expect(f.news.window(scope, f.run.runId, f.now).from).toBe(window.from);
  // Coverage older than the base window *does* move the start, which is the
  // documented recovery branch.
  f.store.handle
    .prepare("UPDATE tavi_routine_state SET state_json=? WHERE routine_id=?")
    .run(JSON.stringify({ dedup: [], coverage: { to: "2026-09-18T06:00:00.000Z" } }), f.run.routineId);
  expect(f.news.window(scope, f.run.runId, f.now).from).toBe("2026-09-18T05:00:00.000Z");
});

it("honors the report's render policy instead of hardcoding it", async () => {
  const { renderRoutineNewsHtml } = await import("@tavi/runtime");
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  const withLinks = renderRoutineNewsHtml(report, { language: "en", sourceLinks: true, templateVersion: "news-v1" });
  const withoutLinks = renderRoutineNewsHtml(report, { language: "de", sourceLinks: false, templateVersion: "news-v1" });
  expect(withLinks).toContain('<html lang="en">');
  expect(withoutLinks).toContain('<html lang="de">');
  expect(withLinks).toContain('<a href="https://example.com/model"');
  expect(withoutLinks).not.toContain("<a href=");
  expect(() => renderRoutineNewsHtml(report, { language: "en", sourceLinks: true, templateVersion: "news-v2" })).toThrow(/not available/);
});

it("reclaims eligible old artifacts before staging, and says so when every byte is protected", async () => {
  const f = fixture();
  // A budget that fits exactly one report plus a little: the second publication
  // must reclaim the first, or it can never be staged at all.
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  const bytes = Buffer.from(canonicalRoutineJson(report));
  const snapshot = { ...f.run.snapshot, retention: { ...f.run.snapshot.retention, artifactBytes: bytes.byteLength + 16 } };
  f.store.handle.prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?").run(canonicalRoutineJson(snapshot), f.run.runId);
  const first = f.publication.stage(f.fence, "json", bytes);
  expect(first).toBeTruthy();
  const version = (f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number }).version;
  f.publication.publish(f.fence, report, version, f.delivery);
  const reclaimed = f.publication.reclaimForCapacity(f.runs.get(scope, f.run.runId), 1);
  // The newest publication is protected: an operator would open it.
  expect(reclaimed).toEqual({ artifacts: 0, freedBytes: 0 });
  // Once a *newer* publication exists, the older bytes become eligible.
  const second = f.runs.request(scope, f.run.routineId, "second");
  // The admitted retention policy travels with the run's snapshot, so the second
  // run has to carry the same budget for this to be the same situation.
  f.store.handle.prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?").run(canonicalRoutineJson(snapshot), second.runId);
  const secondFence = f.runs.start(scope, second.runId)!;
  const secondRun = f.runs.get(scope, second.runId);
  const next = { ...report, runId: second.runId, revision: secondRun.revision };
  const nextBytes = Buffer.from(canonicalRoutineJson(next));
  expect(() => f.publication.stage(secondFence, "json", nextBytes)).toThrow(/retention budget exhausted/);
  const forced = f.publication.reclaimForCapacity(secondRun, nextBytes.byteLength);
  expect(forced.artifacts).toBe(0);
  // The refusal is actionable: it names what is needed, held, protected and the
  // budget, so an operator can decide instead of retrying blindly.
  try {
    f.publication.stage(secondFence, "json", nextBytes);
    throw new Error("expected refusal");
  } catch (error) {
    expect((error as { details?: Record<string, unknown> }).details).toMatchObject({
      reason: "capacity-blocked",
      budgetBytes: snapshot.retention.artifactBytes,
    });
  }
  f.runs.cancel(scope, secondRun.runId);
});

it("reclaims the oldest unprotected artifact when a newer publication exists", async () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  const size = Buffer.from(canonicalRoutineJson({ ...report, runId: f.run.runId, revision: f.run.revision })).byteLength;
  const published: string[] = [];
  for (const operationKey of ["a", "b", "c"]) {
    const run = operationKey === "a" ? f.run : f.runs.request(scope, f.run.routineId, operationKey);
    const fence = operationKey === "a" ? f.fence : f.runs.start(scope, run.runId)!;
    const scoped = { ...report, runId: run.runId, revision: f.runs.get(scope, run.runId).revision };
    f.publication.stage(fence, "json", Buffer.from(canonicalRoutineJson(scoped)));
    const version = (f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number }).version;
    f.publication.publish(fence, scoped, version, f.delivery);
    published.push(run.runId);
  }
  expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_blob_refs").get()).toEqual({ n: 3 });
  // A budget that fits two reports: the oldest two must give up their bytes for
  // the fourth, and the newest must keep them.
  const fourth = f.runs.request(scope, f.run.routineId, "d");
  const tightened = { ...f.run.snapshot, retention: { ...f.run.snapshot.retention, artifactBytes: size * 2 + 400 } };
  f.store.handle.prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?").run(canonicalRoutineJson(tightened), fourth.runId);
  const fence = f.runs.start(scope, fourth.runId)!;
  const scoped = { ...report, runId: fourth.runId, revision: f.runs.get(scope, fourth.runId).revision };
  f.publication.stage(fence, "json", Buffer.from(canonicalRoutineJson(scoped)));
  // Exactly one publication keeps its bytes — the newest — and the other two gave
  // theirs up. Which UUID that is depends on the tiebreak, since the fixture's
  // clock is fixed; that the count is right is the property under test.
  const survivors = f.store.handle.prepare("SELECT run_id FROM tavi_routine_blob_refs").all() as { run_id: string }[];
  expect(survivors).toHaveLength(1);
  expect(published).toContain(survivors[0]!.run_id);
  expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_staging WHERE status='reclaimed'").get()).toEqual({ n: 2 });
  expect(
    f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_staging WHERE run_id=? AND status='ready'").get(fourth.runId),
  ).toEqual({ n: 1 });
  f.runs.cancel(scope, fourth.runId);
});

it("reclaims an older publication of the other mode while keeping the newest of each", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  const size = Buffer.from(canonicalRoutineJson(report)).byteLength;
  // The fixture's clock is fixed, so `ended_at` is stamped explicitly after each
  // publication: which report is the newest of its mode has to be a property of
  // the fixture rather than of a UUID tiebreak.
  const publish = (runId: string, fence: RoutineFence, mode: "production" | "preview", endedAt: string): void => {
    const scoped = { ...report, runId, revision: f.runs.get(scope, runId).revision, mode };
    f.publication.stage(fence, "json", Buffer.from(canonicalRoutineJson(scoped)));
    const version = (f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number }).version;
    f.publication.publish(fence, scoped, version, f.delivery);
    f.store.handle.prepare("UPDATE tavi_routine_runs SET ended_at=? WHERE run_id=?").run(endedAt, runId);
  };
  publish(f.run.runId, f.fence, "production", "2026-09-20T06:00:00.000Z");
  const older = f.runs.request(scope, f.run.routineId, "preview-older", "preview");
  publish(older.runId, f.runs.start(scope, older.runId)!, "preview", "2026-09-20T07:00:00.000Z");
  const newest = f.runs.request(scope, f.run.routineId, "preview-newest", "preview");
  publish(newest.runId, f.runs.start(scope, newest.runId)!, "preview", "2026-09-20T08:00:00.000Z");
  // One budget covers all modes, so three retained reports leave a fourth with
  // room for exactly one more: the production stage below can only proceed by
  // reclaiming the older *preview* publication, because the newest of each mode is
  // what an operator would open and the byte budget is shared rather than per-mode.
  const fourth = f.runs.request(scope, f.run.routineId, "capacity", "production");
  const tightened = { ...f.run.snapshot, retention: { ...f.run.snapshot.retention, artifactBytes: size * 3 + 400 } };
  f.store.handle.prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?").run(canonicalRoutineJson(tightened), fourth.runId);
  const fence = f.runs.start(scope, fourth.runId)!;
  f.publication.stage(
    fence,
    "json",
    Buffer.from(canonicalRoutineJson({ ...report, runId: fourth.runId, revision: f.runs.get(scope, fourth.runId).revision })),
  );
  const survivors = (f.store.handle.prepare("SELECT run_id FROM tavi_routine_blob_refs").all() as { run_id: string }[])
    .map((row) => row.run_id)
    .sort();
  expect(survivors).toEqual([f.run.runId, newest.runId].sort());
  expect(f.store.handle.prepare("SELECT status FROM tavi_routine_staging WHERE run_id=?").get(older.runId)).toEqual({
    status: "reclaimed",
  });
  expect(f.store.handle.prepare("SELECT status FROM tavi_routine_staging WHERE run_id=?").get(fourth.runId)).toEqual({ status: "ready" });
  f.runs.cancel(scope, fourth.runId);
});

it("delivers a report with no PDF as text, rather than delivering nothing", async () => {
  const f = fixture();
  const target = f.runs.routines.putTarget(scope, {
    ...scope,
    targetId: "telegram",
    connectionId: "tg",
    chatId: "123",
    label: "Test",
    authorizationRef: "fixture",
    enabled: true,
    createdAt: f.now,
  });
  pinDestinations(f, [target.targetId], { targetIds: [target.targetId] });
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  // The PDF could not be rendered: publication carries on without it.
  const published = f.publication.publish(f.fence, report, state.version, f.delivery, "renderer unavailable");
  expect(published.pdfArtifactId).toBeNull();
  const job = f.delivery.list(scope, f.run.runId)[0]!;
  expect(job.data.artifactId).toBe(published.reportArtifactId);
  expect(job.data.text).toContain("Model One version 2 is now available.");
  const sent: unknown[] = [];
  const delivery = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async (message) => {
        sent.push(message.parts);
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "m1" }] } as never;
      },
    },
  });
  await delivery.drain();
  expect(sent).toEqual([[{ kind: "text", content: job.data.text }]]);
});

it("writes a report as text: title, stories, their HTTPS sources, cut at a story boundary past its limit", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  const text = routineReportText(report);
  expect(text.startsWith(`${report.title} — ${report.coverage.to.slice(0, 10)}`)).toBe(true);
  expect(text).toContain(`• ${report.stories[0]!.title}`);
  expect(text).toContain("(example.com: https://example.com/model)");
  expect(routineReportText({ ...report, quiet: true, stories: [] })).toContain("No qualifying news verified.");
  const many = {
    ...report,
    stories: Array.from({ length: 200 }, (_, index) => ({
      ...report.stories[0]!,
      storyId: `s${index}`,
      title: `Release ${index} ${"x".repeat(80)}`,
    })),
  };
  const cut = routineReportText(many);
  expect(cut.length).toBeLessThanOrEqual(REPORT_TEXT_LIMIT);
  expect(cut).toMatch(/…and \d+ more in the report\.$/);
});

it("charges a render to the render step, not to synthesis's budget", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.stage(f.fence, "pdf", Buffer.from("%PDF-fixture"));
  // Synthesis began ten minutes ago (its budget is two); the render began now.
  f.store.handle
    .prepare(
      "UPDATE tavi_routine_runs SET data_json=json_set(data_json,'$.stepStarted.synthesis',?,'$.stepStarted.render',?) WHERE run_id=?",
    )
    .run("2026-09-20T05:50:00.000Z", f.now, f.run.runId);
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  expect(f.publication.publish(f.fence, report, state.version, f.delivery).pdfArtifactId).not.toBeNull();
});
it("does not send, and settles the job, when the target's connection cannot build a destination", async () => {
  const f = deliveryFixture();
  let sends = 0;
  const delivery = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: () => undefined,
      send: async () => {
        sends++;
        throw new Error("must not send");
      },
    },
  });
  await delivery.drain();
  expect(sends).toBe(0);
  expect(delivery.get(scope, f.job.jobId).status).not.toBe("accepted");
  expect(delivery.get(scope, f.job.jobId).status).not.toBe("pending");
});

/** Publishes `report` with a PDF and delivers it to a target, returning what the channel was sent. */
async function deliverPdf(f: ReturnType<typeof fixture>, report: ReturnType<RoutineNewsService["select"]>): Promise<unknown[]> {
  const target = f.runs.routines.putTarget(scope, {
    ...scope,
    targetId: "target",
    connectionId: "tg",
    chatId: "123",
    label: "Test",
    authorizationRef: "fixture",
    enabled: true,
    createdAt: f.now,
  });
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.stage(f.fence, "pdf", Buffer.from("%PDF-fixture"));
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  const published = f.publication.publish(f.fence, report, state.version, f.delivery);
  f.delivery.enqueue(
    withTarget(f, [target.targetId], { format: "pdf" }),
    published.pdfArtifactId!,
    f.store.getArtifact(published.pdfArtifactId!)!.sha256,
    f.now,
  );
  const sent: unknown[] = [];
  const service = new DrainedDelivery(f.runs, {
    now: () => f.now,
    messaging: {
      buildDestination: (_connectionId, to) => ({ chatId: to.to }),
      send: async (message) => {
        sent.push(...message.parts);
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "fixture-id" }] };
      },
    },
  });
  await service.drain();
  return sent;
}
const routineState = (f: ReturnType<typeof fixture>) =>
  JSON.parse((f.store.handle.prepare("SELECT state_json FROM tavi_routine_state").get() as { state_json: string }).state_json) as {
    clustering?: { threshold: number | null };
  };
const BATTERY_PAGE =
  '<meta property="article:published_time" content="2026-09-20T05:00:00Z"><p>QuantumScape Corp. and the U.S. Dept. of Energy said Dr. J. Smith will lead the Jan. 5 pilot vs. two rivals. The cells passed 1,000 charge cycles.</p>';
const batterySelection = (sourceId: string) => ({
  stories: [
    {
      title: "Solid-state pilot line",
      releaseIdentity: "QuantumScape pilot",
      eventKind: "update",
      claims: [
        { text: "QuantumScape Corp. and the U.S. Dept. of Energy said Dr. J. Smith will lead the Jan. 5 pilot vs. two rivals.", sourceId },
        { text: "The cells passed 1,000 charge cycles.", sourceId },
      ],
    },
  ],
});

it("reports a news-v1 routine on its own objective: titled and filed by its name, its stories by their titles, quotes whole across abbreviations", async () => {
  const f = fixture("production", "news-v1", {
    name: "Battery Watch: Solid-State",
    objective: "Solid-state battery news",
    instructions: ROUTINE_NEWS_INSTRUCTIONS,
  });
  const page = f.news.capture(f.fence, "http.request", { url: "https://example.com/battery" }, { ok: true, body: BATTERY_PAGE }) as {
    sourceId: string;
  };
  const before = routineState(f);
  const report = f.news.select(scope, f.run.runId, batterySelection(page.sourceId), f.now);
  // Neither claim repeats the story's identity, and the first quotes a sentence with five abbreviations and an initial in it.
  expect(report).toMatchObject({ title: "Battery Watch: Solid-State", rejected: 0, stories: [{ title: "Solid-state pilot line" }] });
  expect(renderRoutineNewsHtml(report)).toContain("<title>Battery Watch: Solid-State</title>");
  // Selecting leaves the routine's state alone; the production publication records the clustering policy.
  expect(routineState(f)).toEqual(before);
  const sent = await deliverPdf(f, report);
  expect(routineState(f).clustering).toMatchObject({ threshold: expect.any(Number) });
  expect(sent).toEqual([expect.objectContaining({ kind: "file", filename: "battery-watch-solid-state.pdf" })]);
});

it("still splits a quote at a real sentence end, and refuses a quote that runs across two sentences", () => {
  const f = fixture();
  const page = f.news.capture(
    f.fence,
    "http.request",
    { url: "https://example.com/two" },
    { ok: true, body: '<meta property="article:published_time" content="2026-09-20T05:00:00Z"><p>Sales rose. Prices fell.</p>' },
  ) as { sourceId: string };
  const story = (text: string) => ({
    stories: [{ title: "Sales", releaseIdentity: "Sales report", eventKind: "update", claims: [{ text, sourceId: page.sourceId }] }],
  });
  expect(f.news.select(scope, f.run.runId, story("Prices fell."), f.now).rejected).toBe(0);
  expect(f.news.select(scope, f.run.runId, story("Sales rose. Prices fell."), f.now).rejected).toBe(1);
});

it("runs a revision saved as news-v1 with the LLM-release default exactly as it was saved: LLM news, llm-news.pdf, the release rule", async () => {
  const f = fixture("production", "news-v1", { name: "Battery Watch", instructions: ROUTINE_LLM_RELEASES_INSTRUCTIONS });
  const saved = f.runs.routines.get(scope, f.run.routineId).revision.snapshot;
  // The stored revision is not rewritten: it still names news-v1 and the instructions it was saved with.
  expect(saved.report.templateVersion).toBe("news-v1");
  expect(saved.agent.instructions).toBe(ROUTINE_LLM_RELEASES_INSTRUCTIONS);
  const page = f.news.capture(f.fence, "http.request", { url: "https://example.com/battery" }, { ok: true, body: BATTERY_PAGE }) as {
    sourceId: string;
  };
  // Claims that do not name the release are refused, as they always were.
  expect(f.news.select(scope, f.run.runId, batterySelection(page.sourceId), f.now)).toMatchObject({ rejected: 1, stories: [] });
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  expect(report).toMatchObject({ title: "LLM news", stories: [{ title: "Model One version 2" }] });
  const sent = await deliverPdf(f, report);
  expect(sent).toEqual([expect.objectContaining({ kind: "file", filename: "llm-news.pdf" })]);
});

it("suppresses a news-v1 story another publisher reports on a later run, within the dedup window", () => {
  const f = fixture("production", "news-v1", { name: "Battery Watch", instructions: ROUTINE_NEWS_INSTRUCTIONS });
  const page = f.news.capture(f.fence, "http.request", { url: "https://example.com/battery" }, { ok: true, body: BATTERY_PAGE }) as {
    sourceId: string;
  };
  const report = f.news.select(scope, f.run.runId, batterySelection(page.sourceId), f.now);
  expect(report.stories).toHaveLength(1);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  f.publication.publish(f.fence, report, state.version, f.delivery);
  const second = f.runs.request(scope, f.run.routineId, "second");
  const fence = f.runs.start(scope, second.runId)!;
  const copy = f.news.capture(fence, "http.request", { url: "https://second.com/battery" }, { ok: true, body: BATTERY_PAGE }) as {
    sourceId: string;
  };
  const repeat = f.news.select(scope, second.runId, batterySelection(copy.sourceId), f.now);
  expect(repeat).toMatchObject({ duplicates: 1, stories: [] });
  expect(repeat.suppressions).toEqual([{ releaseIdentity: "QuantumScape pilot", reason: expect.stringContaining("dedup window") }]);
});

it("merges another publication's coverage and dedup committed while the run researched, instead of failing it", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  const before = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  // Another publication of this routine commits first, with a later coverage window.
  const elsewhere = { from: "2026-09-20T05:30:00.000Z", to: "2026-09-20T06:30:00.000Z" };
  f.store.handle
    .prepare(
      "UPDATE tavi_routine_state SET version=version+1,state_json=json_set(state_json,'$.dedup',json(?),'$.coverage',json(?)) WHERE routine_id=?",
    )
    .run(JSON.stringify([{ key: "other-story", at: f.now }]), JSON.stringify(elsewhere), f.run.routineId);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  f.publication.publish(f.fence, report, before.version, f.delivery);
  expect(f.runs.get(scope, f.run.runId).status).toBe("succeeded");
  const after = f.store.handle.prepare("SELECT version,state_json FROM tavi_routine_state").get() as {
    version: number;
    state_json: string;
  };
  expect(after.version).toBe(before.version + 2);
  const state = JSON.parse(after.state_json) as { dedup: { key: string }[]; coverage: { to: string } };
  expect(state.dedup.map((item) => item.key)).toEqual(["other-story", ...report.stories.map((story) => story.dedupKey)]);
  // The later of the two windows is the one covered.
  expect(state.coverage.to).toBe(elsewhere.to);
});

it("reads and decrypts a report once per chunked download, across the requests that fetch its chunks", async () => {
  const { createRoutineDispatcher } = await import("../src/persistence/routine-handlers.js");
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  const pdf = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(300_000, 65)]);
  f.publication.stage(f.fence, "pdf", pdf);
  const state = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  f.publication.publish(f.fence, report, state.version, f.delivery);
  const dispatch = createRoutineDispatcher(f.store);
  dispatch("routine.configure", {
    ownerEpoch: "one",
    workspaces: [{ ...scope, permissions: [] }],
    toolPermissions: {},
    destinations: [],
    providerConnectionIds: [],
    modelOverride: true,
    executionAvailable: true,
    allowedHosts: [],
  });
  const reads = vi.spyOn(f.store, "readArtifactBody");
  // Each chunk is its own request, as the owner sends them.
  const download = () => {
    const chunks: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const chunk = dispatch("routine.control", {
        payload: { ...scope, action: "artifact", runId: f.run.runId, artifactKind: "pdf", offset },
      }) as { base64: string; nextOffset: number | null };
      chunks.push(Buffer.from(chunk.base64, "base64"));
      offset = chunk.nextOffset;
    }
    return Buffer.concat(chunks);
  };
  expect(download()).toEqual(pdf);
  expect(reads).toHaveBeenCalledTimes(1);
  // The last chunk let it go: the next download reads afresh.
  expect(download()).toEqual(pdf);
  expect(reads).toHaveBeenCalledTimes(2);
});

it("runs two routines that fire at 09:00 side by side, and both publish", async () => {
  const { RoutineRunDrain } = await import("../src/routines/drain.js");
  const f = fixture();
  f.runs.cancel(scope, f.run.runId);
  const first = f.run.snapshot;
  const second = f.runs.routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...routineDefaults("Europe/Sofia"),
      operationKey: "create-second",
      name: "Second",
      objective: "Find more news",
      agent: { agentId: "second", name: "Second", instructions: "Find evidence" },
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
      skills: [],
      models: first.models,
      permissions: first.permissions,
    }),
  );
  f.runs.routines.finishEvaluation(scope, second.routine.routineId, 1, true, "pass");
  const runs = [f.runs.request(scope, f.run.routineId, "nine"), f.runs.request(scope, second.routine.routineId, "nine")];
  const entered: string[] = [];
  const together = Promise.withResolvers<void>();
  await new RoutineRunDrain(f.runs, {
    dispatch: async (run, fence) => {
      const source = f.news.capture(
        fence,
        "http.request",
        { url: "https://example.com/model" },
        {
          ok: true,
          body: '<meta property="article:published_time" content="2026-09-20T05:00:00Z"><p>Model One version 2 is now available.</p>',
        },
      ) as { sourceId: string };
      const version = f.runs.stateVersion(run.routineId);
      const report = f.news.select(
        scope,
        run.runId,
        { stories: [{ ...f.selection.stories[0]!, claims: [{ ...f.selection.stories[0]!.claims[0]!, sourceId: source.sourceId }] }] },
        f.now,
      );
      f.publication.stage(fence, "json", Buffer.from(canonicalRoutineJson(report)));
      // Neither publishes until both are running.
      entered.push(run.runId);
      if (entered.length === 2) together.resolve();
      await together.promise;
      f.publication.publish(fence, report, version, f.delivery);
    },
  }).drain();
  expect(entered.sort()).toEqual(runs.map((run) => run.runId).sort());
  for (const run of runs) expect(f.runs.get(scope, run.runId).status).toBe("succeeded");
});

it("keeps each reported story's title and identity in the dedup memory, and names them to the routine's next run", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  const before = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  f.publication.publish(f.fence, report, before.version, f.delivery);
  const state = JSON.parse(
    (f.store.handle.prepare("SELECT state_json FROM tavi_routine_state").get() as { state_json: string }).state_json,
  );
  expect(state.dedup).toEqual([{ key: report.stories[0]!.dedupKey, at: f.now, title: "Release", releaseIdentity: "Model One version 2" }]);
  const second = f.runs.request(scope, f.run.routineId, "second");
  f.runs.start(scope, second.runId);
  expect(f.news.window(scope, second.runId, f.now).reported).toEqual([{ title: "Release", releaseIdentity: "Model One version 2" }]);
});

it("reads dedup rows kept before titles were: they still suppress a repeat, and are not named to a run", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  f.store.handle
    .prepare("UPDATE tavi_routine_state SET state_json=?")
    .run(canonicalRoutineJson({ dedup: [{ key: report.stories[0]!.dedupKey, at: f.now }], coverage: { to: null } }));
  const window = f.news.prepareWindow(f.fence);
  expect(window.reported).toBeUndefined();
  expect(window).toEqual({ from: "2026-09-19T06:00:00.000Z", to: f.now, hours: 24, gaps: [] });
  expect(f.news.select(scope, f.run.runId, f.selection, f.now)).toMatchObject({ duplicates: 1, stories: [] });
});

it("names at most 30 of the newest reported stories still inside the dedup window, oldest first, each once", () => {
  const f = fixture();
  const at = (hoursAgo: number) => new Date(Date.parse(f.now) - hoursAgo * 3_600_000).toISOString();
  const dedup = [
    // Past the 7-day dedup window: not named.
    { key: "expired", at: at(8 * 24), title: "Expired", releaseIdentity: "Expired one" },
    ...Array.from({ length: 40 }, (_, index) => ({
      key: `story-${index}`,
      at: at(40 - index),
      title: `Story ${index}`,
      releaseIdentity: `S${index}`,
    })),
    // The same story under a second key (a material update): named once.
    { key: "story-39-update", at: at(0), title: "Story 39", releaseIdentity: "S39" },
  ];
  f.store.handle.prepare("UPDATE tavi_routine_state SET state_json=?").run(canonicalRoutineJson({ dedup, coverage: { to: null } }));
  const second = f.runs.request(scope, f.run.routineId, "second");
  f.runs.start(scope, second.runId);
  const reported = f.news.window(scope, second.runId, f.now).reported ?? [];
  expect(reported).toHaveLength(30);
  expect(reported[0]).toEqual({ title: "Story 10", releaseIdentity: "S10" });
  expect(reported.at(-1)).toEqual({ title: "Story 39", releaseIdentity: "S39" });
});

it("keeps titles only on the newest 30 dedup rows a publication writes; older rows keep their key and time", () => {
  const f = fixture();
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  const at = (hoursAgo: number) => new Date(Date.parse(f.now) - hoursAgo * 3_600_000).toISOString();
  const dedup = Array.from({ length: 39 }, (_, index) => ({
    key: `story-${index}`,
    at: at(39 - index),
    title: `Story ${index}`,
    releaseIdentity: `S${index}`,
  }));
  f.store.handle.prepare("UPDATE tavi_routine_state SET state_json=?").run(canonicalRoutineJson({ dedup, coverage: { to: null } }));
  f.publication.stage(f.fence, "json", Buffer.from(canonicalRoutineJson(report)));
  const before = f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number };
  f.publication.publish(f.fence, report, before.version, f.delivery);
  const state = JSON.parse(
    (f.store.handle.prepare("SELECT state_json FROM tavi_routine_state").get() as { state_json: string }).state_json,
  ) as { dedup: { key: string; at: string; title?: string }[] };
  expect(state.dedup).toHaveLength(40);
  expect(state.dedup.filter((row) => row.title !== undefined)).toHaveLength(30);
  expect(state.dedup.slice(0, 10)).toEqual(dedup.slice(0, 10).map((row) => ({ key: row.key, at: row.at })));
  expect(state.dedup.at(-1)).toEqual({
    key: report.stories[0]!.dedupKey,
    at: f.now,
    title: "Release",
    releaseIdentity: "Model One version 2",
  });
});

it("spends no slot on a story already reported: it is suppressed, and a new one takes its place", () => {
  const f = fixture();
  f.store.handle
    .prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?")
    .run(canonicalRoutineJson({ ...f.run.snapshot, report: { ...f.run.snapshot.report, maxItems: 1 } }), f.run.runId);
  const page = f.news.capture(
    f.fence,
    "http.request",
    { url: "https://example.com/three" },
    {
      ok: true,
      body: '<meta property="article:published_time" content="2026-09-20T05:30:00Z"><p>Model One version 3 is now available.</p>',
    },
  ) as { sourceId: string };
  const selection = structuredClone(f.selection);
  selection.stories.push({
    title: "Release three",
    releaseIdentity: "Model One version 3",
    eventKind: "release",
    claims: [{ text: "Model One version 3 is now available.", sourceId: page.sourceId }],
  });
  // With nothing reported, the first story takes the only slot.
  const first = f.news.select(scope, f.run.runId, selection, f.now);
  expect(first.stories.map((story) => story.releaseIdentity)).toEqual(["Model One version 2"]);
  f.store.handle.prepare("UPDATE tavi_routine_state SET state_json=?").run(
    canonicalRoutineJson({
      dedup: [{ key: first.stories[0]!.dedupKey, at: f.now, title: "Release", releaseIdentity: "Model One version 2" }],
    }),
  );
  const repeat = f.news.select(scope, f.run.runId, selection, f.now);
  expect(repeat).toMatchObject({ duplicates: 1, quiet: false });
  expect(repeat.stories.map((story) => story.releaseIdentity)).toEqual(["Model One version 3"]);
});

it("keeps the base window as the one a widening routine's selection tries first", () => {
  const f = fixture();
  f.store.handle
    .prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?")
    .run(canonicalRoutineJson({ ...f.run.snapshot, report: { ...f.run.snapshot.report, onEmpty: "widen_lookback" } }), f.run.runId);
  expect(f.news.prepareWindow(f.fence)).toMatchObject({ from: "2026-09-19T06:00:00.000Z", hours: 24 });
  const report = f.news.select(scope, f.run.runId, f.selection, f.now);
  expect(report.coverage).toMatchObject({ from: "2026-09-19T06:00:00.000Z", widened: false });
});
