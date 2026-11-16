import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AnalyzerEntry, AnalyzerManifest } from "@tavi/contracts";

/**
 * `@tavi/video-transcribe`: local transcription, the person's own whisper.cpp CLI on
 * their own ggml model, run as a command analyser in a confined child of its
 * own. Tavi ships neither, so the person installs whisper.cpp
 * (`brew install whisper-cpp`, or a build of their own) and puts a model in
 * `<data>/video/models`, naming it in `analyzers.json` with its licence.
 *
 * The owner imports this module only in `apps/cli/src/features/video/host.ts`, and
 * only when it is installed.
 */

export const TRANSCRIBE_ANALYZER_ID = "builtin.whisper-cpp";

/** The whisper.cpp CLI's names, newest first: `whisper-cli` since 1.7, `whisper-cpp` in Homebrew's older builds. */
export const WHISPER_NAMES = ["whisper-cli", "whisper-cpp"] as const;
/** Where it is looked for besides `PATH`. */
export const WHISPER_PREFIXES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] as const;

export interface TranscribeModel {
  readonly path: string;
  readonly licence: string;
}

export type CommandEntry = Extract<AnalyzerEntry, { readonly type: "command" }>;

export interface TranscribeEntryOptions {
  readonly dataDirectory: string;
  /** The whisper.cpp CLI, when not on `PATH` or the usual prefixes. */
  readonly whisper?: string;
  readonly node?: string;
  /** Where to look, for tests. */
  readonly path?: string;
  /**
   * What whisper.cpp must read inside the denied roots: its library closure, as the host computes it for FFmpeg
   * (`libraryRoots`). Absent, its install prefix, unless that is home or above it.
   */
  readonly libraryRoots?: (binary: string) => readonly string[];
}

/** Where the person puts models: the one directory a model may be read from (as the pose add-on's). */
export function transcribeModelsDirectory(dataDirectory: string): string {
  return join(dataDirectory, "video", "models");
}

const packageRoot = (): string => dirname(dirname(fileURLToPath(import.meta.url)));

const isExecutable = (path: string): boolean => {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/** The whisper.cpp CLI: the one named, else the first on `PATH` or a usual prefix; undefined when there is none. */
export function findWhisper(options: Pick<TranscribeEntryOptions, "whisper" | "path"> = {}): string | undefined {
  if (options.whisper !== undefined)
    return isAbsolute(options.whisper) && isExecutable(options.whisper) ? realpathSync(options.whisper) : undefined;
  const directories = [
    ...(options.path ?? process.env["PATH"] ?? "").split(delimiter).filter((entry) => isAbsolute(entry)),
    ...WHISPER_PREFIXES,
  ];
  for (const directory of directories) {
    for (const name of WHISPER_NAMES) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return realpathSync(candidate);
    }
  }
  return undefined;
}

/** A model file the person named, inside the models directory after every link is followed, or why not. */
function modelFile(name: string, directory: string): { readonly path: string } | { readonly refused: string } {
  if (!existsSync(directory)) return { refused: `the models directory ${directory} does not exist` };
  const root = realpathSync(directory);
  let real: string;
  try {
    real = realpathSync(isAbsolute(name) ? name : resolve(directory, name));
  } catch {
    return { refused: `${name} does not exist` };
  }
  if (!real.startsWith(root + sep)) return { refused: `${name} is outside ${directory}: a transcription model is read from there only` };
  if (!lstatSync(real).isFile()) return { refused: `${name} is not a file` };
  return { path: real };
}

/** What whisper.cpp needs to read: the host's closure for it, or its prefix where that is not home or above it. */
function whisperRoots(whisper: string, options: TranscribeEntryOptions): readonly string[] {
  if (options.libraryRoots !== undefined) return options.libraryRoots(whisper);
  const prefix = dirname(dirname(whisper));
  const home = homedir();
  return prefix === home || home.startsWith(prefix + sep) || prefix === sep ? [] : [prefix];
}

/**
 * The command analyser entry that runs the add-on's child on the person's
 * whisper.cpp and model, or why it cannot run.
 */
export function transcribeAnalyzerEntry(
  model: TranscribeModel | undefined,
  options: TranscribeEntryOptions,
): { readonly entry: CommandEntry } | { readonly missing: string } {
  if (model === undefined)
    return {
      missing:
        "Tavi ships no transcription model: name your own ggml model (model.path, model.licence) in analyzers.json, in <data>/video/models",
    };
  const file = modelFile(model.path, transcribeModelsDirectory(options.dataDirectory));
  if ("refused" in file) return { missing: file.refused };
  const whisper = findWhisper(options);
  if (whisper === undefined) return { missing: "whisper.cpp is not installed (brew install whisper-cpp, or a build of your own on PATH)" };
  const child = join(packageRoot(), "dist", "child.mjs");
  if (!existsSync(child)) return { missing: "@tavi/video-transcribe is not built (its dist/child.mjs is missing)" };
  const node = options.node ?? process.execPath;
  const manifest: AnalyzerManifest = {
    id: TRANSCRIBE_ANALYZER_ID,
    version: "1",
    attribution: {
      name: `whisper.cpp on your model ${basename(file.path)}`.slice(0, 100),
      url: "https://github.com/ggml-org/whisper.cpp",
      licence: model.licence,
    },
    capabilities: [{ capability: "transcribe", inputs: ["audio"], output: "Transcript@1", maxAudioSec: 600 }],
    local: true,
    confined: true,
    models: [{ name: basename(file.path).slice(0, 100), installed: true }],
  };
  return {
    entry: {
      type: "command",
      id: "whisper-cpp",
      command: node,
      args: [child, "{{audio}}", "{{outDir}}", "{{options}}", "--model", file.path, "--whisper", whisper],
      manifest,
      // Its package, the model's directory, whisper.cpp's libraries, and Node's install; never home itself.
      readRoots: [
        ...new Set([packageRoot(), dirname(file.path), ...whisperRoots(whisper, options), dirname(dirname(realpathSync(node)))]),
      ].slice(0, 8),
    },
  };
}

export { MAX_SEGMENTS, runTranscribe, transcriptOf, type Exec, type TranscribeRun } from "./run.js";
