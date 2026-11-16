import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MEMORY_LIST_PAGE_MAX,
  MEMORY_LIMIT_BOUNDS,
  MEMORY_PROVIDER_LIMITS,
  type memoryProviderEgressOf,
  type EffectiveMemorySettings,
  type MemoryActor,
  type MemoryDeletion,
  type MemoryRecord,
  type MemoryRemovalReason,
  type MemoryRevision,
  type MemoryScope,
  type MemoryServicePort,
  type MemorySnapshot,
  type MemorySyncBatch,
  type PersistencePort,
  type PluginMemoryDeclaration,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";

import {
  effectiveMemoryProviderEgress,
  egressAsDeclared,
  spansWorkspaces,
  type InstalledMemoryProvider,
  type MemoryProviderRegistry,
} from "./providers.js";
import type { WriteGate } from "../../shared/write-gate.js";
import { type RepeatTimer, repeatEvery } from "@tavi/agent-host/schedule-scheduler";

/**
 * Keeping an external provider's own index (invariants 7, 9 and 26).
 *
 * **Where changes are seen.** The owner's memory port is wrapped
 * (`wrap`): every committing method that can change what a provider may hold
 * (`propose`, `remember`, `approve`, `correct`, `revoke`, `forget`,
 * `sweepExpired`) is followed, before it returns, by the
 * `sync` it calls for; approving a tidy-up also sends the records it
 * superseded as removals, `superseded`. A wrapper rather than the change feed
 * (`center.memoryChanged`, `onChange`) because those name a scope, not a
 * record, and fire after the call returned; the wrapper knows the record and
 * holds the call until every provider took its removal ("removal before
 * return"). Every surface writes through this one port (the Center, the CLI
 * on an owner, the tools, `/remember` and `/forget`, the sweep).
 *
 * **Who receives what.** A record goes to the provider a workspace selected
 * when that provider is a plugin keeping its own index (`index: "own"`) and
 * the workspace's `records` switch is on; a `personal` record (the person's,
 * read in all their workspaces) to every such workspace this owner serves
 * for that person with `includePersonal` on too. Only approved, normal
 * records are sent; anything else (revoked, expired, ended by forget, made
 * sensitive) is sent as a removal. The built-in keeps no index of its own.
 *
 * **What cannot be taken now waits.** A forget whose removal a provider
 * could not take (not running, it threw, or its `sync` ran past
 * `MEMORY_PROVIDER_LIMITS.syncMs`) still completes; its journal row goes back
 * to `pending`, naming each provider that missed it, and the
 * receipt names them. The removal is resent to those providers, whatever the
 * workspaces select by then, when one starts and at each upkeep pass (a
 * composition-owned timer, `startUpkeep`, so disabling `tavi.memory` never
 * stops it; all pending rows in one batch per provider); the row is marked
 * `complete` once every one of them took it. A removal carries an id only, so
 * a resend is harmless. Any other removal a provider missed is kept in memory
 * for it the same way (`owed`), and so is a forget's under an owner whose
 * memory has no Tavi journal (`memoryOverride`). A provider that starts is
 * also sent its whole index again (`full`), which drops whatever it missed
 * while it was stopped; a selected one that could not take any other change
 * (the sweep's, a revoke's, egress-off removals) is sent it at the next pass,
 * and again at each one until it takes it. Only what a provider may ever have
 * held leaves it: a record never approved sends nothing, and neither does
 * approving or revoking a sensitive one.
 */

export interface MemoryProviderSyncDependencies {
  /** The owner's memory port, unwrapped: what records are read through. */
  readonly memory: Pick<MemoryServicePort, "list" | "history" | "get">;
  readonly providers: Pick<MemoryProviderRegistry, "get" | "list" | "onInstalled">;
  /**
   * The memory provider an approved plugin declares, read from its record
   * (`approvedMemoryDeclaration`): how a provider that does not run now is
   * known. One declaring `index: "host"` holds nothing to remove; one whose
   * record says nothing is taken to keep an index of its own. Absent: every
   * provider not running is.
   */
  readonly declarationOf?: (providerId: string) => Promise<PluginMemoryDeclaration | undefined>;
  /** The workspaces this owner serves, with their operator. */
  readonly workspaces: () => readonly { readonly workspaceId: string; readonly principalId: string }[];
  /** Everyone served in a workspace, its operator included: whose personal memory its provider may hold. */
  readonly peopleOf: (workspaceId: string) => readonly string[];
  readonly settingsOf: (workspaceId: string) => Promise<Pick<EffectiveMemorySettings, "provider" | "providerEgress">>;
  /** The deletion journal's pending rows (its existing `cleanup_status`). */
  readonly journal: Pick<
    PersistencePort["repositories"]["memory"],
    "markDeletionPending" | "pendingDeletions" | "pendingDeletionCounts" | "completeDeletion"
  >;
  readonly now: () => string;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
  /** How long one `sync` may take, for tests: `MEMORY_PROVIDER_LIMITS.syncMs` otherwise. */
  readonly syncDeadlineMs?: number;
}

export interface MemoryProviderSync {
  /** The port with every committing method followed by the sync it calls for, before it returns. */
  wrap(port: MemoryServicePort): MemoryServicePort;
  /** An actor's approved, normal records as snapshots, `personal` ones only when asked: an `index: "host"` provider's candidates. */
  snapshotsFor(actor: MemoryActor, options: { readonly personal: boolean; readonly limit: number }): Promise<readonly MemorySnapshot[]>;
  /** Send `providerId` everything it should hold now, as a `full` sync (a switch, `records` on, a start). */
  fullSync(providerId: string): Promise<void>;
  /**
   * A workspace's egress narrowed (`records` or `personal` off): what it no
   * longer lets its provider hold is sent as removals, `egress-off`. `before`
   * is the workspace's egress before the change.
   */
  egressNarrowed(workspaceId: string, providerId: string, before: Pick<EffectiveMemorySettings, "providerEgress">): Promise<void>;
  /** Resend every pending removal to each provider that missed it, selected or not; mark each row complete once every one of them has taken it. Then send each selected provider that missed a change its whole index. */
  resendPending(): Promise<void>;
  /** How many forgets still wait for a provider to take their removal. */
  pendingRemovals(): Promise<number>;
  /** The providers pending removals wait for, with how many each, sorted (doctor: one uninstalled for good keeps its rows pending). */
  pendingByProvider(): Promise<readonly { readonly provider: string; readonly removals: number }[]>;
  /** Run `resendPending` every `everyMs` until stopped, on a timer of the caller's (composition's, not `tavi.memory`'s). */
  /**
   * Resends pending removals every `everyMs`. With a `gate`, a pass is skipped
   * while nothing was written, no provider runs, and nothing is owed or stale:
   * then there is nothing it could send or complete.
   */
  startUpkeep(everyMs: number, gate?: WriteGate, every?: RepeatTimer): { readonly stop: () => void; readonly running: () => Promise<void> };
  /** The providers other than the built-in that the workspaces this owner serves select, sorted (what `tavi reset` cannot reach). */
  selectedExternal(): Promise<readonly string[]>;
  /** Stop listening for providers that start. */
  close(): void;
}

/** Records one listing reads at most: the record quota's ceiling. */
const HOLDINGS_MAX = MEMORY_LIMIT_BOUNDS.maxRecords.max;
/** Bodies kept by revision, so a recall's candidates do not read every revision again. */
const BODIES_KEPT = 10_000;
/** Pending journal rows one resend reads at most, per provider running now (and of those naming none). */
const PENDING_MAX = 1_000;

const CALLER = "memory-provider-sync";

/** A record as `list` reads it, with its current revision when asked for. */
type Listed = MemoryRecord & { readonly currentRevision?: MemoryRevision };

/** Whether a provider may hold `record` at all: approved, current, normal (invariant 7). */
function holdable(record: MemoryRecord): boolean {
  // A local chat's record never leaves for a provider: it may run anywhere.
  return (
    record.status === "approved" && record.sensitivity === "normal" && record.currentRevisionId !== undefined && record.localOrigin !== true
  );
}

/** Whether `record` was ever approved: a proposal or a rejection was never sent anywhere, so its id never leaves either. */
function everApproved(record: MemoryRecord): boolean {
  return record.status !== "proposed" && record.status !== "rejected";
}

/** Why a record that may no longer be held leaves an index. */
function removalReasonOf(record: MemoryRecord): MemoryRemovalReason {
  if (record.status === "deleted") return "forgotten";
  if (record.status === "expired") return "expired";
  if (record.status === "superseded") return "superseded";
  // Sensitive is never sent anywhere (invariant 7): it leaves as egress does.
  if (record.sensitivity === "sensitive") return "egress-off";
  return "revoked";
}

/** The workspaces of a scope's reach, by its fields: `personal` (and a workspace-free agent scope) reach every workspace of its person. */
function reaches(scope: MemoryScope, workspaceId: string, people: readonly string[]): boolean {
  if (scope.kind === "shared_workspace" || scope.kind === "personal_workspace" || scope.kind === "run_local")
    return scope.workspaceId === workspaceId;
  if (scope.kind === "personal_agent" && scope.workspaceId !== undefined) return scope.workspaceId === workspaceId;
  return people.includes(scope.principalId);
}

export function createMemoryProviderSync(deps: MemoryProviderSyncDependencies): MemoryProviderSync {
  /** Bodies by revision id, with their record: evicted when the record changes, so nothing forgotten stays here. */
  const bodies = new Map<
    string,
    {
      readonly recordId: string;
      readonly title?: string;
      readonly body?: string;
      readonly observedAt?: string;
      readonly recordedAt: string;
    }
  >();
  const evict = (recordId: string): void => {
    for (const [revisionId, entry] of bodies) if (entry.recordId === recordId) bodies.delete(revisionId);
  };

  /**
   * One record as a provider receives it, read as `actor` (`view` as the
   * operator's page reads it), or undefined. A record listed with its current
   * revision (`withCurrentRevision`) needs no further read.
   */
  const snapshotOf = async (record: Listed, actor: MemoryActor, view?: "operator"): Promise<MemorySnapshot | undefined> => {
    if (!holdable(record) || record.currentRevisionId === undefined) return undefined;
    let entry = bodies.get(record.currentRevisionId);
    if (entry === undefined) {
      const revisions =
        record.currentRevision !== undefined
          ? [record.currentRevision]
          : (await deps.memory.history({ actor, recordId: record.recordId, ...(view === undefined ? {} : { view }) })).revisions;
      const revision = revisions.find((candidate) => candidate.revisionId === record.currentRevisionId);
      if (revision === undefined) return undefined;
      entry = {
        recordId: record.recordId,
        recordedAt: revision.recordedAt,
        ...definedOnly({
          title: revision.title,
          body: revision.body,
          observedAt: revision.observedAt,
        }),
      };
      if (bodies.size >= BODIES_KEPT) bodies.delete(bodies.keys().next().value as string);
      bodies.set(record.currentRevisionId, entry);
    }
    if (entry.body === undefined) return undefined;
    const validUntil = record.validTo ?? record.expiryAt;
    return Object.freeze({
      recordId: record.recordId,
      revisionId: record.currentRevisionId,
      scopeKey: record.scopeKey,
      kind: record.kind,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      body: entry.body,
      ...(entry.observedAt === undefined ? {} : { observedAt: entry.observedAt }),
      recordedAt: entry.recordedAt,
      ...(validUntil === undefined ? {} : { validUntil }),
    });
  };

  /** Every approved record `list` reads with `input`, paged, at most `max`, each with its current revision. */
  const listAll = async (input: Parameters<MemoryServicePort["list"]>[0], max: number): Promise<readonly Listed[]> => {
    const found: Listed[] = [];
    for (let offset = 0; found.length < max; offset += MEMORY_LIST_PAGE_MAX) {
      const page = await deps.memory.list({
        ...input,
        statuses: ["approved"],
        limit: MEMORY_LIST_PAGE_MAX,
        offset,
        withCurrentRevision: true,
      });
      found.push(...page);
      if (page.length < MEMORY_LIST_PAGE_MAX) break;
    }
    return found.slice(0, max);
  };

  /** What workspace `workspaceId` lets its provider hold now: its people's records, ones spanning workspaces (`spansWorkspaces`) only with `includePersonal`. */
  const holdingsOf = async (
    workspaceId: string,
    egress: { readonly records: boolean; readonly includePersonal: boolean },
  ): Promise<readonly MemorySnapshot[]> => {
    if (!egress.records) return [];
    const operator = deps.workspaces().find((workspace) => workspace.workspaceId === workspaceId)?.principalId;
    if (operator === undefined) return [];
    const held = new Map<string, MemorySnapshot>();
    const take = async (records: readonly Listed[], actor: MemoryActor, view?: "operator"): Promise<void> => {
      for (const record of records) {
        if (held.has(record.recordId) || (spansWorkspaces(record.scope) && !egress.includePersonal)) continue;
        // A record whose snapshot cannot be read now is left out of this send, never failing the others.
        const snapshot = await snapshotOf(record, actor, view).catch(() => undefined);
        if (snapshot !== undefined) held.set(record.recordId, snapshot);
      }
    };
    // The operator's page: their scopes, the workspace's shared scope, every agent's, and their chat notes.
    const own: MemoryActor = { principalId: operator, workspaceId, caller: CALLER, authority: "operator" };
    await take(await listAll({ actor: own, view: "operator" }, HOLDINGS_MAX), own, "operator");
    await take(await listAll({ actor: own, view: "operator", chatNotes: true }, HOLDINGS_MAX).catch(() => []), own, "operator");
    // Everyone else served there: their own scopes, read as themselves.
    for (const principalId of new Set(deps.peopleOf(workspaceId))) {
      if (principalId === operator) continue;
      const actor: MemoryActor = { principalId, workspaceId, caller: CALLER, authority: "operator" };
      await take(await listAll({ actor }, HOLDINGS_MAX), actor);
    }
    return [...held.values()];
  };

  /** The workspaces whose provider is `providerId`, with their egress as its declaration allows it. */
  const selecting = async (
    providerId: string,
  ): Promise<readonly { readonly workspaceId: string; readonly egress: ReturnType<typeof memoryProviderEgressOf> }[]> => {
    const found: { workspaceId: string; egress: ReturnType<typeof memoryProviderEgressOf> }[] = [];
    for (const { workspaceId } of deps.workspaces()) {
      const settings = await deps.settingsOf(workspaceId);
      if (settings.provider === providerId)
        found.push({ workspaceId, egress: effectiveMemoryProviderEgress(settings.providerEgress, deps.providers.get(providerId)) });
    }
    return found;
  };

  /** Everything `providerId` should hold now: the union of what each workspace selecting it lets it hold. */
  const unionFor = async (providerId: string): Promise<Map<string, MemorySnapshot>> => {
    const union = new Map<string, MemorySnapshot>();
    for (const { workspaceId, egress } of await selecting(providerId))
      for (const snapshot of await holdingsOf(workspaceId, egress)) union.set(snapshot.recordId, snapshot);
    return union;
  };

  /** A provider that keeps an index, running: what a batch is sent to. */
  const indexing = (installed: InstalledMemoryProvider | undefined): installed is InstalledMemoryProvider =>
    installed !== undefined &&
    installed.kind === "plugin" &&
    installed.declaration.index === "own" &&
    typeof installed.provider.sync === "function";

  /**
   * Providers that missed a change outside `forget` (whose removals are journal
   * rows): each is sent its whole index again at the next tick (`resendPending`),
   * and leaves this set once that full sync was taken. One not running gets it
   * when it starts.
   */
  const stale = new Set<string>();

  /** A provider not running, as its approved record declares it; undefined when unknown (no record, or it could not be read). */
  const declaredOf = async (providerId: string): Promise<PluginMemoryDeclaration | undefined> =>
    // Unreadable is unknown, as the doc above says.
    deps.declarationOf === undefined ? undefined : await deps.declarationOf(providerId).catch(() => undefined);

  /** The providers other than the built-in that the workspaces this owner serves select, sorted. */
  const selectedExternal = async (): Promise<readonly string[]> => {
    const selected = new Set<string>();
    for (const { workspaceId } of deps.workspaces()) {
      const { provider } = await deps.settingsOf(workspaceId);
      if (provider !== BUILTIN_MEMORY_PROVIDER_ID) selected.add(provider);
    }
    return [...selected].sort();
  };

  /** Send one batch; false when the provider could not take it now, or not within the deadline (its signal then aborts). */
  const send = async (installed: InstalledMemoryProvider, batch: MemorySyncBatch): Promise<boolean> => {
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = Promise.resolve().then(() => installed.provider.sync?.(Object.freeze({ ...batch, signal: deadline.signal })));
      // A late batch's own answer, or its failure, is dropped: it must not surface as an unhandled rejection.
      work.catch(() => undefined);
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("its sync ran past its deadline")), deps.syncDeadlineMs ?? MEMORY_PROVIDER_LIMITS.syncMs);
      });
      await Promise.race([work, late]);
      return true;
    } catch (error) {
      deadline.abort();
      // The reason only, never memory text.
      deps.log("a memory provider could not take a sync", {
        providerId: installed.id,
        upserts: batch.upserts.length,
        removals: batch.removals.length,
        full: batch.full === true,
        error: errorMessage(error, "unknown").slice(0, 200),
      });
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * Removals a provider missed outside the journal (a revoke's, the sweep's,
   * egress-off, superseded; a forget's too, for a memory with no Tavi
   * journal): resent to it, selected or not, with the pending rows, and kept
   * here until it takes them. Ids only; lost on a restart, when a provider
   * still selected is sent its whole index again on start.
   */
  const owed = new Map<string, Map<string, MemoryRemovalReason>>();
  const owe = (providerIds: readonly string[], removals: MemorySyncBatch["removals"]): void => {
    for (const providerId of providerIds) {
      const entry = owed.get(providerId) ?? new Map<string, MemoryRemovalReason>();
      for (const removal of removals) {
        if (!entry.has(removal.recordId) && entry.size >= PENDING_MAX) entry.delete(entry.keys().next().value as string);
        entry.set(removal.recordId, removal.reason);
      }
      if (entry.size > 0) owed.set(providerId, entry);
    }
  };
  /** The providers that missed a batch: each owes its removals, and is `stale`. */
  const missedBy = (providerIds: readonly string[], batch: MemorySyncBatch): void => {
    owe(providerIds, batch.removals);
    for (const providerId of providerIds) stale.add(providerId);
  };

  /**
   * The providers a change to a record of `scope` goes to (undefined: every
   * workspace's, for a journal row whose scope is a key): each selected
   * plugin provider with `records` on (and `includePersonal` for `personal`),
   * once, whether it runs now or not. An installed one's switches count only
   * as its declaration allows them (`effectiveMemoryProviderEgress`).
   */
  const targetsOf = async (scope: MemoryScope | undefined): Promise<readonly string[]> => {
    const targets = new Set<string>();
    for (const { workspaceId } of deps.workspaces()) {
      const settings = await deps.settingsOf(workspaceId);
      if (settings.provider === BUILTIN_MEMORY_PROVIDER_ID) continue;
      const installed = deps.providers.get(settings.provider);
      // One not running is known by its approved record: what it declares it receives, and whether it keeps an index.
      const declared = installed === undefined ? await declaredOf(settings.provider) : undefined;
      const egress =
        declared === undefined
          ? effectiveMemoryProviderEgress(settings.providerEgress, installed)
          : egressAsDeclared(settings.providerEgress, declared);
      if (!egress.records) continue;
      if (scope !== undefined && !reaches(scope, workspaceId, deps.peopleOf(workspaceId))) continue;
      if (scope !== undefined && spansWorkspaces(scope) && !egress.includePersonal) continue;
      // One that keeps no index of its own, running or as its record declares, holds nothing to remove.
      if (installed !== undefined ? !indexing(installed) : declared?.index === "host") continue;
      targets.add(settings.provider);
    }
    return [...targets];
  };

  /** Whether `providerId` keeps an index of its own: as it runs, else as its approved record declares; unknown is taken as yes. */
  const keepsOwnIndex = async (providerId: string): Promise<boolean> => {
    const installed = deps.providers.get(providerId);
    return installed !== undefined ? indexing(installed) : (await declaredOf(providerId))?.index !== "host";
  };

  /**
   * A change that could not be prepared (a read threw): every provider it
   * may have gone to — `targets`, else each selected external one — is
   * `stale`, and is sent its whole index again at the next pass.
   */
  const unprepared = async (targets: readonly string[] | undefined): Promise<void> => {
    for (const providerId of targets ?? (await selectedExternal().catch(() => []))) stale.add(providerId);
  };

  /** Send a record's change to every provider it goes to; answers those that could not take it now. */
  const deliver = async (
    scope: MemoryScope | undefined,
    batch: MemorySyncBatch,
    targets?: readonly string[],
  ): Promise<readonly string[]> => {
    const missed: string[] = [];
    for (const providerId of targets ?? (await targetsOf(scope))) {
      const installed = deps.providers.get(providerId);
      if (!indexing(installed) || !(await send(installed, batch))) missed.push(providerId);
    }
    return missed;
  };

  /**
   * A committed write's record, to every provider it goes to: an upsert while
   * it may be held, else a removal. `origin` is the write: one just `written`
   * that may not be held (sensitive, waiting) was never sent; one `decided`
   * (approved, revoked) that is sensitive never was either (the approval of a
   * sensitive proposal, the revoke of a sensitive record); one `corrected` to
   * sensitive leaves wherever it was held.
   */
  const changed = async (
    record: MemoryRecord | undefined,
    actor: MemoryActor,
    origin: "written" | "decided" | "corrected",
  ): Promise<void> => {
    if (record === undefined) return;
    evict(record.recordId);
    // Not even its id goes.
    if (origin === "written" && !holdable(record)) return;
    let targets: readonly string[] | undefined;
    try {
      // Nothing to read when no provider it goes to keeps an index (the usual case: the built-in).
      targets = await targetsOf(record.scope);
      if (targets.length === 0) return;
      const snapshot = holdable(record) ? await snapshotOf(record, actor) : undefined;
      // Whether a `personal` record may go is each workspace's `includePersonal` (`targetsOf`).
      const batch: MemorySyncBatch =
        snapshot !== undefined
          ? { upserts: [snapshot], removals: [] }
          : { upserts: [], removals: [{ recordId: record.recordId, reason: removalReasonOf(record) }] };
      // Proposals and rejections were never sent, nor a sensitive record decided on: nothing to say about them.
      if (
        batch.upserts.length === 0 &&
        (!everApproved(record) || record.localOrigin === true || (origin === "decided" && record.sensitivity === "sensitive"))
      )
        return;
      missedBy(await deliver(record.scope, batch, targets), batch);
    } catch (error) {
      deps.log("a memory change could not be sent to the providers", {
        recordId: record.recordId,
        error: errorMessage(error, "unknown").slice(0, 200),
      });
      await unprepared(targets);
    }
  };

  /**
   * An approved preference expires the lapsed one holding its key in its
   * scope on the way (the service's own step): that one leaves every index
   * it went to, as `expired`. A removal carries an id only, so one sent
   * before is harmless.
   */
  const lapsedPreferences = async (record: MemoryRecord, actor: MemoryActor): Promise<void> => {
    if (record.kind !== "preference" || record.preferenceKey === undefined || record.status !== "approved") return;
    let targets: readonly string[] | undefined;
    try {
      targets = await targetsOf(record.scope);
      if (targets.length === 0) return;
      const expired = (
        await deps.memory.list({ actor, scope: record.scope, kinds: ["preference"], statuses: ["expired"], limit: MEMORY_LIST_PAGE_MAX })
      ).filter((other) => other.recordId !== record.recordId && other.preferenceKey === record.preferenceKey);
      if (expired.length === 0) return;
      for (const other of expired) evict(other.recordId);
      const batch: MemorySyncBatch = {
        upserts: [],
        removals: expired.map((other) => ({ recordId: other.recordId, reason: "expired" as const })),
      };
      missedBy(await deliver(record.scope, batch, targets), batch);
    } catch (error) {
      deps.log("an expired preference could not be removed from the providers", {
        recordId: record.recordId,
        error: errorMessage(error, "unknown").slice(0, 200),
      });
      await unprepared(targets);
    }
  };

  /**
   * The records a waiting tidy-up supersedes, read before it is
   * approved; none when no provider keeps an index (the usual case) or the
   * record is not a tidy-up.
   */
  const supersededBy = async (
    port: MemoryServicePort,
    input: { readonly actor: MemoryActor; readonly recordId?: string },
  ): Promise<readonly string[]> => {
    if (input.recordId === undefined) return [];
    let targets: readonly string[] | undefined;
    try {
      targets = await targetsOf(undefined);
      if (targets.length === 0) return [];
      const related = await port.related({ actor: input.actor, recordId: input.recordId });
      return (related.supersedes ?? []).map((entry) => entry.recordId);
    } catch {
      // What it supersedes is unknown: each provider it may go to drops it with its whole index, at the next pass.
      await unprepared(targets);
      return [];
    }
  };

  /** An approved tidy-up's inputs leave every index they went to, as `superseded`. A removal carries an id only. */
  const superseded = async (record: MemoryRecord, inputs: readonly string[]): Promise<void> => {
    if (inputs.length === 0 || record.status !== "approved") return;
    for (const recordId of inputs) evict(recordId);
    const batch: MemorySyncBatch = { upserts: [], removals: inputs.map((recordId) => ({ recordId, reason: "superseded" as const })) };
    let targets: readonly string[] | undefined;
    try {
      targets = await targetsOf(record.scope);
      missedBy(await deliver(record.scope, batch, targets), batch);
    } catch (error) {
      deps.log("superseded records could not be removed from the providers", {
        recordId: record.recordId,
        error: errorMessage(error, "unknown").slice(0, 200),
      });
      await unprepared(targets);
    }
  };

  /**
   * A forget's removal, before it returns: a provider that cannot take it now
   * leaves the journal row pending, naming it. `before` is the record
   * as it was, when read: one no provider may ever have held sends nothing.
   */
  const forgotten = async (receipt: MemoryDeletion, before: MemoryRecord | undefined): Promise<MemoryDeletion> => {
    evict(receipt.recordId);
    if (before !== undefined && !everApproved(before)) return receipt;
    const scope = before?.scope;
    const batch: MemorySyncBatch = { upserts: [], removals: [{ recordId: receipt.recordId, reason: "forgotten" }] };
    let missed: readonly string[];
    try {
      missed = await deliver(scope, batch);
    } catch (error) {
      deps.log("a forget's removal could not be sent to the providers", {
        recordId: receipt.recordId,
        error: errorMessage(error, "unknown").slice(0, 200),
      });
      missed = await targetsOf(scope).catch(() => []);
    }
    if (missed.length === 0) return receipt;
    // The row names who missed it; a memory with no Tavi journal row (`memoryOverride`) has it kept here too, so it is resent either way.
    await deps.journal.markDeletionPending(receipt.deletionId, missed);
    missedBy(missed, batch);
    deps.log("a forgotten record waits to be removed from a memory provider that is not running", {
      deletionId: receipt.deletionId,
      providers: missed,
    });
    return { ...receipt, cleanupStatus: "pending", pendingProviders: missed.slice(0, 16) };
  };

  /** A sync's own failure is logged, never the caller's; answers whether the work was done. The provider is then `stale`. */
  const guarded = async (what: string, providerId: string, work: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await work();
    } catch (error) {
      deps.log(`a memory provider's ${what} could not be prepared`, {
        providerId,
        error: errorMessage(error, "unknown").slice(0, 200),
      });
      return false;
    }
  };

  /** `providerId`'s whole index again; false when it could not take it now. One not running has nothing to take until it starts. */
  const sendFull = async (providerId: string): Promise<boolean> =>
    await guarded("full sync", providerId, async () => {
      const installed = deps.providers.get(providerId);
      if (!indexing(installed)) return true;
      const union = await unionFor(providerId);
      return await send(installed, { upserts: [...union.values()], removals: [], full: true });
    });

  const fullSync = async (providerId: string): Promise<void> => {
    if (await sendFull(providerId)) stale.delete(providerId);
    else stale.add(providerId);
  };

  /**
   * The pending journal rows waiting for each of `providerIds`, read per
   * provider: rows for one uninstalled for good never crowd out another's.
   * A row naming none yet (as a forget writes it) is
   * first given the providers its forget goes to now, once; with none, it is
   * complete.
   */
  const pendingRows = async (providerIds: readonly string[]): Promise<Map<string, readonly MemoryDeletion[]>> => {
    let current: readonly string[] | undefined;
    for (const row of await deps.journal.pendingDeletions(PENDING_MAX, { unassigned: true })) {
      current ??= await targetsOf(undefined);
      if (current.length === 0) await deps.journal.completeDeletion({ deletionId: row.deletionId, cleanedAt: deps.now() });
      else await deps.journal.markDeletionPending(row.deletionId, current);
    }
    const byProvider = new Map<string, readonly MemoryDeletion[]>();
    for (const providerId of providerIds) {
      const rows = await deps.journal.pendingDeletions(PENDING_MAX, { provider: providerId });
      if (rows.length > 0) byProvider.set(providerId, rows);
    }
    return byProvider;
  };

  const resendPending = async (): Promise<void> => {
    // Only a provider running now can take a removal: the rows of one that does not wait for it to start (`onInstalled`).
    const rows = await pendingRows(
      deps.providers
        .list()
        .filter((installed) => installed.kind === "plugin")
        .map((installed) => installed.id),
    );
    // Each provider that missed a removal is sent all of its own in one batch, whatever the workspaces select now:
    // a row completes once every provider it names has taken it.
    for (const providerId of new Set([...rows.keys(), ...owed.keys()])) {
      const installed = deps.providers.get(providerId);
      // Not running: they wait for it to start (`onInstalled`).
      if (installed === undefined) continue;
      const deletions = rows.get(providerId) ?? [];
      const sent = new Map(owed.get(providerId) ?? []);
      for (const row of deletions) sent.set(row.recordId, "forgotten");
      // One running that keeps no index of its own holds nothing: nothing is left to remove from it.
      if (
        indexing(installed) &&
        !(await send(installed, { upserts: [], removals: [...sent].map(([recordId, reason]) => ({ recordId, reason })) }))
      )
        continue;
      // Only what was sent leaves: a removal owed while it was sending waits for the next pass.
      const entry = owed.get(providerId);
      for (const recordId of sent.keys()) entry?.delete(recordId);
      if (entry?.size === 0) owed.delete(providerId);
      for (const row of deletions) await deps.journal.completeDeletion({ deletionId: row.deletionId, cleanedAt: deps.now(), providerId });
    }
    // A selected provider that missed a change since is sent its whole index again; one no workspace selects
    // now is sent nothing more: what it missed reaches it as removals, from the journal and `owed`.
    for (const providerId of [...stale]) {
      if ((await selecting(providerId)).length === 0) stale.delete(providerId);
      else await fullSync(providerId);
    }
  };

  // A provider that starts takes what it missed: the removals still pending, and its whole index again.
  const stopListening = deps.providers.onInstalled((installed) => {
    if (installed.kind !== "plugin") return;
    void (async () => {
      try {
        await resendPending();
        if ((await selecting(installed.id)).length > 0) await fullSync(installed.id);
      } catch (error) {
        deps.log("a memory provider that started could not be brought up to date", {
          providerId: installed.id,
          error: errorMessage(error, "unknown").slice(0, 200),
        });
      }
    })();
  });

  const wrap = (port: MemoryServicePort): MemoryServicePort => {
    type Method = (input: { readonly actor: MemoryActor; readonly recordId?: string }) => Promise<unknown>;
    const committing: Partial<Record<keyof MemoryServicePort, Method>> = {
      propose: async (input) => {
        const record = (await port.propose(input as Parameters<MemoryServicePort["propose"]>[0])) as MemoryRecord;
        await changed(record, input.actor, "written");
        return record;
      },
      remember: async (input) => {
        const record = (await port.remember(input as Parameters<MemoryServicePort["remember"]>[0])) as MemoryRecord;
        await changed(record, input.actor, "written");
        await lapsedPreferences(record, input.actor);
        return record;
      },
      approve: async (input) => {
        // A tidy-up's inputs are read first: approving it supersedes them in the same transaction.
        const inputs = await supersededBy(port, input);
        const record = (await port.approve(input as Parameters<MemoryServicePort["approve"]>[0])) as MemoryRecord;
        await changed(record, input.actor, "decided");
        await lapsedPreferences(record, input.actor);
        await superseded(record, inputs);
        return record;
      },
      correct: async (input) => {
        const record = (await port.correct(input as Parameters<MemoryServicePort["correct"]>[0])) as MemoryRecord;
        await changed(record, input.actor, "corrected");
        await lapsedPreferences(record, input.actor);
        return record;
      },
      revoke: async (input) => {
        const record = (await port.revoke(input as Parameters<MemoryServicePort["revoke"]>[0])) as MemoryRecord;
        await changed(record, input.actor, "decided");
        return record;
      },
      forget: async (input) => {
        // The record is read first, when any provider may hold it: after the forget, nothing of it is readable.
        const anyTarget = (await targetsOf(undefined).catch(() => [])).length > 0;
        const before =
          !anyTarget || input.recordId === undefined
            ? undefined
            : await Promise.resolve(port.get({ actor: input.actor, recordId: input.recordId })).then(
                (record) => record,
                () => undefined,
              );
        const receipt = (await port.forget(input as Parameters<MemoryServicePort["forget"]>[0])) as MemoryDeletion;
        return await forgotten(receipt, before);
      },
      sweepExpired: async (input) => {
        const swept = (await port.sweepExpired(input as Parameters<MemoryServicePort["sweepExpired"]>[0])) as Awaited<
          ReturnType<MemoryServicePort["sweepExpired"]>
        >;
        for (const entry of swept) evict(entry.recordId);
        if (swept.length > 0) {
          // The sweep's own forgets have no receipt here: a provider that missed them is `stale`, and drops them with its next full sync.
          const batch: MemorySyncBatch = {
            upserts: [],
            removals: swept.map((entry) => ({
              recordId: entry.recordId,
              reason: entry.outcome === "expired" ? ("expired" as const) : ("forgotten" as const),
            })),
          };
          missedBy(await deliver(undefined, batch).catch(() => []), batch);
        }
        return swept;
      },
    };
    return new Proxy(port, {
      get(target, property) {
        const method = committing[property as keyof MemoryServicePort];
        if (method !== undefined) return method;
        // Bound to the port itself, so a class with private fields still works through the wrapper.
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  };

  return {
    wrap,
    snapshotsFor: async (actor, options) => {
      const snapshots: MemorySnapshot[] = [];
      for (const record of await listAll({ actor }, options.limit * 2)) {
        if (snapshots.length >= options.limit) break;
        if (spansWorkspaces(record.scope) && !options.personal) continue;
        // A record whose snapshot cannot be read now is left out of this send, never failing the others.
        const snapshot = await snapshotOf(record, actor).catch(() => undefined);
        if (snapshot !== undefined) snapshots.push(snapshot);
      }
      return snapshots;
    },
    fullSync,
    egressNarrowed: async (workspaceId, providerId, before) => {
      const done = await guarded("egress-off removals", providerId, async () => {
        const installed = deps.providers.get(providerId);
        // One that keeps no index of its own, running or as its approved record declares, holds nothing to remove.
        if (!(await keepsOwnIndex(providerId))) return true;
        const was = await holdingsOf(workspaceId, before.providerEgress);
        if (was.length === 0) return true;
        // What another workspace selecting it still lets it hold stays.
        const kept = await unionFor(providerId);
        const removals = was
          .filter((snapshot) => !kept.has(snapshot.recordId))
          .map((snapshot) => ({ recordId: snapshot.recordId, reason: "egress-off" as const }));
        if (removals.length === 0 || (indexing(installed) && (await send(installed, { upserts: [], removals })))) return true;
        // Stopped, or it failed: it is owed them, and sent them at its next pass (one stopped, once it starts).
        owe([providerId], removals);
        return installed === undefined;
      });
      if (!done) stale.add(providerId);
    },
    resendPending,
    // Counted, never read row by row: a provider uninstalled for good can leave any number waiting.
    pendingRemovals: async () => (await deps.journal.pendingDeletionCounts()).total,
    pendingByProvider: async () => (await deps.journal.pendingDeletionCounts()).byProvider,
    startUpkeep: (everyMs, gate, every = repeatEvery) => {
      let current: Promise<void> = Promise.resolve();
      let busy = false;
      const idle = (): boolean =>
        gate?.due() === false &&
        owed.size === 0 &&
        stale.size === 0 &&
        !deps.providers.list().some((installed) => installed.kind === "plugin");
      const stopTicks = every(() => {
        if (busy || idle()) return;
        busy = true;
        current = resendPending()
          .catch((error: unknown) =>
            deps.log("pending memory provider removals could not be resent", {
              error: errorMessage(error, "unknown").slice(0, 200),
            }),
          )
          .finally(() => {
            busy = false;
            gate?.ran();
          });
      }, everyMs);
      return { stop: stopTicks, running: () => current };
    },
    selectedExternal,
    close: stopListening,
  };
}
