import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AnalyzerEntry, AnalyzerManifest, SkeletonId } from "@tavi/contracts";

/**
 * `@tavi/video-pose`: the built-in pose analyser, RTMPose (with an optional detector) on
 * `onnxruntime-node`, run as a command analyser in a confined child of its
 * own: inside the denied home and data directory it reads only the run, this
 * package, its runtime, Node's own install and the model, and it writes only
 * in the run, with no network. Tavi ships no weights: none of the candidates' terms passed the
 * licence allowlist, so the person names their own ONNX
 * model in `analyzers.json`, with the licence they hold. It must live in
 * `<data>/video/models`, and Tavi never copies or redistributes it.
 *
 * The owner imports this module only in `apps/cli/src/features/video/host.ts`, and
 * only when it is installed.
 */

export const POSE_ANALYZER_ID = "builtin.rtmpose";
/** RTMPose-s's input, width × height. */
export const POSE_INPUT = [192, 256] as const;
/** RTMDet-nano's square input. */
export const DETECTOR_INPUT = 320;

/** The person's model, as `analyzers.json` names it (`{ type: "builtin", id: "rtmpose", model }`). */
export interface PoseModel {
  readonly path: string;
  readonly detectorPath?: string | undefined;
  readonly skeleton?: SkeletonId | undefined;
  readonly licence: string;
}

export type CommandEntry = Extract<AnalyzerEntry, { readonly type: "command" }>;

export interface PoseEntryOptions {
  /** The owner's data directory: models live in its `video/models`. */
  readonly dataDirectory: string;
  /** The Node that runs the child (the owner's own, by default). */
  readonly node?: string;
  /** A module standing in for onnxruntime-node (tests). */
  readonly ort?: string;
}

/** Where the person puts pose models: the one directory a model may be read from. */
export function poseModelsDirectory(dataDirectory: string): string {
  return join(dataDirectory, "video", "models");
}

const packageRoot = (): string => {
  // `src/index.ts` in development, `dist/index.mjs` built: the package is the directory above either.
  return dirname(dirname(fileURLToPath(import.meta.url)));
};

/**
 * Where onnxruntime-node is installed beside this package, with the
 * `onnxruntime-common` it imports (a package of its own, installed beside
 * it): the child reads both; under pnpm, the store folder where Node finds
 * `common` through a link beside onnxruntime-node. `common` exports no
 * `package.json`, so it is found from its entry. Undefined when
 * onnxruntime-node is not installed. `from` is where it is looked for from
 * (this module; tests give their own layout).
 */
export function onnxRuntimeDirectories(from: string = import.meta.url): readonly string[] | undefined {
  let node: string;
  try {
    node = realpathSync(dirname(createRequire(from).resolve("onnxruntime-node/package.json")));
  } catch {
    return undefined;
  }
  let common: string | undefined;
  try {
    for (let directory = dirname(realpathSync(createRequire(join(node, "package.json")).resolve("onnxruntime-common"))); ; ) {
      // Its own package.json, not a `{ "type": … }` one inside it (`dist/cjs`).
      if (packageName(join(directory, "package.json")) === "onnxruntime-common") {
        common = directory;
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    common = undefined;
  }
  if (common === undefined || common.startsWith(node + sep)) return [node];
  // Under pnpm, Node reaches `common` through a link beside onnxruntime-node: the folder of those links is read too (a
  // link itself cannot be: the sandbox's paths are resolved), and it holds onnxruntime-node's dependencies only.
  const link = join(dirname(node), "onnxruntime-common");
  return existsSync(link) && lstatSync(link).isSymbolicLink() ? [dirname(node), common] : [node, common];
}

/** The `name` in a package.json; undefined when there is none or it is unreadable. */
function packageName(file: string): string | undefined {
  try {
    const { name } = JSON.parse(readFileSync(file, "utf8")) as { readonly name?: unknown };
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** A model file the person named, inside the models directory after every link is followed, or why not. */
function modelFile(name: string, directory: string): { readonly path: string } | { readonly refused: string } {
  if (!existsSync(directory)) return { refused: `the models directory ${directory} does not exist` };
  const root = realpathSync(directory);
  const named = isAbsolute(name) ? name : resolve(directory, name);
  let real: string;
  try {
    real = realpathSync(named);
  } catch {
    return { refused: `${name} does not exist` };
  }
  if (!real.startsWith(root + sep)) return { refused: `${name} is outside ${directory}: a pose model is read from there only` };
  if (!lstatSync(real).isFile()) return { refused: `${name} is not a file` };
  return { path: real };
}

/**
 * The command analyser entry that runs the add-on's child on the person's
 * model, or why it cannot run: onnxruntime-node or the built child missing,
 * or a model outside the models directory.
 */
export function poseAnalyzerEntry(
  model: PoseModel | undefined,
  options: PoseEntryOptions,
): { readonly entry: CommandEntry } | { readonly missing: string } {
  if (model === undefined)
    return {
      missing: "Tavi ships no pose weights: name your own ONNX model (model.path, model.licence) in analyzers.json, in <data>/video/models",
    };
  // The model first: where it is wrong is the owner's to fix whatever else is missing.
  const directory = poseModelsDirectory(options.dataDirectory);
  const pose = modelFile(model.path, directory);
  if ("refused" in pose) return { missing: pose.refused };
  const detector = model.detectorPath === undefined ? undefined : modelFile(model.detectorPath, directory);
  if (detector !== undefined && "refused" in detector) return { missing: detector.refused };
  const runtime = options.ort === undefined ? onnxRuntimeDirectories() : undefined;
  if (options.ort === undefined && runtime === undefined)
    return { missing: "onnxruntime-node is not installed beside @tavi/video-pose (npm install onnxruntime-node where Tavi is installed)" };
  const child = join(packageRoot(), "dist", "child.mjs");
  if (!existsSync(child)) return { missing: "@tavi/video-pose is not built (its dist/child.mjs is missing)" };
  const skeleton = model.skeleton ?? "coco17";
  const node = options.node ?? process.execPath;
  const manifest: AnalyzerManifest = {
    id: POSE_ANALYZER_ID,
    version: "1",
    attribution: {
      name: `RTMPose on your model ${basename(pose.path)}`.slice(0, 100),
      url: "https://github.com/open-mmlab/mmpose",
      licence: model.licence,
    },
    capabilities: [{ capability: "pose", inputs: ["frames"], output: "PoseTrack@1", skeleton, maxFrames: 600 }],
    local: true,
    confined: true,
    models: [{ name: basename(pose.path).slice(0, 100), installed: true }],
  };
  const readRoots = [
    ...new Set([
      packageRoot(),
      dirname(pose.path),
      ...(detector === undefined ? [] : [dirname(detector.path)]),
      ...(runtime ?? []),
      // Node itself, wherever it is installed (often under home).
      dirname(dirname(realpathSync(node))),
      ...(options.ort === undefined ? [] : [dirname(options.ort)]),
    ]),
  ];
  return {
    entry: {
      type: "command",
      id: "rtmpose",
      command: node,
      args: [
        child,
        "{{framesDir}}",
        "{{outDir}}",
        "{{options}}",
        "--model",
        pose.path,
        ...(detector === undefined ? [] : ["--detector", detector.path]),
        "--skeleton",
        skeleton,
        "--pose-size",
        `${String(POSE_INPUT[0])}x${String(POSE_INPUT[1])}`,
        "--detector-size",
        String(DETECTOR_INPUT),
        ...(options.ort === undefined ? [] : ["--ort", options.ort]),
      ],
      manifest,
      readRoots: readRoots.slice(0, 8),
    },
  };
}

export { cropPerson, decodeSimcc, letterbox, peopleIn, subjectBox, POSE_MEAN, POSE_STD, type Box, type PoseCrop } from "./geometry.js";
export { runPose, JOINT_COUNTS, type OrtLike, type PoseRun, type SessionLike } from "./run.js";
