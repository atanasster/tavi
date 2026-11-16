import { describe, expect, it } from "vitest";

import type { AnalyzeOutcome, AnalyzeRequest, AnalyzerManifest, VideoAnalyzerPort, VideoCapability } from "@tavi/contracts";

import { createAnalyzerRegistry } from "../src/registry.js";

/** The analyser registry: fallback, parsing in the owner, and remote analysers held back. */

function manifest(id: string, overrides: Partial<AnalyzerManifest> = {}): AnalyzerManifest {
  return {
    id,
    version: "1",
    attribution: { name: id, licence: "MIT" },
    capabilities: [
      { capability: "transcribe", inputs: ["audio"], output: "Transcript@1" },
      { capability: "ocr", inputs: ["frames"], output: "FrameText@1", maxFrames: 4 },
    ],
    local: true,
    confined: true,
    models: [],
    ...overrides,
  };
}

const transcript = { language: "en", segments: [{ startSec: 0, endSec: 1, text: "hello" }] };

function analyzer(
  id: string,
  answer: () => AnalyzeOutcome<unknown> | Promise<AnalyzeOutcome<unknown>>,
  overrides: Partial<AnalyzerManifest> = {},
): VideoAnalyzerPort & { readonly calls: number[]; closed: boolean } {
  const calls: number[] = [];
  const port = {
    calls,
    closed: false,
    manifest: () => manifest(id, overrides),
    analyze: async () => {
      calls.push(1);
      return (await answer()) as never;
    },
    close: async () => {
      port.closed = true;
    },
  };
  return port;
}

const ok = (result: unknown = transcript): AnalyzeOutcome<unknown> => ({ ok: true, result, model: "m", wallMs: 1 });
const fail = (code: "timeout" | "protocol" | "unsupported" | "memory"): AnalyzeOutcome<unknown> => ({
  ok: false,
  error: { code, retryable: code === "timeout" || code === "memory", message: code },
});

/** A request carrying audio, unless it carries frames instead. */
function request<C extends VideoCapability>(capability: C, extra: Partial<AnalyzeRequest<C>> = {}): AnalyzeRequest<C> {
  return {
    capability,
    ...(extra.frames === undefined ? { audio: { path: "/run/audio.wav", seconds: 5 } } : {}),
    runDirectory: "/run",
    options: {} as AnalyzeRequest<C>["options"],
    limits: { timeoutMs: 1_000, maxOutputBytes: 10_000 },
    signal: new AbortController().signal,
    ...extra,
  };
}

describe("the analyser registry", () => {
  it("falls back on a transient failure and names who answered and who was tried", async () => {
    const slow = analyzer("slow", () => fail("timeout"));
    const big = analyzer("big", () => fail("memory"));
    const good = analyzer("good", () => ok());
    const outcome = await createAnalyzerRegistry({ transcribe: [slow, big, good] }).analyze(request("transcribe"));
    expect(outcome).toMatchObject({ ok: true, result: transcript, analyzer: "good", tried: ["slow", "big", "good"] });
  });

  it("stops on a contract error, an answer outside its schema or its size, a thrown error, or another skeleton", async () => {
    const after = analyzer("after", () => ok());
    for (const [first, code] of [
      [analyzer("strict", () => fail("protocol")), "protocol"],
      [analyzer("refuses", () => fail("unsupported")), "unsupported"],
      [analyzer("wrong", () => ok({ language: "english", segments: [] })), "protocol"],
      [
        analyzer("huge", () =>
          ok({
            language: "en",
            segments: Array.from({ length: 400 }, (_, index) => ({ startSec: index, endSec: index + 1, text: "x".repeat(100) })),
          }),
        ),
        "protocol",
      ],
      [
        analyzer("throws", () => {
          throw new Error("boom");
        }),
        "internal",
      ],
    ] as const) {
      const outcome = await createAnalyzerRegistry({ transcribe: [first, after] }).analyze(request("transcribe"));
      expect(outcome, first.manifest().id).toMatchObject({ ok: false, error: { code }, tried: [first.manifest().id] });
    }
    expect(after.calls).toEqual([]);
    const pose = analyzer("pose", () => ok({ skeleton: "mp33", coordSpace: "pixels", frames: [] }), {
      capabilities: [{ capability: "pose", inputs: ["frames"], output: "PoseTrack@1", skeleton: "coco17" }],
    });
    const frames = [{ timeSec: 0, path: "/run/f.rgb", width: 4, height: 4, format: "rgb24" as const }];
    expect(await createAnalyzerRegistry({ pose: [pose] }).analyze(request("pose", { frames }))).toMatchObject({
      ok: false,
      error: { code: "protocol", message: expect.stringContaining("skeleton") },
    });
  });

  it("skips one that does not take what the call carries or as much of it, without asking it", async () => {
    const audioOnly = analyzer("audio-only", () => ok());
    const reader = analyzer("reader", () => ok({ frames: [{ timeSec: 0, text: "EXIT", confidence: 90 }] }), {
      capabilities: [{ capability: "ocr", inputs: ["frames"], output: "FrameText@1" }],
    });
    const frames = Array.from({ length: 6 }, (_, index) => ({
      timeSec: index,
      path: `/run/${String(index)}.png`,
      width: 4,
      height: 4,
      format: "png" as const,
    }));
    // audio-only's OCR takes at most 4 frames: too large, so the next one is asked.
    const outcome = await createAnalyzerRegistry({ ocr: [audioOnly, reader] }).analyze(request("ocr", { frames }));
    expect(outcome).toMatchObject({ ok: true, analyzer: "reader", tried: ["reader"] });
    expect(audioOnly.calls).toEqual([]);
    expect(await createAnalyzerRegistry({}).analyze(request("pose"))).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
      tried: [],
    });
    expect(await createAnalyzerRegistry({ transcribe: [audioOnly] }).analyze(request("describe"))).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("reaches a remote analyser only for a call allowed to send the video off the machine, and puts a local one first unattended", async () => {
    const remote = analyzer("remote", () => ok(), { local: false });
    const local = analyzer("local", () => ok());
    const registry = createAnalyzerRegistry({ transcribe: [remote, local] });
    expect(registry.first({ capability: "transcribe", audioSec: 5 })?.manifest().id).toBe("remote");
    expect(registry.first({ capability: "transcribe", audioSec: 5 }, { unattended: true })?.manifest().id).toBe("local");
    // Not assessed external: the remote one is passed over, never asked.
    expect(await registry.analyze(request("transcribe"))).toMatchObject({ ok: true, analyzer: "local", tried: ["local"] });
    expect(remote.calls).toEqual([]);
    expect(await registry.analyze(request("transcribe"), { remote: "remote" })).toMatchObject({ ok: true, analyzer: "remote" });
    // Unattended, the local one is asked first even though the remote one leads the chain.
    expect(await registry.analyze(request("transcribe"), { unattended: true, remote: "remote" })).toMatchObject({
      ok: true,
      analyzer: "local",
      tried: ["local"],
    });
    // A local analyser that fails transiently does not fall back to a remote one on a call not allowed it.
    const flaky = analyzer("flaky", () => fail("timeout"));
    const held = createAnalyzerRegistry({ transcribe: [flaky, analyzer("far", () => ok(), { local: false })] });
    expect(await held.analyze(request("transcribe"))).toMatchObject({ ok: false, error: { code: "timeout" }, tried: ["flaky"] });
    expect(
      await createAnalyzerRegistry({ transcribe: [analyzer("only-remote", () => ok(), { local: false })] }).analyze(request("transcribe")),
    ).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("remote") }, tried: [] });
  });

  it("never falls back from the remote analyser a call was approved for to another remote one", async () => {
    const approved = analyzer("approved", () => fail("timeout"), { local: false });
    const other = analyzer("other", () => ok(), { local: false });
    const outcome = await createAnalyzerRegistry({ transcribe: [approved, other] }).analyze(request("transcribe"), { remote: "approved" });
    expect(outcome).toMatchObject({ ok: false, error: { code: "timeout" }, tried: ["approved"] });
    expect(other.calls).toEqual([]);
  });

  it("chooses first the analyser that takes what the call carries, so the card names the one that will be asked", () => {
    // The local one takes at most 4 frames: a 6-frame call goes to the remote one, and is asked about it.
    const small = analyzer("small", () => ok());
    const far = analyzer("far", () => ok(), {
      local: false,
      capabilities: [{ capability: "ocr", inputs: ["frames"], output: "FrameText@1" }],
    });
    const registry = createAnalyzerRegistry({ ocr: [small, far] });
    expect(registry.first({ capability: "ocr", frames: 6 })?.manifest().id).toBe("far");
    expect(registry.first({ capability: "ocr", frames: 3 })?.manifest().id).toBe("small");
    // Audio past an analyser's most, and audio to one that reads frames only, are passed over too.
    const short = analyzer("short", () => ok(), {
      capabilities: [{ capability: "transcribe", inputs: ["audio"], output: "Transcript@1", maxAudioSec: 60 }],
    });
    expect(createAnalyzerRegistry({ transcribe: [short] }).first({ capability: "transcribe", audioSec: 120 })).toBeUndefined();
    expect(createAnalyzerRegistry({ ocr: [far] }).first({ capability: "ocr", audioSec: 5 })).toBeUndefined();
  });

  it("stops on a bad-input answer, and asks nobody once the call is stopped", async () => {
    const after = analyzer("after", () => ok());
    const picky = analyzer("picky", () => ({ ok: false, error: { code: "bad-input", retryable: false, message: "no speech track" } }));
    expect(await createAnalyzerRegistry({ transcribe: [picky, after] }).analyze(request("transcribe"))).toMatchObject({
      ok: false,
      error: { code: "bad-input" },
      tried: ["picky"],
    });
    const stopped = new AbortController();
    stopped.abort();
    expect(await createAnalyzerRegistry({ transcribe: [after] }).analyze(request("transcribe", { signal: stopped.signal }))).toMatchObject({
      ok: false,
      error: { code: "timeout" },
      tried: [],
    });
    expect(after.calls).toEqual([]);
  });

  it("lists each chain for doctor and closes every analyser once, all of them even when one fails", async () => {
    let closes = 0;
    const shared = {
      ...analyzer("shared", () => ok()),
      close: async () => {
        closes += 1;
      },
    };
    const broken = {
      ...analyzer("broken", () => ok()),
      close: async () => {
        throw new Error("stuck");
      },
    };
    let lateClosed = false;
    const late = {
      ...analyzer("late", () => ok()),
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        lateClosed = true;
      },
    };
    const registry = createAnalyzerRegistry({ transcribe: [shared, broken], ocr: [shared, late] });
    expect(registry.chains()).toEqual({ transcribe: [shared.manifest(), broken.manifest()], ocr: [shared.manifest(), late.manifest()] });
    await expect(registry.close()).rejects.toThrow("stuck");
    expect(closes).toBe(1);
    expect(lateClosed).toBe(true);
  });
});
