import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  TaviError,
  mcpTreeBounds,
  type BuiltinPluginInfo,
  type PluginConfig,
  type ProviderInstanceConfig,
  type PluginView,
} from "@tavi/contracts";
import type { Locale } from "@tavi/contracts/i18n";
import { nowTimestamp } from "@tavi/contracts/util";
import type { DatabaseClient } from "../persistence/client.js";
import { peekManifest, withDevViews, type PluginLiveStatus, type PluginRegistry as WorkerPluginRegistry } from "./registry.js";
import { prepareTree, verifyTree, type TreeCheck } from "./mcp-tree.js";
import type { PluginRegistryConfiguration } from "../persistence/plugin-registry-protocol.js";

export interface PluginRegistryOptions {
  readonly client: DatabaseClient;
  readonly directory: string;
  readonly builtins: readonly BuiltinPluginInfo[];
  readonly now?: () => string;
  /** Durable revocation has committed; abort the loaded generation before returning, resolving to a warning if its cleanup failed. */
  readonly withdraw?: (pluginId: string, version?: string) => Promise<string | undefined>;
}

/** A committed revocation; `cleanupWarning` reports a loaded generation whose cleanup failed. */
export type Withdrawal<T> = T & { readonly cleanupWarning?: string };

export class PluginRegistry {
  readonly #options: PluginRegistryOptions;
  constructor(options: PluginRegistryOptions) {
    this.#options = options;
  }
  #configuration(): PluginRegistryConfiguration {
    return { directory: this.#options.directory, builtins: this.#options.builtins, timestamp: this.#options.now?.() ?? nowTimestamp() };
  }
  snapshotDirectory(pluginId: string, version: string): string {
    return join(this.#options.directory, pluginId, version);
  }
  async install(...args: Parameters<WorkerPluginRegistry["install"]>): Promise<ReturnType<WorkerPluginRegistry["install"]>> {
    const [sourcePath, by] = args;
    const manifest = isAbsolute(sourcePath) ? peekManifest(sourcePath) : undefined;
    if (manifest?.mcp === undefined)
      return this.#options.client.call("pluginRegistry.install", { configuration: this.#configuration(), args });
    // An MCP server's files (an npm closure runs to hundreds of megabytes) are read, copied and hashed here, outside
    // the database worker; the worker only moves the staged copy into place and records it.
    const staging = join(this.#options.directory, ".staging", randomUUID());
    try {
      const prepared = prepareTree(sourcePath, staging, mcpTreeBounds(manifest.provenance.format));
      return await this.#options.client.call("pluginRegistry.commitMcpStaged", {
        configuration: this.#configuration(),
        args: [{ manifest, hash: prepared.hash, staging, index: prepared.index }, by],
      });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  async decide(...args: Parameters<WorkerPluginRegistry["decide"]>): Promise<Withdrawal<ReturnType<WorkerPluginRegistry["decide"]>>> {
    const result = await this.#options.client.call("pluginRegistry.decide", { configuration: this.#configuration(), args });
    return args[2] === "rejected" ? this.#withdraw(result, args[0], args[1]) : result;
  }
  enable(...args: Parameters<WorkerPluginRegistry["enable"]>): Promise<ReturnType<WorkerPluginRegistry["enable"]>> {
    return this.#options.client.call("pluginRegistry.enable", { configuration: this.#configuration(), args });
  }
  async disable(...args: Parameters<WorkerPluginRegistry["disable"]>): Promise<Withdrawal<ReturnType<WorkerPluginRegistry["disable"]>>> {
    const result = await this.#options.client.call("pluginRegistry.disable", { configuration: this.#configuration(), args });
    return this.#withdraw(result, args[0]);
  }
  configure(
    pluginId: string,
    set: PluginConfig,
    unset: readonly string[],
    by: string,
    version?: string,
    instances?: readonly ProviderInstanceConfig[],
  ): Promise<ReturnType<WorkerPluginRegistry["configure"]>> {
    return this.#options.client.call("pluginRegistry.configure", {
      configuration: this.#configuration(),
      args: [pluginId, set, unset, by, version, instances],
    });
  }
  async remove(...args: Parameters<WorkerPluginRegistry["remove"]>): Promise<Withdrawal<ReturnType<WorkerPluginRegistry["remove"]>>> {
    const result = await this.#options.client.call("pluginRegistry.remove", { configuration: this.#configuration(), args });
    return this.#withdraw(result, args[0], args[1]);
  }
  async #withdraw<T extends object>(result: T, pluginId: string, version?: string): Promise<Withdrawal<T>> {
    const cleanupWarning = await this.#options.withdraw?.(pluginId, version);
    return cleanupWarning === undefined ? result : { ...result, cleanupWarning };
  }
  /**
   * An MCP server's snapshot checked by its index, or fully re-hashed:
   * the files are read here, outside the database
   * worker; only the state and a fresh index cross to it.
   */
  async verifyMcp(pluginId: string, version: string, full: boolean): Promise<TreeCheck> {
    const state = await this.#options.client.call("pluginRegistry.mcpTreeState", {
      configuration: this.#configuration(),
      args: [pluginId, version],
    });
    const verified = verifyTree({
      directory: state.directory,
      contentHash: state.contentHash,
      version,
      index: state.index,
      stale: state.stale,
      full,
      bounds: mcpTreeBounds(state.format),
    });
    if (verified.index !== undefined) await this.#options.client.call("repository.mcp.putTreeIndex", [pluginId, version, verified.index]);
    return verified.check;
  }
  disabledBuiltins(): Promise<ReadonlySet<string>> {
    return this.#options.client.call("pluginRegistry.disabledBuiltins", { configuration: this.#configuration(), args: [] });
  }
  resolveEnabled(): Promise<ReturnType<WorkerPluginRegistry["resolveEnabled"]>> {
    return this.#options.client.call("pluginRegistry.resolveEnabled", { configuration: this.#configuration(), args: [] });
  }
  /** With `locale`, each version's person-facing words in that language (`PluginRegistry.list`). */
  async list(live?: PluginLiveStatus, locale?: Locale): Promise<readonly PluginView[]> {
    const views = await this.#options.client.call("pluginRegistry.list", {
      configuration: this.#configuration(),
      ...(locale === undefined ? {} : { locale }),
    });
    return withDevViews(
      views.map((view) => ({ ...view, ...live?.status(view.id) })),
      live,
    );
  }
  async show(pluginId: string, live?: PluginLiveStatus, locale?: Locale): Promise<PluginView> {
    const view = (await this.list(live, locale)).find((candidate) => candidate.id === pluginId);
    if (view === undefined) throw new TaviError("NOT_FOUND", `no plugin ${pluginId}`);
    if (view.mods === undefined && view.commands === undefined) return view;
    // A dev plugin's rows are its own, apart from an installed plugin's of its id.
    return {
      ...view,
      hookActivity: await this.#options.client.call("repository.plugins.hookActivity", [
        view.dev === true ? devAuditId(pluginId) : pluginId,
        10,
      ]),
    };
  }
}

/** The id a `--dev-plugin`'s hook audit is kept under: never an installed plugin's, whose ids have no `:`. */
export function devAuditId(pluginId: string): string {
  return `dev:${pluginId}`;
}
