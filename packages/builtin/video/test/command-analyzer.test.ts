import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import type { AnalyzeRequest, AnalyzerManifest } from "@tavi/contracts";

import { COMMAND_FRAMES_INDEX, createCommandAnalyzer } from "../src/command-analyzer.js";

/**
 * The command analyser's own rules:
 * placeholders are whole arguments, its answer is one file, its own error
 * stands, and what it is handed is held to the run. Each command is
 * `node -e`, never a script written here.
 */

const roots = temporaryDirectories({ prefix: "tavi-command-analyzer-" });
afterEach(() => roots.cleanup());

const manifest: AnalyzerManifest = {
  id: "cmd.inline",
  version: "1",
  attribution: { name: "inline", licence: "MIT" },
  capabilities: [{ capability: "ocr", inputs: ["frames"], output: "FrameText@1" }],
  local: true,
  confined: true,
  models: [],
};

/** A command that runs `code` with `[framesDir, outDir, options]` as `process.argv.slice(1)`. */
function inline(code: string, args: readonly string[] = ["{{framesDir}}", "{{outDir}}", "{{options}}"]) {
  return createCommandAnalyzer({
    entry: { type: "command", id: "inline", command: process.execPath, args: ["-e", code, ...args], manifest, readRoots: [] },
    sandbox: { kind: "none" },
  });
}

function run(): { readonly directory: string; readonly request: AnalyzeRequest<"ocr"> } {
  const directory = roots.create();
  mkdirSync(join(directory, "call"));
  const frames = [0, 1].map((timeSec) => {
    const path = join(directory, "call", `${String(timeSec)}.png`);
    writeFileSync(path, "png");
    return { timeSec, path, width: 2, height: 2, format: "png" as const };
  });
  return {
    directory,
    request: {
      capability: "ocr",
      frames,
      runDirectory: directory,
      options: { language: "eng" },
      limits: { timeoutMs: 20_000, maxOutputBytes: 4_096 },
      signal: new AbortController().signal,
    },
  };
}

const answers = `const [frames, out, options] = process.argv.slice(1);
const fs = require("node:fs"), path = require("node:path");
const listed = JSON.parse(fs.readFileSync(path.join(frames, "frames.json"), "utf8")).frames;
fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ result: { frames: listed.map((f) => ({ timeSec: f.timeSec, text: f.file + " " + JSON.parse(options).language, confidence: 80 })) }, model: "inline-1" }));`;

describe("the command analyser", () => {
  it("hands the frames by directory with their index, and takes its one answer file", async () => {
    const { directory, request } = run();
    const outcome = await inline(answers).analyze(request);
    expect(outcome).toMatchObject({
      ok: true,
      model: "inline-1",
      result: {
        frames: [
          { timeSec: 0, text: "0.png eng" },
          { timeSec: 1, text: "1.png eng" },
        ],
      },
    });
    // Its scratch and the frames' index are gone; the caller's frames stay.
    expect(readdirSync(directory)).toEqual(["call"]);
    expect(existsSync(join(directory, "call", COMMAND_FRAMES_INDEX))).toBe(false);
  });

  it("refuses a placeholder inside another argument when it is made", () => {
    expect(() => inline(answers, ["--frames={{framesDir}}"])).toThrow(/placeholder or plain text/);
  });

  it("takes its own error, whatever it exits with, and says a crash, a missing answer or one too large apart", async () => {
    const said = await inline(
      `require("node:fs").writeFileSync(require("node:path").join(process.argv[2], "result.json"), JSON.stringify({ error: { code: "model-load", message: "no weights" } })); process.exit(3);`,
    ).analyze(run().request);
    expect(said).toMatchObject({
      ok: false,
      error: { code: "model-load", retryable: true, message: expect.stringContaining("no weights") },
    });
    // Its diagnostics may quote the media, so they are not passed on.
    const crashed = await inline(`process.stderr.write("boom\\n"); process.exit(2);`).analyze(run().request);
    expect(crashed).toMatchObject({ ok: false, error: { code: "crashed", message: expect.stringContaining("exited 2") } });
    expect(JSON.stringify(crashed)).not.toContain("boom");
    // Exit 125 from a bare launch is its own exit, not a cgroup's refusal.
    expect(await inline(`process.exit(125);`).analyze(run().request)).toMatchObject({ ok: false, error: { code: "crashed" } });
    expect(await inline(`0`).analyze(run().request)).toMatchObject({ ok: false, error: { code: "protocol" } });
    expect(
      await inline(
        `require("node:fs").writeFileSync(require("node:path").join(process.argv[2], "result.json"), JSON.stringify({ result: { frames: [{ timeSec: 0, text: "x".repeat(3000), confidence: 1 }, { timeSec: 1, text: "x".repeat(3000), confidence: 1 }] } }));`,
      ).analyze(run().request),
    ).toMatchObject({ ok: false, error: { code: "protocol" } });
    expect(
      await createCommandAnalyzer({
        entry: { type: "command", id: "missing", command: "/nonexistent/analyser", args: [], manifest, readRoots: [] },
        sandbox: { kind: "none" },
      }).analyze(run().request),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("refuses frames outside the run or in more than one directory, and a launch the sandbox refuses", async () => {
    const { directory, request } = run();
    // Frames of another run, each in one directory: outside this run.
    const elsewhere = run();
    expect(await inline(answers).analyze({ ...request, frames: elsewhere.request.frames ?? [] })).toMatchObject({
      ok: false,
      error: { code: "bad-input", message: expect.stringContaining("one directory of the run") },
    });
    // Frames of this run, in two of its directories.
    mkdirSync(join(directory, "other"));
    const split = join(directory, "other", "2.png");
    writeFileSync(split, "png");
    expect(
      await inline(answers).analyze({
        ...request,
        frames: [...(request.frames ?? []), { timeSec: 2, path: split, width: 2, height: 2, format: "png" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "bad-input" } });
    const refused = createCommandAnalyzer({
      entry: { type: "command", id: "inline", command: process.execPath, args: ["-e", answers], manifest, readRoots: [] },
      sandbox: { kind: "wrapped", wrap: () => ({ refused: "unconfined" }) },
    });
    expect(await refused.analyze(run().request)).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("sandbox") },
    });
  });

  it("ends one that writes past the run's cap, counting what it writes anywhere in the run, and clears what it left there", async () => {
    const { directory, request } = run();
    // 70 MiB beside its own scratch, in the run directory itself.
    const outcome = await inline(
      `require("node:fs").writeFileSync(require("node:path").join(process.argv[2], "..", "..", "big"), Buffer.alloc(70 * 1024 * 1024)); setTimeout(() => {}, 5000);`,
    ).analyze(request);
    expect(outcome).toMatchObject({ ok: false, error: { code: "protocol" } });
    expect(readdirSync(directory)).toEqual(["call"]);
  });

  it("never writes through a link planted where the frames' index goes, and leaves a planted directory be", async () => {
    const { directory, request } = run();
    const target = join(directory, "..", `victim-${String(process.pid)}`);
    writeFileSync(target, "keep");
    onTestFinished(() => rmSync(target, { force: true }));
    symlinkSync(target, join(directory, "call", COMMAND_FRAMES_INDEX));
    expect(await inline(answers).analyze(request)).toMatchObject({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("keep");
    // An index the command replaced with a directory is not the owner's to remove: it stays, and later calls still run.
    const replaced = run();
    const making = inline(
      `const fs = require("node:fs"), path = require("node:path"); const index = path.join(process.argv[1], "frames.json"); const listed = JSON.parse(fs.readFileSync(index, "utf8")).frames; fs.rmSync(index); fs.mkdirSync(index); fs.writeFileSync(path.join(process.argv[2], "result.json"), JSON.stringify({ result: { frames: listed.map((f) => ({ timeSec: f.timeSec, text: "", confidence: 1 })) } }));`,
    );
    expect(await making.analyze(replaced.request)).toMatchObject({ ok: true });
    expect(await inline(answers).analyze(replaced.request)).toMatchObject({ ok: true });
  });

  it("asks the sandbox for the network only as a remote analyser, with the owner's hosts", async () => {
    const launches: { readonly domains?: readonly string[] }[] = [];
    const wrap = (launch: {
      readonly argv: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly domains?: readonly string[];
    }) => {
      launches.push(launch);
      return { command: launch.argv[0] ?? "", args: launch.argv.slice(1), env: launch.env };
    };
    const make = (local: boolean) =>
      createCommandAnalyzer({
        entry: {
          type: "command",
          id: "inline",
          command: process.execPath,
          args: ["-e", answers, "{{framesDir}}", "{{outDir}}", "{{options}}"],
          manifest: { ...manifest, local },
          readRoots: [],
          domains: local ? [] : ["api.example.com"],
        },
        sandbox: { kind: "wrapped", wrap },
      });
    expect(await make(true).analyze(run().request)).toMatchObject({ ok: true });
    expect(await make(false).analyze(run().request)).toMatchObject({ ok: true });
    expect(launches.map((launch) => launch.domains)).toEqual([[], ["api.example.com"]]);
  });

  it("gives a transcription analyser room for its speech model, and holds every other one to the frames' caps", async () => {
    const limits: number[] = [];
    // Every sample says 500 MiB: past the frames' watchdog, within transcription's.
    const make = (capability: "ocr" | "transcribe", code: string) =>
      createCommandAnalyzer({
        entry: {
          type: "command",
          id: "inline",
          command: process.execPath,
          args: ["-e", code, "{{framesDir}}", "{{outDir}}", "{{options}}"],
          manifest: {
            ...manifest,
            capabilities:
              capability === "ocr"
                ? manifest.capabilities
                : [{ capability: "transcribe", inputs: ["audio"], output: "Transcript@1", maxAudioSec: 600 }],
          },
          readRoots: [],
        },
        sandbox: {
          kind: "wrapped",
          wrap: (launch) => {
            limits.push(launch.limits.memoryBytes / 1024 / 1024);
            return { command: launch.argv[0] ?? "", args: launch.argv.slice(1), env: launch.env };
          },
        },
        residentKb: async () => 500 * 1024,
      });
    const slow = `setTimeout(() => {}, 1_500);`;
    expect(await make("ocr", slow).analyze(run().request)).toMatchObject({ ok: false, error: { code: "memory" } });
    const { directory, request } = run();
    writeFileSync(join(directory, "call", "audio.wav"), "wav");
    const transcribed = await make(
      "transcribe",
      `setTimeout(() => require("node:fs").writeFileSync(require("node:path").join(process.argv[2], "result.json"), JSON.stringify({ result: { language: "en", segments: [] } })), 1_500);`,
    ).analyze({ ...request, capability: "transcribe", frames: [], audio: { path: join(directory, "call", "audio.wav") } } as never);
    expect(transcribed).toMatchObject({ ok: true });
    expect(limits).toEqual([384, 1_024]);
  });
});
