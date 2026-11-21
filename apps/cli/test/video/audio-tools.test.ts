import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TOOL_LABEL_KEY,
  untrustedLabel,
  type AnalyzeRequest,
  type InvocationContext,
  type VideoAnalyzerPort,
  type VideoDecoderPort,
} from "@tavi/contracts";
import { createAnalyzerRegistry, createFfmpegDecoder, findFfmpeg } from "@tavi/plugin-video";
import { temporaryDirectories } from "@tavi/test-support";
import { createInMemoryArtifactRepository } from "@tavi/test-support/fakes";
import { ToolRegistry } from "@tavi/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { transcribeSetupNote } from "../../src/features/video/host.js";
import { noTranscriberMessage, registerAudioTools, type AudioToolOptions } from "../../src/features/video/audio.js";

const context: InvocationContext = { workspaceId: "w1", principalId: "operator", runId: "task-1", caller: "test" };
const signal = new AbortController().signal;

/** A transcriber in the test: whisper.cpp's stand-in, answering what it is told and noting the audio it was handed. */
function stubTranscriber(text: string, handed: string[] = []): VideoAnalyzerPort {
  return {
    manifest: () => ({
      id: "test.whisper",
      version: "1",
      attribution: { name: "stub whisper", licence: "MIT" },
      capabilities: [{ capability: "transcribe", inputs: ["audio"], output: "Transcript@1" }],
      local: true,
      confined: true,
      models: [{ name: "ggml-test", installed: true }],
    }),
    analyze: (async (request: AnalyzeRequest<"transcribe">) => {
      handed.push(request.audio?.path ?? "");
      return {
        ok: true as const,
        result: { language: "en", segments: [{ startSec: 0, endSec: 1.5, text }] },
        model: "ggml-test",
        wallMs: 1,
      };
    }) as VideoAnalyzerPort["analyze"],
    close: async () => undefined,
  };
}

const call = async (tools: ToolRegistry, input: unknown): Promise<Record<string, unknown>> => {
  const tool = tools.get("audio.transcribe");
  if (tool === undefined) throw new Error("audio.transcribe is not registered");
  return (await tool.handler({ input, context, signal })) as Record<string, unknown>;
};

/** A Telegram voice note as intake keeps it: Ogg bytes, an untrusted `attachment` artifact. */
async function voiceNote(artifacts: AudioToolOptions["artifacts"], body: Uint8Array) {
  return await artifacts.putArtifact({
    workspaceId: "w1",
    contentType: "audio/ogg",
    body,
    extension: "ogg",
    untrusted: true,
    label: untrustedLabel("attachment"),
  });
}

describe("audio.transcribe with nothing installed", () => {
  it("says the voice note arrived, names what is missing and how to install it, never that it did not arrive", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const note = await voiceNote(artifacts, new TextEncoder().encode("OggS\0not really opus"));
    const tools = new ToolRegistry();
    registerAudioTools(tools, {
      ffmpegMissing: () => "FFmpeg is not installed (brew install ffmpeg)",
      analyzers: createAnalyzerRegistry({}),
      transcribeSetup: () =>
        transcribeSetupNote({
          chains: { transcribe: [{ id: "whisper-cpp", type: "builtin", status: "not-installed", note: "whisper.cpp is not installed" }] },
        }),
      modelsDirectory: "/data/video/models",
      artifacts,
      enabled: async () => true,
    });
    const refused = call(tools, { artifactId: note.artifactId });
    await expect(refused).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const message = await refused.catch((error: Error) => error.message);
    expect(message).toContain(`The audio arrived and is kept (artifact ${note.artifactId})`);
    expect(message).toContain("FFmpeg is not installed");
    expect(message).toContain("whisper-cpp: whisper.cpp is not installed");
    expect(message).toContain("brew install whisper-cpp ffmpeg");
    expect(message).toContain("/data/video/models");
    expect(message).toContain("do not say the file did not arrive");
  });

  it("names the analyser alone when FFmpeg is there, and says when analyzers.json names none", () => {
    expect(transcribeSetupNote({ chains: {} })).toMatch(/no transcription analyser .* is named in analyzers\.json/);
    expect(transcribeSetupNote({ chains: { transcribe: [{ id: "whisper-cpp", type: "builtin", status: "ready" }] } })).toBeUndefined();
    expect(noTranscriberMessage("art-1", ["no transcription analyser"])).toMatch(
      /^The audio arrived .* no transcription analyser\. To read voice messages, finish the Voice messages step of setup \(Home's setup checklist, or `tavi setup voice`\), or install it with `brew install whisper-cpp ffmpeg`/,
    );
  });

  it("says the audio arrived when the video plugin or the workspace's video tools are off, and how to turn them on", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const note = await voiceNote(artifacts, new TextEncoder().encode("OggS\0not really opus"));
    const off = new ToolRegistry();
    registerAudioTools(off, { disabled: "the video plugin (tavi.video) is turned off here", artifacts, enabled: async () => true });
    const unplugged = await call(off, { artifactId: note.artifactId }).catch((error: Error) => error.message);
    expect(unplugged).toContain(`The audio arrived and is kept (artifact ${note.artifactId})`);
    expect(unplugged).toContain("the video plugin (tavi.video) is turned off here");
    expect(unplugged).toContain("do not say the file did not arrive");
    const workspaceOff = new ToolRegistry();
    registerAudioTools(workspaceOff, { artifacts, enabled: async () => false });
    const refused = call(workspaceOff, { artifactId: note.artifactId });
    await expect(refused).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await refused.catch((error: Error) => error.message)).toMatch(/^The audio arrived and is kept .*video\.enabled/);
  });

  it("refuses what is not audio, pointing a video to video.transcribe", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const clip = await artifacts.putArtifact({ workspaceId: "w1", contentType: "video/mp4", body: new Uint8Array(8), extension: "mp4" });
    const tools = new ToolRegistry();
    registerAudioTools(tools, { artifacts, enabled: async () => true });
    await expect(call(tools, { artifactId: clip.artifactId })).rejects.toThrow(/video\.transcribe/);
    await expect(call(tools, { artifactId: "art-none" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

const found = findFfmpeg();
describe.skipIf("missing" in found)("audio.transcribe on FFmpeg itself", () => {
  const directories = temporaryDirectories();
  let decoder: VideoDecoderPort;
  let ogg = new Uint8Array();

  beforeAll(async () => {
    const root = directories.create("tavi-audio-tools-");
    const path = join(root, "voice.ogg");
    // A two-second tone as Opus in Ogg: a Telegram voice note's format.
    const made = spawnSync((found as { readonly ffmpeg: string }).ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:a",
      "libopus",
      "-f",
      "ogg",
      path,
    ]);
    expect(made.status, made.stderr.toString()).toBe(0);
    ogg = new Uint8Array(readFileSync(path));
    decoder = await createFfmpegDecoder({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs") });
  });
  afterAll(async () => {
    await decoder.close();
    directories.cleanup();
  });

  it("turns a voice note into text a turn can use, labelled as the sender's untrusted attachment", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const note = await voiceNote(artifacts, ogg);
    const handed: string[] = [];
    const tools = new ToolRegistry();
    registerAudioTools(tools, {
      decoder: async () => decoder,
      analyzers: createAnalyzerRegistry({ transcribe: [stubTranscriber("remind me to call mum at five", handed)] }),
      artifacts,
      enabled: async () => true,
    });
    const result = await call(tools, { artifactId: note.artifactId });
    expect(result).toMatchObject({
      audio: { artifactId: note.artifactId, container: "ogg", durationSec: expect.closeTo(2, 0), codec: "opus" },
      language: "en",
      text: "remind me to call mum at five",
      segments: [{ startSec: 0, endSec: 1.5, text: "remind me to call mum at five" }],
      analyzer: { id: "test.whisper", model: "ggml-test" },
    });
    // The transcriber was handed FFmpeg's 16 kHz mono WAV, never the Ogg itself.
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatch(/audio\.wav$/);
    // The words are the sender's file's: untrusted, never the person's own.
    expect(result[TOOL_LABEL_KEY]).toEqual({
      stored: expect.objectContaining({ integrity: "untrusted", sources: ["attachment"] }),
    });
  });

  it("names the missing transcriber when FFmpeg alone is installed", async () => {
    const artifacts = createInMemoryArtifactRepository();
    const note = await voiceNote(artifacts, ogg);
    const tools = new ToolRegistry();
    registerAudioTools(tools, {
      decoder: async () => decoder,
      analyzers: createAnalyzerRegistry({}),
      transcribeSetup: () => transcribeSetupNote({ chains: {} }),
      artifacts,
      enabled: async () => true,
    });
    const message = await call(tools, { artifactId: note.artifactId }).catch((error: Error) => error.message);
    expect(message).toContain("no transcription analyser (whisper.cpp with a ggml model) is named in analyzers.json");
    expect(message).not.toContain("FFmpeg is not installed");
    expect(message).toContain("brew install whisper-cpp ffmpeg");
  });

  it("opens only audio as audio: a video run is refused, and a voice note is no video", async () => {
    expect(decoder.openAudio({ bytes: new TextEncoder().encode("not audio at all") })).toMatchObject({ ok: false, refused: "not-video" });
    expect(decoder.open({ bytes: ogg })).toMatchObject({ ok: false, refused: "not-video" });
  });
});
