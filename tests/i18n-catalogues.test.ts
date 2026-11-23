import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

import type { Catalog, Message } from "@tavi/contracts/i18n";
import { CORE_BG } from "@tavi/contracts/locales/core-bg";
import { CORE_EN } from "@tavi/contracts/locales/core-en";

import { bg as UI_BG } from "../apps/ui/src/locales/bg.js";
import { en as UI_EN } from "../apps/ui/src/locales/en.js";
import { ideas as IDEAS_BG } from "../packages/plugin-kit/src/ideas/locales/bg.js";
import { ideas as IDEAS_EN } from "../packages/plugin-kit/src/ideas/locales/en.js";

/**
 * The language packs: every namespace's catalogue in another language has
 * English's keys and parameters, and its Bulgarian reads as Bulgarian is
 * written (quotes, one script per word, sentence case, no calques). And the
 * canvas's words still written inline in its views are counted per folder
 * against a ratchet that only goes down, so a new view is written through the
 * catalogue from the start.
 *
 * `UPDATE_I18N_RATCHET=1 pnpm exec vitest run tests/i18n-catalogues.test.ts`
 * writes the counts after strings move into a catalogue.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each namespace: its English source and its other languages' catalogues. */
const NAMESPACES: readonly { readonly name: string; readonly en: Catalog; readonly bg: Catalog }[] = [
  { name: "core", en: CORE_EN, bg: CORE_BG },
  { name: "ui", en: UI_EN, bg: UI_BG },
  { name: "ideas", en: IDEAS_EN, bg: IDEAS_BG },
];

const PARAMETER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function forms(message: Message): readonly string[] {
  return typeof message === "string" ? [message] : Object.values(message).filter((form): form is string => typeof form === "string");
}

function parametersOf(message: Message): ReadonlySet<string> {
  const names = new Set<string>();
  for (const form of forms(message)) for (const match of form.matchAll(PARAMETER)) names.add(match[1] ?? "");
  return names;
}

/**
 * Parameters a key's caller always supplies whether English uses them or not,
 * so another language may write a day its own way ("сряда, 30 септември" with
 * the full month where English has "Wed 30 Sep").
 */
function suppliedFor(key: string): ReadonlySet<string> {
  return key.startsWith("date.") ? new Set(["day", "weekday", "weekdayShort", "month", "monthShort"]) : new Set();
}

/**
 * The parameter differences between a key's English and its translation: one
 * the caller does not supply, or one English needs that the translation drops.
 */
function parameterProblems(key: string, english: Message, translated: Message): string[] {
  const supplied = suppliedFor(key);
  const ours = parametersOf(translated);
  const theirs = parametersOf(english);
  return [
    ...[...ours].filter((name) => !theirs.has(name) && !supplied.has(name)).map((name) => `${key}: {${name}} is not supplied`),
    ...[...theirs].filter((name) => !ours.has(name) && !supplied.has(name)).map((name) => `${key}: {${name}} is dropped`),
  ];
}

/** Bulgarian quotes nest „outer ‚inner‘ outer“: a „ opened inside an open „…“ reads as a broken quotation. */
function nestedLowQuotes(text: string): boolean {
  let open = 0;
  for (const character of text) {
    if (character === "„") {
      open += 1;
      if (open > 1) return true;
    } else if (character === "“") open = Math.max(0, open - 1);
  }
  return false;
}

/** A word with Cyrillic and Latin letters in it: a Latin "a", "o" or "e" typed among Cyrillic ones. */
const MIXED_SCRIPT = /[\p{Script=Cyrillic}][\p{Script=Latin}]|[\p{Script=Latin}][\p{Script=Cyrillic}]/u;

/** Names written with a capital wherever they stand, so the sentence-case check passes them. */
const PROPER_NOUNS: ReadonlySet<string> = new Set([
  "България",
  "София",
  // Places and names the plugin packs write: each word of a name is capitalised.
  "Великобритания",
  "Германия",
  "Йорк",
  "Канада",
  "Корея",
  "Нов",
  "Норвегия",
  "Ню",
  "Тасмания",
  "Тексас",
  "Уелс",
  "Уикипедия",
  "Южен",
]);

/** Capitalised Cyrillic words past a sentence's start: Bulgarian writes sentence case, never Title Case. */
function titleCased(text: string): boolean {
  // A menu path is written as on screen, each item capitalised: "Настройки → Модели".
  const body = text.replace(PARAMETER, "x").replace(/\p{Lu}\p{Ll}*(?:\s+\p{Ll}+)*(?:\s*→\s*\p{Lu}\p{Ll}*(?:\s+\p{Ll}+)*)+/gu, "x");
  const words = [...body.matchAll(/(^|[.!?:„(…]\s*|\n\s*|\s)(\p{Lu}[\p{Ll}]+)/gu)].filter(
    (match) =>
      /\p{Script=Cyrillic}/u.test(match[2] ?? "") && !PROPER_NOUNS.has(match[2] ?? "") && !/^$|[.!?:„(…]\s*$|\n\s*$/.test(match[1] ?? ""),
  );
  return words.length > 0;
}

/** Quotation marks other languages use: Bulgarian quotes with „…“ and ‚…‘, and writes ’ for an apostrophe. */
const FOREIGN_QUOTES = /["'”«»]/u;

/** Wordings a Bulgarian reader sees as translated from English, with what to write instead. */
const CALQUES: readonly { readonly pattern: RegExp; readonly instead: string }[] = [
  { pattern: /кликн/iu, instead: "натисни" },
  { pattern: /моля,\s+натисн/iu, instead: "the imperative alone: „Натисни …“" },
  { pattern: /да се извърши/iu, instead: "a verb: „изпълни“" },
  { pattern: /успешно (запазен|изтрит|изпратен|създаден)/iu, instead: "„запазено“, without „успешно“" },
  { pattern: /имплементир/iu, instead: "„правя“, „въвеждам“" },
  { pattern: /базиран на/iu, instead: "„според“, „на база“" },
  { pattern: /направи сигурно/iu, instead: "„провери“" },
];

/**
 * A count followed by a word it must agree with ("{count} файла", "1 файла" when it is 1), in a plain string: write
 * it as a `{ one, other }` message. A word that does not agree with the count ("{count} от {total}", "+{count} още")
 * passes.
 */
const COUNTED_WORD = /\{(?:count|n)\}[  ](?!(?:от|още|до|ч|мин|сек|д|Б|КБ|МБ|ГБ|мс|км)(?!\p{L}))\p{Script=Cyrillic}/u;

/** Plain strings whose count is never 1: a fixed limit or a threshold above it, or a position rather than a count. */
const NEVER_ONE: ReadonlySet<string> = new Set([
  "schedule.paused.failures",
  "error.mcp.tooManyTools",
  "notice.schedule.paused.text",
  "channel.approval.stdinLong",
  "channel.review.screenshots",
  "channel.review.files",
  "channel.memory.card.forgetUndoes",
  "channel.heartbeat.alert.failures",
  "channel.schedule.alert.watchBackoff",
  "tui.form.tooMany",
  "tui.card.stdinLong",
  "ui.cadence.nextRuns",
  "chatPanel.folder.atMost",
  "center.recurring.firstRoutines",
  "center.recurring.firstSchedules",
  "center.reminders.noticesMax",
  "center.reminderRows.doneCount",
  "center.heartbeatTargets.full",
  "center.soul.count",
]);

/**
 * A number and its unit ("80 знака", "5 мин"), or "1" and the word after it ("1 човек"), with a plain space between,
 * where a no-break space keeps them on one line. A counted noun after another number keeps its plain space ("5 файла").
 * A digit that ends a name (sha256, SHA-256) or a time (9:00) is not a number standing alone, and a range ("от 1 до 5")
 * is not a number and its word.
 */
const SPLIT_NUMBER =
  /(?<![\p{L}\d.,:-])(?:1 (?!до )\p{Script=Cyrillic}|\d+ (?:ч|мин|сек|д|дни|часа|минути|секунди|знака|Б|КБ|МБ|ГБ|мс|км)(?!\p{L}))/u;

/** The section 2a rules a Bulgarian catalogue breaks, one line per key and rule. */
function styleProblems(catalog: Catalog): string[] {
  const problems: string[] = [];
  for (const [key, message] of Object.entries(catalog))
    for (const form of forms(message)) {
      if (nestedLowQuotes(form)) problems.push(`${key}: „ opened inside „…“`);
      if (FOREIGN_QUOTES.test(form)) problems.push(`${key}: quote with „…“, not ", ', ” or «»`);
      if (MIXED_SCRIPT.test(form)) problems.push(`${key}: a word mixes Cyrillic and Latin letters`);
      if (titleCased(form)) problems.push(`${key}: Title Case; write sentence case`);
      for (const calque of CALQUES) if (calque.pattern.test(form)) problems.push(`${key}: write ${calque.instead}`);
      if (typeof message === "string" && COUNTED_WORD.test(form) && !NEVER_ONE.has(key))
        problems.push(`${key}: a count and the word that agrees with it; write { one, other }`);
      if (SPLIT_NUMBER.test(form)) problems.push(`${key}: a no-break space after a number keeps it with its word`);
    }
  return problems;
}

/** The folders that hold plugins, two levels down from the root: `packages/external/discord`, `examples/plugins/acme-onboarding`. */
const PLUGIN_ROOTS = ["packages", "examples"] as const;

/**
 * Every plugin's Bulgarian pack (`<plugin>/locales/bg.json`), its manifest
 * words and its messages as one catalogue (`manifest.<field>`, `messages.<key>`).
 */
function pluginPacks(): readonly { readonly path: string; readonly catalog: Catalog }[] {
  const packs: { path: string; catalog: Catalog }[] = [];
  for (const top of PLUGIN_ROOTS)
    for (const group of readdirSync(join(root, top), { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      for (const plugin of readdirSync(join(root, top, group.name), { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const path = join(top, group.name, plugin.name, "locales", "bg.json");
        let text: string;
        try {
          text = readFileSync(join(root, path), "utf8");
        } catch {
          continue;
        }
        const pack = JSON.parse(text) as { readonly manifest?: Record<string, Message>; readonly messages?: Record<string, Message> };
        const catalog: Record<string, Message> = {};
        for (const [key, value] of Object.entries(pack.manifest ?? {})) catalog[`manifest.${key}`] = value;
        for (const [key, value] of Object.entries(pack.messages ?? {})) catalog[`messages.${key}`] = value;
        packs.push({ path: path.split(sep).join("/"), catalog });
      }
    }
  return packs.sort((a, b) => a.path.localeCompare(b.path));
}

describe("language packs", () => {
  for (const namespace of NAMESPACES) {
    it(`gives "${namespace.name}" in Bulgarian every key and parameter English has`, () => {
      expect(Object.keys(namespace.bg).sort()).toEqual(Object.keys(namespace.en).sort());
      const problems: string[] = [];
      for (const [key, english] of Object.entries(namespace.en)) {
        const bulgarian = namespace.bg[key];
        if (bulgarian === undefined) continue;
        if (typeof bulgarian !== typeof english) problems.push(`${key}: a plural in one language and not the other`);
        problems.push(...parameterProblems(key, english, bulgarian));
      }
      expect(problems).toEqual([]);
    });

    it(`writes "${namespace.name}" in Bulgarian as Bulgarian is written`, () => {
      expect(styleProblems(namespace.bg)).toEqual([]);
    });
  }

  for (const pack of pluginPacks())
    it(`writes ${pack.path} as Bulgarian is written`, () => {
      expect(styleProblems(pack.catalog)).toEqual([]);
    });

  it("finds every plugin's Bulgarian pack", () => {
    const paths = pluginPacks().map((pack) => pack.path);
    expect(paths).toContain("packages/external/discord/locales/bg.json");
    expect(paths).toContain("packages/builtin/browser-view/locales/bg.json");
    expect(paths).toContain("examples/ui-plugins/minimal-browser-view/locales/bg.json");
  });

  it("catches each rule it states", () => {
    expect(nestedLowQuotes("„едно „друго“ “")).toBe(true);
    expect(nestedLowQuotes("„едно ‚друго‘ още“")).toBe(false);
    expect(MIXED_SCRIPT.test("Зaпази")).toBe(true);
    expect(MIXED_SCRIPT.test("Запази в Telegram")).toBe(false);
    expect(titleCased("Запази Промените")).toBe(true);
    expect(titleCased("Запази промените. Готово: Да")).toBe(false);
    expect(titleCased("Отвори „Настройки“")).toBe(false);
    expect(titleCased("Готово… Да")).toBe(false);
    expect(titleCased("Първи ред\nВтори ред")).toBe(false);
    expect(titleCased("Пише в България")).toBe(false);
    expect(titleCased("Отвори Настройки → Свързани приложения.")).toBe(false);
    expect(titleCased("Отвори Настройки и Модели")).toBe(true);
    expect(FOREIGN_QUOTES.test("Отвори «Настройки»")).toBe(true);
    expect(FOREIGN_QUOTES.test("Отвори “Настройки”")).toBe(true);
    expect(FOREIGN_QUOTES.test("Отвори „Настройки“")).toBe(false);
    expect(CALQUES.some((calque) => calque.pattern.test("Кликнете тук"))).toBe(true);
    expect(COUNTED_WORD.test("{count} файла")).toBe(true);
    expect(COUNTED_WORD.test("{n} чакат")).toBe(true);
    expect(COUNTED_WORD.test("{count} от {total}")).toBe(false);
    expect(COUNTED_WORD.test("+{count} още")).toBe(false);
    expect(SPLIT_NUMBER.test("най-много 80 знака")).toBe(true);
    expect(SPLIT_NUMBER.test("още 1 човек")).toBe(true);
    expect(SPLIT_NUMBER.test("най-много 80\u00a0знака")).toBe(false);
    expect(SPLIT_NUMBER.test("sha256 {hash}, SHA-256 не съвпада, в 9:00 да")).toBe(false);
    expect(SPLIT_NUMBER.test("250 търсения на месец, до 20 от тях")).toBe(false);
    expect(SPLIT_NUMBER.test("Напиши число от 1 до {n}.")).toBe(false);
    expect(COUNTED_WORD.test("{n}\u00a0мин")).toBe(false);
    expect(parameterProblems("tasks", "{count} tasks", "{n} задачи")).toEqual(["tasks: {n} is not supplied", "tasks: {count} is dropped"]);
    expect(parameterProblems("date.longDay", "{weekday} {day} {monthShort}", "{weekday}, {day} {month}")).toEqual([]);
  });
});

// ------------------------------------------------------------------ the canvas's inline words

const UI_SOURCE = join(root, "apps", "ui", "src");
const RATCHET = join(root, "tests", "fixtures", "i18n-ratchet.json");

/** Two letters in a row: a word, not punctuation or a lone symbol. */
const WORD = /\p{L}{2}/u;
/** The attributes a person reads or hears. */
const READ_ATTRIBUTES: ReadonlySet<string> = new Set(["aria-label", "title", "placeholder", "alt", "label"]);
/** Elements whose text is code, typed and copied as shown in every language: `<Command>` renders a `<code>`. */
const CODE_ELEMENTS: ReadonlySet<string> = new Set(["code", "kbd", "Command"]);
/** Names every language writes the same: brands, and an abbreviation no language spells out. */
const NAMES: ReadonlySet<string> = new Set([
  "Tavi",
  "tavi",
  "ChatGPT",
  "Todoist",
  "SerpApi",
  "Rhumb",
  "Telegram",
  "Discord",
  "Gmail",
  "Mailgun",
  "Ollama",
  "OpenRouter",
  "URL",
]);

/**
 * Text that is not words to translate: a name from `NAMES`, or every word of it
 * code (an address, a path, a dotted setting, a package: it has `.`, `/`, `@`,
 * `:` or `*`). A placeholder that is one lowercase identifier is an example
 * value the field only accepts in ASCII (a slug such as `docs`).
 */
function untranslatable(text: string, attribute?: string): boolean {
  const trimmed = text.trim();
  if (NAMES.has(trimmed)) return true;
  if (attribute === "placeholder" && /^[a-z][a-z0-9-]*$/.test(trimmed)) return true;
  return trimmed.split(/\s+/).every((token) => /[./@:*]/.test(token));
}

/**
 * The words a `.tsx` source writes inline, counted from its syntax tree: each
 * JSX text with a word in it (beside an `{expression}` too), and each read
 * attribute given a string with a word in it, quoted or in braces. Text inside
 * `<code>`, `<kbd>` or `<Command>`, inside an `aria-hidden` mark (its name is
 * said by text beside it), and text `untranslatable` names are not counted.
 */
function inlineWords(name: string, source: string): number {
  let found = 0;
  const visit = (node: unknown, skipped: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, skipped);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as {
      readonly type?: unknown;
      readonly value?: unknown;
      readonly name?: { readonly name?: unknown };
      readonly openingElement?: { readonly name?: { readonly name?: unknown }; readonly attributes?: readonly unknown[] };
    };
    let skip = skipped;
    if (record.type === "JSXElement") {
      const opening = record.openingElement;
      const element = opening?.name?.name;
      const hidden = (opening?.attributes ?? []).some((attribute) => {
        const a = attribute as { readonly name?: { readonly name?: unknown }; readonly value?: { readonly value?: unknown } | null };
        return a.name?.name === "aria-hidden" && a.value?.value === "true";
      });
      if ((typeof element === "string" && CODE_ELEMENTS.has(element)) || hidden) skip = true;
    }
    if (!skip && record.type === "JSXText" && typeof record.value === "string" && WORD.test(record.value) && !untranslatable(record.value))
      found += 1;
    if (!skip && record.type === "JSXAttribute" && typeof record.name?.name === "string" && READ_ATTRIBUTES.has(record.name.name)) {
      const value = record.value as {
        readonly type?: unknown;
        readonly value?: unknown;
        readonly expression?: { readonly type?: unknown; readonly value?: unknown };
      } | null;
      const text = value?.type === "Literal" ? value.value : value?.expression?.type === "Literal" ? value.expression.value : undefined;
      if (typeof text === "string" && WORD.test(text) && !untranslatable(text, record.name.name)) found += 1;
    }
    for (const child of Object.values(node)) if (child !== null && typeof child === "object") visit(child, skip);
  };
  visit(parseSync(name, source).program, false);
  return found;
}

/** The folder a source counts under: `features/<name>`, `ui`, `lib`, or `app` for the files at the root. */
function folderOf(path: string): string {
  const parts = relative(UI_SOURCE, path).split(sep);
  if (parts[0] === "features") return `features/${parts[1] ?? ""}`;
  return parts.length === 1 ? "app" : (parts[0] ?? "");
}

function inlineCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of readdirSync(UI_SOURCE, { recursive: true }) as string[]) {
    if (!name.endsWith(".tsx")) continue;
    const path = join(UI_SOURCE, name);
    const found = inlineWords(name, readFileSync(path, "utf8"));
    if (found === 0) continue;
    const folder = folderOf(path);
    counts[folder] = (counts[folder] ?? 0) + found;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

describe("the canvas's inline words", () => {
  it("counts the words a person reads, and no code", () => {
    expect(inlineWords("a.tsx", 'const x = useState<string>("a"); const y = a < b ? (c) : d > e;')).toBe(0);
    // Each run of text beside an expression counts: "You have " and " items".
    expect(inlineWords("a.tsx", "const x = <p>You have {n} items</p>;")).toBe(2);
    expect(inlineWords("a.tsx", 'const x = <i title=\'Close\' aria-label={"Open menu"} className="two words" />;')).toBe(2);
    expect(inlineWords("a.tsx", 'const x = <p>{t("k")} · {n}</p>; // a comment with words')).toBe(0);
  });

  it("does not count code, names or a decorative mark", () => {
    expect(inlineWords("a.tsx", "const x = <p><code>tavi serve</code> <kbd>Enter</kbd> <Command>tavi ui</Command></p>;")).toBe(0);
    expect(inlineWords("a.tsx", 'const x = <p><span aria-hidden="true">tav</span> <a>Rhumb</a> <h2>Todoist</h2></p>;')).toBe(0);
    expect(inlineWords("a.tsx", 'const x = <i placeholder="https://host/v1" title="ann@example.com, @example.org" />;')).toBe(0);
    expect(inlineWords("a.tsx", 'const x = <i placeholder="docs" />;')).toBe(0);
    // A sentence beside code still counts, and so does a sentence naming a brand.
    expect(inlineWords("a.tsx", "const x = <p>Run <code>tavi serve</code> first</p>;")).toBe(2);
    expect(inlineWords("a.tsx", 'const x = <i title="Open Todoist" aria-label="Close" />;')).toBe(2);
  });

  it("count no more than the ratchet allows, and the ratchet follows them down", () => {
    const counts = inlineCounts();
    if (process.env["UPDATE_I18N_RATCHET"] === "1") {
      // A folder that reached 0 keeps its row at 0, so the fixture shows the folders the ratchet has closed.
      const before = JSON.parse(readFileSync(RATCHET, "utf8")) as Record<string, number>;
      const kept = Object.fromEntries(Object.keys(before).map((folder) => [folder, 0]));
      const written = Object.fromEntries(Object.entries({ ...kept, ...counts }).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(RATCHET, `${JSON.stringify(written, null, 2)}\n`);
    }
    const ratchet = JSON.parse(readFileSync(RATCHET, "utf8")) as Record<string, number>;
    const grown = Object.entries(counts).filter(([folder, count]) => count > (ratchet[folder] ?? 0));
    expect(grown, "new words written inline: put them in apps/ui/src/locales/en.ts and bg.ts").toEqual([]);
    const shrunk = Object.entries(ratchet).filter(([folder, count]) => (counts[folder] ?? 0) < count);
    expect(shrunk, "fewer inline words than the ratchet: run with UPDATE_I18N_RATCHET=1 to lower it").toEqual([]);
  });
});
