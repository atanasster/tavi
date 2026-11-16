// A command analyser whose answer is not its capability's result type: the conformance
// suite fails it on "output", and on nothing else.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , outDir] = process.argv.slice(2);
writeFileSync(join(outDir, "result.json"), JSON.stringify({ result: { language: "english", segments: "none" } }));
