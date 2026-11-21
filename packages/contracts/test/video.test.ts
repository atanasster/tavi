import { describe, expect, it } from "vitest";

import {
  ANALYZER_FALLBACK_ERRORS,
  AnalyzerConfigSchema,
  AnalyzerEntrySchema,
  AnalyzerManifestSchema,
  CAPABILITY_OUTPUT,
  gifFrameCount,
  gifIsAnimated,
  gifShape,
  AUDIO_CONTAINERS,
  AUDIO_MEDIA_TYPES,
  sniffAudioContainer,
  sniffVideoContainer,
  MOVEMENT_TEMPLATES,
  PoseTrackSchema,
  SKELETONS,
  TranscriptSchema,
  VIDEO_CONTAINERS,
  VIDEO_MEDIA_TYPES,
  VideoFramesInputSchema,
  VideoPoseInputSchema,
  VideoSourceSchema,
  VideoTranscribeInputSchema,
} from "../src/index.js";

const manifest = {
  id: "cmd.mediapipe",
  version: "1",
  attribution: { name: "MediaPipe", licence: "Apache-2.0" },
  capabilities: [{ capability: "pose", inputs: ["frames"], output: "PoseTrack@1", skeleton: "mp33" }],
  local: true,
  confined: true,
  models: [],
} as const;

describe("video contracts", () => {
  it("maps every skeleton's keypoints, in its own order, onto Tavi's joint names", () => {
    expect(SKELETONS.coco17).toHaveLength(17);
    expect(SKELETONS.halpe26).toHaveLength(26);
    expect(SKELETONS.body25).toHaveLength(25);
    expect(SKELETONS.mp33).toHaveLength(33);
    for (const [id, joints] of Object.entries(SKELETONS)) {
      const named = joints.filter((joint) => joint !== null);
      // No joint twice: a name maps to one index.
      expect(new Set(named).size, id).toBe(named.length);
      // Angles and overlays need these in every skeleton.
      for (const side of ["left", "right"])
        for (const part of ["shoulder", "hip", "knee", "ankle"]) expect(named, id).toContain(`${side}_${part}`);
    }
    // Heels and toes, for knee-over-toe, only where the skeleton has them.
    expect(SKELETONS.coco17).not.toContain("left_heel");
    for (const id of ["halpe26", "body25", "mp33"] as const) expect(SKELETONS[id]).toContain("left_big_toe");
    // Index order, spot-checked against each source's own table: a swapped side would pass every check above.
    expect(SKELETONS.coco17[5]).toBe("left_shoulder");
    expect(SKELETONS.coco17[12]).toBe("right_hip");
    expect(SKELETONS.halpe26[18]).toBe("neck");
    expect(SKELETONS.halpe26[24]).toBe("left_heel");
    expect(SKELETONS.body25[2]).toBe("right_shoulder");
    expect(SKELETONS.body25[8]).toBe("mid_hip");
    expect(SKELETONS.body25[19]).toBe("left_big_toe");
    expect(SKELETONS.body25[24]).toBe("right_heel");
    expect(SKELETONS.mp33[11]).toBe("left_shoulder");
    expect(SKELETONS.mp33[23]).toBe("left_hip");
    expect(SKELETONS.mp33[31]).toBe("left_big_toe");
  });

  it("holds a pose track to its skeleton's keypoint count", () => {
    const person = (count: number) => ({ bbox: [0, 0, 10, 20], score: 0.9, keypoints: Array.from({ length: count }, () => [1, 2, 0.8]) });
    expect(
      PoseTrackSchema.safeParse({ skeleton: "coco17", coordSpace: "pixels", frames: [{ timeSec: 0, people: [person(17)] }] }).success,
    ).toBe(true);
    expect(
      PoseTrackSchema.safeParse({ skeleton: "coco17", coordSpace: "pixels", frames: [{ timeSec: 0, people: [person(33)] }] }).success,
    ).toBe(false);
    // A field outside the schema (an identity, say) is refused, not passed on.
    expect(
      PoseTrackSchema.safeParse({
        skeleton: "mp33",
        coordSpace: "pixels",
        frames: [{ timeSec: 0, people: [{ ...person(33), name: "someone" }] }],
      }).success,
    ).toBe(false);
  });

  it("validates an analyser's manifest and the owner's ordered configuration", () => {
    expect(AnalyzerManifestSchema.parse(manifest).id).toBe("cmd.mediapipe");
    expect(AnalyzerManifestSchema.safeParse({ ...manifest, id: "Has Spaces" }).success).toBe(false);
    expect(AnalyzerConfigSchema.parse({})).toEqual({
      pose: [{ type: "builtin", id: "rtmpose" }],
      transcribe: [{ type: "builtin", id: "whisper-cpp" }],
      ocr: [{ type: "builtin", id: "pdf-ocr" }],
    });
    const command = AnalyzerEntrySchema.parse({
      type: "command",
      id: "mediapipe",
      command: "/usr/bin/python3",
      args: ["pose.py", "{{framesDir}}", "{{outDir}}"],
      manifest,
      readRoots: ["/opt/pose"],
    });
    expect(command.type).toBe("command");
    expect(AnalyzerEntrySchema.safeParse({ type: "builtin", id: "something-else" }).success).toBe(false);
    // A capability answers its own result type, and `describe` is not built.
    expect(
      AnalyzerManifestSchema.safeParse({ ...manifest, capabilities: [{ capability: "pose", inputs: ["frames"], output: "Transcript@1" }] })
        .success,
    ).toBe(false);
    expect(
      AnalyzerManifestSchema.safeParse({
        ...manifest,
        capabilities: [{ capability: "describe", inputs: ["frames"], output: "FrameText@1" }],
      }).success,
    ).toBe(false);
    // A command that reaches the network cannot call itself local.
    expect(
      AnalyzerEntrySchema.safeParse({
        type: "command",
        id: "remote",
        command: "/usr/bin/curl",
        args: [],
        manifest,
        readRoots: [],
        domains: ["api.example.com"],
      }).success,
    ).toBe(false);
    expect(
      AnalyzerEntrySchema.safeParse({
        type: "command",
        id: "remote",
        command: "/usr/bin/curl",
        args: [],
        manifest: { ...manifest, local: false },
        readRoots: [],
        domains: ["api.example.com"],
      }).success,
    ).toBe(true);
    expect(CAPABILITY_OUTPUT.pose).toBe("PoseTrack@1");
    // Contract errors stop the chain; only transient ones fall back.
    expect(ANALYZER_FALLBACK_ERRORS).not.toContain("protocol");
    expect(ANALYZER_FALLBACK_ERRORS).toContain("timeout");
  });

  it("tells a voice note's audio from a video by its bytes, and only the audio sniff takes it", () => {
    const bytes = (...parts: readonly (string | readonly number[])[]) =>
      Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...new TextEncoder().encode(part)] : [...part])));
    expect(sniffAudioContainer(bytes("OggS", [0, 2]))).toBe("ogg");
    expect(sniffAudioContainer(bytes("ID3", [4, 0]))).toBe("mp3");
    expect(sniffAudioContainer(bytes([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");
    expect(sniffAudioContainer(bytes("RIFF", [0, 0, 0, 0], "WAVE"))).toBe("wav");
    expect(sniffAudioContainer(bytes([0, 0, 0, 24], "ftypM4A "))).toBe("m4a");
    // A video, a JPEG and text are no audio; a voice note is no video.
    expect(sniffAudioContainer(bytes([0, 0, 0, 24], "ftypisom"))).toBeUndefined();
    expect(sniffAudioContainer(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBeUndefined();
    expect(sniffAudioContainer(bytes("plain words"))).toBeUndefined();
    expect(sniffVideoContainer(bytes("OggS", [0, 2]))).toBeUndefined();
    for (const container of AUDIO_CONTAINERS) expect(AUDIO_MEDIA_TYPES[container]).toMatch(/^audio\//);
  });

  it("gives each container its media type and each tool its defaults", () => {
    for (const container of VIDEO_CONTAINERS) expect(VIDEO_MEDIA_TYPES[container]).toMatch(/^(video|image)\//);
    expect(VideoFramesInputSchema.parse({ source: { artifactId: "art-1" } })).toEqual({
      source: { artifactId: "art-1" },
      mode: "uniform",
      count: 6,
      layout: "sheet",
      ocr: false,
    });
    expect(VideoPoseInputSchema.parse({ source: { path: "clip.mov" } })).toMatchObject({ movement: "generic", side: "auto", fps: 10 });
    expect(VideoSourceSchema.safeParse({ artifactId: "a", path: "b" }).success).toBe(false);
    // Whisper's three-letter codes are languages too.
    expect(VideoTranscribeInputSchema.safeParse({ source: { artifactId: "a" }, language: "yue" }).success).toBe(true);
    expect(TranscriptSchema.safeParse({ language: "haw", segments: [] }).success).toBe(true);
  });

  it("counts a GIF's images by its blocks, without decoding it", () => {
    const header = [...new TextEncoder().encode("GIF89a"), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
    const control = [0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00];
    const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00];
    expect(gifFrameCount(new Uint8Array([...header, ...control, ...frame, 0x3b]))).toBe(1);
    expect(gifFrameCount(new Uint8Array([...header, ...control, ...frame, ...control, ...frame, ...control, ...frame, 0x3b]), 5)).toBe(3);
    // It stops counting at `stopAt`: an animation is told from a still by its second image.
    expect(gifFrameCount(new Uint8Array([...header, ...frame, ...frame, ...frame, 0x3b]))).toBe(2);
    expect(gifFrameCount(new TextEncoder().encode("not a gif"))).toBeUndefined();
    expect(gifFrameCount(new Uint8Array([...header, 0x99]))).toBeUndefined();
    // A truncated image is not a guess.
    expect(gifFrameCount(new Uint8Array([...header, 0x2c, 0, 0]))).toBeUndefined();
    // A local colour table, LZW data over two sub-blocks, a looping application extension.
    const local = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80, 1, 2, 3, 4, 5, 6, 0x02, 0x01, 0x44, 0x01, 0x01, 0x00];
    const loop = [0x21, 0xff, 0x0b, ...new TextEncoder().encode("NETSCAPE2.0"), 0x03, 0x01, 0x00, 0x00, 0x00];
    expect(gifShape(new Uint8Array([...header, ...loop, ...local, ...local, 0x3b]), 10)).toEqual({ images: 2, timed: true });
    // A sub-block whose size points past the end.
    expect(gifFrameCount(new Uint8Array([...header, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x7f, 0x44]))).toBeUndefined();
    // Animated: two images and a delay or a loop. A still tiled from two images with no delay is not.
    expect(gifIsAnimated(new Uint8Array([...header, ...control, ...frame, ...control, ...frame, 0x3b]))).toBe(true);
    expect(gifIsAnimated(new Uint8Array([...header, ...frame, ...frame, 0x3b]))).toBe(false);
    expect(gifIsAnimated(new Uint8Array([...header, ...control, ...frame, 0x3b]))).toBe(false);
  });

  it("keeps every template's faults on its own measures, and none validated before its recordings", () => {
    for (const template of Object.values(MOVEMENT_TEMPLATES)) {
      const ids = template.measures.map((measure) => measure.id);
      expect(new Set(ids).size, template.id).toBe(ids.length);
      for (const fault of template.faults) {
        expect(ids, `${template.id}: ${fault.id}`).toContain(fault.measure);
        expect(fault.below !== undefined || fault.above !== undefined, fault.id).toBe(true);
      }
      expect(template.validated, template.id).toBe(false);
    }
  });
});

describe("the video capability tokens", () => {
  it("lets each writer replace only the tokens it owns", async () => {
    const { withOwnedCapabilities, readsVideo } = await import("../src/models-config.js");
    // Discovery owns `video`: a catalog that drops it clears it, and keeps a test's and a probe's.
    expect(withOwnedCapabilities(["chat", "tools", "video", "video-probed"], ["video"], [])).toEqual(["chat", "tools", "video-probed"]);
    // A test owns chat, streaming and tools: it keeps the catalog's and the probe's.
    expect(withOwnedCapabilities(["video", "video-probed", "tools"], ["chat", "streaming", "tools"], ["chat", "streaming"])).toEqual([
      "video",
      "video-probed",
      "chat",
      "streaming",
    ]);
    expect(withOwnedCapabilities([], ["video"], ["video", "stray"])).toEqual(["video"]);
    expect(readsVideo(["video-probed"])).toBe(true);
    expect(readsVideo(["chat"])).toBe(false);
  });
});
