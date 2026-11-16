import { describe, expect, it } from "vitest";

import {
  belowSecureRelease,
  decoderFacts,
  findFfmpeg,
  libraryRoots,
  listedNames,
  parseLibraryListing,
  parseVersion,
} from "../src/ffmpeg.js";

const DECODERS = `Decoders:
 V..... = Video
 A..... = Audio
 ------
 V....D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 V....D hevc                 HEVC (High Efficiency Video Coding)
 V....D vp9                  Google VP9
 V....D libdav1d             dav1d AV1 decoder by VideoLAN (codec av1)
 V....D gif                  GIF (Graphics Interchange Format)
`;
const FILTERS = `Filters:
  T.. = Timeline support
  | = Source or sink filter
  ------
 T. metadata          V->V       Manipulate video frame metadata.
 .. scdet             V->V       Detect video scene change
 .. tile              V->V       Tile several successive frames together.
`;
const ENCODERS = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V.S..D mpeg4                MPEG-4 part 2
 A....D pcm_s16le            PCM signed 16-bit little-endian
`;

describe("the person's FFmpeg", () => {
  it("is found by the owner's path, then PATH, then the usual prefixes", () => {
    const present = new Set(["/opt/tools/ffmpeg", "/opt/tools/ffprobe", "/usr/local/bin/ffmpeg", "/usr/local/bin/ffprobe"]);
    const exists = (path: string): boolean => present.has(path);
    expect(findFfmpeg({ ffmpeg: "/opt/tools/ffmpeg", ffprobe: "/opt/tools/ffprobe", path: "", exists })).toEqual({
      ffmpeg: "/opt/tools/ffmpeg",
      ffprobe: "/opt/tools/ffprobe",
    });
    expect(findFfmpeg({ path: "/nowhere:relative", exists })).toEqual({
      ffmpeg: "/usr/local/bin/ffmpeg",
      ffprobe: "/usr/local/bin/ffprobe",
    });
    const missing = findFfmpeg({ path: "", exists: () => false });
    expect(missing).toMatchObject({ missing: expect.stringContaining("brew install ffmpeg") });
    // A relative name would be another file in the run's own directory.
    expect(findFfmpeg({ ffmpeg: "bin/ffmpeg", ffprobe: "/opt/tools/ffprobe", path: "", exists: () => true })).toMatchObject({
      missing: expect.stringContaining("bin/ffmpeg"),
    });
    // A named binary that is not there is not replaced by another.
    expect(findFfmpeg({ ffmpeg: "/gone/ffmpeg", path: "", exists })).toMatchObject({ missing: expect.stringContaining("/gone/ffmpeg") });
  });

  it("reads its build: version, the decoders Tavi needs, and the features a build may lack", () => {
    expect(parseVersion("ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with clang")).toBe("9.0.2");
    expect(parseVersion("ffmpeg version n7.1-12-gabc Copyright")).toBe("n7.1-12-gabc");
    expect([...listedNames(DECODERS)]).toEqual(["h264", "hevc", "vp9", "libdav1d", "gif"]);
    const facts = decoderFacts({ version: "ffmpeg version 9.0.2 Copyright", decoders: DECODERS, filters: FILTERS, encoders: ENCODERS });
    expect(facts.decoders).toEqual(["h264", "hevc", "vp9", "av1", "gif"]);
    // FFmpeg's own av1 decoder needs hardware: without libdav1d (or libaom) AV1 is not listed.
    expect(
      decoderFacts({
        version: "ffmpeg version 9.0.2",
        decoders: DECODERS.replace("libdav1d ", "av1      "),
        filters: FILTERS,
        encoders: ENCODERS,
      }).decoders,
    ).not.toContain("av1");
    expect(facts.features).toEqual(["scdet", "tile", "h264-encoder", "mpeg4-encoder", "audio-extract"]);
    // Homebrew's build has no drawtext: a warning, and sheets go unlabelled.
    expect(facts.warnings.some((warning) => warning.includes("drawtext"))).toBe(true);
    expect(facts.warnings.some((warning) => warning.includes("security"))).toBe(false);
  });

  it("warns, never refuses, below the latest security releases", () => {
    expect(belowSecureRelease("9.0.2")).toBe(false);
    expect(belowSecureRelease("9.1")).toBe(false);
    expect(belowSecureRelease("9.0.1")).toBe(true);
    expect(belowSecureRelease("8.1.3")).toBe(false);
    expect(belowSecureRelease("8.1.2")).toBe(true);
    expect(belowSecureRelease("8.0.4")).toBe(true);
    expect(belowSecureRelease("6.1.1")).toBe(true);
    expect(belowSecureRelease("N-12345-gabc")).toBe(false);
    expect(
      decoderFacts({ version: "ffmpeg version 6.1.1", decoders: DECODERS, filters: FILTERS, encoders: ENCODERS }).warnings[0],
    ).toContain("older than the latest security releases");
  });

  it("reopens the library closure of a build under a denied root, the whole Homebrew prefix for a keg", () => {
    const home = "/home/me";
    const listing =
      "/home/me/.linuxbrew/Cellar/ffmpeg/9.0.2/bin/ffmpeg:\n\t/home/me/.linuxbrew/opt/libvpx/lib/libvpx.so.9 (compatibility version 9.0.0)\n\t/usr/lib/libc.so.6 (compatibility version 1.0.0)\n";
    const roots = libraryRoots(
      "/home/me/.linuxbrew/bin/ffmpeg",
      [home],
      () => parseLibraryListing(listing),
      (path) => path.replace("/home/me/.linuxbrew/bin/ffmpeg", "/home/me/.linuxbrew/Cellar/ffmpeg/9.0.2/bin/ffmpeg"),
    );
    expect(roots).toEqual(["/home/me/.linuxbrew/Cellar", "/home/me/.linuxbrew/lib", "/home/me/.linuxbrew/opt"]);
    // A static build under ~/.local: its own install directory.
    expect(
      libraryRoots(
        "/home/me/.local/bin/ffmpeg",
        [home],
        () => [],
        (path) => path,
      ),
    ).toEqual(["/home/me/.local"]);
    // Never home itself or its parent: ~/bin reopens ~/bin, and a binary straight in home only itself.
    expect(
      libraryRoots(
        "/home/me/bin/ffmpeg",
        [home],
        () => [],
        (path) => path,
      ),
    ).toEqual(["/home/me/bin"]);
    expect(
      libraryRoots(
        "/home/me/ffmpeg",
        [home],
        () => ["/home/me/lib/libx.so"],
        (path) => path,
      ),
    ).toEqual(["/home/me/ffmpeg", "/home/me/lib"]);
    for (const roots of [
      libraryRoots(
        "/home/me/ffmpeg",
        [home, "/home/me/data"],
        () => [],
        (path) => path,
      ),
    ])
      for (const root of roots) expect(["/home", "/home/me"]).not.toContain(root);
    // Outside every denied root, nothing needs reopening.
    expect(
      libraryRoots(
        "/usr/local/bin/ffmpeg",
        [home],
        () => ["/usr/local/opt/x264/lib/libx264.dylib"],
        (path) => path,
      ),
    ).toEqual([]);
    expect(parseLibraryListing("\tlibz.so.1 => /lib/x86_64-linux-gnu/libz.so.1 (0x00007f)\n\tlinux-vdso.so.1 (0x00007ffd)\n")).toEqual([
      "/lib/x86_64-linux-gnu/libz.so.1",
    ]);
  });
});
