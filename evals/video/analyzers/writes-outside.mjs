// A command analyser that answers correctly but also writes beside its run directory:
// the conformance suite fails it on "writes", and on nothing else.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { answer } from "./conforming.mjs";

const args = process.argv.slice(2);
// outDir is <run>/analyze-*/out: three levels up is beside the run directory.
writeFileSync(join(args[2], "..", "..", "..", `escaped-${String(process.pid)}`), "out");
answer(args);
