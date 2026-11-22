# Languages

Tavi speaks English unless you choose another language. The first other
language is Bulgarian. This guide is for anyone who wants Tavi in their own
language, and for contributors who add words to Tavi or a new language to it.
It covers [choosing a language](#choosing-a-language), [what follows
it](#what-follows-the-language), and, for contributors, [how the language packs
are laid out](#how-the-language-packs-are-laid-out), [adding a
string](#adding-a-string), [the checks](#the-checks) and [adding a
language](#adding-a-language).

## Choosing a language

One language for the whole workspace: each part of Tavi follows it once that
part is translated ([what follows it](#what-follows-the-language)). English is
the default. `tavi onboard` asks for the language first on a first run (Enter
keeps English), and a full `tavi setup` asks again. In the canvas, Welcome has
the picker in its rail on every step, and Settings → General has it as
**Language**: a pick is saved and the page switches at once. On a workspace
with no language set yet, Welcome picks Bulgarian when it is the first of the
browser's languages that Tavi speaks (`bg` ahead of any `en`), and English
otherwise. An owner from before languages shows no picker. Change it any time with:

```bash
tavi config set workspace.locale bg
```

`tavi config set workspace.locale en` goes back to English, and
`tavi config get workspace.locale` says which one is set. A language Tavi does
not speak is refused with the value named (exit `2`). The setting is described
with the other workspace settings in [CONFIGURATION.md](CONFIGURATION.md#workspace-settings).

| Code | Language |
| :--- | :--- |
| `en` | English (the default) |
| `bg` | Български (Bulgarian) |

The canvas follows the owner's setting, so a change made in the terminal
reaches a page that is already open, and it draws every view again in the new
language. It also remembers the last language it showed in the
browser, so the next visit starts in that language before the owner answers.

## What follows the language

Tavi is being translated part by part, and each part follows the language as
it is translated. Anything not yet translated stays in English.

| Part | Follows the language |
| :--- | :--- |
| Days, months and dates in the canvas | Yes: "вт, 29 сеп", "ноември 2026 г." |
| Counts in the canvas | Yes: "20 000" in Bulgarian, "20,000" in English |
| The canvas's own words | As each view is translated |
| The terminal chat (`tavi chat`) | As its screens are translated |
| Chat replies, channel messages and reports | As each is translated |
| CLI `--help`, usage errors and `--format json` | No: they stay in English, since scripts read them |
| These docs | No: they are written in English |

A plugin's own words come from the plugin, in the languages its author wrote.

## How the language packs are laid out

Words are kept in catalogues, one per namespace and language, typed against
English so a missing or misspelt key fails the typecheck:

| Namespace | English | Bulgarian | Used by |
| :--- | :--- | :--- | :--- |
| `core` | `packages/contracts/src/locales/core-en.ts` | `core-bg.ts` beside it | Weekdays, months and date patterns, used by the canvas so far |
| `ui` | `apps/ui/src/locales/en.ts` | `bg.ts` beside it | The canvas |

`@tavi/contracts/i18n` holds the machinery: the list of languages
(`SUPPORTED_LOCALES`, `LOCALE_NAMES`), plural messages chosen with
`Intl.PluralRules`, `{param}` filling, numbers grouped the language's way, and
`createTranslator`, which falls back to English for a key a language lacks and
to the key itself for one English lacks. The canvas loads English with the
page and every other language in its own chunk, only when the workspace speaks
it.

## Adding a string

1. Add the key to the English catalogue. Keys read `feature.place.purpose`,
   such as `settings.language.hint`.
2. Add the same key to every other language's catalogue. The typecheck fails
   until each has it.
3. In a canvas view, read it with `useT()`: `t("settings.language.hint")`.
   Outside React, `translateNow` reads the `ui` words and `translateCore` the
   `core` ones.

A count is a plural message, one form per plural category the language has:

```ts
"center.todos.count": { one: "{count} to-do", other: "{count} to-dos" },
```

Bulgarian is written as people speak it, not translated word for word: "ти",
short imperatives on buttons ("Запази", not "Запазете"), sentence case,
„…“ quotes, lowercase weekdays and months, and "г." after a year.

## The checks

`tests/i18n-catalogues.test.ts` checks every language pack:

- every key and parameter English has, and no parameter English does not
  supply;
- Bulgarian as Bulgarian is written: „…‚…‘…“ quotes and no straight ones, no
  word mixing Cyrillic and Latin letters, sentence case, and none of the
  common calques ("кликни", "успешно запазен", "базиран на").

It also counts the words still written inline in the canvas's views, per
folder, against `tests/fixtures/i18n-ratchet.json`. The count may only go
down: a new view puts its words in the catalogue from the start. After moving
words into a catalogue, lower the ratchet with:

```bash
UPDATE_I18N_RATCHET=1 pnpm exec vitest run tests/i18n-catalogues.test.ts
```

### The overflow walk

Bulgarian runs longer than English, so every screen is also checked in a real
browser: `tests/integration/overflow.bg.real.test.ts` opens each canvas route
in Bulgarian and in the stretched `qps` pseudo-locale (every word about half
again as long, bracketed), at 375, 768 and 1440 pixels wide, light and dark,
and runs `apps/ui/scripts/overflow-probe.js` on it. The probe lists words that
spill out of their box, labels an ellipsis cuts, buttons whose words break
across lines, controls that overlap, and a page that scrolls sideways. It
needs a build and a browser, so it runs only with the real tests:

```bash
pnpm run build
TAVI_REAL_TESTS=1 pnpm exec vitest run tests/integration/overflow.bg.real.test.ts
```

Every finding goes to `plans/qa/overflow-bg.json`, with a picture of its
screen beside it. The test fails on any finding not in
`tests/fixtures/overflow-allow.json`, whose entries each say why that wrap or
cut is meant. To see the pseudo-locale by hand, set `tavi.pseudoLocale` to
`1` in the page's local storage and reload; a word still written inline in a
view then shows without brackets.

## Adding a language

1. Add its code to `SUPPORTED_LOCALES`, its own name to `LOCALE_NAMES` and its
   `Intl` locale to `INTL_LOCALE` in `packages/contracts/src/i18n.ts`.
2. Write `core-<code>.ts` beside `core-en.ts` and export it from
   `packages/contracts` (`package.json` `exports` and `publishConfig.exports`,
   and the `tsdown` entry).
3. Write `apps/ui/src/locales/<code>.ts`, typed with
   `satisfies CatalogFor<typeof en>`, and add a loader for it in
   `apps/ui/src/lib/i18n.ts`.
4. Check the faces cover its script: Inter for text, Bricolage for titles.
   Where Bricolage does not (Cyrillic), set `--font-display` for the language
   under `:root:lang(<code>)` in `apps/ui/src/styles/tokens.css`, as Bulgarian
   does with Onest.
5. In `tests/i18n-catalogues.test.ts`, give each `NAMESPACES` entry the new
   language's catalogue and check it in the two language-pack tests, with style
   rules of its own if the language has them.
6. List it where the languages are written out by hand: the `workspace.locale`
   help in `apps/cli/src/features/config/parse.ts`, the onboarding question's
   label ("Language / Език") in `apps/cli/src/features/onboard/steps.ts`, its row in
   [CONFIGURATION.md](CONFIGURATION.md#workspace-settings), and the table at the
   top of this guide.
