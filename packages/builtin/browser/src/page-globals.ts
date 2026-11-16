/**
 * The page's globals, as a function run in it through `evaluate` reads them.
 * This package declares no DOM types, and such a function must be
 * self-contained (Playwright sends its source, not its closure, so it cannot
 * call a helper of this package): each reads `globalThis as PageGlobals<...>`
 * itself, naming the document it duck-types. Every member is optional, as
 * Node's globals (a unit test's) have none of them, which is also what lets
 * `globalThis` be asserted to it directly, with no cast through `unknown`.
 */
export interface PageGlobals<Document = never> {
  readonly document?: Document;
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly scrollX?: number;
  readonly scrollY?: number;
  scrollTo?(x: number, y: number): void;
  scrollBy?(x: number, y: number): void;
}
