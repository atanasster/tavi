import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SKELETONS } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";

import { cropPerson, decodeSimcc, letterbox, peopleIn, subjectBox } from "../src/geometry.js";
import { onnxRuntimeDirectories, POSE_ANALYZER_ID, poseAnalyzerEntry, poseModelsDirectory } from "../src/index.js";
import { JOINT_COUNTS, runPose, type OrtLike } from "../src/run.js";

/** The pose add-on: its image arithmetic, its run on a stand-in runtime, and the person's model kept to its directory. */

const temp = temporaryDirectories({ prefix: "tavi-video-pose-" });
afterEach(() => temp.cleanup());
const fakeOrt = fileURLToPath(new URL("./fixtures/fake-ort.mjs", import.meta.url));

describe("the pose add-on's image arithmetic", () => {
  it("keeps each skeleton's keypoint count as contracts has it", () => {
    for (const [skeleton, count] of Object.entries(JOINT_COUNTS))
      expect(count, skeleton).toBe(SKELETONS[skeleton as keyof typeof SKELETONS].length);
  });

  it("crops a person 25% larger at the model's aspect, and maps a SimCC peak back to the frame", () => {
    const rgb = new Uint8Array(100 * 80 * 3).fill(200);
    const crop = cropPerson(rgb, 100, 80, [40, 20, 20, 40], 192, 256);
    // 20 × 40 grown 25% to 25 × 50, widened to 3:4: 37.5 × 50, centred on (50, 40).
    expect(crop).toMatchObject({ x: 50 - 37.5 / 2, y: 15, width: 37.5, height: 50 });
    expect(crop.tensor.length).toBe(3 * 192 * 256);
    // Inside the frame, 200 normalised; the red channel's (200 − 123.675) / 58.395.
    expect(crop.tensor[0]).toBeCloseTo((200 - 123.675) / 58.395, 4);
    // The peak at the crop's middle bins is the crop's centre.
    const joints = 2;
    const x = new Float32Array(joints * 384);
    const y = new Float32Array(joints * 512);
    for (let joint = 0; joint < joints; joint += 1) {
      x[joint * 384 + 192] = 0.8;
      y[joint * 512 + 256] = 0.6;
    }
    expect(decodeSimcc(x, y, joints, crop, 192, 256)).toEqual([
      [50, 40, 0.6],
      [50, 40, 0.6],
    ]);
    expect(() => decodeSimcc(x, y, 3, crop, 192, 256)).toThrow(RangeError);
  });

  it("letterboxes for the detector and maps its people back, persons only, best first, within the frame", () => {
    // A frame of pure red: the detector reads it as BGR, normalised as RTMDet was trained.
    const red = new Uint8Array(640 * 360 * 3);
    for (let index = 0; index < red.length; index += 3) red[index] = 255;
    const boxed = letterbox(red, 640, 360, 320);
    expect(boxed.scale).toBe(2);
    const plane = 320 * 320;
    // Inside the frame: blue first (0), red last (255).
    expect(boxed.tensor[0]).toBeCloseTo((0 - 103.53) / 57.375, 4);
    expect(boxed.tensor[2 * plane]).toBeCloseTo((255 - 123.675) / 58.395, 4);
    // Below the frame in the square: the grey pad, normalised.
    expect(boxed.tensor[319 * 320]).toBeCloseTo((114 - 103.53) / 57.375, 4);
    const people = peopleIn([10, 10, 50, 100, 0.9, 0, 0, 5, 5, 0.95, 100, 50, 400, 300, 0.2, 60, 20, 90, 150, 0.5], [0, 1n, 0, 0], 2, {
      width: 640,
      height: 360,
    });
    expect(people).toEqual([
      { box: [20, 20, 80, 180], score: 0.9 },
      { box: [120, 40, 60, 260], score: 0.5 },
    ]);
  });

  it("follows the subject: the largest, most central first, then whoever overlaps it, else where it was", () => {
    const frame = { width: 640, height: 480 };
    const centre = { box: [250, 100, 140, 300] as const };
    const corner = { box: [0, 0, 60, 80] as const };
    expect(subjectBox([corner, centre], undefined, frame)).toBe(centre.box);
    const moved = { box: [260, 110, 140, 300] as const };
    expect(subjectBox([corner, moved], centre.box, frame)).toBe(moved.box);
    expect(subjectBox([corner], centre.box, frame)).toBe(centre.box);
    expect(subjectBox([], undefined, frame)).toBeUndefined();
  });
});

describe("a pose run on a stand-in runtime", () => {
  function frames(root: string, count: number): string {
    const directory = join(root, "frames");
    mkdirSync(directory);
    const index = Array.from({ length: count }, (_, frame) => {
      writeFileSync(join(directory, `frame-${String(frame).padStart(4, "0")}.rgb`), new Uint8Array(64 * 48 * 3));
      return { file: `frame-${String(frame).padStart(4, "0")}.rgb`, timeSec: frame / 10, width: 64, height: 48, format: "rgb24" };
    });
    writeFileSync(join(directory, "frames.json"), JSON.stringify({ frames: index }));
    return directory;
  }
  const ort = async (): Promise<OrtLike> => (await import(fakeOrt)) as OrtLike;

  it("finds the subject's keypoints in each frame, counts the others without measuring them, and answers a pose track", async () => {
    const root = temp.create();
    const out = join(root, "out");
    mkdirSync(out);
    writeFileSync(join(root, "pose.onnx"), JSON.stringify({ kind: "pose", joints: 17, x: 192, y: 256 }));
    writeFileSync(
      join(root, "det.onnx"),
      JSON.stringify({
        kind: "detector",
        dets: [
          [100, 40, 180, 230, 0.9],
          [0, 0, 20, 30, 0.8],
        ],
      }),
    );
    await runPose(
      {
        framesDir: frames(root, 3),
        outDir: out,
        model: join(root, "pose.onnx"),
        detector: join(root, "det.onnx"),
        skeleton: "coco17",
        poseSize: [192, 256],
        detectorSize: 320,
      },
      await ort(),
    );
    const answer = JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as {
      readonly result: {
        readonly skeleton: string;
        readonly frames: readonly {
          readonly timeSec: number;
          readonly people: readonly { readonly bbox: readonly number[]; readonly keypoints: readonly (readonly number[])[] }[];
        }[];
      };
      readonly model: string;
    };
    expect(answer.model).toBe("pose.onnx");
    expect(answer.result.skeleton).toBe("coco17");
    expect(answer.result.frames.map((frame) => frame.timeSec)).toEqual([0, 0.1, 0.2]);
    const [subject, other] = answer.result.frames[0]?.people ?? [];
    expect(subject?.keypoints).toHaveLength(17);
    expect(subject?.keypoints[0]?.[2]).toBe(0.9);
    // Letterboxed 64 × 48 into 320: a scale of 0.2, so the box is 20, 8, 16, 38 in the frame.
    expect(subject?.bbox).toEqual([20, 8, 16, 38]);
    expect(other?.keypoints.every((point) => point[2] === 0)).toBe(true);
  });

  it("says a model that will not load, one that answers another skeleton, and frames that are not their size", async () => {
    const root = temp.create();
    const out = join(root, "out");
    mkdirSync(out);
    const directory = frames(root, 1);
    writeFileSync(join(root, "broken.onnx"), "not json");
    await runPose(
      { framesDir: directory, outDir: out, model: join(root, "broken.onnx"), skeleton: "coco17", poseSize: [192, 256], detectorSize: 320 },
      await ort(),
    );
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({ error: { code: "model-load" } });
    writeFileSync(join(root, "halpe.onnx"), JSON.stringify({ kind: "pose", joints: 26, x: 1, y: 1 }));
    await runPose(
      { framesDir: directory, outDir: out, model: join(root, "halpe.onnx"), skeleton: "coco17", poseSize: [192, 256], detectorSize: 320 },
      await ort(),
    );
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({
      error: { code: "model-load", message: expect.stringContaining("17 coco17") },
    });
    // A model made for another input size: said as the model's, so the chain tries the next analyser.
    writeFileSync(join(root, "wide.onnx"), JSON.stringify({ kind: "pose", joints: 17, x: 1, y: 1, width: 288 }));
    await runPose(
      { framesDir: directory, outDir: out, model: join(root, "wide.onnx"), skeleton: "coco17", poseSize: [192, 256], detectorSize: 320 },
      await ort(),
    );
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({
      error: { code: "model-load", message: expect.stringContaining("192×256") },
    });
    writeFileSync(join(directory, "frame-0000.rgb"), new Uint8Array(10));
    writeFileSync(join(root, "pose.onnx"), JSON.stringify({ kind: "pose", joints: 17, x: 1, y: 1 }));
    await runPose(
      { framesDir: directory, outDir: out, model: join(root, "pose.onnx"), skeleton: "coco17", poseSize: [192, 256], detectorSize: 320 },
      await ort(),
    );
    expect(JSON.parse(readFileSync(join(out, "result.json"), "utf8"))).toMatchObject({ error: { code: "bad-input" } });
  });
});

describe("the person's model", () => {
  it("is named from the models directory only, every link followed, and runs the built child with it", () => {
    const data = temp.create();
    const models = poseModelsDirectory(data);
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, "rtmpose-s.onnx"), "{}");
    const outside = join(data, "elsewhere.onnx");
    writeFileSync(outside, "{}");
    symlinkSync(outside, join(models, "linked.onnx"));
    const made = poseAnalyzerEntry({ path: "rtmpose-s.onnx", licence: "Apache-2.0" }, { dataDirectory: data, ort: fakeOrt });
    if (!("entry" in made)) throw new Error(made.missing);
    expect(made.entry.manifest).toMatchObject({
      id: POSE_ANALYZER_ID,
      local: true,
      attribution: { licence: "Apache-2.0" },
      capabilities: [{ capability: "pose", skeleton: "coco17" }],
    });
    expect(made.entry.args).toEqual(expect.arrayContaining(["{{framesDir}}", "{{outDir}}", "{{options}}", "--model", "--ort", fakeOrt]));
    expect(made.entry.args[0]).toMatch(/dist[/\\]child\.mjs$/);
    expect(poseAnalyzerEntry({ path: outside, licence: "MIT" }, { dataDirectory: data, ort: fakeOrt })).toMatchObject({
      missing: expect.stringContaining("outside"),
    });
    expect(poseAnalyzerEntry({ path: "linked.onnx", licence: "MIT" }, { dataDirectory: data, ort: fakeOrt })).toMatchObject({
      missing: expect.stringContaining("outside"),
    });
    expect(poseAnalyzerEntry({ path: "../../elsewhere.onnx", licence: "MIT" }, { dataDirectory: data, ort: fakeOrt })).toMatchObject({
      missing: expect.stringContaining("outside"),
    });
    expect(poseAnalyzerEntry(undefined, { dataDirectory: data })).toMatchObject({
      missing: expect.stringContaining("ships no pose weights"),
    });
  });
});

describe("the runtime the child reads", () => {
  it("is onnxruntime-node with pnpm's links beside it, and the onnxruntime-common it imports, though common exports no package.json", () => {
    // pnpm's layout: each package in a store folder of its own, its dependencies linked beside it.
    const top = temp.create();
    const store = join(top, "node_modules", ".pnpm");
    const ort = join(store, "onnxruntime-node@1", "node_modules", "onnxruntime-node");
    const common = join(store, "onnxruntime-common@1", "node_modules", "onnxruntime-common");
    for (const [directory, name, exports] of [
      [ort, "onnxruntime-node", undefined],
      [common, "onnxruntime-common", { require: "./dist/index.js", import: "./dist/index.js" }],
    ] as const) {
      mkdirSync(join(directory, "dist"), { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name, main: "./dist/index.js", exports }));
      writeFileSync(join(directory, "dist", "index.js"), "");
    }
    // As the real one has: a package.json of its own type inside it, which is not the package's.
    writeFileSync(join(common, "dist", "package.json"), JSON.stringify({ type: "commonjs" }));
    symlinkSync(common, join(store, "onnxruntime-node@1", "node_modules", "onnxruntime-common"));
    symlinkSync(ort, join(top, "node_modules", "onnxruntime-node"));
    const from = join(top, "package.json");
    writeFileSync(from, "{}");
    const real = (path: string) => realpathSync(path);
    expect(onnxRuntimeDirectories(from)).toEqual([real(join(store, "onnxruntime-node@1", "node_modules")), real(common)]);
  });
});
