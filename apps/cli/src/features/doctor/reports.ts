import { PDF_ENGINE_PLUGIN_ID, VIDEO_ENGINE_PLUGIN_ID } from "../plugins/catalog.js";
import { onboardingStatus } from "../onboard/owner.js";
import { ownerOnboardingDependencies } from "../onboard/owner-dependencies.js";
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync, type Dirent } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { nodeHonoursEnvProxy } from "../mcp/launcher.js";
import { pdfConfinement, pdfOcrAssets } from "../pdf/host.js";
import { engineWarnings, parentProxyChecks, sandboxDoctorSection } from "../sandbox/setup.js";
import { findUv } from "../mcp/pypi.js";
import { schemaTokenCount } from "../mcp/review.js";
import { credentialsEncrypted, plainCredentialStoreWarning } from "../credentials/store.js";
import {
  sandboxConfines,
  type SandboxStatus,
  MCP_ENABLED_SETTING,
  MCP_PLUGIN_PREFIX,
  MCP_SCHEMA_TOKENS_WARN,
  mcpEnabledOf,
  mcpServerAllowed,
  labelSummary,
  TRUSTED_PUBLIC,
  type LabelSummary,
  type TaskRecord,
  GATE_OBSERVATION_DOCTOR_DAYS,
  GATE_OBSERVATION_TOP_TOOLS,
  taintDoctorLine,
  taintModeOf,
  type TaintMode,
  BUILTIN_MEMORY_PROVIDER_ID,
  DEFAULT_WORKSPACE_ID,
  effectiveMemorySettings,
  memorySettingsDoctor,
  hostTimeZone,
  redactToolOutput,
  startOfLocalDay,
  resolveContributions,
  toolResultRedactionOn,
  pdfToolsOn,
  videoToolsOn,
  type AdmissionKind,
  type HeartbeatProvider,
  heartbeatCheckRan,
  type PluginView,
  MEMORY_PORT_CONFORMANCE,
  WEB_SEARCH_ALLOW_RULE_ID,
  SCHEDULED_BUDGET_NOTICE_PERCENT,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";

import {
  readRecordedOwner,
  type ChatMeasurement,
  SAVER_EXPECTED_COLUMNS,
  SAVER_SCHEMA_VERSION,
  SAVER_SCHEMA_VERSION_KEY,
  type DatabaseClient,
  type RoutinePublicationService,
} from "@tavi/runtime";
import { diskStatus } from "../../shared/disk.js";
import { MEMORY_EMBEDDING_ATTEMPT_PREFIX } from "../memory/embedding-role.js";
import { memoryVectorsDoctor, workspacePrincipals } from "../memory/vectors.js";
import { pluginUiEntries } from "../plugins/actions.js";
import { scheduledWorkThisMonth } from "../schedules/actions.js";
import { inProcessAudit } from "../plugins/audit.js";
import { checkpointContextLabel, readCheckpointValues, taskHistory } from "../tasks/history.js";

import type { BrowserBoundary, TaviRuntime } from "../../runtime/types.js";
import { isRunningHere, recoverCommand } from "../../shared/ipc-decisions.js";
import { routerPriceReady, routerProviderCandidate, routerProviderPricing, routerProviderState } from "../router/owner.js";
import { EPOCH_FLUSH_ATTEMPT_PREFIX, MEMORY_CONSOLIDATION_ATTEMPT_PREFIX, MEMORY_REVIEW_ATTEMPT_PREFIX } from "@tavi/agent-host/workflow";
import { memoryIdleReviewDoctor } from "../memory/idle-review.js";
import { memoryConsolidationDoctor } from "../memory/consolidation.js";
import { externalMemoryIndexNote, readMemoryProviderStatus } from "../memory/providers.js";
import { nodeVersionReport, type NodeVersionReport } from "../../shared/node-version.js";
import { vcRuntimeReport, type VcRuntimeReport } from "../../shared/vc-runtime.js";
import type { HealthTrend } from "./health.js";

/**
 * Rows with a call's stored input, masked as `tools.redactResults` says for
 * each one's workspace, as `approvals show` and the inbox mask them: the
 * real input stays in the store, where the call runs from. A task that cannot
 * be read is masked.
 */
async function withMaskedInputs<T extends { readonly taskId: string; readonly inputs: unknown; readonly inputsHash?: string }>(
  repositories: Awaited<ReturnType<DatabaseClient["asPort"]>>["repositories"],
  rows: readonly T[],
): Promise<T[]> {
  const masking = new Map<string, Promise<boolean>>();
  const masked = (taskId: string): Promise<boolean> => {
    let known = masking.get(taskId);
    if (known === undefined) {
      known = (async () => {
        const task = await repositories.tasks.get(taskId);
        return task === undefined || toolResultRedactionOn((await repositories.workspaceSettings.get(task.workspaceId)).settings);
      })().catch(() => true);
      masking.set(taskId, known);
    }
    return known;
  };
  return Promise.all(rows.map(async (row) => ((await masked(row.taskId)) ? maskedCall(row) : row)));
}

/** A row's stored input masked, and its `inputsHash` too: that is the input's canonical JSON, not a digest. */
export function maskedCall<T extends { readonly inputs: unknown; readonly inputsHash?: string }>(row: T): T {
  return {
    ...row,
    inputs: redactToolOutput(row.inputs).value,
    ...(typeof row.inputsHash === "string" ? { inputsHash: redactToolOutput(row.inputsHash).value as string } : {}),
  };
}

/**
 * The `tasks` document.
 *
 * Both the direct path and the IPC handler build it here, so a script consuming
 * `tavi tasks` cannot receive a different document depending on whether a service
 * happens to be running.
 */
export async function buildTaskDocument(
  store: DatabaseClient,
  dataDirectory: string,
  now: string,
  /** The owner answering, which holds the lock and so cannot read it: it names itself. Absent: the lock's record. */
  owner?: unknown,
): Promise<Record<string, unknown>> {
  const repositories = (await store.asPort()).repositories;
  const executions = repositories.executions;
  const tasks = await Promise.all(
    (await store.listTasks(50)).map(async (task) => ({
      ...task,
      // Lease state is reported so an operator can see a stuck task and recover it.
      execution: (await executions.current(task.taskId)) ?? null,
    })),
  );
  return {
    dataDirectory,
    owner: owner ?? (await readRecordedOwner(dataDirectory)),
    tasks,
    expiredLeases: await executions.listExpiredLeases(now, 50),
    cancellations: await repositories.cancellations.list(50),
    pendingApprovals: await withMaskedInputs(repositories, await repositories.approvals.listPending(50)),
    // An effect whose outcome is unknown is surfaced for reconciliation and never
    // retried automatically.
    unresolvedEffects: await withMaskedInputs(repositories, await repositories.effects.listUnresolved(50)),
    // A messaging effect that `begin`-ed but never `resolve`-ed is a delivery
    // whose fate the workflow cannot see: the connector may or may not have
    // reached the provider. `listPending`'s own contract calls itself the
    // messaging equivalent of `unresolvedEffects`, so it is listed beside it:
    // otherwise an operator reviewing a half-sent morning brief would see only
    // `unresolvedEffects`, with no hint that a document may already be out.
    // Only the identity is projected; the row also holds the full message, and
    // a reconciliation view has no business echoing chat content.
    pendingDeliveries: (await repositories.messagingOutbox.listPending(50)).map((row) => ({
      effectId: row.effectId,
      connectionId: row.connectionId,
    })),
  };
}

/**
 * One task's full durable timeline: identity, execution history/lease state,
 * and every cancellation/approval/effect record naming it — the
 * `tavi tasks <task-id>` view. Looks the task up
 * directly by id (`store.getTask`) rather than filtering `tavi tasks`'
 * bounded 50-row list, so an older task is still found — and, unlike
 * `buildTaskDocument`'s deliberate "50 most recent system-wide" lists, every
 * per-kind field here uses the repository's own by-task lookup
 * (`cancellations.get`, `approvals.listForTask`, `effects.listForTask`) so a
 * shown task's own records can never fall outside someone else's recency
 * window. The one exception is `expiredLeases`: the repository has no
 * by-task variant for it, only a global `listExpiredLeases(now, limit)`
 * scan, so that field alone still inherits a bounded top-50 window and can
 * in principle omit the shown task's own expired lease if 50 *other*
 * executions are also currently expired.
 */
export async function buildTaskShowDocument(
  store: DatabaseClient,
  dataDirectory: string,
  taskId: string,
  now: string,
  /** As `buildTaskDocument`'s. */
  owner?: unknown,
): Promise<Record<string, unknown>> {
  const repositories = (await store.asPort()).repositories;
  const task = await store.getTask(taskId);
  const cancellation = await repositories.cancellations.get(taskId);
  const executions = await repositories.executions.list(taskId);
  // Read once, for the history and the context label.
  const checkpoint = task === undefined ? undefined : await readCheckpointValues(store, task);
  return {
    dataDirectory,
    owner: owner ?? (await readRecordedOwner(dataDirectory)),
    taskId,
    found: task !== undefined,
    task: task ?? null,
    executions,
    ...(task === undefined || checkpoint === undefined
      ? {}
      : {
          history: await taskHistory(store, task, executions, checkpoint),
          // What the chat read that Tavi does not trust, as its checkpoint records it: the header's taint chip.
          contextLabel: checkpointContextLabel(checkpoint),
        }),
    admissions: await repositories.tasks.listAdmissions(taskId),
    expiredLeases: (await repositories.executions.listExpiredLeases(now, 50)).filter((row) => row.taskId === taskId),
    cancellations: cancellation === undefined ? [] : [cancellation],
    pendingApprovals: await withMaskedInputs(
      repositories,
      (await repositories.approvals.listForTask(taskId)).filter((row) => row.state === "pending"),
    ),
    unresolvedEffects: await withMaskedInputs(
      repositories,
      (await repositories.effects.listForTask(taskId)).filter((row) => row.state === "pending" || row.state === "uncertain"),
    ),
  };
}

/**
 * A chat's context label for its header's taint chip
 * (`tasks { action: "label" }`): as the gate reads it now
 * (`checkpoints.contextLabel`: the sticky channel and what
 * the conversation holds), else as its checkpoint records it. `null` when
 * neither can be read.
 */
export async function taskContextLabel(runtime: Pick<TaviRuntime, "workflow" | "store">, task: TaskRecord): Promise<LabelSummary | null> {
  const read = runtime.workflow?.checkpoints.contextLabel;
  if (read !== undefined) {
    try {
      const label = await read(task.threadId);
      return labelSummary(label ?? TRUSTED_PUBLIC);
    } catch {
      // Read from the checkpoint instead.
    }
  }
  try {
    return checkpointContextLabel(await readCheckpointValues(runtime.store, task));
  } catch {
    return null;
  }
}

/**
 * The `doctor` document, built identically for the direct and attached paths.
 *
 * It reports *capabilities*, not credentials: the secret source is described by
 * its access and kind, and the model configuration by what is configured, so this
 * document can be shared with an attached client.
 */
/**
 * `doctor`'s document, typed where the command reads a verdict from it.
 *
 * The exit code comes from `integrity` and `admissionOpen`, so both are typed
 * here rather than reached through a cast from `Record<string, unknown>`, which
 * would fail *open* if the shape ever changed.
 */
export interface DoctorDocument {
  readonly buildId: string;
  /** The Node.js answering against the supported floor: the live owner's when `tavi serve` answers, else this CLI's. */
  readonly node: NodeVersionReport;
  /** On Windows only: whether the Visual C++ runtime the native modules need is installed. */
  readonly vcRuntime?: VcRuntimeReport;
  readonly admissionOpen: boolean;
  readonly integrity: {
    /** False when the check was skipped: an attached run must not read every page of a live database. */
    readonly checked: boolean;
    /** Which check ran: `quick` (`PRAGMA quick_check`, the default) or `full` (`--deep`). */
    readonly mode?: "quick" | "full";
    readonly ok: boolean | null;
    readonly problems: readonly string[];
  };
  readonly migrations: {
    readonly applied: readonly string[];
    readonly latest: string | null;
    readonly unknown: readonly string[];
  };
  /** Admissions an unclean stop (or a failed write) left `claimed`; see `strandedAdmissions`. */
  readonly strandedAdmissions: StrandedAdmissionsReport;
  /** Model use by chat kind and side-chat use, read from local rows only. */
  readonly chatMeasurement: ChatMeasurement;
  /** The heartbeat host and the default operator's heartbeat. */
  readonly heartbeat: Record<string, unknown>;
  /** The default workspace's memory: settings, provider, digest, review and vectors. */
  readonly memory: Record<string, unknown>;
  readonly browser: BrowserBoundary;
  readonly [key: string]: unknown;
}

/**
 * Doctor's `memory` section: the default
 * workspace's memory, gathered from the line each step added. Counts, ids and
 * settings only, never memory text.
 */
async function memoryDoctor(runtime: TaviRuntime): Promise<Record<string, unknown>> {
  const repositories = runtime.store.asPort().repositories;
  const workspace = (await repositories.workspaceSettings.get(DEFAULT_WORKSPACE_ID)).settings;
  const settings = effectiveMemorySettings(workspace.memory);
  // The memory jobs run in every workspace this owner serves: their lines are summed over them all,
  // today counted from the default workspace's midnight.
  const served = runtime.access.workspaceIds();
  const nowIso = runtime.clock.now();
  const now = Date.parse(nowIso);
  const thirtyDaysAgo = new Date(now - 30 * 86_400_000).toISOString();
  const todaySince = startOfLocalDay(new Date(now), workspace.timezone ?? hostTimeZone()).toISOString();
  const marksOverServed = async (kind: "review" | "consolidate") =>
    (
      await Promise.all(served.map((workspaceId) => repositories.transcripts.memoryMarksSince({ workspaceId, kind, since: thirtyDaysAgo })))
    ).flat();
  return {
    // An embedder's memory service in place of the built-in: what backup, export, reset and the memory limits no longer cover.
    ...(runtime.memoryOverridden === true
      ? {
          service: {
            override: true,
            conformance: MEMORY_PORT_CONFORMANCE,
            warning:
              "memory is an embedder's memoryOverride: its records are outside Tavi's tables, so backup, export and tavi reset do not cover them, and the memory limits set with tavi memory (limits.maxRecords) are the override's to enforce",
          },
        }
      : {}),
    // The memory settings: on or paused, whether the model may
    // suggest memory, every kind kept without asking (always shown, even
    // none, as it relaxes the approval gate), and every other key that differs from its default.
    settings: memorySettingsDoctor(workspace.memory),
    // The provider: selected and serving (a fallback in effect, said so), how
    // it indexes and its status, each egress switch, personal included, and how many forgotten records
    // still wait to leave a provider; and the index an external one keeps, which is the plugin's to clear.
    provider: await (async () => {
      const choice = await runtime.memoryProviders.choice(DEFAULT_WORKSPACE_ID);
      const serving = choice.provider;
      const status = serving === undefined ? undefined : readMemoryProviderStatus(serving.provider);
      // Installed providers with an index of their own that the workspace does not select: sent nothing more, holding what they had.
      const unselected = runtime.memoryProviders
        .list()
        .filter((installed) => installed.kind === "plugin" && installed.declaration.index === "own" && installed.id !== choice.chosen)
        .map((installed) => installed.id)
        .sort();
      // The selected one is named when it keeps an index of its own, or when its declaration cannot be read now (a fallback).
      const ownIndex =
        choice.chosen !== BUILTIN_MEMORY_PROVIDER_ID && (choice.fallback !== undefined || serving?.declaration.index === "own");
      const external = [...(ownIndex ? [choice.chosen] : []), ...unselected];
      // Which provider each pending removal waits for, said even of one no workspace selects or that is uninstalled for good:
      // its rows stay pending until it runs again.
      const waiting = await runtime.memoryProviderSync.pendingByProvider();
      return {
        selected: choice.chosen,
        serving: serving?.id ?? null,
        ...(choice.fallback === undefined ? {} : { fallback: choice.fallback }),
        ...(serving === undefined ? {} : { index: serving.declaration.index }),
        ...(status === undefined ? {} : { status }),
        egress: { records: choice.egress.records, conversation: choice.egress.conversation, personal: choice.egress.includePersonal },
        pendingRemovals: await runtime.memoryProviderSync.pendingRemovals(),
        ...(waiting.length === 0
          ? {}
          : {
              pendingRemovalsFor: waiting.map((entry) => ({
                ...entry,
                installed: runtime.memoryProviders.get(entry.provider) !== undefined,
              })),
              pendingNote: `forgotten memories wait to be removed from ${waiting.map((entry) => `${entry.provider} (${entry.removals}${runtime.memoryProviders.get(entry.provider) === undefined ? ", not running" : ""})`).join(", ")}: each is removed when that provider next runs; one uninstalled for good keeps them waiting`,
            }),
        ...(unselected.length === 0 ? {} : { unselectedIndexes: unselected }),
        ...(external.length === 0 ? {} : { note: externalMemoryIndexNote(external) }),
      };
    })(),
    // The review digest: on or off, and when each person's last went out, from the marks.
    digest: await (async () => {
      const marks = await repositories.transcripts.memoryMarksOf({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "digest" });
      const lastByPerson = new Map<string, { readonly principalId: string; readonly taskId: string; readonly at: string }>();
      for (const mark of marks)
        if (!lastByPerson.has(mark.principalId))
          lastByPerson.set(mark.principalId, { principalId: mark.principalId, taskId: mark.taskId, at: mark.at });
      return { digest: workspace.memory?.digest ?? "weekly", lastSent: [...lastByPerson.values()] };
    })(),
    // The idle review: capture on or off, the last review, and today's reviews, proposals
    // filed and dropped, failures, spans skipped after three failures and spend — counts only, from the marks and the ledger,
    // summed over every workspace this owner serves, where the job runs.
    review: await (async () => {
      const month = await marksOverServed("review");
      const spend = await runtime.store.memoryCallSpend({
        workspaceIds: served,
        since: todaySince,
        purpose: "extraction",
        attemptPrefix: MEMORY_REVIEW_ATTEMPT_PREFIX,
      });
      return memoryIdleReviewDoctor({ capture: settings.enabled ? settings.capture : "off", month, todaySince, spend });
    })(),
    // The epoch flush: today's spend on every served workspace's chats — its `summary` calls, by their attempt prefix.
    flush: {
      today: {
        spend: await runtime.store.memoryCallSpend({
          workspaceIds: served,
          since: todaySince,
          purpose: "summary",
          attemptPrefix: EPOCH_FLUSH_ATTEMPT_PREFIX,
        }),
      },
    },
    // Consolidation: off or weekly, the last run and what it drafted and filed, failures
    // and skipped weeks in the last 30 days, and today's spend — counts only, from the marks and the ledger,
    // summed over the served workspaces.
    consolidation: await (async () => {
      const month = await marksOverServed("consolidate");
      const spend = await runtime.store.memoryCallSpend({
        workspaceIds: served,
        since: todaySince,
        purpose: "extraction",
        attemptPrefix: MEMORY_CONSOLIDATION_ATTEMPT_PREFIX,
      });
      return memoryConsolidationDoctor({ consolidation: settings.consolidation, month, spend });
    })(),
    // Hybrid recall's vectors: retrieval, the embedding model, the accepted connections (personal memory's opt-in too), whether
    // personal records are embedded, vectors indexed, missing and failed, the worker's cache, turn recall's p95
    // on this owner and today's embedding spend — counts only. Tavi's own tables, read
    // past the port: under a memoryOverride they hold none of its records, so nothing is said of them.
    ...(runtime.memoryOverridden === true
      ? {}
      : {
          vectors: await memoryVectorsDoctor({
            workspaceId: DEFAULT_WORKSPACE_ID,
            principalId: runtime.access.resolveWorkspace(DEFAULT_WORKSPACE_ID)?.principalId,
            principalIds: workspacePrincipals(
              runtime.access.resolveWorkspace(DEFAULT_WORKSPACE_ID)?.principalId,
              runtime.access.peopleOf(DEFAULT_WORKSPACE_ID),
            ),
            settings,
            memory: repositories.memory,
            embeddings: runtime.embeddings,
            times: runtime.memoryRecallTimes,
            now: nowIso,
            // Today's embedding calls across the owner, found by their attempt-id prefix (the backfill's run is no workspace's task).
            spend: await runtime.store.memoryEmbeddingSpend({
              since: startOfLocalDay(new Date(Date.parse(nowIso)), workspace.timezone ?? hostTimeZone()).toISOString(),
              attemptPrefix: MEMORY_EMBEDDING_ATTEMPT_PREFIX,
            }),
          }),
          // 30-day capture keep rate per revision-1 author prefix: counts only, never memory text. A damaged
          // memory table is said here, not thrown: doctor still reaches its integrity verdict.
          capture: await (async () => {
            try {
              return { days: 30, bySource: await repositories.memory.captureStats({ since: thirtyDaysAgo, now: nowIso }) };
            } catch (error) {
              return { days: 30, unavailable: errorMessage(error, "unreadable").slice(0, 200) };
            }
          })(),
        }),
  };
}

/**
 * Doctor's `taint` section: the default workspace's
 * `security.taint` in force (an owner's `--taint-policy` over it), and the
 * calls the taint step asked — or under `observe` would have asked — in the
 * last 7 days, over every workspace, from `tavi_gate_observations`. Tool ids
 * and counts only.
 */
async function taintDoctor(runtime: TaviRuntime): Promise<Record<string, unknown>> {
  const repositories = runtime.store.asPort().repositories;
  const settings = (await repositories.workspaceSettings.get(DEFAULT_WORKSPACE_ID)).settings;
  const mode = taintModeOf(settings, runtime.taintPolicy);
  const since = new Date(Date.parse(runtime.clock.now()) - GATE_OBSERVATION_DOCTOR_DAYS * 86_400_000).toISOString();
  const summary = await repositories.toolPolicy.summarizeGateObservations(since, GATE_OBSERVATION_TOP_TOOLS);
  return {
    mode,
    ...(runtime.taintPolicy === undefined ? {} : { via: "serve --taint-policy" }),
    days: GATE_OBSERVATION_DOCTOR_DAYS,
    ...summary,
    line: taintDoctorLine(mode, summary),
    ...definedOnly({ warning: weakTaintWarning(mode, runtime.taintPolicy !== undefined) }),
  };
}

/**
 * Doctor's `webSearch` section: whether `web_search` is offered here (a
 * provider is enabled) and whether the default workspace still holds the
 * seeded allow rule that lets a search run without asking. Once removed, the
 * rule is never seeded again, so a search asks each time.
 */
async function webSearchDoctor(runtime: TaviRuntime): Promise<Record<string, unknown>> {
  const rule = await runtime.store.asPort().repositories.toolPolicy.getRule(DEFAULT_WORKSPACE_ID, WEB_SEARCH_ALLOW_RULE_ID);
  const present = rule !== undefined && rule.decision === "allow";
  const offered = runtime.tools.list().some((tool) => tool.id === "web_search");
  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    offered,
    allowRule: { ruleId: WEB_SEARCH_ALLOW_RULE_ID, present },
    line: present
      ? `web searches run without asking (rule ${WEB_SEARCH_ALLOW_RULE_ID}); a query that looks like a key or token still asks. To be asked each time: tavi permissions rm ${WEB_SEARCH_ALLOW_RULE_ID}`
      : `web searches ask each time: the ${WEB_SEARCH_ALLOW_RULE_ID} allow rule was removed, and is not seeded again`,
    ...(offered ? {} : { note: "no search provider is enabled: tavi search add <kind>" }),
  };
}

/**
 * What `tavi doctor` and `serve` start say of a taint mode weaker than
 * `enforce`, or `undefined` for `enforce`: `observe` lets a chat that read
 * untrusted content run what rules and grants allow, unasked.
 */
function weakTaintWarning(mode: TaintMode, viaServe: boolean): string | undefined {
  const fix = viaServe ? "restart serve without --taint-policy, or with --taint-policy enforce" : "tavi permissions taint enforce";
  if (mode === "off") return `security.taint is off: the taint step neither asks nor records, and off is deprecated; ${fix}`;
  if (mode === "observe")
    return `security.taint is observe: after a chat reads a web page, an email or a search result, its calls are decided as if it had not, so injected instructions can run what a rule or grant allows; ${fix}`;
  return undefined;
}

/**
 * The workspaces whose taint mode is weaker than `enforce`, each with what
 * to say of it: `serve` logs them at start. An unreadable setting enforces,
 * as the gate does.
 */
export async function weakTaintWorkspaces(
  runtime: Pick<TaviRuntime, "store" | "taintPolicy" | "access">,
): Promise<readonly { readonly workspaceId: string; readonly mode: TaintMode; readonly warning: string }[]> {
  const repositories = runtime.store.asPort().repositories;
  const found: { workspaceId: string; mode: TaintMode; warning: string }[] = [];
  for (const workspaceId of runtime.access.workspaceIds()) {
    let mode: TaintMode;
    try {
      mode = taintModeOf((await repositories.workspaceSettings.get(workspaceId)).settings, runtime.taintPolicy);
    } catch {
      continue;
    }
    const warning = weakTaintWarning(mode, runtime.taintPolicy !== undefined);
    if (warning !== undefined) found.push({ workspaceId, mode, warning });
  }
  return found;
}

/** The bytes of the files under `directory`, links not followed; 0 when it is not there. */
function directoryBytes(directory: string): number {
  let total = 0;
  const walk = (path: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) total += statSync(child).size;
    }
  };
  walk(directory);
  return total;
}

/** How many damaged reports doctor names; the count covers them all. */
const ROUTINE_REPORTS_LISTED = 50;

/**
 * Doctor's `routineReports` section: every published routine report hashed in
 * full against its manifest. The owner's startup only checks that each file is
 * there at its recorded size, so a report whose bytes changed in place is found
 * here (or when it is opened or delivered, which refuse it). The bytes are
 * streamed in this process, never on the persistence worker.
 */
export async function routineReportsDoctor(
  publication: Pick<RoutinePublicationService, "publishedReports">,
): Promise<Record<string, unknown>> {
  const reports = await publication.publishedReports();
  let damagedCount = 0;
  const damaged: { routineId: string; runId: string; artifactId: string; kind: string; problem: "missing" | "size" | "hash" }[] = [];
  for (const report of reports) {
    const problem = await (async (): Promise<"missing" | "size" | "hash" | undefined> => {
      try {
        const file = await stat(report.path);
        if (!file.isFile()) return "missing";
        if (file.size !== report.byteSize) return "size";
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(report.path)) hash.update(chunk as Buffer);
        return hash.digest("hex") === report.hash ? undefined : "hash";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
      }
    })();
    if (problem === undefined) continue;
    damagedCount += 1;
    if (damaged.length < ROUTINE_REPORTS_LISTED)
      damaged.push({ routineId: report.routineId, runId: report.runId, artifactId: report.artifactId, kind: report.kind, problem });
  }
  return {
    checked: reports.length,
    damaged: damagedCount,
    ...(damaged.length === 0
      ? {}
      : {
          reports: damaged,
          warning: `${String(damagedCount)} published routine report file(s) are missing or do not match what was published; they will not be opened or delivered`,
        }),
  };
}

/**
 * Doctor's `pdf` section: whether the PDF tools are on in the default workspace, and
 * how the single-use parser child is confined on this host — under srt (no
 * network, nothing writable) on macOS, and on Linux whenever the sandbox's
 * tier allows; while it is unavailable, PDF calls are refused, or run bare
 * where serve was started with `--pdf-allow-unconfined`, with the sandbox's
 * fix and `pdf.enabled off` named.
 */
async function pdfDoctor(runtime: TaviRuntime, sandbox: Promise<SandboxStatus>): Promise<Record<string, unknown>> {
  const repositories = runtime.store.asPort().repositories;
  // The engine turned off: its tools are not offered, whatever a workspace's setting says.
  if ((await runtime.plugins.registry.disabledBuiltins()).has(PDF_ENGINE_PLUGIN_ID))
    return { enabled: false, engine: "disabled", note: `\`tavi plugins enable ${PDF_ENGINE_PLUGIN_ID}\` offers the PDF tools again` };
  const enabled = pdfToolsOn((await repositories.workspaceSettings.get(DEFAULT_WORKSPACE_ID)).settings);
  // Every workspace the owner serves where the tools are off, not only the default one.
  const offIn: string[] = [];
  for (const workspaceId of runtime.access.workspaceIds())
    if (!pdfToolsOn((await repositories.workspaceSettings.get(workspaceId)).settings)) offIn.push(workspaceId);
  // OCR changes what a read can check: scans read, covered text compared with the page as drawn.
  let ocr: string;
  try {
    ocr =
      (await pdfOcrAssets()) === undefined
        ? "not installed (scanned pages stay images; covered text is reported, not checked)"
        : "installed";
  } catch (error) {
    // Installed but broken is said so, not hidden as absent.
    ocr = `installed but not loadable: ${errorMessage(error)}`.slice(0, 300);
  }
  const facts = { enabled, ...(offIn.length === 0 ? {} : { offIn }), ocr };
  const check = await sandbox;
  const confinement = pdfConfinement({
    host: runtime.sandboxHost,
    ...(runtime.pdfAllowUnconfined === true ? { allowUnconfined: true } : {}),
  });
  return { ...facts, ...pdfConfinementFacts(confinement, check) };
}

/** The `pdf` section's confinement facts: how the parser child runs here, and what to do where it is refused or bare. */
export function pdfConfinementFacts(confinement: ReturnType<typeof pdfConfinement>, check: SandboxStatus): Record<string, unknown> {
  const because = check.cause === undefined ? "" : `, because ${check.cause}`;
  if (confinement === "refused") {
    // Refused while the sandbox is unavailable here; the sandbox's own fix confines it, or the owner allows it bare.
    return {
      confinement: "refused",
      note: `the sandbox is unavailable on this host${because}, so PDF calls are refused: ${check.fix === undefined ? "fix the sandbox (tavi sandbox setup)" : check.fix}, or start serve with --pdf-allow-unconfined`,
    };
  }
  if (confinement === "unconfined") {
    // Bare by the owner's choice; the sandbox's own fix confines it.
    return {
      confinement: "unconfined",
      note: `serve was started with --pdf-allow-unconfined and the sandbox is unavailable${because}: the PDF parser child runs unconfined (it has your files' view; PDFium runs in WebAssembly, capped in memory and time); ${check.fix === undefined ? "" : `${check.fix} confines it, and `}\`tavi config set pdf.enabled off\` turns the PDF tools off`,
    };
  }
  return sandboxConfines(check)
    ? { confinement: "srt" }
    : {
        confinement: "srt",
        works: false,
        cause: check.cause,
        note: "the PDF tools fail until srt works here; `tavi config set pdf.enabled off` turns them off meanwhile",
      };
}

/**
 * Doctor's `video` section: whether the video tools are on (and in which
 * workspaces they are off), the person's FFmpeg and what its build lacks,
 * or how to install one, and how its runs are confined here.
 */
async function videoDoctor(runtime: TaviRuntime, sandbox: Promise<SandboxStatus>): Promise<Record<string, unknown>> {
  const repositories = runtime.store.asPort().repositories;
  if ((await runtime.plugins.registry.disabledBuiltins()).has(VIDEO_ENGINE_PLUGIN_ID))
    return { enabled: false, engine: "disabled", note: `\`tavi plugins enable ${VIDEO_ENGINE_PLUGIN_ID}\` offers the video tools again` };
  const enabled = videoToolsOn((await repositories.workspaceSettings.get(DEFAULT_WORKSPACE_ID)).settings);
  const offIn: string[] = [];
  for (const workspaceId of runtime.access.workspaceIds())
    if (!videoToolsOn((await repositories.workspaceSettings.get(workspaceId)).settings)) offIn.push(workspaceId);
  try {
    const check = await sandbox;
    return {
      enabled,
      ...(offIn.length === 0 ? {} : { offIn }),
      ...(await runtime.videoDoctor({ works: sandboxConfines(check), cause: check.cause, fix: check.fix })),
    };
  } catch (error) {
    return { enabled, ...(offIn.length === 0 ? {} : { offIn }), ffmpeg: "unreadable", detail: errorMessage(error).slice(0, 300) };
  }
}

/** Doctor's `video` section alone, for Settings → Models (`models video-status`): a page may not read `doctor`. */
export function videoStatusDocument(runtime: TaviRuntime): Promise<Record<string, unknown>> {
  return videoDoctor(runtime, runtime.sandboxHost.check());
}

/**
 * Doctor's `mcp` section: whether MCP is
 * on; the live sandbox test a stdio server would run under; whether `uv` is there (Python servers); each server's
 * state, open notices and files (a full verify); the MCP tools registered,
 * their schema tokens against the budget; hosts that reach the internet only
 * through a proxy (remote servers connect directly); and, under `observe`, the
 * MCP calls the taint step would have asked.
 */
async function mcpDoctor(runtime: TaviRuntime, check: Promise<SandboxStatus>): Promise<Record<string, unknown>> {
  const repositories = runtime.store.asPort().repositories;
  const enabled = mcpEnabledOf(await runtime.store.getMeta(MCP_ENABLED_SETTING));
  const sandbox = await check;
  const uvPath = findUv();
  const servers = [];
  for (const view of await runtime.plugins.registry.list()) {
    if (view.kind !== "mcp") continue;
    const verified =
      view.activeVersion === undefined
        ? undefined
        : await runtime.plugins.registry
            .verifyMcp(view.id, view.activeVersion, true)
            .catch((error: unknown) => ({ ok: false, problem: errorMessage(error), files: 0, rehashed: 0 }));
    // What it takes on disk (fetched packages are large): each version kept, and its home; an old version is removable.
    const versions = view.versions.map((candidate) => ({
      version: candidate.version,
      bytes: directoryBytes(runtime.plugins.registry.snapshotDirectory(view.id, candidate.version)),
    }));
    servers.push({
      disk: { versions, homeBytes: directoryBytes(join(runtime.dataDirectory, "mcp", view.id)) },
      ...runtime.mcp.supervisor.status(view.id),
      enabled: view.enabled,
      openNotices: (await repositories.mcp.listNotices({ pluginId: view.id, open: true })).map((notice) => notice.kind),
      ...(verified === undefined
        ? {}
        : { files: verified.ok ? { ok: true, count: verified.files } : { ok: false, problem: verified.problem } }),
    });
  }
  const mcpTools = runtime.tools.list().filter((tool) => tool.id.startsWith("mcp."));
  // As the model is sent each tool: its model name, description and input schema (the review counts the same way).
  const tokensOf = (tools: typeof mcpTools): number =>
    tools.reduce(
      (total, tool) =>
        total +
        schemaTokenCount({
          name: runtime.tools.modelNameOf(tool.id) ?? tool.id,
          description: tool.description,
          parameters: runtime.tools.inputJsonSchemaOf(tool.id) ?? {},
        }),
      0,
    );
  const schemaTokens = tokensOf(mcpTools);
  const listedTools = mcpTools.filter((tool) => tool.deferred !== true);
  const listed = listedTools.length;
  // Per surface: what the listed MCP tools of the servers a workspace allows cost each of its
  // operator's model calls; a deferred server's cost nothing until searched.
  const surfaces = [];
  for (const workspaceId of runtime.access.workspaceIds()) {
    const settings = (await repositories.workspaceSettings.get(workspaceId)).settings;
    const tokens = tokensOf(listedTools.filter((tool) => mcpServerAllowed(settings, `${MCP_PLUGIN_PREFIX}${tool.id.split(".")[1] ?? ""}`)));
    surfaces.push({
      workspaceId,
      schemaTokens: tokens,
      ...(tokens > MCP_SCHEMA_TOKENS_WARN
        ? {
            warning: `MCP tool schemas take about ${String(tokens)} tokens of every model call in ${workspaceId}; set large servers' exposure to search`,
          }
        : {}),
    });
  }
  const proxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].find(
    (name) => (process.env[name] ?? "") !== "",
  );
  const since = new Date(Date.parse(runtime.clock.now()) - GATE_OBSERVATION_DOCTOR_DAYS * 86_400_000).toISOString();
  const observed = (await repositories.toolPolicy.summarizeGateObservations(since, 500)).topTools
    .filter((entry) => entry.toolId.startsWith("mcp."))
    .reduce((total, entry) => total + entry.calls, 0);
  return {
    enabled,
    ...(enabled ? {} : { note: "MCP is off: no server runs and no MCP tool is offered (tavi mcp on)" }),
    sandbox: sandboxConfines(sandbox)
      ? { works: true }
      : {
          works: false,
          cause: sandbox.cause,
          fix: "a stdio server runs only with --unsandboxed (or --nested in a container that masks /proc) until this is fixed",
        },
    // Python servers are fetched with uv and run on an interpreter it manages.
    // A Node server granted domains reaches them through its proxy only on Node 22.21 or later.
    node: {
      version: process.versions.node,
      ...(nodeHonoursEnvProxy()
        ? {}
        : {
            note: `Node ${process.versions.node} is older than 22.21: a Node MCP server granted a domain will not start; upgrade Node (same LTS line)`,
          }),
    },
    uv:
      uvPath === undefined
        ? { found: false, note: "Python MCP servers (--pypi) need uv on PATH: https://docs.astral.sh/uv/, then `uv python install 3.12`" }
        : { found: true, path: uvPath },
    servers,
    tools: { registered: mcpTools.length, listed, limit: runtime.mcp.bridge.limit(), schemaTokens, surfaces },
    ...(proxy === undefined
      ? {}
      : {
          proxy: `${proxy} is set: remote MCP servers connect directly, never through it; a host that reaches the internet only through a proxy cannot use them`,
        }),
    taintObserved: { days: GATE_OBSERVATION_DOCTOR_DAYS, calls: observed },
  };
}

/** `doctor`'s `audit` for one plugin (`inProcessAudit`); a snapshot it cannot read is said, never thrown. */
function doctorPluginAudit(
  registry: TaviRuntime["plugins"]["registry"],
  plugin: PluginView,
): { readonly audit?: { readonly workerRefusal?: string; readonly findings: readonly string[] } | { readonly error: string } } {
  try {
    const entry = inProcessAudit(registry, plugin);
    return entry === undefined
      ? {}
      : { audit: { ...(entry.workerRefusal === undefined ? {} : { workerRefusal: entry.workerRefusal }), findings: entry.findings } };
  } catch (error) {
    return { audit: { error: errorMessage(error) } };
  }
}

export async function buildDoctorDocument(
  runtime: TaviRuntime,
  options: {
    /**
     * `quick` (the default) runs `PRAGMA quick_check`; `full` (`tavi doctor
     * --deep`) runs SQLite's complete check, which also checks every index
     * against its table. `skip` is for the attached path: either check reads
     * every page of the database synchronously, so running it inside the
     * daemon's own process would block the IPC loop — and the scheduler — for
     * as long as the file takes to read.
     */
    readonly integrity?: "quick" | "full" | "skip";
    /** The owner's health trend (`features/doctor/health.ts`); only a live owner has one. */
    readonly health?: HealthTrend;
  } = {},
): Promise<DoctorDocument> {
  // One live srt check (it spawns srt, up to 20 s) answers both the MCP and the PDF sections.
  // `doctor` probes again, and the answer becomes the runtime's (a fixed host needs no restart).
  const sandboxCheck = runtime.sandboxHost.check();
  // A read-only projection of stored configuration, deliberately not routed
  // through `ModelConfigService`: a report needs no validation, and creating a
  // service here would imply this command may edit what it is describing.
  const repository = runtime.store.asPort().repositories.modelConfig;
  const connections = await repository.listConnections();
  const bindings = await repository.listRoleBindings(DEFAULT_WORKSPACE_ID);
  const workspaceDefault = await repository.getWorkspaceDefault(DEFAULT_WORKSPACE_ID);
  const vcRuntime = vcRuntimeReport();
  return {
    buildId: runtime.host.buildId,
    node: nodeVersionReport(),
    ...(vcRuntime === undefined ? {} : { vcRuntime }),
    admissionOpen: runtime.host.admissionOpen,
    plugins: runtime.host.status(),
    // Open browser sessions: in use, and inactive — kept for a chat's next turn, each holding a browser context until closed.
    browserSessions: await runtime.store.asPort().repositories.browserHistory.counts(),
    // How the browser is bounded: confined in srt or not and why, Chromium's own sandbox, and whether its cap fits.
    browser: await runtime.browserBoundary(),
    // Every plugin the registry knows, with its phase here: an external one that failed to load
    // (or, from an offline doctor, one verified without being imported) is not in the host's list.
    pluginRegistry: (await runtime.plugins.registry.list(runtime.plugins)).map((plugin) => ({
      id: plugin.id,
      kind: plugin.kind,
      enabled: plugin.enabled,
      core: plugin.core,
      ...definedOnly({
        activeVersion: plugin.activeVersion,
        phase: plugin.phase,
        error: plugin.error,
      }),
      awaitingReview: plugin.versions.filter((version) => version.reviewState === "proposed").map((version) => version.version),
      // What it adds to the web canvas: each contribution's slots, channels and disclosure.
      ...(plugin.ui === undefined
        ? {}
        : {
            ui: plugin.ui.contributions.map((contribution) => ({
              id: contribution.id,
              ...(contribution.role === undefined ? {} : { role: contribution.role }),
              slots: contribution.placements.map((placement) => placement.slot),
              channels: contribution.channels,
              ...(contribution.disclosure === undefined ? {} : { disclosure: contribution.disclosure }),
            })),
          }),
      ...(plugin.uiOnly === true ? { uiOnly: true } : {}),
      // Where its code runs: a worker, or UNSANDBOXED in the owner's process (approved so, or before workers).
      ...(plugin.kind === "external" && plugin.runsOwnerCode
        ? { isolation: plugin.isolation ?? "in-process", ...(plugin.isolation === "process" ? {} : { unsandboxed: true }) }
        : {}),
      // An enabled one in the owner's process: what it would lose as a worker, as `tavi plugins audit` reads it.
      ...doctorPluginAudit(runtime.plugins.registry, plugin),
      // Its hooks into the turn and its slash commands: what each does and how it fails.
      ...(plugin.mods === undefined
        ? {}
        : {
            hooks: plugin.mods.map((hook) => ({
              event: hook.event,
              ...(hook.match === undefined ? {} : { match: hook.match }),
              onFailure: hook.onFailure,
              disclosure: hook.disclosure,
              reads: hook.reads,
              ...(hook.contextTrusted === true ? { contextTrusted: true } : {}),
            })),
          }),
      ...(plugin.commands === undefined ? {} : { commands: plugin.commands.map((command) => command.name) }),
    })),
    // A canvas role whose chosen plugin can no longer fill it: the built-in stands in, or nothing does.
    uiRoleFallbacks: await (async () => {
      const settings = (await runtime.store.asPort().repositories.workspaceSettings.get(DEFAULT_WORKSPACE_ID)).settings;
      const { fallbacks } = resolveContributions(pluginUiEntries(await runtime.plugins.registry.list(runtime.plugins)), settings);
      return fallbacks.map((fallback) => ({
        workspaceId: DEFAULT_WORKSPACE_ID,
        ...fallback,
        warning: `${fallback.wanted} is chosen as the ${fallback.role} but is not enabled and approved, or no longer offers one; ${fallback.using === undefined ? "none is shown" : `${fallback.using} is used meanwhile`}`,
      }));
    })(),
    // Routing that is switched on but whose selected provider cannot run here.
    routerProviders: await Promise.all(
      (await runtime.routerRepository.selections())
        .filter((selection) => selection.enabled)
        .map(async (selection) => {
          const state = await routerProviderState(runtime.plugins.registry, selection.provider, {
            ...runtime.plugins,
            providers: runtime.routerProviders,
          });
          const candidate = await routerProviderCandidate(runtime.plugins.registry, selection.provider);
          const usable =
            candidate.ok &&
            candidate.enabled &&
            (state.state === "running" || (state.state === "enabled" && runtime.plugins.status(selection.provider).phase === "verified"));
          const pricing = await routerProviderPricing(runtime.plugins.registry, selection.provider, runtime.routerProviders);
          const priceReady =
            pricing !== undefined &&
            routerPriceReady(
              await runtime.modelAccounting.price(pricing.connectionId, pricing.model, runtime.clock.now()),
              selection.priceRevision,
              selection.provider,
            );
          const warning = !usable
            ? candidate.ok
              ? `routing is on but ${selection.provider} is ${state.state}; it stays off until the provider runs`
              : `routing is on but ${candidate.reason}`
            : !priceReady
              ? `routing is on but no price sheet for ${selection.provider} matches priceRevision ${selection.priceRevision ?? "(unset)"}; its decisions abstain`
              : undefined;
          return { ...selection, ...state, priceReady, ...(warning === undefined ? {} : { warning }) };
        }),
    ),
    heartbeat: await heartbeatDoctor(runtime),
    // Scheduled work: what the default workspace's schedules and routines spent this month, against its budget.
    scheduledWork: await scheduledWorkDoctor(runtime),
    // Ideas: the default workspace's provider, whether it runs and says it is ready, and its last run.
    ideas: await ideasDoctor(runtime),
    // Onboarding: the flow in use, and each step's state as tavi onboard status says it.
    onboarding: await onboardingDoctor(runtime),
    // Published routine reports, each hashed in full against what was published.
    routineReports: await routineReportsDoctor(runtime.routinePublication).catch((error: unknown) => ({
      checked: 0,
      problem: errorMessage(error).slice(0, 300),
    })),
    // Memory, in one section: each step's line under its own key.
    memory: await memoryDoctor(runtime),
    // The taint gate: the mode in force and what it asked, or would have asked, in 7 days.
    taint: await taintDoctor(runtime),
    // The credential store: whether it is encrypted at rest, and a warning when values sit in it plain.
    credentialStore: {
      encrypted: credentialsEncrypted(runtime.dataDirectory),
      ...definedOnly({ warning: await plainCredentialStoreWarning(runtime.dataDirectory) }),
    },
    // Web search: whether it is offered, and whether the seeded rule still lets it run without asking.
    webSearch: await webSearchDoctor(runtime),
    // The sandbox: one tier for sandbox.run, MCP servers and the PDF children, with its cause and fix.
    // Its facts through the host port, so an override is the host it describes; with what the engine could not express here.
    sandbox: await (async () => {
      const status = await sandboxCheck;
      const facts = await runtime.sandboxHost.facts();
      return sandboxDoctorSection(
        {
          ...status,
          checks: [...status.checks, ...engineWarnings(runtime.sandbox), ...parentProxyChecks(process.env, runtime.sandboxParentProxy)],
        },
        facts,
        undefined,
        runtime.limits.capabilities(),
        runtime.sandboxLimits === undefined ? undefined : { run: runtime.sandboxLimits },
        runtime.sandboxOptions,
      );
    })(),
    // MCP servers: whether a stdio server can run sandboxed here, with the fix when not.
    mcp: await mcpDoctor(runtime, sandboxCheck),
    // The PDF tools: whether they are on, and whether their parser child runs confined here.
    pdf: await pdfDoctor(runtime, sandboxCheck),
    // The video tools: the person's FFmpeg, its build, and how its runs are confined here.
    video: await videoDoctor(runtime, sandboxCheck),
    tools: runtime.tools.list(),
    applicationTables: await runtime.store.listApplicationTables(),
    saverTables: await runtime.store.listSaverTables(),
    // The shape the pinned saver was last set up with, versus the shape
    // this build expects. A mismatch means the directory was used by a different
    // pin — `CREATE TABLE IF NOT EXISTS` will not reshape it, so the failure
    // would otherwise appear inside a graph run. `missingColumns` is the part
    // that can be checked against reality rather than against the marker: it
    // reads `checkpoints`/`writes` themselves.
    saverSchema: await (async () => {
      const recorded = (await runtime.store.getMeta(SAVER_SCHEMA_VERSION_KEY)) ?? null;
      const missingColumns = Object.fromEntries(
        (
          await Promise.all(
            Object.entries(SAVER_EXPECTED_COLUMNS).map(async ([table, expected]) => {
              const actual = new Set(await runtime.store.tableColumns(table));
              return [table, expected.filter((column) => !actual.has(column))] as const;
            }),
          )
        ).filter(([, missing]) => missing.length > 0),
      );
      return {
        expected: SAVER_SCHEMA_VERSION,
        recorded,
        matches: (recorded === null || recorded === String(SAVER_SCHEMA_VERSION)) && Object.keys(missingColumns).length === 0,
        missingColumns,
      };
    })(),
    meta: await runtime.store.listMeta(),
    // The check that has to happen *before* the disk is full, because the
    // alert about a full disk is itself a database write.
    disk: diskStatus(runtime.dataDirectory),
    // The tables a daily daemon grows without bound. Their size is the
    // operator's early warning; `inboxUnprocessed` is the count that would not
    // shrink on its own.
    transport: await runtime.store.transportRowCounts(),
    // Integrity and migration status: SQLite's own verdict on the file, and the
    // migration ledger against the ones this build ships. `quick` unless the
    // operator asks for `--deep`, as the daemon's own startup does; an
    // *attached* `doctor` skips it entirely.
    integrity: await (async () => {
      const mode = options.integrity ?? "quick";
      return mode === "skip"
        ? { checked: false, ok: null, problems: [] }
        : { checked: true, mode, ...(await runtime.store.integrityCheck(mode)) };
    })(),
    // The owner's resident memory, open descriptors and children, sampled every 10 minutes, and
    // any that grew more than twofold over 6 hours. Only a running owner has samples.
    health:
      options.health ??
      ({ running: false, note: "the health trend is the running owner's: start tavi serve, and doctor reports it" } as const),
    migrations: await runtime.store.migrationStatus(),
    checkpoints: await runtime.checkpointCount(),
    modelTransport: runtime.workflow !== undefined,
    secretSource: runtime.secretSource,
    modelConfiguration: {
      connections: connections.map((connection) => ({
        connectionId: connection.connectionId,
        label: connection.label,
        kind: connection.kind,
        credentialRef: connection.credentialRef,
        localOnly: connection.localOnly,
        // Sign in with ChatGPT's Responses wire takes no output cap and no temperature: said, so a cap is not assumed.
        ...(connection.wireApi === "responses"
          ? { note: "the Responses wire drops output caps (maxOutputTokens) and temperature: no cap applies to this connection's calls" }
          : {}),
      })),
      workspaceDefault: workspaceDefault ?? null,
      roles: bindings,
    },
    strandedAdmissions: await strandedAdmissions(runtime),
    // Local measurement, never uploaded: per-turn input
    // tokens and summarizer calls by chat kind, and how side chats are used.
    // Definitions live on `ChatMeasurement` in the runtime's `chat-measurement.ts`.
    chatMeasurement: await runtime.store.chatMeasurement({ now: runtime.clock.now() }),
  };
}

/** How many admissions left `claimed` `doctor` lists, of how many it reads. */
const STRANDED_ADMISSIONS = { listed: 50, scanned: 1000 } as const;

/** One admission left `claimed` with no outcome that no turn of the answering process is running. */
interface StrandedAdmission {
  readonly taskId: string;
  readonly admissionId: string;
  readonly operationKey: string;
  readonly kind: AdmissionKind;
  readonly claimedAt: string;
  /**
   * What holds the task's slot: `held` by an owner that is gone (or by one this
   * report cannot see); `busy` with another turn of this very owner;
   * `recovered`, its own execution terminated by `tavi recover`; or `free`.
   */
  readonly slot: "held" | "busy" | "recovered" | "free";
  /** The execution holding the task's slot, while one is active. */
  readonly execution: {
    readonly generation: number;
    readonly ownerSession: string;
    /** The admission that execution runs — not necessarily this one. */
    readonly admissionId: string;
    readonly leaseExpiresAt: string;
    readonly expired: boolean;
  } | null;
  readonly remedy: string;
}

/**
 * What `tavi serve` logs at start for each stranded turn: one plain warning a
 * reader of `tavi logs` acts on, pointing at `tavi doctor` for the step that
 * frees it.
 */
export function strandedTurnWarnings(
  report: StrandedAdmissionsReport,
): readonly { readonly message: string; readonly fields: Record<string, string> }[] {
  return [
    ...report.admissions.map((admission) => ({
      message: `a turn of task ${admission.taskId} was cut off when an owner stopped; \`tavi doctor --format text\` says how to free it`,
      fields: { taskId: admission.taskId, admissionId: admission.admissionId, slot: admission.slot },
    })),
    ...(report.truncated ? [{ message: "more turns were cut off than were listed; `tavi doctor` lists them", fields: {} }] : []),
  ];
}

export interface StrandedAdmissionsReport {
  /** Newest first. */
  readonly admissions: readonly StrandedAdmission[];
  readonly truncated: boolean;
}

/**
 * Admissions left `claimed` with no outcome that no turn of this process is
 * running — usually a turn an unclean stop cut off, sometimes
 * one a failed write left behind. Nothing re-admits one automatically:
 * retrying its operation key does, once its slot is free, so each is reported
 * with what holds the slot and the step that settles it. One superseded by a
 * later settled admission of its task, or on a cancelled task, needs nothing.
 */
export async function strandedAdmissions(runtime: TaviRuntime): Promise<StrandedAdmissionsReport> {
  const repositories = runtime.store.asPort().repositories;
  const now = runtime.clock.now();
  const stranded = (
    await Promise.all(
      (
        await runtime.store.listClaimedAdmissions(STRANDED_ADMISSIONS.scanned)
      ).map(async (claimed): Promise<StrandedAdmission[]> => {
        const lease = claimed.execution;
        // A turn this process is running right now is not stranded.
        if (isRunningHere({ ...claimed, state: "claimed", result: null }, lease, runtime.ownerSession)) return [];
        // Settled past, or final: nothing left to do for it.
        const settled = await repositories.tasks.latestSettledAdmission(claimed.taskId);
        if (settled !== undefined && settled.createdAt > claimed.createdAt) return [];
        if ((await repositories.cancellations.get(claimed.taskId)) !== undefined) return [];

        const active = lease?.state === "active" ? lease : undefined;
        const retry =
          `retry its operation key \`${claimed.operationKey}\` (\`tavi run --operation-key\`, or the same decision sent again) to settle it, ` +
          `or \`tavi cancel ${claimed.taskId} --reason <text>\``;
        let slot: StrandedAdmission["slot"];
        let remedy: string;
        if (active !== undefined && active.ownerSession === runtime.ownerSession) {
          slot = "busy";
          remedy = `this owner is running another turn of the task (admission ${active.admissionId}); once it ends, ${retry}`;
        } else if (active !== undefined) {
          slot = "held";
          remedy = `${recoverCommand(claimed.taskId, active.generation)} frees the slot once its owner is confirmed gone; then ${retry}`;
        } else if (lease?.state === "terminated" && lease.admissionId === claimed.admissionId) {
          slot = "recovered";
          remedy = `its execution was recovered; ${retry}`;
        } else {
          slot = "free";
          remedy = `nothing holds the task's slot; ${retry} — \`tavi tasks ${claimed.taskId}\` shows where it stands`;
        }
        return [
          {
            taskId: claimed.taskId,
            admissionId: claimed.admissionId,
            operationKey: claimed.operationKey,
            kind: claimed.kind,
            claimedAt: claimed.claimedAt,
            slot,
            execution:
              active === undefined
                ? null
                : {
                    generation: active.generation,
                    ownerSession: active.ownerSession,
                    admissionId: active.admissionId,
                    leaseExpiresAt: active.leaseExpiresAt,
                    expired: active.leaseExpiresAt <= now,
                  },
            remedy,
          },
        ];
      }),
    )
  ).flat();
  return { admissions: stranded.slice(0, STRANDED_ADMISSIONS.listed), truncated: stranded.length > STRANDED_ADMISSIONS.listed };
}

/** A provider's own `status()`, read without trusting it: absent, throwing or malformed is no status. */
function providerSelfStatus(provider: HeartbeatProvider | undefined): { readonly ready: boolean; readonly detail?: string } | undefined {
  if (typeof provider?.status !== "function") return undefined;
  try {
    const answer: unknown = provider.status();
    if (answer === null || typeof answer !== "object" || typeof (answer as { ready?: unknown }).ready !== "boolean") return undefined;
    const detail = (answer as { detail?: unknown }).detail;
    return {
      ready: (answer as { ready: boolean }).ready,
      ...(typeof detail === "string" && detail !== ""
        ? { detail: (redactToolOutput({ detail }).value as { detail: string }).detail.slice(0, 200) }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** Onboarding in doctor: the flow in use, and each step's state in the terminal's order. */
async function onboardingDoctor(runtime: TaviRuntime): Promise<Record<string, unknown>> {
  try {
    const status = await onboardingStatus(ownerOnboardingDependencies(runtime), DEFAULT_WORKSPACE_ID, "cli");
    return {
      providerId: status.providerId,
      complete: status.complete,
      firstRun: status.firstRun,
      steps: Object.fromEntries(
        status.steps.map((step) => [step.kind, { state: step.state, ...(step.detail === "" ? {} : { detail: step.detail }) }]),
      ),
      ...(status.flowFallback === undefined ? {} : { flowFallback: status.flowFallback }),
      ...(status.complete ? {} : { warning: "the model is not set up and verified: run tavi onboard" }),
    };
  } catch (error) {
    return { warning: errorMessage(error, "the onboarding status cannot be read") };
  }
}

/** Ideas in doctor: whether the default workspace's provider runs and is ready, and how its last run went. */
async function ideasDoctor(runtime: TaviRuntime): Promise<Record<string, unknown>> {
  const ideas = runtime.store.asPort().repositories.ideas;
  let settings;
  try {
    settings = (await ideas.settings(DEFAULT_WORKSPACE_ID)).settings;
  } catch (error) {
    return { warning: errorMessage(error, "the ideas settings cannot be read") };
  }
  const entry = runtime.ideas.providers.list().find((provider) => provider.id === settings.provider);
  const lastRun = await ideas.lastRun(DEFAULT_WORKSPACE_ID);
  const repositories = runtime.store.asPort().repositories;
  const fastModel = (await repositories.modelConfig.listRoleBindings(DEFAULT_WORKSPACE_ID)).some((binding) => binding.role === "fast");
  const principalId = runtime.access.resolveWorkspace(DEFAULT_WORKSPACE_ID)?.principalId;
  const digestReachable =
    settings.digest === undefined || principalId === undefined
      ? undefined
      : await runtime.ideas.digestReachable(DEFAULT_WORKSPACE_ID, principalId, settings.digest.channel);
  const dayAgo = new Date(Date.parse(runtime.clock.now()) - 24 * 60 * 60_000).toISOString();
  const warnings = [
    ...(settings.enabled && settings.dailyTokens > 0 && !fastModel
      ? ["no fast model is set: ideas keep their plain wording (tavi models roles set fast …)"]
      : []),
    ...(digestReachable === false
      ? [`the weekly ideas digest has no chat of yours on connection ${settings.digest?.channel ?? ""} to go to: it is skipped every week`]
      : []),
    ...(settings.enabled && entry === undefined
      ? [
          `ideas are on but their provider ${settings.provider} is not installed or not running; its runs are skipped until it runs, or tavi.ideasagent is chosen`,
        ]
      : []),
    ...(settings.enabled && entry !== undefined && !entry.ready ? [`the ideas provider ${settings.provider} says it is not ready`] : []),
    ...(lastRun?.outcome === "failed" ? [`the last ideas run failed: ${lastRun.reason ?? "no reason recorded"}`] : []),
  ];
  return {
    enabled: settings.enabled,
    providerId: settings.provider,
    providerReady: entry?.ready ?? false,
    volume: settings.volume,
    dailyTokens: settings.dailyTokens,
    hours: settings.hours,
    fastModel,
    ...(settings.digest === undefined
      ? {}
      : { digest: { ...settings.digest, ...(settings.digestSent === undefined ? {} : { lastSentOn: settings.digestSent.on }) } }),
    // The prepared steps of the last day: how many ran, and what they spent.
    prepared: await ideas.preparedSince(DEFAULT_WORKSPACE_ID, dayAgo),
    ...(lastRun === undefined
      ? {}
      : {
          lastRun: {
            at: lastRun.startedAt,
            trigger: lastRun.trigger,
            outcome: lastRun.outcome,
            ...(lastRun.reason === undefined ? {} : { reason: lastRun.reason }),
          },
        }),
    ...(warnings.length === 0 ? {} : { warning: warnings.join("; ") }),
  };
}

/**
 * Scheduled work as `tavi doctor` reports it: what the default workspace's
 * schedules and routines, with their workers, spent this calendar month in its
 * zone, in tokens and (when every call had a price sheet) dollars, and its
 * share of `scheduled.monthlyTokenBudget` when one is set.
 */
async function scheduledWorkDoctor(runtime: TaviRuntime): Promise<Record<string, unknown>> {
  const repositories = runtime.store.asPort().repositories;
  const usage = await scheduledWorkThisMonth(repositories, DEFAULT_WORKSPACE_ID, new Date(runtime.clock.now()));
  const notice = usage.percent !== undefined && usage.percent >= SCHEDULED_BUDGET_NOTICE_PERCENT;
  return {
    month: usage.month,
    timezone: usage.timezone,
    tokens: usage.tokens,
    // An unpriced model's spending is unknown in dollars, never shown as free.
    usd: usage.usd ?? "unknown",
    ...(usage.budget === undefined ? {} : { budget: usage.budget, percent: usage.percent }),
    ...(notice ? { warning: `scheduled work used ${usage.percent}% of this month's ${usage.budget}-token budget` } : {}),
  };
}

/**
 * The heartbeat as `tavi doctor` reports it: whether the host runs
 * here, and the default workspace operator's heartbeat — on, its provider and whether that is
 * installed (and what it says of itself), the next check, any pause and why, and today's checks.
 */
async function heartbeatDoctor(runtime: TaviRuntime): Promise<Record<string, unknown>> {
  const host = runtime.heartbeat.host() !== undefined;
  const principalId = runtime.access.resolveWorkspace(DEFAULT_WORKSPACE_ID)?.principalId;
  if (principalId === undefined) return { host };
  const repositories = runtime.store.asPort().repositories;
  let state;
  try {
    state = await repositories.heartbeats.get(DEFAULT_WORKSPACE_ID, principalId);
  } catch (error) {
    return { host, warning: errorMessage(error, "the heartbeat's settings cannot be read") };
  }
  if (state === undefined) return { host, configured: false };
  const timezone = (await repositories.workspaceSettings.get(DEFAULT_WORKSPACE_ID)).settings.timezone ?? hostTimeZone();
  const since = startOfLocalDay(new Date(runtime.clock.now()), timezone).toISOString();
  const ticks = await repositories.heartbeats.listTicks({ workspaceId: DEFAULT_WORKSPACE_ID, principalId, since, limit: 500 });
  const usage = await repositories.heartbeats.usageSince({ workspaceId: DEFAULT_WORKSPACE_ID, principalId, since });
  const providerId = state.config.providerId;
  const entry = providerId === "off" ? undefined : runtime.heartbeat.providers.get(providerId);
  const providerReady = providerId === "off" || entry !== undefined;
  // What the provider says of itself (`status()`), when it answers one: its words are untrusted, so bounded and masked.
  const providerStatus = providerSelfStatus(entry?.provider);
  const warnings = [
    ...(state.config.enabled && !host
      ? ["the heartbeat is on but no host runs here: tavi.heartbeat is disabled, or this is not the owner"]
      : []),
    ...(state.config.enabled && host && !providerReady
      ? [`the heartbeat's provider ${providerId} is not installed; the heartbeat pauses until it is, or the built-in is chosen`]
      : []),
    ...(state.config.enabled && providerStatus?.ready === false
      ? [
          `the heartbeat's provider ${providerId} says it is not ready${providerStatus.detail === undefined ? "" : `: ${providerStatus.detail}`}`,
        ]
      : []),
  ];
  return {
    host,
    configured: true,
    enabled: state.config.enabled,
    providerId,
    providerReady,
    ...definedOnly({
      providerStatus,
      nextTickAt: state.nextTickAt,
      paused: state.config.paused,
    }),
    // An unpriced model's spending is unknown in dollars, never shown as free.
    // Checks that ran, as Center → Heartbeat counts them: not skips, waits, closed hours or summaries.
    today: {
      checks: ticks.filter(heartbeatCheckRan).length,
      modelTicks: usage.modelTicks,
      tokens: usage.tokens,
      usd: usage.usd ?? "unknown",
    },
    ...(warnings.length === 0 ? {} : { warning: warnings.join("; ") }),
  };
}
