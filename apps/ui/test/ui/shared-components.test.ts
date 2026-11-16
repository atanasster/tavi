import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A view draws its controls through `src/ui/`: a button is `Button` (or a
 * part built on it), a list to choose from is `Select`, an overlay is `Modal`
 * or `Popover`, and a labelled control is `Field`. A raw element skips the
 * focus, keyboard and labelling wiring those carry. Each rule names the files
 * that keep the raw element, and why.
 */
const root = join(import.meta.dirname, "..", "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

interface Allowed {
  /** Relative to `src/`. */
  readonly paths: readonly string[];
  readonly reason: string;
}

interface Rule {
  readonly name: string;
  readonly instead: string;
  readonly pattern: RegExp;
  /** Whether a file, relative to `src/`, may write the raw element by what it is. */
  readonly owner: (path: string) => boolean;
  readonly allowed: readonly Allowed[];
  /** Each piece of text the rule catches on its own, on its first line. */
  readonly planted: readonly string[];
  readonly nearMiss: string;
}

/** `source` with its comments blanked, lines kept, so prose about an element is not the element. */
const uncommented = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")).replace(/(^|\s)\/\/.*$/gm, "$1");

/** The 1-based lines of `text`, comments already blanked, where `pattern` (global) starts a match. */
const matchLines = (pattern: RegExp, text: string): number[] =>
  [...text.matchAll(pattern)].map((match) => text.slice(0, match.index).split("\n").length);

/** The 1-based lines of `source` where `pattern` (global) starts a match outside a comment. */
const linesOf = (pattern: RegExp, source: string): number[] => matchLines(pattern, uncommented(source));

const RULES: readonly Rule[] = [
  {
    name: "a raw <button>",
    instead: "Button, IconButton or Tabs from src/ui/",
    pattern: /<button\b/g,
    owner: (path) => path === "ui/Button.tsx" || path === "ui/Tabs.tsx",
    allowed: [],
    planted: ['<button type="button" onClick={go}>Go</button>'],
    nearMiss: "<Button onClick={go}>Go</Button>\n// a <button> would skip the focus ring",
  },
  {
    name: "a raw <select>",
    instead: "Select from src/ui/Select.tsx",
    pattern: /<select\b/g,
    owner: (path) => path === "ui/Select.tsx",
    allowed: [],
    planted: ["<select value={value} onChange={choose}>"],
    nearMiss: "<Select value={value} options={options} onChange={choose} />\n/* the page's `<select>` lists */",
  },
  {
    name: 'a hand-written role="dialog"',
    instead: "Modal or Popover from src/ui/",
    // `role="dialog"`, `role={"dialog"}`, or `role: "dialog"` in props spread onto an element.
    pattern: /\brole(?:=(?:"(?:alert)?dialog"|\{\s*["'`](?:alert)?dialog["'`]\s*\})|:\s*["'`](?:alert)?dialog["'`])/g,
    owner: (path) => path === "ui/Modal.tsx" || path === "ui/Popover.tsx" || path === "ui/Select.tsx",
    allowed: [
      {
        paths: ["features/takeover/Takeover.tsx", "features/takeover/TakeoverPopovers.tsx"],
        reason:
          "The live view is a full-page takeover that routes every key and pointer to the remote page, and the page's own file chooser and alert prompts sit inside it; Modal's native <dialog> would lift them into the top layer, out of the takeover.",
      },
      {
        paths: ["features/plugin-host/PluginPanelTab.tsx"],
        reason:
          "A plugin's panel grows in place into a modal and back, so its frame keeps running; Modal would draw it in a separate <dialog> and remount it.",
      },
      {
        paths: ["features/settings/CanvasPluginsSettings.tsx"],
        reason:
          "An inline confirmation (`alertdialog`) in the section's flow, asking before a plugin may see the agent's browser; not an overlay.",
      },
    ],
    planted: ['<div role="dialog" aria-modal="true">', '<div {...(open ? { role: "dialog" } : {})}>', "<div role={'alertdialog'}>"],
    nearMiss: '<Modal title="Delete">\n<div role="dialogue-log">\nconst props = { role: "dialogue", kind: "dialog" };',
  },
  {
    name: "a <label htmlFor> written by hand",
    instead: "Field from src/ui/Field.tsx",
    pattern: /<label\b[^>]*?\bhtmlFor=/g,
    owner: (path) => path === "ui/Field.tsx",
    allowed: [
      {
        paths: ["features/settings/McpServers.tsx", "features/settings/ConnectionSetup.tsx"],
        reason: "The label wraps its input as well as naming it, a layout Field, which puts the control after the label, does not draw.",
      },
      {
        paths: ["features/settings/PluginModals.tsx", "features/chat-panel/Memory.tsx"],
        reason: "A checkbox wrapped in its label, the box before the words.",
      },
      {
        paths: ["features/chat-panel/Instructions.tsx"],
        reason: "The label sits inside the section's h4 heading, beside the revision, not above a bare control.",
      },
      {
        paths: ["features/settings/SystemPromptEditor.tsx", "features/center/Soul.tsx"],
        reason: "The textarea's count and problem lines sit in the editor's own layout, which Field's hint and error would replace.",
      },
      {
        paths: ["features/apps/SignInStep.tsx"],
        reason: "A warning paragraph sits between the label and the field it names.",
      },
      {
        paths: ["features/apps/SettingsForm.tsx"],
        reason: "One row draws every kind of app setting: a list has no control, so its name is a span, and the label is chosen per kind.",
      },
    ],
    planted: ['<label htmlFor={id} className="x">Name</label>'],
    nearMiss: '<label>\n  <input type="checkbox" /> Remember\n</label>',
  },
  {
    name: "a tavi command in a raw <code>",
    instead: "Command from src/ui/Command.tsx, which wraps a command only between its words, never at the hyphen of a flag",
    pattern: /<code(?:\s+className="[^"]*")?>tavi\b/g,
    owner: (path) => path === "ui/Command.tsx",
    allowed: [],
    planted: ["use <code>tavi reset --yes</code>.", '<code className="meta">tavi doctor</code>'],
    nearMiss: "<Command>tavi reset --yes</Command>\n<code>travel.googleFlights off</code>",
  },
];

const sources = files(root)
  .filter((path) => path.endsWith(".tsx"))
  .map((path) => path.slice(root.length + 1));
// Each view read once, its comments blanked once, for every rule.
const texts = new Map(sources.map((path) => [path, uncommented(readFileSync(join(root, path), "utf8"))]));
const allowedPaths = (rule: Rule): string[] => rule.allowed.flatMap((entry) => entry.paths);

describe("views draw their controls through src/ui/", () => {
  it("finds the views", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it.each(RULES)("writes no $name", (rule) => {
    const allowed = new Set(allowedPaths(rule));
    const offenders = sources
      .filter((path) => !rule.owner(path) && !allowed.has(path))
      .flatMap((path) => matchLines(rule.pattern, texts.get(path) ?? "").map((line) => `${path}:${line}`));
    expect(offenders, `use ${rule.instead}`).toEqual([]);
  });

  it.each(RULES)("allows only files that still write $name", (rule) => {
    // An entry whose file has moved onto the component, or is gone, is stale.
    const stale = allowedPaths(rule).filter((path) => {
      const text = texts.get(path);
      return text === undefined || matchLines(rule.pattern, text).length === 0;
    });
    expect(stale).toEqual([]);
  });

  it.each(RULES)("catches a planted $name and passes a near miss", (rule) => {
    for (const planted of rule.planted) expect(linesOf(rule.pattern, planted), planted).toEqual([1]);
    expect(linesOf(rule.pattern, rule.nearMiss)).toEqual([]);
  });

  it("reads past comments but keeps line numbers", () => {
    expect(linesOf(/<select\b/g, "/* a <select>\n spanning */\nconst a = 1;\n<select>")).toEqual([4]);
    expect(linesOf(/<button\b/g, 'const url = "https://x"; <button')).toEqual([1]);
  });
});
