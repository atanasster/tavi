import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { findFfmpeg } from "@tavi/plugin-video";
import { ModelConfigService } from "@tavi/runtime";
import { temporaryDirectories, fakeFetch, partialFake } from "@tavi/test-support";
import { sse, textChunk } from "@tavi/test-support/openai-stub";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { probeClipFrames, probeCode, probeVideoAndRecord, readsProbeCode, VIDEO_PROBE_CLIP } from "../../src/features/models/actions.js";
import { probeVideoDecoder } from "../../src/features/video/host.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * `tavi models probe --video`:
 * the endpoint here decodes the clip it is sent with the installed FFmpeg and
 * reads its seven-segment digits, so the test checks the clip itself, not a
 * stand-in for it.
 */

const found = findFfmpeg();
const roots = temporaryDirectories();
afterAll(() => roots.cleanup());

const SEGMENT_CENTRES: Readonly<Record<string, readonly [number, number]>> = {
  a: [160, 40],
  b: [200, 80],
  c: [200, 160],
  d: [160, 200],
  e: [120, 160],
  f: [120, 80],
  g: [160, 120],
};
const DIGITS: Readonly<Record<string, string>> = {
  abcdef: "0",
  bc: "1",
  abdeg: "2",
  abcdg: "3",
  bcfg: "4",
  acdfg: "5",
  acdefg: "6",
  abc: "7",
  abcdefg: "8",
  abcdfg: "9",
};

/** The digits a frame shows: which segments are lit, read at their centres. */
function readDigit(frame: Buffer): string {
  const lit = Object.entries(SEGMENT_CENTRES)
    .filter(([, [x, y]]) => (frame[(y * VIDEO_PROBE_CLIP.width + x) * 3] ?? 0) > 128)
    .map(([name]) => name)
    .sort()
    .join("");
  return DIGITS[lit] ?? "?";
}

/** The clip's digits, one a second, decoded by FFmpeg from the data URL a request carries. */
function digitsOf(body: string, root: string): string | undefined {
  const encoded = /"video_url":\{"url":"data:video\/mp4;base64,([^"]+)"/.exec(body)?.[1];
  if (encoded === undefined) return undefined;
  const clip = join(root, `sent-${String(Date.now())}.mp4`);
  writeFileSync(clip, Buffer.from(encoded, "base64"));
  const decoded = spawnSync(
    (found as { readonly ffmpeg: string }).ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      clip,
      "-vf",
      "select='eq(mod(n\\,4)\\,2)'",
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const size = VIDEO_PROBE_CLIP.width * VIDEO_PROBE_CLIP.height * 3;
  return Array.from({ length: Math.floor(decoded.stdout.length / size) }, (_, index) =>
    readDigit(decoded.stdout.subarray(index * size, (index + 1) * size)),
  ).join("");
}

const streamed = (text: string): Response =>
  new Response(sse([textChunk(text, "stop")]), { status: 200, headers: { "content-type": "text/event-stream" } });

describe("the video probe's clip", () => {
  it("draws each digit as seven-segment blocks, a second each", () => {
    const frames = probeClipFrames("1234");
    expect(frames).toHaveLength(16);
    expect(frames.every((frame) => frame.length === 320 * 240 * 3)).toBe(true);
    expect(readDigit(Buffer.from(frames[0] as Uint8Array))).toBe("1");
    expect(readDigit(Buffer.from(frames[15] as Uint8Array))).toBe("4");
  });
});

describe("the probe's code and its reading", () => {
  it("never holds a digit twice in a row, and reads a reply's digits with runs counted once", () => {
    for (let index = 0; index < 500; index += 1) expect(probeCode()).toMatch(/^(?!.*(\d)\1)\d{4}$/);
    expect(readsProbeCode("The digits are 1, 2, 3, 4.", "1234")).toBe(true);
    expect(readsProbeCode("4-second clip: 1234", "1234")).toBe(true);
    expect(readsProbeCode("1 1 1 1 2 2 2 2 3 3 3 3 4 4 4 4", "1234")).toBe(true);
    expect(readsProbeCode("4321", "1234")).toBe(false);
    expect(readsProbeCode("123", "1234")).toBe(false);
  });

  it("is named on the command line: one of --pdf or --video", async () => {
    const io = { stdout: () => undefined, stderr: () => undefined, isTty: false };
    expect(await main(["models", "probe", "vllm", "--pdf", "--video"], { io })).toBe(EXIT.usage);
    expect(await main(["models", "probe", "vllm"], { io })).toBe(EXIT.usage);
  });
});

describe.skipIf("missing" in found)("tavi models probe --video", () => {
  let root = "";
  let models: ModelConfigService;
  beforeEach(async () => {
    root = roots.create("tavi-video-probe-");
    const store = await SqliteStore.open({ databasePath: join(root, "tavi.sqlite"), artifactsDirectory: join(root, "artifacts") });
    models = new ModelConfigService(store.asPort());
    await models.putConnection({
      connectionId: "vllm",
      label: "vLLM",
      baseUrl: "http://127.0.0.1:9/v1",
      credentialRef: "vllm.key",
      defaultModel: "qwen3-vl",
    });
  });
  const probe = async (answer: (digits: string | undefined) => Response | string) => {
    const decoder = await probeVideoDecoder(root);
    try {
      return await probeVideoAndRecord(models, "vllm", undefined, async () => "key", {
        decoder,
        workDirectory: join(root, "video"),
        fetch: fakeFetch(async (_url, init) => {
          const reply = answer(digitsOf(String(init?.body), root));
          return typeof reply === "string" ? streamed(reply) : reply;
        }),
      });
    } finally {
      await decoder.close();
    }
  };
  const token = async (): Promise<boolean> =>
    (await models.listCatalog("vllm")).find((entry) => entry.modelId === "qwen3-vl")?.capabilities.includes("video-probed") === true;

  it("passes when the model reads the four digits back in order, and the row says video-probed", async () => {
    let seen: string | undefined;
    const result = await probe((digits) => ((seen = digits), `The digits are ${(digits ?? "").split("").join(", ")}.`));
    // The endpoint read four digits off the clip it was sent.
    expect(seen).toMatch(/^\d{4}$/);
    expect(result, JSON.stringify(result)).toMatchObject({ connectionId: "vllm", modelId: "qwen3-vl", ok: true, videoProbed: true });
    expect(await token()).toBe(true);
  }, 60_000);

  it("fails on one digit, the wrong order or an endpoint that ignores the clip, clearing the token; a fault worth a retry changes nothing", async () => {
    expect(await probe((digits) => (digits ?? "").slice(0, 1))).toMatchObject({ ok: false, videoProbed: false });
    await probe((digits) => digits ?? "");
    expect(await token()).toBe(true);
    expect(await probe((digits) => (digits ?? "").split("").reverse().join(""))).toMatchObject({ ok: false, videoProbed: false });
    await probe((digits) => digits ?? "");
    expect(await probe(() => "I see no video.")).toMatchObject({
      ok: false,
      videoProbed: false,
      message: expect.stringContaining("in order"),
    });
    await probe((digits) => digits ?? "");
    const busy = await probe(() => new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 }));
    expect(busy).toMatchObject({ ok: false, videoProbed: true });
    // An authentication failure says nothing about video either; an endpoint that refuses the request does.
    expect(await probe(() => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }))).toMatchObject({
      ok: false,
      videoProbed: true,
    });
    expect(
      await probe(() => new Response(JSON.stringify({ error: { message: "video_url is not supported" } }), { status: 400 })),
    ).toMatchObject({ ok: false, videoProbed: false });
  }, 120_000);

  it("records nothing for a connection edited while it was probed, and sends nothing without a credential", async () => {
    const result = await probe((digits) => {
      // The owner edits the connection while the model answers.
      void models.putConnection({
        connectionId: "vllm",
        label: "Renamed",
        baseUrl: "http://127.0.0.1:9/v1",
        credentialRef: "vllm.key",
        defaultModel: "qwen3-vl",
      });
      return digits ?? "";
    });
    expect(result).toMatchObject({ ok: false, videoProbed: false, message: expect.stringContaining("changed while it was probed") });
    const decoder = await probeVideoDecoder(root);
    let sent = false;
    try {
      await expect(
        probeVideoAndRecord(models, "vllm", undefined, async () => null, {
          decoder,
          workDirectory: join(root, "video"),
          fetch: fakeFetch(async () => ((sent = true), streamed(""))),
        }),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    } finally {
      await decoder.close();
    }
    expect(sent).toBe(false);
  }, 60_000);

  it("is refused for an endpoint that takes no video, and for a provider-managed connection", async () => {
    await models.putConnection({
      connectionId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      credentialRef: "openai.key",
      defaultModel: "gpt-x",
    });
    const decoder = await probeVideoDecoder(root);
    try {
      await expect(
        probeVideoAndRecord(models, "openai", undefined, async () => "key", { decoder, workDirectory: join(root, "video") }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      const managed = {
        ...(await models.getConnection("vllm")),
        providerBinding: { instanceId: "i", workspaceId: "w", principalId: "p", bindingHash: "h" },
      };
      const fake = partialFake<ModelConfigService>({ getConnection: async () => managed });
      await expect(
        probeVideoAndRecord(fake, "vllm", undefined, async () => "key", { decoder, workDirectory: join(root, "video") }),
      ).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
    } finally {
      await decoder.close();
    }
  });
});
