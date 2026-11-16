/**
 * The module specifiers a source or built file imports: static imports and
 * re-exports (a statement's `from`, on the line that ends it), side-effect
 * imports, dynamic `import("…")` (with options, or a template string with no
 * substitution), `require("…")` and a module resolved by name
 * (`require.resolve`, `createRequire(…).resolve`, `import.meta.resolve`). Anchored to statements, so a string such
 * as the `"from"` of `Omit<…, "from">`, or a comment, is not mistaken for one.
 * Shared by the boundary and artifact gates, so a fix reaches both.
 */
const IMPORT =
  /(?:^|\n)[ \t]*(?:import|export|\})[^\n]*?\sfrom\s*["']([^"'\n]+)["']|(?:^|\n)[ \t]*import\s*["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*[,)]|\bimport\s*\(\s*`([^`$\n]+)`\s*[,)]|\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)|(?:\brequire|\)|\bimport\.meta)\.resolve\(\s*["']([^"'\n]+)["']/g;

export function importedBy(text: string): string[] {
  return [...text.matchAll(IMPORT)].map((match) => match.slice(1).find((group) => group !== undefined) ?? "");
}

/** Static imports, re-exports and side-effect imports alone: what loads before a module's own code runs. */
const STATIC_IMPORT = /(?:^|\n)[ \t]*(?:import|export|\})[^\n]*?\sfrom\s*["']([^"'\n]+)["']|(?:^|\n)[ \t]*import\s*["']([^"'\n]+)["']/g;

export function staticallyImportedBy(text: string): string[] {
  return [...text.matchAll(STATIC_IMPORT)].map((match) => match.slice(1).find((group) => group !== undefined) ?? "");
}
