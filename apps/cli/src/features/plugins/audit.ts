import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { workerRefusal, type PluginManifest, type PluginView } from "@tavi/contracts";
import { readPluginManifest } from "@tavi/runtime";

/**
 * `tavi plugins audit` (the observe step before a plugin runs as a worker):
 * what a plugin running in the owner's process would lose as a
 * worker, read from its approved files without running them — the files it
 * opens, hosts it names that its manifest does not declare, the environment,
 * child processes and native addons. A static reading: it can miss what the
 * code builds at run time, and names what it finds, never what it proves.
 */
export interface PluginAuditEntry {
  readonly pluginId: string;
  readonly version: string;
  /** `in-process` (approved so, or before workers) or `process`. */
  readonly isolation: "process" | "in-process";
  /** Why it cannot be a worker at all, when it cannot. */
  readonly workerRefusal?: string;
  readonly findings: readonly string[];
}

const SOURCE = /\.(?:mjs|cjs|js)$/;
const MAX_FILES = 2_000;
const MAX_BYTES = 2 * 1024 * 1024;

/** Whether a manifest domain (`host`, `*.domain`, either with a port) covers `host`, on any port. */
function declares(domains: readonly string[], host: string): boolean {
  return domains.some((entry) => {
    const name = entry.replace(/:\d+$/, "");
    return name.startsWith("*.") ? host.endsWith(name.slice(1)) : host === name;
  });
}

function files(directory: string): readonly string[] {
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (found.length >= MAX_FILES) return;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  walk(directory);
  return found;
}

/** What the plugin's files show it would lose as a worker. */
function auditPluginSource(directory: string, manifest: PluginManifest): readonly string[] {
  const findings = new Set<string>();
  const declared = manifest.network?.domains ?? [];
  const hosts = new Set<string>();
  for (const path of files(directory)) {
    const name = relative(directory, path);
    if (path.endsWith(".node")) findings.add(`ships a native addon (${name}), which a worker loads only from its own folder`);
    if (!SOURCE.test(path) || statSync(path).size > MAX_BYTES) continue;
    const text = readFileSync(path, "utf8");
    if (/\bprocess\.env\b/.test(text))
      findings.add("reads the environment (process.env): a worker's holds only its own; read a credential with secret(key)");
    if (/["'](?:node:)?child_process["']/.test(text)) findings.add("starts child processes: as a worker they run confined with it");
    if (/["'](?:node:)?fs(?:\/promises)?["']/.test(text))
      findings.add("reads or writes files: a worker reaches only its own folder and home");
    for (const match of text.matchAll(/\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi)) hosts.add((match[1] ?? "").toLowerCase());
  }
  for (const host of [...hosts].sort()) {
    if (!declares(declared, host)) findings.add(`names ${host}, which its manifest's network.domains does not declare`);
  }
  return [...findings];
}

function auditEntry(
  pluginId: string,
  version: string,
  isolation: "process" | "in-process",
  directory: string,
  manifest: PluginManifest,
): PluginAuditEntry {
  const refusal = workerRefusal(manifest);
  return {
    pluginId,
    version,
    isolation,
    ...(refusal === undefined ? {} : { workerRefusal: refusal }),
    findings: auditPluginSource(directory, manifest),
  };
}

/**
 * What `view`'s active version would lose as a worker, read from its approved
 * files, when it is an enabled external plugin running in the owner's process
 * (approved so, or before workers); `undefined` otherwise. `tavi plugins audit`
 * and `doctor` both read it.
 */
export function inProcessAudit(
  registry: { snapshotDirectory(pluginId: string, version: string): string },
  view: PluginView,
): PluginAuditEntry | undefined {
  if (view.kind !== "external" || !view.enabled || !view.runsOwnerCode || view.isolation === "process" || view.activeVersion === undefined)
    return undefined;
  const directory = registry.snapshotDirectory(view.id, view.activeVersion);
  return auditEntry(view.id, view.activeVersion, "in-process", directory, readPluginManifest(directory));
}
