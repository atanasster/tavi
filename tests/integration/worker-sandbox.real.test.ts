import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PluginManifestSchema, type PluginWorkerServices } from "@tavi/contracts";
import { canApplySeatbeltProfile } from "@tavi/test-support/sandbox";
import { createSrtConfinement } from "@tavi/plugin-sandbox/srt-cli";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPluginIsolation, maskedVariable } from "../../packages/builtin/worker/src/index.js";

/** The package under test, from the repository's tests. */
const packageDirectory = join(import.meta.dirname, "..", "..", "packages", "builtin", "worker");

/**
 * A plugin worker under the real srt: the escape cases from
 * inside a worker. macOS always; Linux in the matrix's `srt` case.
 */

const MODE = process.env["TAVI_SANDBOX_MATRIX"] ?? (process.platform === "darwin" && canApplySeatbeltProfile() ? "srt" : undefined);
const fixture = join(packageDirectory, "test", "fixtures", "echo-plugin");
const nodeProxies = (() => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 21);
})();

describe.skipIf(MODE !== "srt")(`a confined plugin worker (${process.platform})`, () => {
  let root = "";
  let data = "";
  let home = "";
  let denied = "";
  const temp = temporaryDirectories();
  beforeAll(() => {
    root = realpathSync(temp.create("tavi-worker-real-"));
    data = join(root, "data");
    home = join(data, "plugins", "acme.echo", "home");
    mkdirSync(home, { recursive: true });
    denied = join(data, "credentials");
    mkdirSync(denied);
    writeFileSync(join(denied, "key.txt"), "owner secret");
  });
  afterAll(() => temp.cleanup());

  const services: PluginWorkerServices = {
    loadState: async () => ({}),
    putState: async () => undefined,
    rawSecret: async () => null,
    log: () => undefined,
    ui: () => undefined,
  };
  const start = async () =>
    createPluginIsolation({
      confinement: createSrtConfinement({ caDirectory: join(data, "sandbox-ca") }),
      denyRead: [homedir(), data],
      policyDirectory: join(root, "policies"),
    }).start(
      {
        pluginId: "acme.echo",
        version: "1.0.0",
        contentHash: "a".repeat(64),
        directory: fixture,
        entryPath: join(fixture, "index.mjs"),
        manifest: PluginManifestSchema.parse({
          schemaVersion: 2,
          abi: "tavi.providers/1",
          provenance: { format: "bundled-esm", packages: [] },
          id: "acme.echo",
          version: "1.0.0",
          name: "Echo",
          entry: "index.mjs",
          config: { token: { type: "credential" } },
          network: { domains: ["httpbin.org"] },
        }),
        config: { token: "plugins.acme.echo.token" },
        maskedSecrets: { token: "tavi-worker-real-token" },
        home,
      },
      services,
    );
  const call = (handle: Awaited<ReturnType<typeof start>>, name: string, input: unknown = {}) =>
    handle.callTool(name, input, new AbortController().signal, "read");

  it("keeps a node:sqlite store in its home that outlives an idle stop", async () => {
    const handle = await start();
    try {
      expect(await call(handle, "store")).toEqual({ rows: 1 });
      expect(await call(handle, "store")).toEqual({ rows: 2 });
    } finally {
      await handle.stop();
    }
    expect(existsSync(join(home, "gate.db"))).toBe(true);
    const again = await start();
    try {
      expect(await call(again, "store")).toEqual({ rows: 3 });
    } finally {
      await again.stop();
    }
  }, 60_000);

  it("reads its own folder and home, and nothing of the owner's home or data directory", async () => {
    const handle = await start();
    expect(await call(handle, "read", { path: join(fixture, "index.mjs") })).toHaveProperty("text");
    expect(await call(handle, "read", { path: join(denied, "key.txt") })).toHaveProperty("refused");
    expect(await call(handle, "read", { path: join(homedir(), ".zshrc") })).not.toHaveProperty("text");
    expect(await call(handle, "write", { path: join(home, "note.txt") })).toEqual({ wrote: true });
    // Refused on macOS; on Linux the denied folder is an empty tmpfs inside the sandbox, so the write lands there. Never on the disk.
    await call(handle, "write", { path: join(data, "planted.txt") });
    expect(existsSync(join(data, "planted.txt"))).toBe(false);
    expect(existsSync(join(home, "note.txt"))).toBe(true);
    await handle.stop();
  }, 60_000);

  it("has no owner environment, and only the placeholder of its credential, in its environment and its heap", async () => {
    process.env["ANTHROPIC_API_KEY"] ??= "owner-provider-key";
    const handle = await start();
    const answer = (await call(handle, "env")) as { env: Record<string, string>; secret: string };
    expect(Object.keys(answer.env)).not.toContain("ANTHROPIC_API_KEY");
    expect(answer.secret).toMatch(/^fake_value_/);
    expect(answer.env[maskedVariable("token")]).toBe(answer.secret);
    const { file } = (await call(handle, "heap")) as { file: string };
    expect(readFileSync(file).includes("tavi-worker-real-token")).toBe(false);
    await handle.stop();
  }, 60_000);

  it("reaches no host its manifest does not declare", async () => {
    const handle = await start();
    expect(await call(handle, "fetch", { url: "https://example.com/" })).toHaveProperty("failed");
    await handle.stop();
  }, 60_000);

  it.skipIf(!nodeProxies)(
    "reaches a declared host through its proxy, which puts its credential in",
    async () => {
      const handle = await start();
      const answer = (await call(handle, "fetch", { url: "https://httpbin.org/headers" })) as { status: number; body: string };
      expect(answer.status).toBe(200);
      expect(answer.body).toContain("Bearer tavi-worker-real-token");
      await handle.stop();
    },
    60_000,
  );
});
