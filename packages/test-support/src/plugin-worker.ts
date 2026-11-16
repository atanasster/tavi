import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PluginManifestSchema, type PluginIsolationPort, type PluginWorkerHandle, type PluginWorkerServices } from "@tavi/contracts";

import { canApplySeatbeltProfile } from "./sandbox.js";
import { temporaryDirectories } from "./temporary.js";

/**
 * A built external plugin in a real confined worker, as its
 * `worker.real.test.ts` drives it: a scratch data directory with the
 * plugin's home under it, the bundle started from `dist-plugin/`, and its
 * tools called as the operator. Run after the plugin's build; macOS always,
 * Linux in the sandbox matrix.
 */

/** Where the isolation keeps its parts, under the scratch data directory. */
export interface ConfinedWorkerPaths {
  readonly caDirectory: string;
  readonly denyRead: readonly string[];
  readonly policyDirectory: string;
}

export interface ConfinedPluginWorkerOptions {
  readonly pluginId: string;
  /** The plugin package's `dist-plugin/`. */
  readonly bundle: string;
  /** The plugin isolation the worker starts under: `createPluginIsolation` with an `srt` confinement. */
  readonly isolation: (paths: ConfinedWorkerPaths) => PluginIsolationPort;
  /** The effect a tool is called with: `read` unless this names another. */
  readonly effect?: (tool: string) => "read" | "write";
}

export interface ConfinedPluginWorker {
  /** Whether the suite runs: an `srt` sandbox is there, and the bundle is built. */
  readonly runs: boolean;
  /** The scratch data directory, and the plugin's home under it; set by `prepare`. */
  readonly root: string;
  readonly home: string;
  /** Makes the scratch data directory and the home under it: a suite's `beforeAll`. */
  prepare(prefix: string): void;
  /** Removes it: the suite's `afterAll`. */
  cleanup(): void;
  /** Starts the bundle in a worker, with no setting and services that keep nothing unless given others. */
  start(launch?: {
    readonly services?: PluginWorkerServices;
    readonly maskedSecrets?: Readonly<Record<string, string>>;
  }): Promise<PluginWorkerHandle>;
  /** Calls a tool as the operator, attended. */
  call(handle: PluginWorkerHandle, tool: string, input?: unknown): Promise<unknown>;
}

/** Services that keep and answer nothing. */
export const quietWorkerServices: PluginWorkerServices = {
  loadState: async () => ({}),
  putState: async () => undefined,
  rawSecret: async () => null,
  log: () => undefined,
  ui: () => undefined,
};

export function confinedPluginWorker(options: ConfinedPluginWorkerOptions): ConfinedPluginWorker {
  const mode = process.env["TAVI_SANDBOX_MATRIX"] ?? (process.platform === "darwin" && canApplySeatbeltProfile() ? "srt" : undefined);
  const runs = mode === "srt" && existsSync(join(options.bundle, "index.mjs"));
  const temp = temporaryDirectories();
  let root = "";
  let home = "";
  return {
    runs,
    get root() {
      return root;
    },
    get home() {
      return home;
    },
    prepare(prefix) {
      root = realpathSync(temp.create(prefix));
      home = join(root, "data", "plugins", options.pluginId, "home");
      mkdirSync(home, { recursive: true });
    },
    cleanup() {
      temp.cleanup();
    },
    async start(launch = {}) {
      const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(options.bundle, "tavi-plugin.json"), "utf8")));
      const isolation = options.isolation({
        caDirectory: join(root, "data", "sandbox-ca"),
        denyRead: [homedir(), join(root, "data", "credentials")],
        policyDirectory: join(root, "policies"),
      });
      return isolation.start(
        {
          pluginId: options.pluginId,
          version: manifest.version,
          contentHash: "a".repeat(64),
          directory: options.bundle,
          entryPath: join(options.bundle, "index.mjs"),
          manifest,
          config: {},
          maskedSecrets: launch.maskedSecrets ?? {},
          home,
        },
        launch.services ?? quietWorkerServices,
      );
    },
    call(handle, tool, input = {}) {
      return handle.callTool(tool, input, new AbortController().signal, options.effect?.(tool) ?? "read", {
        principalId: "operator",
        workspaceId: "default",
        unattended: false,
      });
    },
  };
}
