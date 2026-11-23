import { afterEach, beforeEach } from "vitest";

import { setLocale } from "../../src/lib/i18n.js";
import { unmountAll } from "./dom.js";

/**
 * Every test of the file that calls it in Bulgarian: the canvas's locale set to
 * `bg` before each test, and after it the views taken down and English back,
 * so the next file starts as the canvas does.
 */
export function inBulgarian(): void {
  beforeEach(async () => {
    await setLocale("bg");
  });
  afterEach(async () => {
    unmountAll();
    await setLocale("en");
  });
}
