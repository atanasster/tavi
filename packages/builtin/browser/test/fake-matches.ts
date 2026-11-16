import type { Locator } from "playwright";

import type { ScannedElement } from "../src/playwright.js";

/**
 * What `page.locator(selector)` answers in a fake page: `evaluateAll` returns
 * the scan `scanPage` would have made of `locators` — `elements[i]` describes
 * `locators[i]`, a button by default — and `nth` resolves a ref's locator.
 */
export function fakeMatches(locators: readonly Locator[], elements?: readonly Omit<ScannedElement, "index">[]) {
  return {
    evaluateAll: async (): Promise<ScannedElement[]> =>
      locators.map((_, index) => ({ index, ...(elements?.[index] ?? { role: "button" }) })),
    nth: (index: number): Locator | undefined => locators[index],
  };
}
