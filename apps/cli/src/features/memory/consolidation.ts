import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MEMORY_LIST_PAGE_MAX,
  localDateTime,
  type EffectiveMemorySettings,
  type MemoryActor,
  type MemoryProvider,
  type MemoryRecord,
  type MemoryRevision,
  type MemoryServicePort,
  type ModelPort,
  type ModelTarget,
  type PersistencePort,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import {
  MEMORY_CONSOLIDATION_RECORDS_MAX,
  runMemoryConsolidation,
  type ConsolidationDropCounts,
  type ConsolidationRecord,
} from "@tavi/agent-host/workflow";

import { daysBetween, localDateKey, memoryChatOf } from "./digest.js";
import type { MemoryIdleReviewDoctor } from "./idle-review.js";
import { spansWorkspaces, type MemoryProviderChoice, type MemoryProviderRegistry } from "./providers.js";

/**
 * Weekly consolidation on the `tavi.memory` tick: tidy-up suggestions — merge, replace, end — drafted
 * by the workspace's memory provider from what a person keeps, and filed as
 * proposals they decide. Off by default (`consolidation: "weekly"` turns it
 * on); never while memory is paused; never auto-approved (invariant 2), and
 * nothing is changed until a person approves one (invariant 8).
 *
 * **When.** Once a week per person per workspace, at the first tick at or
 * after 03:00 in the workspace's `timezone`, and at most one run a tick across
 * the owner, so a machine that wakes runs them one a minute.
 *
 * **What it reads.** The person's approved, normal-sensitivity facts and
 * lessons in force — never a chat's words, so no heartbeat, routine or worker
 * text enters (invariant 6) — in their `personal_workspace` and
 * `personal_agent` scopes of the workspace, and their `personal` ones (and an
 * agent scope that spans workspaces) only in their **oldest** workspace with
 * consolidation on: the first, in the order this owner serves them, where
 * they are served — and not when another workspace's run included them in
 * the last week (its `p<date>` mark), as when the oldest was paused at its
 * run or switched on mid-week. So two workspaces never propose the same
 * tidy-up, and a person's personal records run at most once a week.
 * Preferences are left out: each key holds one value already, and a change
 * is a *Replace*. At most 500 records, batched by scope, kind and topic.
 *
 * **Who drafts.** The workspace's provider when it declares `consolidate`
 * and may receive every record of the run (`records` on, and
 * `includePersonal` for a run with personal records — the effective egress,
 * as its declaration allows it); otherwise the built-in, which is the host's
 * own and sees no more than the host holds. Withholding changes who drafts,
 * never whether.
 *
 * **Marks** (`tavi_memory_marks`, kind `consolidate`), on the chat the
 * person's digest goes to (`memoryChatOf`: the operator's Home, else their
 * most recently active attended chat whose memory is on; another person's
 * bound direct conversation): `c<date>` once the provider answered and
 * before any draft is filed (so a week is consolidated at most once across
 * restarts), with `p<date>` beside it when the run held the person's
 * personal records, then `c<date>;filed=…` with counts, never text, and
 * `s<date>;<digest>` of what it read (`memoryConsolidationSetMark`): the next
 * scheduled run over the same set, drafter, model and `sensitive` setting is
 * skipped once, recorded as a run that filed nothing. A failure is
 * `x<date>;<n>`, retried after an hour; the third since the last run skips
 * the week (`c<date>;skipped`). A person with no such chat is not
 * consolidated: there is nowhere to record the run.
 *
 * **Bounds**. One call a run on the `extraction` role (else the
 * workspace's utility model), at most 20 drafts and 2,000 output tokens, 60
 * seconds; the call keeps no copy of its request. One log line a run, counts only.
 */

/** Days between a person's consolidations in a workspace. */
const MEMORY_CONSOLIDATION_EVERY_DAYS = 7;
/** The local hour from which a day's run may start. */
const MEMORY_CONSOLIDATION_HOUR = 3;
/** A failed run is tried again no sooner than this. */
const MEMORY_CONSOLIDATION_RETRY_MS = 3_600_000;
/** Failures since the last run after which the week is skipped. */
const MEMORY_CONSOLIDATION_FAILURES_MAX = 3;

const DAY_MS = 86_400_000;
/** Records one person's listing reads at most, to find the 500 a run is given. */
const LISTED_MAX = 4 * MEMORY_CONSOLIDATION_RECORDS_MAX;
const CALLER = "memory-consolidation";

/** A run's mark: `c<date>` (claimed), `c<date>;skipped`, or `c<date>;filed=…;drafts=…;secret=…;sensitive=…;known=…;invalid=…`. */
export type MemoryConsolidationMark =
  | { readonly date: string; readonly outcome: "claimed" | "skipped" }
  | {
      readonly date: string;
      readonly outcome: "ran";
      readonly filed: number;
      readonly drafts: number;
      readonly dropped: Omit<ConsolidationDropCounts, "similar">;
    };

export function memoryConsolidationMark(mark: MemoryConsolidationMark): string {
  const head = `c${mark.date}`;
  if (mark.outcome !== "ran") return mark.outcome === "claimed" ? head : `${head};skipped`;
  const { dropped } = mark;
  return `${head};filed=${mark.filed};drafts=${mark.drafts};secret=${dropped.secret};sensitive=${dropped.sensitive};known=${dropped.known};invalid=${dropped.invalid}`;
}

/** A run's mark read back; undefined for a failure mark or anything else. */
function parseMemoryConsolidationMark(mark: string): MemoryConsolidationMark | undefined {
  const match = /^c(\d{4}-\d{2}-\d{2})(?:;(.*))?$/.exec(mark);
  if (match === null) return undefined;
  const date = match[1] as string;
  const rest = match[2];
  if (rest === undefined) return { date, outcome: "claimed" };
  if (rest === "skipped") return { date, outcome: "skipped" };
  const counts = new Map(rest.split(";").map((part) => part.split("=") as [string, string]));
  const count = (key: string): number => {
    const value = Number.parseInt(counts.get(key) ?? "0", 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  return {
    date,
    outcome: "ran",
    filed: count("filed"),
    drafts: count("drafts"),
    dropped: { secret: count("secret"), sensitive: count("sensitive"), known: count("known"), invalid: count("invalid") },
  };
}

/** The `attempt`th failure (from 1) of the run due on `date`: `x<date>;<attempt>`. */
export function memoryConsolidationFailureMark(date: string, attempt: number): string {
  return `x${date};${attempt}`;
}

const isFailureMark = (mark: string): boolean => /^x\d{4}-\d{2}-\d{2};\d+$/.test(mark);

/** That a run on `date` included the person's personal records: `p<date>`, beside its `c<date>`. */
export function memoryConsolidationPersonalMark(date: string): string {
  return `p${date}`;
}

const personalMarkDate = (mark: string): string | undefined => /^p(\d{4}-\d{2}-\d{2})$/.exec(mark)?.[1];

/**
 * What a run read: `s<date>;<digest>`, written when a run drafted, of its records at their revisions, who drafted
 * and on which model, and the `sensitive` setting. Only a drafting run writes one, so a set no one changed is
 * skipped one week and read again the next, when a date in its words may have passed.
 */
function memoryConsolidationSetMark(date: string, digest: string): string {
  return `s${date};${digest}`;
}

/** The digest a set mark carries (`memoryConsolidationSetMark`). */
export function consolidationSetDigest(
  records: readonly ConsolidationRecord[],
  run: { readonly drafter?: string | undefined; readonly model?: string | undefined; readonly sensitive: string },
): string {
  return sha256Hex(
    JSON.stringify([
      records.map((record) => [record.snapshot.recordId, record.snapshot.revisionId]),
      run.drafter ?? null,
      run.model ?? null,
      run.sensitive,
    ]),
  ).slice(0, 32);
}

const setMarkDigest = (mark: string): string | undefined => /^s\d{4}-\d{2}-\d{2};([a-f0-9]{32})$/.exec(mark)?.[1];

/** The provider that drafts a run. */
export interface MemoryConsolidationProvider {
  readonly id: string;
  readonly provider: Pick<MemoryProvider, "consolidate">;
}

export interface MemoryConsolidationDependencies {
  readonly models: ModelPort;
  /** `list` reads each person's records (with their current revision); `principals` who has any; `propose` files. */
  readonly memory: Pick<MemoryServicePort, "propose" | "list" | "principals">;
  readonly repositories: {
    readonly tasks: Pick<PersistencePort["repositories"]["tasks"], "homeOf" | "get">;
    readonly messagingConversations: Pick<PersistencePort["repositories"]["messagingConversations"], "directTasksOf">;
    readonly transcripts: Pick<
      PersistencePort["repositories"]["transcripts"],
      "claimMemoryMark" | "memoryMarksSince" | "memoryReviewChats"
    >;
  };
  /** The workspaces this owner serves, each with its operator, oldest first: the first one a person is served in with consolidation on holds their personal records' run. */
  readonly workspaces: () => readonly { readonly workspaceId: string; readonly principalId: string }[];
  /** Everyone served in a workspace, its operator included. */
  readonly peopleOf: (workspaceId: string) => readonly string[];
  readonly memorySettings: (workspaceId: string) => Promise<EffectiveMemorySettings>;
  readonly timezoneOf: (workspaceId: string) => Promise<string>;
  /** The composition's provider registry: the workspace's choice and the built-in. */
  readonly providers: Pick<MemoryProviderRegistry, "choice" | "get">;
  /** The model a workspace's runs use: the `extraction` role, else its utility model. */
  readonly targetOf: (workspaceId: string) => Promise<ModelTarget | undefined>;
  /** Whether a model is local: a remote one is never given a record a local chat wrote (`localOrigin`). Absent: every model is. */
  readonly isLocal?: (target: ModelTarget) => Promise<boolean>;
  readonly newId: (prefix: string) => string;
  readonly now: () => Date;
  /** Aborted when the owner stops: a run's call in flight ends now (a failure, retried an hour later). */
  readonly signal?: AbortSignal;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

/** What `consolidateNow` did for one person. */
interface MemoryConsolidateNowResult {
  readonly principalId: string;
  /**
   * `ran` (its tidy-ups in `filed`), `nothing` (no fact or lesson to tidy),
   * `no-chat` (no Home or attended chat to record the run on), `already`
   * (a run is recorded for today) or `failed`.
   */
  readonly outcome: "ran" | "nothing" | "no-chat" | "already" | "failed";
  readonly filed: readonly string[];
  readonly drafts: number;
  readonly reason?: string;
}

export interface MemoryConsolidation {
  /** Start at most one due run across the owner. Never throws. */
  tick(): Promise<void>;
  /**
   * `tavi memory consolidate-now`: run consolidation now for each person of
   * the workspace who keeps approved memory (or the one named), ignoring the
   * weekly 03:00 schedule and a failure's hour. Every other rule holds: the
   * setting (`weekly`, memory on; otherwise `undefined`), what a run reads,
   * who drafts, the bounds and the marks (one run a day).
   */
  consolidateNow(input: {
    readonly workspaceId: string;
    readonly principalId?: string;
  }): Promise<readonly MemoryConsolidateNowResult[] | undefined>;
}

/** The newest run among marks (by its date), with when it was written. */
function lastRunOf(
  marks: readonly { readonly mark: string; readonly at: string }[],
): { readonly date: string; readonly at: string } | undefined {
  let last: { date: string; at: string } | undefined;
  for (const { mark, at } of marks) {
    const parsed = parseMemoryConsolidationMark(mark);
    if (parsed !== undefined && (last === undefined || parsed.date > last.date || (parsed.date === last.date && at > last.at)))
      last = { date: parsed.date, at };
  }
  return last;
}

/** The failure marks written after the newest run. */
function failuresSinceRun(
  marks: readonly { readonly mark: string; readonly at: string }[],
): readonly { readonly mark: string; readonly at: string }[] {
  const since = lastRunOf(marks)?.at ?? "";
  return marks.filter((entry) => isFailureMark(entry.mark) && entry.at > since);
}

/**
 * Whether a person is due a run `today`, by their marks in the workspace
 * (newest first): no run in the last week, and, after a failure, an hour
 * since it. `skip` when the failures since the last run reached the cap.
 */
function memoryConsolidationDue(input: {
  readonly today: string;
  readonly now: Date;
  readonly marks: readonly { readonly mark: string; readonly at: string }[];
}): "due" | "wait" | "skip" {
  const lastRun = lastRunOf(input.marks);
  if (lastRun !== undefined && daysBetween(lastRun.date, input.today) < MEMORY_CONSOLIDATION_EVERY_DAYS) return "wait";
  const failures = failuresSinceRun(input.marks);
  if (failures.length >= MEMORY_CONSOLIDATION_FAILURES_MAX) return "skip";
  const newest = failures
    .map((entry) => entry.at)
    .sort()
    .at(-1);
  if (newest !== undefined && input.now.getTime() - Date.parse(newest) < MEMORY_CONSOLIDATION_RETRY_MS) return "wait";
  return "due";
}

/**
 * Who drafts a run (see the module comment): the workspace's provider when it
 * declares `consolidate` and its effective egress lets it receive every
 * record of the run, else the built-in.
 */
export function consolidationProviderOf(
  choice: Pick<MemoryProviderChoice, "provider" | "egress">,
  builtin: MemoryConsolidationProvider | undefined,
  withPersonal: boolean,
): MemoryConsolidationProvider | undefined {
  const installed = choice.provider;
  if (installed === undefined || installed.kind !== "plugin") return builtin;
  const declares = installed.declaration.capabilities.includes("consolidate") && typeof installed.provider.consolidate === "function";
  if (!declares || !choice.egress.records || (withPersonal && !choice.egress.includePersonal)) return builtin;
  return { id: installed.id, provider: installed.provider };
}

type Listed = MemoryRecord & { readonly currentRevision?: MemoryRevision };

/** A record a run may read: an approved, normal fact or lesson of this person, in force, with its words. */
function readable(record: Listed, principalId: string, now: string): boolean {
  if (record.status !== "approved" || record.sensitivity !== "normal" || (record.kind !== "fact" && record.kind !== "lesson")) return false;
  if (record.currentRevision?.body === undefined || record.currentRevision.revisionId !== record.currentRevisionId) return false;
  if ((record.validTo !== undefined && record.validTo <= now) || (record.expiryAt !== undefined && record.expiryAt <= now)) return false;
  const { scope } = record;
  return (
    (scope.kind === "personal" || scope.kind === "personal_workspace" || scope.kind === "personal_agent") &&
    scope.principalId === principalId
  );
}

/** Whether a record belongs to the run of this workspace: its own scopes always, personal ones (and a workspace-free agent scope) only where `personal`. */
function inRun(record: MemoryRecord, workspaceId: string, personal: boolean): boolean {
  const { scope } = record;
  if (scope.kind === "personal_workspace") return scope.workspaceId === workspaceId;
  if (scope.kind === "personal_agent") return scope.workspaceId === undefined ? personal : scope.workspaceId === workspaceId;
  return scope.kind === "personal" && personal;
}

export function createMemoryConsolidation(deps: MemoryConsolidationDependencies): MemoryConsolidation {
  const { repositories } = deps;

  /** A person's records for a run, batched by scope, kind and topic, at most `MEMORY_CONSOLIDATION_RECORDS_MAX`. */
  const recordsOf = async (
    workspaceId: string,
    principalId: string,
    operator: boolean,
    personal: boolean,
    withLocalOrigin: boolean,
  ): Promise<readonly ConsolidationRecord[]> => {
    const actor: MemoryActor = { principalId, workspaceId, caller: CALLER, authority: "operator" };
    const now = deps.now().toISOString();
    const found: Listed[] = [];
    for (let offset = 0; offset < LISTED_MAX; offset += MEMORY_LIST_PAGE_MAX) {
      // The operator's page spans every agent's scope; anyone else reads their own scopes.
      const page = await deps.memory.list({
        actor,
        ...(operator ? { view: "operator" as const } : {}),
        statuses: ["approved"],
        kinds: ["fact", "lesson"],
        limit: MEMORY_LIST_PAGE_MAX,
        offset,
        withCurrentRevision: true,
      });
      found.push(
        ...page.filter(
          (record) =>
            readable(record, principalId, now) && inRun(record, workspaceId, personal) && (withLocalOrigin || record.localOrigin !== true),
        ),
      );
      if (page.length < MEMORY_LIST_PAGE_MAX) break;
    }
    const unique = [...new Map(found.map((record) => [record.recordId, record])).values()];
    unique.sort(
      (left, right) =>
        left.scopeKey.localeCompare(right.scopeKey) ||
        left.kind.localeCompare(right.kind) ||
        (left.topicKey ?? "").localeCompare(right.topicKey ?? "") ||
        left.recordedAt.localeCompare(right.recordedAt) ||
        left.recordId.localeCompare(right.recordId),
    );
    return unique.slice(0, MEMORY_CONSOLIDATION_RECORDS_MAX).map((record) => {
      const revision = record.currentRevision as MemoryRevision;
      const validUntil = record.validTo ?? record.expiryAt;
      return {
        scope: record.scope,
        ...(record.topicKey === undefined ? {} : { topicKey: record.topicKey }),
        snapshot: Object.freeze({
          recordId: record.recordId,
          revisionId: revision.revisionId,
          scopeKey: record.scopeKey,
          kind: record.kind,
          ...(revision.title === undefined ? {} : { title: revision.title }),
          body: revision.body as string,
          ...(revision.observedAt === undefined ? {} : { observedAt: revision.observedAt }),
          recordedAt: revision.recordedAt,
          ...(validUntil === undefined ? {} : { validUntil }),
        }),
      };
    });
  };

  /** The workspace that holds a person's personal records' run: the first served one with consolidation on where they are served. */
  const personalHome = async (principalId: string): Promise<string | undefined> => {
    for (const { workspaceId } of deps.workspaces()) {
      // Settings that cannot be read serve no consolidation here: the run is skipped, never run under defaults.
      const settings = await deps.memorySettings(workspaceId).catch(() => undefined);
      if (settings === undefined || !settings.enabled || settings.consolidation !== "weekly") continue;
      if (deps.peopleOf(workspaceId).includes(principalId)) return workspaceId;
    }
    return undefined;
  };

  /**
   * Whether another served workspace's run included the person's personal
   * records in the last week (its `p<date>` mark): the home can change — the
   * oldest workspace paused at its run, or consolidation switched on there
   * mid-week after another ran — and the person's personal records are still
   * consolidated at most once a week, whichever workspace runs.
   */
  const personalRanElsewhere = async (workspaceId: string, principalId: string, today: string, since: string): Promise<boolean> => {
    for (const served of deps.workspaces()) {
      if (served.workspaceId === workspaceId) continue;
      const marks = await repositories.transcripts.memoryMarksSince({ workspaceId: served.workspaceId, kind: "consolidate", since });
      for (const entry of marks) {
        const date = entry.principalId === principalId ? personalMarkDate(entry.mark) : undefined;
        if (date !== undefined && daysBetween(date, today) < MEMORY_CONSOLIDATION_EVERY_DAYS) return true;
      }
    }
    return false;
  };

  type RunOutcome = { readonly started: boolean; readonly result: Omit<MemoryConsolidateNowResult, "principalId"> };
  const nothingStarted = (outcome: MemoryConsolidateNowResult["outcome"]): RunOutcome => ({
    started: false,
    result: { outcome, filed: [], drafts: 0 },
  });

  /**
   * One person's run in one workspace: `started` when a run was started (a
   * model call or a failure). `immediate` (`consolidateNow`) ignores the
   * week's spacing and a failure's hour.
   */
  const runFor = async (input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly operator: boolean;
    readonly today: string;
    readonly timeZone: string;
    readonly settings: EffectiveMemorySettings;
    readonly marks: readonly { readonly mark: string; readonly at: string }[];
    readonly immediate?: boolean;
  }): Promise<RunOutcome> => {
    const { workspaceId, principalId, today } = input;
    const now = deps.now();
    // Run now: no schedule, but still one run a day (its mark is the day's), so no call is made for nothing.
    if (input.immediate === true && input.marks.some((entry) => parseMemoryConsolidationMark(entry.mark)?.date === today))
      return nothingStarted("already");
    const due = input.immediate === true ? "due" : memoryConsolidationDue({ today, now, marks: input.marks });
    if (due === "wait") return nothingStarted("already");
    const taskId = await memoryChatOf(repositories, { workspaceId, principalId, operator: input.operator, now });
    // Nowhere to record the run: it is not run, so it never repeats unrecorded.
    if (taskId === undefined) return nothingStarted("no-chat");
    const claim = (mark: string): Promise<boolean> =>
      repositories.transcripts.claimMemoryMark({ taskId, kind: "consolidate", mark, at: now.toISOString() });
    if (due === "skip") {
      await claim(memoryConsolidationMark({ date: today, outcome: "skipped" }));
      deps.log("memory consolidation failed three times; this week is skipped", { workspaceId, taskId });
      return nothingStarted("failed");
    }
    const since = new Date(now.getTime() - (MEMORY_CONSOLIDATION_EVERY_DAYS + 1) * DAY_MS).toISOString();
    const personal =
      (await personalHome(principalId)) === workspaceId && !(await personalRanElsewhere(workspaceId, principalId, today, since));
    // A local chat's record is read only by a local tidy-up model, drafting through the built-in: an
    // external provider could take it anywhere. Judged as permissively as the drafter can be chosen.
    const planned = deps.isLocal === undefined ? undefined : await deps.targetOf(workspaceId).catch(() => undefined);
    const builtinEntry = deps.providers.get(BUILTIN_MEMORY_PROVIDER_ID);
    const externalDrafter =
      deps.isLocal !== undefined &&
      consolidationProviderOf(
        await deps.providers.choice(workspaceId),
        builtinEntry === undefined ? undefined : { id: builtinEntry.id, provider: builtinEntry.provider },
        false,
      )?.id !== BUILTIN_MEMORY_PROVIDER_ID;
    const withLocalOrigin = deps.isLocal === undefined || (planned !== undefined && !externalDrafter && (await deps.isLocal(planned)));
    const records = await recordsOf(workspaceId, principalId, input.operator, personal, withLocalOrigin);
    if (records.length < 1) {
      // Nothing to tidy: the week counts as run, so the listing is not read again until next week.
      await claim(
        memoryConsolidationMark({
          date: today,
          outcome: "ran",
          filed: 0,
          drafts: 0,
          dropped: { secret: 0, sensitive: 0, known: 0, invalid: 0 },
        }),
      );
      return nothingStarted("nothing");
    }
    // The same records at the same revisions, drafted by the same provider on the same model under the same
    // `sensitive` setting, as the run that last drafted: nothing new to tidy, this week. A run asked for now
    // still runs, and a skip writes no set mark, so the next week reads the set again.
    const drafterId = await deps.providers
      .choice(workspaceId)
      .then((choice) => {
        const builtin = deps.providers.get(BUILTIN_MEMORY_PROVIDER_ID);
        return consolidationProviderOf(
          choice,
          builtin === undefined ? undefined : { id: builtin.id, provider: builtin.provider },
          records.some((record) => spansWorkspaces(record.scope)),
        )?.id;
      })
      .catch(() => undefined);
    const model = planned ?? (await deps.targetOf(workspaceId).catch(() => undefined));
    const digest = consolidationSetDigest(records, {
      drafter: drafterId,
      model: model === undefined ? undefined : `${model.connectionId}/${model.model}`,
      sensitive: input.settings.sensitive,
    });
    if (input.immediate !== true && input.marks.some((entry) => setMarkDigest(entry.mark) === digest)) {
      await claim(
        memoryConsolidationMark({
          date: today,
          outcome: "ran",
          filed: 0,
          drafts: 0,
          dropped: { secret: 0, sensitive: 0, known: 0, invalid: 0 },
        }),
      );
      deps.log("memory consolidation skipped: the records are as the last run read them", { workspaceId, taskId, records: records.length });
      return nothingStarted("nothing");
    }
    const withPersonal = records.some((record) => spansWorkspaces(record.scope));
    try {
      const builtin = deps.providers.get(BUILTIN_MEMORY_PROVIDER_ID);
      const drafting = consolidationProviderOf(
        await deps.providers.choice(workspaceId),
        builtin === undefined ? undefined : { id: builtin.id, provider: builtin.provider },
        withPersonal,
      );
      if (drafting?.provider.consolidate === undefined) throw new Error("no memory provider drafts this workspace's tidy-ups");
      const target = planned ?? (await deps.targetOf(workspaceId));
      if (target === undefined) throw new Error("no model is configured for this workspace's tidy-ups");
      const result = await runMemoryConsolidation({
        models: deps.models,
        memory: deps.memory,
        provider: drafting.provider,
        providerId: drafting.id,
        target,
        context: { workspaceId, principalId, runId: taskId, caller: CALLER },
        records,
        newId: deps.newId,
        now: () => deps.now().toISOString(),
        timeZone: input.timeZone,
        sensitive: input.settings.sensitive,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        // The person's personal records are marked as run with the claim, for every other workspace to read.
        claim: async () => {
          if (!(await claim(memoryConsolidationMark({ date: today, outcome: "claimed" })))) return false;
          if (personal) await claim(memoryConsolidationPersonalMark(today));
          return true;
        },
      });
      // A run already recorded for today (the claim is one a day): nothing is filed again.
      if (!result.claimed) return { started: true, result: { outcome: "already", filed: [], drafts: 0 } };
      const { similar: _similar, ...dropped } = result.dropped;
      await claim(memoryConsolidationMark({ date: today, outcome: "ran", filed: result.recordIds.length, drafts: result.drafts, dropped }));
      await claim(memoryConsolidationSetMark(today, digest));
      // Counts only, never memory text.
      deps.log("memory consolidation ran", {
        workspaceId,
        taskId,
        providerId: drafting.id,
        records: records.length,
        drafts: result.drafts,
        filed: result.recordIds.length,
        ...dropped,
      });
      return { started: true, result: { outcome: "ran", filed: result.recordIds, drafts: result.drafts } };
    } catch (error) {
      const attempt = failuresSinceRun(input.marks).length + 1;
      await claim(memoryConsolidationFailureMark(today, attempt));
      deps.log("memory consolidation failed; it is tried again in an hour", {
        workspaceId,
        taskId,
        attempt,
        reason: errorMessage(error),
      });
      return { started: true, result: { outcome: "failed", filed: [], drafts: 0, reason: errorMessage(error).slice(0, 200) } };
    }
  };

  return {
    async consolidateNow(input) {
      const workspace = deps.workspaces().find((entry) => entry.workspaceId === input.workspaceId);
      if (workspace === undefined) return [];
      const settings = await deps.memorySettings(input.workspaceId);
      if (settings.consolidation !== "weekly" || !settings.enabled) return undefined;
      const operator = workspace.principalId;
      const timeZone = await deps.timezoneOf(input.workspaceId);
      const now = deps.now();
      const today = localDateKey(localDateTime(now, timeZone));
      const people =
        input.principalId === undefined
          ? [
              ...(await deps.memory.principals({
                actor: { principalId: operator, workspaceId: input.workspaceId, caller: CALLER, authority: "operator" },
                statuses: ["approved"],
              })),
            ].sort()
          : [input.principalId];
      const since = new Date(now.getTime() - (MEMORY_CONSOLIDATION_EVERY_DAYS + 1) * DAY_MS).toISOString();
      const marks = await repositories.transcripts.memoryMarksSince({ workspaceId: input.workspaceId, kind: "consolidate", since });
      const results: MemoryConsolidateNowResult[] = [];
      for (const principalId of people) {
        const run = await runFor({
          workspaceId: input.workspaceId,
          principalId,
          operator: principalId === operator,
          today,
          timeZone,
          settings,
          marks: marks.filter((mark) => mark.principalId === principalId),
          immediate: true,
        });
        results.push({ principalId, ...run.result });
      }
      return results;
    },

    async tick() {
      const now = deps.now();
      for (const { workspaceId, principalId: operator } of deps.workspaces()) {
        try {
          const settings = await deps.memorySettings(workspaceId);
          // Off by default, and no background job but the digest while memory is paused.
          if (settings.consolidation !== "weekly" || !settings.enabled) continue;
          const timeZone = await deps.timezoneOf(workspaceId);
          const local = localDateTime(now, timeZone);
          if (local.hour < MEMORY_CONSOLIDATION_HOUR) continue;
          const today = localDateKey(local);
          const people = await deps.memory.principals({
            actor: { principalId: operator, workspaceId, caller: CALLER, authority: "operator" },
            statuses: ["approved"],
          });
          const since = new Date(now.getTime() - (MEMORY_CONSOLIDATION_EVERY_DAYS + 1) * DAY_MS).toISOString();
          const marks = await repositories.transcripts.memoryMarksSince({ workspaceId, kind: "consolidate", since });
          for (const principalId of [...people].sort()) {
            const mine = marks.filter((mark) => mark.principalId === principalId);
            // At most one run a tick across the owner.
            if (
              (await runFor({ workspaceId, principalId, operator: principalId === operator, today, timeZone, settings, marks: mine }))
                .started
            )
              return;
          }
        } catch (error) {
          deps.log("memory consolidation could not be checked", { workspaceId, reason: errorMessage(error) });
        }
      }
    },
  };
}

/** Doctor's consolidation line: from the marks and the ledger, counts only. */
export interface MemoryConsolidationDoctor {
  readonly consolidation: "off" | "weekly";
  /** When the last run (one that called the provider) was, in the last 30 days. */
  readonly lastRun: string | null;
  /** What the last run filed, and drafted before validation. */
  readonly filed: number;
  readonly drafts: number;
  /** Failures and skipped weeks in the last 30 days. */
  readonly failures: number;
  readonly skipped: number;
  /** Today's spend of its `extraction` calls. */
  readonly spend: MemoryIdleReviewDoctor["today"]["spend"];
}

/** Doctor's line from the consolidation marks of the last 30 days, and today's spend. */
export function memoryConsolidationDoctor(input: {
  readonly consolidation: "off" | "weekly";
  readonly month: readonly { readonly mark: string; readonly at: string }[];
  readonly spend: MemoryConsolidationDoctor["spend"];
}): MemoryConsolidationDoctor {
  let lastRun: string | null = null;
  let filed = 0;
  let drafts = 0;
  let failures = 0;
  let skipped = 0;
  for (const { mark, at } of input.month) {
    if (isFailureMark(mark)) {
      failures += 1;
      continue;
    }
    const parsed = parseMemoryConsolidationMark(mark);
    if (parsed?.outcome === "skipped") skipped += 1;
    if (parsed?.outcome === "ran" && (lastRun === null || at > lastRun)) {
      lastRun = at;
      filed = parsed.filed;
      drafts = parsed.drafts;
    }
  }
  return { consolidation: input.consolidation, lastRun, filed, drafts, failures, skipped, spend: input.spend };
}
