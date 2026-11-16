# Changelog

All notable changes to Tavi are recorded here. The project follows
[Semantic Versioning](https://semver.org); before 1.0, a minor version may
change behaviour or stored data.

## Unreleased

### Changed

- The Node.js floor is now 22.22.2 (it was 22.21.0): the test toolchain's
  jsdom needs it, and `pnpm install` refuses an older Node.

### Fixed

- `tavi onboard`'s questions are drawn in a terminal where `CI` is set: Ink
  took that to mean "print only the last frame", so the prompt never showed.
- A plugin worker whose proxy CA came due for renewal while it was starting
  was stopped as soon as it was ready, failing the call that started it. That
  call is answered first, and the worker restarts after it.

## 0.1.0 — first release

The first release published under the MIT licence. Tavi runs from a clone of
this repository: there is no npm package.

### Added

- **A new look for the web canvas**: the Pine & Sun palette, Bricolage
  Grotesque as the display face, the sprout mark and wordmark, a floating
  composer, a greeting on a new chat, and small moments of motion.
- **Smarter schedules**: one cadence engine (several times a day, every N
  hours, monthly, yearly, once, until), cheap pre-checks that skip the model
  call when nothing changed, watchers, webhook triggers and email triggers,
  per-fire and monthly token budgets, retries for transient failures, a fire
  ledger, and notifications only when there is something to say. Schedules and
  routines can be created and changed from a chat, and "Repeat this…" turns a
  chat that worked into a draft.
- **To-dos** (`tavi todos`, the `todos.*` tools) that work with no setup and
  defer to a task app connected over MCP (`tasks.home`).
- **Skills**: importing Agent Skills packages, skills the agent proposes for
  review, on-demand loading (`skills.read`, `skills.search`), use counts, and
  `allowed-tools` as a ceiling, never a grant.
- **Experimental desktop control** on macOS (`tavi.desktop`, off until
  enabled).
- **Browser**: site recipes that can replay, site notes, long forms filled in
  one `browser.batch`, tabs, frames, downloads, page dialogs, an opt-in
  agent signature, and a model's own computer-use tool for acting by sight.
- **Memory**: forget and replace from a chat, past facts on request, recency
  and confirmation in recall ranking, and an always-in-context profile.
- **Models**: native Anthropic Messages connections, and provider failover
  when a stream stalls (`--first-byte-timeout`, `--idle-timeout`).
- **Tools**: `math.eval`, `artifacts.read`, paged `web_fetch`, a richer
  `http.request` and file tools, and `sandbox.run` lines approved command by
  command.
- The owner watches its own memory, descriptors and children; `tavi doctor`
  and the Activity view warn on sustained growth. Offline `tavi doctor` runs
  SQLite's quick integrity check, and the full one with `--deep`.
- A new data directory keeps its credential key in the OS keychain, so
  credentials are encrypted from the start; `tavi credentials key` moves it.

### Changed

- An idle owner sleeps until its next due work, and the Command Center updates
  on writes instead of polling.
- Image, document and video bodies sent to a model are kept between steps.
- Commands load their handlers only when they run; past-chat search, the
  database's hot queries and the web canvas's first load are faster.
- The lean tool layout is the default: rarely used families wait behind
  `tools.search` (`models.toolDeferral`).
- A Node.js older than 22 gets an upgrade message before the CLI loads, and
  `pnpm install` refuses it; the floor stays 22.21.0.
- **Settings** has its own grouped navigation (Workspace, Connections,
  Control) in the left column instead of a row of tabs.
- The Command Center shows "Coming up" once on Schedule; the heartbeat's
  on/off control is a switch.
- The chat composer grows with what you type; the footer strip names the model
  by its own name (`Model: gemini-3.8-flash`); a grouped approval offers
  **Allow once**, with its explanation behind "What does this allow?".
- Empty states say what is true: the chats list ("No chats yet", "No archived
  chats"), Connected apps, and Plugins, which folds its core built-ins under
  "Core (always on)".
- `tavi schedules agenda` and `tavi todos list` print aligned columns, the id
  last.
- Smaller fixes from the same review: a plugin nobody has approved says
  "awaits review" rather than "disabled" and "not composed"; a refused key,
  Welcome and Settings link to the provider's page for creating a key rather
  than its API reference; a chat's later turns no longer say "Continues chat"
  with an internal id; System prompt's Save says "use the shipped default"
  only when that is the change. A chat with no title and no prompt is
  "Untitled chat" (one replayed after a reload, "Earlier chat") in its header,
  the chats list and Activity, never its task id. A round `tavi run
  --approval deny` refused says "automatic denial (--approval deny)", in the
  terminal and the canvas, not "automatic approval".

### Fixed and hardened

- Turning a plugin off no longer leaves the model or the person pointed at it.
  `tavi.localmessaging` is core, since the terminal's and canvas's chats go
  through it. Flight search, `web_fetch`, `http.request`, site notes and
  desktop control name the browser's tools only while the browser is on.
  `tavi onboard` names no particular channel or app, and the built-in
  onboarding flow offers the installed channels when Telegram is not one of
  them. Settings → General and Settings → Models hide the browser, flight
  search and video settings while their plugin is off. A plugin tool can
  declare `requiresTools`, so a tool that needs the browser is offered only
  while the browser is on (jobs' `fill_plan`, trends' `profile` and `ingest`,
  places' `reconcile`).
- The shell approval reads command lines the way `/bin/sh` does, cross-checked
  by a second parser; home and root deletes are refused in every spelling.
- `http.request` dials only a pinned public address; the browser holds every
  approved call to its host, including frames on other sites.
- A Gmail sender is verified only by an aligned DKIM signature; channel
  ingress budgets are per address.
- Forgotten text leaves no bytes behind in the database or its write-ahead
  log.
- When the agent tried to close a browser session's last tab, the refusal named
  `browser.close_session`, a tool that does not exist; it names `browser.close`.
- `tavi projects --help` no longer offers `--google-service-account-ref`, which
  no action accepted; `projects.json` carries that setting.
- Routines work on models that wrap their JSON in a Markdown fence, such as
  gemini-3.8-flash: the activation check read every such answer as malformed,
  so the routine never activated. One dropped or retryable provider answer no
  longer fails the check, and a new routine's run may make 12 model calls
  instead of 5, so research that searches one query a turn finishes. A
  routine made before is raised to 12 once, on the owner's next start, by a
  revision Tavi saves (archived routines, and ones whose latest revision
  failed its check, keep 5). Research's last call within its budget writes up
  what it found instead of being refused, and a failed run's page says why.
- A turn that spent nearly all its steps on tool calls could end on the
  workflow engine's own recursion limit ("Recursion limit of 41 reached")
  before its last step, which answers with what it gathered.
- Settings → Models no longer says the Embedding role uses the default: it is
  unset until bound, and memory search matches words only until then.
- On a phone, the composer's model picker gets its own row and the footer
  strip no longer runs off the screen.
- Many browser, schedule and routine fixes.

### Documentation

- A guide to the daily brief ([REPORTS.md](docs/REPORTS.md)), the owner's IPC
  messages ([IPC.md](docs/IPC.md)), a catalogue of every built-in tool, an index
  of the docs ([docs/README.md](docs/README.md)) and of the examples.
- Screenshots of the web canvas and the terminal, diagrams of the main
  mechanisms, and a banner; `scripts/docs/` retakes them.
- CLI.md covers every command and flag `--help` offers, and a test keeps it so.
