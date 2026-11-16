// A stand-in for onnxruntime-node, for the pose add-on's tests: a "model" whose file says what it answers.
// A pose model's file holds JSON `{ "kind": "pose", "joints": n, "x": bin, "y": bin, "width"?: w }`: every joint's SimCC peak at
// those bins (score 0.9). A detector's holds `{ "kind": "detector", "dets": [[x1, y1, x2, y2, score], …] }`, in its
// letterboxed input, every one a person. Any other file fails to load, as a broken model does.
import { readFileSync } from "node:fs";

export class Tensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

export const InferenceSession = {
  async create(path) {
    const model = JSON.parse(readFileSync(path, "utf8"));
    if (model.kind === "pose") {
      return {
        inputNames: ["input"],
        outputNames: ["simcc_x", "simcc_y"],
        async run(feeds) {
          const [, , height, width] = feeds.input.dims;
          // A model made for another input size refuses this one, as a real session does.
          if (model.width !== undefined && model.width !== width) throw new Error(`expected width ${model.width}, got ${width}`);
          const binsX = width * 2;
          const binsY = height * 2;
          const x = new Float32Array(model.joints * binsX);
          const y = new Float32Array(model.joints * binsY);
          for (let joint = 0; joint < model.joints; joint += 1) {
            x[joint * binsX + model.x] = 0.9;
            y[joint * binsY + model.y] = 0.9;
          }
          return { simcc_x: new Tensor("float32", x, [1, model.joints, binsX]), simcc_y: new Tensor("float32", y, [1, model.joints, binsY]) };
        },
      };
    }
    if (model.kind === "detector") {
      return {
        inputNames: ["input"],
        outputNames: ["dets", "labels"],
        async run() {
          return { dets: new Tensor("float32", Float32Array.from(model.dets.flat()), [1, model.dets.length, 5]), labels: { data: BigInt64Array.from(model.dets.map(() => 0n)), dims: [1, model.dets.length] } };
        },
      };
    }
    throw new Error("not a model");
  },
};
