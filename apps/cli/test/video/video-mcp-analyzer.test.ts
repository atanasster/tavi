import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PluginManifestSchema, type AnalyzeRequest, type AnalyzerManifest, type ConfinementPort } from "@tavi/contracts";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it } from "vitest";

import { runAnalyzerConformance } from "../../../../tests/support/video-analyzer-conformance.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import type { McpAnalyzerTool } from "../../src/features/mcp/host.js";
import { serverPolicy, stdioLaunch } from "../../src/features/mcp/launcher.js";
import { definitionHash, definitionOf } from "../../src/features/mcp/review.js";
import {
  analyzerConfigPath,
  createVideoAnalyzers,
  resolveVideoMcpTools,
  videoMcpExchange,
  videoMcpServers,
  type VideoMcpClient,
} from "../../src/features/video/host.js";
import { analyzerAssessment } from "../../src/features/video/tools.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * MCP analysers: an MCP server's
 * tool named in `analyzers.json`, its manifest its own `_meta["tavi/analyzer"]`
 * (pinned with its definition) or the owner's, called through the owner's MCP
 * client with the frames in its exchange directory only during the call; a
 * server that can reach the network is remote whatever it declares. The
 * fixture server is `evals/video/analyzers/mcp-server.mjs`, run by node.
 */

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "evals", "video", "analyzers", "mcp-server.mjs");
const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  directories.cleanup();
});

/** srt stands aside for the analysers' own launches: an MCP analyser starts nothing itself. */
const passThrough: ConfinementPort = {
  wrap: (request) => ({ command: request.argv[0] ?? "", args: request.argv.slice(1), env: request.env }),
} as ConfinementPort;

const manifest = (id: string, local = true): AnalyzerManifest => ({
  id,
  version: "1",
  attribution: { name: "Vision", url: "https://vision.example", licence: "MIT" },
  capabilities: [{ capability: "ocr", inputs: ["frames"], output: "FrameText@1" }],
  local,
  confined: true,
  models: [{ name: "vision-1", installed: true }],
});

const tool = (extra: Partial<McpAnalyzerTool> = {}): McpAnalyzerTool => {
  const definition = { name: "read", inputSchema: { type: "object" }, analyzer: manifest("mcp.vision-read") };
  return {
    pluginId: "mcp.vision",
    version: "1.0.0",
    name: "read",
    definition,
    definitionHash: definitionHash(definition),
    transport: "stdio",
    egress: false,
    ...extra,
  };
};

/** A run with one frame, as the decoder leaves one. */
function frameRun(data: string): { readonly run: string; readonly frame: string } {
  const run = join(data, "video", "runs", "r1");
  mkdirSync(join(run, "frames"), { recursive: true });
  const frame = join(run, "frames", "0001.png");
  writeFileSync(frame, "png-bytes");
  return { run, frame };
}

const OPERATOR = { workspaceId: "default", principalId: "operator" };

const ocr = (run: string, frame: string, extra: Partial<AnalyzeRequest<"ocr">> = {}): AnalyzeRequest<"ocr"> => ({
  capability: "ocr",
  frames: [{ timeSec: 1, path: frame, width: 1, height: 1, format: "png" }],
  runDirectory: run,
  options: { language: "eng" },
  limits: { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
  signal: new AbortController().signal,
  caller: OPERATOR,
  ...extra,
});

function dataWith(config: unknown): string {
  const data = directories.create("tavi-video-mcp-");
  mkdirSync(join(data, "video"));
  writeFileSync(analyzerConfigPath(data), JSON.stringify(config));
  return data;
}

describe("the manifest and the chain", () => {
  it("takes the tool's own manifest, or the owner's pin; refuses one that declares none or a bad one; a networked server's is remote", () => {
    const data = dataWith({
      ocr: [
        { type: "mcp", server: "vision", tool: "read" },
        { type: "mcp", server: "mcp.bare", tool: "read" },
        { type: "mcp", server: "bad", tool: "read" },
        { type: "mcp", server: "cloud", tool: "read" },
      ],
    });
    const more = dataWith({
      ocr: [
        { type: "mcp", server: "pinned", tool: "read", manifest: manifest("owner.pinned") },
        { type: "mcp", server: "gone", tool: "read" },
      ],
    });
    const client: VideoMcpClient = {
      analyzerTool: async () => ({ missing: "unused" }),
      callAnalyzer: async () => ({ ok: false, code: "unavailable", message: "unused" }),
    };
    const bare = tool({ pluginId: "mcp.bare", definition: { name: "read", inputSchema: {} } });
    const tools = new Map<string, McpAnalyzerTool | { readonly missing: string }>([
      ["mcp.vision\u0000read", tool()],
      ["mcp.bare\u0000read", bare],
      ["mcp.bad\u0000read", tool({ pluginId: "mcp.bad", definition: { name: "read", inputSchema: {}, analyzer: { id: "Not An Id" } } })],
      [
        "mcp.cloud\u0000read",
        tool({
          pluginId: "mcp.cloud",
          transport: "http",
          egress: true,
          definition: { name: "read", inputSchema: {}, analyzer: manifest("mcp.cloud-read") },
        }),
      ],
      ["mcp.pinned\u0000read", bare],
      ["mcp.gone\u0000read", { missing: "mcp.gone is not installed" }],
    ]);
    const analyzers = createVideoAnalyzers(data, passThrough, { platform: "darwin" }, {}, { tools, client });
    expect(analyzers.chains.ocr).toEqual([
      { id: "mcp.vision/read", type: "mcp", local: true, status: "ready" },
      {
        id: "mcp.bare/read",
        type: "mcp",
        status: "refused",
        note: 'read declares no _meta["tavi/analyzer"] and the entry pins no manifest',
      },
      { id: "mcp.bad/read", type: "mcp", status: "refused", note: 'read\'s _meta["tavi/analyzer"] is not an analyser manifest' },
      // It claimed to be local; its server reaches the network, so it is not.
      {
        id: "mcp.cloud/read",
        type: "mcp",
        local: false,
        status: "ready",
        note: "its server can reach the network, so its calls are external and asked",
      },
    ]);
    expect(analyzers.registry.for("ocr").map((port) => [port.manifest().id, port.manifest().local])).toEqual([
      ["mcp.vision-read", true],
      ["mcp.cloud-read", false],
    ]);
    // The owner's pin stands for a tool that declares none.
    const pinned = createVideoAnalyzers(more, passThrough, { platform: "darwin" }, {}, { tools, client });
    expect(pinned.chains.ocr).toEqual([
      { id: "mcp.pinned/read", type: "mcp", local: true, status: "ready" },
      { id: "mcp.gone/read", type: "mcp", status: "not-installed", note: "mcp.gone is not installed" },
    ]);
    expect(pinned.registry.for("ocr").map((port) => port.manifest().id)).toEqual(["owner.pinned"]);
    // Without the MCP client, an entry says so.
    expect(createVideoAnalyzers(data, passThrough, { platform: "darwin" }).chains.ocr?.[0]).toEqual({
      id: "mcp.vision/read",
      type: "mcp",
      status: "not-installed",
      note: "MCP servers are not reachable here",
    });
    // The servers whose launch may read their exchange: those analyzers.json names.
    expect([...videoMcpServers(data)].sort()).toEqual(["mcp.bad", "mcp.bare", "mcp.cloud", "mcp.vision"]);
  });

  it("refuses an MCP tool claiming a manifest id a command already holds", () => {
    const command = {
      type: "command",
      id: "reader",
      command: process.execPath,
      args: [],
      manifest: manifest("mcp.vision-read"),
      readRoots: [],
    };
    const data = dataWith({ ocr: [command, { type: "mcp", server: "vision", tool: "read" }] });
    const client: VideoMcpClient = {
      analyzerTool: async () => ({ missing: "unused" }),
      callAnalyzer: async () => ({ ok: false, code: "unavailable", message: "unused" }),
    };
    const analyzers = createVideoAnalyzers(
      data,
      passThrough,
      { platform: "darwin" },
      {},
      { tools: new Map([["mcp.vision\u0000read", tool()]]), client },
    );
    expect(analyzers.chains.ocr?.map((entry) => [entry.id, entry.status])).toEqual([
      ["reader", "refused"],
      ["mcp.vision/read", "refused"],
    ]);
  });

  it("hands a stdio server the frames in its exchange only during the call, one call at a time; an HTTP one inline", async () => {
    const data = dataWith({
      ocr: [
        { type: "mcp", server: "vision", tool: "read" },
        { type: "mcp", server: "cloud", tool: "read" },
      ],
    });
    const exchange = videoMcpExchange(data, "mcp.vision");
    const seen: unknown[] = [];
    let running = 0;
    let most = 0;
    const client: VideoMcpClient = {
      analyzerTool: async () => ({ missing: "unused" }),
      callAnalyzer: async (called, args) => {
        running += 1;
        most = Math.max(most, running);
        const frames = args["frames"] as readonly { readonly path?: string; readonly data?: string; readonly timeSec: number }[];
        // During the call the frame is there, the owner's alone.
        const there = frames.map((frame) =>
          frame.path === undefined ? Buffer.from(frame.data ?? "", "base64").toString() : readFileSync(frame.path, "utf8"),
        );
        seen.push({
          pluginId: called.pluginId,
          frames: frames.map((frame) => ({
            ...frame,
            ...(frame.path === undefined ? {} : { mode: (statSync(frame.path).mode & 0o777).toString(8) }),
          })),
          there,
        });
        await delay(20);
        running -= 1;
        return {
          ok: true,
          structured: true,
          content: { frames: frames.map((frame) => ({ timeSec: frame.timeSec, text: "EXIT", confidence: 90 })) },
        };
      },
    };
    const tools = new Map([
      ["mcp.vision\u0000read", tool()],
      [
        "mcp.cloud\u0000read",
        tool({
          pluginId: "mcp.cloud",
          transport: "http",
          egress: true,
          definition: { name: "read", inputSchema: {}, analyzer: manifest("mcp.cloud-read") },
        }),
      ],
    ]);
    const analyzers = createVideoAnalyzers(data, passThrough, { platform: "darwin" }, {}, { tools, client });
    const [local, cloud] = analyzers.registry.for("ocr");
    const { run, frame } = frameRun(data);
    const outcomes = await Promise.all([local?.analyze(ocr(run, frame)), local?.analyze(ocr(run, frame))]);
    expect(outcomes.map((outcome) => outcome?.ok)).toEqual([true, true]);
    expect(most).toBe(1);
    expect(seen[0]).toEqual({
      pluginId: "mcp.vision",
      frames: [
        {
          path: expect.stringMatching(new RegExp(`^${exchange}/[0-9a-f]{16}/frame-0000\\.png$`)),
          timeSec: 1,
          width: 1,
          height: 1,
          format: "png",
          mode: "600",
        },
      ],
      there: ["png-bytes"],
    });
    // Each call has paths of its own.
    const paths = seen.slice(0, 2).map((entry) => (entry as { readonly frames: readonly { readonly path: string }[] }).frames[0]?.path);
    expect(new Set(paths).size).toBe(2);
    // Emptied after: the server reads the media only during its call.
    expect(readdirSync(exchange)).toEqual([]);
    expect((statSync(exchange).mode & 0o777).toString(8)).toBe("700");
    expect(await cloud?.analyze(ocr(run, frame))).toMatchObject({ ok: true });
    expect(seen[2]).toEqual({
      pluginId: "mcp.cloud",
      frames: [{ data: Buffer.from("png-bytes").toString("base64"), timeSec: 1, width: 1, height: 1, format: "png" }],
      there: ["png-bytes"],
    });
  });

  it("ends a call queued behind its server's others at its own time, and an inline call past its cap is too large, calling nothing", async () => {
    const data = dataWith({
      ocr: [
        { type: "mcp", server: "vision", tool: "read" },
        { type: "mcp", server: "cloud", tool: "read" },
      ],
    });
    let calls = 0;
    let release = (): void => undefined;
    const client: VideoMcpClient = {
      analyzerTool: async () => ({ missing: "unused" }),
      callAnalyzer: async (_tool, args) => {
        calls += 1;
        // The first call holds the server until it is let go.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          ok: true,
          structured: true,
          content: {
            frames: (args["frames"] as readonly { readonly timeSec: number }[]).map((frame) => ({
              timeSec: frame.timeSec,
              text: "",
              confidence: 0,
            })),
          },
        };
      },
    };
    const tools = new Map([
      ["mcp.vision\u0000read", tool()],
      [
        "mcp.cloud\u0000read",
        tool({
          pluginId: "mcp.cloud",
          transport: "http",
          egress: true,
          definition: { name: "read", inputSchema: {}, analyzer: manifest("mcp.cloud-read") },
        }),
      ],
    ]);
    const [local, cloud] = createVideoAnalyzers(data, passThrough, { platform: "darwin" }, {}, { tools, client }).registry.for("ocr");
    const { run, frame } = frameRun(data);
    const first = local?.analyze(ocr(run, frame, { limits: { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 } }));
    const started = Date.now();
    expect(await local?.analyze(ocr(run, frame, { limits: { timeoutMs: 200, maxOutputBytes: 64 * 1024 } }))).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    release();
    expect(await first).toMatchObject({ ok: true });
    // The queued call, reached after its time, called nothing.
    expect(calls).toBe(1);
    const big = join(run, "frames", "big.raw");
    writeFileSync(big, Buffer.alloc(9 * 1024 * 1024));
    expect(
      await cloud?.analyze(ocr(run, frame, { frames: [{ timeSec: 0, path: big, width: 1024, height: 3072, format: "rgb24" }] })),
    ).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(calls).toBe(1);
  });

  it("a networked server's call is external and asked; a local one's stays read-only", () => {
    const data = dataWith({ ocr: [{ type: "mcp", server: "cloud", tool: "read" }] });
    const client: VideoMcpClient = {
      analyzerTool: async () => ({ missing: "unused" }),
      callAnalyzer: async () => ({ ok: false, code: "unavailable", message: "unused" }),
    };
    const context = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };
    for (const egress of [true, false]) {
      const analyzers = createVideoAnalyzers(
        data,
        passThrough,
        { platform: "darwin" },
        {},
        { tools: new Map([["mcp.cloud\u0000read", tool({ pluginId: "mcp.cloud", egress })]]), client },
      );
      const assessed = analyzerAssessment(analyzers.registry, { capability: "ocr", frames: 1 }, context, "Read the frames' text");
      if (egress)
        expect(assessed).toMatchObject({ effect: "external", sink: "network", attendedOnly: true, subjects: ["analyzer:mcp.vision-read"] });
      else expect(assessed.effect).toBeUndefined();
    }
  });
});

describe("the server's read access", () => {
  it("adds the exchange to the policy's reads, never its writes, and makes it 0700 before the sandbox starts", () => {
    const data = directories.create("tavi-video-mcp-");
    const plugin = join(data, "plugins", "mcp.vision", "1.0.0");
    mkdirSync(plugin, { recursive: true });
    const block = { abi: "tavi.mcp/1", transport: "stdio", command: ["node", "server.mjs"] } as const;
    const exchange = videoMcpExchange(data, "mcp.vision");
    const policy = serverPolicy({
      pluginDirectory: plugin,
      home: join(data, "home"),
      dataDirectory: data,
      personHome: directories.create("tavi-video-mcp-"),
      block: block as never,
      nested: false,
      analyzerExchange: exchange,
    });
    expect(policy.allowRead).toContain(exchange);
    expect(policy.allowWrite).not.toContain(exchange);
    expect(policy.denyRead).toContain(data);
    expect(
      serverPolicy({
        pluginDirectory: plugin,
        home: join(data, "home"),
        dataDirectory: data,
        personHome: directories.create("tavi-video-mcp-"),
        block: block as never,
        nested: false,
      }).allowRead,
    ).not.toContain(exchange);
    const manifest = PluginManifestSchema.parse({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "mcp-dir", packages: [] },
      id: "mcp.vision",
      version: "1.0.0",
      name: "vision",
      mcp: block,
    });
    let wrapped: { readonly allowRead: readonly string[] } | undefined;
    const confinement = {
      wrap: (request: {
        readonly argv: readonly string[];
        readonly env: Readonly<Record<string, string>>;
        readonly policy: { readonly allowRead: readonly string[] };
      }) => {
        // Made by the time srt is asked to wrap the launch.
        expect((statSync(exchange).mode & 0o777).toString(8)).toBe("700");
        wrapped = request.policy;
        return { command: request.argv[0] ?? "", args: request.argv.slice(1), env: request.env };
      },
    } as unknown as ConfinementPort;
    stdioLaunch(
      { pluginId: "mcp.vision", manifest, pluginDirectory: plugin, sandboxState: "srt", env: {}, analyzerExchange: exchange },
      { dataDirectory: data, confinement },
    );
    expect(wrapped?.allowRead).toContain(exchange);
  });
});

describe("drift", () => {
  it('hashes _meta["tavi/analyzer"] with the definition, and nothing else of _meta', () => {
    const listed = { name: "analyze", inputSchema: { type: "object" }, _meta: { "tavi/analyzer": manifest("mcp.vision-read"), other: 1 } };
    const before = definitionOf(listed as never);
    expect(before.analyzer).toEqual(manifest("mcp.vision-read"));
    expect(definitionHash(definitionOf({ ...listed, _meta: { ...listed._meta, other: 2 } } as never))).toBe(definitionHash(before));
    // A server claiming local after approval: another definition, so drift.
    expect(definitionHash(definitionOf({ ...listed, _meta: { "tavi/analyzer": manifest("mcp.vision-read", false) } } as never))).not.toBe(
      definitionHash(before),
    );
    // A tool with no analyser's manifest has no analyser in its definition.
    expect(definitionOf({ name: "echo", inputSchema: {} } as never)).toEqual({ name: "echo", inputSchema: {} });
  });
});

describe("a real server", () => {
  async function tavi(argv: readonly string[]) {
    const out = capture();
    const code = await main([...argv], { io: out.io });
    return { code, stdout: out.stdout(), stderr: out.stderr() };
  }

  it("passes the conformance suite through the owner's MCP client, answers only as its schema says, and drifts when its manifest changes", async () => {
    const data = directories.create("tavi-video-mcp-");
    const at = ["--data-dir", data];
    const server = directories.create("tavi-video-mcp-server-");
    writeFileSync(join(server, "server.mjs"), readFileSync(SERVER));
    const meta = join(directories.create("tavi-video-mcp-meta-"), "meta.json");
    writeFileSync(meta, "{}");
    const added = await tavi([
      "mcp",
      "add",
      "vision",
      "--dir",
      server,
      "--unsandboxed",
      "--env",
      `FIXTURE_META=${meta}`,
      ...at,
      "--",
      "node",
      "server.mjs",
    ]);
    expect(added.code, added.stderr).toBe(EXIT.ok);
    const approved = await tavi(["mcp", "approve", "mcp.vision", "1.0.0", "--unsandboxed", ...at]);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
    expect((await tavi(["plugins", "enable", "mcp.vision", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["mcp", "on", ...at])).code).toBe(EXIT.ok);
    mkdirSync(join(data, "video"), { recursive: true });
    const entry = (name: string) => ({ type: "mcp", server: "vision", tool: name });
    writeFileSync(
      analyzerConfigPath(data),
      JSON.stringify({
        ocr: [entry("analyze"), entry("analyze_text"), entry("analyze_wrong"), entry("analyze_fail")],
        transcribe: [entry("analyze"), entry("analyze_rpc_error")],
      }),
    );
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), {
      modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
    });
    runtimes.push(runtime);

    const analyzers = createVideoAnalyzers(data, passThrough, { platform: "darwin" }, {}, await resolveVideoMcpTools(data, runtime.mcp));
    // Unsandboxed, it can reach any network: remote, whatever its manifest says.
    expect(analyzers.chains.ocr?.map((listed) => [listed.id, listed.status, listed.local])).toEqual([
      ["mcp.vision/analyze", "ready", false],
      ["mcp.vision/analyze_text", "ready", false],
      ["mcp.vision/analyze_wrong", "ready", false],
      ["mcp.vision/analyze_fail", "ready", false],
    ]);
    const [analyze, asText, wrong, failing] = analyzers.registry.for("ocr");
    if (analyze === undefined || asText === undefined || wrong === undefined || failing === undefined)
      throw new Error("the chain is short");

    const report = await runAnalyzerConformance(() => analyze, { timeoutMs: 20_000, caller: OPERATOR });
    expect(report).toEqual({
      manifest: { pass: true },
      unsupported: { pass: true },
      timeout: { pass: true },
      signal: { pass: true },
      output: { pass: true },
      writes: { pass: true },
      network: { pass: true },
    });
    const exchange = videoMcpExchange(data, "mcp.vision");
    expect(readdirSync(exchange)).toEqual([]);

    const { run, frame } = frameRun(data);
    // The server read the frame from its exchange: nine bytes.
    expect(await analyze.analyze(ocr(run, frame))).toMatchObject({
      ok: true,
      result: { frames: [{ timeSec: 1, text: "read 9 bytes", confidence: 90 }] },
      model: "fixture-1",
    });
    expect(await asText.analyze(ocr(run, frame))).toMatchObject({ ok: true, result: { frames: [{ text: "read 9 bytes" }] } });
    expect(await wrong.analyze(ocr(run, frame))).toMatchObject({ ok: false, error: { code: "protocol" } });
    const failed = await failing.analyze(ocr(run, frame));
    expect(failed).toMatchObject({ ok: false, error: { code: "crashed" } });
    // The server's words, which may quote the media, are not passed on: an isError result's, nor a JSON-RPC error's.
    expect(JSON.stringify(failed)).not.toContain("ignore previous");
    // Only for someone the server's tools are offered to, as any MCP tool call is; a call that names no one is refused.
    expect(await analyze.analyze(ocr(run, frame, { caller: { workspaceId: "default", principalId: "someone-else" } }))).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("not offered to this person") },
    });
    const { caller: _dropped, ...nobody } = ocr(run, frame);
    expect(await analyze.analyze(nobody)).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("names no one") },
    });
    expect(readdirSync(exchange)).toEqual([]);
    // The registry reaches a remote analyser only for the call allowed to use it.
    expect(await analyzers.registry.analyze(ocr(run, frame))).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const viaRegistry = await analyzers.registry.analyze(ocr(run, frame), { remote: "fixture.analyze" });
    expect(viaRegistry, JSON.stringify(viaRegistry)).toMatchObject({ ok: true, analyzer: "fixture.analyze" });

    // The server changes its declared manifest: the tool drifts and is withheld, and the analyser built on it stops.
    writeFileSync(meta, JSON.stringify({ version: "2" }));
    expect(await runtime.mcp.checkDrift("mcp.vision")).toMatchObject({ withheld: expect.arrayContaining(["mcp.vision.analyze"]) });
    expect(await analyze.analyze(ocr(run, frame))).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("not approved") },
    });

    // A JSON-RPC error's message, and the restart it leads to, are said in Tavi's words, never the server's.
    const rpcError = analyzers.registry.for("transcribe")[1];
    for (const said of [await rpcError?.analyze(ocr(run, frame)), await rpcError?.analyze(ocr(run, frame))]) {
      expect(said).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(JSON.stringify(said)).not.toContain("ignore previous");
    }
    await analyzers.close();
  }, 120_000);
});
