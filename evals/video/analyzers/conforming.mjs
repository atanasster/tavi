// A conforming command analyser: the
// conformance suite's reference. Arguments: framesDir audio outDir options.
// It answers transcription with one segment and OCR with an empty text per frame.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function answer([framesDir, audio, outDir, options]) {
  JSON.parse(options);
  const { frames } = JSON.parse(readFileSync(join(framesDir, "frames.json"), "utf8"));
  const result =
    frames.length > 0
      ? { frames: frames.map((frame) => ({ timeSec: frame.timeSec, text: "", confidence: 0 })) }
      : { language: "en", segments: existsSync(audio) ? [{ startSec: 0, endSec: 1, text: "fixture" }] : [] };
  writeFileSync(join(outDir, "result.json"), JSON.stringify({ result, model: "fixture-1" }));
}

// Run as the command itself (not imported by another fixture), whatever its path holds or links through.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) answer(process.argv.slice(2));
