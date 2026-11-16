#!/usr/bin/env node
// Puts the manifest beside the bundle, so dist-plugin/ is the folder
// `tavi plugins install` takes, and holds it to its budget: one module, no
// import other than Node's own, at most 400 KB, and no second TaviError class
// or contracts barrel bundled in.
import { copyFileSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUDGET_BYTES = 400 * 1024;

/** Every problem with a dist-plugin folder; none when it may be installed. */
export function problemsOf(out) {
  const problems = [];
  const files = readdirSync(out, { recursive: true }).filter((file) => statSync(join(out, file)).isFile());
  const modules = files.filter((file) => file.endsWith(".mjs") || file.endsWith(".js"));
  if (modules.length !== 1 || modules[0] !== "index.mjs")
    problems.push(`dist-plugin holds ${modules.join(", ") || "no module"}: one index.mjs is expected`);
  const bundle = files.includes("index.mjs") ? readFileSync(join(out, "index.mjs"), "utf8") : "";
  // `import … from` and `export … from` (spaced or minified), a bare `import "x"`, `import("x")` and `require("x")`.
  const imports = [
    ...bundle.matchAll(
      /(?:\bimport|\bexport)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3] ?? match[4]);
  const bare = imports.filter((specifier) => !specifier.startsWith("node:"));
  if (bare.length > 0) problems.push(`the bundle imports ${bare.join(", ")}: only node: modules may stay outside it`);
  if (/class TaviError\b/.test(bundle)) problems.push("the bundle holds a TaviError class of its own: the host's must be the one thrown");
  if (/TAVI_ERROR_CODES|ChannelDescriptorSchema/.test(bundle)) problems.push("the bundle holds the contracts barrel's schemas");
  const bytes = files.reduce((sum, file) => sum + statSync(join(out, file)).size, 0);
  if (bytes > BUDGET_BYTES) problems.push(`dist-plugin is ${String(bytes)} bytes, past its ${String(BUDGET_BYTES)}-byte budget`);
  return { problems, files, bytes };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out = join(root, "dist-plugin");
  copyFileSync(join(root, "tavi-plugin.json"), join(out, "tavi-plugin.json"));
  const { problems, files, bytes } = problemsOf(out);
  if (problems.length > 0) throw new Error(problems.join("; "));
  console.log(`dist-plugin: ${files.join(", ")} (${String(bytes)} bytes)`);
}
