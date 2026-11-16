import { randomUUID } from "node:crypto";
import {
  MEMORY_LIST_PAGE_DEFAULT,
  MEMORY_LIST_PAGE_MAX,
  TaviError,
  type MemoryActor,
  type MemoryServicePort,
  type ModelTarget,
  type RouterDecisionInput,
  type RouterPort,
  type RouterReceipt,
  type RouterScope,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";

/**
 * A chat on a local connection keeps its text, and what it produced, off
 * remote models. These wrappers hold that rule where the text would leave:
 * the router, and memory written in or recalled into a chat.
 */

/** Whether a chat used, or runs on, a local connection: its words stay off remote models. */
type ChatIsLocal = (scope: RouterScope, taskId: string) => Promise<boolean>;

/**
 * The router, asked nothing about a local chat: each decision for one answers
 * "egress" at once, as the guard does when task text may not leave, and calls
 * no provider. Answers the same router, its `decide` and `decideBatch` replaced.
 */
export function localChatRouter(router: RouterPort, chatIsLocal: ChatIsLocal): RouterPort {
  const withheld = async (input: RouterDecisionInput): Promise<RouterReceipt> => {
    const config = await router.configuration(input.scope);
    const at = new Date().toISOString();
    return {
      decisionId: randomUUID(),
      operationId: input.operationId,
      taskId: input.fence.taskId,
      turnId: input.turnId,
      feature: input.feature,
      mode: config.settings.modes[input.feature],
      configRevision: config.revision,
      policyVersion: config.settings.policyVersion,
      providerId: config.settings.provider,
      candidateHash: sha256Hex(JSON.stringify({ prompt: "", candidates: input.candidates.map((candidate) => candidate.id) })),
      permissionRevision: input.permissionRevision,
      state: "finished",
      reason: "egress",
      selectedIds: [],
      probabilities: {},
      cacheHit: false,
      elapsedMs: 0,
      startedAt: at,
      finishedAt: at,
    };
  };
  const local = async (input: RouterDecisionInput): Promise<boolean> => {
    try {
      return await chatIsLocal(input.scope, input.fence.taskId);
    } catch {
      // Unknown is local: a prompt is never sent where it might not be allowed to go.
      return true;
    }
  };
  // Patched on the router itself, not around it: the guard answers a batch's
  // left-out surfaces through its own `decide`, which then holds this rule too.
  const decide = router.decide.bind(router);
  const batch = router.decideBatch?.bind(router);
  router.decide = async (input) => ((await local(input)) ? await withheld(input) : await decide(input));
  if (batch !== undefined) {
    router.decideBatch = async (inputs) => {
      const first = inputs[0];
      return first !== undefined && (await local(first)) ? await Promise.all(inputs.map(withheld)) : await batch(inputs);
    };
  }
  return router;
}

/** What memory asks of the composition about a chat. */
interface LocalChatMemoryOptions {
  /** Whether the chat used, or runs on, a local connection: what it writes is stamped local. */
  readonly chatIsLocal: (workspaceId: string, taskId: string) => Promise<boolean>;
  /** Whether the chat's model now is a local one: only such a chat recalls what local chats wrote. */
  readonly chatRunsLocal: (actor: MemoryActor) => Promise<boolean>;
}

/** The chat an actor reads or writes for: a worker's is its chat's. */
function chatOf(actor: MemoryActor): string | undefined {
  return actor.chatTaskId ?? actor.runId;
}

/**
 * Memory that keeps a local chat's notes local:
 *
 * - a proposal or a kept note written in a chat that used or runs on a local
 *   connection is stamped `localOrigin`, as is one written about such a chat
 *   (its `originTaskId`, or a chat note's chat);
 * - a chat whose model is remote never recalls a `localOrigin` record — not by
 *   search, by preference, by id, nor through a provider's ranking.
 *
 * An actor with no chat (the operator's own commands, the background jobs) is
 * left as it is: those paths decide for themselves.
 */
export function withLocalChatMemory(port: MemoryServicePort, options: LocalChatMemoryOptions): MemoryServicePort {
  const madeLocally = async (actor: MemoryActor, chats: readonly (string | undefined)[]): Promise<boolean> => {
    for (const taskId of new Set(chats.filter((chat): chat is string => chat !== undefined))) {
      try {
        if (await options.chatIsLocal(actor.workspaceId, taskId)) return true;
      } catch {
        // Unknown is local: a note is never sent where it might not be allowed to go.
        return true;
      }
    }
    return false;
  };
  /** Whether this read is for a chat on a remote model, which reads no local chat's notes. */
  const remoteReader = async (actor: MemoryActor): Promise<boolean> => {
    if (chatOf(actor) === undefined) return false;
    try {
      return !(await options.chatRunsLocal(actor));
    } catch {
      // Unknown is remote here: the narrower read.
      return true;
    }
  };
  const stamp = async <T extends Parameters<MemoryServicePort["propose"]>[0]>(input: T): Promise<T> => {
    if (input.localOrigin === true) return input;
    const scopeChat = input.scope.kind === "run_local" ? input.scope.runId : undefined;
    return (await madeLocally(input.actor, [input.originTaskId, scopeChat, chatOf(input.actor)])) ? { ...input, localOrigin: true } : input;
  };
  /** A record a remote reader may not see answers as one that does not exist, in the service's words. */
  const absent = (recordId: string): TaviError => new TaviError("NOT_FOUND", `Memory record ${recordId} does not exist`);
  /** Whether a record is a local chat's, read as the operator would, without asking the reader's chat again. */
  const stamped = async (actor: MemoryActor, recordId: string): Promise<boolean> => {
    try {
      return (await port.get({ actor, recordId })).localOrigin === true;
    } catch {
      // Unknown is local: a record that cannot be read is withheld from a remote reader, the narrower answer
      // (one that does not exist reads as absent either way).
      return true;
    }
  };
  const replaced: Partial<Record<keyof MemoryServicePort, unknown>> = {
    propose: async (input: Parameters<MemoryServicePort["propose"]>[0]) => await port.propose(await stamp(input)),
    remember: async (input: Parameters<MemoryServicePort["remember"]>[0]) => {
      if (input.localOrigin === true) return await port.remember(input);
      const scopeChat = input.scope.kind === "run_local" ? input.scope.runId : undefined;
      return await port.remember(
        (await madeLocally(input.actor, [input.originTaskId, scopeChat, chatOf(input.actor)])) ? { ...input, localOrigin: true } : input,
      );
    },
    search: async (input: Parameters<MemoryServicePort["search"]>[0]) =>
      await port.search((await remoteReader(input.actor)) ? { ...input, excludeLocalOrigin: true } : input),
    eligible: async (input: Parameters<MemoryServicePort["eligible"]>[0]) =>
      await port.eligible((await remoteReader(input.actor)) ? { ...input, excludeLocalOrigin: true } : input),
    resolvePreferences: async (input: Parameters<MemoryServicePort["resolvePreferences"]>[0]) =>
      await port.resolvePreferences((await remoteReader(input.actor)) ? { ...input, excludeLocalOrigin: true } : input),
    list: async (input: Parameters<MemoryServicePort["list"]>[0]) =>
      (await remoteReader(input.actor)) ? await listWithoutLocalOrigin(port, input) : await port.list(input),
    get: async (input: Parameters<MemoryServicePort["get"]>[0]) => {
      const record = await port.get(input);
      if (record.localOrigin === true && (await remoteReader(input.actor))) throw absent(input.recordId);
      return record;
    },
    history: async (input: Parameters<MemoryServicePort["history"]>[0]) => {
      if ((await remoteReader(input.actor)) && (await stamped(input.actor, input.recordId))) throw absent(input.recordId);
      return await port.history(input);
    },
    related: async (input: Parameters<MemoryServicePort["related"]>[0]) => {
      if (!(await remoteReader(input.actor))) return await port.related(input);
      if (await stamped(input.actor, input.recordId)) throw absent(input.recordId);
      const related = await port.related(input);
      // A local chat's record is named to a remote reader by no title: it is left out.
      const named = async <T extends { readonly recordId: string }>(entry: T | undefined): Promise<T | undefined> =>
        entry === undefined || (await stamped(input.actor, entry.recordId)) ? undefined : entry;
      const updates = await named(related.updates);
      const mayUpdate = await named(related.mayUpdate);
      const similarTo = await named(related.similarTo);
      const kin = related.kin === undefined || related.kin === null ? related.kin : ((await named(related.kin)) ?? null);
      const supersedes =
        related.supersedes === undefined
          ? undefined
          : (await Promise.all(related.supersedes.map(named))).filter((entry) => entry !== undefined);
      return {
        ...definedOnly({ updates, mayUpdate, similarTo, kin, supersedes }),
      };
    },
  };
  return new Proxy(port, {
    get(target, property) {
      if (typeof property === "string" && property in replaced) return replaced[property as keyof MemoryServicePort];
      // Bound to the port itself, so a class with private fields still works through the wrapper.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Memory as a job on a remote model reads it (Ideas and the heartbeat on a
 * remote `fast` model): nothing a local chat wrote.
 */
export function withoutLocalOrigin(
  memory: Pick<MemoryServicePort, "list" | "eligible" | "search" | "resolvePreferences">,
): Pick<MemoryServicePort, "list" | "eligible" | "search" | "resolvePreferences"> {
  return {
    list: async (input) => await listWithoutLocalOrigin(memory, input),
    eligible: async (input) => await memory.eligible({ ...input, excludeLocalOrigin: true }),
    search: async (input) => await memory.search({ ...input, excludeLocalOrigin: true }),
    resolvePreferences: async (input) => await memory.resolvePreferences({ ...input, excludeLocalOrigin: true }),
  };
}

/** Which chats are local, and the local models they go on with (`runtime/models.ts`). */
export interface LocalChatModels {
  /** Whether a chat used, or runs on, a local connection. */
  readonly isLocal: (workspaceId: string, taskId: string) => Promise<boolean>;
  /** Which of several chats are local (`isLocal`), asked together; one that cannot be judged answers local. */
  readonly areLocal: (workspaceId: string, taskIds: readonly string[]) => Promise<ReadonlyMap<string, boolean>>;
  /** Whether a chat's model now (its own, else the default) is a local one. */
  readonly runsLocal: (workspaceId: string, taskId: string) => Promise<boolean>;
  readonly locality: (connectionId: string) => Promise<"local" | "remote" | undefined>;
  /** The local model a local chat goes on with: its own when local, else the default chain's first local one. */
  readonly localTargetOf: (workspaceId: string, taskId: string) => Promise<ModelTarget | undefined>;
  /** The workspace's `fast` model when it is local. */
  readonly localFast: (workspaceId: string) => Promise<ModelTarget | undefined>;
  /** Whether the default chain starts on a local connection. */
  readonly defaultIsLocal: (workspaceId: string) => Promise<boolean>;
  /** The local model an idea's work starts on when Ideas read local data; undefined when they run remote. */
  readonly ideaModel: (workspaceId: string) => Promise<ModelTarget | undefined>;
}

/**
 * Past-chat hits as a reader may see them: a chat on a remote model (or no
 * chat at all) finds no local chat's words; a chat on a local model finds all.
 */
export async function withoutLocalChats<T extends { readonly taskId: string }>(
  hits: readonly T[],
  chats: Pick<LocalChatModels, "areLocal" | "runsLocal">,
  workspaceId: string,
  readerTaskId: string | undefined,
): Promise<readonly T[]> {
  if (readerTaskId !== undefined && (await chats.runsLocal(workspaceId, readerTaskId))) return hits;
  const local = await chats.areLocal(
    workspaceId,
    hits.map((hit) => hit.taskId),
  );
  // Unknown is local: a chat missing from the answer is left out.
  return hits.filter((hit) => local.get(hit.taskId) === false);
}

/** A page of `list` with no local chat's record, filled from the pages after it as the service pages. */
async function listWithoutLocalOrigin(
  memory: Pick<MemoryServicePort, "list">,
  input: Parameters<MemoryServicePort["list"]>[0],
): ReturnType<MemoryServicePort["list"]> {
  const limit = Math.min(input.limit ?? MEMORY_LIST_PAGE_DEFAULT, MEMORY_LIST_PAGE_MAX);
  type Listed = Awaited<ReturnType<MemoryServicePort["list"]>>[number];
  const kept: Listed[] = [];
  const skip = input.offset ?? 0;
  // Each kept record's place among the filtered ones: the caller's offset counts those, not the raw rows.
  let passed = 0;
  for (let offset = 0; kept.length < limit; offset += MEMORY_LIST_PAGE_MAX) {
    const page = await memory.list({ ...input, offset, limit: MEMORY_LIST_PAGE_MAX });
    for (const record of page) {
      if (record.localOrigin === true) continue;
      if (passed++ < skip) continue;
      if (kept.length < limit) kept.push(record);
    }
    if (page.length < MEMORY_LIST_PAGE_MAX) break;
  }
  return kept;
}
