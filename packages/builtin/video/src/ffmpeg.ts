import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";

import {
  VIDEO_DECODER_FEATURES,
  VIDEO_DECODERS,
  type VideoDecoderFacts,
  type VideoDecoderFeature,
  type VideoDecoderName,
} from "@tavi/contracts";

/**
 * The person's own FFmpeg: found from `serve --video-ffmpeg`/`--video-ffprobe`, else
 * `PATH`, else the usual install prefixes; its build read once into
 * `VideoDecoderFacts`. Tavi ships none.
 */

/** The prefixes looked in after `PATH`, in order. */
export const FFMPEG_PREFIXES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] as const;

/**
 * The oldest releases of each maintained branch that carry the latest
 * security fixes at this writing: older is a `doctor` warning, never a
 * refusal, since distributions backport fixes.
 */
export const FFMPEG_SECURE_RELEASES: readonly (readonly [number, number, number])[] = [
  [8, 1, 3],
  [9, 0, 2],
];

export interface FfmpegPaths {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export interface FindFfmpegOptions {
  /** The owner's `serve --video-ffmpeg` / `--video-ffprobe`. */
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  /** `PATH`, by default the process's. */
  readonly path?: string;
  readonly exists?: (path: string) => boolean;
}

/** Each binary, by the owner's path, `PATH`, or a known prefix; `missing` names what was not found and how to install it. */
export function findFfmpeg(options: FindFfmpegOptions = {}): FfmpegPaths | { readonly missing: string } {
  const exists = options.exists ?? existsSync;
  const directories = [
    ...(options.path ?? process.env["PATH"] ?? "").split(delimiter).filter((entry) => isAbsolute(entry)),
    ...FFMPEG_PREFIXES,
  ];
  const find = (name: string, given: string | undefined): string | undefined => {
    // Absolute only: a run starts in its own directory, so a relative path would name another file there.
    if (given !== undefined) return isAbsolute(given) && exists(given) ? given : undefined;
    for (const directory of directories) {
      const candidate = join(directory, name);
      if (exists(candidate)) return candidate;
    }
    return undefined;
  };
  const ffmpeg = find("ffmpeg", options.ffmpeg);
  const ffprobe = find("ffprobe", options.ffprobe);
  if (ffmpeg !== undefined && ffprobe !== undefined) return { ffmpeg, ffprobe };
  const absent = [
    ffmpeg === undefined ? (options.ffmpeg ?? "ffmpeg") : undefined,
    ffprobe === undefined ? (options.ffprobe ?? "ffprobe") : undefined,
  ].filter((name) => name !== undefined);
  return {
    missing: `${absent.join(" and ")} not found: install FFmpeg (brew install ffmpeg, or apt install ffmpeg), or name it with serve --video-ffmpeg and --video-ffprobe`,
  };
}

/** `ffmpeg version 9.0.2 Copyright…` (or `n9.0.2-…`, a Git build's): the version, or the whole token when it is not numeric. */
export function parseVersion(versionOutput: string): string {
  const token = /^ff(?:mpeg|probe) version (\S+)/m.exec(versionOutput)?.[1];
  return token ?? "unknown";
}

function numericVersion(version: string): readonly [number, number, number] | undefined {
  const match = /^n?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/**
 * Whether `version` is below the latest security release: on a listed
 * branch, below its release; on any other branch, older than the newest
 * listed one (unmaintained). A Git build's version is not judged.
 */
export function belowSecureRelease(version: string): boolean {
  const parts = numericVersion(version);
  if (parts === undefined) return false;
  const compare = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const branch = FFMPEG_SECURE_RELEASES.find((release) => release[0] === parts[0] && release[1] === parts[1]);
  if (branch !== undefined) return compare(parts, branch) < 0;
  return compare(parts, FFMPEG_SECURE_RELEASES[FFMPEG_SECURE_RELEASES.length - 1] as readonly [number, number, number]) < 0;
}

/** The names in an `ffmpeg -decoders`, `-encoders` or `-filters` listing: the second column of each entry, after the legend's dashed rule. */
export function listedNames(listing: string): ReadonlySet<string> {
  const names = new Set<string>();
  let started = false;
  for (const line of listing.split("\n")) {
    if (!started) {
      started = /^\s*-{3,}\s*$/.test(line);
      continue;
    }
    const match = /^\s*[A-Z.|]{2,}\s+(\S+)\s/.exec(line);
    if (match !== null) names.add(match[1] as string);
  }
  return names;
}

/** Which of the decoders Tavi needs a build has. */
function decodersOf(decoders: ReadonlySet<string>): readonly VideoDecoderName[] {
  // FFmpeg's own `av1` decoder needs hardware support: only libdav1d or libaom decode AV1 in software.
  return VIDEO_DECODERS.filter((name) => (name === "av1" ? decoders.has("libdav1d") || decoders.has("libaom-av1") : decoders.has(name)));
}

/** Which optional features a build has, from its filters and encoders. */
function featuresOf(filters: ReadonlySet<string>, encoders: ReadonlySet<string>): readonly VideoDecoderFeature[] {
  const has: Record<VideoDecoderFeature, boolean> = {
    scdet: filters.has("scdet"),
    tile: filters.has("tile"),
    drawtext: filters.has("drawtext"),
    "h264-encoder": encoders.has("libx264"),
    "mpeg4-encoder": encoders.has("mpeg4"),
    "audio-extract": encoders.has("pcm_s16le"),
  };
  return VIDEO_DECODER_FEATURES.filter((feature) => has[feature]);
}

/** A build's facts, from its `-version`, `-decoders`, `-filters` and `-encoders` output. */
export function decoderFacts(outputs: {
  readonly version: string;
  readonly decoders: string;
  readonly filters: string;
  readonly encoders: string;
}): VideoDecoderFacts {
  const version = parseVersion(outputs.version);
  const decoders = decodersOf(listedNames(outputs.decoders));
  const features = featuresOf(listedNames(outputs.filters), listedNames(outputs.encoders));
  const warnings: string[] = [];
  if (belowSecureRelease(version))
    warnings.push(
      `FFmpeg ${version} is older than the latest security releases (${FFMPEG_SECURE_RELEASES.map((release) => release.join(".")).join(", ")}); your distribution may have backported the fixes`,
    );
  for (const needed of ["h264", "hevc", "vp9", "gif"] as const)
    if (!decoders.includes(needed)) warnings.push(`this FFmpeg has no ${needed} decoder: such videos cannot be read`);
  if (!features.includes("scdet")) warnings.push("this FFmpeg has no scdet filter: scene and motion frames are unavailable");
  if (!features.includes("tile")) warnings.push("this FFmpeg has no tile filter: contact sheets are unavailable");
  if (!features.includes("drawtext"))
    warnings.push("this FFmpeg has no drawtext filter (no FreeType): contact sheets are unlabelled, their times listed instead");
  return { kind: "ffmpeg", version, decoders, features, warnings };
}

/**
 * The directories a confined run must read for `binary` to start, when its
 * real path lies under a read-denied root (`~/.local`, Linuxbrew, Nix under
 * home): its own install directory, and its libraries' (from
 * `listLibraries`: `otool -L` or `ldd`). A Homebrew build's keg is not
 * enough: `libavcodec` and its codecs load from the prefix's `opt/*` and
 * `Cellar/*`, so the whole prefix's `Cellar`, `opt` and `lib`
 * are reopened. Outside every denied root, nothing is needed.
 */
export function libraryRoots(
  binary: string,
  deniedRoots: readonly string[],
  listLibraries: (binary: string) => readonly string[],
  realpath: (path: string) => string = realpathSync,
): readonly string[] {
  const under = (path: string): boolean => deniedRoots.some((root) => path === root || path.startsWith(`${root}${sep}`));
  // A reopened root must sit strictly inside a denied one: never home itself or its parent.
  const inside = (path: string): boolean =>
    deniedRoots.some((root) => path.startsWith(`${root}${sep}`)) &&
    !deniedRoots.some((root) => root === path || root.startsWith(`${path}${sep}`));
  /** The widest of `candidates` that is safely inside a denied root; the file itself when none is. */
  const narrowest = (path: string, candidates: readonly string[]): readonly string[] => {
    for (const candidate of candidates) if (inside(candidate)) return [candidate];
    return [path];
  };
  let real: string;
  try {
    real = realpath(binary);
  } catch {
    return [];
  }
  const roots = new Set<string>();
  const add = (path: string): void => {
    if (!under(path)) return;
    const cellar = path.indexOf(`${sep}Cellar${sep}`);
    if (cellar >= 0 && inside(join(path.slice(0, cellar), "Cellar"))) {
      const prefix = path.slice(0, cellar);
      for (const part of ["Cellar", "opt", "lib"]) roots.add(join(prefix, part));
    } else for (const root of narrowest(path, [dirname(dirname(path)), dirname(path)])) roots.add(root);
  };
  add(real);
  for (const library of listLibraries(real)) {
    try {
      add(realpath(library));
    } catch {
      add(library);
    }
  }
  // A root inside another adds nothing.
  const all = [...roots];
  return all.filter((root) => !all.some((other) => other !== root && root.startsWith(`${other}${sep}`))).sort();
}

/** The library paths in `otool -L` (macOS) or `ldd` (Linux) output. */
export function parseLibraryListing(output: string): readonly string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    // otool: "\t/opt/homebrew/opt/x264/lib/libx264.164.dylib (compatibility …)"; ldd: "\tlibx.so.1 => /lib/libx.so.1 (0x…)".
    const match = /(?:=>\s*)?(\/[^\s(]+)\s*\(/.exec(line.trim());
    if (match !== null) paths.push(match[1] as string);
  }
  return paths;
}

/** The libraries a binary loads, by `otool -L` (macOS) or `ldd` (Linux): what a confined run must still read. None when neither answers. */
export function listBinaryLibraries(binary: string): readonly string[] {
  try {
    const output =
      process.platform === "darwin"
        ? execFileSync("/usr/bin/otool", ["-L", binary], { encoding: "utf8", timeout: 10_000 })
        : execFileSync("ldd", [binary], { encoding: "utf8", timeout: 10_000 });
    return parseLibraryListing(output);
  } catch {
    return [];
  }
}
