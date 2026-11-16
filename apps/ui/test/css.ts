import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the canvas's stylesheets live. */
const stylesDir = join(import.meta.dirname, "..", "src", "styles");

/** One stylesheet under `styles/`, as text. */
export const stylesheet = (name: string): string => readFileSync(join(stylesDir, name), "utf8");

/**
 * The canvas's stylesheet as one text, as the page receives it:
 * `styles/index.css` with each of its own `@import`s read in its place, in
 * cascade order. A package's import (the font) is left out.
 */
export const canvasCss = (): string =>
  stylesheet("index.css")
    .replace(/@import "\.\/([^"]+)";/g, (_, name: string) => stylesheet(name))
    .replace(/@import "[^"]+";/g, "");
