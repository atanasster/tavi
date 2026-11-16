import { type SandboxStatus, sandboxNetworkModeOf } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { FolderSpace, isBookkeepingArtifact, emptyFolderTrash } from "@tavi/runtime";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import {
  createOwnerLimits,
  createOwnerSandbox,
  createOwnerSandboxHost,
  denyingRead,
  ownerConfinement,
  ownerDenyRead,
  saveOwnerReadRoots,
} from "../features/sandbox/host.js";
import { DEFAULT_SANDBOX_OUTPUT_BYTES, readOwnerGitIdentity, registerSandboxTools } from "../features/sandbox/tools.js";
import type { MemoryContext } from "./memory.js";

/** How long `serve` waits for the sandbox's first probe before it starts anyway. */
const SANDBOX_WARM_TIMEOUT_MS = 20_000;

/** The sandbox and its limits, confinement, the folders' disk budget, and the sandbox tools. */
export async function composeSandbox(composed: MemoryContext) {
  const { late, logger, options, overrides, persistencePort, store, tools } = composed;
  // Sandbox/browser tools: registered
  // unconditionally, on every platform — `dispatchSandboxedTool`'s own
  // `NOT_CONFIGURED`/`UNAVAILABLE` gate (never this composition root)
  // is what refuses `sandbox.run` gracefully on a non-macOS host or a
  // host without a real sandbox dependency installed, so the tool
  // surface stays identical across platforms rather than silently
  // varying. Sandbox×browser pairing is out of scope — these
  // two adapters are wired independently.
  const sandboxHost =
    overrides.sandboxHostOverride ??
    createOwnerSandboxHost(
      { dataDirectory: options.dataDirectory },
      {
        writableRoots: (options.fsRoots ?? []).map((root) => resolvePath(root)),
        ...(options.sandboxNested === true ? { nested: true } : {}),
      },
    );
  // The engine runs at the tier the host settles, sweeping what a killed owner's runs left.
  // Every sandbox, server, worker, browser and PDF child in a cgroup of its own; the operator's caps for sandbox.run.
  const limits =
    overrides.limitsOverride ??
    createOwnerLimits({
      sweep: options.sandboxWarm === true,
      ...(options.sandboxLimits === undefined ? {} : { defaults: { run: options.sandboxLimits } }),
    });
  const sandbox =
    overrides.sandboxOverride ??
    createOwnerSandbox({
      host: sandboxHost,
      limits,
      stateDirectory: join(options.dataDirectory, "sandbox"),
      // The CA `sandbox.run`'s proxy terminates credential hosts' TLS with: in the data directory, which no command reads.
      caDirectory: join(options.dataDirectory, "sandbox-ca"),
      ...(options.sandboxNested === true ? { nested: true } : {}),
      ...(options.sandboxPinnedOff === true ? { pinnedOff: true } : {}),
      ...(options.sandboxParentProxy === undefined ? {} : { parentProxy: options.sandboxParentProxy }),
      ...(options.sandboxInspectTls === true ? { inspectTls: true } : {}),
      // What the engine cannot express here (srt's glob warnings, a dropped deny), logged once each.
      onWarning: (message) => logger.warn(`sandbox: ${message}`),
    });
  // MCP stdio servers, the browser, the PDF engine's and the video analysers' children are wrapped in this:
  // none reads home, the data directory or a folder given for chats but what its own policy opens.
  const confinement = denyingRead(overrides.confinementOverride ?? ownerConfinement(), ownerDenyRead(options));
  // Recorded for a command run without the owner (`tavi mcp add`'s probe), which denies the same folders.
  saveOwnerReadRoots(options);
  if (options.sandboxWarm === true) {
    // Bounded: a probe that hangs leaves the tier `checking`, and the first run probes again.
    const failed = (error: unknown): SandboxStatus => ({ tier: "unavailable", checks: [], cause: errorMessage(error) });
    const settled = await Promise.race([
      sandboxHost.check().catch(failed),
      new Promise<undefined>((done) => setTimeout(() => done(undefined), SANDBOX_WARM_TIMEOUT_MS).unref()),
    ]);
    if (settled === undefined) logger.warn("sandbox: the probe is still running; sandbox.run waits for it");
    else
      logger.info(`sandbox: ${settled.tier}${settled.mechanism === undefined ? "" : ` (${settled.mechanism})`}`, {
        ...(settled.cause === undefined ? {} : { cause: settled.cause }),
        ...(settled.fix === undefined ? {} : { fix: settled.fix }),
      });
    // A root owner and an open socket family are warned at every start, never refused.
    for (const check of settled?.checks ?? [])
      if (!check.ok && check.severity === "warning") logger.warn(`sandbox: ${check.name}: ${check.detail ?? "not as expected"}`);
  }
  // The chats' folders against their budget and the free-space floor:
  // measured when a write or a run is admitted, never on
  // every call; past a cap `.tmp/` is emptied first, then writes into the
  // managed folder and new shell runs are refused.
  const folderSpace = new FolderSpace({
    dataDirectory: options.dataDirectory,
    ...options.folderRetention,
    // A chat's workers share its folder: its `.tmp/` is not emptied while one runs.
    scratchInUse: async (managed) => {
      const task = await persistencePort.repositories.tasks.get(basename(managed));
      if (task === undefined || late.chatFolders.managedPath(task.workspaceId, task.taskId) !== managed) return false;
      return (await persistencePort.repositories.agentDelegations.countRunningInTree(task.workspaceId, task.taskId)) > 0;
    },
  });
  // Every file the owner stores for a person or the model keeps to the floor too: downloads, reports and
  // screenshots share the volume; its own bookkeeping (a fold's archive, a thumbnail) does not.
  store.guardArtifactWrites((input) => {
    if (!isBookkeepingArtifact(input)) folderSpace.checkFloor();
  });
  // What waited in `chats/.trash/` its seven days goes when an owner starts. Best effort.
  void emptyFolderTrash(options.dataDirectory)
    .then(({ failed }) => {
      for (const entry of failed)
        logger.warn("an entry of the chats' folder trash could not be deleted", { path: entry.path, reason: entry.reason });
    })
    .catch((error: unknown) => logger.warn("the chats' folder trash could not be emptied", { error: errorMessage(error) }));
  // Built per call from the calling chat's folder: it writes only the chat's own folders, reads
  // nothing of `$HOME`, the `--fs-root`s or the data directory but those
  // folders, the toolchains on the owner's PATH and `--sandbox-read`, and
  // runs with an environment of its own, never the owner's — which holds
  // provider API keys. `policyFor` in `features/sandbox/tools.ts` says
  // how.
  registerSandboxTools(tools, sandbox, {
    dataDirectory: options.dataDirectory,
    fsRoots: options.fsRoots ?? [],
    devPluginFolders: options.devPlugins ?? [],
    sandboxRead: options.sandboxRead ?? [],
    domains: options.sandboxDomains ?? [],
    workspaceDomains: async (workspaceId) =>
      (await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings.sandboxDomains ?? [],
    workspaceNetwork: async (workspaceId) =>
      sandboxNetworkModeOf((await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings),
    ...(options.sandboxCredentials === undefined
      ? {}
      : { credentials: options.sandboxCredentials, readSecret: (reference: string) => late.secrets.getSecret(reference) }),
    homeDirectory: homedir(),
    ...(options.sandboxTimeouts?.defaultMs === undefined
      ? {}
      : { resources: { timeoutMs: options.sandboxTimeouts.defaultMs, maxOutputBytes: DEFAULT_SANDBOX_OUTPUT_BYTES } }),
    ...(options.sandboxTimeouts?.maxMs === undefined ? {} : { maxTimeoutMs: options.sandboxTimeouts.maxMs }),
    ...(options.sandboxLocal === undefined ? {} : { local: options.sandboxLocal }),
    ...(options.sandboxCache === true ? { sharedCache: join(homedir(), ".cache", "tavi-sandbox") } : {}),
    gitIdentity: readOwnerGitIdentity,
    space: folderSpace,
    // What a tainted run writes into its chat's folder taints whoever reads it.
    markFolderTainted: (context) => late.chatFolders.markTainted(context.workspaceId, context.runId, context.chatTaskId),
    taintedFoldersNow: (context) => late.chatFolders.taintedFoldersNow(context.workspaceId, context.runId, context.chatTaskId),
    hostMarks: (context, roots) => late.chatFolders.taintedWritesUnder(context.workspaceId, roots),
  });
  return { confinement, folderSpace, limits, sandbox, sandboxHost };
}

export type SandboxContext = MemoryContext & Awaited<ReturnType<typeof composeSandbox>>;
