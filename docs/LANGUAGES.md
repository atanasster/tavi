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
| Setup's steps: each step's state, Tavi's own steps, a model check's advice, why a plugin's steps were not used | Yes, in the canvas; a setup plugin is told the language and chooses its own words |
| The terminal: `tavi chat`, onboarding, confirms and the text of status, doctor, reports, tasks and needs | Yes |
| Chat replies, channel messages and reports | As each is translated |
| CLI `--help`, usage errors and `--format json` | No: they stay in English, since scripts read them |
| These docs | No: they are written in English |

A plugin's own words come from the plugin, in the languages its author wrote.
A plugin can ship its own language packs: `locales/<lang>.json`, declared in
its manifest under `locales` (manifest `schemaVersion: 3`). A pack translates
the words of the manifest a person reads (its name and description, settings
labels, Connected apps entries, channel setup, canvas panel titles) and carries
the plugin's own messages for its code (`ctx.t`). Tavi shows those words in the
workspace's language on the canvas; the terminal's plugin listings stay
English. What the model reads (tool descriptions, MCP text, routine prompts) is
never translated: a pack that tries is refused at install. Packs are part of
the plugin version's reviewed files, so changing one is a new version to
approve, and a pack changed on disk after approval is never shown. A running
plugin hears a language change at once (`ctx.locale`), with no restart.

Errors Tavi's server sends the canvas for you to act on (a value it
refuses, something that no longer exists, a change someone else saved first,
a folder, channel or connected app it cannot use) carry the key of their
sentence beside the English, so the canvas shows them in your language. An
error with no key, or one from a newer server whose key this canvas does not
know, shows in English. The terminal, logs and `--format json` keep the
English message, and so does what the agent reads.

In a Bulgarian workspace the terminal speaks Bulgarian: `tavi chat`'s status
row, cards, panes and forms, approval and review cards, onboarding, the
`[Д/н]` confirms, the text output of `tavi tasks`, `tavi reports`,
`tavi heartbeat`, `tavi doctor`, `tavi onboard status` and `tavi needs`, the
`tavi tasks folders prune` plan and outcome, and `tavi models replace`. The
language is read from the owner's `workspace.locale` (or the data directory's
when no owner runs), English when it cannot be read. Key hints read
„д — одобри“, „н — откажи“, „Н — откажи с причина“, „ч — до края на този чат“
and „в — винаги (правило за работното пространство)“. The English keys
y/n/N/s/a keep working in either language, and a Bulgarian key never grants
more than its English twin; a yes or no is read as y/yes/д/да and n/no/н/не.
Onboarding asks the rest of its questions in the chosen language only once
that choice is saved. Some informational lines, field labels a plugin supplies,
preset notes and usage errors stay English. Columns are measured in terminal
cells, so Cyrillic and wide characters stay aligned. The words live in the
`terminal` part of the `core` catalogue (`tui.*`, `prompt.*`, `cli.*`).

Notices Tavi posts into a chat or Home (a scheduled run's result, a routine
that paused, a server that needs signing in again, the heartbeat's digest) and
a schedule's run history are stored with the key of each sentence beside its
English, so the canvas says them in the language set when you read them, not
the one set when they were posted. What a person or a run wrote (a routine's
name, a chat's title, a run's answer) is shown as it was written. Notices and
runs from before this release have no keys and show the English they were
stored in, and so does anything a newer release stored that this one does not
know. Some details inside a notice are still in English: why a server needs
signing in again, and why a schedule's webhook or email trigger refused a
call. The agent reads notices in English.

Messages Tavi sends to a chat app speak the workspace's language: approval
requests with their buttons and receipts, questions and their choices, memory
cards and the `/memory` and `/forget` answers, the heartbeat's items, digest,
buttons and `/heartbeat` status, reminders with their Done and Snooze buttons,
the answer to `/new`, `/ideas` and the weekly ideas digest, a schedule's or
routine's alert, a server notice, and the notice a busy group chat gets. Error
details Tavi passes on as it got them (why a run failed, a provider's own
message) stay as they were written. A workspace whose language can't be read is
answered in English.

What you type back is read in English and Bulgarian alike, whatever the
workspace's language: an approval as `одобри` or `разреши` (with `веднъж`,
`чат` or `сесия`, or `винаги`) and `откажи` or `отхвърли` with your reason, a
command's words as `/memory запази всички`, `/memory преглед`,
`/heartbeat пауза 2ч` (or `30мин`, `1д`, `2 часа`), `/heartbeat продължи` and
`/ideas обнови`, and a digest pick as `пробвай 2`. The commands' names stay
`/memory`, `/heartbeat` and `/ideas`, and the help lists the words of the
workspace's language.

On Discord, the `/tavi` command descriptions and the "Ask Tavi about this"
message menu carry Bulgarian names, which Discord shows to people whose Discord
app is set to Bulgarian. The commands themselves stay `/tavi ask` and
`/tavi new` in every language. The bot's private replies to a command will
follow the workspace's language once Tavi passes plugins the language; until
then they are in English.

The agent's own instructions stay in English. When the workspace's language
isn't English, the facts the agent reads each turn add one line asking it to
reply in that language unless the person writes in another, and give the local
time with that language's weekday and month names. The `tavi config` preview of
the system prompt shows them as the agent reads them. Memory recall understands
Bulgarian dates ("вчера", "миналата седмица", "преди 3 дни", "през март",
"от 2020 г.", "тази година"), and automatic memory capture recognises Bulgarian
passwords, PIN codes and sensitive topics (health, beliefs, money, ЕГН and other
ID numbers, a home address) the same way it recognises English ones.

Text a model writes follows the workspace's language too. Ideas Tavi rewords
for you are written in it, and a reminder an idea promises is kept whichever
language it's written in. Activity summaries use the language of the chat, and
the workspace's language when that isn't clear. A routine set up after you
choose a language writes its report in it: story titles are in your language,
while each claim stays the exact sentence from its source page, because that is
what Tavi checks. The report's headings, labels and dates follow its language.
Routines created earlier keep theirs. A report can be in any language Tavi has a
pack for.

The built-in ideas come in each language Tavi has a pack for: their titles,
labels, pitches and prompts, and the words in your notes that bring an idea up.
Trigger words count in English and Bulgarian alike, whatever the workspace's
language. Ideas are stored in the language they were written in, so after a
language change they switch at the next run. An idea from a plugin, or one Tavi
reworded, stays as it was written.

Status words the canvas shows for codes the owner sends (the state of a
routine, run, delivery, schedule, reminder, plugin or worker; a run's mode and
network reach; a tool's effect; a review state) come from the canvas's own
catalogue. A code the canvas doesn't know yet is shown as the owner sent it.

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

An error a person reads in the canvas is thrown with
`keyedError(code, "error.<area>.<purpose>", params)` from `@tavi/contracts`,
its words in `packages/contracts/src/locales/{en,bg}/errors.ts`. Its English
template is the message as the terminal shows it; data (a name, a path, a
count as text) goes in `params`. Errors only the agent or a developer reads
stay plain `TaviError`s.

A menu path in a message ("Settings → Models") is never written out: it is
built from the nav's own labels, the `nav.*` keys the canvas's routes read, with
`navPath(...)` in a message said at run time (`englishOf` for its English) or
`navPathIn(words, ...)` inside a catalogue's message, `words` being that
language's nav words: the part's own `./nav.js` in `@tavi/contracts`,
`CORE_EN` / `CORE_BG` in the canvas. `strayMenuPaths` checks a catalogue for
a path the nav does not have.

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

Two evals check the agent's language. `evals/reply-language` runs prompts in
English, in Bulgarian and with no letters at all (emoji only), in workspaces set
to `en` and `bg`. It checks that each reply is in the language the
reply-language line asks for: Bulgarian unless the person writes in another
language. The language is read from the reply's letters, so no judge model is
needed. `evals/ideas` has a Bulgarian world of each kind; the rewording there
must stay in Bulgarian and keep every `[placeholder]` the note leaves open,
exactly as the catalogue writes it. Both cost model tokens and are run by hand
(`node evals/reply-language/eval.ts --template …`). `pnpm test` checks their
cases offline, and `node evals/ideas/eval.ts --offline` costs nothing.

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
