import { randomUUID } from "node:crypto";

import { TaviError, hostTimeZone, type ModelTarget, type RoutineDetail } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { TaviRuntime } from "../../runtime/types.js";
import { saveHeartbeatChange } from "../heartbeat/owner.js";
import { targetSourcesOf, type ModelUse } from "./targets-in-use.js";

/**
 * `tavi models replace`: every place one model is used, moved to another, in
 * one go and only when asked. A suggestion (a lifecycle sync's) never calls
 * this; a person does, after seeing the list. A connection's video model is
 * not moved: turning video on for a model asks its own disclosure.
 */

export type ReplaceRuntime = Pick<TaviRuntime, "store" | "access" | "routines" | "routerRepository" | "heartbeat" | "clock">;

/** What `replace` would change in the workspace, and what could not be read: nothing has changed yet. */
export interface ReplacePreview {
  readonly from: ModelTarget;
  readonly to: ModelTarget;
  readonly workspaceId: string;
  /** Every place that would move, or be left with a reason (`skipped`). */
  readonly usedBy: readonly ModelUse[];
  /** Places the uses could not be read from: a use there is neither listed nor moved. */
  readonly unread: readonly string[];
}

export interface ReplaceResult extends ReplacePreview {
  /** Each place moved to `to`. */
  readonly changed: readonly ModelUse[];
  /** Each place left as it was, and why: a video model, another connection's default, an archived routine. */
  readonly skipped: readonly { readonly use: ModelUse; readonly reason: string }[];
  /** Each place whose change failed, and why: the rest still moved. */
  readonly failed: readonly { readonly use: ModelUse; readonly error: string }[];
  /** What a person should know of a change made: a routine runs its new model only once its check passes. */
  readonly notes: readonly string[];
}

const same = (left: ModelTarget, right: ModelTarget): boolean => left.connectionId === right.connectionId && left.model === right.model;
const label = (target: ModelTarget): string => `${target.connectionId}/${target.model}`;

/** Whom a replaced routine's new revision names: the operator's change, never the routine owner's. */
const REPLACE_AUTHOR = "operator";

/**
 * Checks `to` can take over from `from`: a different model, on a connection
 * that exists, that its catalog lists and does not know to be unavailable. A
 * connection never discovered (an empty catalog) takes any model, as a role does.
 */
async function assertReplaceable(runtime: ReplaceRuntime, from: ModelTarget, to: ModelTarget): Promise<void> {
  if (same(from, to)) throw new TaviError("INVALID_INPUT", `${label(from)} would replace itself`);
  const service = runtime.store.services.modelConfig;
  const connection = (await service.listConnections()).find((candidate) => candidate.connectionId === to.connectionId);
  if (connection === undefined) throw new TaviError("NOT_FOUND", `No connection ${to.connectionId}`);
  const catalog = await service.listCatalog(to.connectionId);
  const row = catalog.find((entry) => entry.modelId === to.model);
  if (catalog.length > 0 && row === undefined)
    throw new TaviError(
      "INVALID_INPUT",
      `${to.connectionId} does not list ${to.model}; check the name (tavi models show ${to.connectionId})`,
    );
  if (row?.state === "unavailable")
    throw new TaviError(
      "INVALID_INPUT",
      `${label(to)} is unavailable on its connection; pick another (tavi models show ${to.connectionId})`,
    );
}

/** What `replace` would change in `workspaceId`: the same walk as the change, writing nothing. */
export async function previewReplace(
  runtime: ReplaceRuntime,
  from: ModelTarget,
  to: ModelTarget,
  workspaceId: string,
): Promise<ReplacePreview> {
  const { changed, skipped, unread } = await walk(runtime, from, to, workspaceId, false);
  return { from, to, workspaceId, usedBy: [...changed, ...skipped.map((entry) => entry.use)], unread };
}

/**
 * Moves every use of `from` in `workspaceId` to `to`: its default, its roles
 * and their fallbacks, its activity summaries, and each person's heartbeat,
 * chats that chose it and routines (a new revision, run once its check passes).
 * The connection's own default moves only within that connection. Each place
 * is changed on its own: one that fails is named, and the rest still move.
 */
export async function replaceModel(
  runtime: ReplaceRuntime,
  from: ModelTarget,
  to: ModelTarget,
  workspaceId: string,
): Promise<ReplaceResult> {
  const result = await walk(runtime, from, to, workspaceId, true);
  const routines = result.changed.filter((use) => use.kind === "routine" || use.kind === "routine-fallback").length;
  return {
    from,
    to,
    workspaceId,
    usedBy: [...result.changed, ...result.skipped.map((entry) => entry.use), ...result.failed.map((entry) => entry.use)],
    ...result,
    notes:
      routines === 0
        ? []
        : [
            `Each routine moved is saved as a new revision: it runs on ${label(to)} once that revision's quality check passes, and on ${label(from)} until then.`,
          ],
  };
}

/** One walk over the uses: with `write`, each is moved; without, each is only counted. */
async function walk(
  runtime: ReplaceRuntime,
  from: ModelTarget,
  to: ModelTarget,
  workspaceId: string,
  write: boolean,
): Promise<{
  changed: ModelUse[];
  skipped: { use: ModelUse; reason: string }[];
  failed: { use: ModelUse; error: string }[];
  unread: string[];
}> {
  await assertReplaceable(runtime, from, to);
  const sources = targetSourcesOf(runtime);
  const service = runtime.store.services.modelConfig;
  const repositories = runtime.store.asPort().repositories;
  const changed: ModelUse[] = [];
  const skipped: { use: ModelUse; reason: string }[] = [];
  const failed: { use: ModelUse; error: string }[] = [];
  const unread: string[] = [];
  const now = (): Date => new Date(runtime.clock.now());
  /** A use that moves: counted, or moved by `body` when writing. */
  const move = async (use: ModelUse, body: () => Promise<void>): Promise<void> => {
    try {
      if (write) await body();
      changed.push(use);
    } catch (error) {
      failed.push({ use, error: errorMessage(error) });
    }
  };
  /** A read of where the model may be used: a failure is named, never taken as no use. */
  const read = async <T>(source: string, body: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await body();
    } catch (error) {
      unread.push(`${source}: ${errorMessage(error)}`);
      return undefined;
    }
  };

  const connection = (await service.listConnections()).find((candidate) => candidate.connectionId === from.connectionId);
  if (connection?.defaultModel === from.model) {
    const use: ModelUse = { kind: "connection-default" };
    if (to.connectionId !== from.connectionId)
      skipped.push({
        use,
        reason: `a connection's default is one of its own models: set it with tavi models add ${from.connectionId} --model`,
      });
    else
      await move(use, async () => {
        await service.putConnection({
          connectionId: connection.connectionId,
          label: connection.label,
          kind: connection.kind,
          baseUrl: connection.baseUrl,
          credentialRef: connection.credentialRef,
          defaultModel: to.model,
        });
      });
  }
  if (connection !== undefined && (connection.videoModels ?? []).includes(from.model))
    skipped.push({
      use: { kind: "video" },
      reason: `video is turned on per model after its disclosure: turn it on for ${to.model} in Settings → Models, or tavi models video`,
    });

  const target = await read(`${workspaceId} workspace default`, () => sources.workspaceDefault(workspaceId));
  if (target !== undefined && same(target, from))
    await move({ kind: "workspace-default", workspaceId }, async () => {
      await service.setWorkspaceDefault({ workspaceId, target: to });
    });

  for (const binding of (await read(`${workspaceId} model roles`, () => service.listRoleBindings(workspaceId))) ?? []) {
    const chain = [binding.target, ...binding.fallback];
    if (!chain.some((entry) => same(entry, from))) continue;
    // The new model takes the old one's place; where it was already in the chain, the old one just goes.
    const moved = chain.map((entry) => (same(entry, from) ? to : entry));
    const [primary, ...fallback] = moved.filter((entry, index) => moved.findIndex((other) => same(other, entry)) === index);
    if (primary === undefined) continue;
    await move({ kind: same(binding.target, from) ? "role" : "role-fallback", workspaceId, detail: binding.role }, async () => {
      await service.setRoleBinding({ workspaceId, role: binding.role, target: primary, fallback });
    });
  }

  const settings = await read(`${workspaceId} activity summaries`, () => repositories.workspaceSettings.get(workspaceId));
  const summary = settings?.settings.activitySummaryModel;
  if (settings !== undefined && summary !== undefined && same(summary, from))
    await move({ kind: "activity-summary", workspaceId }, async () => {
      await repositories.workspaceSettings.set({
        workspaceId,
        settings: { ...settings.settings, activitySummaryModel: to },
        expectedRevision: settings.revision,
        actor: "operator:command",
        now: now().toISOString(),
      });
    });

  for (const principalId of (await read(`${workspaceId} people`, () => sources.people(workspaceId))) ?? []) {
    const scope = { workspaceId, principalId };
    const heartbeat = await read(`${workspaceId} heartbeat of ${principalId}`, () => repositories.heartbeats.get(workspaceId, principalId));
    const model = heartbeat?.config.model;
    if (heartbeat !== undefined && model !== undefined && same(model, from))
      await move({ kind: "heartbeat", workspaceId }, async () => {
        await saveHeartbeatChange(
          { heartbeats: repositories.heartbeats, options: runtime.heartbeat.options, author: REPLACE_AUTHOR },
          { ...scope, timezone: settings?.settings.timezone ?? hostTimeZone(), now: now() },
          (config) => ({ ...config, model: to }),
          // Read just above: a change made since is a conflict, never overwritten.
          heartbeat.config.revision,
        );
      });

    const chosen = await read(`${workspaceId} chats of ${principalId}`, () => runtime.routerRepository.chosenTargets(scope));
    const chats = chosen?.find((entry) => same(entry, from))?.chats ?? 0;
    if (chats > 0) {
      try {
        const count = write ? await runtime.routerRepository.retargetChosen(scope, from, to) : chats;
        if (count > 0) changed.push({ kind: "chat", workspaceId, count });
      } catch (error) {
        failed.push({ use: { kind: "chat", workspaceId, count: chats }, error: errorMessage(error) });
      }
    }

    const routines = (await read(`${workspaceId} routines of ${principalId}`, () => runtime.routines.list(scope, ROUTINES_MAX))) ?? [];
    if (routines.length >= ROUTINES_MAX) unread.push(`${workspaceId} routines of ${principalId}: only the first ${ROUTINES_MAX} were read`);
    for (const listed of routines) {
      const detail = await read(`${workspaceId} routine ${listed.name}`, () => runtime.routines.get(scope, listed.routineId));
      if (detail === undefined) continue;
      const snapshot = detail.revision.snapshot;
      const stages = Object.entries(snapshot.models);
      const uses = stages.filter(([, policy]) => [policy.primary, ...policy.fallbacks].some((entry) => same(entry, from)));
      if (uses.length === 0) continue;
      const use: ModelUse = {
        kind: uses.some(([, policy]) => same(policy.primary, from)) ? "routine" : "routine-fallback",
        workspaceId,
        detail: `${listed.name} (${uses.map(([name]) => name).join(", ")})`,
      };
      if (listed.status === "archived") {
        skipped.push({ use, reason: "archived: it no longer runs, and an archived routine cannot be edited" });
        continue;
      }
      await move(use, async () => {
        const models = Object.fromEntries(
          stages.map(([name, current]) => [name, movedPolicy(current, from, to)]),
        ) as typeof snapshot.models;
        await runtime.routines.update(
          scope,
          {
            routineId: listed.routineId,
            operationKey: `models-replace-${randomUUID()}`,
            expectedRevision: detail.routine.latestRevision,
            snapshot: { ...snapshot, models },
            changeSummary: `Model ${label(from)} replaced by ${label(to)}`,
          },
          undefined,
          REPLACE_AUTHOR,
        );
      });
    }
  }
  return { changed, skipped, failed, unread };
}

/** The most routines one person's list returns, as the use listing reads them. */
const ROUTINES_MAX = 200;

type RoutinePolicy = RoutineDetail["revision"]["snapshot"]["models"]["research"];

/** A stage's chain with `from` moved to `to`: the binding kept only on the same connection, and no target twice. */
function movedPolicy(policy: RoutinePolicy, from: ModelTarget, to: ModelTarget): RoutinePolicy {
  const move = (entry: RoutinePolicy["primary"]): RoutinePolicy["primary"] => {
    if (!same(entry, from)) return entry;
    const { bindingHash, ...rest } = entry;
    return {
      ...rest,
      connectionId: to.connectionId,
      model: to.model,
      ...(bindingHash !== undefined && to.connectionId === from.connectionId ? { bindingHash } : {}),
    };
  };
  const chain = [policy.primary, ...policy.fallbacks].map(move);
  const unique = chain.filter((entry, index) => chain.findIndex((other) => same(other, entry)) === index);
  const [primary, ...fallbacks] = unique;
  return { primary: primary ?? move(policy.primary), fallbacks };
}
