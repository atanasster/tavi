// `plugin-base.css`, the theme tokens a UI plugin's page links before its own
// stylesheet, generated from the canvas's `apps/ui/src/styles/tokens.css`:
// every token in PLUGIN_UI_THEME_TOKENS (@tavi/contracts), and nothing else,
// with its light value and, where the canvas has one, its dark value. Two
// copies are written, each a plain file its plugin serves as it is: the
// built-in view's `ui/plugin-base.css` and the example plugin's, which runs
// from the repository without a build.
//
//   node scripts/plugin-base.mjs          rewrite both copies
//   node scripts/plugin-base.mjs --check  fail if either is not what this writes
//                                         (@tavi/plugin-browser-view's build runs it)
//
// tests/ui-plugin-base.test.ts regenerates and compares too, so a hand edit to
// either copy fails; edit tokens.css or the token list and rerun this.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HEADER = `/* Tavi's theme tokens for a UI plugin's page: every variable the canvas
   passes in \`init\` and \`theme\` (PLUGIN_UI_THEME_TOKENS), with the canvas's
   own values, light and dark, so a page looks right before the host's arrive
   or outside the host altogether. The host's values, set on the root element,
   win over these. Colours are HSL components: \`hsl(var(--primary))\`,
   \`hsl(var(--primary) / var(--tint-medium))\`; a hairline is \`var(--line)\`.
   Link it before the page's own stylesheet.

   Generated from apps/ui/src/styles/tokens.css by scripts/plugin-base.mjs
   in the Tavi repository; do not edit. */
`;

/** The custom properties a block declares, in order. */
const declarations = (block) => new Map([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));

/**
 * The custom properties a stylesheet declares in its first `:root` block (the
 * light scheme) and in its `prefers-color-scheme: dark` one, comments aside.
 */
export function schemes(stylesheet) {
  const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, "");
  const light = /^:root\s*\{([^}]*)\}/m.exec(css)?.[1];
  const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1];
  if (light === undefined || dark === undefined) throw new Error("plugin-base: no light or dark :root block");
  return { light: declarations(light), dark: declarations(dark) };
}

/**
 * `plugin-base.css` for these tokens, from the canvas's `tokens.css` text.
 * Throws on a token the canvas does not define, or a value that reads a
 * variable the plugin is not given.
 */
export function pluginBase(tokensCss, tokens) {
  const values = schemes(tokensCss);
  const given = new Set(tokens);
  for (const token of tokens) {
    if (!values.light.has(token)) throw new Error(`plugin-base: ${token} is not in tokens.css`);
    for (const scheme of [values.light, values.dark]) {
      for (const [, name] of (scheme.get(token) ?? "").matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!given.has(name)) throw new Error(`plugin-base: ${token} reads ${name}, which a plugin is not given`);
      }
    }
  }
  const line = (indent, token, value) => `${indent}${token}: ${value};\n`;
  const darkTokens = tokens.filter((token) => values.dark.has(token));
  return [
    HEADER,
    ":root {\n  color-scheme: light dark;\n",
    ...tokens.map((token) => line("  ", token, values.light.get(token))),
    "}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n",
    ...darkTokens.map((token) => line("    ", token, values.dark.get(token))),
    "  }\n}\n",
  ].join("");
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the canvas's tokens are, and the two copies this writes. */
export const PLUGIN_BASE_PATHS = {
  tokens: join(repo, "apps", "ui", "src", "styles", "tokens.css"),
  copies: [
    join(repo, "packages", "builtin", "browser-view", "ui", "plugin-base.css"),
    join(repo, "examples", "ui-plugins", "minimal-browser-view", "plugin-base.css"),
  ],
};

// Run as a script: the path it was run by, links resolved, is this module's (a link or a drive letter's case would differ).
if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const { PLUGIN_UI_THEME_TOKENS } = await import("@tavi/contracts");
  const css = pluginBase(readFileSync(PLUGIN_BASE_PATHS.tokens, "utf8"), PLUGIN_UI_THEME_TOKENS);
  const check = process.argv.includes("--check");
  const stale = PLUGIN_BASE_PATHS.copies.filter((path) => readFileSync(path, "utf8") !== css);
  const names = (paths) => paths.map((path) => relative(repo, path)).join(", ");
  if (check && stale.length > 0) {
    console.error(
      `plugin-base: ${names(stale)} not generated from tokens.css; run \`node scripts/plugin-base.mjs\` at the repository root`,
    );
    process.exit(1);
  }
  if (!check) for (const path of stale) writeFileSync(path, css);
  console.log(`plugin-base: ${stale.length > 0 && !check ? `wrote ${names(stale)}` : `${names(PLUGIN_BASE_PATHS.copies)} up to date`}`);
}
