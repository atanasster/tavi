import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PluginManifestSchema, TaviError } from "@tavi/contracts";
import { canApplySeatbeltProfile } from "@tavi/test-support/sandbox";
import { createRuntimeSandbox } from "@tavi/plugin-sandbox/runtime";
import { delay, needsPosix, temporaryDirectories } from "@tavi/test-support";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { McpEndpoint } from "../../src/features/mcp/client.js";
import { nodeHonoursEnvProxy, stdioLaunch } from "../../src/features/mcp/launcher.js";
import { ownerConfinement } from "../../src/features/sandbox/host.js";
import { McpServerLog, readServerLog, scrubLogLine } from "../../src/features/mcp/logs.js";
import { listProcesses } from "../../src/features/mcp/stdio-transport.js";
import { mcpCommand } from "../../src/server/config-commands.js";
import { parseMcp } from "../../src/features/mcp/parse.js";
import { McpSupervisor, reapOrphans, type McpServerSpec } from "../../src/features/mcp/supervisor.js";

/** Windows skips this file's POSIX cases (`POSIX_ONLY` says why). */
const posixOnly = needsPosix(import.meta.url);

/** The owner's MCP supervisor. */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp");
const FAKE = join(FIXTURES, "fake-server.mjs");
const RAW = join(FIXTURES, "raw-server.mjs");
const directories = temporaryDirectories({ prefix: "tavi-mcp-sup-" });
const supervisors: McpSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
});
afterAll(() => directories.cleanup());

const baseEnv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

function fakeSpec(
  pluginId: string,
  env: Record<string, string> = {},
  extra: Partial<McpServerSpec> & { pidFile?: string } = {},
): McpServerSpec {
  const endpoint: McpEndpoint = {
    transport: "stdio",
    spawn: {
      command: process.execPath,
      args: [FAKE],
      env: { ...baseEnv, FAKE_ERA: "legacy", ...env },
      stdinGraceMs: 200,
      killGraceMs: 500,
      ...(extra.pidFile === undefined ? {} : { pidFile: extra.pidFile }),
    },
  };
  return {
    pluginId,
    version: "1.0.0",
    transport: "stdio",
    maxMessageBytes: 1024 * 1024,
    concurrency: 4,
    prior: { kind: "legacy" },
    endpoint: async () => endpoint,
    ...extra,
  };
}

function supervisor(
  specs: Record<string, McpServerSpec>,
  options: Partial<ConstructorParameters<typeof McpSupervisor>[0]> = {},
): McpSupervisor {
  const created = new McpSupervisor({ dataDirectory: directories.create(), spec: async (id) => specs[id], ...options });
  supervisors.push(created);
  return created;
}

const alive = async (pid: number): Promise<boolean> => (await listProcesses()).some((row) => row.pid === pid);

describe("lifecycle", () => {
  it("refuses to start what is not what was approved, and fails the server at once with its notice, never backing off", async () => {
    const failed: string[] = [];
    const changed = fakeSpec(
      "mcp.changed",
      {},
      {
        endpoint: async () => {
          throw new TaviError(
            "CONFLICT",
            "/usr/local/bin/tool-mcp changed since it was approved; it will not start until it is reviewed again",
            { details: { mcpFailure: "integrity" } },
          );
        },
      },
    );
    const sup = supervisor({ "mcp.changed": changed }, { onFailed: (id) => void failed.push(id) });
    await expect(sup.call("mcp.changed", "echo", { text: "x" }, { timeoutMs: 5_000 })).rejects.toThrow(/changed since it was approved/);
    expect(sup.status("mcp.changed")).toMatchObject({ state: "failed", reason: expect.stringMatching(/changed since it was approved/) });
    expect(sup.status("mcp.changed").retryAt).toBeUndefined();
    expect(failed).toEqual(["mcp.changed"]);
  });

  it("backs off 30 s, 60 s, 120 s, 240 s, then is failed after five, with a notice", async () => {
    let now = 1_000_000;
    const failed: string[] = [];
    const sup = supervisor(
      { "mcp.crash": fakeSpec("mcp.crash", { FAKE_FLAGS: "crash-on-start" }) },
      { now: () => now, onFailed: (id) => void failed.push(id) },
    );
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(sup.call("mcp.crash", "echo", { text: "x" }, { timeoutMs: 5_000 })).rejects.toMatchObject({ code: "UNAVAILABLE" });
      const status = sup.status("mcp.crash");
      if (status.retryAt !== undefined) {
        delays.push(status.retryAt - now);
        // Calls fail fast while it backs off, saying so.
        await expect(sup.call("mcp.crash", "echo", {}, { timeoutMs: 5_000 })).rejects.toThrow(/restarting after a failure/);
        now = status.retryAt;
      }
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(sup.status("mcp.crash")).toMatchObject({ state: "failed", failures: 5 });
    expect(failed).toEqual(["mcp.crash"]);
    await expect(sup.call("mcp.crash", "echo", {}, { timeoutMs: 5_000 })).rejects.toThrow(/has failed/);
    // A probe or a decision on the owner stops it: the next call tries afresh.
    await sup.stop("mcp.crash");
    expect(sup.status("mcp.crash")).toMatchObject({ state: "stopped", failures: 0 });
  }, 60_000);

  it("a call past its timeout is uncertain; a server that does not answer a ping after it is killed, its other calls uncertain, and the next call reconnects", async () => {
    const events: string[] = [];
    const sup = supervisor({ "mcp.stuck": fakeSpec("mcp.stuck") }, { cancelGraceMs: 500 });
    sup.subscribe((event) => {
      if (event.kind === "killed" || (event.kind === "call" && event.outcome === "uncertain")) events.push(event.kind);
    });
    // A tool that only hangs leaves its server answering: no kill.
    await expect(sup.call("mcp.stuck", "hang", {}, { timeoutMs: 300 })).rejects.toMatchObject({ details: { mcpFailure: "uncertain" } });
    await delay(800);
    expect(events).toEqual(["call"]);
    expect((await sup.call("mcp.stuck", "echo", { text: "alive" }, { timeoutMs: 5_000 })).content).toBe("alive");
    // A frozen server answers nothing: the call times out, the ping fails, the group is killed and the slow sibling call is uncertain.
    const sibling = sup.call("mcp.stuck", "slow", { ms: 10_000 }, { timeoutMs: 30_000 });
    await expect(sup.call("mcp.stuck", "freeze", {}, { timeoutMs: 300 })).rejects.toMatchObject({ details: { mcpFailure: "uncertain" } });
    await expect(sibling).rejects.toThrow(/uncertain/);
    expect(events).toContain("killed");
    expect((await sup.call("mcp.stuck", "echo", { text: "again" }, { timeoutMs: 5_000 })).content).toBe("again");
  }, 60_000);

  it("stops an idle stdio server, and starts it again on the next call", async () => {
    const sup = supervisor({ "mcp.idle": fakeSpec("mcp.idle") }, { idleMs: 200 });
    await sup.call("mcp.idle", "echo", { text: "1" }, { timeoutMs: 5_000 });
    expect(sup.status("mcp.idle").state).toBe("running");
    await delay(700);
    expect(sup.status("mcp.idle").state).toBe("stopped");
    expect((await sup.call("mcp.idle", "echo", { text: "2" }, { timeoutMs: 5_000 })).content).toBe("2");
  }, 30_000);
});

describe("bounds", () => {
  it("starts a stopped server once for calls that arrive together, and keeps its concurrency exact", async () => {
    let starts = 0;
    const spec = fakeSpec("mcp.cold");
    const sup = supervisor({
      "mcp.cold": {
        ...spec,
        endpoint: async () => {
          starts += 1;
          await delay(50);
          return spec.endpoint();
        },
      },
    });
    let peak = 0;
    sup.subscribe(() => void (peak = Math.max(peak, sup.status("mcp.cold").inFlight)));
    const calls = Array.from({ length: 12 }, (_, index) => sup.call("mcp.cold", "slow", { ms: 100 + index }, { timeoutMs: 20_000 }));
    await Promise.all(calls);
    expect(starts).toBe(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(sup.status("mcp.cold")).toMatchObject({ inFlight: 0, queued: 0, state: "running" });
  }, 60_000);

  it("a decision on the owner reconciles the server (stopped, its tools registered again); reading it does not", async () => {
    const stopped: string[] = [];
    const view = { id: "mcp.docs", kind: "mcp", versions: [{ version: "1.0.0" }] };
    const runtime = {
      plugins: { registry: { show: async () => view } },
      store: { asPort: () => ({ repositories: { mcp: { rejectVersion: async () => undefined } } }) },
      dataDirectory: directories.create(),
      resolveSecret: async () => null,
      tools: { list: () => [] },
      clock: { now: () => "2026-10-14T00:00:00.000Z" },
      mcp: { changed: async (id: string) => void stopped.push(id), oauth: { tokens: {}, logins: {} } },
    } as unknown as Parameters<typeof mcpCommand>[0];
    expect((await mcpCommand(runtime, { action: "reject", pluginId: "mcp.docs", version: "1.0.0" }, "operator")).ok).toBe(true);
    expect(stopped).toEqual(["mcp.docs"]);
    await mcpCommand(runtime, { action: "verify", pluginId: "mcp.nope", full: false }, "operator");
    expect(stopped).toEqual(["mcp.docs"]);
  });

  it("a stop lets a call in flight finish on the old server; a call meanwhile starts a new one, and the old closes after", async () => {
    const sup = supervisor({ "mcp.stopped": fakeSpec("mcp.stopped") });
    await sup.call("mcp.stopped", "echo", { text: "warm" }, { timeoutMs: 5_000 });
    const running = sup.call("mcp.stopped", "slow", { ms: 1_500 }, { timeoutMs: 20_000 });
    await delay(100);
    await sup.stop("mcp.stopped");
    expect(sup.status("mcp.stopped")).toMatchObject({ state: "stopped", failures: 0 });
    // The next call starts the server again, beside the old one still finishing its call.
    expect((await sup.call("mcp.stopped", "echo", { text: "next" }, { timeoutMs: 5_000 })).content).toBe("next");
    expect((await running).content).toBe("done");
    expect(sup.status("mcp.stopped")).toMatchObject({ state: "running", failures: 0 });
  }, 30_000);

  it("a call finishing on a retired connection leaves the server's state as it now is: failed stays failed", async () => {
    const sup = supervisor({ "mcp.late": fakeSpec("mcp.late") });
    await sup.call("mcp.late", "echo", { text: "warm" }, { timeoutMs: 5_000 });
    const running = sup.call("mcp.late", "slow", { ms: 800 }, { timeoutMs: 20_000 });
    await delay(100);
    await sup.stop("mcp.late");
    await sup.markFailed("mcp.late", "it now offers 130 tools");
    expect((await running).content).toBe("done");
    expect(sup.status("mcp.late")).toMatchObject({ state: "failed", reason: "it now offers 130 tools" });
  }, 30_000);

  it("runs four calls at once, queues sixteen, and fails the twenty-first fast", async () => {
    const sup = supervisor({ "mcp.busy": fakeSpec("mcp.busy") });
    await sup.call("mcp.busy", "echo", { text: "warm" }, { timeoutMs: 5_000 });
    const calls = Array.from({ length: 20 }, () => sup.call("mcp.busy", "slow", { ms: 600 }, { timeoutMs: 20_000 }));
    await delay(100);
    expect(sup.status("mcp.busy")).toMatchObject({ inFlight: 4, queued: 16 });
    await expect(sup.call("mcp.busy", "echo", { text: "21st" }, { timeoutMs: 5_000 })).rejects.toThrow(/busy: 4 calls run and 16 wait/);
    await Promise.all(calls);
  }, 60_000);

  it("stops the least recently used idle server to make room, and fails fast when every running one is busy", async () => {
    const sup = supervisor({ "mcp.a": fakeSpec("mcp.a"), "mcp.b": fakeSpec("mcp.b"), "mcp.c": fakeSpec("mcp.c") }, { maxRunning: 2 });
    await sup.call("mcp.a", "echo", { text: "a" }, { timeoutMs: 5_000 });
    await sup.call("mcp.b", "echo", { text: "b" }, { timeoutMs: 5_000 });
    await sup.call("mcp.c", "echo", { text: "c" }, { timeoutMs: 5_000 });
    expect(sup.status("mcp.a").state).toBe("stopped");
    const busy = [
      sup.call("mcp.b", "slow", { ms: 800 }, { timeoutMs: 10_000 }),
      sup.call("mcp.c", "slow", { ms: 800 }, { timeoutMs: 10_000 }),
    ];
    await delay(100);
    await expect(sup.call("mcp.a", "echo", { text: "a" }, { timeoutMs: 5_000 })).rejects.toThrow(
      /all 2 MCP servers that may run at once are busy/,
    );
    await Promise.all(busy);
  }, 60_000);
});

describe("processes (invariants 18, 31)", () => {
  it("shutdown leaves no process: a server flooding stderr, and one whose grandchild left its group", async () => {
    const data = directories.create();
    const grandchildFile = join(data, "grandchild.pid");
    const sup = supervisor({
      "mcp.flood": fakeSpec("mcp.flood", { FAKE_FLAGS: "stderr-flood" }),
      "mcp.setsid": fakeSpec("mcp.setsid", { FAKE_FLAGS: "setsid", FAKE_PIDFILE: grandchildFile }, { pidFile: join(data, "setsid.pid") }),
    });
    await sup.call("mcp.flood", "echo", { text: "x" }, { timeoutMs: 5_000 });
    await sup.list("mcp.setsid");
    const grandchild = Number(readFileSync(grandchildFile, "utf8"));
    expect(await alive(grandchild)).toBe(true);
    await sup.shutdown();
    expect(await alive(grandchild)).toBe(false);
    expect(sup.statuses().every((status) => status.state === "stopped")).toBe(true);
  }, 60_000);

  it("reaps the groups an earlier owner left running", async () => {
    const data = directories.create();
    const grandchildFile = join(data, "grandchild.pid");
    mkdirSync(join(data, "mcp", "mcp.left"), { recursive: true });
    // An owner that died without closing: its server and the grandchild that left the group keep running.
    const abandoned = new McpSupervisor({
      dataDirectory: data,
      spec: async () =>
        fakeSpec(
          "mcp.left",
          { FAKE_FLAGS: "setsid", FAKE_PIDFILE: grandchildFile },
          { pidFile: join(data, "mcp", "mcp.left", "run-1a2b3c4d.pid") },
        ),
    });
    await abandoned.list("mcp.left");
    const grandchild = Number(readFileSync(grandchildFile, "utf8"));
    const leader = (JSON.parse(readFileSync(join(data, "mcp", "mcp.left", "run-1a2b3c4d.pid"), "utf8")) as { pgid: number }).pgid;
    expect(await alive(leader)).toBe(true);
    expect(await reapOrphans(data)).toBeGreaterThanOrEqual(2);
    expect(await alive(leader)).toBe(false);
    expect(await alive(grandchild)).toBe(false);
    expect(() => readFileSync(join(data, "mcp", "mcp.left", "run-1a2b3c4d.pid"))).toThrow();
  }, 60_000);

  it("skips a run record that is not one an owner writes, and goes on reaping the rest", async () => {
    const data = directories.create();
    mkdirSync(join(data, "mcp", "mcp.bad"), { recursive: true });
    mkdirSync(join(data, "mcp", "mcp.gone"), { recursive: true });
    // Half-written, and naming pid 0 (kill's own group): neither may drive a kill.
    writeFileSync(join(data, "mcp", "mcp.bad", "run-1.pid"), JSON.stringify({ pgid: 4242 }));
    writeFileSync(
      join(data, "mcp", "mcp.bad", "run-2.pid"),
      JSON.stringify({ pgid: 0, leaderStart: "x", descendants: [], recordedAt: "2026-01-01T00:00:00.000Z" }),
    );
    // A well-formed record whose processes are long gone: removed.
    const gone = join(data, "mcp", "mcp.gone", "run-3.pid");
    writeFileSync(gone, JSON.stringify({ pgid: 2_147_483_000, leaderStart: "x", descendants: [], recordedAt: "2026-01-01T00:00:00.000Z" }));
    const lines: string[] = [];
    expect(await reapOrphans(data, (line) => lines.push(line))).toBe(0);
    expect(lines.filter((line) => line.startsWith("removed mcp.bad's run record"))).toHaveLength(2);
    expect(existsSync(join(data, "mcp", "mcp.bad", "run-1.pid"))).toBe(false);
    expect(existsSync(join(data, "mcp", "mcp.bad", "run-2.pid"))).toBe(false);
    // Said once: the next start finds nothing to say.
    lines.length = 0;
    expect(await reapOrphans(data, (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([]);
    expect(existsSync(gone)).toBe(false);
  });

  it("keeps the run records when the processes cannot be listed, except on Windows, whose jobs ended with their owner", async () => {
    const data = directories.create();
    mkdirSync(join(data, "mcp", "mcp.kept"), { recursive: true });
    const record = join(data, "mcp", "mcp.kept", "run-1.pid");
    writeFileSync(record, JSON.stringify({ pgid: 4242, leaderStart: "x", descendants: [], recordedAt: "2026-01-01T00:00:00.000Z" }));
    const path = process.env["PATH"];
    // No `ps` to be found: the listing fails, as it does on Windows.
    process.env["PATH"] = "";
    try {
      expect(await reapOrphans(data, () => undefined, "linux")).toBe(0);
      expect(existsSync(record)).toBe(true);
      expect(await reapOrphans(data, () => undefined, "win32")).toBe(0);
      expect(existsSync(record)).toBe(false);
    } finally {
      process.env["PATH"] = path;
    }
  });
});

describe("logs", () => {
  it("parses tavi mcp logs: a server id, and --lines from 1 to 10000", () => {
    expect(parseMcp(["logs", "mcp.docs", "--lines", "50"])).toMatchObject({
      command: "mcp",
      mcp: { action: "logs", pluginId: "mcp.docs", lines: 50 },
    });
    expect(parseMcp(["logs", "mcp.docs"])).toMatchObject({ mcp: { lines: 100 } });
    expect(() => parseMcp(["logs", "mcp.docs", "--lines", "0"])).toThrow(/--lines takes 1 to 10000/);
    expect(() => parseMcp(["logs", "../../etc"])).toThrow(/server id/);
  });

  it("masks every credential the server was given, in its stderr and anywhere else", async () => {
    const data = directories.create();
    const token = "tok_9f8e7d6c5b4a";
    const log = new McpServerLog(data, () => [token]);
    const sup = supervisor({ "mcp.leaky": fakeSpec("mcp.leaky", { FAKE_FLAGS: "stderr-token", FAKE_TOKEN: token }) });
    const stop = log.follow(sup);
    await sup.call("mcp.leaky", "echo", { text: "x" }, { timeoutMs: 5_000 });
    await delay(300);
    await log.write("mcp.leaky", "done");
    stop();
    const lines = (await readServerLog(data, "mcp.leaky")).join("\n");
    expect(lines).toContain("stderr: starting as [credential], token");
    expect(lines).toContain("call echo ok");
    expect(lines).not.toContain(token);
    expect(lines).not.toContain('"x"');
    expect(scrubLogLine(`a ${token} b \u001b[31m`, [token])).toBe("a [credential] b ");
  }, 30_000);
});

describe("per-server networks", () => {
  const manifestFor = (id: string, domains: readonly string[]) =>
    PluginManifestSchema.parse({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "mcp-dir", packages: [] },
      id,
      version: "1.0.0",
      name: id,
      mcp: {
        abi: "tavi.mcp/1",
        transport: "stdio",
        command: ["node", "${package}/raw.mjs"],
        ...(domains.length === 0 ? {} : { network: { domains } }),
      },
    });
  const install = (data: string, id: string): string => {
    const plugin = join(data, "plugins", id, "1.0.0");
    mkdirSync(join(plugin, "server"), { recursive: true });
    writeFileSync(join(plugin, "server", "raw.mjs"), readFileSync(RAW));
    return plugin;
  };

  it.skipIf(nodeHonoursEnvProxy())("refuses a granted network on a Node that cannot use the proxy, and any network unsandboxed", () => {
    const data = directories.create();
    expect(() =>
      stdioLaunch(
        {
          pluginId: "mcp.net",
          manifest: manifestFor("mcp.net", ["example.com"]),
          pluginDirectory: install(data, "mcp.net"),
          sandboxState: "srt",
          env: {},
        },
        { dataDirectory: data, confinement: ownerConfinement() },
      ),
    ).toThrow(/Node 22.21 or later/);
  });

  it("refuses a granted network unsandboxed", () => {
    const data = directories.create();
    expect(() =>
      stdioLaunch(
        {
          pluginId: "mcp.net",
          manifest: manifestFor("mcp.net", ["example.com"]),
          pluginDirectory: install(data, "mcp.net"),
          sandboxState: "none",
          env: {},
        },
        { dataDirectory: data, confinement: ownerConfinement() },
      ),
    ).toThrow(nodeHonoursEnvProxy() ? /only a sandbox can hold it to/ : /Node 22.21 or later|only a sandbox/);
  });

  // srt runs each server in its own process, so the owner's sandbox manager is free for `sandbox.run`, both ways round.
  it.skipIf(process.platform !== "darwin" || !canApplySeatbeltProfile())(
    "runs sandbox.run while a sandboxed server runs, and the other way round",
    async () => {
      const data = directories.create();
      const id = "mcp.side";
      const sup = supervisor({
        [id]: {
          pluginId: id,
          version: "1.0.0",
          transport: "stdio",
          maxMessageBytes: 1024 * 1024,
          concurrency: 4,
          prior: { kind: "legacy" },
          endpoint: async () => ({
            transport: "stdio",
            spawn: stdioLaunch(
              { pluginId: id, manifest: manifestFor(id, []), pluginDirectory: install(data, id), sandboxState: "srt", env: {} },
              { dataDirectory: data, confinement: ownerConfinement() },
            ),
          }),
        },
      });
      const file = join(data, "visible.txt");
      writeFileSync(file, "visible");
      const sandbox = createRuntimeSandbox();
      const run = () =>
        sandbox.run(
          {
            filesystem: { allowRead: [file], allowWrite: [], denyPaths: [] },
            network: { allow: false },
            resources: { timeoutMs: 10_000, maxOutputBytes: 65_536 },
          },
          { command: "cat", args: [file] },
        );
      const slow = sup.call(id, "echo", { text: "first" }, { timeoutMs: 20_000 });
      expect((await run()).stdout).toBe("visible");
      expect((await slow).content).toBe("first");
      const during = run();
      expect((await sup.call(id, "echo", { text: "second" }, { timeoutMs: 20_000 })).content).toBe("second");
      expect((await during).stdout).toBe("visible");
    },
    60_000,
  );

  // The first proof of per-server networks: two servers under their own srt processes each reach only their own domain, and a
  // no-network one reaches none. Needs a Node with NODE_USE_ENV_PROXY and the network: TAVI_LIVE_NETWORK=1.
  it.skipIf(posixOnly || !nodeHonoursEnvProxy() || process.env["TAVI_LIVE_NETWORK"] !== "1")(
    "keeps each server to its own domains while they run at once",
    async () => {
      const data = directories.create();
      const specFor = (id: string, domains: readonly string[]): McpServerSpec => ({
        pluginId: id,
        version: "1.0.0",
        transport: "stdio",
        maxMessageBytes: 1024 * 1024,
        concurrency: 4,
        prior: { kind: "legacy" },
        endpoint: async () => ({
          transport: "stdio",
          spawn: stdioLaunch(
            { pluginId: id, manifest: manifestFor(id, domains), pluginDirectory: install(data, id), sandboxState: "srt", env: {} },
            { dataDirectory: data, confinement: ownerConfinement() },
          ),
        }),
      });
      const sup = supervisor({
        "mcp.a": specFor("mcp.a", ["example.com"]),
        "mcp.b": specFor("mcp.b", ["example.org"]),
        "mcp.none": specFor("mcp.none", []),
      });
      const fetchVia = async (id: string, url: string) => String((await sup.call(id, "fetch", { url }, { timeoutMs: 20_000 })).content);
      expect(await fetchVia("mcp.a", "https://example.com/")).toBe("status 200");
      expect(await fetchVia("mcp.b", "https://example.org/")).toBe("status 200");
      expect(await fetchVia("mcp.a", "https://example.org/")).toMatch(/^denied/);
      expect(await fetchVia("mcp.b", "https://example.com/")).toMatch(/^denied/);
      expect(await fetchVia("mcp.none", "https://example.com/")).toMatch(/^denied/);
      expect(await fetchVia("mcp.none", "https://example.org/")).toMatch(/^denied/);
    },
    120_000,
  );
});
