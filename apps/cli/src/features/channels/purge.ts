import type { ChannelPurgeCounts, ChannelPurgeRecord, ChannelRetention, MessagingConnectionRecord, PersistencePort } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { channelDescriptorOf } from "./catalog.js";

/**
 * Purge on removal:
 * removing a connection whose channel says `retention: "purge-on-remove"`
 * schedules the erasure of what it brought in 24 hours later, which adding
 * the same platform account again cancels. When it runs, every conversation
 * task the connection mapped, in every epoch, is forgotten as `forget` does —
 * its turns, admissions' words, fold archives and the memory it taught — and
 * all of its thread's checkpoints go; then every row naming the connection,
 * the delivery targets that name it, and the media its senders brought in.
 * What stays is a counts-only `tavi_channel_purges` row. A purge stopped
 * midway runs again at the next sweep: each erasure is idempotent.
 */

/** The owner meta key a connection's remembered account is kept under. */
const accountKey = (connectionId: string): string => `channel.account:${connectionId}`;

/**
 * What a connection was, remembered while it ran: the platform's own
 * id for its account, and whether its channel purges on removal. A removal
 * made while it is closed — disabled, failing, or its plugin disabled, which
 * takes its descriptor out of the catalog — schedules and is cancelled by these.
 */
export interface RememberedAccount {
  readonly accountRef?: string;
  readonly retention: ChannelRetention;
}

export interface AccountMemory {
  readonly get: (key: string) => Promise<string | undefined>;
  readonly set: (key: string, value: string) => Promise<void>;
}

export async function rememberedAccount(meta: AccountMemory | undefined, connectionId: string): Promise<RememberedAccount | undefined> {
  const raw = await meta?.get(accountKey(connectionId));
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as { accountRef?: unknown; retention?: unknown };
    return {
      ...(typeof value.accountRef === "string" ? { accountRef: value.accountRef } : {}),
      retention: value.retention === "purge-on-remove" ? "purge-on-remove" : "keep",
    };
  } catch {
    return undefined;
  }
}

/** Remembers each open connection's account and retention, when its channel purges on removal; one already remembered is left alone. */
export async function rememberAccounts(
  meta: AccountMemory,
  connections: readonly { readonly connectionId: string; readonly providerId: string }[],
  accountRefOf: (connectionId: string) => string | undefined,
): Promise<void> {
  for (const connection of connections) {
    if (!purgesOnRemove(connection.providerId)) continue;
    const accountRef = accountRefOf(connection.connectionId);
    const value = JSON.stringify({ ...(accountRef === undefined ? {} : { accountRef }), retention: "purge-on-remove" });
    if ((await meta.get(accountKey(connection.connectionId))) !== value) await meta.set(accountKey(connection.connectionId), value);
  }
}

/** How long a removed connection's data waits for the same account to come back. */
export const CHANNEL_PURGE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface ChannelPurgeDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "channelPurges" | "messagingConnections">;
  /** Forgets one conversation task the way `forget --with-memory` does, then deletes all of its thread's checkpoints; answers how many chat notes went. */
  readonly forgetTask: (taskId: string) => Promise<{ readonly turns: number; readonly notes: number }>;
  /** Erases these artifacts, rows and bodies. */
  readonly eraseArtifacts: (artifactIds: readonly string[]) => Promise<{ readonly artifacts: number }>;
  /** Deletes a connection record still saved (its plugin was removed) with its secrets. */
  readonly removeConnection: (record: MessagingConnectionRecord) => Promise<void>;
  readonly log: (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
  readonly now: () => string;
}

/** What a removal would erase, for its confirmation. */
export interface ChannelPurgePreview {
  readonly retention: "keep" | "purge-on-remove";
  readonly conversations: number;
  readonly messages: number;
  readonly files: number;
  readonly tasks: readonly string[];
  /** Conversations beyond the `tasks` listed. */
  readonly moreTasks: number;
  /** The chat notes its conversations taught, when a running owner could count them. */
  readonly notes?: number;
  /** The routine delivery targets on it, which go with it. */
  readonly routineTargets: readonly string[];
  /** How many heartbeats lose a target on it. */
  readonly heartbeats: number;
}

/** Whether a provider's channel purges what a removed connection brought in. */
function purgesOnRemove(providerId: string): boolean {
  return channelDescriptorOf(providerId)?.retention === "purge-on-remove";
}

/** How many conversations a preview names for export. */
const PREVIEW_TASKS = 20;

/** `remembered` is what the connection was while it ran: its channel's retention when the catalog no longer holds it. */
/** `countNotes`, from a running owner, counts the chat notes the purge would forget; without it they are not counted. */
export async function purgePreview(
  deps: Pick<ChannelPurgeDependencies, "repositories"> & {
    readonly countNotes?: ((taskIds: readonly string[]) => Promise<number>) | undefined;
  },
  connection: Pick<MessagingConnectionRecord, "connectionId" | "providerId">,
  remembered?: RememberedAccount,
): Promise<ChannelPurgePreview> {
  if (!purgesOnRemove(connection.providerId) && remembered?.retention !== "purge-on-remove")
    return { retention: "keep", conversations: 0, messages: 0, files: 0, tasks: [], moreTasks: 0, routineTargets: [], heartbeats: 0 };
  const inventory = await deps.repositories.channelPurges.inventory(connection.connectionId);
  // A count that cannot be read is left out, as offline: the preview is what a removal asks first, and must not stop it.
  const notes = deps.countNotes === undefined ? undefined : await deps.countNotes(inventory.taskIds).catch(() => undefined);
  return {
    retention: "purge-on-remove",
    conversations: inventory.conversations,
    messages: inventory.messages,
    files: inventory.artifactIds.length,
    tasks: inventory.taskIds.slice(0, PREVIEW_TASKS),
    moreTasks: Math.max(0, inventory.taskIds.length - PREVIEW_TASKS),
    ...(notes === undefined ? {} : { notes }),
    routineTargets: inventory.routineTargets,
    heartbeats: inventory.heartbeats.length,
  };
}

/**
 * Schedules a removed connection's purge, when its channel purges (or did,
 * as remembered), after the grace; the account is the platform's own id for
 * it (its status's `accountRef`, else the remembered one), or the
 * connection's account as Tavi names it.
 */
export async function schedulePurge(
  deps: Pick<ChannelPurgeDependencies, "repositories" | "now">,
  connection: Pick<MessagingConnectionRecord, "connectionId" | "providerId" | "workspaceId" | "accountIdentity">,
  accountRef: string | undefined,
  remembered?: RememberedAccount,
): Promise<ChannelPurgeRecord | undefined> {
  if (!purgesOnRemove(connection.providerId) && remembered?.retention !== "purge-on-remove") return undefined;
  return await scheduleAfterGrace(deps, connection, accountRef ?? remembered?.accountRef);
}

async function scheduleAfterGrace(
  deps: Pick<ChannelPurgeDependencies, "repositories" | "now">,
  connection: Pick<MessagingConnectionRecord, "connectionId" | "providerId" | "workspaceId" | "accountIdentity">,
  accountRef: string | undefined,
): Promise<ChannelPurgeRecord | undefined> {
  const now = deps.now();
  await deps.repositories.channelPurges.schedule({
    connectionId: connection.connectionId,
    workspaceId: connection.workspaceId,
    providerId: connection.providerId,
    accountRef: (accountRef ?? connection.accountIdentity) || connection.connectionId,
    requestedAt: now,
    purgeAfter: new Date(Date.parse(now) + CHANNEL_PURGE_GRACE_MS).toISOString(),
  });
  return deps.repositories.channelPurges.get(connection.connectionId);
}

/** The same platform account added again within the grace: its scheduled purges are cancelled. Answers their connection ids. */
export async function cancelPurgesFor(
  deps: Pick<ChannelPurgeDependencies, "repositories" | "now">,
  providerId: string,
  accountRef: string | undefined,
  opener?: { readonly connectionId: string; readonly createdAt?: string | undefined },
): Promise<readonly string[]> {
  if (accountRef === undefined || accountRef === "") return [];
  return deps.repositories.channelPurges.cancelForAccount(providerId, accountRef, deps.now(), opener);
}

/** One purge, from wherever a stopped owner left it. */
async function runPurge(deps: ChannelPurgeDependencies, purge: ChannelPurgeRecord): Promise<ChannelPurgeCounts | undefined> {
  const { channelPurges, messagingConnections } = deps.repositories;
  if (!(await channelPurges.markRunning(purge.connectionId))) return undefined;
  const inventory = await channelPurges.inventory(purge.connectionId);
  // The inventory's files first (its messages' media and what a video tool made from them): forgetting a task erases
  // its conversation's attachments and previews too, which would leave this count short of what the preview said.
  // The count is kept as it goes: a purge resumed after a stop adds to what an earlier attempt erased.
  const earlier = purge.state === "running" ? (purge.counts?.["files"] ?? 0) : 0;
  const erasedNow = await deps.eraseArtifacts(inventory.artifactIds);
  const files = { artifacts: earlier + erasedNow.artifacts };
  await channelPurges.recordProgress(purge.connectionId, { files: files.artifacts });
  let turns = 0;
  let notes = 0;
  for (const taskId of inventory.taskIds) {
    const forgotten = await deps.forgetTask(taskId);
    turns += forgotten.turns;
    notes += forgotten.notes;
  }
  // A connection whose plugin was removed is still saved: it goes too, with its secrets.
  const saved = await messagingConnections.get(purge.connectionId);
  if (saved !== undefined && saved.deletedAt === undefined) await deps.removeConnection(saved);
  // The rows, and the purge finished with its counts, in one transaction: a resumed purge never records zeros.
  const erased = await channelPurges.erase(
    purge.connectionId,
    inventory.taskIds,
    { tasks: inventory.taskIds.length, turns, notes, files: files.artifacts },
    deps.now(),
  );
  const counts = erased.counts;
  deps.log("info", "a removed connection's data was purged", {
    connectionId: purge.connectionId,
    providerId: purge.providerId,
    counts,
    ...(erased.routineTargets.length === 0 ? {} : { routineTargetsRemoved: erased.routineTargets }),
    ...(erased.heartbeats.length === 0 ? {} : { heartbeatsWithoutTarget: erased.heartbeats }),
  });
  return counts;
}

/** Every purge whose time has come, or that a stopped owner left running; one that fails is logged and tried at the next sweep. */
export async function runDuePurges(deps: ChannelPurgeDependencies): Promise<number> {
  let done = 0;
  for (const purge of await deps.repositories.channelPurges.listDue(deps.now())) {
    try {
      if ((await runPurge(deps, purge)) !== undefined) done += 1;
    } catch (error) {
      deps.log("error", "a removed connection's data could not be purged; the next sweep tries again", {
        connectionId: purge.connectionId,
        error: errorMessage(error),
      });
    }
  }
  return done;
}

/**
 * A removed channel plugin's connections: each of a purging
 * channel's saved connections is scheduled as a removal is, and stays saved —
 * showing its channel missing — until its purge runs, which removes it too.
 * Reinstalling the plugin within the grace opens them again, which cancels
 * it. `providerIds` are the plugin's channels that purge on removal, as its
 * reviewed manifest said: the catalog may no longer hold them. Answers the
 * connections scheduled.
 */
export async function schedulePluginChannelPurges(
  deps: Pick<ChannelPurgeDependencies, "repositories" | "now">,
  providerIds: readonly string[],
  accountRefOf: (connectionId: string) => Promise<string | undefined>,
): Promise<readonly string[]> {
  if (providerIds.length === 0) return [];
  const scheduled: string[] = [];
  for (const connection of await deps.repositories.messagingConnections.list(undefined)) {
    if (!providerIds.includes(connection.providerId)) continue;
    if ((await scheduleAfterGrace(deps, connection, await accountRefOf(connection.connectionId))) !== undefined)
      scheduled.push(connection.connectionId);
  }
  return scheduled;
}

/** What removing a channel plugin would have purged: its providers' saved connections, and what they brought in. */
export async function pluginChannelPurgePreview(
  deps: Pick<ChannelPurgeDependencies, "repositories">,
  providerIds: readonly string[],
): Promise<{ readonly connections: number; readonly conversations: number; readonly messages: number; readonly files: number }> {
  let connections = 0,
    conversations = 0,
    messages = 0,
    files = 0;
  for (const connection of await deps.repositories.messagingConnections.list(undefined)) {
    if (!providerIds.includes(connection.providerId)) continue;
    const inventory = await deps.repositories.channelPurges.inventory(connection.connectionId);
    connections += 1;
    conversations += inventory.conversations;
    messages += inventory.messages;
    files += inventory.artifactIds.length;
  }
  return { connections, conversations, messages, files };
}

/**
 * Open connections of a purging channel cancel their accounts' scheduled
 * purges: the same account added again while it could
 * not open — offline, or failing at save — or a channel plugin reinstalled
 * within a removal's grace, cancels once its connection opens, at the
 * owner's start or a reload. Answers the purges cancelled.
 */
export async function cancelOpenedPurges(
  deps: Pick<ChannelPurgeDependencies, "repositories" | "now">,
  connections: readonly { readonly connectionId: string; readonly providerId: string; readonly createdAt?: string | undefined }[],
  accountRefOf: (connectionId: string) => string | undefined,
): Promise<readonly string[]> {
  const cancelled: string[] = [];
  // Each as the opener: a connection of the account that was there before the removal cancels nothing.
  for (const connection of connections.filter((candidate) => purgesOnRemove(candidate.providerId)))
    cancelled.push(
      ...(await cancelPurgesFor(deps, connection.providerId, accountRefOf(connection.connectionId), {
        connectionId: connection.connectionId,
        createdAt: connection.createdAt,
      })),
    );
  return cancelled;
}
