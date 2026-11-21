import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzerConfigPath } from "../../src/features/video/host.js";
import { createVoiceSetup, voiceSetupCommands, withVoiceEntry, type VoiceSetupOptions } from "../../src/features/video/voice-setup.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/** A small stand-in for Whisper's base model: what the step pins is its size and checksum, whatever they are. */
const BODY = new TextEncoder().encode("ggml stand-in model bytes");
const MODEL = {
  file: "ggml-test.bin",
  url: "https://example.test/ggml-test.bin",
  sha256: createHash("sha256").update(BODY).digest("hex"),
  bytes: BODY.byteLength,
  licence: "MIT",
} as unknown as NonNullable<VoiceSetupOptions["model"]>;

const answering = (body: Uint8Array) => vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;

/** Waits for the job `start` began to end, reading `status` as a step does. */
async function settled(setup: ReturnType<typeof createVoiceSetup>) {
  for (let tries = 0; tries < 200; tries++) {
    const now = await setup.status();
    if (now.job?.state !== "running") return now;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the voice setup job did not end");
}

describe("withVoiceEntry", () => {
  it("puts the built-in whisper.cpp first in the transcription chain and keeps everything the person wrote", () => {
    const mine = { type: "command", id: "my-asr", command: ["/usr/local/bin/asr"] };
    expect(withVoiceEntry({ pose: [{ type: "builtin", id: "mediapipe" }], transcribe: [mine] }, "ggml-base.bin", "MIT")).toEqual({
      pose: [{ type: "builtin", id: "mediapipe" }],
      transcribe: [{ type: "builtin", id: "whisper-cpp", model: { path: "ggml-base.bin", licence: "MIT" } }, mine],
    });
  });

  it("gives an entry that names no model this one, and leaves one that names its own as it is", () => {
    expect(withVoiceEntry({ transcribe: [{ type: "builtin", id: "whisper-cpp" }] }, "ggml-base.bin", "MIT")).toEqual({
      transcribe: [{ type: "builtin", id: "whisper-cpp", model: { path: "ggml-base.bin", licence: "MIT" } }],
    });
    const own = { type: "builtin", id: "whisper-cpp", model: { path: "/models/ggml-large.bin", licence: "MIT" } };
    expect(withVoiceEntry({ transcribe: [own] }, "ggml-base.bin", "MIT")).toEqual({ transcribe: [own] });
    expect(withVoiceEntry(undefined, "ggml-base.bin", "MIT")).toEqual({
      transcribe: [{ type: "builtin", id: "whisper-cpp", model: { path: "ggml-base.bin", licence: "MIT" } }],
    });
  });
});

describe("createVoiceSetup", () => {
  const base = (dataDirectory: string, overrides: Partial<VoiceSetupOptions> = {}): VoiceSetupOptions => ({
    dataDirectory,
    platform: "darwin",
    ffmpegFound: () => false,
    whisperFound: async () => false,
    transcriberReady: () => false,
    reload: async () => undefined,
    brew: () => "/opt/homebrew/bin/brew",
    runBrew: async () => ({ code: 0, output: "" }),
    fetch: answering(BODY),
    model: MODEL,
    ...overrides,
  });

  it("names what is missing, the commands that add it by hand, and whether it can add it itself", async () => {
    const data = directories.create("tavi-voice-");
    const status = await createVoiceSetup(base(data)).status();
    expect(status).toMatchObject({ supported: true, ready: false, ffmpeg: false, whisper: false, model: false, automatic: true });
    expect(status.missing).toEqual(["FFmpeg", "whisper.cpp", "a speech model"]);
    expect(status.commands).toEqual(voiceSetupCommands("darwin", join(data, "video", "models"), MODEL));
    expect(status.commands[0]).toBe("brew install whisper-cpp ffmpeg");
    // No Homebrew: the commands, never a job that cannot run.
    expect((await createVoiceSetup(base(data, { brew: () => undefined })).status()).automatic).toBe(false);
    expect((await createVoiceSetup(base(data, { platform: "win32" })).status()).supported).toBe(false);
  });

  it("installs the missing tools with Homebrew, keeps the pinned model, names it in analyzers.json and reloads", async () => {
    const data = directories.create("tavi-voice-");
    let installed = false;
    let configured = false;
    const ran: (readonly string[])[] = [];
    const reload = vi.fn(async () => {
      configured = true;
    });
    const setup = createVoiceSetup(
      base(data, {
        ffmpegFound: () => installed,
        whisperFound: async () => installed,
        transcriberReady: () => configured,
        reload,
        runBrew: async (_brew, args) => {
          ran.push(args);
          installed = true;
          return { code: 0, output: "" };
        },
      }),
    );
    expect((await setup.start()).job).toMatchObject({ state: "running" });
    const done = await settled(setup);
    expect(done).toMatchObject({ ready: true, missing: [], job: { state: "done" } });
    // A fixed argument list, the formulae missing and nothing else.
    expect(ran).toEqual([["install", "whisper-cpp", "ffmpeg"]]);
    expect(readFileSync(join(data, "video", "models", MODEL.file))).toEqual(Buffer.from(BODY));
    expect(JSON.parse(readFileSync(analyzerConfigPath(data), "utf8"))).toEqual({
      transcribe: [{ type: "builtin", id: "whisper-cpp", model: { path: MODEL.file, licence: "MIT" } }],
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps no model whose checksum differs, and says so", async () => {
    const data = directories.create("tavi-voice-");
    const tampered = new Uint8Array(BODY);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const setup = createVoiceSetup(base(data, { ffmpegFound: () => true, whisperFound: async () => true, fetch: answering(tampered) }));
    await setup.start();
    const failed = await settled(setup);
    expect(failed.job).toMatchObject({ state: "failed", phase: "download" });
    expect(failed.job?.message).toMatch(/not the one expected/);
    expect(existsSync(join(data, "video", "models", MODEL.file))).toBe(false);
    expect(existsSync(join(data, "video", "models", `${MODEL.file}.download`))).toBe(false);
    expect(existsSync(analyzerConfigPath(data))).toBe(false);
  });

  it("never overwrites an analyzers.json it cannot read, and says what to fix", async () => {
    const data = directories.create("tavi-voice-");
    mkdirSync(join(data, "video"), { recursive: true });
    writeFileSync(analyzerConfigPath(data), "{ not json");
    const setup = createVoiceSetup(base(data, { ffmpegFound: () => true, whisperFound: async () => true }));
    const before = await setup.status();
    expect(before.automatic).toBe(false);
    expect(before.missing).toContain(`${analyzerConfigPath(data)} is not JSON`);
    await setup.start();
    const failed = await settled(setup);
    expect(failed.job).toMatchObject({ state: "failed", phase: "configure" });
    expect(readFileSync(analyzerConfigPath(data), "utf8")).toBe("{ not json");
  });

  it("says Homebrew's failure, and installs nothing else after it", async () => {
    const data = directories.create("tavi-voice-");
    const fetch = answering(BODY);
    const setup = createVoiceSetup(base(data, { runBrew: async () => ({ code: 1, output: "Error: no bottle" }), fetch }));
    await setup.start();
    const failed = await settled(setup);
    expect(failed.job).toMatchObject({ state: "failed", phase: "install" });
    expect(failed.job?.message).toMatch(/Homebrew could not install whisper-cpp and ffmpeg/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
