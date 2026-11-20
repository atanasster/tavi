import type { ChosenModelTarget, ModelTarget, ModelUse } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { TaviRuntime } from "../../runtime/types.js";

/**
 * Every model tavi keeps a reference to, and where: what a model lifecycle
 * check has to cover. A fallback is listed as its own use: when a primary
 * model retires, its fallback chain takes over without an error, so a retired
 * fallback is as worth knowing as a retired primary.
 */

export type { ModelUse };

export interface ModelTargetInUse {
  readonly connectionId: string;
  readonly model: string;
  readonly usedBy: readonly ModelUse[];
}

export interface ModelTargetsInUse {
  readonly targets: readonly ModelTargetInUse[];
  /** Sources that could not be read, and why: the rest still count. */
  readonly unread: readonly string[];
}

/** The reads the collection needs, each as narrow as one source: {@link targetSourcesOf} gives them from a runtime. */
export interface TargetSources {
  readonly connections: () => Promise<
    readonly {
      readonly connectionId: string;
      readonly defaultModel?: string | undefined;
      readonly videoModels?: readonly string[] | undefined;
    }[]
  >;
  readonly workspaceIds: () => readonly string[];
  /** The workspace's principal, the people allowed in it, and anyone since revoked who still owns a routine. */
  readonly people: (workspaceId: string) => Promise<readonly string[]>;
  readonly workspaceDefault: (workspaceId: string) => Promise<ModelTarget | undefined>;
  readonly roleBindings: (
    workspaceId: string,
  ) => Promise<readonly { readonly role: string; readonly target: ModelTarget; readonly fallback: readonly ModelTarget[] }[]>;
  readonly activitySummaryModel: (workspaceId: string) => Promise<ModelTarget | undefined>;
  readonly heartbeatModel: (scope: Scope) => Promise<ModelTarget | undefined>;
  readonly chosenTargets: (scope: Scope) => Promise<readonly ChosenModelTarget[]>;
  /** The models of the revision each routine runs, by stage; `complete` is false when only the first page of routines was read. */
  readonly routineModels: (scope: Scope) => Promise<{ readonly routines: readonly RoutineModels[]; readonly complete: boolean }>;
}

interface Scope {
  readonly workspaceId: string;
  readonly principalId: string;
}

interface RoutineModels {
  readonly name: string;
  readonly stages: Readonly<Record<string, { readonly primary: ModelTarget; readonly fallbacks: readonly ModelTarget[] }>>;
}

/** The sources from a runtime: its model configuration, workspaces, heartbeats, chats' routes and routines. */
export function targetSourcesOf(runtime: Pick<TaviRuntime, "store" | "access" | "routines" | "routerRepository">): TargetSources {
  const repositories = runtime.store.asPort().repositories;
  return {
    connections: () => repositories.modelConfig.listConnections(),
    workspaceIds: () => runtime.access.workspaceIds(),
    people: async (workspaceId) => {
      const principal = runtime.access.resolveWorkspace(workspaceId)?.principalId;
      return [
        ...new Set([
          ...(principal === undefined ? [] : [principal]),
          ...runtime.access.peopleOf(workspaceId),
          ...(await runtime.routines.owners(workspaceId)),
        ]),
      ];
    },
    workspaceDefault: async (workspaceId) => (await repositories.modelConfig.getWorkspaceDefault(workspaceId))?.target,
    roleBindings: (workspaceId) => repositories.modelConfig.listRoleBindings(workspaceId),
    activitySummaryModel: async (workspaceId) => (await repositories.workspaceSettings.get(workspaceId)).settings.activitySummaryModel,
    heartbeatModel: async (scope) => (await repositories.heartbeats.get(scope.workspaceId, scope.principalId))?.config.model,
    chosenTargets: (scope) => runtime.routerRepository.chosenTargets(scope),
    routineModels: async (scope) => {
      // One request: each routine's running revision (active, else latest); archived ones run nothing.
      const listed = await runtime.routines.modelsInUse(scope, ROUTINES_READ_MAX);
      return {
        routines: listed.map((routine) => ({ name: routine.name, stages: routine.models })),
        complete: listed.length < ROUTINES_READ_MAX,
      };
    },
  };
}

/** The most routines one person's list returns: the routine service has no paging past it. */
const ROUTINES_READ_MAX = 200;

/** The models referenced across this owner's connections and served workspaces, each with its uses. */
export async function modelTargetsInUse(sources: TargetSources): Promise<ModelTargetsInUse> {
  const uses = new Map<string, { connectionId: string; model: string; usedBy: ModelUse[] }>();
  const unread: string[] = [];
  const add = (target: ModelTarget, use: ModelUse): void => {
    const key = `${target.connectionId}\u0000${target.model}`;
    const entry = uses.get(key) ?? { connectionId: target.connectionId, model: target.model, usedBy: [] };
    entry.usedBy.push(use);
    uses.set(key, entry);
  };
  const read = async (source: string, body: () => Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (error) {
      unread.push(`${source}: ${errorMessage(error)}`);
    }
  };

  await read("model connections", async () => {
    for (const connection of await sources.connections()) {
      const { connectionId } = connection;
      if (connection.defaultModel !== undefined) add({ connectionId, model: connection.defaultModel }, { kind: "connection-default" });
      for (const model of connection.videoModels ?? []) add({ connectionId, model }, { kind: "video" });
    }
  });

  for (const workspaceId of sources.workspaceIds()) {
    await read(`${workspaceId} workspace default`, async () => {
      const target = await sources.workspaceDefault(workspaceId);
      if (target !== undefined) add(target, { kind: "workspace-default", workspaceId });
    });
    await read(`${workspaceId} model roles`, async () => {
      for (const binding of await sources.roleBindings(workspaceId)) {
        add(binding.target, { kind: "role", workspaceId, detail: binding.role });
        for (const fallback of binding.fallback) add(fallback, { kind: "role-fallback", workspaceId, detail: binding.role });
      }
    });
    await read(`${workspaceId} activity summaries`, async () => {
      const target = await sources.activitySummaryModel(workspaceId);
      if (target !== undefined) add(target, { kind: "activity-summary", workspaceId });
    });
    let people: readonly string[] = [];
    await read(`${workspaceId} people`, async () => {
      people = await sources.people(workspaceId);
    });
    for (const principalId of people) {
      const scope = { workspaceId, principalId };
      await read(`${workspaceId} heartbeat of ${principalId}`, async () => {
        const target = await sources.heartbeatModel(scope);
        if (target !== undefined) add(target, { kind: "heartbeat", workspaceId });
      });
      await read(`${workspaceId} chats of ${principalId}`, async () => {
        for (const chosen of await sources.chosenTargets(scope)) add(chosen, { kind: "chat", workspaceId, count: chosen.chats });
      });
      await read(`${workspaceId} routines of ${principalId}`, async () => {
        const { routines, complete } = await sources.routineModels(scope);
        if (!complete) unread.push(`${workspaceId} routines of ${principalId}: only the first ${routines.length} were read`);
        for (const routine of routines)
          for (const [stage, policy] of Object.entries(routine.stages)) {
            const detail = `${routine.name} (${stage})`;
            add(policy.primary, { kind: "routine", workspaceId, detail });
            for (const fallback of policy.fallbacks) add(fallback, { kind: "routine-fallback", workspaceId, detail });
          }
      });
    }
  }

  const targets = [...uses.values()].sort(
    (left, right) => left.connectionId.localeCompare(right.connectionId) || left.model.localeCompare(right.model),
  );
  return { targets, unread };
}
