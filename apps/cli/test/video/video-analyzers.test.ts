import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AnalyzerManifest, ConfinementPort, InvocationContext, ModelPort, VideoAnalyzerPort } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { poseAnalyzerEntry, poseModelsDirectory } from "@tavi/video-pose";
import { findWhisper, transcribeModelsDirectory } from "@tavi/video-transcribe";
import { createAnalyzerRegistry, createCommandAnalyzer } from "@tavi/plugin-video";
import { temporaryDirectories } from "@tavi/test-support";

import {
  analyzerConfigPath,
  createVideoAnalyzers,
  pdfOcrAnalyzer,
  loadAnalyzerConfig,
  loadVideoPoseAddOn,
  loadVideoTranscribeAddOn,
  videoAnalyzerFacts,
  videoBuiltins,
} from "../../src/features/video/host.js";
import { analyzerAssessment, approvedRemoteAnalyzer, unattendedHint } from "../../src/features/video/tools.js";
import { CONFORMANCE_CASES, runAnalyzerConformance } from "../../../../tests/support/video-analyzer-conformance.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The owner's video analysers: `analyzers.json` read and validated, each capability's chain built
 * and listed for `doctor`, and a remote analyser raising its call. Commands
 * are `node -e`, never a script written here.
 */

const roots = temporaryDirectories();
afterEach(() => roots.cleanup());
function dataDirectory(config?: unknown): string {
  const root = roots.create("tavi-video-analyzers-");
  mkdirSync(join(root, "video"));
  if (config !== undefined) writeFileSync(analyzerConfigPath(root), typeof config === "string" ? config : JSON.stringify(config));
  return root;
}

/** srt stands aside here: the launch is run as given, so the test sees what the analyser itself does. */
const passThrough: ConfinementPort = {
  wrap: (request) => ({ command: request.argv[0] ?? "", args: request.argv.slice(1), env: request.env }),
} as ConfinementPort;

const manifest = (local = true): AnalyzerManifest => ({
  id: local ? "cmd.reader" : "cmd.cloud",
  version: "1",
  attribution: { name: local ? "Reader" : "Cloud OCR", url: "https://ocr.example", licence: "MIT" },
  capabilities: [{ capability: "ocr", inputs: ["frames"], output: "FrameText@1" }],
  local,
  confined: true,
  models: [{ name: "reader-1", installed: true }],
});

const answer = `const fs = require("node:fs"), path = require("node:path"); const [frames, out] = process.argv.slice(1);
const listed = JSON.parse(fs.readFileSync(path.join(frames, "frames.json"), "utf8")).frames;
fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ result: { frames: listed.map((f) => ({ timeSec: f.timeSec, text: "EXIT", confidence: 90 })) } }));`;

const command = (extra: Record<string, unknown> = {}) => ({
  type: "command",
  id: "reader",
  command: process.execPath,
  args: ["-e", answer, "{{framesDir}}", "{{outDir}}"],
  manifest: manifest(),
  readRoots: [],
  ...extra,
});

describe("analyzers.json", () => {
  it("is the built-in chains when absent, and an error doctor shows when it is unreadable, not JSON, invalid or a link", () => {
    expect(loadAnalyzerConfig(dataDirectory())).toEqual({
      config: {
        pose: [{ type: "builtin", id: "rtmpose" }],
        transcribe: [{ type: "builtin", id: "whisper-cpp" }],
        ocr: [{ type: "builtin", id: "pdf-ocr" }],
      },
      present: false,
    });
    expect(loadAnalyzerConfig(dataDirectory("{"))).toMatchObject({ error: expect.stringContaining("not JSON") });
    expect(
      loadAnalyzerConfig(
        dataDirectory({ ocr: [{ type: "command", id: "Bad Id", command: "/x", args: [], manifest: manifest(), readRoots: [] }] }),
      ),
    ).toMatchObject({ error: expect.stringContaining("ocr.0") });
    // A command that reaches the network must say it is not local.
    expect(loadAnalyzerConfig(dataDirectory({ ocr: [command({ domains: ["ocr.example"] })] }))).toMatchObject({
      error: expect.stringContaining("not local"),
    });
    const linked = dataDirectory();
    const real = join(linked, "elsewhere.json");
    writeFileSync(real, "{}");
    symlinkSync(real, analyzerConfigPath(linked));
    expect(loadAnalyzerConfig(linked)).toMatchObject({ error: expect.stringContaining("not a regular file") });
  });

  it("builds each capability's chain, listing what cannot run and why, and runs a command analyser through the registry", async () => {
    const data = dataDirectory({
      ocr: [
        { type: "builtin", id: "pdf-ocr" },
        { type: "mcp", server: "vision", tool: "read" },
        command({ id: "relative", command: "node", manifest: { ...manifest(), id: "cmd.relative" } }),
        command(),
      ],
      pose: [command({ id: "wrong", manifest: { ...manifest(), id: "cmd.wrong" } })],
    });
    const analyzers = createVideoAnalyzers(data, passThrough, { platform: "darwin" });
    expect(analyzers.chains.ocr?.map((entry) => [entry.id, entry.status])).toEqual([
      ["pdf-ocr", "not-installed"],
      ["mcp.vision/read", "not-installed"],
      ["relative", "refused"],
      ["reader", "ready"],
    ]);
    expect(analyzers.chains.pose).toEqual([
      { id: "wrong", type: "command", local: true, status: "refused", note: "its manifest does not declare pose" },
    ]);
    expect(videoAnalyzerFacts(analyzers, data)).toMatchObject({
      chains: {
        ocr: expect.arrayContaining(["reader (command): ready", "relative (command): refused, its command must be an absolute path"]),
      },
    });
    const run = join(data, "video", "run");
    mkdirSync(join(run, "frames"), { recursive: true });
    const frame = join(run, "frames", "0001.png");
    writeFileSync(frame, "png");
    const outcome = await analyzers.registry.analyze({
      capability: "ocr",
      frames: [{ timeSec: 1.5, path: frame, width: 2, height: 2, format: "png" }],
      runDirectory: run,
      options: { language: "eng" },
      limits: { timeoutMs: 20_000, maxOutputBytes: 4_096 },
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ ok: true, analyzer: "cmd.reader", result: { frames: [{ timeSec: 1.5, text: "EXIT" }] } });
    await analyzers.close();
  });

  it("refuses an entry whose id or manifest id another entry holds, a placeholder inside an argument and relative readRoots", () => {
    const other = { ...manifest(), id: "cmd.other" };
    const data = dataDirectory({
      ocr: [
        command(),
        command({ args: ["-e", answer, "--out={{outDir}}"], id: "inline-arg", manifest: { ...manifest(), id: "cmd.inline" } }),
        command({ id: "rooted", readRoots: ["models"], manifest: { ...manifest(), id: "cmd.rooted" } }),
        command({ id: "twin", manifest: manifest() }),
      ],
      // The same id with another definition is another command: refused, never the first one reused.
      transcribe: [
        command({
          command: "/usr/bin/false",
          manifest: { ...other, capabilities: [{ capability: "transcribe", inputs: ["audio"], output: "Transcript@1" }] },
        }),
      ],
    });
    const analyzers = createVideoAnalyzers(data, passThrough, { platform: "darwin" });
    // reader is two definitions: refused in both chains, in either order; twin claims reader's manifest id.
    expect(analyzers.chains.ocr?.map((entry) => [entry.id, entry.status, entry.note])).toEqual([
      ["reader", "refused", "another command entry is named reader"],
      ["inline-arg", "refused", expect.stringContaining("placeholder or plain text")],
      ["rooted", "refused", "its readRoots must be absolute paths"],
      ["twin", "refused", "its manifest id cmd.reader is claimed by command reader and command twin"],
    ]);
    expect(analyzers.chains.transcribe).toEqual([
      { id: "reader", type: "command", local: true, status: "refused", note: "another command entry is named reader" },
    ]);
    expect(analyzers.registry.for("ocr")).toEqual([]);
    // One entry listed under two capabilities is one analyser.
    const shared = createVideoAnalyzers(
      dataDirectory({
        ocr: [
          command({
            manifest: {
              ...manifest(),
              capabilities: [...manifest().capabilities, { capability: "transcribe", inputs: ["audio"], output: "Transcript@1" }],
            },
          }),
        ],
        transcribe: [
          command({
            manifest: {
              ...manifest(),
              capabilities: [...manifest().capabilities, { capability: "transcribe", inputs: ["audio"], output: "Transcript@1" }],
            },
          }),
        ],
      }),
      passThrough,
      { platform: "darwin" },
    );
    expect(shared.registry.for("ocr")[0]).toBe(shared.registry.for("transcribe")[0]);
  });

  it("lists a built-in that cannot be made, rather than failing to start", () => {
    const analyzers = createVideoAnalyzers(
      dataDirectory(),
      passThrough,
      { platform: "darwin" },
      {
        rtmpose: () => {
          throw new RangeError("an analyser argument is a placeholder or plain text, not both: /data/{{x}}");
        },
      },
    );
    expect(analyzers.chains.pose).toEqual([
      { id: "rtmpose", type: "builtin", status: "not-installed", note: expect.stringContaining("placeholder") },
    ]);
  });

  it("uses an installed built-in, says the PDF OCR adapter is not built yet, and refuses one past the size cap or unreadable", () => {
    const built: VideoAnalyzerPort = {
      manifest: () => ({
        ...manifest(),
        id: "builtin.rtmpose",
        capabilities: [{ capability: "pose", inputs: ["frames"], output: "PoseTrack@1", skeleton: "coco17" }],
      }),
      analyze: async () => ({ ok: false, error: { code: "internal", retryable: false, message: "x" } }),
      close: async () => undefined,
    };
    const analyzers = createVideoAnalyzers(dataDirectory(), passThrough, { platform: "darwin" }, { rtmpose: () => built });
    expect(analyzers.chains.pose).toEqual([{ id: "rtmpose", type: "builtin", local: true, status: "ready", note: "licence MIT" }]);
    expect(analyzers.registry.for("pose")).toEqual([built]);
    expect(analyzers.chains.ocr).toEqual([
      { id: "pdf-ocr", type: "builtin", status: "not-installed", note: "the PDF engine is not available here" },
    ]);
    expect(analyzers.chains.transcribe).toMatchObject([{ id: "whisper-cpp", status: "not-installed" }]);
    expect(loadAnalyzerConfig(dataDirectory(" ".repeat(64 * 1024 + 1)))).toMatchObject({ error: expect.stringContaining("over 64 KiB") });
    // A file that cannot be looked at is an error, never the built-in chains.
    const hidden = dataDirectory("{}");
    chmodSync(join(hidden, "video"), 0o000);
    try {
      expect(loadAnalyzerConfig(hidden)).toMatchObject({ error: expect.stringContaining("could not be read") });
    } finally {
      chmodSync(join(hidden, "video"), 0o700);
    }
  });

  it("uses no analyser, and says why, when the file does not parse", () => {
    const data = dataDirectory("[]");
    const analyzers = createVideoAnalyzers(data, passThrough, { platform: "darwin" });
    expect(analyzers.registry.for("ocr")).toEqual([]);
    expect(videoAnalyzerFacts(analyzers, data)).toMatchObject({
      configError: expect.any(String),
      note: expect.stringContaining("no analyser runs"),
    });
  });
});

describe("a video analysis call's assessment", () => {
  const port = (local: boolean): VideoAnalyzerPort => ({
    manifest: () => manifest(local),
    analyze: async () => ({ ok: false, error: { code: "internal", retryable: false, message: "not here" } }),
    close: async () => undefined,
  });
  const attended: InvocationContext = { workspaceId: "w1", principalId: "operator", runId: "task-1", caller: "cli" };
  const routine: InvocationContext = { ...attended, caller: "routine" };

  it("raises the call to external when its first analyser is remote, naming it on the card and in the subject dispatch reads", () => {
    const registry = createAnalyzerRegistry({ ocr: [port(false), port(true)] });
    const raised = analyzerAssessment(registry, { capability: "ocr", frames: 3 }, attended, "Read the frames' text");
    expect(raised).toMatchObject({
      effect: "external",
      sink: "network",
      attendedOnly: true,
      subjects: ["analyzer:cmd.cloud"],
      display: { title: "Read the frames' text with cmd.cloud", destination: expect.stringContaining("https://ocr.example") },
    });
    expect(approvedRemoteAnalyzer(raised.subjects)).toBe("cmd.cloud");
    // Unattended, the local one goes first: the call stays the read it declares, and no remote analyser is approved.
    expect(unattendedHint(routine)).toBe(true);
    const local = analyzerAssessment(registry, { capability: "ocr", frames: 3 }, routine, "Read the frames' text");
    expect(local.effect).toBeUndefined();
    expect(approvedRemoteAnalyzer(local.subjects)).toBeUndefined();
    expect(analyzerAssessment(undefined, { capability: "ocr", frames: 3 }, attended, "Read").effect).toBeUndefined();
  });
});

describe("the composed owner's analysers", () => {
  /** A model that is never asked anything here. */
  const idle: ModelPort = {
    stream: async (request) => ({ status: "completed", attemptId: request.attemptId, text: "", toolCalls: [], usage: {} }),
  };
  const compose = async (directory: string, overrides: Parameters<typeof composeTaviRuntime>[1] = {}) =>
    composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), { modelOverride: idle, ...overrides });

  it("reads analyzers.json at start and lists its chains in doctor, or the override's none, and closes them with the runtime", async () => {
    const data = dataDirectory({ ocr: [command()] });
    const runtime = await compose(data);
    try {
      expect(await runtime.videoDoctor()).toMatchObject({
        analyzers: { config: analyzerConfigPath(data), chains: { ocr: ["reader (command): ready"] } },
      });
    } finally {
      await runtime.close();
    }
    let closed = false;
    const registry = createAnalyzerRegistry({
      ocr: [
        {
          manifest: () => manifest(),
          analyze: async () => ({ ok: false, error: { code: "internal", retryable: false, message: "x" } }),
          close: async () => {
            closed = true;
          },
        },
      ],
    });
    const overridden = await compose(dataDirectory({ ocr: [command()] }), { videoAnalyzersOverride: registry });
    try {
      expect(await overridden.videoDoctor()).toMatchObject({ analyzers: { chains: { ocr: [], pose: [], transcribe: [] } } });
    } finally {
      await overridden.close();
    }
    // An override is the caller's to close.
    expect(closed).toBe(false);
  }, 60_000);
});

describe("the pose add-on as the owner runs it", () => {
  const fakeOrt = fileURLToPath(new URL("../../../../packages/video-pose/test/fixtures/fake-ort.mjs", import.meta.url));

  it("is listed as needing the person's model until analyzers.json names one in the models directory", async () => {
    const addOn = await loadVideoPoseAddOn();
    expect(addOn).toBeDefined();
    const data = dataDirectory({ pose: [{ type: "builtin", id: "rtmpose" }] });
    const analyzers = createVideoAnalyzers(
      data,
      passThrough,
      { platform: "darwin" },
      videoBuiltins(data, passThrough, { platform: "darwin" }, addOn),
    );
    expect(analyzers.chains.pose).toEqual([
      { id: "rtmpose", type: "builtin", status: "not-installed", note: expect.stringContaining("ships no pose weights") },
    ]);
    const outside = dataDirectory({ pose: [{ type: "builtin", id: "rtmpose", model: { path: "/etc/hosts", licence: "MIT" } }] });
    mkdirSync(poseModelsDirectory(outside), { recursive: true });
    expect(
      createVideoAnalyzers(outside, passThrough, { platform: "darwin" }, videoBuiltins(outside, passThrough, { platform: "darwin" }, addOn))
        .chains.pose?.[0],
    ).toMatchObject({ status: "not-installed", note: expect.stringContaining("outside") });
  });

  it("lists whisper.cpp as needing the person's model, and then their whisper.cpp, until both are there", async () => {
    const transcribe = await loadVideoTranscribeAddOn();
    expect(transcribe).toBeDefined();
    const data = dataDirectory({ transcribe: [{ type: "builtin", id: "whisper-cpp" }] });
    const chains = (root: string) =>
      createVideoAnalyzers(
        root,
        passThrough,
        { platform: "darwin" },
        videoBuiltins(root, passThrough, { platform: "darwin" }, undefined, transcribe),
      ).chains.transcribe;
    expect(chains(data)).toEqual([
      { id: "whisper-cpp", type: "builtin", status: "not-installed", note: expect.stringContaining("ships no transcription model") },
    ]);
    const modelled = dataDirectory({
      transcribe: [{ type: "builtin", id: "whisper-cpp", model: { path: "ggml-base.bin", licence: "MIT" } }],
    });
    mkdirSync(transcribeModelsDirectory(modelled), { recursive: true });
    writeFileSync(join(transcribeModelsDirectory(modelled), "ggml-base.bin"), "x");
    // The model is there: what is left is whisper.cpp itself, said not installed where it is not, ready where it is.
    expect(chains(modelled)?.[0]).toEqual(
      findWhisper() === undefined
        ? { id: "whisper-cpp", type: "builtin", status: "not-installed", note: expect.stringContaining("whisper.cpp is not installed") }
        : { id: "whisper-cpp", type: "builtin", local: true, status: "ready", note: "licence MIT" },
    );
  });

  it("runs its built child as a command analyser on the decoder's raw frames, and answers a pose track", async () => {
    const data = dataDirectory();
    const models = poseModelsDirectory(data);
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, "pose.onnx"), JSON.stringify({ kind: "pose", joints: 17, x: 192, y: 256 }));
    const made = poseAnalyzerEntry({ path: "pose.onnx", licence: "Apache-2.0" }, { dataDirectory: data, ort: fakeOrt });
    if (!("entry" in made)) throw new Error(made.missing);
    const analyzer = createCommandAnalyzer({ entry: made.entry, sandbox: { kind: "none" } });
    const run = join(data, "video", "run");
    mkdirSync(join(run, "frames"), { recursive: true });
    const frames = [0, 0.1].map((timeSec, index) => {
      const path = join(run, "frames", `frame-${String(index).padStart(4, "0")}.rgb`);
      writeFileSync(path, new Uint8Array(64 * 48 * 3));
      return { timeSec, path, width: 64, height: 48, format: "rgb24" as const };
    });
    const outcome = await analyzer.analyze({
      capability: "pose",
      frames,
      runDirectory: run,
      options: {},
      limits: { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      ok: true,
      model: "pose.onnx",
      result: { skeleton: "coco17", frames: [{ timeSec: 0 }, { timeSec: 0.1 }] },
    });
    if (outcome.ok) expect(outcome.result.frames[0]?.people[0]?.keypoints).toHaveLength(17);
  }, 60_000);
});

describe("the PDF engine's OCR as a video analyser", () => {
  const engine =
    (
      answer: (images: readonly { readonly page: number; readonly png: Uint8Array }[], signal?: AbortSignal) => unknown,
      ocrAvailable = true,
    ) =>
    () =>
      ({
        ocrAvailable,
        ocr: async (images: readonly { readonly page: number; readonly png: Uint8Array }[], options?: { readonly signal?: AbortSignal }) =>
          answer(images, options?.signal),
      }) as never;

  it("hands the decoder's raw frames over as PNG pages, and reads its pages back as frame text", async () => {
    const run = dataDirectory();
    const frame = join(run, "frame.rgb");
    writeFileSync(frame, new Uint8Array(4 * 2 * 3).fill(200));
    const seen: Uint8Array[] = [];
    const analyzer = pdfOcrAnalyzer(
      engine(
        (images) => (
          seen.push(...images.map((image) => image.png)),
          { ok: true, pages: [{ page: 1, text: "EXIT 12", confidence: 91 }], peakKb: 1, wallMs: 1 }
        ),
      ),
    );
    const outcome = await analyzer.analyze({
      capability: "ocr",
      frames: [{ timeSec: 2.5, path: frame, width: 4, height: 2, format: "rgb24" }],
      runDirectory: run,
      options: { language: "eng" },
      limits: { timeoutMs: 10_000, maxOutputBytes: 10_000 },
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ ok: true, result: { frames: [{ timeSec: 2.5, text: "EXIT 12", confidence: 91 }] } });
    expect(
      Buffer.from(seen[0] as Uint8Array)
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");
    expect(analyzer.manifest()).toMatchObject({ id: "builtin.pdf-ocr", local: true, capabilities: [{ capability: "ocr", maxFrames: 10 }] });
  });

  it("passes the conformance suite: bounded by the request's time and the caller's signal, answering in its schema", async () => {
    // An engine that takes 50 ms unless its signal ends the child first, as the real one does: a millisecond's time
    // and a signal 5 ms in each stop the call.
    const slow = engine(async (images, signal) => {
      const ended = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 50);
        signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(true)), { once: true });
      });
      return ended
        ? { ok: false, failure: "timeout" }
        : { ok: true, pages: images.map((image) => ({ page: image.page, text: "", confidence: 0 })), peakKb: 1, wallMs: 50 };
    });
    const report = await runAnalyzerConformance(() => pdfOcrAnalyzer(slow));
    for (const name of CONFORMANCE_CASES) expect(report[name], `${name}: ${report[name].detail ?? ""}`).toEqual({ pass: true });
  });

  it("refuses more frames than the engine reads at once, and says its add-on is missing", async () => {
    const run = dataDirectory();
    const frame = join(run, "frame.rgb");
    writeFileSync(frame, new Uint8Array(12));
    const frames = Array.from({ length: 11 }, (_, index) => ({
      timeSec: index,
      path: frame,
      width: 2,
      height: 2,
      format: "rgb24" as const,
    }));
    const request = {
      capability: "ocr" as const,
      runDirectory: run,
      options: { language: "eng" as const },
      limits: { timeoutMs: 10_000, maxOutputBytes: 10_000 },
      signal: new AbortController().signal,
    };
    expect(await pdfOcrAnalyzer(engine(() => ({ ok: true, pages: [] }))).analyze({ ...request, frames })).toMatchObject({
      ok: false,
      error: { code: "too-large" },
    });
    expect(
      await pdfOcrAnalyzer(engine(() => ({ ok: false, refused: "no-ocr" }))).analyze({ ...request, frames: frames.slice(0, 1) }),
    ).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("@tavi/pdf-ocr") } });
    const missing = createVideoAnalyzers(
      dataDirectory(),
      passThrough,
      { platform: "darwin" },
      videoBuiltins(
        dataDirectory(),
        passThrough,
        { platform: "darwin" },
        undefined,
        undefined,
        engine(() => ({}), false),
      ),
    );
    expect(missing.chains.ocr).toEqual([
      { id: "pdf-ocr", type: "builtin", status: "not-installed", note: expect.stringContaining("@tavi/pdf-ocr") },
    ]);
  });
});
