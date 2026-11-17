import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DOCKED_MIN_WIDTH, PHONE_MAX_WIDTH, PHONE_QUERY, SHORT_MAX_HEIGHT, WIDE_MIN_WIDTH } from "../../src/lib/breakpoints.js";
import { canvasCss, stylesheet } from "../css.js";

/**
 * The design rules the canvas takes from ai-finance (`docs/brand.md`): an
 * icon is drawn SVG in the current colour, never an emoji or a glyph whose
 * font the platform picks; a surface is one colour, never a gradient; and
 * every colour is a token in `styles/tokens.css`, so a theme is one edit.
 */
const root = join(import.meta.dirname, "..", "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
const sources = files(root);
const read = (path: string) => readFileSync(path, "utf8");

describe("the canvas keeps ai-finance's design rules", () => {
  it("sizes a form's long text to what it holds, up to a limit, so none of it is cut off", () => {
    const rule = /\.settings-fields > label > textarea \{[^}]*\}/.exec(canvasCss())?.[0];
    expect(rule).toContain("field-sizing: content");
    expect(rule).toContain("max-height: var(--height-scroll-sm)");
  });

  it("draws a form's refusal as a refusal: `.settings-fields p` would make it help text", () => {
    expect(/\.settings-fields \.failure \{[^}]*\}/.exec(canvasCss())?.[0]).toContain("color: hsl(var(--destructive))");
  });

  it("wraps a failed tool call's message rather than scrolling it out of sight in a box no keyboard can reach", () => {
    const rule = /\.tool \.failure,\n\.tools > \.failure \{[^}]*\}/.exec(canvasCss())?.[0];
    expect(rule).toContain("white-space: pre-wrap");
    expect(rule).toContain("overflow-wrap: anywhere");
    expect(rule).not.toContain("overflow-x");
  });

  it("keeps a page scroller's scrollbar room, so its centred column sits still between a short page and a long one (Mac mini UI check)", () => {
    for (const selector of [".settings", ".center", ".ideas-page", ".welcome-page", ".runs"]) {
      const rule = new RegExp(`\\n${selector.replace(".", "\\.")} \\{[^}]*\\}`).exec(canvasCss())?.[0];
      expect(rule, selector).toContain("scrollbar-gutter: stable");
    }
  });

  it("draws no emoji and no glyph icons", () => {
    // Emoji, and the dingbats, carets and triangles the old icons were set in.
    // An arrow in a sentence ("turn → tool") is punctuation and is not caught.
    const glyphs = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2303}\u{2304}\u{25B8}\u{25BE}]/u;
    const offenders = sources.filter((path) => /\.(tsx?|css)$/.test(path)).filter((path) => glyphs.test(read(path)));
    expect(offenders.map((path) => path.slice(root.length + 1))).toEqual([]);
  });

  it("paints no gradient", () => {
    const offenders = sources.filter((path) => path.endsWith(".css")).filter((path) => /gradient\(/.test(read(path)));
    expect(offenders).toEqual([]);
  });

  it("names every colour through a token", () => {
    // A literal colour outside the token block is a theme that will not follow.
    const literal = /#[0-9a-f]{3,8}\b|\brgb\((?!\s*0 0 0)/i;
    const offenders = sources
      .filter((path) => path.endsWith(".css"))
      .flatMap((path) =>
        read(path)
          .split("\n")
          .map((line, index) => ({ path, line, index })),
      )
      .filter(({ line }) => literal.test(line) && !line.includes("box-shadow") && !line.includes("--shadow"));
    expect(offenders.map(({ path, index }) => `${path.slice(root.length + 1)}:${index + 1}`)).toEqual([]);
  });

  it("draws hairlines through the --line-* tokens", () => {
    // `hsl(var(--border) / N%)` outside the token block is a divider strength
    // the scale does not know about.
    const offenders = sources
      .filter((path) => path.endsWith(".css"))
      .flatMap((path) =>
        read(path)
          .split("\n")
          .map((line, index) => ({ path, line, index })),
      )
      .filter(({ line }) => /hsl\(var\(--border\) \/ \d+%\)/.test(line) && !line.trim().startsWith("--line"));
    expect(offenders.map(({ path, index, line }) => `${path.slice(root.length + 1)}:${index + 1} ${line.trim()}`)).toEqual([]);
  });

  it("pairs every dark token with a light one", () => {
    const css = stylesheet("tokens.css");
    const blocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map(
      (match) => new Set([...match[1]!.matchAll(/--([a-z0-9-]+):/g)].map((token) => token[1])),
    );
    const [light, dark] = blocks;
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    for (const token of dark!) expect(light!.has(token), `--${token} is dark-only`).toBe(true);
  });
});

describe("a need's stripe is seen", () => {
  /** WCAG relative luminance of an `H S% L%` token. */
  const luminance = (token: string): number => {
    const [h, s, l] = token
      .trim()
      .split(/\s+/)
      .map((part) => Number.parseFloat(part)) as [number, number, number];
    const sat = s / 100;
    const light = l / 100;
    const a = sat * Math.min(light, 1 - light);
    const channel = (n: number) => {
      const k = (n + h / 30) % 12;
      const value = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
  };
  const ratio = (a: string, b: string) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (high + 0.05) / (low + 0.05);
  };
  it("keeps the warning stripe at least 3:1 against a card, light and dark", () => {
    const css = stylesheet("tokens.css");
    const blocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((match) =>
      Object.fromEntries([...match[1]!.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((token) => [token[1], token[2]])),
    );
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const tokens of blocks.slice(0, 2)) {
      expect(ratio(tokens["warning"] ?? "", tokens["card"] ?? "")).toBeGreaterThanOrEqual(3);
    }
  });
});

it("styles every part of the question card, with phone-sized targets", () => {
  const css = canvasCss();
  for (const part of [
    ".need-meta",
    ".need-context",
    ".need-options",
    ".need-option",
    ".need-own",
    ".need-footer",
    ".need-undo",
    ".need-receipt",
  ]) {
    expect(css, part).toMatch(new RegExp(`${part.replace(".", "\\.")}[\\s,{:]`));
  }
  // On a phone an option row and the card's small buttons are a thumb's height.
  const phone = [...css.matchAll(/@media \(--phone\) \{([\s\S]*?)\n\}/g)].map((match) => match[1] ?? "").join("\n");
  expect(phone).toMatch(/\.need-option \{\s*min-height: var\(--size-touch-row\);/);
  expect(phone).toMatch(/\.button-sm\.need-own-open \{\s*min-height: var\(--size-touch\);/);
  expect(stylesheet("tokens.css")).toMatch(/--size-touch: 44px;/);
  expect(stylesheet("tokens.css")).toMatch(/--size-touch-row: 48px;/);
});

describe("a recurring row's switch on a phone", () => {
  it("keeps its look, with a touch target's height and width around it", () => {
    const phone = [...stylesheet("schedule.css").matchAll(/@media \(--phone\) \{([\s\S]*?)\n\}/g)]
      .map((match) => match[1] ?? "")
      .join("\n");
    const area = /\.switch::before \{([^}]*)\}/.exec(phone)?.[1] ?? "";
    expect(area).toMatch(/position: absolute;/);
    expect(area).toMatch(/width: max\(100%, var\(--size-touch\)\);/);
    expect(area).toMatch(/height: var\(--size-touch\);/);
  });
});

describe("the footer's Keyboard button on a phone", () => {
  it("shows only its icon, and keeps its words in its name", () => {
    const phone = [...stylesheet("strip.css").matchAll(/@media \(--phone\) \{([\s\S]*?)\n\}/g)].map((match) => match[1] ?? "").join("\n");
    // The visible word leaves the screen but not the accessibility tree: display: none would take "Keyboard" out
    // of the button's name, leaving it "shortcuts".
    const label = /\.strip \.strip-keys-label \{([^}]*)\}/.exec(phone)?.[1] ?? "";
    expect(label).toMatch(/clip-path: inset\(50%\);/);
    expect(label).not.toMatch(/display: none/);
    expect(phone).toMatch(/\.strip \.strip-keys kbd \{\s*display: none;/);
  });
});

describe("the layout's breakpoints are one set of numbers", () => {
  // `breakpoints.css` names each step once as `@custom-media`, which Lightning
  // CSS writes out at build time; this holds the definitions to
  // `breakpoints.ts`, which the script reads, and every other query to a name.
  const defined = new Map(
    [...stylesheet("breakpoints.css").matchAll(/@custom-media (--[a-z-]+) ([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]),
  );
  const queries = [
    ...canvasCss()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/@media ([^{]+)\{/g),
  ].map((match) => match[1]!.trim());

  it("defines the steps from breakpoints.ts", () => {
    expect(Object.fromEntries(defined)).toEqual({
      "--phone": PHONE_QUERY,
      "--overlay": `(min-width: ${PHONE_MAX_WIDTH + 1}px) and (max-width: ${DOCKED_MIN_WIDTH - 1}px)`,
      "--undocked": `(max-width: ${DOCKED_MIN_WIDTH - 1}px)`,
      "--wide": `(min-width: ${WIDE_MIN_WIDTH}px)`,
      "--short": `(max-height: ${SHORT_MAX_HEIGHT}px)`,
    });
    expect(PHONE_QUERY).toBe(`(max-width: ${PHONE_MAX_WIDTH}px)`);
  });

  it("gives a short window's height to the transcript, and a phone's open Chats their own scroll", () => {
    const short = (name: string) => stylesheet(name).slice(stylesheet(name).indexOf("@media (--short)"));
    expect(short("strip.css")).toMatch(/\.strip \{\s*display: none;/);
    expect(short("composer.css")).toMatch(/\.composer textarea \{\s*flex: 1 1 0;\s*width: auto;\s*min-height: var\(--control-height\);/);
    expect(short("composer.css")).toMatch(/\.composer-hint \{\s*display: none;/);
    expect(stylesheet("strip.css")).toMatch(/\.body:has\(> \.sidebar\) > \.main \{\s*height: 100%;/);
  });

  it("states a width only in breakpoints.css", () => {
    // Every other query is one named step, or a feature query (hover, pointer,
    // colour scheme, motion, forced colours) that names no size.
    const steps = new Set([...defined.keys()].map((name) => `(${name})`));
    const named = queries.filter((query) => query.includes("(--"));
    expect(named.length).toBeGreaterThan(0);
    for (const query of named) expect(steps.has(query), query).toBe(true);
    for (const query of queries.filter((query) => !steps.has(query))) expect(query).not.toMatch(/width|height|aspect-ratio|resolution/);
    // Each step is used; one no query names is a breakpoint the layout lost.
    for (const step of steps) expect(queries, step).toContain(step);
  });

  it("defines the breakpoints before the first stylesheet that reads them", () => {
    const index = stylesheet("index.css");
    expect(index.indexOf('@import "./breakpoints.css";')).toBeGreaterThan(-1);
    expect(index.indexOf('@import "./breakpoints.css";')).toBeLessThan(index.indexOf('@import "./controls.css";'));
  });
});

describe("a table cell stays a cell", () => {
  it("sets no display on a class a <td> or <th> carries, so its row's border runs the whole row", () => {
    const cellClasses = new Set(
      sources
        .filter((path) => path.endsWith(".tsx"))
        .flatMap((path) => [...read(path).matchAll(/<t[dh] className="([^"]+)"/g)].flatMap((match) => (match[1] ?? "").split(/\s+/))),
    );
    const offenders = [...canvasCss().matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /(^|[;\s])display\s*:/.test(body ?? ""))
      .map(([, selector]) => (selector ?? "").trim())
      .filter((selector) => selector.split(",").some((one) => [...cellClasses].some((name) => one.trim().endsWith(`.${name}`))));
    expect(offenders).toEqual([]);
  });
});

describe("a radio or checkbox keeps its own size", () => {
  it("widens no radio or checkbox to its column in the shared forms (.field, .settings-fields): their stretch leaves them out", () => {
    const offenders = [
      ...canvasCss()
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/([^{}]+)\{([^{}]*)\}/g),
    ]
      .filter(([, , body]) => /(^|[;\s])width\s*:\s*100%/.test(body ?? ""))
      .flatMap(([, selector]) => (selector ?? "").split(",").map((one) => one.trim()))
      // A selector that ends on every input of the shared form layouts and does not leave out radios and checkboxes.
      .filter(
        (one) =>
          /^\.(?:field|settings-fields) input(?::[a-z-]+(?:\([^)]*\))?)*$/.test(one) &&
          !(one.includes('[type="radio"]') && one.includes('[type="checkbox"]')),
      );
    expect(offenders).toEqual([]);
  });
});

describe("a checkbox with a description in a settings form", () => {
  it("puts the description on its own line, so the label is never squeezed to a word a line (This is me)", () => {
    const css = canvasCss();
    expect(/\.settings-fields > label:has\(input\[type="checkbox"\]\)\s*\{([^}]*)\}/.exec(css)?.[1]).toMatch(/flex-wrap:\s*wrap/);
    expect(/\.settings-fields > label:has\(input\[type="checkbox"\]\) > \.settings-description\s*\{([^}]*)\}/.exec(css)?.[1]).toMatch(
      /flex-basis:\s*100%/,
    );
  });
});

describe("an idea card's ⋯ menu", () => {
  it("starts its items at the left, as the canvas's other menus do, a two-line one too", () => {
    const rule = /\.idea-menu-panel \.button-link\s*\{([^}]*)\}/.exec(canvasCss())?.[1] ?? "";
    expect(rule).toMatch(/justify-content:\s*flex-start/);
    expect(rule).toMatch(/text-align:\s*start/);
  });
});
