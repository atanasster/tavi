import type { NavPlaces } from "./locales/nav-path.js";
import { textRef, type TextRef } from "./text-ref.js";

export type { NavKey, NavPlaces } from "./locales/nav-path.js";

/**
 * A menu path through `places` ("Center → Heartbeat") as a reference to the nav's own labels: stored in a notice
 * or an error, the canvas says it in its language; `englishOf` gives the English a terminal or a chat app gets.
 */
export function navPath(...places: NavPlaces): TextRef {
  const [first, second, third] = places;
  const pair = { first: textRef(first), second: textRef(second) };
  return third === undefined ? textRef("nav.path.two", pair) : textRef("nav.path.three", { ...pair, third: textRef(third) });
}
