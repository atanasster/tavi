import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { mcpAddManifest, parseHeader } from "../../src/features/mcp/add.js";
import { capture } from "../support/attached-owner.js";

/** `tavi mcp add`: a server becomes a proposed plugin version; nothing runs. */

const directories = temporaryDirectories({ prefix: "tavi-mcp-add-" });
afterAll(() => directories.cleanup());

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

describe("parsing", () => {
  it("reads each form, and the server's argv after --", () => {
    expect(
      parseArgs(["mcp", "add", "ha", "--url", "https://ha.example/api/mcp", "--header", "Authorization=Bearer @token", "--lan"]).mcp,
    ).toMatchObject({
      action: "add",
      slug: "ha",
      form: { kind: "url", url: "https://ha.example/api/mcp", headers: ["Authorization=Bearer @token"], lan: true },
    });
    expect(
      parseArgs(["mcp", "add", "notes", "--dir", "/srv/notes", "--env", "MODE=local", "--", "node", "index.js", "--stdio"]).mcp,
    ).toMatchObject({
      form: { kind: "dir", path: "/srv/notes", argv: ["node", "index.js", "--stdio"] },
      env: ["MODE=local"],
    });
    expect(parseArgs(["mcp", "add", "bin", "--command", "/usr/local/bin/srv", "--", "--flag"]).mcp).toMatchObject({
      form: { kind: "command", path: "/usr/local/bin/srv", args: ["--flag"] },
    });
  });

  it("refuses mixed or missing forms", () => {
    expect(() => parseArgs(["mcp", "add", "x"])).toThrow(UsageError);
    expect(() => parseArgs(["mcp", "add", "x", "--url", "https://a.example", "--dir", "/d", "--", "node"])).toThrow(
      /one of --url, --npm, --pypi, --dir, --command, --mcpb, --registry or --preset/,
    );
    expect(() => parseArgs(["mcp", "add", "x", "--dir", "/d"])).toThrow(/argv after --/);
    expect(() => parseArgs(["mcp", "add", "x", "--url", "https://a.example", "--env", "A=b"])).toThrow(/stdio server/);
    expect(() => parseArgs(["mcp", "remove"])).toThrow(
      /expected one of add, import, probe, show, review, approve, reject, verify, logs, people/,
    );
  });

  it("reads a header's credential setting and its prefix", () => {
    expect(parseHeader("Authorization=Bearer @token")).toEqual({ name: "Authorization", source: { setting: "token", prefix: "Bearer " } });
    expect(parseHeader("X-Key=@key")).toEqual({ name: "X-Key", source: { setting: "key" } });
    expect(parseHeader("Accept=application/json")).toEqual({ name: "Accept", source: { value: "application/json" } });
    // An @ inside a word is part of the literal.
    expect(parseHeader("X-From=me@corp")).toEqual({ name: "X-From", source: { value: "me@corp" } });
  });
});

describe("the manifest add writes", () => {
  it("declares each setting it names, a header's as a credential", () => {
    const manifest = mcpAddManifest({
      slug: "ha",
      form: { kind: "url", url: "https://ha.example/api/mcp", headers: ["Authorization=Bearer @token"], lan: false },
    });
    expect(manifest).toMatchObject({
      id: "mcp.ha",
      version: "1.0.0",
      provenance: { format: "mcp-remote" },
      config: { token: { type: "credential", required: true } },
    });
    expect(manifest.mcp).toMatchObject({
      transport: "http",
      url: { value: "https://ha.example/api/mcp" },
      headers: { Authorization: { setting: "token", prefix: "Bearer " } },
      auth: "headers",
    });
  });

  it("points argv paths into the copied directory, and leaves node and absolute paths alone", () => {
    const files = new Set(["index.js", "lib/run.js"]);
    const manifest = mcpAddManifest(
      {
        slug: "notes",
        form: { kind: "dir", path: "/srv/notes", argv: ["node", "index.js", "--config", "lib/run.js", "--stdio", "/etc/hosts"] },
        env: ["NOTES_TOKEN=@token"],
      },
      (path) => files.has(path),
    );
    expect(manifest.mcp?.command).toEqual(["node", "${package}/index.js", "--config", "${package}/lib/run.js", "--stdio", "/etc/hosts"]);
    expect(manifest.config).toEqual({ token: { type: "credential", required: true, description: "The server's NOTES_TOKEN" } });
    expect(manifest.provenance.format).toBe("mcp-dir");
  });

  it("refuses an unsafe launch, environment, name or URL, with the reason", () => {
    expect(() => mcpAddManifest({ slug: "x", form: { kind: "dir", path: "/d", argv: ["npx", "-y", "pkg"] } })).toThrow(
      /npx downloads code at every start/,
    );
    expect(() =>
      mcpAddManifest({ slug: "x", form: { kind: "dir", path: "/d", argv: ["node", "a.js"] }, env: ["NODE_OPTIONS=--inspect"] }),
    ).toThrow(/NODE_OPTIONS/);
    expect(() => mcpAddManifest({ slug: "Bad-Name", form: { kind: "url", url: "https://a.example", headers: [], lan: false } })).toThrow(
      /not a server name/,
    );
    expect(() => mcpAddManifest({ slug: "x", form: { kind: "url", url: "http://a.example/mcp", headers: [], lan: false } })).toThrow(
      /plain http only with network.lan/,
    );
  });
});

describe("tavi mcp add, offline", () => {
  it("installs a proposed version that runs no owner code, shown with its launch spec", async () => {
    const at = ["--data-dir", directories.create()];
    const added = await tavi(["mcp", "add", "ha", "--url", "https://ha.example/api/mcp", "--header", "Authorization=Bearer @token", ...at]);
    expect(added.code).toBe(EXIT.ok);
    expect(added.stdout).toContain("added mcp.ha@1.0.0 (proposed)");
    expect(added.stdout).toContain("url https://ha.example/api/mcp");
    expect(added.stdout).toContain("credentials to set: token (`tavi credentials set plugins.mcp.ha.<name>`");
    const shown = await tavi(["plugins", "show", "mcp.ha", ...at]);
    expect(shown.stdout).toContain("kind: mcp");
    expect(shown.stdout).toContain("mcp url https://ha.example/api/mcp");
    expect(shown.stdout).toContain("mcp header Authorization: Bearer <credential token>");
    expect(shown.stdout).toContain("runs no owner code: an MCP server");
    expect(shown.stdout).not.toContain("it only adds to the web canvas");
    const listed = await tavi(["plugins", "list", "--format", "json", ...at]);
    expect(
      (JSON.parse(listed.stdout) as { plugins: { id: string; kind: string; runsOwnerCode: boolean; uiOnly?: true }[] }).plugins.find(
        (plugin) => plugin.id === "mcp.ha",
      ),
    ).toMatchObject({ kind: "mcp", runsOwnerCode: false });
    // The staging copy is gone; the snapshot is the registry's.
    expect(readdirSync(join(at[1] as string, "mcp", ".add"))).toEqual([]);
  });

  it("a changed launch spec needs a new version", async () => {
    const at = ["--data-dir", directories.create()];
    expect((await tavi(["mcp", "add", "docs", "--url", "https://docs.example/mcp", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["mcp", "add", "docs", "--url", "https://docs.example/mcp", ...at])).stdout).toContain("already installed");
    const changed = await tavi(["mcp", "add", "docs", "--url", "https://docs.example/other", ...at]);
    expect(changed.code).not.toBe(EXIT.ok);
    expect(changed.stderr).toContain("bump the version");
    expect((await tavi(["mcp", "add", "docs", "--url", "https://docs.example/other", "--version", "1.1.0", ...at])).code).toBe(EXIT.ok);
  });

  it("copies a local server's directory, and switching it on needs no restart", async () => {
    const at = ["--data-dir", directories.create()];
    const source = directories.create();
    mkdirSync(join(source, "lib"));
    writeFileSync(
      join(source, "index.js"),
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp", "raw-server.mjs")),
    );
    writeFileSync(join(source, "lib", "util.js"), "export {};\n");
    const added = await tavi(["mcp", "add", "local", "--dir", source, "--unsandboxed", ...at, "--", "node", "index.js"]);
    expect(added.code).toBe(EXIT.ok);
    expect(added.stdout).toContain('command ["node","${package}/index.js"]');
    const snapshot = join(at[1] as string, "plugins", "mcp.local", "1.0.0");
    expect(readFileSync(join(snapshot, "server", "lib", "util.js"), "utf8")).toBe("export {};\n");
    expect((await tavi(["mcp", "approve", "mcp.local", "1.0.0", "--unsandboxed", ...at])).code).toBe(EXIT.ok);
    const enabled = await tavi(["plugins", "enable", "mcp.local", ...at]);
    expect(enabled.code).toBe(EXIT.ok);
    expect(enabled.stderr).not.toContain("restart");
  }, 60_000);

  it("never copies $HOME or Tavi's data as a server's files, and a hand-written manifest's grants are checked at install", async () => {
    const data = directories.create();
    const at = ["--data-dir", data];
    const refused = await tavi(["mcp", "add", "home", "--dir", data, ...at, "--", "node", "x.js"]);
    expect(refused.code).not.toBe(EXIT.ok);
    expect(refused.stderr).toContain("overlaps Tavi's data directory");
    const manual = directories.create();
    writeFileSync(
      join(manual, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "mcp-dir", packages: [] },
        id: "mcp.manual",
        version: "1.0.0",
        name: "Manual",
        mcp: {
          abi: "tavi.mcp/1",
          transport: "stdio",
          command: ["node", "${package}/x.js"],
          filesystem: { read: [`${data}/plugins`], write: [] },
        },
      }),
    );
    const installed = await tavi(["plugins", "install", manual, ...at]);
    expect(installed.code).not.toBe(EXIT.ok);
    expect(installed.stderr).toContain("overlaps Tavi's data directory");
  });

  it("refuses a downloader, naming why, and installs nothing", async () => {
    const at = ["--data-dir", directories.create()];
    const source = directories.create();
    const refused = await tavi(["mcp", "add", "bad", "--dir", source, ...at, "--", "npx", "-y", "some-server"]);
    expect(refused.code).not.toBe(EXIT.ok);
    expect(refused.stderr).toContain("npx downloads code at every start");
    expect((await tavi(["plugins", "show", "mcp.bad", ...at])).code).toBe(EXIT.unavailable);
  });
});

describe("only the operator adds a server", () => {
  it("no module but the CLI's entry and the operator's mcp command imports the add path", () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
    const importers: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && /from "\.{1,2}\/(?:mcp\/)?add\.js"/.test(readFileSync(path, "utf8")))
          importers.push(relative(src, path));
      }
    };
    walk(src);
    // The CLI, and the owner's `mcp` IPC handler (`add` from Settings → Plugins): both the operator's only, by
    // the owner's socket and token; no tool, chat, channel, hook or model output reaches either.
    expect(importers.sort()).toEqual(["features/mcp/actions.ts", "features/mcp/cli-command.ts", "features/mcp/parse.ts"]);
  });
});

describe("only the operator approves, enables or allows a server", () => {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
  /** The modules of the CLI that call `pattern`: each one the operator's own path, by the owner's socket and token. */
  const callers = (pattern: RegExp): string[] => {
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && pattern.test(readFileSync(path, "utf8"))) found.push(relative(src, path));
      }
    };
    walk(src);
    return found.sort();
  };

  it("approves only through the mcp command's actions", () => {
    expect(callers(/\.approveVersion\(/)).toEqual(["features/mcp/actions.ts"]);
  });

  it("records a sandbox state only through its actions, its drift check and its host", () => {
    expect(callers(/\.putVersion\(/)).toEqual(["features/mcp/actions.ts", "features/mcp/drift.ts", "features/mcp/host.ts"]);
  });

  it("enables a plugin, and allows an MCP server in a workspace, only through the plugins command", () => {
    expect(callers(/registry\.enable\(/)).toEqual(["features/plugins/actions.ts"]);
    // Removal only drops a server from mcp.servers; the plugins command's enable is the one write that adds it, and
    // `config set mcp.servers` is the operator's own (a page and every tool reach neither).
    // A write of the workspace's settings (`settings: { …, mcpServers: [ … ] }`), not a copy counted in memory.
    expect(callers(/settings: \{[^}]*mcpServers: \[/)).toEqual(["features/plugins/actions.ts"]);
  });
});
