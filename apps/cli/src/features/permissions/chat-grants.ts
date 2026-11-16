import { isAutomaticDecider, LASTING_CHAT_GRANT_MS, type PersistencePort, type SessionGrant } from "@tavi/contracts";

/**
 * "Approve for this chat" grants: in a chat that never ends — a Home,
 * or a messaging conversation's chat — a grant lasts a day or the chat's
 * epoch, whichever ends first; anywhere else it lasts the chat's life.
 */
export interface ChatGrants {
  /** The task's grants still in force; one past its time is dropped as it is found. */
  sessionGrants(taskId: string): Promise<readonly SessionGrant[]>;
  /**
   * A workspace's grants still in force (of one task, when named), each with
   * the end it lapses at — a grant made before ends existed in a chat that
   * never ends shows the day after it was made. Read on
   * the owner's clock; nothing is deleted here.
   */
  listInForce(workspaceId: string, taskId?: string): Promise<readonly SessionGrant[]>;
  /**
   * Store a grant, with an end when the chat never ends. A person's grant to a
   * worker is its chat's: the chat, and every worker it starts, inherit it.
   */
  grantSession(grant: SessionGrant): Promise<void>;
  /**
   * The chat rolled over: its lasting grants end with the epoch — the chat's
   * own and its workers', at any depth, as a messaging
   * reset ends the whole tree's.
   */
  onEpochRollover(taskId: string): Promise<void>;
  /** Delete every grant past its end; returns how many went. */
  sweepExpired(): Promise<number>;
}

/** The parts of the repositories the grants use. */
export interface ChatGrantRepositories {
  readonly tasks: Pick<PersistencePort["repositories"]["tasks"], "get">;
  readonly toolPolicy: Pick<
    PersistencePort["repositories"]["toolPolicy"],
    | "listSessionGrants"
    | "listSessionGrantsForWorkspace"
    | "addSessionGrant"
    | "revokeSessionGrant"
    | "clearSessionGrants"
    | "clearTreeSessionGrants"
    | "deleteExpiredSessionGrants"
  >;
  /** A rollover's workers recorded before roots were are found through it; absent, only those under the chat's root. */
  readonly agentDelegations?: Pick<PersistencePort["repositories"]["agentDelegations"], "listChildren"> &
    Partial<Pick<PersistencePort["repositories"]["agentDelegations"], "getByWorkerTaskId">>;
}

/** How many delegations up a worker's grants are inherited from: the agent tree's own depth. */
const ANCESTORS_READ = 8;

/**
 * Workers recorded before delegation rows carried their root are found by a
 * walk down the tree: how many children it reads per task, how many tasks in
 * all, and how deep — the agent tree's own bounds.
 */
const CHILDREN_READ = 200;
const TREE_TASKS_READ = 1_000;
const TREE_DEPTH_READ = 8;

/** When a grant lapses: its own end, or — one made before ends existed, in a chat that never ends — a day after it was made. */
const grantEndOf = (grant: SessionGrant, lasting: boolean): string | undefined =>
  grant.expiresAt ?? (lasting ? new Date(Date.parse(grant.createdAt) + LASTING_CHAT_GRANT_MS).toISOString() : undefined);

/**
 * `lastingChat`: whether a task's grants belong to a chat that never ends —
 * judged from where it started, so a worker delegated from a Home and a
 * reminder said in a chat count as their chat (the composition resolves it as
 * the tool policy does).
 */
export function createChatGrants(deps: {
  readonly repositories: ChatGrantRepositories;
  readonly now: () => string;
  readonly lastingChat?: (taskId: string) => Promise<boolean>;
}): ChatGrants {
  const { tasks, toolPolicy, agentDelegations } = deps.repositories;
  const lasting =
    deps.lastingChat ??
    (async (taskId: string): Promise<boolean> => {
      const task = await tasks.get(taskId);
      return task !== undefined && (task.chatKind === "home" || task.origin === "messaging");
    });
  /** The chat a task belongs to: the top of its delegations, itself when it has none. */
  const chatOf = async (taskId: string): Promise<string> => {
    const seen = new Set([taskId]);
    let current = taskId;
    for (let hop = 0; hop < ANCESTORS_READ; hop += 1) {
      const parent = (await agentDelegations?.getByWorkerTaskId?.(current))?.parentTaskId;
      if (parent === undefined || seen.has(parent)) break;
      seen.add(parent);
      current = parent;
    }
    return current;
  };
  /** Instants compared as instants, so a differently written one still lapses. */
  const lapsedAt = (end: string | undefined, at: string): boolean => end !== undefined && Date.parse(end) <= Date.parse(at);
  return {
    async sessionGrants(taskId) {
      const at = deps.now();
      const inForceOf = async (owner: string): Promise<readonly SessionGrant[]> => {
        const grants = await toolPolicy.listSessionGrants(owner);
        const lastingHere = grants.length > 0 && (await lasting(owner));
        const lapsed = (grant: SessionGrant): boolean => lapsedAt(grantEndOf(grant, lastingHere), at);
        for (const grant of grants.filter(lapsed)) await toolPolicy.revokeSessionGrant(grant.workspaceId, grant.grantId);
        return grants.filter((grant) => !lapsed(grant));
      };
      const own = await inForceOf(taskId);
      // A worker inherits the approvals of the tasks that delegated to it: what a
      // person allowed for the chat is not asked again of each browser worker it spawned. Rules still come first.
      const parentOf = agentDelegations?.getByWorkerTaskId;
      if (parentOf === undefined) return own;
      const inherited: SessionGrant[] = [];
      const seen = new Set<string>([taskId]);
      let current = taskId;
      for (let hop = 0; hop < ANCESTORS_READ; hop += 1) {
        const parent = (await parentOf.call(agentDelegations, current))?.parentTaskId;
        if (parent === undefined || seen.has(parent)) break;
        seen.add(parent);
        inherited.push(...(await inForceOf(parent)));
        current = parent;
      }
      return [...own, ...inherited];
    },
    async listInForce(workspaceId, taskId) {
      const at = deps.now();
      const grants =
        taskId === undefined
          ? await toolPolicy.listSessionGrantsForWorkspace(workspaceId)
          : (await toolPolicy.listSessionGrants(taskId)).filter((grant) => grant.workspaceId === workspaceId);
      // Only a grant without its own end needs its chat looked up, once per task.
      const lastingOf = new Map<string, boolean>();
      const inForce: SessionGrant[] = [];
      for (const grant of grants) {
        if (grant.expiresAt === undefined && !lastingOf.has(grant.taskId)) lastingOf.set(grant.taskId, await lasting(grant.taskId));
        const end = grantEndOf(grant, lastingOf.get(grant.taskId) === true);
        if (lapsedAt(end, at)) continue;
        inForce.push(end === undefined || end === grant.expiresAt ? grant : { ...grant, expiresAt: end });
      }
      return inForce;
    },
    async grantSession(grant) {
      const owner = isAutomaticDecider(grant.createdBy) ? grant.taskId : await chatOf(grant.taskId);
      await toolPolicy.addSessionGrant({
        ...grant,
        taskId: owner,
        ...((await lasting(owner)) ? { expiresAt: new Date(Date.parse(deps.now()) + LASTING_CHAT_GRANT_MS).toISOString() } : {}),
      });
    },
    async onEpochRollover(taskId) {
      if (!(await lasting(taskId))) return;
      await toolPolicy.clearSessionGrants(taskId);
      const workspaceId = (await tasks.get(taskId))?.workspaceId;
      if (workspaceId === undefined) return;
      // Its workers' grants are keyed by their own tasks: every worker recorded
      // under this root, at any depth and however many, in one statement.
      await toolPolicy.clearTreeSessionGrants(workspaceId, taskId);
      if (agentDelegations === undefined) return;
      // A worker recorded before rows carried their root is reached only by a
      // walk down the tree, bounded; a rooted child's tree went above.
      const seen = new Set<string>([taskId]);
      let level = [taskId];
      for (let depth = 0; depth < TREE_DEPTH_READ && level.length > 0 && seen.size < TREE_TASKS_READ; depth += 1) {
        const next: string[] = [];
        for (const parent of level) {
          for (const child of await agentDelegations.listChildren(workspaceId, parent, CHILDREN_READ)) {
            if (child.rootTaskId !== undefined || seen.has(child.workerTaskId) || seen.size >= TREE_TASKS_READ) continue;
            seen.add(child.workerTaskId);
            await toolPolicy.clearSessionGrants(child.workerTaskId);
            next.push(child.workerTaskId);
          }
        }
        level = next;
      }
    },
    async sweepExpired() {
      return toolPolicy.deleteExpiredSessionGrants(deps.now());
    },
  };
}
