import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { temporaryDirectories } from "@tavi/test-support";

import { importedBy } from "./support/imports.js";

/**
 * Artifact and shared-database qualification.
 *
 * Two gates live here that no package-local suite can check:
 *
 *  - **built artifacts resolve**: the published entry points must import from
 *    `dist`, resolve their declarations, and work — a source-only tree is not
 *    evidence that a release works;
 *  - **shared-database behaviour**: migrations, the saver sharing one handle, WAL
 *    concurrency and an offline snapshot/restore fixture.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directories = temporaryDirectories({ prefix: "tavi-artifact-", mode: 0o700 });

beforeAll(() => {
  // The release artifacts are what is under test, so build them once.
  execFileSync(process.execPath, [join(repositoryRoot, "scripts", "pnpmw.mjs"), "run", "build"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
}, 600_000);

afterAll(() => directories.cleanup());

/**
 * Load a built entry point in a child Node process.
 *
 * This suite cannot do it in-process: Vitest pins the `development` export
 * condition, so a bare `@tavi/*` import inside a `dist` bundle is re-resolved to
 * `src`. A child process without that condition is the only way to prove the
 * published graph resolves — which is the entire point of the gate.
 */
function runInBuiltGraph(script: string): string {
  // Run from the CLI application, which is the real consumer and therefore has
  // the internal package links the built graph needs. The root deliberately
  // declares no @tavi/* dependency of its own.
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: join(repositoryRoot, "apps", "cli"),
    encoding: "utf8",
  });
}

/** A script fragment that asserts the runtime resolved the entry from `dist`. */
function assertLoadedFromDist(packageName: string, specifier: string): string {
  return `
    const url = import.meta.resolve(${JSON.stringify(specifier)});
    if (!url.includes("/dist/")) {
      throw new Error(${JSON.stringify(packageName)} + " resolved to " + url + " instead of dist");
    }
    process.stdout.write("OK " + url);
  `;
}

/** Import a package's built entry point by absolute path, bypassing source. */
async function importBuilt(packagePath: string, entry = "index"): Promise<Record<string, unknown>> {
  const file = join(repositoryRoot, "packages", packagePath, "dist", `${entry}.mjs`);
  expect(existsSync(file), `${file} must exist; run the build`).toBe(true);
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

describe("built artifacts resolve and run", () => {
  it("resolves @tavi/contracts to its built output and uses it", () => {
    const output = runInBuiltGraph(`
      ${assertLoadedFromDist("@tavi/contracts", "@tavi/contracts")}
      const contracts = await import("@tavi/contracts");
      const parsed = contracts.AgentStateDataSchema.safeParse({
        stateVersion: 1,
        runId: "r",
        invocation: { workspaceId: "w", principalId: "p", runId: "r", caller: "c" },
        phase: "running",
      });
      if (!parsed.success) throw new Error("built schema rejected a valid state");
      process.stdout.write(" OK");
    `);
    expect(output).toContain("OK");
    expect(output).toContain("/packages/contracts/dist/");
  });

  it("resolves @tavi/runtime to its built output and opens a database", () => {
    const output = runInBuiltGraph(`
      ${assertLoadedFromDist("@tavi/runtime", "@tavi/runtime")}
      const { DatabaseClient } = await import("@tavi/runtime");
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tavi-built-"));
      fs.chmodSync(dir, 0o700);
      const store = await DatabaseClient.open({
        databasePath: path.join(dir, "tavi.sqlite"),
        artifactsDirectory: path.join(dir, "artifacts"),
      });
      const tables = await store.listApplicationTables();
      await store.close();
      // Windows may still hold the database file a moment after close.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      if (!tables.includes("tavi_tasks")) throw new Error("built runtime has no application tables");
      process.stdout.write(" OK");
    `);
    expect(output).toContain("OK");
    expect(output).toContain("/packages/runtime/dist/");
  });

  it("resolves the @tavi/agent-host entry points to their built output", () => {
    for (const entry of ["models", "workflow"]) {
      const output = runInBuiltGraph(`
        ${assertLoadedFromDist(`@tavi/agent-host/${entry}`, `@tavi/agent-host/${entry}`)}
        const mod = await import(${JSON.stringify(`@tavi/agent-host/${entry}`)});
        const expected = ${JSON.stringify(entry)} === "models" ? "createAiSdkModelAdapter" : "createWorkflowAdapter";
        if (typeof mod[expected] !== "function") throw new Error("missing " + expected);
        process.stdout.write(" OK");
      `);
      expect(output).toContain("OK");
      expect(output).toContain("/packages/agent-host/dist/");
    }
  });

  it("resolves the @tavi/client entry points to their built output, as one module", () => {
    const output = runInBuiltGraph(`
      ${assertLoadedFromDist("@tavi/client/node", "@tavi/client/node")}
      const root = await import("@tavi/client");
      const node = await import("@tavi/client/node");
      if (typeof node.connectToOwner !== "function") throw new Error("missing connectToOwner");
      // /node re-exports the root's own bindings rather than a copy of them.
      if (node.createClient !== root.createClient || node.CLIENT_PROTOCOLS !== root.CLIENT_PROTOCOLS) {
        throw new Error("the /node entry carries a second copy of the root");
      }
      const browser = await import("@tavi/client/browser");
      if (typeof browser.connectThroughBridge !== "function") throw new Error("missing connectThroughBridge");
      if (browser.createClient !== root.createClient || browser.CLIENT_PROTOCOLS !== root.CLIENT_PROTOCOLS) {
        throw new Error("the /browser entry carries a second copy of the root");
      }
      process.stdout.write(" OK");
    `);
    expect(output).toContain("OK");
    expect(output).toContain("/packages/client/dist/");
  });

  it("builds the client's browser entry with no Node import, in it or in any chunk it loads", () => {
    // The entry is compiled for Node like the others; this is what keeps a
    // Node-only shim or import from reaching a page's bundle unnoticed.
    const dist = join(repositoryRoot, "packages/client/dist");
    const pending = ["browser.mjs"];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop() ?? "";
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of importedBy(readFileSync(join(dist, file), "utf8"))) {
        expect(
          specifier.startsWith("node:") || ["fs", "path", "net", "module", "url"].includes(specifier),
          `${file} imports ${specifier}`,
        ).toBe(false);
        if (specifier.startsWith("./")) pending.push(specifier.slice(2));
      }
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("builds the web canvas into the CLI's ui-dist, runnable under the bridge's CSP", () => {
    const canvas = join(repositoryRoot, "apps/cli/ui-dist");
    const page = readFileSync(join(canvas, "index.html"), "utf8");
    // `script-src 'self'` and `style-src 'self'`: every script and stylesheet
    // is a file of this origin, and nothing is inline.
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(body?.trim(), "an inline script").toBe("");
      const source = /\ssrc="([^"]+)"/.exec(attributes ?? "")?.[1] ?? "";
      expect(source.startsWith("/assets/"), source).toBe(true);
      expect(existsSync(join(canvas, source)), source).toBe(true);
    }
    expect(page).not.toMatch(/<style\b|\sstyle="|\son[a-z]+="/i);
    // Stylesheets are hashed assets; the tab's icon is the one file at the root.
    for (const [, href] of page.matchAll(/<link\b[^>]*href="([^"]+)"/g)) {
      expect(href?.startsWith("/assets/") || href === "/favicon.svg", href).toBe(true);
      expect(existsSync(join(canvas, href ?? "")), href).toBe(true);
    }
    // The page's announcement region is in the initial HTML, so
    // it is in the accessibility tree before the bundle runs: a live region
    // inserted with its first message is commonly missed. Asserted as facts
    // about the tag rather than as one string, so a minifier reordering its
    // attributes does not fail a page that is correct.
    const announcer = /<[a-z]+\b([^>]*\bid="announcer"[^>]*)>/.exec(page)?.[1] ?? "";
    expect(announcer, "no #announcer in the built page").not.toBe("");
    expect(announcer).toMatch(/\baria-live="polite"/);
    expect(announcer).toMatch(/\bclass="[^"]*\bvisually-hidden\b/);
    // And it is the page's only live region: several polite queues interleave.
    // Counted per element, not per attribute — the announcer carries both
    // `role="status"` and an explicit `aria-live`.
    const regions = [...page.matchAll(/<[a-z]+\b[^>]*(?:\baria-live=|\brole="(?:status|alert|log)")[^>]*>/g)];
    expect(
      regions.map((region) => region[0]),
      "more than one live region in the built page",
    ).toHaveLength(1);
    // The same files `apps/ui` built: the copy is whole.
    expect(readdirSync(join(canvas, "assets")).sort()).toEqual(readdirSync(join(repositoryRoot, "apps/ui/dist/assets")).sort());
  });

  it("ships the built-in browser view with the canvas, holding it to the canvas's bundle rules", () => {
    const plugin = join(repositoryRoot, "apps/cli/ui-dist/plugins/tavi.browserview");
    expect(readdirSync(plugin).sort()).toEqual(["icon.svg", "live.css", "live.html", "live.js", "locales", "plugin-base.css"]);
    // Its language packs, which the canvas hands the panel as `init.messages`.
    expect(readdirSync(join(plugin, "locales")).sort()).toEqual(["bg.json"]);
    const page = readFileSync(join(plugin, "live.html"), "utf8");
    // Its document's CSP allows only its own files: nothing inline, nothing from elsewhere.
    for (const [, attributes, body] of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(body?.trim(), "an inline script").toBe("");
      expect(/\ssrc="([^"]+)"/.exec(attributes ?? "")?.[1]).toBe("live.js");
    }
    expect(page).not.toMatch(/<style\b|\sstyle="|\son[a-z]+="/i);
    expect(page).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
    const script = readFileSync(join(plugin, "live.js"), "utf8");
    expect(script).not.toMatch(/\beval\(|new Function\(/);
    expect(script).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket\(/);
  });

  it("ships declarations beside every built entry", () => {
    for (const [path, entries] of [
      ["contracts", ["index"]],
      ["runtime", ["index"]],
      ["agent-host", ["models", "workflow"]],
      ["client", ["index", "node", "browser"]],
    ] as const) {
      for (const entry of entries) {
        const declaration = join(repositoryRoot, "packages", path, "dist", `${entry}.d.mts`);
        expect(existsSync(declaration), `${declaration} must exist`).toBe(true);
      }
    }
  });

  it("publishes a contracts declaration with no Node or React dependency", () => {
    const declaration = readFileSync(join(repositoryRoot, "packages", "contracts", "dist", "index.d.mts"), "utf8");
    // The headless core must not drag a platform runtime into a consumer's types.
    for (const forbidden of ["node:", "electron", "react", "playwright"]) {
      expect(declaration).not.toContain(forbidden);
    }
  });

  it("builds both client entries, with a Node-free root that /node shares", () => {
    const dist = join(repositoryRoot, "packages", "client", "dist");
    for (const entry of ["index", "node"]) {
      for (const extension of [".mjs", ".d.mts"]) {
        expect(existsSync(join(dist, entry + extension)), `${entry}${extension} must exist`).toBe(true);
      }
    }
    // Everything the root's code and declarations can load: every emitted file
    // but the /node entry's own — its entry, and the chunks the build shares
    // between entries. The text itself may mention Node (a comment says the
    // root is Node-free), so what is checked is what each file imports.
    const rootFiles = readdirSync(dist).filter((file) => /\.(mjs|d\.mts)$/.test(file) && !file.startsWith("node"));
    expect(rootFiles).toEqual(expect.arrayContaining(["index.mjs", "index.d.mts"]));
    for (const file of rootFiles) {
      for (const specifier of importedBy(readFileSync(join(dist, file), "utf8"))) {
        const allowed =
          specifier === "@tavi/contracts" || specifier === "@tavi/contracts/util" || /^\.\/(?!node)[^/]+\.mjs$/.test(specifier);
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
    }
    // One module instance: every local chunk /node loads is one the root loads
    // too (or the root itself), never an inlined second copy of the root.
    const rootChunks = new Set(["./index.mjs", ...importedBy(readFileSync(join(dist, "index.mjs"), "utf8"))]);
    const nodeChunks = importedBy(readFileSync(join(dist, "node.mjs"), "utf8")).filter((specifier) => specifier.startsWith("./"));
    expect(nodeChunks.length).toBeGreaterThan(0);
    for (const chunk of nodeChunks) expect(rootChunks.has(chunk), `node.mjs loads ${chunk}, which the root does not`).toBe(true);
    expect(readFileSync(join(dist, "node.mjs"), "utf8")).not.toContain("function createClient");
  });

  it("loads Playwright only on first use from the built browser adapters", () => {
    // An optional peer is not installed by default, so a static import in a
    // built entry would fail the CLI at load, before any browser tool is used.
    const dist = join(repositoryRoot, "packages", "builtin", "browser", "dist");
    const DYNAMIC = /\bimport\s*\(\s*["'][^"'\n]+["']\s*\)/g;
    const texts = readdirSync(dist)
      .filter((file) => file.endsWith(".mjs"))
      .map((file) => [file, readFileSync(join(dist, file), "utf8")] as const);
    for (const [file, text] of texts) {
      expect(importedBy(text.replace(DYNAMIC, "")), `${file} imports playwright statically`).not.toContain("playwright");
    }
    const dynamic = texts.flatMap(([, text]) => importedBy([...text.matchAll(DYNAMIC)].map(([call]) => call).join("\n")));
    expect(dynamic, "a built chunk loads playwright dynamically").toContain("playwright");
  });

  it("loads React and Ink for `tavi chat` alone", () => {
    // Every other command pays nothing for the TUI: its chunk is reached only
    // through a dynamic import(), and only it names React or Ink.
    const dist = join(repositoryRoot, "apps", "cli", "dist");
    const DYNAMIC = /\bimport\s*\(\s*["'][^"'\n]+["']\s*\)/g;
    const UI = ["react", "ink", "react/jsx-runtime"];
    const files = readdirSync(dist).filter((file) => file.endsWith(".mjs"));
    const staticImports = (file: string): string[] => importedBy(readFileSync(join(dist, file), "utf8").replace(DYNAMIC, ""));
    const chat = files.filter((file) => staticImports(file).some((specifier) => UI.includes(specifier)));
    expect(chat.length, "one chunk renders the TUI").toBe(1);
    const chatChunk = `./${chat[0] ?? ""}`;
    // What `tavi` loads at start: the executable and everything it imports statically.
    const loaded = new Set<string>();
    const queue = ["executable.mjs"];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || loaded.has(file)) continue;
      loaded.add(file);
      for (const specifier of staticImports(file)) if (specifier.startsWith("./")) queue.push(specifier.slice(2));
    }
    expect([...loaded], "the TUI chunk is not loaded at start").not.toContain(chatChunk.slice(2));
    for (const file of loaded) {
      expect(
        staticImports(file).filter((specifier) => UI.includes(specifier)),
        `${file} loads the UI at start`,
      ).toEqual([]);
    }
    const dynamic = files.flatMap((file) => [...readFileSync(join(dist, file), "utf8").matchAll(DYNAMIC)].map(([call]) => call));
    expect(
      dynamic.some((call) => call.includes(chatChunk)),
      "the TUI chunk is imported dynamically",
    ).toBe(true);
  });

  it("runs the built CLI, which resolves its internal imports from dist", () => {
    // The binary is executed by Node with no `development` condition, so any
    // internal import it needs must resolve from `dist`; a missing file fails.
    const output = execFileSync(process.execPath, [join(repositoryRoot, "apps/cli/dist/executable.mjs"), "--version"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(output).toContain("tavi");

    // And the bundle really is build output rather than a copy of the source.
    const bundle = readFileSync(join(repositoryRoot, "apps/cli", "dist", "executable.mjs"), "utf8");
    expect(bundle).not.toContain("packages/runtime/src/");
  });
});

describe("shared database behaviour", () => {
  it("records migrations in a stable order with no duplicates", async () => {
    const runtime = await importBuilt("runtime");
    const migrations = runtime["MIGRATIONS"] as readonly { readonly id: string }[];
    const ids = migrations.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("lets the saver and application share one worker connection and shut down cleanly", async () => {
    const { DatabaseClient } = (await importBuilt("runtime")) as typeof import("../packages/runtime/src/index.js");
    const { AsyncCheckpointSaver } = (await importBuilt(
      "agent-host",
      "checkpoint",
    )) as typeof import("../packages/agent-host/src/workflow/checkpoint.js");
    const directory = directories.create();
    const store = await DatabaseClient.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const saver = new AsyncCheckpointSaver(store.checkpoints);
    try {
      const rows = [];
      for await (const row of saver.list({ configurable: { thread_id: "probe", checkpoint_ns: "" } })) rows.push(row);
      expect(rows).toEqual([]);
      expect(await store.listApplicationTables()).toContain("tavi_tasks");
      expect([...(await store.listSaverTables())].sort()).toEqual(["checkpoints", "writes"]);
    } finally {
      await saver.close();
      await store.close();
    }
    expect(store.isOpen).toBe(false);
    await store.close();
  });

  it("serves a concurrent reader while a writer holds a transaction, via WAL", async () => {
    const { DatabaseClient } = (await importBuilt("runtime")) as typeof import("../packages/runtime/src/index.js");
    const directory = directories.create();
    const path = join(directory, "tavi.sqlite");
    const writer = await DatabaseClient.open({ databasePath: path, artifactsDirectory: join(directory, "artifacts") });

    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const reader = new BetterSqlite3(path, { readonly: true });
    const writerDb = new BetterSqlite3(path);
    try {
      // An OPEN WRITE TRANSACTION must not block a reader in WAL mode: that is
      // the property attach-style commands depend on.
      writerDb.exec("BEGIN IMMEDIATE");
      writerDb
        .prepare(
          "INSERT INTO tavi_tasks (task_id, workspace_id, principal_id, thread_id, checkpoint_namespace, status, final_text, operation_key, created_at, updated_at) VALUES ('t-wal','w','p','th','','running',NULL,NULL,'t','t')",
        )
        .run();
      const rows = reader.prepare("SELECT COUNT(*) AS n FROM tavi_tasks").get() as { n: number };
      // The uncommitted row is invisible to the reader, and the reader was not
      // blocked while the writer held the transaction.
      expect(rows.n).toBe(0);
      writerDb.exec("ROLLBACK");
    } finally {
      reader.close();
      writerDb.close();
      await writer.close();
    }
  });

  it("restores from an offline snapshot with the saver tables intact", async () => {
    const { DatabaseClient } = (await importBuilt("runtime")) as typeof import("../packages/runtime/src/index.js");
    const directory = directories.create();
    const path = join(directory, "tavi.sqlite");
    const original = await DatabaseClient.open({ databasePath: path, artifactsDirectory: join(directory, "artifacts") });
    await original.repositories.tasks.admit({
      prompt: { builtin: { text: "Test prompt", version: "test" } },
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-snapshot",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: "task-snapshot",
      newAdmissionId: "adm-snapshot",
      newThreadId: "thread-snapshot",
      now: "2026-01-01T00:00:00.000Z",
    });
    // The offline backup protocol: the runtime is stopped before the file is
    // copied, so no WAL state is needed to make the copy consistent.
    await original.close();
    const backupPath = join(directory, "backup.sqlite");
    copyFileSync(path, backupPath);

    const restored = await DatabaseClient.open({ databasePath: backupPath, artifactsDirectory: join(directory, "artifacts") });
    // Application and saver halves both survive the snapshot.
    expect(await restored.listApplicationTables()).toContain("tavi_tasks");
    expect([...(await restored.listSaverTables())].sort()).toEqual(["checkpoints", "writes"]);
    expect(await restored.getTask("task-snapshot")).toMatchObject({ threadId: "thread-snapshot" });
    await restored.close();
  });
});
