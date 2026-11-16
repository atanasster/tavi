import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";

import {
  LIMITS_ENTRY_FAILED,
  LIMITS_ENTRY_FAILED_EXIT,
  PluginManifestSchema,
  type ConfinementPort,
  type PluginWorkerServices,
  type ResourceLimitPort,
} from "@tavi/contracts";
import { listenLocally, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { FrameReader, MAX_MESSAGE_BYTES, encodeFrame } from "../src/protocol.js";
import { createPluginIsolation, exactHosts, maskedVariable } from "../src/index.js";

/** The worker shim and protocol, with the worker unconfined: what the shim does, not the sandbox. */

const fixture = join(import.meta.dirname, "fixtures", "echo-plugin");
const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

const passThrough: ConfinementPort = {
  wrap: (launch) => ({ command: launch.argv[0] ?? "", args: launch.argv.slice(1), env: { ...launch.env } }),
};

function services(): PluginWorkerServices & { readonly logs: string[]; readonly uis: unknown[]; state: Record<string, unknown> } {
  const fake = {
    logs: [] as string[],
    uis: [] as unknown[],
    state: {} as Record<string, unknown>,
    loadState: async () => fake.state,
    putState: async (namespace: string, value: unknown) => {
      fake.state = { ...fake.state, [namespace]: value };
    },
    rawSecret: async (key: string) => (key === "raw" ? "raw-value" : null),
    log: (_level: string, message: string) => void fake.logs.push(message),
    ui: (...args: unknown[]) => void fake.uis.push(args),
  };
  return fake;
}

function launch(overrides: Record<string, unknown> = {}) {
  const home = temp.create("tavi-worker-home-");
  return {
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
      config: { token: { type: "credential" }, raw: { type: "credential" } },
      rawSecrets: ["raw"],
      network: { domains: ["api.example.com", "*.example.org"] },
    }),
    config: { token: "plugins.acme.echo.token", raw: "plugins.acme.echo.raw" },
    maskedSecrets: { token: "real-token" },
    home,
    ...overrides,
  };
}

const isolation = (extra: Record<string, unknown> = {}) =>
  createPluginIsolation({
    confinement: passThrough,
    denyRead: [],
    policyDirectory: temp.create("tavi-worker-policy-"),
    ...extra,
  });
const signal = () => new AbortController().signal;

describe("the protocol", () => {
  it("reads frames whatever the chunking, and refuses one past the limit", () => {
    const seen: unknown[] = [];
    const reader = new FrameReader(
      (message) => seen.push(message),
      () => seen.push("error"),
    );
    const bytes = Buffer.concat([encodeFrame({ t: "stop" }), encodeFrame({ t: "cancel", id: 7 })]);
    for (let at = 0; at < bytes.length; at += 3) reader.push(bytes.subarray(at, at + 3));
    expect(seen).toEqual([{ t: "stop" }, { t: "cancel", id: 7 }]);
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(MAX_MESSAGE_BYTES + 1, 0);
    reader.push(huge);
    reader.push(encodeFrame({ t: "stop" }));
    expect(seen.at(-1)).toBe("error");
    expect(() => encodeFrame({ t: "reply", id: 1, ok: true, value: "x".repeat(MAX_MESSAGE_BYTES) })).toThrow(/past the/);
  });

  it("injects only toward exact hosts", () => {
    expect(exactHosts(["api.example.com", "*.example.org", "x.test:8443"])).toEqual(["api.example.com"]);
    expect(maskedVariable("apiKey")).toBe("TAVI_SECRET_APIKEY");
  });
});

describe("a worker", () => {
  it("starts, registers what the plugin registered, and answers tools, state, hooks and commands", async () => {
    const host = services();
    const handle = await isolation().start(launch(), host);
    expect(handle.registrations.tools.map((tool) => tool.name)).toContain("echo");
    expect(handle.registrations.tools.find((tool) => tool.name === "echo")?.inputJsonSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
    expect(handle.registrations.hooks).toEqual([{ event: "tool.check" }]);
    expect(handle.registrations.commands).toEqual(["hello"]);
    expect(await handle.callTool("echo", { text: "hi" }, signal(), "read")).toEqual({ echoed: "hi", pluginId: "acme.echo" });
    await expect(handle.callTool("echo", { text: 1 }, signal(), "read")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await handle.callTool("count", {}, signal(), "write")).toEqual({ count: 1 });
    expect(await handle.callTool("count", {}, signal(), "write")).toEqual({ count: 2 });
    expect(host.state).toEqual({ counter: { n: 2 } });
    // The hook runs the owner's rest of the chain through `next`, and its console reaches the owner's log.
    const answer = await handle.hook(0, { tool: { id: "fs.read" } }, async () => ({ decision: "allow" }), signal());
    expect(answer).toEqual({ decision: "allow", reason: "seen fs.read" });
    expect(host.logs.some((line) => line.includes("checking fs.read"))).toBe(true);
    expect(await handle.command("hello", { envelope: {} as never, args: "you" }, signal())).toEqual({ text: "hello you" });
    await handle.stop();
  }, 30_000);

  it("hands a tool's handler the call's context as its third argument", async () => {
    const handle = await isolation().start(launch(), services());
    const context = { principalId: "operator", workspaceId: "default", unattended: true };
    expect(await handle.callTool("whom", {}, signal(), "read", context)).toEqual({ context });
    expect(await handle.callTool("whom", {}, signal(), "read")).toEqual({ context: null });
    await handle.stop();
  }, 30_000);

  const signals = () => launch({ config: { token: "plugins.acme.echo.token", raw: "plugins.acme.echo.raw", signals: true } });
  const scope = { workspaceId: "default", principalId: "operator", now: "2026-10-16T12:00:00.000Z", timezone: "UTC" };

  it("collects a heartbeat signal source in the worker", async () => {
    const handle = await isolation().start(signals(), services());
    expect(handle.registrations.signalSources).toEqual([{ id: "queue", retracts: false }, { id: "flaky" }]);
    expect(await handle.collect("queue", scope, signal())).toEqual([
      { key: "job-1", title: "New match for operator", observedAt: "2026-10-16T12:00:00.000Z" },
    ]);
    await expect(handle.collect("inbox", scope, signal())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await handle.stop();
  }, 30_000);

  it("tries a collection again once when its worker crashes, in a worker started again", async () => {
    const handle = await isolation().start(signals(), services());
    expect(await handle.collect("flaky", scope, signal())).toEqual([{ key: "after-crash", title: "Answered after a restart" }]);
    expect(handle.status().restarts).toBe(1);
    await handle.stop();
  }, 30_000);

  it("never stops a worker with signal sources for idleness, so a collection never starts cold", async () => {
    const handle = await isolation({ idleMs: 100 }).start(signals(), services());
    await handle.collect("queue", scope, signal());
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(handle.status().state).toBe("running");
    await handle.stop();
  }, 30_000);

  it("gives the plugin a raw secret only when declared, and otherwise what its environment holds", async () => {
    const handle = await isolation().start(launch(), services());
    const answer = (await handle.callTool("env", {}, signal(), "read")) as { env: Record<string, string>; secret: string; raw: string };
    expect(answer.raw).toBe("raw-value");
    // Unconfined here, so the variable holds the value; under srt it holds the placeholder (the real test).
    expect(answer.secret).toBe(answer.env[maskedVariable("token")]);
    await handle.stop();
  }, 30_000);

  it("reads a declared credential nobody set as null, so a plugin with an optional key still starts and runs", async () => {
    const handle = await isolation().start(launch({ maskedSecrets: {} }), services());
    const answer = (await handle.callTool("env", {}, signal(), "read")) as { secret: string | null };
    expect(answer.secret).toBeNull();
    await handle.stop();
  }, 30_000);

  it("cancels a call the owner abandons", async () => {
    const handle = await isolation().start(launch(), services());
    const controller = new AbortController();
    const pending = handle.callTool("slow", {}, controller.signal, "read");
    setTimeout(() => controller.abort(new Error("gave up")), 100);
    await expect(pending).rejects.toThrow(/gave up/);
    expect(await handle.callTool("echo", { text: "still" }, signal(), "read")).toMatchObject({ echoed: "still" });
    await handle.stop();
  }, 30_000);

  it("turns a crash into UNAVAILABLE for a backoff, reports a write in flight uncertain, and starts again after it", async () => {
    const host = services();
    const handle = await isolation().start(launch(), host);
    await expect(handle.callTool("crash", {}, signal(), "write")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { uncertain: true },
    });
    expect(handle.status()).toMatchObject({ state: "backing-off", restarts: 1 });
    await expect(handle.callTool("echo", { text: "x" }, signal(), "read")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("starts again in"),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await handle.callTool("echo", { text: "back" }, signal(), "read")).toMatchObject({ echoed: "back" });
    expect(handle.status()).toMatchObject({ state: "running", restarts: 1 });
    await handle.stop();
  }, 30_000);

  it("sees a crash though a process it left behind holds its pipes", async () => {
    const marker = `tavi-worker-orphan-${String(process.pid)}`;
    try {
      const handle = await isolation().start(launch(), services());
      const started = Date.now();
      await expect(handle.callTool("orphan-crash", { marker }, signal(), "write")).rejects.toMatchObject({ code: "UNAVAILABLE" });
      // Its exit, then the settle: never the leftover's 30 s.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(handle.status()).toMatchObject({ state: "backing-off", restarts: 1 });
      await handle.stop();
    } finally {
      spawnSync("pkill", ["-f", marker]);
    }
  }, 30_000);

  it("stops when idle, and starts again on the next call with the same registrations", async () => {
    const handle = await isolation({ idleMs: 200 }).start(launch(), services());
    await handle.callTool("echo", { text: "a" }, signal(), "read");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(handle.status().state).toBe("idle");
    expect(await handle.callTool("echo", { text: "b" }, signal(), "read")).toMatchObject({ echoed: "b" });
    expect(handle.status().state).toBe("running");
    await handle.stop();
    expect(handle.status().state).toBe("stopped");
  }, 30_000);

  it("is started again when its credentials' CA nears its end, once nothing is in flight", async () => {
    const renewing = {
      wrap: (launch: Parameters<typeof passThrough.wrap>[0]) => ({ ...passThrough.wrap(launch), renewBy: Date.now() + 300 }),
    };
    const handle = await isolation({ confinement: renewing }).start(launch(), services());
    await handle.callTool("echo", { text: "a" }, signal(), "read");
    await new Promise((resolve) => setTimeout(resolve, 900));
    // Stopped as an idle worker is, not as a crash: no restart is counted, and the next call starts it afresh.
    expect(handle.status()).toMatchObject({ state: "idle", restarts: 0 });
    expect(await handle.callTool("echo", { text: "b" }, signal(), "read")).toMatchObject({ echoed: "b" });
    await handle.stop();
  }, 30_000);

  it("keeps a worker whose CA runs out weeks from now running: a timer past Node's limit never fires early", async () => {
    const later = {
      wrap: (launch: Parameters<typeof passThrough.wrap>[0]) => ({ ...passThrough.wrap(launch), renewBy: Date.now() + 29 * 86_400_000 }),
    };
    const handle = await isolation({ confinement: later }).start(launch(), services());
    await handle.callTool("echo", { text: "a" }, signal(), "read");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(handle.status().state).toBe("running");
    await handle.stop();
  }, 30_000);

  it("refuses a plugin that fails to load, with why", async () => {
    await expect(isolation().start(launch({ entryPath: join(fixture, "missing.mjs") }), services())).rejects.toMatchObject({
      code: "TOOL_FAILED",
      message: expect.stringContaining("failed to start as a worker"),
    });
  }, 30_000);
});

describe("limits and lifecycle edge cases", () => {
  it("refuses a call too large to send, and stays idle-stoppable", async () => {
    const handle = await isolation({ idleMs: 200 }).start(launch(), services());
    await expect(handle.callTool("echo", { text: "x".repeat(MAX_MESSAGE_BYTES) }, signal(), "read")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(handle.status()).toMatchObject({ state: "idle", restarts: 0 });
    await handle.stop();
  }, 30_000);

  it("answers a worker request whose answer is too large with an error, never leaving it waiting", async () => {
    const host = services();
    host.state = { blob: "x".repeat(MAX_MESSAGE_BYTES) };
    const handle = await isolation().start(launch(), host);
    await expect(handle.callTool("count", {}, signal(), "write")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("could not be sent to the worker"),
    });
    await handle.stop();
  }, 30_000);

  it("answers a reply too large to send as an error, and the worker lives on", async () => {
    const handle = await isolation().start(launch(), services());
    await expect(handle.callTool("big", {}, signal(), "read")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("could not be sent to the owner"),
    });
    expect(handle.status()).toMatchObject({ state: "running", restarts: 0 });
    expect(await handle.callTool("echo", { text: "after" }, signal(), "read")).toMatchObject({ echoed: "after" });
    await handle.stop();
  }, 30_000);

  it("ends a read call cancelled while its retry waits out the backoff, at once", async () => {
    const handle = await isolation().start(launch(), services());
    const controller = new AbortController();
    const started = Date.now();
    const pending = handle.callTool("crash", {}, controller.signal, "read");
    setTimeout(() => controller.abort(new Error("gave up")), 300);
    await expect(pending).rejects.toThrow(/gave up/);
    expect(Date.now() - started).toBeLessThan(900);
  }, 30_000);

  it("reports an OOM kill by its cgroup as QUOTA_EXCEEDED, to the call and in its status", async () => {
    const released: string[] = [];
    const limits: ResourceLimitPort = {
      capabilities: () => ({ memory: "enforced", pids: "enforced", cpu: "enforced", rung: "delegated" }),
      place: (argv) => ({ argv, groupId: "g1" }),
      kill: () => undefined,
      outcome: () => (released.length === 0 ? "oom" : undefined),
      release: (id) => void released.push(id),
    };
    const handle = await isolation({ limits }).start(launch(), services());
    // Even a read: what the kernel ended for its memory is not tried again.
    await expect(handle.callTool("crash", {}, signal(), "read")).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      details: { reason: "memory", uncertain: true },
    });
    expect(handle.status()).toMatchObject({ state: "backing-off", lastError: expect.stringContaining("ran out of memory") });
    expect(released).toEqual(["g1"]);
  }, 30_000);

  it("says a worker that could not enter its cgroup never ran", async () => {
    const script = `process.stderr.write(${JSON.stringify(`${LIMITS_ENTRY_FAILED} /sys/fs/cgroup/x\n`)}, () => process.exit(${String(LIMITS_ENTRY_FAILED_EXIT)}))`;
    const limits: ResourceLimitPort = {
      capabilities: () => ({ memory: "enforced", pids: "enforced", cpu: "enforced", rung: "delegated" }),
      place: () => ({ argv: [process.execPath, "-e", script], groupId: "g1" }),
      kill: () => undefined,
      outcome: () => undefined,
      release: () => undefined,
    };
    await expect(isolation({ limits }).start(launch(), services())).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("could not enter its resource limits"),
    });
  }, 30_000);

  it("fails loudly on a credential read from process.env, naming ctx.secret, and leaves other variables be", async () => {
    const handle = await isolation().start(launch(), services());
    await expect(handle.callTool("getenv", { name: "GITHUB_TOKEN" }, signal(), "read")).rejects.toMatchObject({
      message: expect.stringContaining("ctx.secret(key)"),
    });
    expect(await handle.callTool("getenv", { name: "TAVI_NOT_THERE" }, signal(), "read")).toEqual({ value: null });
    expect(await handle.callTool("getenv", { name: "HOME" }, signal(), "read")).toEqual({
      value: expect.stringContaining("tavi-worker-home-"),
    });
    await handle.stop();
  }, 30_000);
});

describe("a worker the owner cannot trust", () => {
  const hostile = (stage: "start" | "call") =>
    createPluginIsolation({
      confinement: {
        wrap: (launch) => ({ command: launch.argv[0] ?? "", args: launch.argv.slice(1), env: { ...launch.env, HOSTILE_STAGE: stage } }),
      },
      denyRead: [],
      policyDirectory: temp.create("tavi-worker-policy-"),
      workerEntry: join(fixture, "..", "hostile-worker.mjs"),
    });

  it("is stopped, never the owner, when it sends a frame that is no message, at its start or later", async () => {
    await expect(hostile("start").start(launch(), services())).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("broke the protocol"),
    });
    const host = services();
    const handle = await hostile("call").start(launch(), host);
    await expect(handle.callTool("echo", {}, signal(), "write")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(handle.status()).toMatchObject({ state: "backing-off", lastError: expect.stringContaining("broke the worker protocol") });
    expect(host.logs.some((line) => line.includes("broke the protocol"))).toBe(true);
  }, 30_000);

  it("is never stopped for idleness while a call runs", async () => {
    const handle = await isolation({ idleMs: 150 }).start(launch(), services());
    await handle.callTool("echo", { text: "a" }, signal(), "read");
    const controller = new AbortController();
    const slow = handle.callTool("slow", {}, controller.signal, "read");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(handle.status().state).toBe("running");
    controller.abort(new Error("done waiting"));
    await expect(slow).rejects.toThrow(/done waiting/);
    await handle.stop();
  }, 30_000);

  it("fails for good when it registers something else on a restart, saying so", async () => {
    const shifting = join(fixture, "..", "shifting-plugin");
    const handle = await isolation({ idleMs: 100 }).start(
      launch({ directory: shifting, entryPath: join(shifting, "index.mjs") }),
      services(),
    );
    await handle.callTool("tool0", {}, signal(), "read");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(handle.callTool("tool0", {}, signal(), "read")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("registered something else"),
    });
    expect(handle.status()).toMatchObject({ state: "failed", lastError: expect.stringContaining("registered something else") });
  }, 30_000);

  it("stays stopped once stopped: a later call is refused, not a new worker", async () => {
    const handle = await isolation().start(launch(), services());
    await handle.stop();
    await expect(handle.callTool("echo", { text: "x" }, signal(), "read")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("was stopped"),
    });
    expect(handle.status().state).toBe("stopped");
  }, 30_000);
});

describe("a tool declared sink none", () => {
  const netFixture = join(import.meta.dirname, "fixtures", "net-plugin");
  const netLaunch = () =>
    launch({
      pluginId: "acme.net",
      directory: netFixture,
      entryPath: join(netFixture, "index.mjs"),
      manifest: PluginManifestSchema.parse({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.net",
        version: "1.0.0",
        name: "Net",
        entry: "index.mjs",
        tools: [
          { name: "peek", effect: "read-only", description: "Declares no network use.", sink: "none" },
          { name: "pull", effect: "read-only", description: "Fetches.", sink: "network" },
          { name: "think", effect: "read-only", description: "Thinks.", sink: "none" },
        ],
      }),
      config: {},
      maskedSecrets: {},
    });

  it("refuses fetch, node:http(s), tls, http2 and net requests and reports them, while a network tool in the same worker reaches the host", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.end("ok");
    });
    const url = `http://127.0.0.1:${String(await listenLocally(server))}/`;
    const host = services();
    const handle = await isolation().start(netLaunch(), host);
    try {
      // Warm pooled connections first, so a fetch or a node:http request that reuses one is refused too.
      expect(await handle.callTool("pull", { how: "fetch", url }, signal(), "read")).toEqual({ reached: true });
      expect(await handle.callTool("pull", { how: "http", url }, signal(), "read")).toEqual({ reached: true });
      const before = hits;
      // Each way out (TLS ones too, refused before any handshake), each counted.
      for (const how of ["fetch", "http", "https", "tls", "http2", "net"] as const) {
        const refused = handle.callTool("peek", { how, url }, signal(), "read");
        await expect(refused, how).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
        expect(
          ((await refused.catch((error: unknown) => error)) as { details?: { requests?: number } }).details?.requests,
          how,
        ).toBeGreaterThanOrEqual(1);
      }
      expect(hits).toBe(before);
      // A network tool's TLS gets as far as the handshake (the plain server refuses it): reading Node's own TLS setting is no credential read.
      for (const how of ["https", "tls"] as const)
        expect(JSON.stringify(await handle.callTool("pull", { how, url }, signal(), "read")), how).not.toContain("process.env");
      // Running together, the network tool's requests are its own.
      const [denied, ...allowed] = await Promise.allSettled([
        handle.callTool("peek", { how: "fetch", url }, signal(), "read"),
        ...(["fetch", "http", "net"] as const).map((how) => handle.callTool("pull", { how, url }, signal(), "read")),
      ]);
      expect(denied).toMatchObject({ status: "rejected", reason: { code: "NOT_AUTHORIZED" } });
      expect(allowed).toEqual(allowed.map(() => ({ status: "fulfilled", value: { reached: true } })));
      expect(await handle.callTool("think", {}, signal(), "read")).toEqual({ thought: "no request" });
    } finally {
      await handle.stop();
      server.close();
    }
  }, 30_000);
});
