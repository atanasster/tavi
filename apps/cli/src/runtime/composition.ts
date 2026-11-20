import { admitMemoryOverride } from "../server/workspace-settings-commands.js";
import { isNewDataDirectory, provisionCredentialKey } from "../features/credentials/store.js";
import { prefixedId } from "@tavi/node-kit";
import { acquireDataDirectoryOwnership, type DataDirectoryOwner, DatabaseClient, type OpenDatabaseOptions } from "@tavi/runtime";
import type { TaviRuntime, TaviRuntimeOptions, TaviRuntimeOverrides } from "./types.js";
import type { CompositionBase, LateBindings } from "./context.js";
import { composeCore } from "./core.js";
import { composeMemory } from "./memory.js";
import { composeSandbox } from "./sandbox.js";
import { composeBrowser } from "./browser.js";
import { composeAccess } from "./access.js";
import { composePlugins } from "./plugins.js";
import { composeModels } from "./models.js";
import { composeOauth } from "./oauth.js";
import { composeChannels } from "./channels.js";
import { composeTools } from "./tools.js";
import { composeFolders } from "./folders.js";
import { composeHosts } from "./hosts.js";
import { composeResearchTools } from "./research-tools.js";
import { composeRunEvents } from "./run-events.js";
import { composeApprovals } from "./approvals.js";
import { composeAsking } from "./asking.js";
import { composeWorkflow } from "./workflow.js";
import { composeRoutines } from "./routines.js";
import { composeSchedules } from "./schedules.js";
import { composeConversations } from "./conversations.js";
import { composeBuiltinPlugins } from "./builtin-plugins.js";
import { composeExternalPlugins } from "./external-plugins.js";
import { composeLifecycle, StartupCleanupIncomplete } from "./lifecycle.js";

export async function composeTaviRuntime(options: TaviRuntimeOptions, overrides: TaviRuntimeOverrides = {}): Promise<TaviRuntime> {
  // An in-memory run has no data directory, so owning one would create a
  // directory the caller never asked for and refuse runs while any owner exists.
  const needsOwnership = options.inMemory !== true;
  // Refused before anything is owned or opened: an undeclared memory service never starts.
  admitMemoryOverride(overrides.memoryOverride);
  // Unique per process, not just per pid: the session is the event stream's
  // epoch and the owner of execution leases, and a restarted daemon that reuses
  // its pid (PID 1 in a container, every time) would otherwise accept a cursor
  // from before the restart and read a dead session's leases as its own.
  const sessionId = options.ownerSession ?? prefixedId(`session-${process.pid}`);

  // Ownership is taken before the store opens, and every fallible step lives
  // inside the region that releases it: a store or migration failure must not
  // leak the lock for the lifetime of the process.
  let ownership: DataDirectoryOwner | undefined;
  let store: DatabaseClient | undefined;
  // Read before the store opens, which creates the database: whether this is the directory's first open.
  let fresh = false;
  try {
    if (needsOwnership) {
      ownership =
        overrides.ownership ??
        (await acquireDataDirectoryOwnership({
          dataDirectory: options.dataDirectory,
          sessionId,
          ...(options.allowPublicDirectory === undefined ? {} : { allowPublicDirectory: options.allowPublicDirectory }),
        }));
    }
    fresh = needsOwnership && overrides.store === undefined && isNewDataDirectory(options.dataDirectory);
    store =
      overrides.store ??
      (await DatabaseClient.open({
        ...buildStoreOptions(options),
        ...(overrides.inspectCheckpoints === true ? { checkpointMode: "inspect" as const } : {}),
      }));
    // A new data directory's credential store is encrypted from the start: the key in the OS keychain where it
    // can keep it, else in credentials.key. Every directory that existed before stays as it was.
    if (fresh) await provisionCredentialKey(options.dataDirectory, overrides.credentialKeychain);
    return await buildRuntime(store, options, overrides, ownership, sessionId);
  } catch (error) {
    if (error instanceof StartupCleanupIncomplete) throw error;
    await store?.close();
    await ownership?.release();
    throw error;
  }
}

/**
 * The runtime over an open store: each part composed in turn, from what the
 * parts before it built, and the late bindings for what a part reads from one
 * composed after it.
 */
async function buildRuntime(
  store: DatabaseClient,
  options: TaviRuntimeOptions,
  overrides: TaviRuntimeOverrides,
  ownership: DataDirectoryOwner | undefined,
  ownershipSessionId: string,
): Promise<TaviRuntime> {
  const late = {} as LateBindings;
  const base: CompositionBase = { store, options, overrides, ownership, ownershipSessionId, late };
  try {
    const core = { ...base, ...composeCore(base) };
    const memory = { ...core, ...composeMemory(core) };
    const sandbox = { ...memory, ...(await composeSandbox(memory)) };
    const browser = { ...sandbox, ...composeBrowser(sandbox) };
    const access = { ...browser, ...(await composeAccess(browser)) };
    const plugins = { ...access, ...(await composePlugins(access)) };
    const models = { ...plugins, ...(await composeModels(plugins)) };
    const oauth = { ...models, ...composeOauth(models) };
    const channels = { ...oauth, ...(await composeChannels(oauth)) };
    const tools = { ...channels, ...(await composeTools(channels)) };
    const folders = { ...tools, ...composeFolders(tools) };
    const hosts = { ...folders, ...composeHosts(folders) };
    const researchTools = { ...hosts, ...(await composeResearchTools(hosts)) };
    const runEvents = { ...researchTools, ...composeRunEvents(researchTools) };
    const approvals = { ...runEvents, ...composeApprovals(runEvents) };
    const asking = { ...approvals, ...composeAsking(approvals) };
    const workflow = { ...asking, ...composeWorkflow(asking) };
    const routines = { ...workflow, ...composeRoutines(workflow) };
    const schedules = { ...routines, ...composeSchedules(routines) };
    const conversations = { ...schedules, ...composeConversations(schedules) };
    const builtinPlugins = { ...conversations, ...composeBuiltinPlugins(conversations) };
    const externalPlugins = { ...builtinPlugins, ...(await composeExternalPlugins(builtinPlugins)) };
    return await composeLifecycle(externalPlugins);
  } catch (error) {
    // What composition named before it failed: a lifecycle that started releases it on its own close.
    late.releaseBuiltinChannels?.();
    throw error;
  }
}

function buildStoreOptions(options: TaviRuntimeOptions): OpenDatabaseOptions {
  if (options.inMemory === true) {
    return { databasePath: ":memory:", inMemory: true };
  }
  return {
    databasePath: `${options.dataDirectory}/tavi.sqlite`,
    artifactsDirectory: `${options.dataDirectory}/artifacts`,
  };
}
