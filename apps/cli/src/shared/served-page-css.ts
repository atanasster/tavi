import { createHash } from "node:crypto";

/**
 * The stylesheet of the pages the CLI serves to a browser outside the canvas:
 * the approval page behind a channel's link and the page an OAuth sign-in
 * lands on. Its tokens are the canvas's own (`apps/ui/src/styles/tokens.css`),
 * light and dark, copied here because the CLI cannot import the canvas; a test
 * holds them equal. The pages load nothing, so the sheet is inline, allowed by
 * its hash (`SERVED_PAGE_STYLE_SRC`) rather than by `'unsafe-inline'`.
 */

/** The canvas's light colours and the scheme-independent tokens the sheet uses. */
export const SERVED_PAGE_LIGHT_TOKENS: Readonly<Record<string, string>> = {
  "--background": "120 14% 96%",
  "--foreground": "157 25% 10%",
  "--card": "0 0% 100%",
  "--primary": "163 55% 27%",
  "--primary-foreground": "150 40% 98%",
  "--muted": "150 14% 93%",
  "--border": "152 6% 48%",
  "--ring": "163 55% 27%",
  "--line": "hsl(var(--border) / 50%)",
  "--font-system": 'system-ui, -apple-system, "Segoe UI", sans-serif',
  "--font-mono": 'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Roboto Mono", monospace',
  "--text-md": "15px",
  "--text-xl": "17px",
  "--leading-normal": "1.5",
  "--radius-xs": "4px",
  "--border-width": "1px",
  "--outline-width": "2px",
  "--focus-offset": "2px",
  "--space-1": "4px",
  "--space-1-5": "6px",
  "--space-2": "8px",
  "--space-3": "12px",
  "--space-4": "16px",
  "--space-8": "32px",
};

/** The canvas's dark values of the colours above. */
export const SERVED_PAGE_DARK_TOKENS: Readonly<Record<string, string>> = {
  "--background": "160 24% 7%",
  "--foreground": "150 21% 93%",
  "--card": "160 21% 11%",
  "--primary": "158 56% 64%",
  "--primary-foreground": "160 24% 7%",
  "--muted": "160 17% 15%",
  "--border": "155 9% 46%",
  "--ring": "158 56% 64%",
};

/** The served page's own measure: a column a form or a message reads comfortably in. */
const PAGE_TOKENS: Readonly<Record<string, string>> = { "--width-served-page": "640px" };

const declarations = (tokens: Readonly<Record<string, string>>): string =>
  Object.entries(tokens)
    .map(([name, value]) => `${name}:${value};`)
    .join("");

const RULES = [
  "body{font:var(--text-xl)/var(--leading-normal) var(--font-system);background:hsl(var(--background));color:hsl(var(--foreground));max-width:var(--width-served-page);margin:var(--space-8) auto;padding:0 var(--space-4)}",
  "a{color:hsl(var(--primary))}",
  "pre{white-space:pre-wrap;font-family:var(--font-mono);background:hsl(var(--muted));padding:var(--space-3);border-radius:var(--radius-xs)}",
  "button{font:inherit;padding:var(--space-2) var(--space-4);border:0;border-radius:var(--radius-xs);background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer}",
  "button:focus-visible,input:focus-visible,textarea:focus-visible{outline:var(--outline-width) solid hsl(var(--ring));outline-offset:var(--focus-offset)}",
  "label{display:block;margin:var(--space-3) 0}",
  "input,textarea{font:inherit;color:inherit;box-sizing:border-box;width:100%;padding:var(--space-1-5);background:hsl(var(--card));border:var(--border-width) solid hsl(var(--border));border-radius:var(--radius-xs)}",
  "input[type=checkbox]{width:auto;accent-color:hsl(var(--primary))}",
  "fieldset{border:0;padding:0}",
  "table{border-collapse:collapse;width:100%;font-size:var(--text-md)}",
  "td,th{border:var(--border-width) solid var(--line);padding:var(--space-1) var(--space-1-5);text-align:left;vertical-align:top}",
];

/** The served pages' one stylesheet: the theme's tokens in both schemes, then the rules that use them. */
export const SERVED_PAGE_CSS =
  `:root{color-scheme:light dark;${declarations(SERVED_PAGE_LIGHT_TOKENS)}${declarations(PAGE_TOKENS)}}` +
  `@media (prefers-color-scheme: dark){:root{${declarations(SERVED_PAGE_DARK_TOKENS)}}}` +
  RULES.join("");

/** The `<style>` element a served page puts in its head. */
export const SERVED_PAGE_STYLE = `<style>${SERVED_PAGE_CSS}</style>`;

/** The CSP source that allows that element and no other inline style. */
export const SERVED_PAGE_STYLE_SRC = `'sha256-${createHash("sha256").update(SERVED_PAGE_CSS).digest("base64")}'`;
