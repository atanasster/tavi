// The add-on's data, copied into dist/ (it is not installed with Tavi, so it ships in the build), and the
// licences of what it copies, written as dist/THIRD-PARTY-NOTICES.txt (package.json `taviBundled`).
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function resolveFrom(from, name) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(directory) === directory) throw new Error(`${name} is not installed above ${from}`);
  }
}

// The names the built module answers with (tsdown has run).
const { CORE, ENG, WASM } = await import(pathToFileURL(join(root, "dist", "index.mjs")).href);
const core = resolveFrom(root, "tesseract.js-core");
const eng = resolveFrom(root, "@tesseract.js-data/eng");
// The LSTM engine with SIMD (Node 22 has it): the glue as CommonJS, since this package is ESM.
copyFileSync(join(core, "tesseract-core-simd-lstm.js"), join(root, "dist", CORE));
copyFileSync(join(core, "tesseract-core-simd-lstm.wasm"), join(root, "dist", WASM));
// The 4.0.0_best_int model: the LSTM engine's, 2.9 MB gzipped against the 4.0.0 model's 10.9 MB.
copyFileSync(join(eng, "4.0.0_best_int", "eng.traineddata.gz"), join(root, "dist", ENG));

const sections = manifest.taviBundled.map((name) => {
  const directory = resolveFrom(root, name);
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const files = readdirSync(directory)
    .filter((entry) => /^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry))
    .sort();
  const text =
    files.length === 0
      ? `(no licence file; declared ${JSON.stringify(pkg.license)})`
      : files.map((file) => `${file}:\n\n${readFileSync(join(directory, file), "utf8").trim()}`).join("\n\n");
  return `${pkg.name}@${pkg.version} (${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license)})\n\n${text}`;
});
// The model is Tesseract's trained English data, which Tesseract's project publishes under Apache-2.0.
// What tesseract.js-core's wasm links, each under its own licence: its third_party/ libraries (at the commits its
// v7.0.0 pins) and the Emscripten 4.0.15 runtime it builds with. The full texts, vendored in licenses/ with the
// source each came from.
const linked = readdirSync(join(root, "licenses"))
  .filter((name) => name.endsWith(".txt"))
  .sort();
sections.push(
  [
    "Linked into tesseract-core-simd-lstm.wasm, each under its own licence, in full below.",
    "This software is based in part on the work of the Independent JPEG Group.",
    "",
    linked.map((name) => readFileSync(join(root, "licenses", name), "utf8").trim()).join(`\n\n${"-".repeat(72)}\n\n`),
  ].join("\n"),
);
sections.push(
  "eng.traineddata (the 4.0.0_best_int build in @tesseract.js-data/eng; Tesseract's trained English model) (Apache-2.0)\n\nLicensed under the Apache License, Version 2.0, as tesseract.js-core above.",
);
writeFileSync(
  join(root, "dist", "THIRD-PARTY-NOTICES.txt"),
  `Third-party software and data copied into this add-on's dist/.\n\n${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
);
