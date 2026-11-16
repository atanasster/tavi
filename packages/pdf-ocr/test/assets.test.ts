import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { ocrAssets } from "../src/index.js";

/** The add-on's files are its whole surface: the OCR child loads them, with nothing fetched. */
describe("the OCR add-on", () => {
  it("ships Tesseract's LSTM build and the English model, which load from the files alone", async () => {
    const assets = ocrAssets();
    const factory = createRequire(import.meta.url)(assets.core) as (options: Record<string, unknown>) => Promise<{
      FS: { writeFile(path: string, data: Uint8Array): void };
      TessBaseAPI: new () => { Init(path: string, lang: string, oem: number): number; End(): void };
    }>;
    // The wasm is handed over (`wasmBinary`), as the OCR child hands it.
    const core = await factory({ wasmBinary: readFileSync(assets.wasm), locateFile: (name: string) => name });
    core.FS.writeFile("/eng.traineddata", gunzipSync(readFileSync(assets.languages.eng)));
    const api = new core.TessBaseAPI();
    // 1: the LSTM engine, the only one this build has.
    expect(api.Init("/", "eng", 1)).toBe(0);
    api.End();
  }, 30_000);

  it("ships the full licence of every library linked into its wasm, with where each came from", () => {
    // These texts are tesseract.js-core 7.0.0's: another version links other code, and must bring its own.
    const installed = createRequire(import.meta.url)("tesseract.js-core/package.json") as { readonly version: string };
    expect(installed.version).toBe("7.0.0");
    // Its third_party/ submodules, and the Emscripten runtime its build links.
    // Each text as it was fetched and read, by sha256: an edit, a cut or a re-fetch shows here.
    const pinned: Readonly<Record<string, string>> = {
      "compiler-rt": "aba7b478a9d93ec7bd2ea400e62c7bb4b1fd37593d1850e06f6735d874758d8f",
      emscripten: "d08b59893eec6156c41d145427a36c5fc4c9fe01dfae18b5bb76a59d6ee695a9",
      giflib: "5f0bb66e06b972ebe4257c8410bd85683f86c6c7a149d683c9978e8b080ed6fb",
      leptonica: "0653f1840cb310a9a6c66e03e20a35020d021f8a5c3e224ae28f6cedd11eed67",
      libcxx: "d53f3413a16193a90210769f25ee6c13089dfbb6594339cb798c6b46332cfaba",
      libcxxabi: "11c4b6fe60c6192a62d015dd3e0dc5acbc852fd03800bd4f12479f02ad73a1a5",
      libjpeg: "94aec3dc33057e10a14cf95831d97c8ea60c2ed388952e5a8561a6f7c05177de",
      libpng: "be5fb8bef48bc647f4677ffb85c0be1effb6481fbf8379f8083252257f500f97",
      libtiff: "0e545167d5d2a42cbeb1783a032a9f94dbd0164f6221329e99fef44890e50a83",
      libwebp: "3cb91c5402a2d2526d42dee56e602427a9eec0cccee3c9c99880baeae05f5ed1",
      musl: "e0c0029e86ae5b0d1b924759858bacab852b494f62a81cb7dd79a91410f5c927",
      openlibm: "5442961ce71d01f9e7023f8b0f06436be5a3fe9bd218c61ae709d3a9f83ee984",
      tesseract: "88dc9bc907964d44ffe0748e3c73e2c7ab57883fb17abe8479dc136f5807d7f9",
      zlib: "92df63626904f2fa013ef8a9785e151c3112d973ae40f740e7498c18807788a2",
    };
    const linked = Object.keys(pinned);
    const directory = join(import.meta.dirname, "..", "licenses");
    expect(readdirSync(directory).sort()).toEqual(linked.map((name) => `${name}.txt`));
    const notices = readFileSync(join(import.meta.dirname, "..", "dist", "THIRD-PARTY-NOTICES.txt"), "utf8");
    for (const name of linked) {
      // Each in full, header and text, as vendored: a text cut short or emptied is not found.
      const vendored = readFileSync(join(directory, `${name}.txt`));
      expect(createHash("sha256").update(vendored).digest("hex"), name).toBe(pinned[name]);
      const text = vendored.toString("utf8").trim();
      expect(text.split("\n").length, name).toBeGreaterThan(8);
      expect(notices.includes(text), name).toBe(true);
    }
    expect(notices).toContain("This software is based in part on the work of the Independent JPEG Group.");
  });
});
