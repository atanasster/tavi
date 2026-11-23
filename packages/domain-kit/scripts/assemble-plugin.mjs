// Puts a domain plugin's manifest, the site profiles and language packs it
// names and the files it ships beside its bundle, so dist-plugin/ is the folder `tavi plugins
// install` takes, and holds it to its budget: one module, no import other
// than Node's own, and at most `budgetMegabytes`.
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {URL} packageUrl The plugin package's folder.
 * @param {object} options
 * @param {number} options.budgetMegabytes The most dist-plugin/ may hold.
 * @param {readonly string[]} [options.files] Files and folders of the package shipped as they are, at the same path.
 * @param {{ readonly from: string; readonly to: string; readonly label: string; readonly budgetMegabytes: number }} [options.dictionary]
 *   A file read by the bundle at start, from outside the package (`from`: an absolute path, or one relative to the
 *   package), kept out of the bundle's budget under its own.
 * @param {boolean} [options.ignoreComments] Leaves comments out of the import check: JSDoc in bundled libraries
 *   (hyparquet's `@type` import expressions) name files that are not imported.
 */
export function assemblePlugin(packageUrl, { budgetMegabytes, files: shipped = [], dictionary, ignoreComments = false }) {
  const root = fileURLToPath(packageUrl);
  const out = join(root, "dist-plugin");
  copyFileSync(join(root, "tavi-plugin.json"), join(out, "tavi-plugin.json"));
  for (const path of shipped) cpSync(join(root, path), join(out, path), { recursive: true });
  // The site profiles the manifest's sites block names, and its language packs, beside it.
  const manifest = JSON.parse(readFileSync(join(root, "tavi-plugin.json"), "utf8"));
  for (const path of [...(manifest.sites ?? []), ...Object.values(manifest.locales ?? {})]) {
    const { from, to } = containedCopy(root, out, path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  if (dictionary !== undefined) {
    mkdirSync(dirname(join(out, dictionary.to)), { recursive: true });
    copyFileSync(resolve(root, dictionary.from), join(out, dictionary.to));
    const dictionaryBytes = statSync(join(out, dictionary.to)).size;
    if (dictionaryBytes > dictionary.budgetMegabytes * 1024 * 1024)
      throw new Error(`${dictionary.to} is ${String(dictionaryBytes)} bytes, past its ${String(dictionary.budgetMegabytes)} MB budget`);
  }
  const files = readdirSync(out, { recursive: true }).filter((file) => statSync(join(out, file)).isFile());
  const modules = files.filter((file) => file.endsWith(".mjs"));
  if (modules.length !== 1 || modules[0] !== "index.mjs")
    throw new Error(`dist-plugin holds ${modules.join(", ")}: one index.mjs is expected`);
  const source = readFileSync(join(out, "index.mjs"), "utf8");
  const bundle = ignoreComments ? source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "") : source;
  // `import … from`, `export … from`, a bare `import "x"`, and `import("x")`.
  const imports = [
    ...bundle.matchAll(
      /(?:^|[\n;])\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3]);
  const bare = imports.filter((specifier) => !specifier.startsWith("node:"));
  if (bare.length > 0) throw new Error(`the bundle imports ${bare.join(", ")}: only node: modules may stay outside it`);
  const kept = dictionary === undefined ? undefined : join(dictionary.to);
  const bytes = files.filter((file) => file !== kept).reduce((sum, file) => sum + statSync(join(out, file)).size, 0);
  const without = dictionary === undefined ? "" : ` without its ${dictionary.label}`;
  if (bytes > budgetMegabytes * 1024 * 1024)
    throw new Error(`dist-plugin is ${String(bytes)} bytes${without}, past its ${String(budgetMegabytes)} MB budget`);
  console.log(`dist-plugin: ${files.join(", ")} (${String(bytes)} bytes)`);
}

/**
 * Where a file the manifest names is copied from and to: a relative path that
 * stays inside the package and inside dist-plugin/. An absolute path, or one
 * that climbs out with `..`, is refused before anything is read or written.
 *
 * @param {string} root The package's folder.
 * @param {string} out Its dist-plugin/ folder.
 * @param {string} path The path as the manifest names it.
 * @returns {{ readonly from: string; readonly to: string }}
 */
export function containedCopy(root, out, path) {
  const inside = (base, target) => {
    const rest = relative(base, target);
    return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
  };
  const refused = () => new Error(`the manifest names ${String(path)}, which is not a relative path inside the package`);
  if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw refused();
  const from = resolve(root, path);
  const to = resolve(out, path);
  if (!inside(root, from) || !inside(out, to)) throw refused();
  return { from, to };
}
