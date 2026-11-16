import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import type { SkeletonId } from "@tavi/contracts";

import { fail, JOINT_COUNTS, runPose, type OrtLike } from "./run.js";

/**
 * The pose add-on's child: run by
 * the owner as a command analyser, in its own confined process: inside the
 * denied home and data directory it reads only the run, this package, its
 * runtime, Node's own install and the person's model. Arguments:
 * `<framesDir> <outDir> <options> --model <path> [--detector <path>]
 * --skeleton <id> --pose-size <w>x<h> --detector-size <n> [--ort <module>]`.
 * Its answer is `<outDir>/result.json`; every failure is said there by kind.
 */

const [framesDir, outDir, , ...flags] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = flags.indexOf(`--${name}`);
  return index < 0 ? undefined : flags[index + 1];
};

/** A bare module name as it is; a path as a file URL (`import()` reads `C:\\…` as a URL scheme). */
const moduleSpecifier = (module: string): string => (isAbsolute(module) ? pathToFileURL(module).href : module);

async function main(): Promise<void> {
  if (framesDir === undefined || outDir === undefined) throw new Error("usage: child <framesDir> <outDir> <options> --model <path> …");
  const model = flag("model");
  const skeleton = flag("skeleton") ?? "coco17";
  const [width, height] = (flag("pose-size") ?? "192x256").split("x").map(Number);
  const detectorSize = Number(flag("detector-size") ?? "320");
  if (
    model === undefined ||
    !Object.hasOwn(JOINT_COUNTS, skeleton) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(detectorSize)
  ) {
    fail(outDir, "bad-input", "the pose child was started without its model, skeleton or sizes");
    return;
  }
  let ort: OrtLike;
  try {
    ort = (await import(moduleSpecifier(flag("ort") ?? "onnxruntime-node"))) as OrtLike;
  } catch {
    fail(outDir, "unavailable", "onnxruntime-node is not installed beside @tavi/video-pose");
    return;
  }
  const detector = flag("detector");
  await runPose(
    {
      framesDir,
      outDir,
      model,
      ...(detector === undefined ? {} : { detector }),
      skeleton: skeleton as SkeletonId,
      poseSize: [width as number, height as number],
      detectorSize,
    },
    ort,
  );
}

main().catch((error: unknown) => {
  if (outDir !== undefined) fail(outDir, "internal", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
