import { fillMessage, type Locale } from "../i18n.js";
import type { nav } from "./en/nav.js";

/** A place in the canvas, by the key of its nav label: a route, a Settings view or a Command Center section. */
export type NavKey = Exclude<keyof typeof nav, `nav.path.${string}`>;

/** A menu path's places, outermost first: two or three. */
export type NavPlaces = readonly [NavKey, NavKey] | readonly [NavKey, NavKey, NavKey];

/** A language's nav words: its part of the `core` catalogue, or the whole catalogue. */
export type NavWords = { readonly [K in keyof typeof nav]: string };

/**
 * The menu path through `places` in `words`' language ("Settings → Models", "Настройки → Модели"): for a
 * catalogue that writes a path into one of its own messages, so the message names the place as the nav does.
 * A message said at run time takes a reference instead (`navPath`).
 */
export function navPathIn(words: NavWords, ...places: NavPlaces): string {
  const [first, second, third] = places;
  const locale: Locale = "en"; // A path holds no number, so its language never changes how it is filled.
  const pair = { first: words[first], second: words[second] };
  return third === undefined
    ? fillMessage(words["nav.path.two"], pair, locale)
    : fillMessage(words["nav.path.three"], { ...pair, third: words[third] }, locale);
}

/** The places that may follow `place` in a path: Settings its views, the Center its sections, and a section the rail's parts in it. */
function nextPlaces(place: string, keys: readonly string[]): readonly string[] {
  if (place === "nav.route.settings") return keys.filter((key) => key.startsWith("nav.settings."));
  if (place === "nav.route.center" || place === "nav.route.commandCenter" || place.startsWith("nav.center."))
    return keys.filter((key) => key.startsWith("nav.center."));
  return [];
}

/**
 * The menu paths in `text` that name a place the nav, in `words`' language, does not have: each one that starts at
 * Settings, the Center or the Command Center, every hop checked against the places that may follow the one before,
 * a label matched whole. Text in `except` (another product's menu, "ChatGPT Settings → Usage") is skipped. For the
 * catalogue checks that keep a path written into a message from drifting from the nav.
 */
export function strayMenuPaths(text: string, words: NavWords, except: readonly string[] = []): string[] {
  const labels: Readonly<Record<string, string>> = words;
  const keys = Object.keys(labels).filter((key) => key.startsWith("nav.") && !key.startsWith("nav.path."));
  const scanned = except.reduce((rest, phrase) => rest.split(phrase).join(" "), text);
  const problems: string[] = [];
  for (const root of ["nav.route.settings", "nav.route.center", "nav.route.commandCenter"] as const) {
    for (const match of scanned.matchAll(new RegExp(`(?<!\\p{L})${words[root]} → `, "gu"))) {
      let place: string = root;
      let rest = scanned.slice(match.index + match[0].length);
      for (;;) {
        // The longest label that follows whole: "Web search", not a prefix of a longer word.
        const next = nextPlaces(place, keys)
          .filter((key) => {
            const label = labels[key] ?? "";
            return rest.startsWith(label) && !/^\p{L}/u.test(rest.slice(label.length));
          })
          .sort((a, b) => (labels[b] ?? "").length - (labels[a] ?? "").length)[0];
        if (next === undefined) {
          problems.push(`${match[0]}${rest.slice(0, 40)}`);
          break;
        }
        rest = rest.slice((labels[next] ?? "").length);
        if (!/^ → \p{L}/u.test(rest)) break;
        rest = rest.slice(" → ".length);
        place = next;
      }
    }
  }
  return problems;
}
