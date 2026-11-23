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

The canvas follows the owner's setting. Every write of a workspace's settings
(the picker, `tavi config set`, onboarding, a save in another tab) wakes the
feed of each open page, which reads the language again and draws every view in
it. The canvas also remembers the last language it showed in the browser, so
the next visit starts in that language before the owner answers. `tavi chat`
reads the language again while it runs, so a change reaches an open chat
within seconds; lines already shown stay as they were.

## What follows the language

Each part of Tavi follows the language as it is translated. A few corners are
still in English, and each section below names them.

| Part | Follows the language |
| :--- | :--- |
| Days, months and dates in the canvas | Yes: "вт, 29 сеп", "ноември 2026 г." |
| Counts in the canvas | Yes: "20 000" in Bulgarian, "20,000" in English |
| The canvas's own words | Yes |
| Setup's steps: each step's state, Tavi's own steps, a model check's advice, why a plugin's steps were not used | Yes, in the canvas; a setup plugin is told the language and chooses its own words |
| The terminal: `tavi chat`, onboarding, confirms and the text output of most commands | Yes ([the terminal](#the-terminal)) |
| Messages to chat apps, the agent's replies and routine reports | Yes |
| Plugins | Built-ins yes; another plugin as far as its language packs go |
| CLI `--help`, usage errors, stderr, logs and `--format json` | No: they stay in English, since scripts read them |
| What a model reads: the agent's instructions, tool descriptions, routine prompts | No: always English |
| These docs | No: they are written in English |

A plugin's own words come from the plugin, in the languages its author wrote.
A plugin can ship its own language packs: `locales/<lang>.json`, declared in
its manifest under `locales` (manifest `schemaVersion: 3`). A pack translates
the words of the manifest a person reads (its name and description, settings
labels, Connected apps entries, channel setup, canvas panel titles) and carries
the plugin's own messages for its code (`ctx.t`). Tavi shows those words in the
workspace's language on the canvas; `tavi plugins list` and `show` say their
own words in it, but show a plugin's manifest words in English. A canvas page
names its workspace when it reads the plugin list and the channel catalogue, so
on a workspace other than the default one, plugin names, channel setup and
plugin panels speak that workspace's language. What the model reads (tool
descriptions, MCP text, routine prompts) is never translated: a pack that tries is refused at install. Packs are part of
the plugin version's reviewed files, so changing one is a new version to
approve, and a pack changed on disk after approval is never shown. A running
plugin hears a language change at once (`ctx.locale`), with no restart.
`ctx.locale` is the language of the owner's default workspace: a plugin that
serves several workspaces (a Discord bot bound to another one, say) speaks the
default's language in all of them.
`tavi plugins validate` checks every pack as install does and counts, for each
language, how many of the manifest's words and messages it translates;
[Translating your plugin](PLUGINS.md#translating-your-plugin) is the author's guide.
A plugin's canvas panels hear the language too: a panel is told the canvas's
language and handed the plugin's own words in it when it starts, and a language
change reaches an open panel at once, with no reload. The words come only from
the approved version's files, or from what the canvas build shipped for a
built-in. The built-in browser view speaks Bulgarian this way: its status chip,
notices, buttons and what it announces to a screen reader. A plugin that
ignores the language keeps its English. The example
[`minimal-browser-view`](../examples/ui-plugins/minimal-browser-view/) shows the
smallest panel that does this.

Tavi's built-in plugins speak the workspace's language through the `plugins`
part of the core catalogue: each built-in's description in the canvas's plugin
list, the built-in onboarding flow, the setup words of the Telegram, Gmail and
Mailgun channels, the guard's hook disclosure and the reason on its approval
card, the flight search's approval card (in the language of the workspace the
search runs in), and the frame of the daily brief's PDF.
The Discord, Jobs, Trends, Places and Places: health plugins ship Bulgarian
language packs; Discord's status and setup notes in Settings → Channels come
from its pack. The MCP presets (Discover, each preset's page, its key and the
steps to get one) and the setup steps of Google's shared client are in the
`presets` part of the core catalogue. A third-party console's buttons and
menus are named as that console shows them. What the model reads (tool descriptions, tool answers and refusals, the guard's
unattended refusal) stays English, and so do a few words a pack cannot reach: a
Telegram bot check's lines, Mailgun's default subject and a channel app's setup
links.

Words Tavi stores in English and wrote itself (Home's default title, the
notes on Tavi's own permission rules, the Soul page's layer labels) are shown in
the workspace's language. Anything you renamed or wrote shows as written.

Approval cards are written in the workspace's language when the call is
assessed: the gate tells each tool's assessor the language, and the card's
title, detail and reasons are stored with the approval as they were said.
Cards stored before a change stay in the language they were stored in. What
the model reads about a call (a refusal, its risk) stays English. The Inbox's
provenance and channel labels follow the language in the canvas.

Connected apps say each repair (its button and why) in the workspace's
language. An empty Schedule's templates fill their forms in it, so a saved
reminder sends those words, and the heartbeat's suggestions are in it too.
An MCP server's question during a call is framed in the language, with its
buttons; the
server's own words are shown as it wrote them, and a yes or no button is read
in either language. Tavi's own slash commands are described in the language of
the workspace in use, and provider disclosures, the video disclosure and model
lifecycle warnings follow it too. What you are shown as having said (a
heartbeat item's "Do it" or "Chat about this", a reason for stopping a chat or
revoking a grant) is in the canvas's language.

The pages Tavi serves for a phone, an email's approval link page and a
channel's OAuth sign-in page, speak the workspace's language and set `lang`.
A link or sign-in that names no workspace uses the default workspace's
language. Still English: the ChatGPT, OpenRouter and MCP sign-in callback
pages, `tavi apps` text, why a routine's setup was refused, and plugin authors'
own text.

Errors a person reads carry the key of their sentence beside the English, so
the canvas, `tavi chat` and a chat app's command replies say them in the
reader's language: a value Tavi refuses, something that no longer exists, a
change someone else saved first, a folder, channel or connected app it cannot
use. An error with no key, or one from a newer server whose key this reader
does not know, is framed in the reader's language around its English
("Нещо се обърка: …"). The CLI's stderr, logs and `--format json` keep the
English message, and so does what the agent reads.

### The terminal

In a Bulgarian workspace the terminal speaks Bulgarian: `tavi chat`'s status
row, cards, panes and forms, approval and review cards, onboarding, the
`[Д/н]` confirms, the text output of `tavi tasks` (with each task's status),
`tavi reports`, `tavi heartbeat`, `tavi doctor`, `tavi onboard status`,
`tavi needs`, `tavi reminders`, `tavi schedules`, `tavi ideas`,
`tavi plugins list` and `show`, and `tavi channels pair`, the
`tavi tasks folders prune` plan and outcome, and `tavi models replace`. The
language is read from the owner's `workspace.locale` (or the data directory's
when no owner runs), English when it cannot be read. `tavi schedules` and
`tavi reminders` use the language of the workspace `--workspace` names;
`tavi plugins` uses the default workspace's.

Key hints read „д — одобри“, „н — откажи“, „Н — откажи с причина“, „ч — до края на този чат“
and „в — винаги (правило за работното пространство)“. The English keys
y/n/N/s/a keep working in either language, and a Bulgarian key never grants
more than its English twin; a yes or no is read as y/yes/д/да and n/no/н/не.
The status row under a round's card says the keys shorter („д — одобри,
ч — за чата, в — правило, н — откажи, Н — откажи с причина“), and the card
above it says them in full. When a Bulgarian row is too wide for the terminal,
it leaves out the round's number and then the group's hosts, never part of a
key. Any other Bulgarian status row is cut where a clause or word ends, keeping
a chat's private and taint marks. The text of `tavi heartbeat`, `tavi doctor`
and `tavi onboard status` wraps at spaces to the terminal's width, and is left
unwrapped in a pipe. Columns are measured in terminal cells, so Cyrillic and
wide characters stay aligned.

Onboarding asks the rest of its questions in the chosen language once that
choice is saved, and from then on speaks it throughout: its lines, the owner's
refusals, sign-in errors, a workspace setting's refusal and hybrid recall's
disclosure. A few lines stay English: the address to open in a browser, an
import's notes, a step's usage messages, the text output of
`tavi onboard provider` and `tavi onboard reset`, and field labels a plugin
supplies. The words live in the
`terminal` part of the `core` catalogue (`tui.*`, `prompt.*`, `cli.*`), and
onboarding's in `setup`. What the agent's `reminder_*` tools read back stays
English.

### Notices, chat apps and reports

Notices Tavi posts into a chat or Home (a scheduled run's result, a routine
that paused, a server that needs signing in again, the heartbeat's digest) and
a schedule's run history are stored with the key of each sentence beside its
English, so the canvas says them in the language set when you read them, not
the one set when they were posted. What a person or a run wrote (a routine's
name, a chat's title, a run's answer) is shown as it was written. Notices and
runs from before this release have no keys and show the English they were
stored in, and so does anything a newer release stored that this one does not
know. A schedule's cadence inside a notice or alert is said in the language
you read it in. Some details inside a notice are still in English: the cause a
server gives for needing to sign in again, and the causes of a schedule's
webhook or email trigger refusing a call. The agent reads notices in English.

Messages Tavi sends to a chat app speak the workspace's language: approval
requests with their buttons and receipts, questions and their choices, memory
cards and the `/memory` and `/forget` answers, the heartbeat's items, digest,
buttons and `/heartbeat` status, reminders with their Done and Snooze buttons,
the answer to `/new`, `/ideas` and the weekly ideas digest, a schedule's or
routine's alert, a server notice, the notice a busy group chat gets, a group
room's introduction, a channel's test message, the reply to mail from an
unverified sender, a plugin command's refusal, and the notice of a round that
was reset. Each is said in the language of the workspace whose chat it is.
Error details Tavi passes on as it got them (why a run failed, a provider's own
message) stay as they were written, and so does the subject of a test email. A
workspace whose language can't be read is answered in English.

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
`/tavi new` in every language. The bot's private replies to a command, its
status and its setup notes follow `ctx.locale`: the owner's default
workspace's language, read again on each answer.

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
what Tavi checks. The report's title, headings, labels, dates and coverage
gaps follow its language; the caveats on a single story (single-source
coverage, publisher independence, near-duplicate clustering) are still in
English. Routines created earlier keep theirs. A report can be in any language Tavi has a
pack for.

The built-in ideas come in each language Tavi has a pack for: their titles,
labels, pitches and prompts, and the words in your notes that bring an idea up.
Trigger words count in English and Bulgarian alike, whatever the workspace's
language. A built-in idea is shown in the language set when you read it, so
after a language change the Ideas tab, the chat's suggested prompts and *Try*
switch at once. An idea from a plugin, or one Tavi reworded, stays as it was
written until the next run writes it again.

Status words the canvas shows for codes the owner sends (the state of a
routine, run, delivery, schedule, reminder, plugin or worker; a run's mode and
network reach; a tool's effect; a review state) come from the canvas's own
catalogue. A code the canvas doesn't know yet is shown as the owner sent it.

## How the language packs are laid out

Words are kept in catalogues, one per namespace and language, typed against
English so a missing or misspelt key fails the typecheck:

| Namespace | English | Bulgarian | Used by |
| :--- | :--- | :--- | :--- |
| `core` | `packages/contracts/src/locales/core-en.ts`, from the parts in `en/` | `core-bg.ts`, from `bg/` | Every surface: the canvas (its parts only, `core-canvas-en.ts` / `core-canvas-bg.ts`), the terminal, the owner's messages to chat apps, the agent host |
| `ui` | `apps/ui/src/locales/en.ts`, from the parts in `en/` | `bg.ts`, from `bg/` | The canvas |
| `ideas` | `packages/plugin-kit/src/ideas/locales/en.ts` | `bg.ts` beside it | The built-in ideas, and Bulgarian trigger words |
| A plugin's own | its manifest, and `locales/en.json` for messages | `locales/bg.json` | That plugin ([Translating your plugin](PLUGINS.md#translating-your-plugin)) |

The `core` catalogue is assembled from parts, one file per part and language
in `packages/contracts/src/locales/{en,bg}/`. The canvas loads only the parts
it says (marked "canvas" below), from `core-canvas-en.ts` and
`core-canvas-bg.ts`; the server's own parts stay out of its bundle, and
`core-en.ts` / `core-bg.ts` add them for the owner and the terminal:

| Part | Its words |
| :--- | :--- |
| `date` (canvas) | Weekdays, months, date patterns and durations |
| `labels` (canvas) | Tool call titles, idea categories and capabilities, approval channels, tool groups |
| `safety` (canvas) | Provenance, why Tavi asked, shell and skill limits |
| `schedule` (canvas) | Schedules, reminders, routines and their cadence; memory cards and settings |
| `connect` (canvas) | What Tavi needs connected (apps, channels, models, plugins, the browser, the desktop), and what a mod's hooks read |
| `errors` (canvas) | Keyed errors and the generic frame (`error.generic`), a workspace setting's refusals |
| `notices` (canvas) | Notices in a chat or Home, a schedule's run outcomes, and a schedule's and the heartbeat's alerts |
| `onboarding` (canvas) | Onboarding's steps and their state, its refusals and sign-in errors |
| `nav` (canvas) | The canvas's routes and Settings views, which menu paths are built from |
| `agent` (canvas) | Words the agent's host says to a person (empty for now) |
| `reports` (canvas) | Language names, and routine reports and their PDF |
| `channels` | Messages to chat apps: approvals, questions, cards, digests, receipts |
| `terminal` | `tavi chat`, the prompts and the text output of the CLI |
| `plugins` | The built-ins' descriptions, channel setup, guard reasons, the flight card, the daily brief's PDF |
| `apps` (canvas) | Connected apps' repairs and MCP questions |
| `presets` | MCP presets and the shared OAuth clients' setup steps |
| `setup` | Onboarding's narration in the terminal |
| `pages` | The approval link and OAuth pages, slash command descriptions |

`@tavi/contracts/i18n` holds the machinery: the list of languages
(`SUPPORTED_LOCALES`, `LOCALE_NAMES`), plural messages chosen with
`Intl.PluralRules`, `{param}` filling, numbers grouped the language's way, and
`createTranslator`, which falls back to English for a key a language lacks and
to the key itself for one English lacks. The canvas loads English with the
page and every other language in its own chunk, only when the workspace speaks
it. The owner, the terminal and the agent host read every language at once
with `coreIn(locale)` from `@tavi/contracts/locales/core-server`.

The shared helpers in `@tavi/contracts` take the canvas's `core` words
(`CanvasCoreT`, from `@tavi/contracts/locales/core-canvas`), and so does
`textRef`: a word stored for later, or a keyed error, is one every surface can
read back, the canvas included. A key the canvas says that sits in a server
part fails the typecheck; move it to a canvas part, keeping its name and its
words. The owner and the terminal pass the whole catalogue (`coreIn`, or
`coreEnglish` from `@tavi/contracts/locales/core`), which holds those words too.

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
`CORE_CANVAS_EN` / `CORE_CANVAS_BG` in the canvas. `strayMenuPaths` checks a catalogue for
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
  word mixing Cyrillic and Latin letters, sentence case, none of the common
  calques ("кликни", "успешно запазен", "базиран на"), a `{ one, other }`
  message wherever a count meets a word that agrees with it, and a no-break
  space between a number and its unit.

The Bulgarian rules run over every plugin's `locales/bg.json` in `packages/`
and `examples/` too.

It also counts the words still written inline in the canvas's views, per
folder, against `tests/fixtures/i18n-ratchet.json`, where every folder is at
`0`. Text inside `<code>`, `<kbd>` or `<Command>` is not counted, nor a brand
name every language writes the same (Tavi, Todoist, Telegram and a few
others), an address, path or setting name, or a decorative mark whose name is
said beside it. The count may only go down: a new view puts its words in the
catalogue from the start. If words are ever moved out again, lower the
ratchet with:

```bash
UPDATE_I18N_RATCHET=1 pnpm exec vitest run tests/i18n-catalogues.test.ts
```

`tests/ui-bundle.test.ts` checks that no Bulgarian word is in the canvas's
first load, apart from the language picker's own "Български".

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
view then shows without brackets. The pseudo-locale is the canvas's only: it
is never a `workspace.locale`, and the owner, the terminal and chat apps have
none.

## Adding a language

1. Add its code to `SUPPORTED_LOCALES`, its own name to `LOCALE_NAMES` and its
   `Intl` locale to `INTL_LOCALE` in `packages/contracts/src/i18n.ts`, and its
   name key to `LANGUAGE_NAME_KEYS` in `packages/contracts/src/locales/core-canvas.ts`
   (with `reports.language.<code>` in every language's `reports` part).
2. Write the `core` parts in `packages/contracts/src/locales/<code>/`, one per
   part in `en/`, and `core-canvas-<code>.ts` and `core-<code>.ts` beside
   `core-canvas-en.ts` and `core-en.ts` to assemble them.
   Add it to `coreIn` in `core-server.ts`, and export both from
   `packages/contracts` (`package.json` `exports` and `publishConfig.exports`,
   and the `tsdown` entry).
3. Write the `ui` parts in `apps/ui/src/locales/<code>/` and
   `apps/ui/src/locales/<code>.ts`, typed with
   `satisfies CatalogFor<typeof en>`, and add a loader for it in
   `apps/ui/src/lib/i18n.ts`.
4. Write `packages/plugin-kit/src/ideas/locales/<code>.ts`, with its trigger
   words, and read it in `packages/plugin-kit/src/ideas/catalogue.ts`.
5. Teach memory the language: its relative dates in
   `packages/agent-host/src/context/retrieval-query.ts`, its sensitive words
   (passwords, PIN codes, health, beliefs, money, ID numbers, an address) in
   `packages/agent-host/src/memory/memory-capture.ts`, and its weekday and
   month names in the agent's local time line
   (`packages/agent-host/src/prompts/system-prompt.ts`).
6. Add the words people type back beside the Bulgarian ones: approvals and
   command words in chat apps (`apps/cli/src/features/channels/typed-words.ts`
   and the `/memory` and `/heartbeat` commands' own parsers), the terminal's
   keys and yes or no (`apps/cli/src/shared/terminal-words.ts`), and the
   Discord plugin's command names (`packages/external/discord/src/commands.ts`).
7. Check the faces cover its script: Inter for text, Bricolage for titles.
   Where Bricolage does not (Cyrillic), set `--font-display` for the language
   under `:root:lang(<code>)` in `apps/ui/src/styles/tokens.css`, as Bulgarian
   does with Onest.
8. In `tests/i18n-catalogues.test.ts`, give each `NAMESPACES` entry the new
   language's catalogue and check it in the two language-pack tests, with style
   rules of its own if the language has them.
9. List it where the languages are written out by hand: the `workspace.locale`
   help in `apps/cli/src/features/config/parse.ts`, the onboarding question's
   label ("Language / Език") in `apps/cli/src/features/onboard/steps.ts`, its row in
   [CONFIGURATION.md](CONFIGURATION.md#workspace-settings), and the table at the
   top of this guide.

Plugins can then ship `locales/<code>.json`: a manifest's `locales` accepts
every code in `SUPPORTED_LOCALES`. The built-in plugins with their own packs
(Discord, Jobs, Trends, Places, Places: health, the browser view) need a pack in
it to speak it.
