import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TranscriptSchema } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";

import { findWhisper, TRANSCRIBE_ANALYZER_ID, transcribeAnalyzerEntry, transcribeModelsDirectory } from "../src/index.js";
import { languageOf, runTranscribe, transcriptOf, type Exec } from "../src/run.js";

/** The transcription add-on: whisper.cpp's JSON read as Transcript@1, failures by kind, the model kept to its directory. */

const temp = temporaryDirectories({ prefix: "tavi-video-transcribe-" });
afterEach(() => temp.cleanup());

const whisperJson = {
  result: { language: "de" },
  transcription: [
    { timestamps: { from: "00:00:00,000", to: "00:00:02,500" }, offsets: { from: 0, to: 2500 }, text: " Guten Tag" },
    { timestamps: { from: "00:00:02,500", to: "00:00:04,000" }, text: " wie geht's" },
    { timestamps: { from: "00:00:05,000", to: "00:00:04,000" }, text: "backwards" },
    { offsets: { from: 6000, to: 7000 }, text: "   " },
  ],
};

describe("whisper.cpp's transcript", () => {
  it("reads its segments and times as Transcript@1, its language unless one was asked for", () => {
    const transcript = transcriptOf(whisperJson, undefined);
    expect(TranscriptSchema.parse(transcript)).toEqual({
      language: "de",
      segments: [
        { startSec: 0, endSec: 2.5, text: "Guten Tag" },
        { startSec: 2.5, endSec: 4, text: "wie geht's" },
      ],
    });
    expect(transcriptOf(whisperJson, "fr")?.language).toBe("fr");
    expect(transcriptOf({ nope: true }, undefined)).toBeUndefined();
  });

  it("reads a transcript whose words hold a raw control character, and the language a request asks for", async () => {
    const out = temp.create();
    await runTranscribe({ audio: "/a.wav", outDir: out, whisper: "/w", model: "/m" }, async (_command, args) => {
      writeFileSync(
        `${args[args.indexOf("-of") + 1] ?? ""}.json`,
        '{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":1000},"text":"tab\there\u0007bell"}]}'
          .replace("\\t", "\t")
          .replace("\\u0007", "\u0007"),
      );
      return { code: 0, stderr: "" };
    });
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({ result: { segments: [{ text: "tab here bell" }] } });
    expect(languageOf('{"language":"yue"}')).toBe("yue");
    expect(languageOf('{"language":"EN"}')).toBeUndefined();
    expect(languageOf("not json")).toBeUndefined();
  });

  it("runs the person's whisper.cpp with one thread on the CPU and JSON out, and says a failure by kind", async () => {
    const out = temp.create();
    const calls: (readonly string[])[] = [];
    const writes: Exec = async (_command, args) => {
      calls.push(args);
      writeFileSync(`${args[args.indexOf("-of") + 1] ?? ""}.json`, JSON.stringify(whisperJson));
      return { code: 0, stderr: "" };
    };
    await runTranscribe(
      { audio: "/run/audio.wav", outDir: out, whisper: "/bin/whisper-cli", model: "/m/ggml-base.bin", language: "de" },
      writes,
    );
    expect(calls[0]).toEqual(
      expect.arrayContaining(["-m", "/m/ggml-base.bin", "-f", "/run/audio.wav", "-l", "de", "-t", "1", "-ng", "-oj"]),
    );
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({
      result: { language: "de", segments: [{ text: "Guten Tag" }, { text: "wie geht's" }] },
    });
    await runTranscribe({ audio: "/a.wav", outDir: out, whisper: "/w", model: "/m" }, async () => ({
      code: 1,
      stderr: "whisper_init_from_file: failed to load model",
    }));
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({ error: { code: "model-load" } });
    // With -np, whisper-cli says only that its context failed: the model's, so the chain tries the next analyser.
    await runTranscribe({ audio: "/a.wav", outDir: out, whisper: "/w", model: "/m" }, async () => ({
      code: 3,
      stderr: "error: failed to initialize whisper context",
    }));
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({ error: { code: "model-load" } });
    await runTranscribe({ audio: "/a.wav", outDir: out, whisper: "/w", model: "/m" }, async () => ({
      code: null,
      signal: "SIGKILL",
      stderr: "",
    }));
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({ error: { code: "crashed" } });
    await runTranscribe({ audio: "/a.wav", outDir: out, whisper: "/w", model: "/m" }, async () => {
      throw new Error("ENOENT");
    });
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({ error: { code: "unavailable" } });
    // A fresh output directory, as every call has: no JSON left in it.
    const fresh = temp.create();
    await runTranscribe({ audio: "/a.wav", outDir: fresh, whisper: "/w", model: "/m" }, async () => ({ code: 0, stderr: "" }));
    expect(JSON.parse(readFileSync(join(fresh, "result.json"), "utf8"))).toMatchObject({
      error: { code: "internal", message: expect.stringContaining("no JSON") },
    });
  });
});

describe("the person's whisper.cpp and model", () => {
  it("is found by name on PATH, never relative, and the model kept to the models directory", () => {
    const root = temp.create();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "whisper-cli"), "", { mode: 0o755 });
    expect(findWhisper({ path: bin })).toMatch(/whisper-cli$/);
    expect(findWhisper({ whisper: "whisper-cli" })).toBeUndefined();
    const data = temp.create();
    mkdirSync(transcribeModelsDirectory(data), { recursive: true });
    writeFileSync(join(transcribeModelsDirectory(data), "ggml-base.bin"), "x");
    const outside = join(data, "elsewhere.bin");
    writeFileSync(outside, "x");
    symlinkSync(outside, join(transcribeModelsDirectory(data), "linked.bin"));
    const made = transcribeAnalyzerEntry(
      { path: "ggml-base.bin", licence: "MIT" },
      { dataDirectory: data, whisper: join(bin, "whisper-cli") },
    );
    if (!("entry" in made)) throw new Error(made.missing);
    expect(made.entry.manifest).toMatchObject({
      id: TRANSCRIBE_ANALYZER_ID,
      local: true,
      attribution: { licence: "MIT" },
      capabilities: [{ capability: "transcribe", inputs: ["audio"] }],
    });
    expect(made.entry.args).toEqual(expect.arrayContaining(["{{audio}}", "{{outDir}}", "{{options}}", "--whisper"]));
    // The host's library closure for whisper.cpp stands for its prefix.
    const closed = transcribeAnalyzerEntry(
      { path: "ggml-base.bin", licence: "MIT" },
      { dataDirectory: data, whisper: join(bin, "whisper-cli"), libraryRoots: () => ["/opt/whisper/lib"] },
    );
    if (!("entry" in closed)) throw new Error(closed.missing);
    expect(closed.entry.readRoots).toContain("/opt/whisper/lib");
    expect(closed.entry.readRoots).not.toContain(root);
    for (const path of ["linked.bin", outside, "../../elsewhere.bin"])
      expect(
        transcribeAnalyzerEntry({ path, licence: "MIT" }, { dataDirectory: data, whisper: join(bin, "whisper-cli") }),
        path,
      ).toMatchObject({ missing: expect.stringContaining("outside") });
    expect(
      transcribeAnalyzerEntry(
        { path: "ggml-base.bin", licence: "MIT" },
        { dataDirectory: data, path: join(root, "empty"), whisper: join(root, "none") },
      ),
    ).toMatchObject({ missing: expect.stringContaining("not installed") });
    expect(transcribeAnalyzerEntry(undefined, { dataDirectory: data })).toMatchObject({
      missing: expect.stringContaining("ships no transcription model"),
    });
  });
});
