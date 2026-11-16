// The licences of what a build bundles — a package.json's `taviBundled` and
// everything those reach — written to one notices file: bundled packages are
// not installed, so their notices ship beside the bundle instead.
// Usage: node scripts/third-party-notices.mjs <package-dir> <output-file> <title>
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [packageArgument, outputArgument, title] = process.argv.slice(2);
if (packageArgument === undefined || outputArgument === undefined || title === undefined) {
  console.error("usage: third-party-notices.mjs <package-dir> <output-file> <title>");
  process.exit(2);
}
// Against the folder the pnpm command was started in (`INIT_CWD`): a package's build runs this through
// `pnpm --workspace-root run notices . …`, which runs it from the workspace's root.
const root = resolve(process.env.INIT_CWD ?? process.cwd(), packageArgument);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function resolveFrom(from, name) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(directory) === directory) throw new Error(`${name} is not installed above ${from}`);
  }
}

const seen = new Map();
const queue = manifest.taviBundled.map((name) => resolveFrom(root, name));
while (queue.length > 0) {
  const directory = queue.pop();
  if (seen.has(directory)) continue;
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  seen.set(directory, pkg);
  const peers = Object.keys(pkg.peerDependencies ?? {}).filter((name) => pkg.peerDependenciesMeta?.[name]?.optional !== true);
  for (const name of [...Object.keys(pkg.dependencies ?? {}), ...peers]) queue.push(resolveFrom(directory, name));
}

const sections = [...seen.entries()]
  .sort(([, a], [, b]) => a.name.localeCompare(b.name))
  .map(([directory, pkg]) => {
    // Every licence and notice file: @embedpdf/pdfium carries PDFium's own beside its package licence.
    const files = readdirSync(directory)
      .filter((entry) => /^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry))
      .sort();
    const text =
      files.length === 0
        ? `(no licence file; declared ${JSON.stringify(pkg.license)})`
        : files.map((file) => `${file}:\n\n${readFileSync(join(directory, file), "utf8").trim()}`).join("\n\n");
    return `${pkg.name}@${pkg.version} (${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license)})\n\n${text}`;
  });
writeFileSync(resolve(root, outputArgument), `${title}\n\n${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`);
