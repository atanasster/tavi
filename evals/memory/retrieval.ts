import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { turnRetrievalQueryFrom, type TurnRetrievalQuery } from "@tavi/agent-host/workflow";
import { MEMORY_LIMIT_BOUNDS, memoryScopeKey, type MemoryActor, type MemoryScope, type WorkflowMessage } from "@tavi/contracts";

import { MemoryService } from "../../packages/runtime/src/memory/service.js";
import { SqliteStore } from "../../packages/runtime/src/persistence/store.js";
import {
  CATEGORIES,
  containsPhrase,
  oracleDecisions,
  scriptedCapture,
  type Category,
  type Probe,
  type SeedRecord,
  type Turn,
  type World,
  type WorldFile,
} from "./eval.js";

/**
 * The offline retrieval eval: seeds each world through the real `MemoryService`
 * over `SqliteStore` (migrating one template database once per run and copying
 * the file per world), builds each probe's recall query with the real
 * `turnRetrievalQueryFrom` at the probe's `now`, runs `MemoryService.search`
 * with the turn's actor, and scores which records come back.
 */

export const RETRIEVAL_CATEGORIES = CATEGORIES;
export type RetrievalCategory = Category;

export interface RetrievalProbe extends Omit<Probe, "expect" | "forbid" | "abstain"> {
  readonly relevant: readonly string[];
  readonly irrelevant?: readonly string[];
  /** When true, tests hybrid meaning-only recall (`query: ""`, `semantic` embedded with the deterministic token vector). */
  readonly meaningOnly?: boolean;
}

export interface RetrievalWorld extends Omit<World, "category" | "probes"> {
  readonly category: RetrievalCategory;
  readonly probes: readonly RetrievalProbe[];
}

const DETERMINISTIC_EMBEDDING_MODEL = "deterministic-token-v1";
const DETERMINISTIC_VECTOR_DIMS = 64;

/**
 * Deterministic 64-dim unit vector from a text's lowercased words (length >= 3),
 * so meaning-only / hybrid follow-up probes exercise `semanticQueryFrom` ->
 * `MemoryReads.#fuseHybrid` -> `SqliteMemoryRepository.vectorCandidates` in CI
 * with no network or model call.
 */
export function deterministicTextVector(text: string): readonly number[] {
  const raw = new Float64Array(DETERMINISTIC_VECTOR_DIMS);
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
  for (const word of words) {
    const digest = createHash("sha256").update(word).digest();
    const bucketA = (digest[0] ?? 0) % DETERMINISTIC_VECTOR_DIMS;
    const bucketB = (digest[1] ?? 0) % DETERMINISTIC_VECTOR_DIMS;
    const signA = ((digest[2] ?? 0) & 1) === 0 ? 1 : -1;
    const signB = ((digest[3] ?? 0) & 1) === 0 ? 1 : -1;
    raw[bucketA] = (raw[bucketA] ?? 0) + signA;
    raw[bucketB] = (raw[bucketB] ?? 0) + signB * 0.5;
  }
  let norm = 0;
  for (const value of raw) norm += value * value;
  if (norm === 0) {
    raw[0] = 1;
    norm = 1;
  }
  const scale = 1 / Math.sqrt(norm);
  return Array.from(raw, (value) => Number((value * scale).toFixed(6)));
}

/**
 * Diagnostic retrieval worlds exercising the recall failure modes identified in
 * the memory audit:
 * - F1 (`f1-morphology`): plurals, verb inflections, and contraction stem pollution.
 * - F2 (`f2-filter-before-limit`): sensitive, local-origin, and revoked-source records
 *   consuming SQL `LIMIT` slots before post-filtering.
 * - F7 (`f7-followup-meaning`): short follow-up question where `semanticQueryFrom`
 *   drops the previous turn's entity.
 * - F10 (`f10-short-terms-and-stopwords`): 2-letter uppercase acronyms (`AI`, `UK`)
 *   and multilingual stopwords consuming the 24-term query budget.
 */
export const RETRIEVAL_DIAGNOSTIC_WORLDS: readonly RetrievalWorld[] = [
  {
    id: "f1-morphology",
    category: "morphology",
    records: [
      {
        id: "meetings",
        kind: "fact",
        title: "Cadence",
        body: "Prefers short meetings on Friday mornings.",
      },
      {
        id: "marathons",
        kind: "fact",
        title: "Running",
        body: "Started running marathons in autumn.",
      },
      {
        id: "shellfish",
        kind: "fact",
        title: "Allergy",
        body: "Severely allergic to shellfish and carries an EpiPen.",
      },
    ],
    sessions: [],
    captures: [],
    probes: [
      {
        id: "plural-meetings",
        question: "How long should our meeting be?",
        relevant: ["meetings"],
        irrelevant: ["marathons", "shellfish"],
      },
      {
        id: "verb-running",
        question: "When did I start to run a marathon?",
        relevant: ["marathons"],
        irrelevant: ["meetings", "shellfish"],
      },
      {
        id: "contraction-stem-pollution",
        question:
          "Didn't, wouldn't, couldn't, shouldn't, wasn't, weren't, hasn't, haven't, hadn't, isn't, aren't, won't, doesn't, don't, mustn't, mightn't, let's check alpha beta gamma delta epsilon zeta eta theta shellfish?",
        relevant: ["shellfish"],
        irrelevant: ["meetings", "marathons"],
      },
    ],
  },
  {
    id: "f2-filter-before-limit",
    category: "recall",
    records: [
      {
        id: "filtered-sensitive",
        kind: "fact",
        title: "Roadmap milestone",
        body: "Roadmap milestone roadmap milestone confidential board note.",
        sensitive: true,
      },
      {
        id: "filtered-local",
        kind: "fact",
        title: "Roadmap milestone",
        body: "Roadmap milestone roadmap milestone private local chat note.",
        localOrigin: true,
      },
      {
        id: "filtered-revoked",
        kind: "fact",
        title: "Roadmap milestone",
        body: "Roadmap milestone roadmap milestone from a revoked source.",
        revokedSource: true,
      },
      ...[
        "authentication token rotation audit",
        "billing invoice export pipeline",
        "calendar webhook retry backoff",
        "database backup verification script",
        "encrypted attachment upload worker",
        "federated identity providerlogin",
        "graphql schema deprecation warnings",
        "hardware key attestation check",
        "incident runbook escalation matrix",
        "journal compaction snapshot pruning",
      ].map((detail, index) => ({
        id: `eligible-${index + 1}`,
        kind: "fact" as const,
        title: `Deliverable ${index + 1}`,
        body: `Roadmap milestone ${index + 1} covers ${detail}.`,
      })),
    ],
    sessions: [],
    captures: [],
    probes: [
      {
        id: "all-ten-eligible",
        question: "What are the roadmap milestone deliverables?",
        remoteChat: true,
        relevant: Array.from({ length: 10 }, (_, index) => `eligible-${index + 1}`),
        irrelevant: ["filtered-sensitive", "filtered-local", "filtered-revoked"],
      },
    ],
  },
  {
    id: "f7-followup-meaning",
    category: "follow-up",
    records: [
      {
        id: "sister-ana-born",
        kind: "fact",
        title: "Sister",
        body: "Sister Ana was born on 14 May in Coimbra.",
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `other-birthday-${index + 1}`,
        kind: "fact" as const,
        title: `Colleague ${index + 1}`,
        body: `Colleague ${index + 1} has a birthday party on day ${index + 10}.`,
      })),
    ],
    sessions: [],
    captures: [],
    probes: [
      {
        id: "followup-her-birthday",
        priorTurns: [
          { role: "person", text: "Tell me about my sister Ana." },
          { role: "assistant", text: "Ana lives in Coimbra." },
        ],
        question: "When is her birthday?",
        meaningOnly: true,
        relevant: ["sister-ana-born"],
        irrelevant: Array.from({ length: 10 }, (_, index) => `other-birthday-${index + 1}`),
      },
    ],
  },
  {
    id: "f10-short-terms-and-stopwords",
    category: "recall",
    records: [
      {
        id: "uk-ai-policy",
        kind: "fact",
        title: "Policy",
        body: "Tracks AI regulation in the UK.",
      },
      {
        id: "berlin-hotel",
        kind: "fact",
        title: "Hotel",
        body: "Stayed at Hotel Savoy in Berlin.",
      },
    ],
    sessions: [],
    captures: [],
    probes: [
      {
        id: "two-letter-acronyms",
        question: "What about AI in the UK?",
        relevant: ["uk-ai-policy"],
        irrelevant: ["berlin-hotel"],
      },
      {
        id: "multilingual-stopwords",
        question: "les des une dans pour avec sur pas plus mais comme tout fait sont nous vous leur bien aussi der die das und ist Berlin?",
        relevant: ["berlin-hotel"],
        irrelevant: ["uk-ai-policy"],
      },
    ],
  },
];

export interface RetrievalProbeScore {
  readonly world: string;
  readonly probe: string;
  readonly category: RetrievalCategory;
  readonly query: TurnRetrievalQuery | undefined;
  readonly relevant: readonly string[];
  readonly irrelevant: readonly string[];
  readonly hits: readonly string[];
  /** Defined when `relevant.length > 0`. */
  readonly recallAtK?: number;
  /** Defined when `relevant.length > 0` or `hits.length > 0`. */
  readonly precisionAtK?: number;
  /** Reciprocal rank of the first relevant hit; defined when `relevant.length > 0`. */
  readonly mrr?: number;
  /** True when at least one hit is in `irrelevant`. */
  readonly noisy: boolean;
  /** True when `relevant.length > 0` and `hits.length === 0`. */
  readonly empty: boolean;
  /** True when every relevant item was retrieved (`recallAtK === 1` or `relevant.length === 0`) and `noisy === false`. */
  readonly passed: boolean;
}

export interface RetrievalCategorySummary {
  readonly probes: number;
  readonly passed: number;
  readonly recallAtK?: number;
  readonly precisionAtK?: number;
  readonly mrr?: number;
  readonly noiseRate: number;
  readonly emptyRate?: number;
}

export interface RetrievalEvalReport {
  readonly version: 1;
  readonly limit: number;
  readonly overall: RetrievalCategorySummary;
  readonly byCategory: Partial<Record<RetrievalCategory, RetrievalCategorySummary>>;
  readonly results: readonly RetrievalProbeScore[];
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : round4(values.reduce((sum, value) => sum + value, 0) / values.length);

/** Score a single probe's retrieved logical record ids against its `relevant` and `irrelevant` sets. */
export function scoreProbeRetrieval(input: {
  readonly world: string;
  readonly probe: string;
  readonly category: RetrievalCategory;
  readonly query: TurnRetrievalQuery | undefined;
  readonly relevant: readonly string[];
  readonly irrelevant?: readonly string[];
  readonly hits: readonly string[];
}): RetrievalProbeScore {
  const relevantSet = new Set(input.relevant);
  const irrelevantList = input.irrelevant ?? [];
  const irrelevantSet = new Set(irrelevantList);
  // A record can come back more than once (its current and an ended or superseded revision), so score distinct records.
  const distinctHits = [...new Set(input.hits)];
  const matched = distinctHits.filter((id) => relevantSet.has(id)).length;
  const hasRelevant = input.relevant.length > 0;
  const recallAtK = hasRelevant ? round4(matched / relevantSet.size) : undefined;
  const precisionAtK = distinctHits.length > 0 ? round4(matched / distinctHits.length) : hasRelevant ? 0 : undefined;
  let mrr: number | undefined;
  if (hasRelevant) {
    const firstRank = input.hits.findIndex((id) => relevantSet.has(id));
    mrr = firstRank === -1 ? 0 : round4(1 / (firstRank + 1));
  }
  const noisy = input.hits.some((id) => irrelevantSet.has(id));
  const empty = hasRelevant && input.hits.length === 0;
  const passed = (!hasRelevant || matched === relevantSet.size) && !noisy;
  return {
    world: input.world,
    probe: input.probe,
    category: input.category,
    query: input.query,
    relevant: input.relevant,
    irrelevant: irrelevantList,
    hits: input.hits,
    ...(recallAtK === undefined ? {} : { recallAtK }),
    ...(precisionAtK === undefined ? {} : { precisionAtK }),
    ...(mrr === undefined ? {} : { mrr }),
    noisy,
    empty,
    passed,
  };
}

/** Aggregate a list of probe scores into a category or overall summary. */
export function summarizeRetrievalCategory(results: readonly RetrievalProbeScore[]): RetrievalCategorySummary {
  const recalls = results.flatMap((result) => (result.recallAtK === undefined ? [] : [result.recallAtK]));
  const precisions = results.flatMap((result) => (result.precisionAtK === undefined ? [] : [result.precisionAtK]));
  const mrrs = results.flatMap((result) => (result.mrr === undefined ? [] : [result.mrr]));
  const withRelevant = results.filter((result) => result.relevant.length > 0);
  const recallAtK = mean(recalls);
  const precisionAtK = mean(precisions);
  const mrr = mean(mrrs);
  const emptyRate =
    withRelevant.length === 0 ? undefined : round4(withRelevant.filter((result) => result.empty).length / withRelevant.length);
  const noiseRate = results.length === 0 ? 0 : round4(results.filter((result) => result.noisy).length / results.length);
  return {
    probes: results.length,
    passed: results.filter((result) => result.passed).length,
    ...(recallAtK === undefined ? {} : { recallAtK }),
    ...(precisionAtK === undefined ? {} : { precisionAtK }),
    ...(mrr === undefined ? {} : { mrr }),
    noiseRate,
    ...(emptyRate === undefined ? {} : { emptyRate }),
  };
}

/** Build the full retrieval report from per-probe scores. */
export function summarizeRetrieval(
  results: readonly RetrievalProbeScore[],
  limit: number = MEMORY_LIMIT_BOUNDS.evidence.default,
): RetrievalEvalReport {
  const byCategory: Partial<Record<RetrievalCategory, RetrievalCategorySummary>> = {};
  for (const category of RETRIEVAL_CATEGORIES) {
    const inCategory = results.filter((result) => result.category === category);
    if (inCategory.length > 0) byCategory[category] = summarizeRetrievalCategory(inCategory);
  }
  return {
    version: 1,
    limit,
    overall: summarizeRetrievalCategory(results),
    byCategory,
    results,
  };
}

function toWorkflowMessages(priorTurns: readonly Turn[], question: string): WorkflowMessage[] {
  const messages: WorkflowMessage[] = [];
  for (const [index, turn] of priorTurns.entries()) {
    if (turn.role === "person" || turn.role === "member") {
      messages.push({ id: `prior-${index + 1}`, role: "user", text: turn.text });
    } else if (turn.role === "assistant") {
      messages.push({ id: `prior-${index + 1}`, role: "assistant", text: turn.text });
    } else if (turn.role === "tool") {
      messages.push({
        id: `prior-${index + 1}`,
        role: "tool",
        toolCallId: `call-${index + 1}`,
        toolName: turn.tool ?? "tool",
        text: turn.text,
      });
    }
  }
  messages.push({ id: "probe-question", role: "user", text: question });
  return messages;
}

/** Convert a `World` from `worlds.json` into a `RetrievalWorld`. */
export function toRetrievalWorld(world: World): RetrievalWorld {
  const allRecordIds = (world.records ?? []).map((record, index) => record.id ?? `record-${index + 1}`);
  const allCaptureIds = world.captures.map((capture) => capture.id);
  const defaultRelevant = [...allRecordIds, ...allCaptureIds];
  return {
    ...world,
    probes: world.probes.map((probe): RetrievalProbe => {
      const relevant =
        probe.relevant !== undefined ? probe.relevant : probe.abstain === true || probe.context === "group" ? [] : defaultRelevant;
      return {
        id: probe.id,
        question: probe.question,
        ...(probe.priorTurns === undefined ? {} : { priorTurns: probe.priorTurns }),
        ...(probe.at === undefined ? {} : { at: probe.at }),
        ...(probe.context === undefined ? {} : { context: probe.context }),
        ...(probe.group === undefined ? {} : { group: probe.group }),
        ...(probe.speaker === undefined ? {} : { speaker: probe.speaker }),
        ...(probe.remoteChat === undefined ? {} : { remoteChat: probe.remoteChat }),
        relevant,
        ...(probe.irrelevant === undefined ? {} : { irrelevant: probe.irrelevant }),
      };
    }),
  };
}

function seedWorldRecord(input: {
  readonly store: SqliteStore;
  readonly persistence: ReturnType<SqliteStore["asPort"]>;
  readonly service: MemoryService;
  readonly actor: MemoryActor;
  readonly scope: MemoryScope;
  readonly record: SeedRecord;
  readonly logicalId: string;
  readonly setClock: (iso: string) => void;
  readonly defaultNow: string;
  readonly embedVectors: boolean;
  /**
   * A capture that updates a kept record is decided as the quality eval's oracle decides it:
   * *Replace* (the kept record corrected to the capture's words, the proposal rejected as
   * "applied as a correction"), so the old words stop being recalled.
   */
  readonly replaceUpdates?: boolean;
  /** The stored id of the record this one replaces outright (a capture's `updates`). */
  readonly replaces?: string;
}): string {
  const { store, persistence, service, actor, scope, record, logicalId, setClock, defaultNow, embedVectors } = input;
  const recordedAt = record.observedAt ?? record.validFrom ?? "2026-01-01T00:00:00.000Z";
  setClock(recordedAt);
  const scopeKey = memoryScopeKey(scope);
  const sourceId = record.revokedSource === true ? `src-${logicalId}` : undefined;
  if (sourceId !== undefined) {
    persistence.repositories.memory.insertEvidence({
      sourceId,
      scopeKey,
      operatorInput: true,
      observedAt: recordedAt,
      contentHash: `hash-${logicalId}`,
      captureBasis: "explicit",
      retentionPolicy: "standard",
      revocationStatus: "active",
    });
  }
  if (input.replaces !== undefined) {
    const corrected = service.correct({
      actor,
      recordId: input.replaces,
      ...(record.title === undefined ? {} : { title: record.title }),
      body: record.body,
      ...(record.kind === "preference" ? { preference: { valueType: "string" as const, value: record.value ?? record.body } } : {}),
      ...(record.keywords === undefined || record.keywords.length === 0 ? {} : { keywords: record.keywords }),
      reason: "replaced by an update",
    });
    if (embedVectors && corrected.currentRevisionId !== undefined && record.sensitive !== true) {
      embedSeeded(persistence, corrected.currentRevisionId, record, recordedAt);
    }
    setClock(defaultNow);
    return corrected.recordId;
  }
  const proposed = service.propose({
    actor,
    scope,
    kind: record.kind,
    ...(record.title === undefined ? {} : { title: record.title }),
    body: record.body,
    ...(record.kind === "preference"
      ? {
          preferenceKey: record.key ?? logicalId,
          preference: { valueType: "string", value: record.value ?? record.body },
        }
      : {}),
    ...(record.topicKey === undefined ? {} : { topicKey: record.topicKey }),
    ...(record.keywords === undefined || record.keywords.length === 0 ? {} : { keywords: record.keywords }),
    ...(record.sensitive === true ? { sensitivity: "sensitive" as const } : {}),
    ...(record.localOrigin === true ? { localOrigin: true } : {}),
    ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
    ...(record.validTo === undefined ? {} : { validTo: record.validTo }),
    ...(record.expiryAt === undefined ? {} : { expiryAt: record.expiryAt }),
    ...(record.observedAt === undefined ? {} : { observedAt: record.observedAt }),
    ...(sourceId === undefined ? {} : { sourceIds: [sourceId] }),
  });
  const related =
    input.replaceUpdates === true && proposed.status === "proposed" ? service.related({ actor, recordId: proposed.recordId }) : {};
  const target = (related.updates ?? related.mayUpdate)?.recordId;
  if (target !== undefined) {
    const corrected = service.correct({
      actor,
      recordId: target,
      ...(record.title === undefined ? {} : { title: record.title }),
      body: record.body,
      ...(record.kind === "preference" ? { preference: { valueType: "string" as const, value: record.value ?? record.body } } : {}),
      ...(record.keywords === undefined || record.keywords.length === 0 ? {} : { keywords: record.keywords }),
      reason: "replaced by an update",
    });
    service.reject({ actor, recordId: proposed.recordId, reason: "applied as a correction" });
    if (embedVectors && corrected.currentRevisionId !== undefined && record.sensitive !== true) {
      embedSeeded(persistence, corrected.currentRevisionId, record, recordedAt);
    }
    setClock(defaultNow);
    return corrected.recordId;
  }
  const approved = proposed.status === "approved" ? proposed : service.approve({ actor, recordId: proposed.recordId });
  if (sourceId !== undefined) {
    store.handle.prepare("UPDATE tavi_evidence_sources SET revocation_status = 'revoked' WHERE source_id = ?").run(sourceId);
  }
  if (embedVectors && approved.currentRevisionId !== undefined && record.sensitive !== true) {
    embedSeeded(persistence, approved.currentRevisionId, record, recordedAt);
  }
  setClock(defaultNow);
  return approved.recordId;
}

/** A seeded revision's deterministic vector, for worlds with meaning-only probes. */
function embedSeeded(persistence: ReturnType<SqliteStore["asPort"]>, revisionId: string, record: SeedRecord, now: string): void {
  const text = [record.title, record.body].filter((part): part is string => typeof part === "string" && part !== "").join(" — ");
  persistence.repositories.memory.putVectors({
    now,
    vectors: [{ revisionId, modelKey: DETERMINISTIC_EMBEDDING_MODEL, vector: deterministicTextVector(text) }],
  });
}

/**
 * Run the offline retrieval eval across `file.worlds` plus the diagnostic
 * retrieval worlds (`includeDiagnostics` defaults to true). Migrates one
 * template SQLite database once in a temporary directory and copies the file
 * for each world.
 */
export function runRetrievalEval(
  file: WorldFile,
  options: {
    readonly includeDiagnostics?: boolean;
    readonly limit?: number;
  } = {},
): RetrievalEvalReport {
  const limit = options.limit ?? MEMORY_LIMIT_BOUNDS.evidence.default;
  const worlds: readonly RetrievalWorld[] = [
    ...file.worlds.map(toRetrievalWorld),
    ...(options.includeDiagnostics === false ? [] : RETRIEVAL_DIAGNOSTIC_WORLDS),
  ];
  const scratchDir = mkdtempSync(join(tmpdir(), "tavi-retrieval-eval-"));
  try {
    const templateDir = join(scratchDir, "template");
    mkdirSync(templateDir, { recursive: true });
    const templatePath = join(templateDir, "tavi.sqlite");
    const templateStore = new SqliteStore({ databasePath: templatePath });
    templateStore.close();

    const results: RetrievalProbeScore[] = [];
    const operator: MemoryActor = {
      principalId: "person",
      workspaceId: "w1",
      agentId: "agent-main",
      caller: "cli",
      authority: "operator",
    };
    const scope: MemoryScope = { kind: "personal", principalId: "person" };

    for (const world of worlds) {
      const worldDir = join(scratchDir, `w-${world.id}`);
      mkdirSync(worldDir, { recursive: true });
      const worldDbPath = join(worldDir, "tavi.sqlite");
      copyFileSync(templatePath, worldDbPath);
      const store = new SqliteStore({ databasePath: worldDbPath });
      try {
        const persistence = store.asPort();
        let currentNow = file.now;
        let idCounter = 0;
        const service = new MemoryService(persistence, {
          now: () => currentNow,
          newId: (prefix) => `${prefix}-${world.id}-${(idCounter += 1)}`,
        });
        const setClock = (iso: string): void => {
          currentNow = iso;
        };
        const embedVectors = world.probes.some((probe) => probe.meaningOnly === true);
        const recordIdToLogical = new Map<string, string>();
        const logicalToRecordId = new Map<string, string>();

        for (const [index, record] of (world.records ?? []).entries()) {
          const logicalId = record.id ?? `record-${index + 1}`;
          const storedId = seedWorldRecord({
            store,
            persistence,
            service,
            actor: operator,
            scope,
            record,
            logicalId,
            setClock,
            defaultNow: file.now,
            embedVectors,
          });
          recordIdToLogical.set(storedId, logicalId);
          logicalToRecordId.set(logicalId, storedId);
        }

        // Seed non-negative captures through the same scripted capture + oracle path the quality eval uses.
        const captureWorld: World = {
          ...world,
          category: (CATEGORIES as readonly string[]).includes(world.category) ? (world.category as Category) : "recall",
          probes: [],
        };
        const proposals = scriptedCapture(captureWorld);
        const decisions = oracleDecisions(captureWorld, proposals);
        const approvedProposals = proposals.filter((proposal) => decisions.approve.includes(proposal.recordId));
        for (const capture of world.captures) {
          const matchingProposal = approvedProposals.find((proposal) =>
            capture.match.every((phrase) => containsPhrase(proposal.text, phrase)),
          );
          const body = matchingProposal?.text ?? capture.match.join(" ");
          const matchingSession = [...world.sessions]
            .reverse()
            .find((session) =>
              session.turns.some((turn) => turn.role === "person" && capture.match.every((phrase) => containsPhrase(turn.text, phrase))),
            );
          const replaces = capture.updates === undefined ? undefined : logicalToRecordId.get(capture.updates);
          const storedId = seedWorldRecord({
            store,
            persistence,
            service,
            actor: operator,
            scope,
            record: {
              id: capture.id,
              kind: capture.kind,
              body,
              ...(matchingProposal?.keywords === undefined ? {} : { keywords: matchingProposal.keywords }),
              ...(matchingSession === undefined ? {} : { observedAt: matchingSession.at }),
              ...(capture.kind === "preference" ? { key: `pref.${capture.id}`, value: capture.match[0] ?? body } : {}),
            },
            logicalId: capture.id,
            setClock,
            defaultNow: file.now,
            embedVectors,
            replaceUpdates: true,
            ...(replaces === undefined ? {} : { replaces }),
          });
          recordIdToLogical.set(storedId, capture.id);
          logicalToRecordId.set(capture.id, storedId);
        }

        for (const probe of world.probes) {
          const probeNow = probe.at ?? file.now;
          setClock(probeNow);
          const conversation = toWorkflowMessages(probe.priorTurns ?? [], probe.question);
          const query = turnRetrievalQueryFrom(conversation, { now: probeNow });
          const turnActor: MemoryActor = {
            principalId: "person",
            workspaceId: "w1",
            agentId: "agent-main",
            caller: "model",
            authority: "model",
            ...(probe.context === "group" ? { reach: "chat-only" as const, chatTaskId: `group-${probe.group ?? "1"}` } : {}),
          };
          let hitLogicalIds: string[] = [];
          const keywords = probe.meaningOnly === true ? "" : (query?.keywords.trim() ?? "");
          const semantic = query?.semantic?.trim() ?? "";
          const useVector = probe.meaningOnly === true && semantic !== "";
          if (query !== undefined && (keywords !== "" || useVector)) {
            const searchResult = service.search({
              actor: turnActor,
              query: keywords,
              match: "any",
              limit,
              applyFloor: true,
              ...(probe.remoteChat === true ? { excludeLocalOrigin: true } : {}),
              ...(semantic === "" ? {} : { semantic }),
              ...(query.range === undefined
                ? {}
                : {
                    range: { from: query.range.from, to: query.range.to },
                    ...(query.range.pastOnly ? { includePast: true } : {}),
                  }),
              ...(useVector
                ? {
                    queryVector: {
                      modelKey: DETERMINISTIC_EMBEDDING_MODEL,
                      vector: deterministicTextVector(semantic),
                    },
                  }
                : {}),
            });
            hitLogicalIds = searchResult.hits.map((hit) => recordIdToLogical.get(hit.recordId) ?? hit.recordId);
          }
          // A turn also carries the "About the person" profile (lessons and core `me.*` facts) whatever its words:
          // what reaches the reader is evidence and profile together, the profile's after the evidence.
          const profile = service.resolvePreferences({ actor: turnActor, includeProfile: true }).profile ?? [];
          for (const entry of profile) {
            const logical = recordIdToLogical.get(entry.recordId) ?? entry.recordId;
            if (!hitLogicalIds.includes(logical)) hitLogicalIds.push(logical);
          }
          results.push(
            scoreProbeRetrieval({
              world: world.id,
              probe: probe.id,
              category: world.category,
              query,
              relevant: probe.relevant,
              ...(probe.irrelevant === undefined ? {} : { irrelevant: probe.irrelevant }),
              hits: hitLogicalIds,
            }),
          );
        }
      } finally {
        store.close();
      }
    }

    return summarizeRetrieval(results, limit);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

export interface RetrievalComparison {
  readonly ok: boolean;
  readonly improved: boolean;
  readonly regressions: readonly string[];
  readonly improvements: readonly string[];
  readonly summary: string;
}

const fmtMetric = (value: number | undefined): string => (value === undefined ? "n/a" : value.toFixed(4));

/**
 * Compare a current retrieval eval report against a committed baseline.
 * Fails (`ok: false`) if recall@k, precision@k or MRR drops, or the noise or
 * empty rate rises, past `tolerance` (default 0.001), overall or in any
 * category; if any baseline probe is missing; or if a previously passing probe
 * regresses. The eval is deterministic, so any real move is a change to review
 * (a recall gain that costs precision updates the baseline in the same PR).
 */
export function compareRetrievalReports(
  baseline: RetrievalEvalReport,
  current: RetrievalEvalReport,
  options: { readonly tolerance?: number } = {},
): RetrievalComparison {
  const tolerance = options.tolerance ?? 0.001;
  const regressions: string[] = [];
  const improvements: string[] = [];

  const checkHigherBetter = (label: string, before: number | undefined, after: number | undefined, tol: number): void => {
    if (before === undefined || after === undefined) return;
    if (after < before - tol) {
      regressions.push(`${label} dropped: ${fmtMetric(before)} -> ${fmtMetric(after)}`);
    } else if (after > before + tol) {
      improvements.push(`${label} improved: ${fmtMetric(before)} -> ${fmtMetric(after)}`);
    }
  };

  const checkLowerBetter = (label: string, before: number | undefined, after: number | undefined, tol: number): void => {
    if (before === undefined || after === undefined) return;
    if (after > before + tol) {
      regressions.push(`${label} rose: ${fmtMetric(before)} -> ${fmtMetric(after)}`);
    } else if (after < before - tol) {
      improvements.push(`${label} improved: ${fmtMetric(before)} -> ${fmtMetric(after)}`);
    }
  };

  checkHigherBetter("overall recall@k", baseline.overall.recallAtK, current.overall.recallAtK, tolerance);
  checkHigherBetter("overall precision@k", baseline.overall.precisionAtK, current.overall.precisionAtK, tolerance);
  checkHigherBetter("overall mrr", baseline.overall.mrr, current.overall.mrr, tolerance);
  checkLowerBetter("overall noiseRate", baseline.overall.noiseRate, current.overall.noiseRate, tolerance);
  checkLowerBetter("overall emptyRate", baseline.overall.emptyRate, current.overall.emptyRate, tolerance);

  for (const category of RETRIEVAL_CATEGORIES) {
    const left = baseline.byCategory[category];
    const right = current.byCategory[category];
    if (left === undefined || right === undefined) continue;
    checkHigherBetter(`${category} recall@k`, left.recallAtK, right.recallAtK, tolerance);
    checkHigherBetter(`${category} precision@k`, left.precisionAtK, right.precisionAtK, tolerance);
    checkHigherBetter(`${category} mrr`, left.mrr, right.mrr, tolerance);
    checkLowerBetter(`${category} noiseRate`, left.noiseRate, right.noiseRate, tolerance);
    checkLowerBetter(`${category} emptyRate`, left.emptyRate, right.emptyRate, tolerance);
  }

  const baselineByKey = new Map(baseline.results.map((result) => [`${result.world}/${result.probe}`, result]));
  const currentKeys = new Set<string>();
  for (const result of current.results) {
    const key = `${result.world}/${result.probe}`;
    currentKeys.add(key);
    const prev = baselineByKey.get(key);
    if (prev === undefined) continue;
    if (prev.passed && !result.passed) {
      regressions.push(
        `probe ${key} regressed (recall@k ${fmtMetric(prev.recallAtK)} -> ${fmtMetric(result.recallAtK)}, noisy ${prev.noisy} -> ${result.noisy})`,
      );
    } else if (!prev.passed && result.passed) {
      improvements.push(`probe ${key} now passes (recall@k ${fmtMetric(prev.recallAtK)} -> ${fmtMetric(result.recallAtK)})`);
    } else if ((result.recallAtK ?? 0) > (prev.recallAtK ?? 0) + tolerance) {
      improvements.push(`probe ${key} recall@k improved (${fmtMetric(prev.recallAtK)} -> ${fmtMetric(result.recallAtK)})`);
    } else if ((result.recallAtK ?? 0) < (prev.recallAtK ?? 0) - tolerance) {
      regressions.push(`probe ${key} recall@k dropped (${fmtMetric(prev.recallAtK)} -> ${fmtMetric(result.recallAtK)})`);
    }
  }
  for (const key of baselineByKey.keys()) {
    if (!currentKeys.has(key)) {
      regressions.push(`probe ${key} missing from current retrieval report`);
    }
  }

  const lines = [
    `retrieval eval comparison: passed ${baseline.overall.passed}/${baseline.overall.probes} -> ${current.overall.passed}/${current.overall.probes}, recall@${current.limit} ${fmtMetric(baseline.overall.recallAtK)} -> ${fmtMetric(current.overall.recallAtK)}, precision@${current.limit} ${fmtMetric(baseline.overall.precisionAtK)} -> ${fmtMetric(current.overall.precisionAtK)}, MRR ${fmtMetric(baseline.overall.mrr)} -> ${fmtMetric(current.overall.mrr)}, noise ${fmtMetric(baseline.overall.noiseRate)} -> ${fmtMetric(current.overall.noiseRate)}, empty ${fmtMetric(baseline.overall.emptyRate)} -> ${fmtMetric(current.overall.emptyRate)}`,
    ...improvements.map((line) => `  + ${line}`),
    ...regressions.map((line) => `  - ${line}`),
  ];

  return {
    ok: regressions.length === 0,
    improved: improvements.length > 0,
    regressions,
    improvements,
    summary: lines.join("\n"),
  };
}

/** Format a retrieval report as a readable table for terminal output. */
export function formatRetrievalReport(report: RetrievalEvalReport): string {
  const lines = [
    `memory retrieval eval (limit=${report.limit}): ${report.overall.passed}/${report.overall.probes} probes passed`,
    ["category", "probes", "passed", `recall@${report.limit}`, `precision@${report.limit}`, "mrr", "noise", "empty"].join("\t"),
    [
      "overall",
      String(report.overall.probes),
      String(report.overall.passed),
      fmtMetric(report.overall.recallAtK),
      fmtMetric(report.overall.precisionAtK),
      fmtMetric(report.overall.mrr),
      fmtMetric(report.overall.noiseRate),
      fmtMetric(report.overall.emptyRate),
    ].join("\t"),
  ];
  for (const category of RETRIEVAL_CATEGORIES) {
    const summary = report.byCategory[category];
    if (summary === undefined) continue;
    lines.push(
      [
        category,
        String(summary.probes),
        String(summary.passed),
        fmtMetric(summary.recallAtK),
        fmtMetric(summary.precisionAtK),
        fmtMetric(summary.mrr),
        fmtMetric(summary.noiseRate),
        fmtMetric(summary.emptyRate),
      ].join("\t"),
    );
  }
  for (const result of report.results.filter((entry) => !entry.passed)) {
    lines.push(
      `FAIL ${result.category} ${result.world}/${result.probe}: recall=${fmtMetric(result.recallAtK)} hits=[${result.hits.join(",")}] relevant=[${result.relevant.join(",")}] noisy=${result.noisy}`,
    );
  }
  return lines.join("\n");
}

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BASELINE_PATH = join(here, "retrieval-baseline.json");
