import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PluginManifestSchema } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { McpConnection } from "../../src/features/mcp/client.js";
import { stdioLaunch } from "../../src/features/mcp/launcher.js";
import { createOwnerSandboxHost, ownerConfinement } from "../../src/features/sandbox/host.js";

/**
 * The sandbox matrix, run by
 * `scripts/mcp-sandbox-matrix.sh` with `TAVI_SANDBOX_MATRIX` naming the case:
 * `srt` (macOS, or Linux with bubblewrap), `refused` (a container where
 * bubblewrap cannot create user namespaces) or `nested` (a container that
 * allows them but masks /proc: srt's weaker nested mode). Skipped otherwise.
 */

const MODE = process.env["TAVI_SANDBOX_MATRIX"];
const RAW = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp"), "raw-server.mjs");
const VISION = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "evals", "video", "analyzers", "mcp-server.mjs");
const directories = temporaryDirectories();
afterAll(() => directories.cleanup());

describe.skipIf(MODE !== "srt" && MODE !== "nested")(`a sandboxed server (${MODE ?? "skipped"})`, () => {
  const nested = MODE === "nested";
  it("passes the live check", async () => {
    expect((await createOwnerSandboxHost({ dataDirectory: directories.create("tavi-mcp-matrix-") }).check({ nested })).tier).toBe(
      nested ? "nested" : "full",
    );
    // Where only the nested mode runs, the full one fails naming it.
    if (nested)
      expect((await createOwnerSandboxHost({ dataDirectory: directories.create("tavi-mcp-matrix-") }).check()).fix).toMatch(
        /--sandbox-nested/,
      );
  }, 60_000);

  it("cannot read the person's secrets or Tavi's database, write outside its home, or see a provider key", async () => {
    const data = directories.create("tavi-mcp-matrix-");
    const home = directories.create("tavi-mcp-matrix-home-");
    const secrets = [
      join(home, ".ssh", "known_hosts"),
      join(home, ".config", "gh", "hosts.yml"),
      join(home, "Documents", "project", ".env"),
      join(data, "tavi.sqlite"),
    ];
    for (const path of secrets) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "secret\n");
    }
    const plugin = join(data, "plugins", "mcp.raw", "1.0.0");
    mkdirSync(join(plugin, "server"), { recursive: true });
    writeFileSync(join(plugin, "server", "raw.mjs"), readFileSync(RAW));
    const manifest = PluginManifestSchema.parse({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "mcp-dir", packages: [] },
      id: "mcp.raw",
      version: "1.0.0",
      name: "raw",
      mcp: { abi: "tavi.mcp/1", transport: "stdio", command: ["node", "${package}/raw.mjs"] },
    });
    const spawn = stdioLaunch(
      { pluginId: "mcp.raw", manifest, pluginDirectory: plugin, sandboxState: nested ? "nested" : "srt", env: {} },
      { dataDirectory: data, home, confinement: ownerConfinement() },
    );
    const previous = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-matrix-not-for-servers";
    const connection = new McpConnection({ endpoint: { transport: "stdio", spawn } });
    try {
      const call = async (name: string, args: Record<string, unknown>) => (await connection.callTool(name, args)).content;
      for (const path of secrets) expect(await call("read", { path })).toMatch(/^denied/);
      // Denied, or (bubblewrap mounts its own /tmp, where these test homes sit) written somewhere the host never sees.
      expect(await call("write", { path: join(home, "dropped.txt") })).toMatch(/^denied|^written$/);
      expect(existsSync(join(home, "dropped.txt"))).toBe(false);
      expect(await call("write", { path: join(data, "mcp", "mcp.raw", "home", "allowed.txt") })).toBe("written");
      expect(await call("connect", { host: "1.1.1.1", port: 443 })).toMatch(/^denied/);
      expect(await call("env", { name: "OPENAI_API_KEY" })).toBe("(unset)");
    } finally {
      if (previous === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = previous;
      await connection.close();
    }
  }, 60_000);
});

describe.skipIf(MODE !== "srt" && MODE !== "nested")(`a video analyser's exchange (${MODE ?? "skipped"})`, () => {
  it("is readable by the server named in analyzers.json, never writable, and nothing else of the data directory is", async () => {
    const data = directories.create("tavi-mcp-matrix-");
    const plugin = join(data, "plugins", "mcp.vision", "1.0.0");
    mkdirSync(join(plugin, "server"), { recursive: true });
    writeFileSync(join(plugin, "server", "server.mjs"), readFileSync(VISION));
    const exchange = join(data, "video", "mcp", "mcp.vision");
    const run = join(data, "video", "runs", "r1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "frame.png"), "run");
    const manifest = PluginManifestSchema.parse({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "mcp-dir", packages: [] },
      id: "mcp.vision",
      version: "1.0.0",
      name: "vision",
      mcp: { abi: "tavi.mcp/1", transport: "stdio", command: ["node", "${package}/server.mjs"] },
    });
    const spawn = stdioLaunch(
      {
        pluginId: "mcp.vision",
        manifest,
        pluginDirectory: plugin,
        sandboxState: MODE === "nested" ? "nested" : "srt",
        env: {},
        analyzerExchange: exchange,
      },
      { dataDirectory: data, home: directories.create("tavi-mcp-matrix-home-"), confinement: ownerConfinement() },
    );
    // The owner's copy of a call's frame, put there after the server started (as each call's is).
    writeFileSync(join(exchange, "frame-0000.png"), "frame");
    const connection = new McpConnection({ endpoint: { transport: "stdio", spawn } });
    try {
      const probe = async (args: Record<string, unknown>) => (await connection.callTool("probe", args)).content;
      expect(await probe({ read: join(exchange, "frame-0000.png") })).toBe("read 5");
      expect(await probe({ write: join(exchange, "planted.png") })).toMatch(/^write denied/);
      expect(existsSync(join(exchange, "planted.png"))).toBe(false);
      expect(await probe({ read: join(run, "frame.png") })).toMatch(/^read denied/);
    } finally {
      await connection.close();
    }
  }, 60_000);
});

describe.skipIf(MODE !== "refused")("a host where the sandbox cannot run", () => {
  it("fails the live check with its cause and fix, so a server refuses to start", async () => {
    const check = await createOwnerSandboxHost({ dataDirectory: directories.create("tavi-mcp-matrix-") }).check();
    expect(check.tier).toBe("unavailable");
    expect(check.cause).toMatch(/container|namespaces/);
    expect(check.fix).toMatch(/seccomp=unconfined/);
  }, 60_000);
});
