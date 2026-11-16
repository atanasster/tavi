import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AnalyzerManifest } from "@tavi/contracts";
import { createCommandAnalyzer } from "@tavi/plugin-video";
import { poseAnalyzerEntry, poseModelsDirectory } from "@tavi/video-pose";
import { temporaryDirectories } from "@tavi/test-support";

import { CONFORMANCE_CASES, runAnalyzerConformance, type ConformanceCase } from "./support/video-analyzer-conformance.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

/**
 * The analyser conformance suite against the command analyser's fixtures:
 * the conforming one passes every
 * case, and each bad one fails exactly its own. They run bare here: the suite
 * tests what an analyser does, and confinement is the decoder's real test's.
 */

const script = (name: string): string => fileURLToPath(new URL(`../evals/video/analyzers/${name}.mjs`, import.meta.url));

const manifest: AnalyzerManifest = {
  id: "cmd.fixture",
  version: "1",
  attribution: { name: "Tavi fixture", licence: "MIT" },
  capabilities: [
    { capability: "transcribe", inputs: ["audio"], output: "Transcript@1" },
    { capability: "ocr", inputs: ["frames"], output: "FrameText@1" },
  ],
  local: true,
  confined: true,
  models: [{ name: "fixture-1", installed: true }],
};

const fixture = (name: string) => (probe: { readonly port: number }) =>
  createCommandAnalyzer({
    entry: {
      type: "command",
      id: name,
      command: process.execPath,
      args: [script(name), "{{framesDir}}", "{{audio}}", "{{outDir}}", "{{options}}", String(probe.port)],
      manifest,
      readRoots: [],
    },
    sandbox: { kind: "none" },
  });

describe("the video analyser conformance suite", () => {
  it("passes the conforming command analyser on every case", async () => {
    const report = await runAnalyzerConformance(fixture("conforming"));
    for (const name of CONFORMANCE_CASES) expect(report[name], `${name}: ${report[name].detail ?? ""}`).toEqual({ pass: true });
  }, 60_000);

  it.each([
    ["writes-outside", "writes"],
    ["network", "network"],
    ["wrong-schema", "output"],
  ] as const)(
    "fails %s on %s alone",
    async (name, expected: ConformanceCase) => {
      const report = await runAnalyzerConformance(fixture(name));
      expect(CONFORMANCE_CASES.filter((key) => !report[key].pass)).toEqual([expected]);
    },
    60_000,
  );
});

describe("the pose add-on in the conformance suite", () => {
  it("passes every case through its built child, on the stand-in runtime and a stand-in model", async () => {
    const data = temp.create("tavi-pose-conformance-");
    const models = poseModelsDirectory(data);
    mkdirSync(models, { recursive: true });
    // The stand-in runtime's model: every joint's peak at one bin (packages/video-pose/test/fixtures/fake-ort.mjs).
    writeFileSync(join(models, "pose.onnx"), JSON.stringify({ kind: "pose", joints: 17, x: 1, y: 1 }));
    const made = poseAnalyzerEntry(
      { path: "pose.onnx", licence: "Apache-2.0" },
      { dataDirectory: data, ort: fileURLToPath(new URL("../packages/video-pose/test/fixtures/fake-ort.mjs", import.meta.url)) },
    );
    if (!("entry" in made)) throw new Error(made.missing);
    const report = await runAnalyzerConformance(() => createCommandAnalyzer({ entry: made.entry, sandbox: { kind: "none" } }), {
      // The child reads raw RGB frames, as video.pose hands them.
      media: (_capability, directory) => {
        const frames = join(directory, "frames");
        mkdirSync(frames);
        return {
          frames: [0, 0.1].map((timeSec, index) => {
            const path = join(frames, `frame-${String(index).padStart(4, "0")}.rgb`);
            writeFileSync(path, new Uint8Array(64 * 48 * 3).fill(128));
            return { timeSec, path, width: 64, height: 48, format: "rgb24" as const };
          }),
        };
      },
    });
    for (const name of CONFORMANCE_CASES) expect(report[name], `${name}: ${report[name].detail ?? ""}`).toEqual({ pass: true });
  }, 60_000);
});
