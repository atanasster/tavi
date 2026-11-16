import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";

import { TaviError, modHookViewsOf, pluginConfigProblems, pluginToolViews, type PluginView } from "@tavi/contracts";
import { validatePluginDirectory, type ResolvedExternalPlugin } from "@tavi/runtime";

/**
 * `tavi serve --dev-plugin <dir>`: one plugin
 * folder loaded for this owner run without being installed or approved — the
 * operator who starts the owner vouches for it. Each load runs a snapshot of
 * the folder under `<dataDir>/plugins/.dev/<id>/<hash>`, so every module of a
 * changed folder is imported fresh, and what runs is what was checked.
 */
export type DevPluginLoad = Extract<ResolvedExternalPlugin, { ok: true }>;

/** Reload this long after the last change in the folder, so one save of several files is one reload. */
const DEV_PLUGIN_RELOAD_DELAY_MS = 300;

/** Check the folder as install would and snapshot it; throws with what install would refuse. */
export function snapshotDevPlugin(source: string, snapshots: string, builtins: ReadonlySet<string>, now: () => string): DevPluginLoad {
  const { manifest, hash, files } = validatePluginDirectory(source, builtins);
  if (manifest.mcp !== undefined)
    throw new TaviError(
      "INVALID_INPUT",
      `${manifest.id} is an MCP server, which runs no owner code: add it with \`tavi mcp add\`, not --dev-plugin`,
    );
  if (manifest.entry === undefined)
    throw new TaviError(
      "INVALID_INPUT",
      `${manifest.id} has no entry: --dev-plugin loads a plugin's owner code; install a ui-only plugin to try it`,
    );
  // Run with no settings: a setting the plugin requires has to have a default.
  const problems = pluginConfigProblems(manifest, {});
  if (problems.length > 0)
    throw new TaviError("INVALID_INPUT", `${manifest.id} runs under --dev-plugin with no settings: ${problems.join("; ")}`);
  const directory = join(snapshots, manifest.id, hash);
  if (!existsSync(directory)) {
    const staging = `${directory}.${process.pid}.staging`;
    rmSync(staging, { recursive: true, force: true });
    for (const file of files) {
      const path = join(staging, ...file.relative.split("/"));
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.content, { mode: 0o600 });
    }
    mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
    // A rename, so a reload never imports a half-written snapshot.
    renameSync(staging, directory);
  }
  // Only the newest snapshot is kept: a loaded module is already in memory, and each save would otherwise leave a copy.
  for (const entry of readdirSync(join(snapshots, manifest.id))) {
    if (entry !== hash) rmSync(join(snapshots, manifest.id, entry), { recursive: true, force: true });
  }
  return {
    ok: true,
    record: {
      pluginId: manifest.id,
      version: manifest.version,
      contentHash: hash,
      manifest,
      reviewState: "approved",
      installedBy: "dev",
      installedAt: now(),
    },
    directory,
    entryPath: join(directory, manifest.entry),
    config: {},
    instances: [],
    // Kept apart from an installed plugin of the same id, which it must not read or overwrite.
    stateId: `dev:${manifest.id}`,
  };
}

/** A dev plugin as the listings show it: marked `dev`, enabled, its folder as its directory. */
export function devPluginView(load: DevPluginLoad, source: string): PluginView {
  const { manifest } = load.record;
  const tools = pluginToolViews(load.record);
  const mods = manifest.mods === undefined || manifest.mods.hooks.length === 0 ? {} : { mods: modHookViewsOf(manifest.mods) };
  const commands = manifest.mods === undefined || manifest.mods.commands.length === 0 ? {} : { commands: manifest.mods.commands };
  return {
    id: manifest.id,
    kind: "external",
    name: manifest.name,
    description: manifest.description,
    enabled: true,
    core: false,
    activeVersion: manifest.version,
    versions: [
      {
        version: manifest.version,
        reviewState: "approved",
        contentHash: load.record.contentHash,
        installedAt: load.record.installedAt,
        runsOwnerCode: true,
        tools,
        capabilities: manifest.capabilities,
        provenance: manifest.provenance,
        configFields: manifest.config,
        ...mods,
        ...commands,
      },
    ],
    directory: source,
    runsOwnerCode: true,
    tools,
    instances: [],
    configFields: manifest.config,
    config: {},
    ...mods,
    ...commands,
    dev: true,
  };
}

/**
 * Watch a dev plugin's folder and reload it after each save: a folder that no
 * longer checks out keeps the last good load running and logs why.
 */
export function watchDevPlugin(source: string, onChange: () => void, onError: (error: Error) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined = watch(source, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, DEV_PLUGIN_RELOAD_DELAY_MS);
  });
  // A folder removed or unreadable ends the watch, never the owner: the last load keeps running.
  watcher.on("error", (error) => {
    clearTimeout(timer);
    watcher?.close();
    watcher = undefined;
    onError(error);
  });
  return () => {
    clearTimeout(timer);
    watcher?.close();
    watcher = undefined;
  };
}
