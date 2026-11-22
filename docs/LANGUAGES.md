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
the default. Change it with:

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

## Adding a language

1. Add its code to `SUPPORTED_LOCALES`, its own name to `LOCALE_NAMES` and its
   `Intl` locale to `INTL_LOCALE` in `packages/contracts/src/i18n.ts`.
2. Write `core-<code>.ts` beside `core-en.ts` and export it from
   `packages/contracts` (`package.json` `exports` and `publishConfig.exports`,
   and the `tsdown` entry).
3. Write `apps/ui/src/locales/<code>.ts`, typed with
   `satisfies CatalogFor<typeof en>`, and add a loader for it in
   `apps/ui/src/lib/i18n.ts`.
4. In `tests/i18n-catalogues.test.ts`, give each `NAMESPACES` entry the new
   language's catalogue and check it in the two language-pack tests, with style
   rules of its own if the language has them.
5. List it where the languages are written out by hand: the `workspace.locale`
   help in `apps/cli/src/features/config/parse.ts`, its row in
   [CONFIGURATION.md](CONFIGURATION.md#workspace-settings), and the table at the
   top of this guide.
