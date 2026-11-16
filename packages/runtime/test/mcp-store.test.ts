import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema, type McpToolDecision } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { hashPluginDirectory, PluginRegistry } from "../src/plugins/registry.js";
import { checkTree, hashTree, listTree, prepareTree } from "../src/plugins/mcp-tree.js";
import { SqliteStore } from "../src/persistence/store.js";

/** MCP servers' storage. */

const AT = "2026-10-13T20:00:00.000Z";
const cleanup: (() => void)[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  directories.cleanup();
});

function temp(): string {
  return directories.create("tavi-mcp-store-");
}

function opened() {
  const dataDirectory = temp();
  const store = new SqliteStore({ databasePath: join(dataDirectory, "tavi.sqlite"), artifactsDirectory: join(dataDirectory, "artifacts") });
  cleanup.push(() => store.close());
  const port = store.asPort();
  let tick = 0;
  const registry = new PluginRegistry({
    repository: port.repositories.plugins,
    mcp: port.repositories.mcp,
    directory: join(dataDirectory, "plugins"),
    builtins: [],
    now: () => new Date(Date.UTC(2026, 9, 13, 20, 0, tick++)).toISOString(),
  });
  return { store, mcp: port.repositories.mcp, registry, dataDirectory };
}

function server(
  options: { readonly id?: string; readonly version?: string; readonly format?: string; readonly files?: number } = {},
): string {
  const directory = temp();
  writeFileSync(
    join(directory, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: options.format ?? "mcp-dir", packages: [] },
      id: options.id ?? "mcp.notes",
      version: options.version ?? "1.0.0",
      name: "Notes",
      mcp: {
        abi: "tavi.mcp/1",
        transport: "stdio",
        command: ["node", "${package}/index.js"],
        ...(options.format === "mcp-npm" ? { package: { registry: "npm", name: "notes-mcp", version: "1.0.0" } } : {}),
      },
    }),
  );
  mkdirSync(join(directory, "server", "lib"), { recursive: true });
  writeFileSync(join(directory, "server", "index.js"), "process.stdin.resume();\n");
  for (let index = 0; index < (options.files ?? 0); index += 1)
    writeFileSync(join(directory, "server", "lib", `f${String(index)}.js`), `export const n = ${String(index)};\n`);
  return directory;
}

const observed = (name: string, description = `the ${name} tool`) => ({
  pluginId: "mcp.notes",
  version: "1.0.0",
  name,
  toolId: `mcp.notes.${name}`,
  observedDefHash: `hash-${name}-${description}`,
  observedDef: { name, description, inputSchema: { type: "object" } },
  suggestedEffect: "read-only" as const,
  doubtful: false,
  flagged: false,
});
const read: McpToolDecision = { effect: "read-only", timeoutMs: 60_000, askTainted: false };

describe("the MCP store", () => {
  it("records a version's tools, approves in one transaction, and pins each to its definition", () => {
    const { registry, mcp } = opened();
    registry.install(server(), "operator");
    expect(mcp.getVersion("mcp.notes", "1.0.0")).toMatchObject({ sandboxState: "srt", transport: "stdio", treeIndexStale: false });
    expect(() =>
      mcp.approveVersion({ pluginId: "mcp.notes", version: "1.0.0", by: "operator", now: AT, decisions: {}, expected: {} }),
    ).toThrow(/has not been probed/);
    mcp.putVersion({ ...mcp.getVersion("mcp.notes", "1.0.0")!, probedAt: AT, probedBy: "operator", eraPrior: { kind: "legacy" } });
    mcp.putObservedTools("mcp.notes", "1.0.0", [observed("search"), observed("delete")]);
    expect(mcp.listTools("mcp.notes", "1.0.0").map((tool) => tool.state)).toEqual(["pending", "pending"]);
    const expected = { search: "hash-search-the search tool", delete: "hash-delete-the delete tool" };
    expect(() =>
      mcp.approveVersion({ pluginId: "mcp.notes", version: "1.0.0", by: "operator", now: AT, decisions: { search: read }, expected }),
    ).toThrow(/no decision for delete/);
    // A definition that changed since the review refuses the approval: only what was reviewed is pinned.
    expect(() =>
      mcp.approveVersion({
        pluginId: "mcp.notes",
        version: "1.0.0",
        by: "operator",
        now: AT,
        decisions: { search: read, delete: "disabled" },
        expected: { ...expected, search: "hash-of-an-older-search" },
      }),
    ).toThrow(/changed since they were reviewed \(search\)/);
    const tools = mcp.approveVersion({
      pluginId: "mcp.notes",
      version: "1.0.0",
      by: "operator",
      now: AT,
      decisions: { search: read, delete: "disabled" },
      expected,
    });
    expect(tools.map((tool) => [tool.name, tool.state])).toEqual([
      ["delete", "disabled"],
      ["search", "approved"],
    ]);
    expect(tools.find((tool) => tool.name === "search")).toMatchObject({ approvedDefHash: "hash-search-the search tool", decision: read });
    expect(registry.show("mcp.notes").versions[0]?.reviewState).toBe("approved");
    // A changed definition is withheld; an unchanged one keeps its decision; a missing one is removed.
    mcp.putObservedTools("mcp.notes", "1.0.0", [observed("search", "now it says something else")]);
    expect(mcp.listTools("mcp.notes", "1.0.0").map((tool) => [tool.name, tool.state])).toEqual([
      ["delete", "removed"],
      ["search", "withheld"],
    ]);
  });

  it("rejection leaves no pending tool", () => {
    const { registry, mcp } = opened();
    registry.install(server(), "operator");
    mcp.putObservedTools("mcp.notes", "1.0.0", [observed("search")]);
    mcp.rejectVersion("mcp.notes", "1.0.0", "operator", AT);
    expect(mcp.listTools("mcp.notes").map((tool) => tool.state)).toEqual(["rejected"]);
    expect(registry.show("mcp.notes").versions[0]?.reviewState).toBe("rejected");
  });

  it("keeps one open notice per server and kind, however often it is raised (invariant 32)", () => {
    const { registry, mcp } = opened();
    registry.install(server(), "operator");
    for (let index = 0; index < 5; index += 1)
      mcp.upsertNotice({ noticeId: `n${String(index)}`, pluginId: "mcp.notes", kind: "drift", detail: { changed: index }, now: AT });
    expect(mcp.listNotices({ open: true })).toEqual([expect.objectContaining({ noticeId: "n0", detail: { changed: 4 } })]);
    expect(mcp.decideNotice("n0", "operator", AT)).toBe(true);
    mcp.upsertNotice({ noticeId: "n9", pluginId: "mcp.notes", kind: "drift", detail: {}, now: AT });
    expect(mcp.listNotices({ pluginId: "mcp.notes" }).map((notice) => notice.noticeId)).toEqual(["n0", "n9"]);
    expect(mcp.deleteNotices("mcp.notes")).toBe(2);
  });

  it("keeps one open notice when two connections raise it in turn (the partial unique index, not one connection's order)", () => {
    const { registry, mcp, dataDirectory } = opened();
    registry.install(server(), "operator");
    const other = new SqliteStore({
      databasePath: join(dataDirectory, "tavi.sqlite"),
      artifactsDirectory: join(dataDirectory, "artifacts"),
    });
    cleanup.push(() => other.close());
    const second = other.asPort().repositories.mcp;
    for (let index = 0; index < 6; index += 1)
      (index % 2 === 0 ? mcp : second).upsertNotice({
        noticeId: `c${String(index)}`,
        pluginId: "mcp.notes",
        kind: "login",
        detail: { attempt: index },
        now: AT,
      });
    expect(mcp.listNotices({ open: true })).toEqual([expect.objectContaining({ noticeId: "c0", kind: "login", detail: { attempt: 5 } })]);
    expect(second.listNotices({ open: true })).toHaveLength(1);
  });

  it("removing the version cascades its rows", () => {
    const { registry, mcp } = opened();
    registry.install(server(), "operator");
    mcp.putObservedTools("mcp.notes", "1.0.0", [observed("search")]);
    registry.remove("mcp.notes");
    expect(mcp.listVersions()).toEqual([]);
    expect(mcp.listTools("mcp.notes")).toEqual([]);
    expect(mcp.getTreeIndex("mcp.notes", "1.0.0")).toEqual([]);
  });
});

describe("the streamed tree", () => {
  it("hashes exactly as the plugin reader does", () => {
    const directory = server({ files: 3 });
    const { hash } = hashTree(
      directory,
      listTree(directory, { maxFiles: 500, maxDirectories: 500, maxDepth: 32, maxBytes: 20 * 1024 * 1024 }),
    );
    expect(hash).toBe(hashPluginDirectory(directory).hash);
  });

  it("installs a package-sized tree past the plugin reader's 500 files, and checks it by index, re-hashing only what changed", () => {
    const { registry, mcp } = opened();
    const { record } = registry.install(server({ format: "mcp-npm", files: 700 }), "operator");
    expect(record.manifest.mcp).toBeDefined();
    expect(mcp.getTreeIndex("mcp.notes", "1.0.0")).toHaveLength(702);
    expect(registry.verifyMcp("mcp.notes", "1.0.0", false)).toEqual({ ok: true, files: 702, rehashed: 0 });
    expect(registry.verifyMcp("mcp.notes", "1.0.0", true)).toMatchObject({ ok: true, files: 702, rehashed: 702 });
    const snapshot = registry.snapshotDirectory("mcp.notes", "1.0.0");
    // A file touched but unchanged is re-hashed and passes; a changed one fails, even with its mtime put back (its ctime moved).
    const touched = join(snapshot, "server", "lib", "f1.js");
    utimesSync(touched, new Date(), new Date(Date.now() + 5_000));
    expect(registry.verifyMcp("mcp.notes", "1.0.0", false)).toMatchObject({ ok: true, rehashed: 1 });
    const before = statSync(touched);
    writeFileSync(touched, "export const n = 999;\n");
    utimesSync(touched, before.atime, before.mtime);
    expect(registry.verifyMcp("mcp.notes", "1.0.0", false)).toMatchObject({ ok: false, problem: expect.stringContaining("f1.js changed") });
    writeFileSync(join(snapshot, "server", "extra.js"), "x");
    expect(
      checkTree(snapshot, mcp.getTreeIndex("mcp.notes", "1.0.0"), {
        maxFiles: 20_000,
        maxDirectories: 5_000,
        maxDepth: 64,
        maxBytes: 300 * 1024 * 1024,
      }),
    ).toMatchObject({ ok: false });
  });

  it("prepares the tree outside the worker and commits it there, refusing a manifest swapped in between", () => {
    const { registry, mcp, dataDirectory } = opened();
    const source = server({ files: 3 });
    const manifest = JSON.parse(readFileSync(join(source, "tavi-plugin.json"), "utf8")) as Record<string, unknown>;
    const staging = join(dataDirectory, "plugins", ".staging", "s1");
    const prepared = prepareTree(source, staging, { maxFiles: 500, maxDirectories: 500, maxDepth: 32, maxBytes: 20 * 1024 * 1024 });
    writeFileSync(join(staging, "tavi-plugin.json"), JSON.stringify({ ...manifest, name: "Swapped" }));
    expect(() =>
      registry.commitMcpStaged(
        { manifest: PluginManifestSchema.parse(manifest), hash: prepared.hash, staging, index: prepared.index },
        "operator",
      ),
    ).toThrow(/not the one that was read/);
    expect(mcp.listVersions()).toEqual([]);
  });

  it("a directory server keeps the plugin reader's bounds", () => {
    const { registry } = opened();
    expect(() => registry.install(server({ files: 600 }), "operator")).toThrow(/exceed 500 files/);
  });

  it("a stale index (after a restore) is re-hashed in full, then fresh again", () => {
    const { registry, mcp } = opened();
    registry.install(server({ files: 2 }), "operator");
    expect(mcp.markTreeIndexesStale()).toBe(1);
    expect(registry.verifyMcp("mcp.notes", "1.0.0", false)).toMatchObject({ ok: true, rehashed: 4 });
    expect(mcp.getVersion("mcp.notes", "1.0.0")?.treeIndexStale).toBe(false);
  });
});
