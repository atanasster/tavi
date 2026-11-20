# Tavi CLI Reference Manual

The `tavi` Command Line Interface (CLI) is the primary user and operator interface to the Tavi local-first agent application. It provides foreground task execution, long-running daemon hosting (`serve`), a terminal UI (`chat`) and a web canvas (`ui`) over that daemon, diagnostic reporting, model and credential configuration, memory management, versioned skill control, and identity bindings. For task-oriented walkthroughs and everyday use cases, see [USECASES.md](USECASES.md); for how the CLI and owner are composed in code, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Table of Contents

- [Command summary](#command-summary)
- [Common flags](#common-flags)
- [Global Flags](#global-flags)
- [Core Concepts & Architecture](#core-concepts--architecture)
  - [Invocation Methods](#invocation-methods)
  - [Data Directory & IPC Architecture](#data-directory--ipc-architecture)
  - [Credential Security Discipline](#credential-security-discipline)
  - [Exit Codes](#exit-codes)
  - [Signals: Ctrl-C, SIGTERM and detaching](#signals-ctrl-c-sigterm-and-detaching)
  - [Upgrades](#upgrades)
  - [Upgrading the shipped system prompt](#upgrading-the-shipped-system-prompt)
  - [Output Formats & Event Streaming](#output-formats--event-streaming)
  - [Environment Variables](#environment-variables)
- [Command Reference](#command-reference)
  - [`tavi onboard`](#tavi-onboard)
  - [`tavi setup`](#tavi-setup)
  - [`tavi run`](#tavi-run)
  - [`tavi run` under a live owner](#tavi-run-under-a-live-owner)
  - [`tavi abort`](#tavi-abort)
  - [`tavi chat`](#tavi-chat)
  - [`tavi ui`](#tavi-ui)
  - [`tavi serve`](#tavi-serve)
  - [`tavi tasks`](#tavi-tasks)
  - [`tavi doctor`](#tavi-doctor)
  - [`tavi cancel`](#tavi-cancel)
  - [`tavi recover`](#tavi-recover)
  - [`tavi models`](#tavi-models)
  - [`tavi memory`](#tavi-memory)
  - [`tavi skills`](#tavi-skills)
  - [`tavi bindings`](#tavi-bindings)
  - [`tavi channels`](#tavi-channels)
  - [`tavi artifacts`](#tavi-artifacts)
  - [`tavi approvals`](#tavi-approvals)
  - [`tavi needs`](#tavi-needs)
  - [`tavi answer`](#tavi-answer)
  - [`tavi permissions`](#tavi-permissions)
  - [`tavi credentials`](#tavi-credentials)
  - [`tavi reports`](#tavi-reports)
  - [`tavi schedules`](#tavi-schedules)
  - [`tavi reminders`](#tavi-reminders)
  - [`tavi todos`](#tavi-todos)
  - [`tavi ideas`](#tavi-ideas)
  - [`tavi heartbeat`](#tavi-heartbeat)
  - [`tavi projects`](#tavi-projects)
  - [`tavi system-prompt`](#tavi-system-prompt)
  - [`tavi config`](#tavi-config)
  - [`tavi agents`](#tavi-agents)
  - [`tavi search`](#tavi-search)
  - [`tavi router`](#tavi-router)
  - [`tavi plugins`](#tavi-plugins)
  - [`tavi mcp`](#tavi-mcp)
  - [`tavi apps`](#tavi-apps)
  - [`tavi sandbox`](#tavi-sandbox)
  - [`tavi service`](#tavi-service)
  - [`tavi remote`](#tavi-remote)
  - [`tavi prune`](#tavi-prune)
  - [`tavi inbox`](#tavi-inbox)
  - [Browser installation, allowlist and history](#browser-installation-allowlist-and-history)
  - [`tavi browser history`](#tavi-browser-history)
  - [`tavi browser close`](#tavi-browser-close)
  - [`tavi browser live`](#tavi-browser-live)
  - [`tavi browser clear-profile`](#tavi-browser-clear-profile)
  - [`tavi browser recipes`](#tavi-browser-recipes)
  - [`tavi browser site-notes`](#tavi-browser-site-notes)
  - [`tavi logs`](#tavi-logs)
  - [`tavi backup`](#tavi-backup)
  - [`tavi export`](#tavi-export)
  - [`tavi restore`](#tavi-restore)
  - [`tavi reset`](#tavi-reset)
- [Operational Workflows & Guides](#operational-workflows--guides)
  - [1. Configuring a Model Once, then Chatting](#1-configuring-a-model-once-then-chatting)
  - [2. Deploying a Persistent Daemon with Messaging](#2-deploying-a-persistent-daemon-with-messaging)
  - [3. Human-in-the-Loop Artifact Reviews](#3-human-in-the-loop-artifact-reviews)
  - [4. Rolling out a skill version](#4-rolling-out-a-skill-version)
  - [5. Dead Execution Slot Recovery](#5-dead-execution-slot-recovery)

---

## Command summary

Every command has `--help`; `tavi --help` lists them all. A page fits the terminal's width, or 80 columns in a pipe: a line too long goes on at spaces, an option's text in its own column, wrapped once as a whole when any of its lines is too wide, so no word is left on a line of its own. The sections below are the full reference; the terms they use are in the [glossary](CONCEPTS.md#glossary).

| Command | What it does |
| :--- | :--- |
| `tavi onboard` / `setup` | Set up what is still open (a model first) / go through every setup step again, or one; `tavi onboard status` is the checklist |
| `tavi serve` | Start the owner: the background process that holds the data directory and serves the other commands, messaging, schedules and the heartbeat |
| `tavi chat` | Chat in the terminal (needs the owner running) |
| `tavi ui` | Open the web canvas in a browser (needs the owner running) |
| `tavi run` | Run one task (here, or on the owner when it runs) |
| `tavi tasks` | List tasks, show a timeline, a chat's instructions, export, forget or rewind its history |
| `tavi abort` / `cancel` / `recover` | Stop a task's running turn (it can be resumed) / cancel a task for good / free a task stuck on a process that died |
| `tavi approvals` / `artifacts` | Decide approval rounds and list past decisions (`history`) / review tool output held back until you approve it |
| `tavi needs` / `answer` | Everything waiting on you (questions, approvals, reviews) / answer a task's open question |
| `tavi permissions` | Tool rules, chat grants and the untrusted-content (taint) check: `list`, `add`, `rm`, `grants`, `revoke`, `taint` |
| `tavi models` / `credentials` / `search` | Model connections and roles / local credentials / web search providers |
| `tavi router` | Optional model routing: configure it, explain a task's route ([ROUTER.md](ROUTER.md)) |
| `tavi system-prompt` | The default base instructions, applied from each chat's next message: `show`, `set`, `reset`, and `preview` |
| `tavi config` | Workspace settings: `get`, `set`, `unset` (see [tavi config](#tavi-config) for every key) |
| `tavi plugins` / `mcp` / `apps` | Plugins: list, install, review, enable, configure ([PLUGINS.md](PLUGINS.md)) / MCP servers ([MCP.md](MCP.md)) / Connected apps ([APPS.md](APPS.md)) |
| `tavi schedules` / `agents` / `projects` / `reports` / `service` | Unattended work (`tavi schedules agenda` lists every upcoming reminder, routine and schedule fire); `service` writes a launchd or systemd unit, or a Windows logon task, that keeps `serve` alive |
| `tavi remote connect` | Use the owner on another computer from this one, over SSH ([OPERATIONS.md](OPERATIONS.md#using-the-owner-from-another-computer)) |
| `tavi reminders` | Reminders: list, add (once, event, repeat), show, snooze, pause, resume, cancel |
| `tavi todos` | To-dos: list, add, done, reopen, remove, export ([AUTOMATION.md](AUTOMATION.md#to-dos)) |
| `tavi ideas` | Ideas Tavi offers you: list, try, dismiss, restore, refresh, brief, provider, digest, hours, budget, prepare, reset, on, off |
| `tavi heartbeat` | Turn the heartbeat on or off, tune it, check now, read its log ([HEARTBEAT.md](HEARTBEAT.md)) |
| `tavi browser history` / `close` / `clear-profile` / `recipes` / `site-notes` / `live` | Browser sessions of the last 30 days (`--live` for open ones) / close one, or every one whose task ended (`--inactive`) / forget the workspace's browser profile / the steps that last led to results on each site (`--forget <host>`, `--forget-all`) / the operator's site notes, each off until turned on / write a task's live view frames to a folder as JPEGs |
| `tavi sandbox` | Check the sandbox on this host, and set it up where it needs root once |
| `tavi bindings` / `inbox` | Link a channel sender to a Tavi user (a principal) / see and replay held inbound messages |
| `tavi channels` | Add, change, test and remove channel connections, sign them in with `connect`, and link or revoke people with `link`, `unlink` and `people` ([CHANNELS.md](CHANNELS.md); a channel of your own: [CHANNEL-PLUGINS.md](CHANNEL-PLUGINS.md)) |
| `tavi memory` / `skills` | Memory and skills (`tavi memory proposals`, `approve`, `reject` review what the agent proposed; `tavi memory config` pauses memory, turns suggestions or the digest off, tidy-up suggestions on, and sets its limits; [MEMORY.md](MEMORY.md)) |
| `tavi doctor` / `logs` / `prune` / `backup` / `export` / `restore` / `reset` | Operations |

## Common flags

Most commands take these; a command's `--help` says which.

| Flag | What it does |
| :--- | :--- |
| `--data-dir <path>` | The data directory (default: `$TAVI_DATA_DIR`, else your user data directory; see [Data Directory & IPC Architecture](#data-directory--ipc-architecture)). |
| `--workspace <id>` | The workspace acted in (default `default`). |
| `--principal <id>` | The principal acted as (default `operator`). |
| `--format <text\|json>` | Output format (default `text`; see [Output Formats & Event Streaming](#output-formats--event-streaming)). |
| `--operation-key <key>` | An idempotency key for an admission: the same key never runs twice. Keys beginning `schedule:` are reserved for schedule fires. |

## Global Flags

Every command reads `--name value` and `--name=value` alike, refuses a flag it does not take, and refuses a single-valued flag given twice (exit `2`); `tavi channels add` and `set` take any other `--<key> <value>` as a channel setting. See [Invocation Methods](#invocation-methods).

- `-h, --help`, `help`: Display command usage help and available subcommands.
- `--version`, `version`: Display the version — the CLI package's, read at startup — and, from a clone, the commit the checkout is at (e.g. `tavi 0.1.0 (1a2b3c4d5e6f)`). The version alone is the build id that `tavi doctor` reports and a backup's manifest records.

---

<a id="architecture"></a>

## Core Concepts & Architecture

### Invocation Methods

Within the monorepo workspace, `tavi` can be run in several ways:

```bash
# 1. Via pnpm script (standard inside the workspace)
pnpm tavi run ...

# 2. Via local bin runner
npx tavi run ...

# 3. Direct executable path
node apps/cli/dist/executable.mjs run ...

# 4. Enable direct `tavi` command in your current shell:
export PATH="$PWD/node_modules/.bin:$PATH"

# Or configure an alias in ~/.bashrc or ~/.zshrc (rebuilds changed packages before serve/ui/chat/onboard/setup):
alias tavi="node $(pwd)/scripts/tavi.mjs"
```

Every command reads its flags the same way: `--name value` and `--name=value` are the same, `-h`/`--help` anywhere shows the command's page, and a flag it does not take is refused, a bare `--` included. A usage error is one line, exit `2`: what was wrong, the nearest valid action, option or command when one is close, and the page to read — `serve does not accept --drain-deadine; did you mean --drain-deadline? See \`tavi serve --help\`.` Only `--help` prints the page. Every removal action answers to `rm`, `remove` and `delete` alike: each command's page names its own (`permissions rm`, `credentials delete`, `remove` elsewhere) and lists the other two as aliases. The one exception is `tavi channels add` and `set`, which take any other `--<key> <value>` as a channel setting. A flag that takes one value may be given **once**: `--model a --model b` is refused with `--model may be given only once` (exit `2`), never read as the last one. Flags documented as repeatable (`--http-allow-host`, `--serve-arg`, `--set`, …) keep every value, in order.

`tavi serve`, `tavi run`, `tavi chat` and `tavi ui` refuse to start on a Node.js older than the `engines.node` floor (22.22.2), with exit `4`; `tavi doctor` reports the version too. On a Node.js older than 22, every command, `doctor` included, prints an upgrade message and exits `4`.

### Data Directory & IPC Architecture

Every Tavi invocation operates against a data directory storing application state:
- `tavi.sqlite`: SQLite database configured in WAL mode containing tasks, attempts, checkpoints, memories, skills, and bindings.
- `artifacts/`: Content-addressed storage for artifacts generated by governed tools (sandbox, browser) and imported skill packages.
- `sandbox-home/`: unused (the shell's `HOME` and `TMPDIR` are in the chat's own folder); closed to the shell like the rest of the data directory and removed by `tavi reset`.
- `chats/<workspace>/<task-id>/`: each chat's own working folder, with `.tmp/` and `.home/` inside, created `0700` when the chat first runs. A worker uses its chat's. The file tools and `sandbox.run` work in it; `.home/` is the shell's `HOME` (kept across turns, for build caches) and `.tmp/` its `TMPDIR`. App-managed: `tavi backup` copies it (without `.tmp/`, `.home/` and `chats/.trash/`) and `tavi reset` erases it, so files a chat must keep belong in a host folder it attaches.
- `plugins/<id>/<version>/`: Installed external plugins, one immutable, hash-pinned snapshot per version (`tavi plugins`).
- `runtime/ipc.json`: the discovery file `tavi serve` publishes once it owns the directory: its protocol version, session, process id and socket endpoint. It holds no credential.
- `runtime/ipc.token`: the owner's authentication cookie, readable by its user only (`0600`).
- `runtime/ipc.sock`: the Unix domain socket attached clients connect to.

#### Resolution Order
The data directory path is resolved once at the CLI boundary using a strict priority order:
1. Explicit `--data-dir <path>` command-line option.
2. `TAVI_DATA_DIR` environment variable.
3. Your user data directory: `$XDG_DATA_HOME/tavi` when `XDG_DATA_HOME` is set to an absolute path (a relative one is ignored), else `~/Library/Application Support/tavi` on macOS, `~/.local/share/tavi` on Linux and `%LOCALAPPDATA%\tavi` on Windows. It is per user, not per working directory, so every command finds the same database.

Paths are automatically resolved to canonical absolute paths to ensure clients and background daemons agree regardless of invocation directory.

#### Concurrency & Mutual Exclusion
To eliminate split-brain write hazards and database corruption (which commands run on the owner, alongside it, or are refused while it runs is one table in [CONCEPTS.md](CONCEPTS.md#the-owner)):
- `tavi serve` takes exclusive ownership of the data directory for its entire lifetime.
- While `tavi serve` is active:
  - Operational commands (`tavi tasks` except `tasks folders prune`, `tavi doctor`, `tavi cancel`, `tavi recover`, `tavi abort`, `tavi approvals list|approve|reject|show|history`, `tavi needs`, `tavi answer`, `tavi artifacts list|approve|reject [--resume]`, `tavi permissions`, `tavi reset`) detect `runtime/ipc.json`, authenticate with `runtime/ipc.token` over the private socket, and execute against the live runtime.
  - `tavi run` dispatches the run to the owner and follows its stream (below); `tavi run --attach <task-id>` follows a task the owner is already running. A run is a chat of its own (`chatKind: "run"`); `tavi run --home "<prompt>"` posts the prompt into your Home chat as its next turn instead, and needs the owner; while the workspace's `chat.home` is off it is refused (`INVALID_INPUT`, exit 2: "Home is off: `tavi config set chat.home on`").
  - The configuration a UI needs is the owner's too: `tavi onboard`, `tavi setup`, `tavi config`, `tavi system-prompt`, `tavi models`, `tavi credentials`, `tavi search`, `tavi projects` (all but `import`), `tavi schedules`, `tavi reminders`, `tavi todos`, `tavi agents`, `tavi channels`, `tavi plugins`, `tavi mcp`, `tavi apps`, `tavi router`, `tavi heartbeat`, `tavi ideas`, `tavi reports list` and `trends`, and `tavi browser` (all but `site-notes`'s listing, `--on` and `--off`) run over IPC with the offline commands' output and exit codes (see "Configuration under a live owner" below). An action with no IPC counterpart — `tavi projects import` — is refused with exit `5`, naming why.
  - `tavi memory` runs over IPC too, acting as the workspace's operator (see [Memory from an attached client](IPC.md#memory-from-an-attached-client)); `tavi memory export` has no IPC counterpart and is refused with exit `5`.
  - Read-only/host commands (`tavi backup`, `tavi export`, `tavi logs`, `tavi service`, `tavi sandbox`, `tavi router evaluate`) run without taking the directory lock.
  - Commands that mutate or inspect the store directly with no remote form (`tavi skills pin-rollout|clear-rollout|rollout-status`, `tavi bindings`, `tavi inbox`, `tavi reports show|open`, `tavi browser site-notes` but `--propose`, `tavi projects import`, `tavi tasks folders prune`, `tavi prune`, `tavi restore`) **strictly refuse** to execute directly against the database while an owner runs, exiting with code `5` (`alreadyOwned`).
- When no owner is active:
  - Foreground commands acquire a file lock (`acquireDataDirectoryOwnership`), perform their operations directly against SQLite, and release the lock on completion.
- `tavi serve` holds the directory a moment before it answers (while its runtime starts). A command run in that window waits for it, up to 15 seconds, and then attaches as usual, rather than being refused.
- A command refused because another process holds the directory says so in one wording, with exit `5` and no internal code: ``restore command failed: `tavi serve` (pid 4242) already owns /path/to/data; restoring would replace the database it is using. Stop it first (Ctrl-C where it runs, or stop the launchd/systemd unit you installed with `tavi service unit`), then run this again.`` A holder that is another tavi command reads ``Another tavi command (pid …) already owns …; … Wait for it to finish, then run this again.``

Under one owner, several front ends — terminals, chat, schedules, attached clients — act on the same tasks at once:
- **One turn per task at a time.** A task holds one execution slot; an admission for a task whose turn is running waits for it. A slot still held by an owner that died is refused `EXECUTION_BUSY` (exit `4`) until `tavi recover <task-id> --generation <n> --reason <text>` frees it.
- **A round is decided once.** Every front end decides an approval round under the round's own key, with that round as its in-queue precondition: the same decision sent twice is one admission, and a different decision for the same round is refused `CONFLICT` (exit `4`), leaving the task as it was. A front end that names the round it showed — an attached client's prompt — is also refused `CONFLICT` once that round has moved on. `tavi approvals approve|reject` names no round: it decides whatever round is pending when the owner reads it, or exits `8` when none is, so check `tavi approvals list` before deciding late. `approval.settled` tells every attached client, and an open prompt for that round is withdrawn.
- **Rules are applied when a call is made, not when it is decided.** The owner checks each call against the hard-deny list, the workspace's deny, ask and allow rules, and the shipped rules (a reply into the task's own conversation and a question to the operator are allowed) as the model emits it, and records the verdict with the call. A refused call never forms a round; its reason is the tool result the model reads. `approval.required` carries the call's `risk` (`level`, `reasons`, `tainted`), a `display` (`title`, and `command`, `host`, `destination` or `detail` when they apply) and the `allowedScopes` a decision may carry; older owners omit them.
- **A round raised by a chat-started task goes to that chat**, or to the chat its delegation root came from.
  - The owner sends it once per round, with a token and the calls' display and risk, and records it in `tavi approvals show <task-id>`.
  - From the chat, `(approve|allow) [token|task-id] [once|session|always]` and `(reject|deny) [token|task-id] [reason…]` decide it under the same round key as every other front end; a token for a round that has moved on is refused.
  - A `session` decision adds a grant for the rest of this chat (in Home or a messaging chat: a day, or until it rolls over), an `always` decision adds a workspace allow rule matching exactly the command, request or destination that was shown, and either applies only where the call's verdict offered that scope.
  - Where the connector has interactions (Telegram), the round carries buttons whose data is only `r:<token>:<o|s|a|d>`: a press is ingested like a message — the presser's binding resolved, the update deduplicated — and decided through the same path, with the principal check applied to the presser; ❌ makes the presser's next message in that conversation the (optional) reason (two minutes, then rejected without one).
  - A decided round's message is edited to show the outcome and lose its buttons where the connector can edit; either way the chat is told who decided it, via what and when (`✅ Round k3f9abcd approved (session) by alice via Telegram at 14:02 UTC.`), and a notice that could not be sent is retried.
  - A chat round not decided within 24 hours (`serve --approval-expiry <hours>`) is rejected by `policy:expired`, the model reads that it timed out, and the chat is told.
  - Only a round delivered to its chat expires: a failed announcement is sent again on each sweep (every 30 seconds), and its expiry is counted from delivery. Rounds of schedule fires and of the local connection are not sent.
- **Scopes and permissions from every front end**.
  - IPC `approve` and `approvals approve` take `scope` (`once`, `session`, `always`) and apply it only where each call's verdict offered it; `approvals reject` takes `note`.
  - `tavi approvals approve --scope` and `reject --note` pass them, as do the `tavi chat` keys (`s`, `a`, `N` for a reason) and the `[y/s/a/N]` prompt of a foreground or attached `tavi run`.
  - A decision records its front end (`via`: `cli`, `ipc`, `bridge`, or the connection) in the audit trail and in an `always` rule's `createdVia`.
  - IPC `permissions` (`rules`, `add`, `remove`, `grants`, `revoke`) serves `tavi permissions` and the canvas's Permissions settings.
  - Through the `tavi ui` bridge `add`, and `remove` of a deny or ask rule, are refused (`NOT_AUTHORIZED`) — either would widen what runs unasked.
  - Shipped or `serve --allow` rules cannot be removed — override one with a deny or ask rule, or restart without the flag.
- **Email approvals**. With a public address (`tavi channels ingress --public-url <https-url>`), a round or question announced by email carries one single-use link per choice, but only when it goes to the address bound to the round's decider: `<url>/i/<token>`, a 128-bit token stored only as its SHA-256, expiring with the round (for a question, at its deadline, and within 24 hours).
  - A question's email is titled `[tavi <token>] Question: <header or first 60 characters>`; a reply under that subject is the question's answer — matched by the token when the thread is lost — and is never read as a round decision. A question a schedule's run asks opens with `⏸ <schedule name> asks:`, on Telegram too.
  - The Mailgun listener serves the link: GET shows the round and the choice and decides nothing (strict CSP, `no-store`, never framed, no referrer; in the browser's light or dark scheme, as the OAuth sign-in's closing page is); the page's POST spends the link and every sibling atomically and decides through the same path a chat decision takes.
  - A critical round's page asks for the credential `approvals.pin`, compared in constant time before the link is spent. Three wrong PINs spend the email's links.
  - An email's subject carries `[tavi <token>]`; a reply whose first line is `approve`/`reject …` decides that round, once only, when Mailgun's `X-Mailgun-Spf` and `X-Mailgun-Dkim-Check-Result` both say `Pass` — read only above the first `Received` header, where Mailgun adds them — and the round's recorded risk is low or medium; otherwise it is refused with how to decide instead.
  - A public URL with a path (`https://mail.example.com/tavi`) is served at both `<path>/i/<token>` and `/i/<token>`.
- **Default working tools and profiles**. `plan.update`, `sessions.search`, `math.eval` (arithmetic and date arithmetic in a time zone, by a parser that runs no code, so it never asks), `artifacts.read`, `artifacts.view_image` and `plugins.authoring_guide` (the plugin-authoring skill) are always registered; so are `plugins.validate` — `tavi plugins validate` on a folder in the chat's folders (refused to a chat-started task, and asked about once in a turn that holds untrusted content) — and `fs.read|list|glob|grep|write|edit`, with or without `serve --fs-root`.
  - **The working folder.** They work per call in the calling chat's working folder, stamped on the turn at admission:
    - Reads reach the chat's primary folder, its own managed folder (`<data-dir>/chats/<workspace>/<task-id>/`) and every attached folder; writes the primary, the managed folder and folders attached read-write.
    - A relative path resolves against the primary folder; a file path must resolve (symlinks followed) into one of those folders.
    - Results and diffs show a path relative to the primary folder, or `<label>/<path>` in an attachment.
    - A turn whose folder could not be resolved is refused with the reason, which names `/folder reset`; there is no fallback to the roots.
  - **`fs.write`/`fs.edit`** show a unified diff in their round.
    - They are hard-denied under credential directories and the files that hold keys or tokens (shell profiles and histories, `.git-credentials`, `.gitconfig`, `.config/gh` — refused to every `fs.*` read too), the data directory (all but the chat's own managed folder and, for a side chat, its parent's, read-only) and every `--dev-plugin` folder, wherever it appears.
    - A write whose path resolves at dispatch to another file than the gate decided — a link swapped in since — is refused (`CONFLICT`), whatever a rule, a grant or an approval allowed.
    - They create missing folders one level at a time and never write through a link at the target or an ancestor; a file with more than one hard link in a managed folder is neither read nor written.
  - **Rule subjects** are folder-qualified: `chat:<task-id>/<path>` in a managed folder, the absolute real path in a host folder; a matcher saved from a subject has its glob characters escaped, and a call with several subjects is allowed by rules only when every subject matches.
  - **Tainted and side chats.**
    - In a chat whose conversation is tainted (the gate's sticky conversation taint), a write outside the chat's own managed folder — into a host primary or a read-write attachment — asks every time, offering `once` only.
    - A side chat's write into a host folder is rated `high`, so `always` is not offered: the rule would also match its parent's writes of that file; `session` stays the side chat's own.
  - **Untrusted results.**
    - `fs.read` of a file in a managed folder's `downloads/`, an `fs.grep` match in one, `fs.list` of a non-empty folder in it and an `fs.glob` that matches a file in it are untrusted for that result.
    - So is every `sandbox.run` result while the chat's own `downloads/` or a side chat's parent's holds any entry, checked before and after the run, or whose audit shows a request that got through to a granted domain (`requests[].allowedCount` above 0; that also marks the chat's folder tainted).
    - For these the handler marks the result and the dispatcher taints the conversation as a web read does (`WorkflowMessage.untrusted`).
    - A file the shell copied out of `downloads/` is not tracked once `downloads/` is empty.
  - **Sending a file by path.** `browser.act` upload and `messaging.send_to` `kind: "file"` take exactly one of `artifactId` and `path`:
    - A path is read as `fs.read` reads one (the chat's folders, protected paths, a hard-linked file in a managed folder refused), whole and once, at most 20 MiB.
    - The call's card shows the file's name, size and sha256, and the hash is kept on the verdict (`contentHash`).
    - When a person approved that very call in its round the handler stores those bytes as an artifact of the calling task (`run_id`), `approved` with that person as `reviewed_by`, and refuses (`CONFLICT`, nothing stored or sent) bytes whose hash differs from the one shown.
    - A call a rule, a grant, a flag, a schedule's policy or `--approval approve` allowed stores the file `pending`, sends nothing and answers `awaiting_review` with the artifact id, so the turn suspends on its review; once it is approved, the model sends it by `artifactId`.
    - A schedule's `--allow` policy never approves such a file, so the fire ends with its review waiting, while `tavi run --approval approve` approves it as it approved the call that stored it.
    - The card and a rule's subject name the recipient as the call names it (`to`, or the older `chatId`).
  - **`sessions.search`** is untrusted output, so a chat that reads it is tainted as a web read taints it.
    - It leaves out heartbeat checks, `run` tasks and chats begun in a messaging conversation other than the caller's own (its earlier epochs included), and a delegated worker is neither offered it nor allowed to call it.
    - It looks each keyword up in a trigram index of every saved turn's prompt and final answer (`tavi_task_history_fts`, migration `0025_task_history_fts`, which indexes the turns a data directory already holds), kept in step by triggers as turns are added, forgotten, rewound, purged or deleted with their chat, and erased at once on delete (FTS5 `secure-delete`).
    - So a search reads only the turns that may hold a keyword, newest first, up to its 5,000-turn scan, however long the history.
    - A keyword with no run of 3 characters that fold alike (a CJK bigram) is matched by a scan of every turn instead, and a keyword with none at all leaves every turn a candidate.
    - From a turn whose `memoryReach` is `chat-only` — a group conversation's Home, its forum topics' side chats and their workers, stamped at every admission — it searches only chats mapped to the caller's own conversation (same connection, the group's key or one of its topics' keys), never the person's Home or other chats, and `memory.search`/`memory.get` read only that chat's notes while `memory.propose` takes only `scope: "chat"`.
  - **`artifacts.read`** reads an approved text or JSON artifact of the calling chat itself (a large result kept whole, whose note names it; never another chat's or a worker's mailbox, at most 8 MiB) a page at a time — at most 16,000 characters (`maxChars`, up to 24,000) and 40,000 bytes, with `nextOffset` — labelled as it was stored, so reading back a web page taints the turn as the page did.
  - **`artifacts.view_image`** returns a reference to an approved png/jpeg/gif/webp artifact of at most 5 MB, or, with a `path`, to a picture in the chat's folders (read as `fs.read` reads it, typed by its bytes, and stored as an artifact with the label `fs.read` would give it), which the model adapter resolves into an image part for the model — the bytes never enter the checkpoint. A picture over 8000 pixels on a side, or one whose header names no size, is refused (the providers refuse it, and the whole call with it); one already in a chat's history is left out of the request rather than sent.
  - **Origin-scoped rules.**
    - A rule can carry an `origin`; the shipped messaging profile denies `sandbox.run`, `fs.write`, `fs.edit` and credentialed `http.request` (its subjects now include `credential:<ref>`) to tasks with origin `messaging`, less any tool named by `serve --messaging-allow-tool` in a turn from the operator's own one-to-one chat, and any a contact grant allows in that person's own one-to-one chat on a chat channel (`tavi channels grant … contact … allow`, still asked).
    - A rule scoped to origin `ipc` also applies to `web` tasks, so a rule written before the canvas's runs were recorded as `web` keeps covering them.
    - A turn is also judged by the front end it was typed in on the owner's local connection (`web` through `tavi ui`, `ipc` from `tavi chat` or `tavi run`): a deny or ask rule applies when it covers the task's origin or that front end, an allow rule only when it covers both — so a canvas turn of a Home `tavi chat` began is held to `web`-scoped deny rules, and following the front end never lifts a rule.
    - Settings → Permissions says which tasks an origin-scoped rule covers. `tavi permissions list` shows these rules with their origin.
- **`sandbox.run` in the chat's folder**. The policy is built per call from the folder stamped on the turn, never from the call's input.
  - **Writes** reach the chat's primary folder, its managed folder and folders attached read-write — only the managed folder in a tainted one, by the conversation's sticky taint or the gate's taint for that call.
  - **Write denies.** Every call's write denies are the full list:
    - srt's shared default write paths (`/private/tmp/claude`, `/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug` — also appended by the runtime adapter to any policy, since a per-call `denyWrite` replaces srt's base list);
    - every `--dev-plugin` folder;
    - the data directory but the chat's own folder (denied entry by entry: its other entries, other workspaces' `chats/` entries and other chats' folders);
    - the credential homes and key-holding dotfiles;
    - inside every folder the shell writes (the managed one too), `.git/hooks`, `.git/config`, `.git/config.worktree`, `.git/commondir`, `.git/info/attributes`, `.gitconfig`, `.gitmodules`, shell profiles (`.bashrc`, `.bash_profile`, `.bash_login`, `.zshrc`, `.zprofile`, `.zlogin`, `.profile`), `.envrc`, `mise.toml`, `.mise.toml`, hook managers' config (`.husky`, `.pre-commit-config.yaml`, `lefthook.yml`, `.lefthook.yml`), `.ripgreprc`, `.mcp.json`, `.vscode`, `.idea`, `.zed`, `.helix`, `.cursor`, `.codex`, `.gemini`, `.claude/commands`, `.claude/agents`, `.claude/hooks`, `.claude/skills`, `.claude/settings.json` and `.claude/settings.local.json` at any depth and in any case — srt's own denies of these resolve against the owner's working directory, so tavi emits them itself wherever the owner runs — except that in a subfolder of the chat's own folder a repository's own files (`.git/hooks`, `.git/config`, …) are left out, so `git init <dir>` and `git clone <url> <dir>` work there (at its top they stay protected); every run's git is given no hooks path, no fsmonitor, no template and every config-defined hook off (`GIT_CONFIG_PARAMETERS`);
    - and, inside each host folder the shell writes, every path component named `.git` (file or folder, so no gitfile can redirect git), so `git commit` fails there too; `fs.write`/`fs.edit` refuse a `.git` component in a host folder as well;
    - and, inside each host folder the shell writes, what a package manager, mise or a dev container runs on its own: `.yarnrc.yml`, `.yarnrc`, `.yarn/releases`, `.yarn/plugins`, `.pnpmfile.cjs`, `bunfig.toml`, `.npmrc`, `.cargo/config.toml`, `.cargo/config`, `mise.local.toml`, `.mise.local.toml`, `.mise/config.toml`, `mise/config.toml`, `.config/mise.toml`, `.config/mise`, `.tool-versions` and `.devcontainer` (the chat's own folder keeps them writable, so `npm login` works there). `fs.write`/`fs.edit` change any of these protected files in a host folder only with the diff approved each time, never for later; in the chat's own folder they never write a repository's `.git` hooks or config.
    - Project files the host may run on purpose (`package.json` scripts, a `Makefile`, other agents' instructions) are not covered; a run that changes one at a host folder's top lists it in its result's `hostRunsChanged`.
  - **Glob characters.** A call whose policy would hold a path with `*`, `?`, `[` or `]` (a chat folder, a root, a dev plugin) is refused (`UNAVAILABLE`), since srt reads them as a glob; such a folder is refused up front as a chat's primary or attachment.
  - **Reads.** In the nested layout, a side chat's parent folder is not read-denied.
    - Reads deny `$HOME`, every `--fs-root` and the data directory (entry by entry when a folder the chat reads holds it), plus the credential homes and key files by name; mounted drives (`/Volumes`, `/media` and `/mnt`, on WSL too, where `/mnt` holds the Windows drives), `/Users/Shared`, a per-user `$XDG_RUNTIME_DIR` (never `/`, `/tmp`, `/run` or a system folder) and, on macOS, other users' entries in `/private/tmp` — a chat's folder, a `--sandbox-read` folder or a toolchain on `PATH` inside one is re-opened; and the owner's temporary directory (`os.tmpdir()`, where the owner spools other chats' checkpoints and artifacts; read and write, and only what tavi stages there by name — `tavi-render-*` — when a folder the chat reads lies in it).
    - They re-open the chat's folders, toolchains under `$HOME` that exist and that the owner's `PATH` runs from (`~/.nvm/versions`, `~/.fnm`, `~/.volta`, `~/.local/share/mise/installs`, `~/.asdf/installs`, `~/.cargo/bin` with `~/.rustup/toolchains` and `~/.rustup/settings.toml`, `~/.pyenv/versions`, `~/.bun/bin`, `~/go/bin`, `~/.local/bin`) and `serve --sandbox-read`.
  - **Working directory.** A command runs in the primary folder unless it names a `cwd`, which resolves against the primary folder and must resolve (symlinks followed) to an existing folder among the chat's folders. A turn with no folder is refused with its reason; so is one whose managed folder could not be made, and one whose `.home/` or `.tmp/` is a link.
  - **Environment.** The child starts from an environment tavi builds (`inheritEnv: false`, assigned inside the sandboxed line, since srt's wrapper sets `TMPDIR`):
    - the owner's `PATH` without entries the shell cannot read;
    - `HOME=<managed>/.home`, `XDG_CACHE_HOME=<managed>/.home/.cache`, `TMPDIR=<managed>/.tmp`;
    - `LANG`, `LC_ALL`/`LC_CTYPE`/`TZ`/`TERM` when set, `USER`/`LOGNAME`, `SHELL=/bin/sh`, `npm_config_package_import_method=copy`;
    - and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` from the owner's global git `user.name`/`user.email` (read once and asynchronously, at the first call).
    - Known provider variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_*`, `GH_TOKEN`, …), `SSH_AUTH_SOCK`, every `TAVI_*` and every owner variable whose name says key, token, secret, password, credential or auth are also unset by srt (`credentials.envVars`, mode `deny`).
  - **Mods and hooks.** The `tavi.guard` mod reads a command's paths relative to the same working folder; a hook envelope carries the chat's folder (`folder`) as labels only (`primaryLabel`, attachment labels and modes, `.tmp`/`.home` relative to the managed folder), for tavi's own mods and every installed or dev plugin alike.
- **Messaging turns, fires and folder retention**.
  - **Messaging turns.** A turn held to a messaging channel resolves the chat's managed folder only — no primary host folder, no attachments, whatever the chat's origin, a DM turn into Home included — so `fs.*` and `sandbox.run` stay in it for that turn (the `folder` command's `files` and `read` are the owner's view of the whole chat, not of one turn, and reach only owner front ends).
    - `serve --messaging-allow-tool` lifts the messaging profile's deny on a tool, never that narrowing.
    - Approved downloads and reports are copied into that same managed folder.
  - **Fires.** Every schedule, routine and reminder fire is a task of its own (`chatKind: "run"`) with a managed folder of its own and no attachments, so a schedule's `--allow fs.write` or `--allow sandbox.run` writes only into that fire's folder; a routine's fires resolve their folder as any turn does.
  - **A routine's pinned folder.**
    - A routine may pin a host folder (`folder: { path }` in `routines` `create`, or in `update`'s snapshot), checked like `/folder set` (`ChatFolders.checkPrimary`: under an `--fs-root`, outside the data directory, credential homes and dev plugins, an existing folder, not `$HOME` itself) and stored as its real path.
    - The web bridge may not name one (`NOT_AUTHORIZED`; an update that keeps the routine's folder passes), nor may the model (the routine tools' setup and edit carry none), and with no owner to check it a folder is `NOT_CONFIGURED`.
    - It is checked again at each fire, before the run's task exists: a fire whose folder no longer passes fails, its error naming the folder and why; otherwise the fire's task gets it as its primary folder (`ChatFolders.begin`) before its first turn, and its research worker works there too.
    - A routine whose pinned folder goes between the fire's check and its task's admission fails the same way, before its first turn.
  - **`.tmp/` and `.home/`.** A chat's `.tmp/` is emptied when the chat's own turn ends (completed, failed or cancelled — not one left waiting on an approval, a review or an answer, and never a worker's turn) and when its conversation rolls over to a new epoch, but never while a worker of the chat is running, since it shares the chat's `.tmp/`; `.home/` is kept.
    - Emptying removes a link and never what it points at, enters a folder only while it resolves to itself, and replaces a `.tmp` swapped for a link with a plain folder.
    - A folder whose mode denies a removal (a Go module cache under `.home/`) is made its owner's (`0700`) and the removal tried once more, and an entry that still cannot go is reported while the rest are removed.
  - **Folder budget.** Per-folder and total caps are a budget (`serve --folder-cap`, default 2 GiB; `--chats-cap`, default 20 GiB, every managed folder together with `chats/.trash/`; `.home/` and `.tmp/` count).
    - Sizes are measured when a write or a run is admitted, by a walk that never follows a link, stops at 100,000 entries (a lower bound then) and is reused for 30 seconds — but a chat's own folder is measured again after each `sandbox.run` in it ends.
    - Past 80% of either cap, `folder show` answers `budget.warning` and the chat gets one `folder` notice per crossing, measured after the turn's admission without holding it up (kept for the owner's lifetime, so a restarted owner tells a full folder once more).
    - At a cap, the folder's `.tmp/` is emptied and the size taken again; still at it, `fs.write`/`fs.edit` into the managed folder, the copy of an approved download or report, and a new `sandbox.run` are refused (`QUOTA_EXCEEDED`) with the folder's size and `tavi tasks folders prune --chat <task-id>` (or `tavi tasks folders prune` for the total).
    - A host folder has no budget.
    - It is a budget, not a ceiling: a command already running is never stopped, so it may overshoot within that call, as may commands running at once and file writes admitted within the 30 seconds.
    - A copy refused by the budget names `tavi tasks folders prune --chat <task-id>`, with an owner or without.
  - **Free-space floor.** Below `serve --free-space-floor` (default 1 GiB) free on the data directory's volume (`statfs`; a free space that cannot be read refuses nothing), these are refused (`QUOTA_EXCEEDED`, or as that caller handles a refused store: an oversized tool result is truncated instead of archived, a channel's media is left out of the message):
    - a new `sandbox.run`;
    - an `fs.write`/`fs.edit` landing on that volume;
    - a copy into a chat's folder;
    - and every file the owner's artifact store keeps for a person or the model — an outbound send by `path`, a browser download or screenshot, a `reports.generate` PDF, an oversized tool result held for review, inbound channel media.
    - Not refused: tavi's own bookkeeping in that store (a conversation fold's archive, a worker's or an envelope's offloaded text, a proposed skill package, a browser thumbnail: refusing it frees nothing and would stop a chat compacting), and what the database worker writes itself — a routine's published report and an imported skill package.
    - Refusals name the free space, the floor and the prune command; the free space is read at most once a second.
    - `tavi artifacts approve` with no owner running keeps to the default caps and floor, since a served owner's flags are not recorded.
  - **Trash.** What waited in `chats/.trash/` for 7 days is deleted when an owner starts and when `tavi tasks folders prune` runs; an entry that cannot be deleted is logged (or printed by prune) and the others still go.
- **`/new` starts a chat's next task**. On a messaging channel (never the owner's local connection, where it is ordinary text), a message that is only `/new` or `/reset` (`@bot` suffix allowed), from the person the chat's task runs for, is no turn: the conversation's task — its open waits settled `cancelled` (`CONVERSATION_RESET`), itself and its workers cancelled if not ended — stays readable under its id, the chat is told which, and the next message starts a new task (`msg-start-<connection>-<conversation>-e<epoch>`; epoch 0 keeps the key without a suffix). A Mailgun conversation is one email thread: the receiving address and a digest of the thread's first message.
- **A question can offer options**. `operator.ask_user` takes `options` (2–4 `{label, description?}`), `header`, `multiSelect` and `allowOther`; the wait records them, `task.waiting` carries them as `choices`, and an answer is read against them — a number or label picks, several for a multi-select, anything else is `other` where allowed and refused (with how to answer) where not. The model reads `answers` and `other` alongside `replyText`. Telegram shows buttons (`q:<token>:<n>`, toggles and Done for a multi-select); a question from a terminal or IPC run waits 30 minutes by default, any other (a chat, a schedule, a delegated worker) 24 hours.
- **A schedule's fire answers its own rounds** while it runs; an operator's decision for them is refused `NOT_AUTHORIZED` (exit `4`) until the fire ends. A schedule is not removed while a fire of it is in flight.
- **A run is its operation key.** `tavi run` under an owner mints one when `--operation-key` is not given, and a retry under the same key resolves the same task instead of starting another; when the owner's answer is lost, the CLI prints the key to retry with.
- **Many clients may follow one task.** An owner serves at most 16 connections at once — every attached `tavi` command holds one, and a further one is refused (exit `4`) — and each connection holds at most 64 subscriptions. A subscription with more than 4 MiB of events not yet flushed to its client is dropped, and a connection more than 16 MiB behind is closed: either way an attached `tavi run` says so and exits `4`, naming `--attach` to follow again.
- **Configuration applies to the next call**, the model target included: the owner resolves its default — the flags it was started with, else role `main`, else the workspace default — at the start of each turn, and reads a connection's endpoint and credential at each call, so a `tavi models` write never needs a restart. A turn keeps the default it began with; a chat with a model of its own (`models set-chat`, `run`'s `model`) runs that one whatever the default.
- **The first model and search provider need no restart**. `tavi serve` started with no model composes no provider for its `default`/`default` placeholders (none at `api.openai.com`), but keeps its model transport, workflow, task summaries, schedules and agent waits composed. Until a default resolves, `run` answers `NOT_CONFIGURED`, a reminder with a prompt is said with "(task not started: no model is configured)", and a channel message is not admitted: its sender is told once a day per conversation that no model is set up. After each `models`, `credentials` or `search` write the owner reads its providers again — a built-in search provider added or enabled is activated, `web_search` is offered once one exists, and routines' model and tool bindings, default model and setup check follow the live connections — so the next turn, routine, reminder fire and channel reply run on what was just configured. `models` and `search` writes answer `restartRequired: false`. The browser tools' extraction and vision models fall back to the default workspace's roles and default, as `run`'s target does, before the startup placeholder.

---

### Credential Security Discipline

Tavi enforces a strict security discipline for all API keys, bot tokens, and webhooks:
- **No Ambient Fallbacks**: Tavi never silently falls back to standard ambient provider keys like `OPENAI_API_KEY` unless explicitly mapped.
- **Explicit File Bindings**: Secrets must be supplied via `--api-key-file`, `--credential-file`, `tavi channels add --secret-file`, etc., or designated `TAVI_*_FILE` environment variables.
- **Strict File Permissions**: Credential files are validated before reading:
  - Must not be symbolic links (preventing redirect attacks).
  - File permissions must be `0600` (read/write by owner only; group and other permissions must be `0`).
  - Files must not be empty.

---

### Exit Codes

Exit codes are part of Tavi's stable contract:

| Code | Constant | Meaning |
| :--- | :--- | :--- |
| `0` | `ok` | Command completed successfully, or task finished with a successful result. |
| `1` | `taskFailed` | Task executed to completion but reported failure or model error. |
| `2` | `usage` | Invalid CLI options (a flag the command does not take, or a single-valued flag given twice), missing required arguments, or unrecognized command. Also a name typed to `tavi schedules`, `tavi agents` or `tavi reminders` that names nothing there: a mistyped name, as a mistyped flag is. |
| `3` | `approvalRequired` | An approval round is pending and this invocation will not ask it: there is no interactive terminal, or it is a decision (`tavi approvals`, `tavi artifacts --resume`) whose resumed turn suspended on the next round. |
| `4` | `unavailable` | Requested entity not found (a task, skill or artifact by its id), admission is closed, or runtime connection refused. Also `tavi serve`, `run`, `chat` or `ui` on a Node.js older than 22.22.2. Also a **refused admission** (see below), and an attached command whose owner dropped its stream, closed the connection, or never answered (an unknown outcome: `tavi run` prints the operation key to retry with). |
| `5` | `alreadyOwned` | Another process currently holds exclusive ownership of the data directory — or, under a live owner, the action has no IPC counterpart (`tavi projects import`, `tavi memory export` …) and needs the owner stopped. |
| `6` | `reviewRequired` | Task paused waiting for operator review of pending artifacts created by governed tools. |
| `7` | `taskWaiting` | Task suspended on `agents.wait` (waiting for a correlated reply, worker, or deadline), or on a question it asks you (`tavi.ask_user`): then stderr says the question and the command that answers it, `tavi answer <task-id> <answer>`. A foreground run with no owner stays while its task waits on a worker it spawned — deciding that worker's rounds with its own `--approval` policy or terminal — and exits `7` only once the wait's deadline passes. |
| `8` | `resumeNotApplicable` | Nothing was there to decide or resume: `tavi approvals approve\|reject` found no decidable approval (the task is not waiting, is cancelled, waits on something else, `--call` names another call, or its round was already decided by a resume that never committed — nothing is written); `tavi artifacts --resume` decided an artifact whose task is missing or has no decidable review (the artifact decision **is** written; only the resume is not); `tavi abort` found no running turn (`NOT_RUNNING`), or no owner serving the directory — nothing was signalled. |
| `70` | `internal` | Unexpected internal runtime error or unhandled exception; `tavi serve` exits `70` after an unhandled fault once it has drained, and after a shutdown that had to abort turns. |
| `130` | `detached` | An attached command — `tavi run`, `tavi run --attach`, `tavi chat` while a run is going, or a decision or fire it follows — was detached with Ctrl-C. The run belongs to the owner and continues; nothing about its outcome is known. See [Signals](#signals-ctrl-c-sigterm-and-detaching). |
| `143` | `terminated` | The same detach on `SIGTERM` (a supervisor or a CI timeout stopping the CLI, not an operator). The run continues under the owner. |

**Refused admissions.** `tavi run`, `tavi approvals approve|reject` and `tavi artifacts ... --resume` exit `4` — not `1`, and not `5` or `70` — when the admission is refused with `CONFLICT`, `NOT_FOUND`, `CANCELLED` or `NOT_AUTHORIZED`: a decision for a round another front end already decided, a key reused for a different decision, another principal's task, a cancelled one. A refused admission ran nothing, so the task is left exactly as it was (often still waiting) and is **not** marked failed. The same exit covers an execution superseded by another generation while it ran — that one may have done work, and stderr says so. `5` is only ever about the data directory's owner: another process holds it, or the action needs that owner stopped.

---

### Signals: Ctrl-C, SIGTERM and detaching

Ctrl-C means *stop* where the work is the command's own, and *stop watching* where it is the owner's:
- **`tavi run` with no owner** runs the task in this process. `SIGINT` (Ctrl-C) or `SIGTERM` aborts the running turn: it ends `failed` with `ABORTED`, its checkpoint intact, so the task can be resumed or replied to later. `tavi approvals approve|reject` and `tavi artifacts --resume` abort their resumed turn the same way.
- **Under a live `tavi serve`** the run is the owner's. Ctrl-C only detaches: the CLI exits `130` (`143` for `SIGTERM`), the run continues, and the CLI prints `tavi run --attach <task-id>` to follow it again, plus `tavi abort <task-id>` and `tavi cancel <task-id> --reason <text>` for a running turn, or `tavi cancel` alone for a suspended task. Ctrl-C at an approval prompt detaches too. Pressed before the owner has answered `tavi run` (or `--attach`), the detach waits for the answer, which names the task; a second Ctrl-C quits at once. `tavi approvals approve|reject`, `tavi artifacts --resume` and `tavi schedules run-now` detach the same way once they follow the owner's resumed turn or fire. A Ctrl-C while the decision or fire itself is still unanswered ends the CLI at once, and the decision or fire may still have been admitted: check `tavi approvals list` or `tavi tasks` before repeating it.
- **`tavi chat`** quits on Ctrl-C: exit `0` when nothing is running, or `130` when a run is going, which the owner continues — the exit message names `tavi chat --attach <task-id>`, or, when the owner had not yet answered the prompt, the operation key it was sent under.
- **`tavi abort <task-id>`** stops the turn the owner is running for a task, recording nothing on the ledger: the task's status becomes `stopped` (`tavi tasks` lists it so; its stream ends with `task.stopped`), and the chat can be replied to as before; **`tavi cancel <task-id> --reason <text>`** is the durable, final stop: it ends a turn that is running too, so an attached `tavi run` exits as failed.
- **`tavi serve`** on `SIGINT`/`SIGTERM`/`SIGHUP` (on Windows, its console window closing, when the drain deadline is held to at most 5 seconds: Windows ends the process 10 seconds after) closes admission for every producer and removes its discovery files, so new commands run offline once it exits. It lets the turns already running finish within `--drain-deadline` (in milliseconds; default `10000`), while attached clients keep receiving their events, then aborts the rest (`ABORTED`) and exits — `0` after a clean drain, `70` when it had to abort turns or its disposal failed. While it drains, a new command finds no owner to attach to: one that needs the database is refused by the ownership lock (exit `5`) until it exits, and `tavi abort`, which needs an owner, finds none (exit `8`). A turn that holds the shutdown up is aborted by the owner itself at the drain deadline; only a client connected before the shutdown began can still send `abort`. An attached `tavi run` sees its stream end and exits with the outcome; if the connection closes first, it exits `4`, naming `tavi tasks <task-id>` to see how the task stands and `tavi run --attach <task-id>` to follow it once an owner is back. An unhandled rejection or uncaught exception in the owner is logged to its log and drains it the same way, releasing the data directory, then exits `70`.

---

### Upgrades

A build that adds a schema migration makes the data directory unopenable by older builds: `tavi` refuses a directory that records a migration it does not know. **Rollback is a restore.** Upgrade in this order:

1. Stop `tavi serve` — through its service manager for a unit from `tavi service unit` (`sudo systemctl stop <label>`; `launchctl bootout gui/$(id -u)/<label>` for the default LaunchAgent), or Ctrl-C in its terminal — and let it drain. Killing the process is not enough: the unit restarts it.
2. Take a snapshot: `tavi backup --out <dir>`.
3. Install the new build.
4. Start `tavi serve` again. The first open applies the new migrations.

To roll back, stop the owner, install the older build, and `tavi restore --from <dir>` the snapshot from step 2; anything written since is set aside with the replaced database. A build refuses to open a data directory whose schema records a migration it does not ship (exit `4`, naming the migration ids), and its `tavi restore` refuses such a snapshot ("written by a newer build"), so going back is always a restore, never only a downgrade. `tavi doctor` lists the migrations a directory has applied against the latest this build ships. A data directory or snapshot of another profile format (a development build's, from before `tavi-1`) is refused for its format ("Unsupported data profile format", or "Snapshot profile format is incompatible") and left unchanged: start it in a separate `--data-dir`.

A task's execution policy is durable and set when the task is created: **attended** for a CLI run, an IPC `run` or an inbound conversation; otherwise **unattended** (no `ask_user`), as for a spawned worker or a schedule fire whose checkpoints do not allow asking, and a stored task with no policy reads as unattended. An ordinary follow-up cannot upgrade an existing task's policy; creating a new task restores interactive work.

**IPC protocol.** A CLI, `tavi chat` or `tavi ui` of another IPC protocol version is refused by the owner when it connects, and a newer client by an older owner, with "restart the service": upgrade the clients with the owner.

**Memory cards**. The notices table takes the `memory` kind, and `tavi_memory_prompts` holds each memory card's records as ids — a token, the card's notice, the record id, its number on the card, and when it settled — deleted a week after a card settled and at once when its record is forgotten. Both are in `tavi backup` and the NDJSON export.

**Client event protocol.** A build that changes the events a task's stream carries bumps `CLIENT_PROTOCOL_VERSION`, and an event's version must match the reader's exactly. After installing it, restart `tavi serve`, then restart `tavi ui` and reload its open tabs, and restart any running `tavi chat`. A client left from the older build stops at the owner's first event with "the running `tavi serve` sent a frame this client cannot read … restart the service, or upgrade this client". Version 5 (the browser live view's audit) added `browser.controlled`: a person's hold of a task's browser the task did not wait for, shown in its transcript as "You controlled the browser for …". Version 6 added `turn.steered`, version 7 the plugins' `plugin.status`, `plugin.notice`, `plugin.state` and `turn.suggested`, and version 8 `task.stopped`; with 7 the IPC protocol went to 6, so an older client is refused when it connects.

### Upgrading the shipped system prompt

Chats in a workspace with no override start on the shipped default of the build that admits their first message. A chat already on a shipped default keeps it when an upgrade ships a newer one — its system text, and a provider's cache of it, stay as they were — while a new chat starts on the new one; a workspace override (set or cleared) still moves every chat at its next message, and a turn already running keeps the base its admission pinned (a task's own snapshot, the base it was created with, is kept as well), and `tavi system-prompt show` reports the workspace's own tier and revision. To hold a workspace on its current text across an upgrade, save it as an override (`tavi system-prompt set --file <path>`) — an override always outranks the shipped default. Rolling the template *content* back is a **forward** build change: restore the previous entry by pointing `DEFAULT_SYSTEM_PROMPT` and
`SHIPPED_SYSTEM_PROMPT_VERSION` at it again. Such a rollback reaches new chats only: a chat already on a shipped template keeps the one it has. Keep that entry in
`SYSTEM_PROMPT_TEMPLATES` — a task's snapshot records the version it selected
(the shipped version today is `tavi-default-5`; `tavi-default-1` to `tavi-default-4` are kept for the chats that started on them), so dropping the entry would leave the version unnamed and the task's own text
unexplainable — but note that nothing in the runtime resolves a version back to text: a task reads
its own stored text, so the registry is a record of what shipped rather than a lookup a running task
depends on. Do **not** downgrade the build to move a template back: a downgrade needs the database
restored from a snapshot, which sets aside everything written since, including this workspace's
setting row and every task's prompt snapshot (see *Upgrades*). A content rollback by contrast
rewrites no task and drops no row: a turn keeps the base its admission pinned, and each chat's next message takes the restored default. Reverting an
override is an explicit settings write with a new revision (`tavi system-prompt reset`).

A CLI and a daemon that speak different IPC protocol versions are refused before they connect: the discovery file carries the owner's IPC protocol version (currently `7`, bumped with the payload changes a release makes, and with an event protocol an older client cannot read: `6` came with event protocol `7`, so such a client is refused here rather than at its first plugin event; `7` gives `run` its `folder` and `clientCwd`, which a protocol-6 owner would drop unread, so a protocol-6 client and owner are refused by a protocol-7 one), and a mismatch reports ``the running `tavi serve` speaks protocol N; this CLI speaks M — restart the service``, exit `4`. An owner of the same protocol that lacks a command the CLI needs is refused too ("The running owner does not implement …", exit `4`). Either way, restart `tavi serve` with the new build; nothing falls back to the owner's database. The event protocol version (`7`, on every NDJSON event) is versioned separately.

---

### Output Formats & Event Streaming

Every command takes `--format <text|json>`, before or after its own flags. A command with a text form of its own prints it under `text`; one whose answer is a record (`tavi models list`, `tavi router …`) prints it as JSON by default and, under `--format text`, as indented `key: value` lines: `--format text` never prints JSON. `tavi tasks` and `tavi doctor` print text at a terminal and JSON in a pipe, unless `--format` says which: `tavi tasks` lists a task a line (status, when it last changed, its id and title) and counts what waits (pending approvals, effects and deliveries of unknown outcome, expired leases); `tavi doctor` prints a short summary of each check instead of the whole report. The interactive commands (`tavi chat`, `tavi ui`, `tavi serve`) have no JSON form and refuse `--format json`, saying so; another value, or `--format` given twice, is refused (exit `2`).

When `--format json` is passed to `tavi run` (with or without `--attach`), `tavi approvals approve|reject`, `tavi artifacts ... --resume`, or `tavi schedules run-now` under an owner, Tavi streams newline-delimited JSON (NDJSON) client events as execution progresses. Every event is one envelope — `protocolVersion` (the event protocol, currently `8`: `3` added `task.spawned`, `4` `wait.settled`, `5` `browser.controlled`, `6` `turn.steered`, `7` `plugin.status`, `plugin.notice`, `plugin.state` and `turn.suggested`, `8` `task.stopped`), `epoch`, `sequence` (increasing by one per event of the task within the epoch, from `0`; a `resync.required` marker repeats the head's), `runId` (the task id), `attemptId` and `at` — followed by its `kind` and that kind's fields. `attemptId` is the admission's attempt (`attempt-admission-…`) until its first model call, then that model call's own, so it changes within a turn; only a resume and a failover are announced, by `attempt.replaced`, and `approval.settled` names the attempt whose `approval.required` it answers. `tavi artifacts … --resume` first prints the decided artifact record as pretty-printed JSON, then the stream, and a `tavi schedules run-now` whose fire was not admitted prints only its outcome object: parse the stream from the first line that starts with `{"protocolVersion"`. A run under `--approval approve`, whose one gated call the owner answers:

```json
{"protocolVersion":8,"epoch":"session-92983-b6a01321-…","sequence":0,"runId":"task-mu76l1jl-1","attemptId":"attempt-admission-mu76l1jl-3","at":"2026-09-18T16:36:42.898Z","kind":"run.started","threadId":"thread-mu76l1jl-2","workspaceId":"default"}
{"protocolVersion":8,"epoch":"session-92983-b6a01321-…","sequence":1,"runId":"task-mu76l1jl-1","attemptId":"attempt-mu76l1jw-4","at":"2026-09-18T16:36:42.910Z","kind":"text.delta","blockId":"b-0","text":"Opening a browser session."}
{"protocolVersion":8,"epoch":"session-92983-b6a01321-…","sequence":2,"runId":"task-mu76l1jl-1","attemptId":"attempt-mu76l1jw-4","at":"2026-09-18T16:36:42.917Z","kind":"approval.required","callId":"call_1","toolName":"browser.create_session","summary":"Approve browser.create_session?","input":{},"steps":1,"approvalId":"approval:15:task-mu76l1jl-1:1:6:call_1","effect":"mutating"}
{"protocolVersion":8,"epoch":"session-92983-b6a01321-…","sequence":3,"runId":"task-mu76l1jl-1","attemptId":"attempt-mu76l1jw-4","at":"2026-09-18T16:36:42.918Z","kind":"approval.settled","steps":1,"decisions":[{"callId":"call_1","approved":true}],"decidedBy":"operator"}
{"protocolVersion":8,"epoch":"session-92983-b6a01321-…","sequence":4,"runId":"task-mu76l1jl-1","attemptId":"attempt-admission-mu76l1k6-5","at":"2026-09-18T16:36:42.918Z","kind":"attempt.replaced","supersededAttemptId":"attempt-mu76l1jw-4","reason":"resuming after approval"}
{"protocolVersion":8,"epoch":"session-92983-b6a01321-…","sequence":5,"runId":"task-mu76l1jl-1","attemptId":"attempt-admission-mu76l1k6-5","at":"2026-09-18T16:36:42.923Z","kind":"tool.started","blockId":"call_1","callId":"call_1","toolName":"browser.create_session","input":{}}
{"protocolVersion":8,"epoch":"session-92983-b6a01321-…","sequence":6,"runId":"task-mu76l1jl-1","attemptId":"attempt-admission-mu76l1k6-5","at":"2026-09-18T16:36:42.924Z","kind":"tool.completed","callId":"call_1","toolName":"browser.create_session","output":{"sessionId":"browser-session-1","state":"open"},"durationMs":0.488}
{"protocolVersion":8,"epoch":"session-92983-b6a01321-…","sequence":7,"runId":"task-mu76l1jl-1","attemptId":"attempt-mu76l1kg-6","at":"2026-09-18T16:36:42.928Z","kind":"text.delta","blockId":"b-1","text":"Session ready."}
{"protocolVersion":8,"epoch":"session-92983-b6a01321-…","sequence":8,"runId":"task-mu76l1jl-1","attemptId":"attempt-mu76l1kg-6","at":"2026-09-18T16:36:42.930Z","kind":"task.completed","finalText":"Session ready."}
```

The stream is the task's own, the same one an attached client receives from `tavi serve`: `epoch` is the owner session that produced it (this process, or the daemon), and a new epoch means earlier cursors cannot be resumed. `sequence` counts per task across all its admissions.

Event kinds include:
- `run.started`: The task's stream begins — emitted once, when the admission that creates the task takes its execution slot.
- `text.delta`: Incremental model response text chunk. Consecutive chunks of one block and attempt are merged into one event for up to 16 ms from the first, while the merged text stays under 1,024 characters; a larger chunk is never split.
- `tool.started`: Tool execution dispatched.
- `tool.completed`: Tool returned successfully.
- `tool.failed`: Tool encountered an error.
- `approval.required`: Execution paused waiting for operator authorization of a tool call. Carries the round (`steps`) and the approval row (`approvalId`). A call asked about after the chat read untrusted content also carries `provenance` (additive, so the event protocol is unchanged and an older client strips it): `gateReason` when the taint step asked, the context label's `sources`, `principals` and newest five `refs`, and `argOrigins` — up to 16 of the call's strings (each URL, email address, path or hostname, and every other string of at least 16 characters), each with where it appears verbatim in the newest 100 KB of the chat: `person`, `content` (with the message's `source`, the `host` Tavi parsed, `toolId` and `ref`) or `unmatched`. Display only: it never changes a decision. Masked with the input under `tools.redactResults`.
- `approval.settled`: A round was decided — by this command, another terminal, chat, an attached client or a schedule's policy — with its per-call verdicts and who decided. Emitted when the resumed turn is claimed, just before its `attempt.replaced`, naming the attempt whose `approval.required` it answers. After an owner restart that attempt is unknown: the event names the resumed attempt instead and no `attempt.replaced` follows, so a client clears a round's cards by `steps`, not by attempt. A round recorded before event protocol 2 is not announced.
- `attempt.replaced`: The same task resumed — after an approval decision, a reply, a deadline or a review — naming the attempt it supersedes. Its `reason` names the admission kind (`resuming after approval`). It also marks a failover: a model call that failed with a rate limit or a provider fault moved to the next target of role `main`'s fallback, as a new attempt; then `discarded: true`, and the superseded attempt's text — streamed already — is not part of the task's conversation, and its `reason` names both targets (`the model call failed over: a/m answered rate_limit (retry after 30s); b/n answers, …`). A consumer written before this field existed reads a failover as a resume and keeps the discarded text: key on `discarded` (or a `reason` starting `the model call failed over`). `tavi run --format text` prints the boundary on its own line, saying the text above it is not the answer.
- `task.spawned`: The task delegated to a worker (`agent.spawn`): the child task's id (`childRunId`), the worker agent, its definition when it has one, and its `depth` under the root.
- `task.waiting` / `task.review_required`: The task suspended on a wait (with the `question`, for `ask_user`, its `waitId`, its `context`, and a `handoff` when the person is asked to act in the browser) or on artifact review.
- `policyStopped` on `approval.required` / `task.review_required`: the owner published a run's pending round again because its `--approval approve|deny` answering stopped there — `{ reason, message }`, `reason` one of `not-own-artifact`, `decided-elsewhere`, `unavailable`, `round-limit` (free text, so a later one stays readable). The round, and every later one of the run, is a person's. Additive: the event protocol is unchanged, an older client strips it and sees the round announced twice, which every client folds into one.
- `tainted` and `knownUrls` on `text.delta` / `task.completed`: the turn read untrusted content, and the URLs its conversation already holds (normal forms, with a fragment when written with one; newest 256 within 64 KiB). Carried by the first `text.delta` after a model call of a tainted turn begins (`knownUrls` only when they changed since the last sent) and by `task.completed`; a later event without them keeps what was sent. The web canvas names the host of, and asks before opening, a link in the answer that is none of them, compared exactly as channels disarm URLs. Additive, like `policyStopped`: an older client strips them.
- `wait.settled`: A wait was settled and the task resumes — published when the resume is claimed, whichever path settled it (a typed reply, a button, an email link, a peer agent's reply, the deadline). Names the `waitId`, the `outcome`, the options chosen (`answers`), the reply clipped (`replyText`), who decided (`decidedBy`), through what (`via`), and, for a browser handoff, how it ended (`handoff`). Every attached client turns its question card into a receipt.
- `browser.controlled`: A person held the task's browser and handed it back while the task did not wait for it: the browser `sessionId`, the `outcome` (`done`, `failed`, `timeout`, `cancelled`), how long they held it (`controlledMs`) and their note (`replyText`). Nothing typed in the page is in it.
- `plugin.status`: A plugin's line for the task: `pluginId` and `line` (up to 200 characters; absent clears it). `tavi chat` shows each plugin's newest line on the status row while nothing asks you for anything, and the canvas in the chat's header. Never sent to a channel.
- `turn.suggested`: What plugins suggest the person does next (`suggestions`, 1–3, each up to 120 characters), at the turn's end, before `task.completed`. `tavi chat` prints them as a "Suggested next" line; the canvas shows each as a button that sends it as the next prompt. Kept in no transcript, never sent to a channel.
- `plugin.notice`: A plugin's one-off `notice` (up to 2,000 characters) on the task, from `pluginId`: a notice line in `tavi chat`, the newest beside the canvas chat's header.
- `plugin.state`: A value a plugin published for its canvas pane: `pluginId`, `stateKey` and `value` (any JSON, up to 16,384 characters, masked). The canvas keeps the newest per key and sends it to the plugin's contributions that declare `mod.state`. Never sent to a channel.
- `turn.steered`: A message sent into the running turn (`/steer`) was merged before its next model call: its `text`, and `messageId`, the reply's own `clientMessageId`, so the front end that sent it knows its message.
- `task.completed`: Task reached successful completion.
- `resync.required`: This subscriber's cursor can no longer be replayed — the owner restarted, or evicted what the cursor pointed into. Treat it as a reset, not an entry; its `sequence` repeats the stream's head.
- `task.stopped`: The person stopped the turn (`tavi abort`, the canvas's Stop, `Esc`). `message` says so in their words. Nothing failed, and a reply goes on in the same chat; a `tavi run` that followed it exits `1`, as a run that did not finish does.
- `task.failed`: Task terminated with failure. `errorCode` is `ABORTED` when anything else fired its signal (Ctrl-C or SIGTERM in the foreground, an owner shutting down), distinct from `CANCELLED` (`tavi cancel`) and from `MODEL_FAILED`.

A replayed `tavi run` — the same `--operation-key` as a run that already finished — emits only that run's recorded outcome offline, or under an owner that no longer holds the task's stream (after a restart or an eviction); an owner that still holds it replays what it holds: the whole stream from `run.started`, or — once the start was evicted — its tail, after a notice that the start is gone. `tavi approvals approve|reject` and `tavi artifacts ... --resume` resume an existing task, so their output never contains `run.started`: it opens with the resumed turn's events. Free-text fields are clamped to their bounds (a clamped value ends with `…`), so an event is never dropped for being too long.

A **refused** admission (exit `4`, see [Exit Codes](#exit-codes)) ends the stream without a terminal event: it is not a failure — the task is as it was — so no `task.failed` is emitted, and the refusal is reported on stderr. A consumer that reads to a terminal event must also watch the exit code. A first `tavi run` admission refused before any task existed (the same `--operation-key` with a different prompt) writes nothing to stdout at all.

---

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `TAVI_DATA_DIR` | Base data directory path | your user data directory (see Resolution Order) |
| `TAVI_PREVIEW_CHATGPT` | `1` offers Sign in with ChatGPT in setup (a preview) | unset: not offered |
| `TAVI_SANDBOX` | `off` turns `sandbox.run` off (as `serve --sandbox-tier unavailable`) | on where the host supports it |
| `TAVI_BROWSER_HEADED` | `1` opens the agent's browser in an off-screen window instead of headless; on Linux a headed browser runs outside the sandbox | headless |
| `TAVI_BROWSER_LINUX_CHROMIUM` | `headless-shell` runs Playwright's headless shell only in a confined Linux launch; `auto` prefers the full Chromium | `auto` |
| `TAVI_SCREEN_READER` | `1` asks setup's prompts as plain numbered lines, as `--plain` does | Ink prompts at a terminal |
| `TAVI_SERVICE` | `1` marks an owner run as a service (`tavi service unit` sets it): no setup offer, no `--dev-plugin` | unset |
| `TAVI_CREDENTIAL_KEYCHAIN` | `off` keeps a new credential key out of the OS keychain: a new data directory then starts unencrypted, and `tavi credentials encrypt` writes a key file | the OS keychain where available |
| `TAVI_CHECKPOINT_BLOBS` | `1` stores checkpoints per channel (experimental; see [ASYNC-PERSISTENCE](ASYNC-PERSISTENCE.md)) | unset: inline checkpoints |
| `TAVI_NO_REBUILD` | `1` makes `pnpm tavi` (`scripts/tavi.mjs`) skip its rebuild check | unset |
| `TAVI_API_KEY_FILE` | Default credential file for model provider | None |
| `TAVI_BASE_URL` | Base URL for OpenAI-compatible model endpoints | `https://api.openai.com/v1` |
| `TAVI_ORGANIZATION` | Optional `OpenAI-Organization` header | None |
| `RESOLVER_KEY` | Model resolver key: turns on `tavi models suggest` (off when unset) | unset: no suggestions, nothing sent |
| `RESOLVER_URL` | Model resolver base URL for `tavi models suggest` | `https://models.nannertech.com` |
| `USER` | Acting operator principal fallback | `operator` |

---

## Command Reference

### `tavi onboard`

Walks the setup steps that are still open, in the onboarding flow's terminal order: the model (the only step Tavi needs), then about you, where you keep tasks, channels, keeping Tavi running and a first idea. A step that is done is never asked about; `tavi setup` is the command that changes one. Unrelated to `tavi sandbox setup`.

```bash
tavi onboard [--workspace <id>] [--data-dir <path>] [--plain] [--paste]
tavi onboard status [--workspace <id>] [--json]
tavi onboard provider [<id>] [--json]
tavi onboard reset [--workspace <id>] [--json]
tavi onboard import [--from openclaw|hermes] [--dry-run] [--with-secrets] [--json]
```

#### Actions
- `status [--json]`: The checklist (`--json`: the `OnboardingStatus`): "Setup: N of M done", then every step of the flow by the same name Welcome and Home's card use, a step done in the canvas (apps, web search) with where and the command that does it now, on an indented line under the step. A model connected with `tavi models add` but not yet verified counts as set up, with **Verify** offered. Exit `0` when no required step is open, `3` when the model is. In the JSON, `complete` is `true` once the required steps (the model) are done, and `open` lists every step still open; each step carries its `title`, and `elsewhere` (`web` or `cli`) when it is done on the other surface. `tavi onboard status --json` also answers `funnel`: per step, how often it was reached, skipped and failed (with the last failure's code). It is kept on this computer only (at most 500 events) and cleared by `tavi onboard reset`.
- `provider [<id>]`: The installed onboarding flows, `*` marking the one in use; with an id, switches to it. The built-in flow is `tavi.onboarding`.
- `reset`: Forgets the workspace's skipped and seen steps and the dismissed checklist. Every model, key, connection, verification and what the flow created stay.
- `import`: Finds an OpenClaw install (`~/.openclaw/openclaw.json` and its `.env`, or `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH`) or a Hermes one (`~/.hermes/config.yaml` and `.env`, or `HERMES_HOME`) and lists its model connections and Telegram bot, each with where its key is (`OPENROUTER_API_KEY in ~/.hermes/.env`), never the key. `--dry-run` stops there. Otherwise it asks before copying any key or token into Tavi's credentials file (`--with-secrets` agrees in advance; a `--json` or non-terminal run never asks, so it copies none without the flag); declined, only servers that need no key are imported. An endpoint with a user, password or query in it is not imported. Each connection goes through `onboarding connect-key`, so it is added before its key is stored. The other agent's default becomes Tavi's only once it verifies, and only while Tavi has no working model. The bot is added and tested on a running owner; pairing is `tavi setup channels`. Neither agent's own credential store, OAuth sign-ins or gateway is read: a key kept only there is listed as not imported.

#### Options
- `--workspace <id>`: The workspace (default: `default`).
- `--data-dir <path>`: The data directory.
- `--plain`: One line per prompt, no live region (also `TERM=dumb` or `TAVI_SCREEN_READER=1`).
- `--paste`: Sign in with OpenRouter from another computer: paste back the address the browser landed on (over SSH).
- `--json`: Answer as JSON (`status`, `provider`, `reset`, `import`); `--format json`, the global flag, is the same.
- `--from openclaw|hermes` (`import` only): Only that one.
- `--dry-run` (`import` only): Say what would be imported, change nothing.
- `--with-secrets` (`import` only): Copy keys and the bot token without asking.

- **Sign in with ChatGPT (preview, off unless `TAVI_PREVIEW_CHATGPT=1`):** with the variable set for `tavi` and `tavi serve`, the model step offers *ChatGPT (preview)*; without it the option is not shown and the owner refuses the sign-in, naming the variable. An owner run as a service needs it in its unit too (`Environment=TAVI_PREVIEW_CHATGPT=1` in the systemd unit, or `EnvironmentVariables` in the launchd plist). With it: the browser signs in with your ChatGPT account (PKCE, back to `127.0.0.1` in this process) and Tavi registers itself as your own agent there. Answers then use your ChatGPT plan's allowance, which ChatGPT Settings → Usage shows and limits. That wire takes no output cap and no temperature, so no cap applies to its calls; `tavi doctor` says so on the connection (`modelConfiguration.connections[].note`). The sign-in is kept only in an encrypted credential store (`tavi credentials encrypt` first), renewed on its own, and a refused renewal asks you to sign in again. Over SSH, sign in on a computer with a browser and move the data directory's credential.

- **The model step:**
  - Detection first — the allowlisted key variables set in this shell (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, by name only) and an Ollama or LM Studio answering on this computer — offered as choices; then the featured providers, with OpenRouter recommended unless Ollama runs a model that calls tools; then *Another provider…* (every preset, and Custom with your own endpoint).
  - For OpenRouter the first choice is **Sign in with OpenRouter**: the browser opens OpenRouter, you allow Tavi, and OpenRouter makes a key for it (PKCE, back to a listener on `127.0.0.1` in this process; over SSH, `--paste` takes the address the browser landed on instead). A declined or failed sign-in falls back to *Paste a key instead*, and nothing is stored until a key is in hand.
  - Otherwise the key is asked hidden, from a found variable, or not at all for a local server (`local-no-key`); it is stored with `credentials set` under the connection's id and never shown again.
  - The connection is added at the preset's endpoint before its key is stored, its models are listed, and a main and a fast model are proposed (`main` from the top five, plus *Other…*).
  - Verify sends one short request that must call the probe tool: ✓ *Inference ready*, or plain advice with another key, another model or *leave it for now*.
  - A failed verify leaves the default where it was: a change in `tavi setup` is made on a new connection beside the working one, and becomes the default only once it passes.
- **Resuming:** the connection id is recorded before the first write, so a run stopped with Ctrl-C (exit `130`) picks up on the same connection — rebinding it rather than adding `openrouter-2`. A connection or a stored key of the preset's name that this flow did not create gets a suffixed id.
- **About you:** your name (`operator.name`) and time zone (`workspace.timezone`, written only when it differs from the host's) in workspace settings, and — while memory is on — as approved personal preferences `user.name` and `user.timezone` (a rerun corrects the one held, never a second). The heartbeat's active hours are asked only when the heartbeat is on. The step is then marked done.
- **Channels:** with a running owner, the featured channel (the first of the flow's featured kinds that is added with secrets alone; a flow that features none: Telegram when installed, else the first such channel installed) in its descriptor's own words: its setup help, each of its `auth.fields` asked hidden under its label, the connection saved and probed (Telegram's answers `Bot @name`), then a pairing code — *Send `4KX9-QM2P` to @name (https://t.me/name) within 10 minutes*, with the channel's deep link when it has one — waited for, and *A message from … carried the code. Is this you? [y/N]*: the person is allowed only on yes, under the workspace operator. A code the owner forgot (it restarted) or that expired gets a new one. Offline, the step says pairing needs `tavi serve`.
- **Keeping it running:** writes a user-scope unit (`~/Library/LaunchAgents/dev.tavi.serve.plist`, or `~/.config/systemd/user/dev.tavi.serve.service`) after a yes, never over a file it did not write; then *Start it now?* runs `launchctl bootstrap gui/<uid> …` or `systemctl --user daemon-reload && systemctl --user enable --now …` — never `sudo`, and only when no owner holds the data directory (a foreground `tavi serve` must stop first, and the command is printed instead). On Linux it prints `loginctl enable-linger $USER`. *I run it myself* marks the step done. `tavi setup service` offers **Remove** for the unit it wrote.
- **First idea:** three prompts at once from `ideas chips` (ideas, or chips for what Tavi can do here, else the flow's own), and a background `ideas refresh` on an owner while Ideas are on; the chosen one opens `tavi chat --draft`, unsent.
- **Apps and search:** the canvas's; `tavi setup search` adds a provider here, and `tavi apps connect <app>` connects an app (`tavi apps connect gmail`, say).
- **Owner:** with a running `tavi serve`, every write and verify goes through it over IPC; with none, the data directory is opened here and the same commands run in this process.
- **Prompts:** Ink at a terminal; one line per prompt, numbered choices and no live region with `--plain`, `TERM=dumb`, `TAVI_SCREEN_READER=1`, or when standard input is not a terminal.
- **Exit codes:** `0` no required step open, `3` one open, `4` an owner is needed, `130` cancelled (progress kept).
- **First run:** `tavi chat` and `tavi run` at a terminal, on an install that has no model and was never set up, ask at each start until a model is set up: *No model is set up. Run `tavi onboard` now (about 2 minutes)? [Y/n]*. `tavi serve` asks nothing: it prints one line saying to run `tavi chat` or `tavi ui` (or `tavi onboard`), then serves; under `TAVI_SERVICE=1` it prints nothing. Ctrl-C there stops the command too (exit `130`). An install that had a model before onboarding existed is never asked. Without a terminal, `tavi run`'s error names `tavi onboard`.

### `tavi setup`

Every setup step, or one (`model`, `about`, `search`, `apps`, `tasks`, `channels`, `service`, `ideas`), showing what is set now and keeping it on Enter (*Model: OpenRouter · … · verified. Change it? [y/N]*). The only command that changes a step that is done.

```bash
tavi setup [<step>] [--workspace <id>] [--data-dir <path>] [--plain] [--paste]
tavi setup --non-interactive --preset <id> [--base-url <url>] (--key-file <path> | --key-stdin) [--model <id>] [--fast-model <id>] \
           [--name <text>] [--timezone <iana>] [--active-hours 08:00-22:00] \
           [--search <kind> [--search-key-file <path> | --search-url <url>]] [--channel-secret <channel>:<field>=<path>]... [--json]
```

#### Options
- `--workspace <id>`: The workspace (default: `default`).
- `--data-dir <path>`: The data directory.
- `--plain`: One line per prompt, no live region.
- `--paste`: Sign in with OpenRouter over SSH: paste back the address the browser landed on.
- `--json`: Answer as JSON (with `--non-interactive`); `--format json` is the same.
- `--non-interactive`: No prompt at all, and each flag sets its own step; a step without its flags is left as it is.
- `--preset <id>`: A preset with a fixed endpoint (`openrouter`, `openai`, `anthropic`, `gemini`, `ollama`, `lmstudio`), or `custom` with `--base-url <url>`.
- `--base-url <url>`: With `--preset custom`, its OpenAI-compatible endpoint (refused with any other preset, and required with `custom`).
- `--key-file <path>`, `--key-stdin`: Where the key comes from: only from a file or standard input, never from an argument. A key file that is not there is refused as a usage error (exit `2`, `--key-file <path>: no such file`; JSON under `--json`). When a connection or key of the preset's name is already there (in use, or added outside setup), setup adds its own beside it (`openrouter-2`) and says so: it never changes a connection it did not make.
- `--model <id>`, `--fast-model <id>`: Choose the models (the suggestions otherwise).
- `--name <text>`, `--timezone <iana>`, `--active-hours 08:00-22:00`: Set about you (active hours only with the heartbeat on, else reported in `ignored`).
- `--search <kind>`: Adds and enables a search provider, with `--search-key-file <path>` for a kind that needs a key, or `--search-url <url>` for SearXNG.
- `--search-key-file <path>`, `--search-url <url>`: The key file, or the SearXNG address, for `--search`.
- `--channel-secret <channel>:<field>=<path>`: Repeatable (e.g. `telegram:token=bot.token`): gives a channel's secret field, one of its descriptor's `auth.fields`, as a file's trimmed contents, all for one channel (a second channel is `tavi channels add`'s, refused here as a usage error).

With `--channel-secret`, that channel is added and tested on a running owner (an id or field its catalog does not list is refused, `INVALID_INPUT`, before any file is read), and pairing is left open with `next: "tavi channels pair <channel>"` (channels are optional, so the exit ignores it); with no owner running it exits `4`, since a channel lives in the owner (`tavi serve`).

A required step left open exits `3`, naming the flag it needs (`--json`: `{ "exit": 3, "missing": "--key-file", "next": …, "ignored": […], "status": … }`).

### `tavi run`

Run one task, stream readable or JSON output, and exit. With no owner running, the task runs in this process: no background daemon is required, execution is checkpointed, and `SIGINT`/`SIGTERM` interrupt it cleanly. Under a live `tavi serve` it is dispatched to the owner instead, and Ctrl-C only detaches (see [below](#tavi-run-under-a-live-owner)).

```bash
tavi run [options] <prompt>
tavi run --attach <task-id> [options]
```

#### Positional Arguments
- `<prompt>`: The natural language prompt or instructions for the agent (required, except with `--attach`).

#### Options
- `--connection <id>`: Model provider connection ID (e.g. `openai`, `local-ollama`). Without it the target is role `main`'s — its binding (`tavi models set-role main`), with the fallback after it — else the workspace default (`tavi models set-default`); a workspace that configures neither uses the default workspace's. A target the catalog marks unavailable is passed over (the run says so); when every configured one is, the run is refused (exit `2`), pointing at `tavi models roles` — as is every command that resolves a run's target the same way: `tavi serve` at startup, `tavi approvals approve|reject`, `tavi schedules run-now` and `tavi inbox replay`.
- `--model <id>`: Model identifier to use (e.g. `gpt-4.1-mini`, `llama3.3`). Without it: role `main`'s or the default's model; with `--connection` alone, the default's model when the default names that connection, else the connection's own (`--connection` alone consults no role binding). Named alone, it runs on the connection role `main` names first (its binding's, else the default's), whatever the catalog says of the configured model, with no fallback.
- `--workspace <id>`: Workspace ID scope (default: `default`).
- `--principal <id>`: Acting principal ID (default: `operator`).
- `--approval <ask|approve|deny>`: Tool call approval policy (default: `ask`). `approve` answers every round nobody sees, its workers' included, but denies a call the taint step asked about, a tainted call of a tool that asks under taint, and a `critical` call, with the reason as the call's result, as a schedule fire does (`unattendedDenial`). `approve` also releases the run's own artifact reviews — a browser download or capture, a sandbox file, a file an upload or send by `path` stored pending — approving each, recorded as reviewed by `auto:<principal>` (never a person), copying a download into the chat's `downloads/`, and resuming the turn, so the model reads what its tools fetched, labelled as it was stored. `ask` and `deny` leave a review for a person (exit `6`). Under a live owner, when the owner stops answering a `approve`/`deny` run's rounds — a review naming an artifact that is gone or not the run's own, a round another front end decided (the run's later rounds are then a person's), the owner no longer admitting, or the 50-round limit — the run ends as a foreground run ends on a round left for a person: exit `6` for a review, `3` for an approval round (reported, never asked), printing why and the command that continues it (`tavi artifacts approve <artifact-id> --resume`, `tavi approvals approve <task-id>`).
  - `ask`: Prompt interactively on TTY. In non-interactive environments, raises an error with exit code `3`.
  - `approve`: Automatically approve mutating/external tool invocations.
  - `deny`: Automatically reject mutating/external tool invocations.
- `--api-key-file <path>`: Explicit path to file containing model API key (mode `0600`). Overrides `TAVI_API_KEY_FILE`.
- `--http-allow-host <host>`: Allow `http.request` and `web_fetch` to reach this host (repeatable; exact or `*.suffix`). The list says only where they can go: a call to a listed host can still stop on a card, depending on what the chat has read and where the address came from. With none they are not offered at all.
- `--http-request-header <name>`: Let the model set this extra request header (repeatable). Credential headers are refused here; bind those with `--http-credential-host`.
- `--http-credential-host <ref>=<host>`: Bind a credential reference to a host it may be sent to (repeatable). Unbound references are refused.
- `--browser-allow-host <host>`: Let the browser open this host when nobody was asked (repeatable; exact or `*.suffix`). A person who allows the browser for a task lets it open any http(s) site.
- `--messaging-allow-destination <destination>`: Allow `messaging.send_to` to address this destination (repeatable): `chatId` for any connection, `connectionId:chatId` for exactly one, `*:chatId` for every connection, or `providerId:*` for anyone on that channel. The bare form is honoured only while a single messaging connection is configured. Omit to deny every destination.
- `--operation-key <key>`: Idempotency key. Re-invoking with an existing key returns the committed admission without re-executing actions. It may not begin with `schedule:`, `reminder:` or `home:`, which are reserved.
- `--in-memory`: Run using an ephemeral in-memory SQLite store (no data written to disk).
- `--format <text|json>`: Output format (default: `text`).
- `--quiet`: Suppress diagnostic logging on stderr.
- `--data-dir <path>`: Custom data directory path.
- `--attach <task-id>`: Follow a task a live owner is running (or has run), from its beginning, instead of starting one. Takes no prompt, and only `--format`, `--workspace`, `--principal`, `--data-dir` and `--quiet`: any flag that shapes a run is refused (exit `2`).
- `--folder <path>`: The run's chat works in this folder, which must lie under one of the owner's `--fs-root` folders, outside the data directory, the credential folders and `--dev-plugin` folders, and must not be your home folder itself; `~` and a relative path are this terminal's. Needs a live owner (exit `4` otherwise; with `--in-memory`, exit `2`); a folder the owner cannot use is refused before anything runs. Not with `--home`, `--attach` or `--managed`, and not empty (exit `2`).
- `--managed`: The run's chat works in its own folder, whatever this terminal's directory. Not with `--home` or `--attach`.
- `--home`: Post the prompt into your Home chat as its next turn, instead of a chat of its own (needs a live owner).
- `-h, --help`: Show help text.

#### Text output
`--format text` streams the answer and prints each tool call as `[tool]` lines. A call that needs approval is printed once as `[approval] <what it does>`: a file change (`fs.edit`, `fs.write`) with its first 20 diff lines, as `tavi chat` shows it (the rest in `tavi approvals show <task-id>`), any other call with its input, then a `Flagged:` line when something besides taint flagged it (a guard mod's reasons, the shell checks'), which `tavi approvals show` repeats under the call. Under `ask` the terminal then asks `Approve <what it does>? [y/s/a/N]`. Once the round is decided, `[approval] approved|denied by <who>` says how — `--approval approve|deny` for the run's own policy, a schedule's policy, or the person who decided — and the run goes on after `[attempt] replaced <attempt>: resuming after the decision`.

---

### `tavi run` under a live owner
While `tavi serve` owns the data directory, `tavi run` does not open the database. It dispatches the run to the owner over IPC and follows the task's stream, rendering the same text or NDJSON the foreground renders; the exit code comes from the event the stream ends on (`0` completed, `1` failed, `3` an approval round, `6` an artifact review, `7` a wait).

#### Options
- `--connection <id>`, `--model <id>`: Together they are the run's own model: sent as `run`'s `model`, saved as the chat's before its first turn, and refused (exit `2`) when no configured connection offers it. With `--home`, or either alone, they are an assertion, not a choice: a run naming another target than the owner's default is refused with exit `2`, naming it.
- `--api-key-file`, `--allow`, `--http-allow-host`, `--http-request-header`, `--http-credential-host`, `--browser-allow-host`, `--messaging-allow-destination`: **The tool policy and credentials are the owner's.** These flags shape the owner's composition, not one run: a run naming any of them is refused with exit `2` rather than run under a policy the operator did not ask for. Set them on `tavi serve`, or stop it to run with them. `--fs-root`, `--messaging-allow-tool` and `--approval-expiry` exist only on `tavi serve`: `tavi run` does not accept them.
- `--approval <ask|approve|deny>`: `ask` (the default) asks each approval round on a terminal once every call of it has arrived, and answers it; without a terminal the round is reported with exit `3` and waits for `tavi approvals approve|reject`. A prompt is withdrawn when another front end decides its round first. `approve`/`deny` have the owner answer every round itself.
- `--attach <task-id>`: Follows a task the owner is running (or has run), from its beginning, with the same exit codes. The stream replays every admission of the task, so the outcome is read from its last event — a task that waited and then completed exits `0`. A task the owner holds no stream for (it ended before the owner started, or its stream was evicted) is reported from its recorded outcome; one still admitted is followed live. Rounds the owner answers itself — a `run` under `approve`/`deny`, or a schedule's fire — are only rendered, never asked. It needs a live owner (exit `4` otherwise).

- **Ctrl-C detaches; the run continues.** This differs from a run with no owner, where Ctrl-C aborts it. On detach the CLI prints `tavi run --attach <task-id>` to follow it again and, for a running task, `tavi abort <task-id>` and `tavi cancel <task-id> --reason <text>`; for a suspended task it prints only `tavi cancel`, since there is no running turn to abort. The exit code is `130` (`143` on `SIGTERM`). Ctrl-C before the owner has answered detaches once it names the task; a second Ctrl-C quits at once.
- **An unknown outcome names its key.** When the owner does not answer `run` (a timeout, or the connection closing first), the run may still have been admitted: the CLI says so and prints the operation key — its own, when none was given — so a retry with `--operation-key` resolves the same task instead of starting another. Exit `4`.
- **The chat's folder**. Without `--folder`, `--managed` or `--home`, the run sends this terminal's directory as `clientCwd`; the owner makes it the new chat's working folder when it lies under one of its `--fs-root` folders and is not your home folder itself. Otherwise the chat works in its own folder (`<data-dir>/chats/<workspace>/<task-id>/`) and one line on stderr says why (`This chat works in its own folder, not <dir>: <reason>`; with no `--fs-root` at all, `This chat works in its own folder. Start tavi serve with --fs-root <path> to let chats work in your folders.`), unless `--quiet`; `tavi chat` says it once a session. Home never takes a directory.

---

### `tavi abort`
Stop the turn a live owner is running for a task: the turn ends `failed` with `ABORTED`, and nothing is recorded on the ledger, so the task can still be resumed or replied to. It is distinct from `tavi cancel`, which is durable and final.

```bash
tavi abort <task-id> [--data-dir <path>]
```

#### Options
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

A task with no running turn — finished, or suspended on an approval, a review or a wait — has nothing to abort (exit `8`); cancel it instead. With no owner running there is no turn to abort (exit `8`). An unknown task exits `4`.

---

### `tavi chat`

A terminal UI over a live `tavi serve`. The first prompt you type is dispatched
to the owner as a run, with an approval policy of `client`, and its stream is
rendered as it arrives.

```text
tavi chat [--workspace <id>] [--principal <id>] [--data-dir <path>]
tavi chat --no-memory | --private [options]
tavi chat --attach <task-id> [options]
tavi chat --draft <text> [options]
tavi chat --replay <ndjson-file> [--stats <file>]
```

#### Options
- `--draft <text>`: Opens a new chat (never Home or the chat it would continue) with `<text>` in the prompt, unsent: edit it, then Enter sends it. `tavi onboard`'s first idea opens it this way. Refused with `--attach` or `--replay`; at most 4000 characters.
- `--attach <task-id>`: Follows a task from its beginning — through every
  turn of a task continued before, and on into one still running. When the owner no
  longer holds the start of the stream, the first line says so; a task whose
  stream it holds none of (it ended before this owner started, or its stream
  was evicted) is printed from its saved turns and reported from its record.
  A Home — the person's own, or any task whose record says `chatKind: "home"`,
  so also one named while `chat.home` is off or the Home lookup failed — is
  not replayed: its newest saved turns are printed and it is followed live
  from now, as a bare `tavi chat` opens Home.
  It opens in place of Home. Its approval rounds are decided with `y`/`n` as
  a run's are (below), and its question is answered by typing when an IPC
  run started it. A prompt typed once it has finished — on its stream, or by
  its record — continues it, when an IPC run started it (its conversation is
  read off its record); otherwise the prompt starts a new chat, or goes to
  Home. A record that cannot be read sends nothing: type the prompt again.
- `--replay <file>`: Renders a recorded stream (`tavi run --format json`,
  one task's, in order) without connecting, at 250 events a frame (about
  7,500 a second), then exits. A file that is not one task's stream in order
  exits `2`, naming the file and line, before anything is drawn. Only the
  lines checked are played: lines added while it plays are not, and a line
  changed in place ends the replay with exit `2`.
- `--stats <file>`: Writes render statistics on exit as JSON: `events`,
  `deltas`, `treeUpdates` (views handed to React), `renders` (frames Ink
  drew), `committedLines`, `peakRssBytes`, `heapUsedBytes`, `reactBuild` (the
  React reconciler that ran: `production`, `development` or `unknown`),
  `elapsedMs`, and the terminal's `rows` and `columns`. Under
  `NODE_OPTIONS=--expose-gc` the heap is measured after a full collection
  (`collected: true`): what the session retained — for a replay, with the UI
  still drawn. A diagnostic; the release gate reads it.
- `--no-memory`, `--private`: Make the first prompt start a
  chat of its own — never Home — sent as `run { memory: "off" }` or
  `run { memory: "private" }`: memory off (`/memory on` turns it back on), or a
  private chat, off for good, left out of past-chat search and *Earlier chats*,
  whose saved turns the retention sweep forgets 24 h after its last. Its side
  chats take its mode; a chat started later in the session is ordinary. Neither
  goes with `--attach` or `--replay`, nor with each other.
- `--workspace <id>`: Workspace to act in (default: `default`).
- `--principal <id>`: Personal principal (default: `operator`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

Once the first prompt's task has finished — completed, failed or
aborted — the next prompt **continues it**: it is sent into the task's
conversation, the owner runs it as a new turn of the same task, and the model
sees the earlier turns. A prompt typed while a turn runs is queued and sent
when it ends; `/steer <text>` sends it into the running turn instead
(below). While an approval round or an artifact review is offered,
its keys (`y`, `s`, `a`, `n`, `N`…) decide it, so no prompt is typed then —
only a `/command`; decide first, then type. The web canvas, whose buttons
decide, queues a prompt typed then. Attached to a chat whose stream the owner no longer
holds, it prints the chat's saved turns before its recorded ending. `/side` makes the next prompt start a side chat of the chat shown (with Home off, `/new` starts a chat of its own). A
chat this terminal cannot reply to (one started on another connection) is not
continued: the prompt starts a new chat (with Home on, it goes to Home), and
the chat says so. A continued
prompt runs as the task's own principal, which is the chat's unless it
attached to another's task. Each turn is bounded on its own: the loop guards
(24 model steps, 64 tool calls by default) count one turn, not the whole
task, and a chat never ends for its length — its history rolls over
into an epoch summary before the conversation's bound; a turn's last step is offered no tools, so it ends with an answer
from what was gathered rather than a failure. A cancelled task is not
continued. The status line says where the next prompt goes: it continues the
chat shown, goes to Home, or starts a chat of its own. No message tells you to
start a new chat to recover: a turn that failed, or a prompt that was not sent,
is sent again in the same chat.

**Home.** While the workspace's `chat.home` is on
(`workspace-settings get` → `effective.homeChat`, read once as the chat starts;
a failed read is off), a bare `tavi chat` opens on the person's Home (`tasks
list` with `chatKinds: ["home"]`, its `principalId`, `limit: 1`): it prints the
newest page of Home's saved turns, follows Home live from now — a Home
is not replayed from its beginning — and settles from its record, so the next
prompt continues it (`reply` into `home:<principal>`). With no Home yet, the
first prompt is sent as a run with `target: "home"`, which begins it; any
prompt with nothing else to continue goes the same way. Commands:

- `/side [topic]` — the next prompt (or the topic, sent at once) starts a side
  chat of the chat shown: a run with `parentChatId` naming it,
  which begins with background from that chat and reads its chat notes. With
  no chat shown it starts an ordinary chat of its own, with no target. A
  `/side` typed while a turn runs keeps the chat shown then as its parent.
- `/home` — back to Home: the chat shown is let go (a turn still running goes
  on at the owner; prompts queued behind it are dropped, and said so), and Home
  is opened as at the start. With no Home yet, the next message begins it.
- `/chats` — the workspace's 20 most recently touched chats (`tasks list`, `chatKinds:
  ["home", "side", "run", "chat"]`, so no worker), the person's own Home first,
  each with its task id, kind, status and title; the one shown is marked.
- `/open <task-id>` — opens that chat as `--attach` does (a Home as `/home`
  does), and continues it.
- `/compact` — fresh context: sends `chat-context { action:
  "compact", taskId }` for the chat shown, so its next message starts a new
  epoch whatever its length; says so, or why the owner refused. With
  no chat shown it says a new chat starts fresh anyway. In a tainted chat it
  adds that fresh context does not clear taint.
- `/taint` — what the chat shown read that Tavi does not trust each source as Tavi established it (a page's host, `mail you forwarded or quoted (via <domain>)`,
  the kind), a page's own title after it as "the page calls itself “…”", what
  taint changes, the remedy (start a fresh chat), and that `/compact` does not
  clear it. While the chat shown is tainted the status line ends with `⚠ Read
  <up to three sources> (/taint)`, read with `tasks { action: "label" }` as
  each turn ends and from each round's label. A round's card prints, under
  each tainted call, `⚠ Why am I asked?` with the gate reason in plain words,
  `read: …` with those sources, and where each of the call's values appears
  (`from your message`, `appears in <host>`, or not in the chat's recent text).
- `/steer <text>` — steering: while a turn of the chat shown runs,
  sends `reply { taskId, text, clientMessageId, intent: "steer" }`; the turn
  reads it before its next model call, and the stream's `turn.steered` prints
  it there (`❯ <text> (sent into the turn)`). Says `… sent into the running
  turn`, or — when the owner found the turn already ended — that it went as the
  chat's next message. With no turn running it is a prompt like any other
  (queued prompts are unchanged: a line typed during a turn still queues).
- `/model [<connection> <model>]` — the chat shown's own model: bare,
  sends `models chat` and names it (or, with no chat shown, `models roles`'
  `activeTarget`, what a new chat runs). With a connection and a model it sends
  `models set-chat` for the chat shown, then `models set-default`, and reads
  `roles` again to say when role `main` or the owner's flags still choose
  another model for new chats; a refused `set-chat` sets no default. With no
  chat shown it sets the default only.
- `/folder [show|set <path>|add <path> [--rw]|drop <label>|reset]` — the chat shown's working folder: bare (or `show`), sends `folder show` and prints where the chat works, its attached folders with their modes, and its own folder when the primary is a host folder; `set` sends `folder set { path }`, `add` `folder attach { path, mode? }`, `drop` `folder detach { label }` and `reset` `folder reset`, each from the chat's next message. `~` and a relative path resolve in this terminal before the owner checks them against its `--fs-root` folders. `/folder reset` also recovers a folder that is gone. With no chat shown it says so. Home's folder moves only by this: `tavi chat` sends `clientCwd` with every prompt that starts a chat of its own — a side chat, or a new chat with Home off — never with a message to Home, and prints the owner's line when the directory was not used.
- `/new` — `/side`'s old name, kept for one release; it says so.
- `/answer [<n> <text>]` — lists the questions open in the chat shown,
  numbered, its own first and then its workers'; with a number and
  text, answers that one: the chat's own as a typed answer is, a worker's with
  `approvals { action: "answer", taskId: <worker>, waitId }`.

**Workers' questions.** Every 5 s the chat reads what the chat shown's
workers wait on (`approvals { action: "needs", rootTaskId }`) and prints each
new question once, with the worker's name and numbered options (`? Researcher
asks: …`), and each browser handoff once (it is taken in the web app). A typed
line answers a question only when exactly one is open — the chat's own or a
worker's, the latter at the worker's wait, never as a turn of the chat. With
two or more open, it says how many and that `/answer <n> <text>` answers one,
and the line is a message: queued behind the chat's turn when the chat waits
on its own question, otherwise sent as usual. An owner that refuses `rootTaskId`, or answers without `handoffs` because it dropped
the key and listed the workspace, is not asked again. Opening another chat
lets the previous chat's worker questions go.

**Notices.** A saved page printed on opening a chat (Home, or
`--attach`) prints its notices among its turns, each after the turn it
followed, as one line: `◆ <title> — <summary> (task <id>)` (an "Earlier
chats" list on one line, `;`-separated). With the workers' 5 s cadence the
chat reads the chat shown's notices (`tasks { action: "notices" }`) and prints
each new or updated one once. The first read of a chat prints those posted
since it was shown here (for a run it started, since its prompt was sent — a
new Home's "Earlier chats") and only learns older ones; a notice placed before
the saved page printed is never printed below it. Replying to a notice in a side chat is the web app's.
A memory card prints as one line read from the memory when it is shown
(`memory { action: "card" }`), never from the notice: `◆ Proposed: You're
vegetarian — /memory keep 1 · /memory discard 1` (several are numbered:
`◆ Proposed: 1. You're vegetarian; 2. Prefers metric units — /memory keep <n> ·
/memory keep all · /memory discard <n>`), and `◆ Saved: …`, `◆ Discarded: …` or
`◆ Forgotten: 1 item` once decided; a sensitive record is counted, never named,
and left to the app. The memory commands are `tavi.memory`'s, run
through the owner like `/heartbeat`: `/remember <text>` (`--chat` for this chat
only; `key: value` saves a preference), `/forget <words>` then `/forget <n>`,
`/memory` (status: on or paused, `capture`, `sensitive`, this chat's mode and what waits), `/memory review` (a tidy-up marked `tidy-up, open Tavi to compare`; it is kept in the app only), `/memory keep <n…>` | `keep all`,
`/memory discard <n…>`, `/memory off` | `on` (this chat's memory:
anyone's for their own chat; a private chat stays off, and an off chat takes
only these and `/memory`), `/memory pause` | `resume` (the workspace operator's)
and `/why`. A number is the newest memory card in the chat shown or the
terminal's own newest listing there; the canvas and each channel keep their
own listings ([MEMORY.md](MEMORY.md) B.1). An answer that used memory is
followed by a dim `memory: 3 used · /why` line, live and in a chat's
printed saved turns; one whose model listed what is kept says
`memory: 5 looked through · /why` or `memory: 1 used, 4 looked through · /why`.
`/why` names them.

With `chat.home` off, `/new` is what it was (an ordinary chat, no parent),
`/side` still opens a side chat of the chat shown, and `/home` says that Home
is off and that `tavi config set chat.home on` turns it on. `/help` is worded
for whichever is in force.

Each turn's stream:
- finished lines of text, tool results and resume boundaries scroll into the
  terminal's own history, where your terminal can search and copy them;
- only the line being written, a running tool, a status line and the prompt
  stay live at the bottom.

The live region is at most a few rows, and always shorter than the terminal:
a long answer shows its newest rows while earlier rows scroll up. Text is
printed without escape sequences or control characters, whatever the model or
a tool produced.

- **Needs a terminal.** Without one, `tavi chat` exits `2`; use `tavi run` in
  scripts and pipelines.
- **Needs a running owner.** Without one it exits `4`, naming `tavi serve`.
  The client reconnects on its own when the owner restarts: about 12 s, with
  pauses of 4 s and 8 s. It says when it reconnects, resumes the stream, and
  says when what happened before the restart cannot be shown; it then reads
  the task's record for the round, reply or review it waits on.
- **Tool cards.** Each tool call is a card in the transcript: the tool, what
  it was called with, how long it took, and its result or error.
- **Approval rounds** are one card each, listing every gated call of the
  round. Press `y` to approve the whole round once, `s` for the rest of this
  chat (in Home or a messaging chat: a day, or until it rolls over), `a` always (a workspace rule matching exactly what the card shows),
  `n` to reject it, or `N` to reject it with a reason you type (Enter sends,
  Esc cancels); `s` and `a` work only where every call of the round offers
  that scope, and a round is decided as a whole. A foreground or
  attached `tavi run` asks the same as `[y/s/a/N]`, listing only the scopes
  offered; the decision names the round, so a round
  that moved on or was decided elsewhere first is refused and offered again,
  never decided in its place. The keys are offered once every call of the
  round is on the card: the owner announces a round a call at a time, and the
  chat lists the round's calls first. Once settled — here or anywhere — the
  card is followed by who decided it, as the owner announces it. The command that
  decides a round elsewhere, `tavi approvals approve|reject <task-id>`, is
  named on the card too.
- **Rounds the owner answers itself** — a run's `approve`/`deny`, or a
  schedule's fire while it runs — are shown with no keys (the owner would
  refuse a decision); a fire's round names its schedule. A fire that ends with
  a round still pending leaves it to you: the chat notices within a few
  seconds, says so, and offers the keys.
- **Esc aborts** the running turn (`failed`, `ABORTED`, as `tavi
  abort` does); Ctrl-C only detaches from it.
- **Reviews** of archived output are one card, listing every flagged
  artifact: `y` releases all of it and resumes the chat, `n` rejects all of it
  and resumes (the decision names the review's round, as a round's does).
  Deciding artifact by artifact is `tavi artifacts approve|reject
  <artifact-id>`, named on the card; a review the owner refuses — part of it
  decided elsewhere, say — is not offered again, and the chat says why.
- **Questions** (`operator.ask_user`) in a run started from `tavi chat` or
  over IPC are asked in the run's own conversation on the owner's local
  connection: the chat shows the question, and what you type next is the
  answer — sent as a reply into that conversation, answering the question
  through the same path a chat reply takes, rather than starting a run. A
  question asked with no chat attached waits on its record; one attaching
  later shows it and takes the answer the same way. A task started from
  another chat (Telegram, say) is answered there; the question is shown
  only. Other waits (on a worker, or a deadline) are explained once and
  resume on their own.
- **Status panes.** `/agents`, `/schedules` and `/approvals`, typed at the
  prompt, print a snapshot read from the owner into the transcript: the
  workspace's agents and the mailbox of the task the chat follows (what other
  agents sent it that it has not received yet, oldest first — an envelope
  past its expiry is listed as expired until it is swept; a followed task in
  another workspace has its mailbox left out, and says so); each schedule's
  next fire, or why there is none, and its last outcome and failures in a
  row; and the workspace's pending approvals a round to a line, each naming
  where it is decided — for the task followed here, its card, or the owner or
  schedule's fire that answers it; `tavi chat --attach` or `tavi approvals`
  otherwise. A round the listing's bound cuts is left out rather than shown
  in part. `/help` (or `/?`) lists them. A command is taken even while a run
  is going or a round is offered: whatever starts with `/` then is the
  command's — the longest command it begins is kept and the rest dropped, so
  no key of it is ever a `y` or an `n` — Enter runs it once it is whole, and
  Esc drops one half typed rather than aborting. A pasted command waits for
  Enter, as a pasted prompt does. A line whose first word is a command's
  (`/agents all`, `/models remove x`), or a lone slash-word that is none
  (`/agnets`), is refused as an unknown command rather than sent to the
  model; anything else (`/etc/hosts?`) is a prompt. `/credentials` lists the
  credential references the owner stores (names only), `/models` its
  model connections, the workspace default and the role bindings, and
  `/plugins` its built-in and installed plugins with their state there and any
  version awaiting review (changes are `tavi plugins`'s or the canvas's).
- **Forms** write the configuration a chat needs, a field at a time in the
  prompt row: `/credentials set [reference]`, `/models add [id] [base-url]
  [credential] [model]`, `/models set-default [connection] [model]`, `/models
  set-role [role] [connection] [model]` and `/models test [connection]
  [model]`. Words after the command fill the fields in order; bare, the form
  asks every field (Enter on nothing leaves an optional one out), and with
  words, only the required ones they leave out. A field that does not do —
  a role that does not exist, a reference or connection id not of the shape
  the owner accepts, a key where a name belongs — is asked again, saying why
  without echoing what was typed; a line break typed into a field answers it,
  and one chunk may answer several. While a form is open every key
  is its own, never a `y`, `n` or abort; Esc cancels it, sending nothing. A
  credential's value is typed masked (bullets), sent to the owner once, and
  never shown, never in the transcript and never taken from the command line
  (`/credentials set openai sk-…` is refused). A form open when the owner
  goes is closed, and one is not opened with the owner gone. A model write
  takes effect on the owner's next turn, with no restart. `models
  test` waits up to 30 s.
- **A credential typed as a prompt** — a provider key, a bearer token, a
  private key, a connection string's password, any shape tool output masks
  (`tools.redactResults`) — is drawn as bullets in the prompt row from the moment it has
  that shape, and refused on Enter, before anything echoes it: never sent to
  the model, into the transcript, as an answer, or in a command's refusal
  (`/credentials add openai sk-…` is refused as a credential, not as an
  unknown command). The refusal points at `/credentials set`.
- **Ctrl-C quits.** It exits `0`, or `130` when a run is still going. The owner
  continues that run, and the exit message names `tavi chat --attach
  <task-id>` to follow it again — or, when the owner had not yet answered the
  prompt, the operation key it was sent under (for a continued task, the
  message id its prompt may have been recorded as). A continuing prompt not
  yet sent is not: the chat exits `0` and says the task was not continued.

The UI (React, Ink) is loaded for this command alone. No other command pays
for it, and it runs in React's production build whatever `NODE_ENV` says.

---

### `tavi ui`

Serves the web canvas on `http://127.0.0.1:<port>` and bridges it to the
live `tavi serve` of the data directory (exit `4` without one).

```bash
tavi ui [--print-url] [--port <n>] [--data-dir <path>]
```

#### Options
- `--print-url`: Print the link instead of opening a browser.
- `--port <n>`: Listen on this port. Without it, `tavi ui` listens on any free one.
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

It also
answers `GET /oauth/callback`, where a provider sends the browser back after a
channel sign-in: with no session, it hands the redirect's state and code to
the owner, which checks the state (single use, 10 minutes), and shows only
whether the sign-in worked ([CHANNELS.md](CHANNELS.md)). It is its own
process and a client of the owner: one IPC connection carries every tab.

- **Opening it.** A one-time link opens in the browser — or is printed, with
  `--print-url` or when no browser opens. On macOS the opener (`osascript`)
  reads the link on stdin, so it is on no command line. Elsewhere (`xdg-open`;
  on WSL `wslview` or Windows' own handler; on Windows `ShellExecuteW`, which
  hands it to the browser on its command line) an opened link is on a command line, which other accounts on the
  computer can read in the process list, so `tavi ui` then prints a line on
  stderr: on a computer shared with other people, use `--print-url`, which
  keeps the link out of it. Its token is in the URL's fragment
  (never sent to a server, nor in a `Referer`), is valid once, for a minute,
  and is exchanged by the page for a session cookie and a session secret. The
  page keeps the secret in the tab's own storage (`sessionStorage`, which no
  other port's page can read), so a reload keeps the session, the page and the
  page's last task — its answers, not its prompts, which the task's stream
  does not carry — and the next prompt continues it. A new tab, or a
  tab whose session has ended, needs a new link: press Enter where `tavi ui`
  runs. A session lasts twelve hours.
- **The page's paths.** Each route has its own path, so a refresh, a bookmark
  or Back lands where it was rather than always on the chat: `/` is the chat on
  the session the page holds, `/tasks/<taskId>` the chat reading that session
  (opened if the page does not hold it), `/tasks/<taskId>/<tab>` the same with
  the chat panel open on that tab, `/center` or `/center/<section>` the
  Command Center at that section, `/center/schedule/routines/<routineId>` a
  routine's page and `.../runs/<runId>` one of its runs, and `/settings` or
  `/settings/<view>` the settings at that view. The Routines tab and Settings →
  Schedules merged into the Center's Schedule section, and their old paths
  redirect (`replaceState`): `/routines` and `/settings/schedules` to
  `/center/schedule`, `/routines/<routineId>[/runs/<runId>]` to the same page
  under `/center/schedule/routines/`. `/center/schedule/reminders/<reminderId>`
  is a reminder's page (on an owner that offers `reminders`). A path the canvas does not know is the chat, and
  the address bar is corrected.
- **What a page may do.** Runs and their streams, approvals (listing and
  deciding), reviews, replies, aborts, cancellations, `tasks`, `agents`, `center`, `memory`, `reminders`, `browser`, the artifact metadata (and `artifacts read` of browser thumbnails, page previews and approved images) and the configuration
  families (`models`, `credentials`, `projects`, `schedules`, `search`), and
  `reset-instance` (Settings → General → Reset instance). `shutdown`,
  `recover` and `doctor` are refused by the bridge.
- **The listener.** It binds the loopback literal and nothing else; a
  page navigation to `localhost` is redirected to `127.0.0.1`, and any other
  request to it refused. Every request is checked by its
  class: the page, its assets and its routes need the right `Host` (and are not
  served to another site); the token exchange also needs the page's exact
  `Origin`; the API and the WebSocket need the cookie **and** the secret as
  well. A route is a path the build ships no file at, answered with the built
  page for a top-level document load only: a subresource request for one is
  still a `404`, no request path reaches the filesystem, and another site may
  link to the page or to any route but not load the page or its assets.
  Neither alone reaches the owner: cookies are shared by every port of
  `127.0.0.1`, so another local server the browser visits receives the cookie,
  but never the secret. The page is served with a strict Content Security
  Policy.
- **Streams.** A tab that stops reading is closed once 4 MiB is waiting for
  it, and only its subscriptions are dropped; its client resubscribes from its
  cursors when it reconnects. A tab holds at most 16 subscriptions (a quarter
  of what the owner allows the bridge). When the owner stops or restarts,
  every tab is closed, and reconnects to the owner serving then.
- **Close codes** a page acts on (`UI_CLOSE` in `@tavi/contracts`):

  | Code | Why |
  | :--- | :--- |
  | `1011` | A frame the bridge could not handle |
  | `1012` | The owner stopped or restarted |
  | `1013` | The tab fell behind |
  | `4401` | No `hello` in time (2 s), or a wrong secret |
  | `4403` | The session ended (12 h, or 32 newer ones) |
  | `4429` | The bridge holds 64 tabs |

  The page's client does not read the code: on any close it reconnects as it
  does over the socket — asking the bridge (`POST /api/owner`) which owner
  serves now, then resubscribing from its cursors. That answer is what tells
  it whether its session still stands: a session that ended is answered 401,
  which is final, and the page asks for a new link.

  A refused upgrade answers 401 for no session and 503 when the bridge is
  full; `POST /api/owner` says which.
- **Residual exposure.** The link is in the browser's history (and its sync),
  and, off macOS, on the opener's command line while it runs; a browser extension with
  access to `127.0.0.1` reads what a page reads — which includes the tool
  input and output of every run it shows, unscrubbed.

The canvas itself (`apps/ui`) is a chat and run view, acting in workspace
`default` as principal `operator` (as `tavi chat` does by default; `tavi ui`
has no flag for either yet). The first prompt is sent as a run whose approval
rounds the page answers — Approve or Reject, the whole round, offered only
once the page has every call the owner lists for it, as the terminal UI does.
Once that chat's turn has finished, the next prompt continues it as `tavi chat`'s
does: a new turn of the same chat, whose model sees the earlier
turns. The prompt box says where the next message goes ("Message Home…",
"Message ‹chat›…", "Start a new chat…" or, with `chat.home` on, "Start a side
chat…"), and the sidebar's **+** — **New chat**, or **New side chat** with
`chat.home` on — makes it start a chat of its own; opening a chat
from the sidebar makes it continue that one. A
prompt sent while the chat's turn is still going — running, or waiting on an
approval or a review — is queued on the page and sent as the chat's next turn
once that turn ends; a chat cancelled meanwhile takes none of it.
**Send now** on a prompt queued behind a running turn (not one waiting on a
decision or a question) sends it as `reply` with `intent: "steer"`:
answered `steered`, it says "Sent into this turn" and stays first in the queue
until the stream's `turn.steered` names it, when its entry goes and the running
turn shows it ("You, during this turn"); should the turn end first, it is sent
as the next turn under the same message id — the owner, which hands it on
itself, answers that resend as the same message. A
finished task with no conversation on the local connection (from a chat, a
schedule, `tavi run`) is continued by its task id, and a reply the owner
refuses is never sent as a new task in its place. A new tab (a new link)
starts afresh. A cancelled task is not continued.
Its text and tool cards stream in as the terminal shows them, folded by the
same reducer; after an owner restart a suspended run is read back from its
record; and Stop aborts the turn a run is taking. Beside the chat, the
settings views work on the live owner through the same IPC families the CLI
uses: **System prompt**, **Channels** and **Allowed people**
(each described with its command), **Models** (the connections' discovered models, searchable and
filterable, each one made the default, bound to a role, or tested; Discover
asks a connection what it offers), **Web search** (the configured providers, enabled, disabled, tested, removed, or added through a
form that stores a hosted provider's key as the credential `search.<id>` —
refused, writing nothing, when that name or reference is already in use; a
key is rotated by replacing that credential),
**Credentials** (the stored references only — a value is set through a
masked form, crosses to the owner once, and is never read back), and
**Plugins** (built-in and installed plugins with their state in the running
owner; install a plugin directory by its absolute path on the owner's machine,
approve or reject a proposed version, enable or disable, and edit an installed
plugin's settings in a form typed by its manifest — see `tavi plugins`). It is
built into `ui-dist/` inside the CLI's package; an install without it serves
a placeholder page.

The chats sidebar shows workspace **default**. Search accepts `status:` and
`origin:` filters; Needs you has an independent bounded inbox so older pending
tasks are not hidden behind history pages. The header count names its workspace.
Other workspaces are excluded. Pins, archives and unread markers live with the
owner (`ui-preferences`, one file per workspace under the data directory's
`ui/`), cached in the browser's local storage for when the owner is
unreachable, so they survive reloads and are shared by every tab. Archived tasks needing action remain
visible. Reopening uses the owner's retained stream, or recorded prompts and
outcome with an explicit history boundary. Partial replay does not pair answers
with prompts by ordinal. Older tasks may have an unknown tool count.

`tavi ui` has no workspace selector. Model role/default reads and session and
approval queries use `default`; task documents are read by globally unique task
ID and browsed documents are checked against that workspace before subscribing.
Connections, credentials and search providers are owner-wide configuration.

Connection lifecycle lines go to stderr. Ctrl-C stops the bridge; the owner
and its runs are untouched.

---

### `tavi serve`

Run the persistent runtime owner. Takes exclusive ownership of the data directory (a second `tavi serve` on it is refused with exit `5`, saying the directory is already owned), accepts client connections over authenticated local IPC, and opens the messaging channels saved with `tavi channels` (Telegram polling, Mailgun webhooks and others).

```bash
tavi serve [options]
```

#### Options
- `--connection <id>`: The model connection the owner's default runs on; with `--model` too, that exact target, which stored configuration never changes. Without both, the owner resolves its default as `tavi run` does — role `main`'s binding, then the workspace default — at the start of every turn. A chat with a model of its own runs that instead. With nothing configured it starts on placeholders (`default`/`default`) and refuses runs and resumes with `NOT_CONFIGURED` until a default is set.
- `--model <id>`: The model on that connection; its default model otherwise.
- `--api-key-file <path>`: Path to model API key file.
- `--windowless`: Windows only (refused elsewhere, exit `2`): run with no console window, as the logon task [`tavi service unit --kind task`](#windows-a-logon-task) does.
- `--drain-deadline <ms>`: Graceful shutdown deadline in milliseconds on `SIGTERM`/`SIGINT`/`SIGHUP` (default: `10000`). If uncompleted tasks cannot drain before the deadline, exits non-zero (`70`).
- `--http-allow-host <host>`: Let `http.request` reach this host (repeatable; exact or `*.suffix`). Omit to deny every host.
  - A listed name is dialed only at a public address it resolves to, pinned for the connection, so DNS rebinding or a taken-over `*.suffix` subdomain cannot point it at a loopback, private-network or cloud-metadata address (the request is refused, `NOT_AUTHORIZED`); a loopback host you list (`127.0.0.1`, `[::1]`, `localhost`) is reached on loopback, and a host on your own network, by name or by address, is refused.
  - The tool's description lists these hosts and the names of the bound credentials (never a value, and never which host each is bound to), so the model uses an allowed API rather than learning the list by being refused.
  - It sends GET, POST, PUT, PATCH or DELETE (a DELETE is rated high on its card) and keeps up to 1 MiB of a response; a response past 64 KiB is kept whole as an artifact the model reads with `artifacts.read` (an `--in-memory` owner, with no artifact store, keeps its first 64 KiB).
  - `saveTo` writes a successful response's body to a new file in the chat's working folder instead, and answers with its path, size and sha256, not the body: the call is assessed as the `fs.write` that creates that file would be (its refusals, its folder-qualified subject, its ask in a tainted chat for a host folder, and `fs.write`'s deny and ask rules), on top of the request's own.
  - A save that would be refused is refused before the request is sent; a body past the 1 MiB cap, or one that echoes the credential the request carried, is not saved; the saved file is marked untrusted, as what a remote API answered. A response that is not a success is returned, not saved.
- `--allow <tool>`: Let every task under this owner call this gated tool without an approval round, e.g. `--allow web_search` (repeatable). The same shape as a schedule's `--allow`: tool ids only, `'*'` is refused. It lifts the round and nothing else — the tool's permissions and its own allowlists still apply — and a `read-only` tool never needs it. For `sandbox.run` it does not lift a line no rule can read (`$(…)`, `eval`, a here-document): that still asks, so a heartbeat check or a routine's run, which nobody attends, refuses it; a rule stored with `tavi permissions add --match-unparsed` covers it.
- `--http-request-header <name>`: Let the model set this extra request header (repeatable). Credential headers are refused here; bind those with `--http-credential-host`.
- `--http-credential-host <ref>=<host>`: Bind a credential reference to the host it may be sent to (repeatable). Unbound references are refused.
- `--browser-allow-host <host>`: Let `browser.navigate` open this host when nobody was asked (repeatable; exact or `*.suffix`). A person who allows the browser for a chat lets it open the site the card named; another site asks again. Loopback, private (RFC 1918, ULA), link-local (with the cloud metadata service), CGNAT and other non-public addresses — and a name that resolves to one — open only for a `host:port` listed here exactly (`127.0.0.1:5173`, `nas.lan:80`); a bare entry opens no port of them (see [Allowing the browser](BROWSER.md#allowing-the-browser)).
- `--messaging-allow-destination <destination>`: Let `messaging.send_to` address this destination (repeatable): `chatId` for any connection, `connectionId:chatId` for exactly one (the bare form only while one messaging connection is configured), `*:chatId` for every connection, or `providerId:*` (such as `telegram:*`) for anyone on that channel's connections — the one wildcard, which a routine's delivery does not take, as it names its destination exactly. Omit to deny every destination. The agent is told each turn which channels it can reach and the targets allowed on each, and the read-only `messaging.channels` tool lists the same.
- `--fs-root <path>`: An absolute folder a chat may use as its working folder or attach (repeatable).
  - The file tools (`fs.read`, `fs.list`, `fs.glob`, `fs.grep`, `fs.write`, `fs.edit`) are always offered and work in each chat's own folder under `<data-dir>/chats/` and its attached folders, with or without a root.
  - A new chat from `tavi`, `tavi chat`, `tavi run` or the canvas gets the first root attached read-only; a messaging, schedule or reminder chat gets none.
  - A chat from before per-chat folders keeps the first root as its folder and every root read-write for `fs.*`; its `sandbox.run` reads them but writes only its own folder; once changed, it keeps every root read-only, and so does a side chat opened from it.
  - A root spelled with `*`, `?`, `[` or `]` is a usage error (exit `2`): the sandbox would read it as a pattern. So is `/`, a system folder (`/usr`, `/bin`, `/sbin`, `/lib*`, `/opt`, `/System`, `/Library`) or a folder holding one, and the `bin`, `lib` or `include` folder of the Node install Tavi runs on (or a folder in or holding one): every confined child is denied each root, and needs those to run.
  - Choose or attach folders per chat with `/folder` in `tavi chat`, `tavi tasks folder`, `tavi run --folder` or the canvas's folder chip.
  - `tavi reset` erases `chats/`; a host folder is never touched by it.
  - Rule subjects are absolute real paths in a host folder and `chat:<task-id>/<path>` in a chat's own folder; with exactly one root, saved rules with relative subjects are rewritten under it at the first start; started with no root or several, they are left as they were and match no file, and the owner logs a warning naming the deny and ask rules among them.
  - On macOS and Windows a deny or ask rule matches a file subject case-folded and NFC-normalized as well; allow rules match exactly.
- `--sandbox-nested`: Accept srt's weaker nested mode, for a container that masks `/proc` (PID and `/proc` isolation are given up; every `sandbox.run` result says `tier: "nested"`). Never automatic.
- `--sandbox-inspect-tls`: `sandbox.run`'s proxy terminates TLS toward every granted domain with Tavi's CA (the command is told to trust it), holds each request to the host it was sent to, and refuses a tunnel that carries no TLS — git over SSH or another raw TCP protocol to a granted host stops working. Off, only a credential's hosts are terminated, and other grants are tunnels the proxy does not read. It cannot be combined with `--sandbox-parent-proxy` or `TAVI_SANDBOX_PARENT_PROXY` (a usage error): the sandbox cannot yet send connections it inspects through a parent proxy.
- `--sandbox-parent-proxy <url>`: the proxy `sandbox.run`'s granted connections leave through (an `http://` or `https://` URL), for a host that reaches the web only through one (a credential host's connections are still dialed directly: srt does not yet route them through it). Tavi checks what a granted name resolves to here before each connection, best effort, since the proxy resolves it again. Without it they dial out directly, whatever proxy the owner's environment names; `TAVI_SANDBOX_PARENT_PROXY` does the same, and `tavi doctor` warns when the owner's environment names a proxy and neither does.
- `--sandbox-pty`, `--sandbox-local-bind`: macOS opt-ins for `sandbox.run`: allocate pseudo-terminals (granted with the operator's own `/dev/ttys*`), and listen for connections (granted on every interface, with connecting to this machine's own ports; such a run gets `HOST=127.0.0.1`, and may use Unix sockets in its own `$TMPDIR`, by a short path: macOS caps one at 104 bytes). Never in a chat holding untrusted content; Linux needs neither. No confined child is ever given a container engine's socket. See [SANDBOX.md](SANDBOX.md#local-capabilities).
- `--sandbox-timeout <seconds>`, `--sandbox-max-timeout <seconds>`: how long a `sandbox.run` call runs when it asks for no `timeoutMs` (default 120), and the longest one it may ask for (default 600); the first may not exceed the second.
- `--sandbox-memory <size>`, `--sandbox-pids <n>`, `--sandbox-cpu <percent>`: `sandbox.run`'s caps (defaults a quarter of the host's memory between 256M and 2G, 1024, and 200% — two cores, or one on a single-core host), enforced on Linux by the run's own cgroup. A run past its memory fails `QUOTA_EXCEEDED`; one that would not fit beside the sandboxes already running under the aggregate cap is refused before it starts, naming what holds the memory. `doctor`'s `sandbox.limits` shows the rung (`delegated`, `systemd-run` or `none`), the aggregate cap and each workload's defaults.
- `--sandbox-tier unavailable`: Refuse `sandbox.run` whatever this host could do — the off switch; `TAVI_SANDBOX=off` in the environment does the same.
- `--sandbox-read <path>`: An absolute folder every chat's `sandbox.run` may read, read-only, beside the chat's own folders (repeatable) — for a toolchain or data under `$HOME` or on a mounted drive the shell does not re-open on its own. A folder holding a toolchain's credential file (`~/.cargo`, `~/.m2`, `~/.gradle`, `~/.gem`, `~/.nuget`, `~/.composer`, `~/Library`) is accepted, and that file stays denied. It must exist and be a folder, and may neither lie in nor contain the data directory, a credential directory (`~/.ssh`, `~/.aws`, …) or a key-holding file (`~/.zshrc`, `~/.gitconfig`, `~/.config/gh`, …), and may neither be nor hold an `--fs-root`: such a flag stops the owner at start (`INVALID_INPUT`), since re-opening it would undo the deny it lies in, or open that root to every chat. A relative path, one spelled with `*`, `?`, `[` or `]`, `/`, a system folder or a folder holding one, and a folder in Tavi's Node install are usage errors (exit `2`), as for `--fs-root`.
- `--sandbox-domain <pattern>`: A domain every workspace's `sandbox.run` may reach (repeatable, at most 64), or `@registries` for the package registries (see [SANDBOX.md](SANDBOX.md#network)).
- `--sandbox-cache`: one npm and pnpm package cache per workspace, in `~/.cache/tavi-sandbox/<workspace>`, which its untainted chats' `sandbox.run` share (integrity-checked stores only; pip, uv, Yarn and Go keep their own per chat); a chat holding untrusted content keeps its own.
  - `host` or `*.domain` (its subdomains), either with an optional `:port`; an address only as canonical dotted IPv4 (`10.0.0.5`, never `127.1`, `2130706433` or `0x7f.0.0.1`), and never a loopback, unspecified, link-local or cloud metadata one, nor `localhost`; a bare `*`, `*.tld` or anything else is a usage error (exit `2`).
  - A workspace adds its own with `sandbox.domains`. The model never chooses them, and a tainted chat's run gets no network whatever is granted. Under a workspace's `sandbox.network ask`, a run may name more hosts in `requestDomains`, which a person approves on its card for that call alone.
  - A run with grants runs in a Tavi srt host process of its own, with its own proxy, so runs with different grants run at once; the proxy lets through only that run's grants and reports every host and port asked for (the result's `requests`: host, port, whether every attempt got through, and how many there were; refusals by the deny list and the address guard included; at most 256, then `requestsTruncated`).
  - Paste and file-drop sites (`pastebin.com`, `transfer.sh`, `webhook.site`, …) are refused whatever is granted.
  - This host (`localhost`, a loopback address or any of its own interface addresses), the unspecified address, link-local addresses and cloud metadata endpoints are never dialed, however the command spells the address (`127.1`, `2130706433`, `[::ffff:7f00:1]` are judged as the address the proxy would dial).
  - A granted name that resolves to any of those, or to RFC 1918, CGNAT or a ULA, is never dialed either; a private address is reached only when a grant names it.
  - MCP servers and plugin workers granted domains get the same deny list and the same refusal of names resolving into private networks; the confined browser (every host) gets the host refusals only, and reaches paste sites and private networks as a person's browser does (the browser tools' page rules govern it).
  - Node children get `NODE_USE_ENV_PROXY=1`, and `--disable-warning=UNDICI-EHPA` at the end of `NODE_OPTIONS` (after the command's own), so a run prints no experimental-proxy warning.
  - On Linux the proxy's sockets live in the service's runtime directory (`RuntimeDirectory=tavi`, else `$XDG_RUNTIME_DIR/tavi`); a run granted domains without one is refused (`UNAVAILABLE`).
- `--sandbox-credential <VAR>=<ref>`: A stored credential `sandbox.run` may use without seeing it (repeatable).
  - `<ref>` must be bound to hosts with `--http-credential-host <ref>=<host>`, each one exact host in lower case, with no port (srt matches inject hosts by name); otherwise the owner refuses to start (`INVALID_INPUT`). A bad `<VAR>` or the same `<VAR>` twice is a usage error (exit `2`).
  - Each clean run reads the value when it starts (`NOT_CONFIGURED`, naming `tavi credentials set <ref>`, when there is none), grants the hosts, and gives the command a placeholder (`fake_value_…`) in `VAR`; the real value stays in the run's srt host process.
  - Its proxy terminates TLS for those hosts only, with a CA the owner mints into `<data-dir>/sandbox-ca/`, valid 30 days and replaced for new runs a week before it runs out (no command can read it; older ones are removed once they have run out), verifies the upstream's certificate (a failure answers 502 and sends nothing), and puts the value in place of the placeholder in the `Authorization` header.
  - A request to those hosts is refused (403) when it carries a credential header (`Authorization`, `Cookie`, `X-Api-Key`, …) without the placeholder, the placeholder in the URL, another header or the body, or is a `GET`, `HEAD` or `OPTIONS` declaring a body (which the check cannot see).
  - Over plain HTTP nothing is put in.
  - A response is not filtered: a host that echoes the request returns the value to the command, so bind credentials only to APIs that do not.
  - Elsewhere the placeholder goes out as it is.
  - `requests` lists, per host, the credentials put in (names only). A tainted chat's run gets none.
  - Only a placeholder carried as-is is replaced: a client that encodes it (HTTP Basic, as `git` sends a token) is not served.
- `--video-ffmpeg <path>`, `--video-ffprobe <path>`: The FFmpeg and ffprobe the video tools run, as absolute paths (default: the first on `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`); Tavi ships none ([VIDEO.md](VIDEO.md)).
- `--video-allow-unconfined`: On Linux where the sandbox is unavailable, read videos with FFmpeg unconfined (still within its memory and time caps) rather than refuse.
- `--pdf-allow-unconfined`: Where the sandbox is unavailable, read PDFs with the parser child unconfined (still within its memory and time caps) rather than refuse ([PDF.md](PDF.md)).
- `--dev-plugin <path>`: A plugin folder to load for this owner run without installing or approving it (repeatable) — you vouch for the code by starting the owner with it. It is checked as `tavi plugins install` checks a folder (a failure stops `serve` from starting), must have an entry and run with no settings, and loads in place of an installed plugin of the same id. Each save reloads it after 300 ms from a fresh snapshot under `<data-dir>/plugins/.dev/`: the old load is withdrawn, then the new one registers, with its hooks' failure count cleared (a suspended plugin runs again); a `register` that throws leaves it `failed` until the next save; a save that no longer checks out is logged and the last good load keeps running; a changed id, or a removed folder, needs a restart. Only the newest snapshot is kept. `tavi plugins list` and `show` mark it `dev`; nothing is installed. Its folder is read-only to the file tools (`fs.write` and `fs.edit` into it are refused), so no turn can change code the owner runs, and its state store is its own (`dev:<id>`), apart from an installed plugin of the same id. A reload that failed is tried again by saving the same content. Its canvas contributions are not served. Refused (exit `2`) when the owner runs as a service (`TAVI_SERVICE=1`, which `tavi service unit` writes).
- `--folder-cap <size>`: A chat's own folder's budget (default `2GB`; a number of bytes, or with `K`, `M`, `G` or `T`, powers of 1024). Past 80% the chat is told once and `/folder` shows it; at the budget its `.tmp/` is emptied, then writes into it, copies of approved downloads and new `sandbox.run` calls are refused until it is cleared. It is a budget, not a ceiling: a command already running may overshoot. `0` or a malformed size is a usage error (exit `2`).
- `--chats-cap <size>`: Every chat's folder together, `chats/.trash/` included (default `20GB`), as `--folder-cap`.
- `--free-space-floor <size>`: Below this much free space on the disk that holds the data directory (default `1GB`; `0` turns it off), file writes on that disk, copies into chats' folders, sends of a folder file and new `sandbox.run` calls are refused.
- `--messaging-allow-tool <tool-id>`: Let a chat-started task use this tool despite the messaging profile, in the operator's own one-to-one chats only — a chat channel's one-to-one conversation whose sender is bound to the workspace's operator; never a group, a thread, an email thread or another person's chat, and not a worker's or a fire's turn, which has no chat of its own (repeatable). The owner logs which chats it applies to once at start. Only `sandbox.run`, `fs.write`, `fs.edit`, `plugins.validate` and `http.request` (held back when it carries a credential) are accepted; any other id is a usage error (exit `2`), since the profile holds back nothing else.
- `--approval-expiry <hours>`: How long a round sent to a chat or email waits before it is rejected (default `24`; `0.25` to `720`). The clock starts when the round is delivered; a round that never reached a chat does not expire.
- `--taint-policy <off|observe|enforce>`: The taint step's mode in every workspace this owner serves, for its lifetime. Precedence: this flag, then each workspace's `security.taint` (`tavi permissions taint`), then `enforce`. With `observe` or `off` here or in a workspace, the owner logs a warning at start. A workspace's own setting is kept and applies again once the owner restarts without the flag; `tavi permissions taint`, `tavi config get security.taint`, the workspace-settings answer (`taintPolicy`) and `tavi doctor` (`taint.via`) say the flag is in force. Like `--allow`, it shapes the owner, not one run. Any other value is a usage error (exit `2`).
- `--log-file <path>`, `--log-rotate-bytes <n>`, `--log-keep <n>`: The owner's JSON log, besides stderr (default `<data-dir>/logs/tavi.log`, rotated at 5 MiB, 3 kept); read it with [`tavi logs`](#tavi-logs).
- `--eval`: An owner for evaluation (`evals/memory`'s eval and cache gate): it starts no reminder sweep, heartbeat host, schedule sweep, memory tick (the review digest, the idle review, the vector backfill and consolidation) or messaging channel (saved ones stay closed; the channel flags are a usage error with it, exit `2`), and it writes no task summaries (a finished task keeps its prompt-derived title whatever `activitySummaries` says, so no summary model call adds to the spend the eval measures). The memory host still runs, its jobs only on demand (`tavi memory reindex`, `review-now`, `consolidate-now`). A plain `tavi serve` is unchanged.
- `--retention-sweep-artifacts`: Also let the six-hourly retention sweep delete non-report artifacts (never a pending one, never a report PDF). Off by default. Browser history is swept either way: sessions opened more than 30 days ago are deleted with their visits and thumbnails on every pass. Each pass ends by returning the database file's free pages to the operating system when at least 32 MiB is free: `PRAGMA incremental_vacuum` on a file this build created; a file from an earlier build (`auto_vacuum` off) is rebuilt once with `VACUUM`, which switches it to incremental, when at least half of it is free — so the copy is no larger than what it frees. The database is unavailable to other work while that one `VACUUM` runs. Then it refreshes the query planner's statistics where they have drifted (`PRAGMA optimize`).
- `--data-dir <path>`: Custom data directory path.
- `-h, --help`: Show help text.

> [!NOTE]
> `tavi serve` runs on macOS and Linux. It refuses to start on native Windows until the named pipe that replaces the Unix socket there, though given a private access list, is proven against a second account in CI. Sandboxed tools are refused there separately: the sandbox's Windows backend is not used yet. WSL2 counts as Linux; see the [README](../README.md#platforms).

#### What an attached client sends

Under a live owner a command that runs on it reaches it over IPC (see [Concurrency & Mutual Exclusion](#concurrency--mutual-exclusion)). Each message an
attached client sends, with what it answers, is in [IPC.md](IPC.md).

#### Configuration under a live owner
`tavi models`, `tavi credentials`, `tavi projects`, `tavi schedules`, `tavi search`, `tavi plugins` and `tavi agents` send the [configuration messages](IPC.md#configuration-from-an-attached-client) when an owner serves the directory, and print what the offline commands print, with their exit codes. The differences:
- `tavi credentials set` reads the value from `--file` with the same checks (`0600`, no symlink) and sends it once over the local socket; it is never printed. A missing or empty file is a usage error (`2`) on both paths, and a file others can read is refused (`4`).
- `tavi models test|discover` probe with the credential the owner's chain resolves, so `--credential-file` is refused (exit `2`). `tavi schedules run-now` fires with the owner's credentials and target: `--api-key-file` is refused (exit `2`), and `--connection/--model` only assert the owner's target (another is refused, exit `2`).
- `tavi schedules run-now` follows the fired run on its stream, as `tavi run --attach` does, and exits with its outcome (Ctrl-C detaches; the fire continues). Offline it prints the fire's result once the run ends.
- The lists come from the owner's bounded answers: `tavi agents list --format json` prints `{ agents, truncated }` without instructions, `tavi projects list --format json` adds `truncated`, `tavi schedules list --format json` the schedules without their prompts, and a truncated list says so on stderr.
- `tavi schedules run-now --format json` prints the followed run's NDJSON events rather than the offline fire result, and exits with the run's outcome: `0`, `1`, `6` (review), `7` (waiting), or `130`/`143` detached, where offline any run that did not complete is `1`. A fire that ran nothing (skipped for overlap) is `1` either way. A schedule cannot be removed while a fire of it is in flight (exit `4`); a `remove` straight after a followed run waits for that fire to finish recording.
- An id longer than the IPC bounds (64 characters for a connection, 128 for an agent or project) is refused as a usage error (`2`), where offline it is not found (`4`).
- `tavi search` prints what it prints offline, refusals and exits included; `test` resolves the key through the owner's chain. `list --format json` adds `truncated` (at most 100). Adding, enabling, disabling or removing a provider applies to new calls without a restart. A provider's key must be a search reference (`search.*` or the kind's own) that no model connection — stored or launched — no launcher binding and no provider of another kind holds, checked at `add` and again at `test` (exit `2`), and `web_search` leaves out a provider that breaks it: over IPC a page could otherwise have another key sent to a search provider. The other way round, `tavi models add|rebind|test|discover` over IPC refuses a connection naming a search key — any reference under `search.`, `tavily.`, `brave.`, `serper.` or `searxng.`, whether or not a provider names it now — a plugin's key (under `plugins.`), or one the launcher bound for another use (exit `4`). Through `tavi ui`, `models add|rebind` also refuses a stored key at an origin no connection uses it at, unless the page itself set it.
- `tavi plugins install <path>` sends the path made absolute; the owner reads the directory on its own machine. A change that alters what runs notes on stderr that it takes effect when `tavi serve` restarts; a UI-only plugin's never does.
- `tavi projects import` has no IPC counterpart yet, and is refused with exit `5`, naming why; stop `tavi serve` to run it.


---

### `tavi tasks`

Inspect task history or view a specific task's complete durable timeline. Attaches to a running owner over IPC if available; otherwise opens the database directly. Its `owner` is the owner serving the directory (`session_id`, `pid`, and offline the lock's `acquired_at`), or `null` when none is.

```bash
tavi tasks [task-id] [options]
tavi tasks folder <task-id> [show|set <path>|attach <path> [--rw]|detach <label>|reset] [--workspace <id>]
tavi tasks folders prune [--older-than <days>] [--chat <task-id>] [--workspace <id>] [--dry-run] [--yes]
```

#### Positional Arguments
- `[task-id]`: Optional ID of a specific task. If omitted, lists recent tasks (at a terminal a line each; `--format json` for the document). If provided, displays detailed execution timeline, attempts, checkpoints, and tool calls. Each task carries its generated `title` and `summary` (`null` before one exists) and `summaryState`. A shown task also carries `contextLabel`: the chat's context label as its checkpoint records it — `integrity` (`untrusted` once it read content Tavi does not trust), `sources`, `principals`, `confidentiality` and the newest five `refs` (each with the host Tavi parsed and a page's own `title`, display only) — or `null` when the checkpoint cannot be read.

#### Options
- `--turn <n>`: With `tasks history <task-id> rewind`, the turn taken back with every later one.
- `--rw`: With `tasks folder <task-id> attach`, attach the folder read-write (default read-only).
- `--older-than <days>`: With `tasks folders prune`, the age past which a folder is taken (default 30; `30` and `30d` alike).
- `--chat <task-id>`: With `tasks folders prune`, that chat's folder only, whatever its kind.
- `--dry-run`: With `tasks folders prune`, print the plan and move nothing.
- `--yes`: With `tasks folders prune`, move without asking; required without a terminal.
- `--workspace <id>`: With `tasks folder`, `tasks folders prune --chat` and `tasks instructions`, the chat's workspace (default `default`).
- `--data-dir <path>`: Custom data directory path.
- `-h, --help`: Show help text.

`tavi tasks folder <task-id> [show|set <path>|attach <path> [--rw]|detach <label>|reset]` shows or changes one chat's working folder through the running owner's `folder` command, as `/folder` in `tavi chat` does: `show` (the default) prints where the chat works, its attached folders and modes, and its own folder when the primary is a host folder; `set`, `attach` (read-only unless `--rw`), `detach` and `reset` apply from the chat's next message and print the result. `~` and a relative path are this directory's. `--workspace <id>` names the chat's workspace (default `default`). It needs a running owner, whose `--fs-root` folders a path is checked against (exit `4` with none); a refusal exits as other configuration commands do — `2` for an overlap, a malformed path, a path that is a file, a 17th attachment, a worker's id, or a change that raced another one (`CONFLICT`: run it again), `4` for a folder not allowed or not found — and a chat whose folder is gone, or whose stored folder no longer reads, prints why and exits `4`. `reset` recovers it, a side chat's too when its parent's folder is the one gone (what is gone is left out). A change that would leave a folder that is gone is refused and stores nothing.

`tavi tasks folders prune [--older-than <days>] [--chat <task-id>] [--workspace <id>] [--dry-run] [--yes]` reclaims chats' own folders.

- **What it takes.** Without `--chat` it takes every run's folder (`chatKind: "run"`: a schedule's, routine's or reminder's fire, a `tavi run`) whose chat was last active (`updated_at`) more than `--older-than` days ago (default 30; `30` and `30d` alike, 0 to 3650). With `--chat`, it takes that chat's folder — a worker's is its chat's — whatever its kind and, unless `--older-than` is given, its age: the only way a Home's, a side chat's or an ordinary chat's folder is cleared.
- **What it skips.**
  - A chat with a turn in progress (status `admitted`, `running` or `waiting`, a running admission, or a worker of its delegation tree that has not ended, since workers work in their chat's folder), and one whose folder record or task record cannot be read (nothing of it is deleted).
  - A folder a side chat reads as `parent-chat` is never taken by age (the plan names the side chat and `--chat`), and with `--chat` it is skipped while a side chat of it has a turn in progress.
  - It leaves alone any folder under `chats/` that no chat is recorded for, a link, and every host folder.
- **Plan and confirmation.** It prints its plan — the folders to move with their kind, size and last activity, what it leaves and why, and what waits in the trash — then asks (`[y/N]`); `--yes` answers it, and without a terminal it is required (exit `2` without it); `--dry-run` prints the plan only.
- **Moving to the trash.** Each folder is moved by a rename on the same volume, after checking it is still a plain folder in a parent that resolves to itself, to `chats/.trash/<task-id>-<YYYYMMDDTHHMMSSZ>/`; a chat whose folder moved gets an empty one at its next turn.
- **Emptying the trash.** Trash entries 7 days old or more are deleted then, never through a link, and at every owner start; a folder that cannot be moved or a trash entry that cannot be deleted is printed to stderr and the command exits `4`, after printing what it moved.
- The sizes it prints stop counting at 20,000 entries a folder ("at least").
- **Offline only.** It runs offline like `tavi prune`, taking the data directory's ownership, so a running owner refuses it with the ownership message (exit `5`), `--dry-run` included: stop the owner first.
- Backups include `chats/` but leave `chats/.trash/`, and each folder's `.tmp/` and `.home/`, out. A link in a chat's folder is copied as a link, except on Windows, where it is left out (making one there needs Developer Mode, and a junction points into the live folder).

`tavi tasks instructions <task-id> [show|history|set <text>|reset]` reads and saves one chat's own instructions (`chat-context` above): `show` (the default) prints the current revision and its text, `history` one line per revision, newest first (`<revision>\t<recordedAt>\t<author>\t<first line>`, `(cleared)` for a reset), `set` saves the quoted text and `reset` an empty revision, each against the revision it reads first, or the one `--revision <n>` names (a stale one exits `2`). `--workspace <id>` names the chat's workspace (default `default`). Through a running owner, or from the data directory when none runs.

`tavi tasks history <task-id> forget --before <time> | --epoch <n> [--with-memory]` erases the chat's saved history from before then (`chat-context` `forget` above) and prints what went: the saved turns (and checkpoints let go of), `Deleted N archives of its earlier turns.`, `Forgot N memory proposals it made that still waited.`, and with `--with-memory` `Forgot N memories it taught.` (when a memory provider could not take the removal now, `What it taught will be removed from <provider> when it next runs.`); without it, `N memories it taught stay; --with-memory forgets them too.` Memory is forgotten only on a running owner: offline the history and its archives are erased and the output says its memory proposals were not checked (run it again with `tavi serve` running), and `--with-memory` is refused with exit `2`.

`tavi tasks history <task-id> rewind --turn <n>` takes the chat back to before its turn `n`: that turn and every later one leave the saved history (the IPC `rewind` above), and the chat's folder is not changed.

---

### `tavi doctor`

Inspect and report runtime composition, SQLite migration status, available tools, model connection health, and capability availability.

```bash
tavi doctor [--deep] [options]
```

#### Options
- `--deep`: Run SQLite's full integrity check, which also checks every index (slower on a large database), instead of the quick check. A running owner answers `doctor` itself and skips the check either way, so it never blocks.
- `--format <text|json>`: `text` prints one line per check — Node, the Visual C++ runtime (on Windows), the database, migrations, the owner, models, setup, the sandbox and its limits per workload (with its cause and fix when it is unavailable, naming the off switch when shell commands are pinned off, and a `started with --sandbox-…` line for the options the owner was started with), video, taint, web search and disk, the owner's health (its memory, open files and child processes, crossed when one kept growing) and stranded turns (each task with the step that frees it) — and where the whole report is; the default (and `json`) is the whole report.
- `--data-dir <path>`: Custom data directory path.
- `-h, --help`: Show help text.

- If `tavi serve` is active, queries the live daemon via IPC to report real running state.
- `integrity`: SQLite's verdict on the database file: `checked`, `mode`, `ok` and `problems`. Offline, `mode` is `quick` (`PRAGMA quick_check`); `--deep` runs the full `integrity_check` (`mode: "full"`), which also checks every index against its table and is slower on a large database. A live owner answers `checked: false` with or without `--deep`: either check reads every page on its event loop. `ok: false` exits `4`.
- `health`: the live owner's own resident memory, open file descriptors (on Windows, open handles) and child processes, sampled every 10 minutes and kept in memory (the last 24 hours; a restart starts afresh, and nothing is written to the database): `intervalMinutes`, `samples`, `since` (the oldest kept), `now` (a sample taken for this report: `rssBytes`, `openFds` where the platform lists them, `openHandles` on Windows, `children`), `windowStart` (the sample 6 hours before the newest, never one from the owner's first hour, while it warms up; so from 7 hours of uptime) and `growth`: each metric that more than doubled over those 6 hours and whose newest three samples all stayed there (at least 64 MB of memory, 32 descriptors, 256 handles or 4 children more; from no children, the 4 alone), with `from`, `to`, `factor` and a `warning`. The Command Center's Activity view shows the same warnings. Offline, `{ running: false, note }`. It does not change the exit code.
- If no owner is running, opens the database directly without requiring model credentials. It runs no plugin code: each enabled external plugin is *verified* — approved, its snapshot matching the approved hash, its settings complete — and reported, not imported.
- `node`: the Node.js answering (`version`: the live owner's when `tavi serve` answers, else this CLI's), the supported floor (`required`, the package's `engines`) and whether it is met (`ok`). An older Node is reported, not refused.
- `vcRuntime` (Windows only): whether the Microsoft Visual C++ runtime the native modules need is installed (`ok`), the files of it missing from the system folder (`missing`), and the `fix` (`winget install Microsoft.VCRedist.2015+.x64`, or `.arm64` on Windows on Arm). The text form prints it under Node.
- `browserSessions` counts the browser sessions open now, across workspaces: `open` (in use) and `inactive` (their task ended; each holds a browser context until `tavi browser close`).
- `pluginRegistry` lists every plugin the registry knows with its phase: `ready`/`failed` (with the `error`) from a live owner, `verified`/`failed` offline, `not_composed` for one that is disabled or not configured, and the versions `awaitingReview`. `plugins` is the host's own list of what it composed.
- `memory`: the default workspace's memory in one section, each part from the step that added it. Under an embedder's `memoryOverride` it adds `service` and leaves out `vectors`.
  - `service`: only under a `memoryOverride`: `override`, its `conformance`, and a `warning` that backup, export and `tavi reset` do not cover its records.
  - `settings`: the default workspace's memory settings (`tavi memory config`): `state` (`on` or `paused`), `capture` (`suggest` or `off`), `autoApprove` (the kinds kept without asking: always shown, `[]` when none), and `changed`, each other key set to something other than its default (`sensitive`, `retrieval`, `digest`, a limit), by its `tavi memory config` key (`consolidation: weekly` once it is on).
  - `provider`: the default workspace's memory provider: `selected` (`tavi memory set-provider`), `serving` (the one recall and capture use now: the selected one, or the built-in while that one is not running, with the `fallback` notice saying so), `index` (`host` or `own`: whether the serving one keeps an index of its own), its `status` (`ready`, `indexed` when it reports a count, and `detail`, its own words on one line of at most 200 characters; a status that throws, is not synchronous or is malformed reads as not ready, saying why), `egress` (`records`, `conversation`, `personal`), `pendingRemovals`, forgotten records a provider could not take the removal of yet, `pendingRemovalsFor` (when any wait: each `provider` they wait for, its count of `removals`, and whether it is `installed` now; one uninstalled for good keeps them waiting) with a `pendingNote` saying so, `unselectedIndexes`, installed providers with an index of their own the workspace does not select (sent nothing more, holding what they had), and `note`, when a provider other than the built-in is selected or holds an index, that its own index is outside Tavi's tables and the plugin's to clear. Ids and counts only.
  - `digest`: the default workspace's review digest: `digest` (`weekly` or `off`) and `lastSent`, when each person's last digest went out (`principalId`, the `taskId` of the chat it was posted to, and `at`), newest first. Empty until one has.
  - `review`: the default workspace's idle review: `capture` (`suggest`, or `off` when capture is off or memory paused), `lastReview` (when the last review that called a model ran, in the last 30 days; `null` for none), and `today` (since local midnight in the workspace's time zone): `reviews` made, proposals `filed`, drafts `dropped` by reason (`secret`, `sensitive`, `known`, `similar`), `failures`, spans `skipped` after three failures, and `spend` (`calls`, `failed`, `inputTokens`, `outputTokens`, `estimatedUsd` of the review's `extraction` calls on that workspace's chats; `failed` counts calls that ended without completing, not one still running). Counts only, never memory text.
  - `consolidation`: the default workspace's weekly tidy-up suggestions: `consolidation` (`off` or `weekly`), `lastRun` (when the last run that read the records happened, in the last 30 days; `null` for none), what it drafted (`drafts`, before validation) and `filed` as proposals, the `failures` and weeks `skipped` after three failures in the last 30 days, and today's `spend` (since local midnight in the workspace's time zone: `calls`, `failed`, `inputTokens`, `outputTokens`, `estimatedUsd` of its `extraction` calls, as the review's). Counts only, never memory text.
  - `vectors`: the default workspace's hybrid recall: `retrieval` (`lexical` or `hybrid`), `model` (`connection/model` of the bound `embedding` role, `null` when none) and its `locality`, vectors `indexed`, `missing` (eligible records the backfill has not embedded yet with that model) and `failed` (skipped after three failures until the model changes), the worker's `cache` (`vectors`, `bytes`), `recallP95Ms` and `recalls` of hybrid turn and tool recall on this owner since it started (`null` before any), `retrievalConnection` (the remote connection whose disclosure was accepted, `null` when none), `retrievalPersonal` (the remote connection personal memory's own disclosure was accepted for, `null` when off), `personal` (whether personal records are embedded through the bound connection: on a local one the people's, on a remote one only the operator's own and only when `retrievalPersonal` names it; the rest count as neither indexed nor missing), and `spend` (today's embedding calls across the owner, the backfill's and every query's: `calls`, `failed`, `inputTokens`, `estimatedUsd`; each embedding attempt id starts with `memory-embed-`). Counts only, never memory text.
  - Memory's prompt-cache measurement stays in `chatMeasurement.promptCacheByChatKind`: it measures every call, not memory's alone.
- `ideas`: the default workspace's Ideas: `enabled`, `providerId` and `providerReady`, `volume` (how many ideas a run asks for, moved by auto-volume), `dailyTokens`, `hours`, `fastModel` (whether a *Fast* model is bound), `digest` when one is set (its `channel`, `weekday`, and `lastSentOn`), `prepared` (the prepared first steps of the last 24 hours: `count` and `tokens`), and `lastRun`. A `warning` says when Ideas are on with no *Fast* model (and a budget above 0), when the digest's connection has no chat of yours to go to, when the provider is not installed, running or ready, or when the last run failed.
- `scheduledWork`: the default workspace's scheduled work this calendar month in its zone — the model calls of its schedules' and routines' runs and of the workers they spawned: `month` (`YYYY-MM`), `timezone`, `tokens`, `usd` (`"unknown"` when a call had no price sheet), and, with `scheduled.monthlyTokenBudget` set, `budget` and `percent`, with a `warning` from 80%.
- `routineReports`: every published routine report (JSON and PDF) hashed in full against its publication manifest, streamed by doctor itself rather than on the database worker: `checked` (how many files) and `damaged` (how many are missing, a different size, or hash differently), and when any are, `reports` (at most 50: `routineId`, `runId`, `artifactId`, `kind`, `problem` of `missing`, `size` or `hash`) and a `warning`. It does not change the exit code. A damaged report is never opened or delivered: reading and delivery hash it too. `tavi serve`'s start only checks that each published file exists at its recorded size, so a report whose bytes changed in place shows here first. When the check cannot run, `problem` says why.
- `taint`: the default workspace's `security.taint` in force (`mode`; `via: "serve --taint-policy"` when the owner's flag set it), and over every workspace the calls the taint step asked — or under `observe` would have asked — in the last `days` (7): `calls`, the `tasks` they were in, `unasked` (those the gate let run unasked: the approvals `enforce` would add), `topTools` (the five most observed, with counts), and `line`, such as `taint would have asked 12 calls in 7 days (top tools http.request 7, messaging.send_to 3)` (`taint asked …` under `enforce`). Under `observe` or `off` it adds a `warning` naming the fix (`tavi permissions taint enforce`). Tool ids and counts only, from `tavi_gate_observations`.
- `webSearch`: whether `web_search` is offered here (`offered`; with none, a `note` naming `tavi search add <kind>`), whether the default workspace still holds the seeded allow rule (`allowRule: { ruleId: "seeded-web-search", present }`), and `line`: searches run without asking (a query that looks like a key or token still asks; `tavi permissions rm seeded-web-search` to be asked each time), or ask each time because the rule was removed, which is never seeded again.
- `mcp`: `enabled` (the owner's `mcp.enabled`, with a `note` when off); `sandbox` — the live check a stdio MCP server's sandbox must pass (`works: true`, or `works: false` with the `cause` naming its fix, and `fix` saying which flag a server then needs); `uv` — whether `uv` is on PATH for Python servers (`found` with its `path`, or a `note` on getting it); `weakerSandbox`, only when an approved stdio server runs unsandboxed or nested while this host now confines more: each one's `pluginId`, `version`, `sandboxState` and a `warning` naming how to move it (a new `--version`, approved), which `tavi serve` also logs at start; `servers`, each installed server: `state` (`stopped`, `running`, `backing-off` with `retryAt`, `failed`, `login-required`), `failures`, `inFlight`, `queued`, `reason`, `enabled`, its `openNotices`, and `files` (a full re-hash of the active version: `ok` and `count`, or the `problem`); `tools` — `registered`, `listed` (not deferred), the budget `limit`, `schemaTokens` (every registered MCP tool's model name, description and input schema as JSON, characters / 4, as `show` counts them), and `surfaces`: per workspace, the `schemaTokens` its listed MCP tools add to each of its operator's model calls, with a `warning` above 20,000; `proxy` when a proxy variable is set (remote servers never use it); and `taintObserved`, the MCP calls the taint step asked or would have asked in the last 7 days.
- Returns exit code `0` if admission is open and dependencies are healthy; `4` if unavailable.
- `strandedAdmissions` lists admissions left `claimed` with no outcome that no turn of the answering process is running — usually a turn cut off by a crash or a `kill -9`, sometimes one a failed write left behind — newest first, at most 50, with `truncated`. Nothing re-admits one automatically. Each entry says what holds the task's slot (`slot`) and the step that settles it (`remedy`):
  - `held`: an execution of an owner that is gone still holds the slot (`execution` gives its `generation`, `ownerSession`, and whether its lease has `expired`): `tavi recover <task-id> --generation <n> --reason <text>` once that owner is confirmed gone, then retry the admission's `operationKey` — `tavi run --operation-key <key>`, or the same decision sent again — or `tavi cancel` the task.
  - `busy`: the answering owner is running a newer turn of the same task: nothing to recover; retry the key once that turn ends.
  - `recovered` / `free`: nothing holds the slot (its own execution was recovered, or none does): retry the key, or `tavi cancel` the task.
  An admission superseded by a later settled one, or on a cancelled task, is not listed; nor is one still `pending` (queued, never claimed). The report does not change the exit code.
- `chatMeasurement` is local measurement, read from rows the data directory already keeps and never sent anywhere. Totals cover every stored row, all workspaces, all time; rows a `forget` or a task deletion removed drop out.
  - `usageByChatKind`: one entry per chat kind that has a turn or a model call, in the order `home`, `side`, `messaging` (a channel conversation), `worker`, `run`, `chat` (any other chat), `unattributed` (a provider call naming no task, such as a router decision). Each gives `turns` (admissions claimed, committed or failed), `modelCalls`, `generationCalls`, `generationCallsWithoutUsage`, `inputTokens` (reported input tokens of generation calls), `inputTokensPerTurn`, `summarizerCalls { total, compaction, epochFlush, taskSummary, other }` (stage-2 fold summaries, pre-rollover memory flushes and task titles/summaries, told apart by their attempt-id prefix) and `otherCalls` (learning, evaluation, router).
  - `promptCacheByChatKind`: how much of each chat kind's prompts a provider's prefix cache could reuse, from completed generation calls recorded with their turn `step` and `systemHash` (the first 16 hex digits of the SHA-256 of the call's system text, which the ledger records at the call's start). Calls from before this measurement have neither and are left out; a kind appears once it has a measured call. Each gives `firstStep` and `laterSteps`, each `{ calls, inputTokens, cacheReadTokens, share }` — the cache-read share of input tokens on a turn's first call (after the person's message) and on its later calls (after a tool result), over calls whose provider reported both counts; `callsWithoutCacheUsage` (the provider did not report both input tokens and cache reads: it does not cache, or does not say); and `firstStepPrefix { turnsCompared, sameAsPreviousTurn, share }` — of the turns whose first call follows an earlier turn's in the same chat, how many sent the same system text. The memory retrieved for each message (and an ordinary chat's epoch summary) travels in the user-role context block, not the system text, so a share below 1 now means the persona, the chat's instructions or the runtime facts changed between turns, or the compared turns predate this layout.
  - `usageBySite`: token use per call site over the last 30 days (`SITE_USAGE_WINDOW_DAYS`), from every settled provider call, most input tokens first. The site is recorded beside each call when it starts (never inside the request): `chat-step1`, `chat-stepN` and `final-step` (a chat turn's own calls), `heartbeat`, `ideas`, `worker`, `routine-research`, `routine-synthesis`, `compaction`, `epoch-flush`, `memory-review`, `consolidation`, `summarizer`, `extract`, `extract-repair`, `find`, `vision`, `evaluation` and `classifier`; calls from before sites were recorded are `unlabelled`. Each gives `calls`, `callsWithoutUsage`, `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`, `cacheUsageUnreported` (calls whose provider's usage said nothing about its cache, so their cache reads of 0 are unknown rather than misses), `cacheReadShare` and `estimatedUsd` (null when none had a price).
  - `prefixChurn`: over the same window, what re-sent a chat's whole prefix: `modelSwitches` (a turn whose first call went to another model than the turn before it) with `chatsWithModelSwitch`, and `folds` (stage-2 fold summaries, which rewrite the history after the system text) with `chatsWithFold`.
  - Each settled call also keeps `toolsHash` (the first 16 hex digits of the SHA-256 of its tool descriptors) beside `systemHash`, and its usage keeps `wirePrefixHash` (the same digest of the prefix as sent: tools and messages through the last cache breakpoint, or every message but the newest when none is marked) and `cacheUsageReported`, so two calls can be checked for a shared prefix.
  - `sideChats`: `created`; `messages { total, average, median }` (the person's messages per side chat: its prompt and each follow-up); `settled` (side chats whose parent holds a `side-chat-settled` notice); `returned` (the parent took a prompt of the person's within `returnWindowHours` = 24 after the latest settle); `awaitingWindow` (settled less than 24 h ago with no return yet); `returnToParentRate` = `returned / (settled − awaitingWindow)`, or null.

---

### `tavi cancel`

Durably cancel an in-flight or suspended task. Records an authoritative cancellation in the store, immediately aborts running attempts, closes pending approvals, and prevents late incoming worker messages or replies from reviving the work.

```bash
tavi cancel <task-id> --reason <text> [options]
```

#### Positional Arguments
- `<task-id>` *(required)*: Task identifier to cancel.

#### Options
- `--reason <text>` *(required)*: Durable explanation for why the task was cancelled.
- `--operator <id>`: Principal recording the cancellation (default: `$USER` or `operator`).
- `--data-dir <path>`: Custom data directory path.
- `-h, --help`: Show help text.

---

### `tavi recover`

Free a task's execution slot when the process that ran it has died. Tavi's atomic lease discipline treats expired leases as evidence to investigate, not permission to automatically overwrite; an operator must explicitly clear the dead generation before a replacement invocation can be admitted.

```bash
tavi recover <task-id> --generation <n> --reason <text> [options]
```

#### Positional Arguments
- `<task-id>` *(required)*: ID of the task whose execution slot is blocked.

#### Options
- `--generation <n>` *(required)*: Numeric generation ID of the dead attempt to terminate (positive integer).
- `--reason <text>` *(required)*: Recorded rationale confirming the prior process is terminated.
- `--operator <id>`: Operator principal confirming recovery (default: `$USER` or `operator`).
- `--data-dir <path>`: Custom data directory path.
- `-h, --help`: Show help text.

---

### `tavi models`

Inspect and configure model provider connections, default model targets, and per-role overrides. With no owner running, these commands take exclusive ownership of the data directory; under a live `tavi serve` they run on the owner over IPC (see "Configuration under a live owner").

```bash
tavi models <action> [options]
```

#### Actions
- `list`: List all configured model provider connections. A connection's `defaultModel` is its own, else the workspace default's model when that runs on it (`tavi setup` and `set-default` set the workspace's), and `workspaceDefault` marks the connection the workspace default runs on.
- `show <connection-id>`: Show connection properties, base URL, and cached model catalog.
- `add <connection-id>`: Add or update a provider connection, with `--label`, `--base-url`, `--credential`, `--model`, `--local-only`, `--pdf-input`, `--pdf-engine`, `--first-byte-timeout`, `--idle-timeout` and `--header` (see Options). A local connection — a loopback or unix-socket base URL, or `--local-only` — may leave `--credential` out: Tavi then names a key of its own, as `tavi setup model` does for Ollama and LM Studio — one already stored under the connection's id that no other connection names, else a placeholder it stores under the first free `<id>`, `<id>-2`, … — so two local connections never share a key across addresses. Any other connection without `--credential` is refused before any owner is asked, naming the flag (exit `2`), with or without an owner. A credential another connection uses at another address is saved with a warning on stderr (`warning: credential <ref> is also used by the connection <id> at <origin>; …`): while `tavi serve` runs, `models test` refuses a key shared across addresses, so give each connection a credential of its own.
  - `add`, `rebind`, `list` and `show` print `local` (the effective locality: `true` for a loopback base URL) beside the declared `localOnly`.
  - **Reasoning effort.** The background calls whose answer is short — `browser.find` and `browser.extract`, task summaries, the injection classifier, a heartbeat check's turn, a compaction summary, the epoch flush and a memory provider's capture and tidy-up calls — ask for `low` reasoning effort: OpenAI's endpoint is sent `reasoning_effort` for a reasoning model (the o-series, GPT-5 and later but their `-chat` variants), Anthropic's own endpoint `output_config.effort` for a model that takes it (Claude 5 and later, Opus 4.5–4.8, Sonnet 4.6: thinking cannot be turned off on Claude 5.5 models, so effort is how deep it goes), OpenRouter `reasoning.effort` only for an OpenAI reasoning model there (for another, a reasoning object can switch thinking on: Claude's extended thinking costs 1,024 tokens or more), and no other endpoint, nor the Responses wire, anything. A chat's own turns ask for none (the provider's default), and a heartbeat's asks the same on every call of its turn.
  - A connection is of one of two kinds. `openai-compatible` (Chat Completions, or the Responses API for Sign in with ChatGPT) is every endpoint's but one: Google's Gemini among them, through its OpenAI-compatible endpoint. `anthropic-messages` speaks Anthropic's own Messages API, through the AI SDK's Anthropic provider; a new connection to Anthropic's endpoint gets it from the preset:

    | Vendor | `--base-url` | Kind | Credential |
    | :--- | :--- | :--- | :--- |
    | Anthropic | `https://api.anthropic.com/v1` | `anthropic-messages` | an Anthropic API key |
    | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `openai-compatible` | a Gemini API key |

    Name the model with `--model`, an id from the vendor's own model list; `discover` lists what the vendor lists (Anthropic's with its own `x-api-key` and `anthropic-version` headers; Gemini's as far as its compatibility layer lists models to a bearer token, so it may find none). On an Anthropic connection the model's prompt is cached (`cache_control` breakpoints, as for an `anthropic/…` model on OpenRouter; see [CONFIGURATION.md](CONFIGURATION.md)), its usage reports the cache's reads and writes, and when the model thinks (Claude 5 models do by default) its thinking is kept with each step, whole or not at all, and sent back to the same model with the step's tool results, which Anthropic's API requires. Through OpenRouter, an `anthropic/…` or `google/gemini…` model's requests carry prompt-cache breakpoints too. Which presets get breakpoints, OpenRouter's `session_id`, OpenAI's `prompt_cache_key`, the one-hour heartbeat prefix and where under the v2 prompt layout the loop marks each request's cacheable end are in [CONFIGURATION.md](CONFIGURATION.md#connection-kinds). A connection to Anthropic's endpoint saved before this kind existed keeps `openai-compatible` (the compatibility layer, which caches nothing) until it is removed and added again. To Gemini's endpoint, what tavi sends is the plain Chat Completions request: a vendor's extensions to it — thinking or reasoning settings, safety settings — are not sent.
- `remove <connection-id>` (alias `rm`, `delete`): Delete a connection and the models it discovered. Refused while a role or a workspace default names it: point those at another model first.
- `rebind <connection-id> [--credential <ref>]`: Update the credential reference for a connection. Without `--credential`, a local connection is given a key of its own as `add` gives one; any other is refused (exit `2`).
- `discover <connection-id> --credential-file <path>`: Query the provider's `/models` endpoint to refresh the model catalog.
- `test <connection-id> --credential-file <path> [--model <id>]`: Execute a bounded test generation through the connection. A provider's 408 or 409 is reported as a `provider` failure (retryable, as the AI SDK classifies them).
- `probe <connection-id> --pdf [--model <id>] [--credential-file <path>]`: sends the model (the connection's default unless `--model`) a generated one-page PDF holding a random eight-character code, as the file a `pdf.view` result names, and asks for the code back. On a pass the connection's `pdfInput` becomes `openai-file`; a fail changes nothing. Answers `{ connectionId, modelId, ok, pdfInput, latencyMs, message? }`, exit 0 on a pass and 1 on a fail. An endpoint that drops files (Anthropic's compatibility layer) is `UNSUPPORTED` before anything is sent, and a provider-managed connection `CAPABILITY_MISSING`. A probe names exactly one of `--pdf` or `--video`. Offline it needs `--credential-file`; on a running owner the owner's credential is used.
- `probe <connection-id> --video [--model <id>] [--credential-file <path>]`: sends the model a 4-second clip of four digits and asks for them back in order; a pass qualifies the model for `tavi models video` and changes nothing else ([VIDEO.md](VIDEO.md)).
- `video <connection-id> --enable <model> --yes`: Sends that model whole videos a chat views instead of frames (its catalog or a passed video probe must say it reads video). Without `--yes` it prints what leaves the machine and changes nothing.
- `video <connection-id> --disable <model>`: Back to frames for that model.
- `roles`: Show the workspace default, the role-specific bindings, and `resolved`: what role resolution gives each role in the workspace — `{ role, source, target }`, `source` being `role-override` (the binding's first usable target) or `workspace-default` (with `skipped` candidates, if any), or `source: null` with the typed refusal (`NOT_CONFIGURED` when neither a binding nor this workspace's default exists, or every target is unusable, with the reasons in `skipped`). `embedding` never resolves to the workspace default: until it is bound it shows `source: null` with `NOT_CONFIGURED` naming `tavi models set-role embedding`. This is the role configuration's answer. `tavi run` and `tavi serve` resolve role `main` the same way — and a workspace that configures neither a `main` binding nor a default runs the default workspace's, which `resolved` does not borrow. The other roles serve narrower calls: `fast` the heartbeat's checks and onboarding's verification, `extraction` and `compaction` the browser's extraction and the epoch summaries (each falling back to the chat's own model), and `embedding` hybrid memory recall.
- `set-default --connection <id> [--model <id>]`: Set default provider and model for the workspace. A model the connection's catalog does not list is still saved, with a warning on stderr (`warning: <connection> does not list the model <id>`) naming the nearest listed id and `tavi models test`; `set-role` warns the same way.
- `clear-default`: Remove workspace default model target.
- `set-role <role> --connection <id> [--model <id>] [--fallback <conn/model>]`: Bind a specific model role with optional fallback targets (up to 3 fallbacks). Role `main`'s fallback is what a run fails over to: a model call answered with a rate limit (a 429 that is not an exhausted quota) or a provider fault (5xx, 408, 409, or a retryable error inside the stream) moves to the next target as a new attempt, discarding what the failed call had streamed; an exhausted quota, an authentication failure, a bad request or an abort ends the turn as before. A target that answered `Retry-After` is not failed over to, nor started on, by this process until that time has passed — a turn, or compaction's summary, starts on the first target not waiting (said in the owner's log) — except when every target is waiting, when the first is called: a turn must call something. A failure that is not a provider's answer — a refused connection (an endpoint that is down), or a reset mid-stream, with no status — does not fail over: it is reported as `unknown`, not as a bad request. Each fallback connection's credential resolves through the credentials directory or a launcher's binding: `--api-key-file` binds the first target's alone.
  - Supported roles: `main`, `extraction`, `compaction`, `fast` (a cheaper, quicker target) and `embedding` (a text-embedding model). `embedding` is the model the owner's embedding call uses (docs/MEMORY.md): only an explicit binding counts, never the workspace default, it is not failed over (vectors from two models cannot be compared), and its calls appear among a run's provider attempts with purpose `embedding`, usage only. Nothing in recall calls it until hybrid retrieval.
- `clear-role <role>`: Remove a role-specific override.
- `suggest`: Off unless `RESOLVER_KEY` is set; without it, prints a hint and changes nothing. With it, asks the model resolver (`RESOLVER_URL`, default `https://models.nannertech.com`) two things and prints the answers as JSON without applying them: the best local model for tavi's agent turns (tools, a 32,768-token context) on the connected local runtimes (Ollama, LM Studio) that fits this machine — three quarters of its memory, the free disk under the data directory, and on Apple silicon the same memory as GPU memory — and `priceSheets` for the models on the connected cloud providers (OpenRouter, OpenAI, Anthropic, Gemini), in the form `tavi router configure` installs. A connection to a custom endpoint is not asked about. Only provider names, the task and the machine's limits are sent: never a prompt, a credential or a model key. Each call has a 2-second deadline, and a process that asks again within a day reuses the answer (or, when the resolver then fails, the older answer); a failed call (a 4xx or 5xx, `no_candidate`, a timeout) leaves its suggestion out with a note, and the command still exits 0.

#### Options
- `--label <text>`: Friendly display label.
- `--base-url <url>`: Endpoint URL (e.g. `http://localhost:11434/v1` for Ollama).
- `--credential <ref>`: Opaque credential reference identifier (e.g. `openai.apiKey`), for `add` and `rebind`.
- `--model <id>`: Default model for this connection (`add`), or the target's model (`set-default`, `set-role`, `test`, `probe`).
- `--local-only`: Declare this connection targets operator-controlled local infrastructure (skips cloud validation).
- `--pdf-input none|openai-file`: Whether a PDF a tool hands the model is sent as a Chat Completions `file` part. Unset, the endpoint's preset decides: on for `https://api.openai.com/v1` and `https://openrouter.ai/api/v1`, off elsewhere. `openai-file` is refused on any other endpoint (`INVALID_INPUT`, naming the PDF probe that turns it on); `none` is kept across later edits, and moving the endpoint returns it to its preset's default.
- `--pdf-engine pdf-text|mistral-ocr|native|default`: OpenRouter's `file-parser` engine for those PDFs; `default` clears it.
- `--first-byte-timeout <seconds>|default`: How long a call waits for the provider's first output before it is given up as a provider fault, so role `main`'s fallback takes over (default 60; 180 for a call that reasons first; 600 for an endpoint on this computer). Whole seconds, 1 to 3600; `default` clears it. Kept across later edits while the endpoint stays the same, dropped when it moves.
- `--idle-timeout <seconds>|default`: The same for a reply that goes quiet between chunks (default 90); what it already streamed is discarded with the failed call.
- `--header <key=value>`: Custom HTTP header (repeatable). Credential headers are rejected.
- `--connection <id>`: The target's connection, for `set-default` and `set-role`.
- `--fallback <conn/model>`: Ordered fallback target for `set-role` (repeatable, max 3).
- `--credential-file <path>`: Credential file for `discover`, `test` and `probe` (`0600`, explicit). Under a running `tavi serve` it is refused: the owner tests connections with its own credentials.
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

---

### `tavi memory`

Inspect and curate personal and workspace memory records (facts, preferences, lessons, summaries), and review what the agent proposes. Features full-text lexical search with citations, topic conflict detection, and immutable revision history.

```bash
tavi memory <action> [options]
```

#### Actions
- `list`: List memories accessible to the acting principal.
  - `--scope <personal|workspace|shared|agent:<agent-id>|chat:<task-id>>`: Filter by scope (default: all authorized scopes); `agent:<agent-id>` is your memory for that agent in this workspace, and `chat:<task-id>` one chat's notes, which are listed only when named.
  - `--kind <fact|preference|lesson|summary>`: Filter by record kind.
  - `--limit <n>`: Pagination limit (at most 100 through the owner).
  - `--offset <n>`: Pagination offset.
  - `--origin-task <task-id>`: Only the records that chat wrote — what it taught (the chat panel's **Learned here**). Owner only.
  - `--used-in <task-id>`: The records that chat's turns were given, most recent first (**Used here**): one page. Owner only.
  - `--chat-notes`: Every chat's notes in place of the scopes, each naming its chat as `chat:<task-id>`; not with `--scope` or `--used-in`. Owner only.
  - `--past`: **Past** (the Command Center's list of the same name): facts whose end date passed, kept approved as history (`ended after <day>, kept`), and preferences and lessons that expired (`expired after <day>, erased on <day>`: `limits.proposalDays` after the sweep marked them). Days are named in the workspace's `timezone`. Not with `--used-in` or `--chat-notes`. A JSON row through the owner carries `erasesAt`.
- `proposals`: List what the agent proposed and nobody reviewed yet, with `list`'s options and output.
- `review`: Decide the waiting proposals one at a time, oldest first, at a terminal (a pipe exits `2`). Each shows its kind, where it would apply (`remember everywhere` or `this chat only`), its expiry date, the chat it came from and how many sources it cites; a sensitive one's text only on `v`. `k` keeps it, `d` discards it, `e` asks for new words and keeps it in them (approve, then correct), `s` skips it and `q` stops. An update shows `updates: <the kept one>` and takes `r` to replace the kept record with it (`memory {action: "replace"}`) — and, for a fact, `k` to keep both — but no `e`; a near duplicate shows `similar to: <the kept one>`. A proposal decided elsewhere meanwhile is reported as `Already kept.` or `Already discarded.`, and a tidy-up one of whose inputs changed since it was suggested says so (discard it; the next weekly run suggests it again); it ends with `kept N · replaced N · discarded N · edited N · skipped N` (`replaced` only when there were any), and exits `4` if a decision failed. Owner only.
- `search <query>`: Bounded lexical full-text search across memories with relevance ranking and citations. A record matches when it holds every word; when none does, the search runs again for records holding any of them, and the text output starts with `No exact match; showing partial matches` (JSON: `"match": "any"`). Each hit's text is its whole body up to 300 characters, else about 40 words around the match with the matched words in `[brackets]`.
- `show <record-id>`: Display the record. Through the owner it includes the current title and body (a sensitive record's are withheld).
- `remember`: Propose and approve a memory record in a single atomic operation.
  - `--scope <personal|workspace|agent:<agent-id>|chat:<task-id>>`: Target memory scope (default: `personal`); `chat:<task-id>` makes it a note for that chat only. `shared` is refused (exit `2`): shared memory is changed by an explicit share only.
  - `--kind <fact|preference|lesson|summary>`: Record kind (default: `fact`).
  - `--title <text>`: Optional short title.
  - `--body <text>`: Memory content body.
  - `--key <text>`: Preference key (for `kind=preference`).
  - `--value <text>`: Preference string value (for `kind=preference`).
  - `--topic <text>`: Topic key for semantic grouping and contradiction detection (for `kind=fact`).
  - `--sensitive`: Mark record as sensitive.
  - `--reason <text>`: Rationale for creating the record.
- `correct <record-id>`: Supersede an approved record with a new revision. A record's end date is kept unless `--until` changes it.
  - `--title <text>`, `--body <text>`, `--value <text>`, `--reason <text>`.
  - `--until <date|none>`: **Keep longer**: a new end date — `YYYY-MM-DD`, which holds through that day in the workspace's `timezone`, or an ISO date-time with its zone — in the future (else exit `2`); `none` keeps it with no end. It moves the date the record has (a fact's end, a preference's or lesson's expiry), else the one its kind takes. An expired record returns to approved; for a preference whose key has another value kept meanwhile it exits `2` (`MEMORY_CONFLICT`).
- `approve <record-id>`: Approve a proposal; `--note <text>` is recorded with the review.
- `reject <record-id>`: Reject a proposal; `--note <text>` says why. A record that is no longer proposed exits `2`.
- `forget <record-id> --reason <text>`: Erase a record: its revisions, search entries, vectors and card rows go, a tombstone and a content-free journal row stay. What derives from it is blocked or marked for review, and a waiting tidy-up that merges it is erased with it. Through the owner it also edits every channel message a card or digest listing either was sent as, and the receipt's `unreached` names what no forget reaches.
- `move <record-id> --scope <scope>`: Move an approved record to another scope, as the chat panel's **Remember everywhere** and **Keep to this chat** do: it is remembered there, keeping the chat it came from, and forgotten here. `--reason <text>` is recorded. `shared` is refused (exit `2`). Owner only.
- `why <chat-task-id>`: The memories that chat's newest answer used, as its saved turn recorded them (the revisions its model calls were given and those `memory.search`/`memory.get` fetched), each with its date (in the workspace's `timezone`), the chat it came from and its id, as `/why` says them (`The answer used 2 memories:` …, then any forgotten since or past the 20 an answer names, then what `memory.list` showed it under `Looked through 5 memories:` or `Looked through 4 more:`, and how many preferences applied; or `The last answer used no memory.`). An answer saved before answers recorded this says `Not recorded: …`.
  - `--turn <n>`: The chat's turn `n` (from 1) instead; a turn the chat does not have exits `4`.
  - `--format json`: The answer as JSON (`taskId`, `seq`, `answeredAt`, `records`, and `used`: `recorded`, `used`, `forgotten`, `preferences`). Owner only.
- `export`: Export all accessible records for auditing or backup. Offline only. It holds Tavi's records only: when the workspace selects a memory provider other than the built-in, stderr says that any index of its own is outside Tavi's tables and the plugin's to clear; the JSON on stdout is the bundle alone.
- `config [<key> [<value>]]`: The workspace's memory settings (see below).
- `set-provider <id>|builtin`: The workspace's memory provider (see below). Owner only.
- `egress <records|conversation|personal> on|off`: What the workspace's external memory provider may receive (see below). Owner only.
- `reindex`, `review-now`, `consolidate-now`: Operator conveniences: the `tavi.memory` host's background jobs run now (see below).

#### Options
- `--workspace <id>`: Workspace to act in (default: `default`).
- `--principal <id>`: Personal principal (default: `operator`); for `consolidate-now`, only this person.
- `--format <text|json>`: Output format (default: `text`; renders as JSON for `show`, `remember`, `correct` and `forget`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).
- The other options belong to one action each, and are listed under it above (and under `config`, `reindex`, `review-now` and `consolidate-now` below).

While `tavi serve` runs, every action except `export` goes through the owner (the `memory` command above) and acts as the workspace's operator: it sees the operator's personal, workspace and agent memory and the workspace's shared memory, and `--principal` applies only offline. The output and exit codes are the offline command's, except that a JSON listing prints the owner's rows (the record plus `target`, `title`, `body`, `redacted`, …) and `search` shows no `(conflict)` flag. `export` is refused with exit `5`: the owner answers evidence as counts, never as its sources. With no owner running the commands open the data directory directly.

The agent can only propose memory (the `memory.propose` tool); a proposal is not used until the operator approves it — or, for a kind the operator listed under `tavi memory config auto-approve`, until Tavi finds it in words the operator typed — and one nobody reviews within 30 days (`tavi memory config limits.proposalDays`) expires.

A `chat:<task-id>` scope, the owner-only options, `move`, `review` and `why` need `tavi serve` running: without one they exit `2` saying so.

#### `tavi memory config`

```bash
tavi memory config                         # every key: its value, (set) or (default), and the revision
tavi memory config <key>                   # one key
tavi memory config <key> <value> [--revision <n>] [--workspace <id>] [--format text|json]
tavi memory config retrieval hybrid --yes=cloud  # accept the disclosure of the remote embedding connection it named
tavi memory config retrieval hybrid --include-personal --yes=cloud  # your personal memory too, after its own disclosure
tavi memory config auto-approve fact,preference  # keep your own facts and preferences without asking; none turns it off
```

The workspace's `memory` settings section (docs/MEMORY.md B.3), stored as the key `memory` of the workspace settings. It goes through the owner's `workspace-settings` command when `tavi serve` runs, which takes a change from the workspace's operator only, and opens the data directory otherwise. A change reads the section, changes the one key and writes the whole section back held to the revision it read, or to the one `--revision` names: a revision that moved is a conflict (exit `3`) and nothing is written. It applies from the next model call. `default` as the value clears a key.

| Key | Values | Default | Effect |
|---|---|---|---|
| `enabled` | `on` · `off` | `on` | `off` pauses memory: no turn gets a memory manifest, the model is offered no `memory.*` tool and no `sessions.search`, a heartbeat check gets no memory block, and nothing is captured. Records are kept. |
| `capture` | `suggest` · `off` | `suggest` | `off`: the model is not offered `memory.propose`, a rollover flushes nothing, and the idle review reviews no quiet chat (what was said meanwhile is never reviewed later); what you write yourself (`remember`, the Center) is still kept, and recall is unchanged. |
| `auto-approve` | `none`, or a comma list of `preference`, `fact`, `lesson` (plurals accepted) | `none` | *Keep without asking* (docs/MEMORY.md A.2): a new proposal of a listed kind is approved at once, with the operator's authority and the review note `auto-approve (settings revision N)`, and its card shows it *Saved* with *Undo* — only when it is the operator's own, from `memory.propose` in an attended, untainted chat turn not held to a messaging channel, or from the idle review (never the flush, a tidy-up suggestion, a worker, a `run`, a heartbeat tick or a bound channel user), and Tavi finds at least 80% of its words, and its title's (at least three; a negation added or dropped in the same clause, or a supposition such as "if" or "would", making it wait), in one message you typed (not in a `>` quote, code, an HTML quote or quotation marks); a preference needs its value and every word of its key typed, at least three words between them, and its wording too, unless that only restates the key and value. A sensitive proposal, an update, a near match, one akin to a kept record of its kind (Jaccard ≥ 0.5 among the top matches, or cosine ≥ 0.8 under `retrieval hybrid`) and a preference whose key has a segment `auth`, `payment`, `channel`, `exec` or `credential` (or its plural), or any non-ASCII character, always wait. Removing a kind stops it from the next proposal, and from one made before it was removed. `/memory` names the kinds to the workspace operator only. |
| `sensitive` | `skip` · `suggest` | `skip` | What automatic capture (a rollover's flush and the idle review of a quiet chat) does with a draft the model marked sensitive or Tavi's category list matches — health, sex life or orientation, religion or beliefs, politics, ethnicity, union membership, money, account numbers and ids: `skip` drops it; `suggest` files it marked sensitive, so it is masked on every card, the terminal, channels and the digest, and never recalled automatically. The model's `memory.propose` made because you asked is filed either way, marked sensitive when the list matches. A draft holding a key-shaped secret is never filed. |
| `retrieval` | `lexical` · `hybrid` | `lexical` | `hybrid`: turn recall and the `memory.search` tool also rank by meaning, through the `embedding` model role (docs/MEMORY.md A.3), fused with the word ranks; anything that fails or lacks a vector falls back to words, `coverage: "partial"`. What it needs and what it sends where: see *`retrieval hybrid`* below the table. |
| `digest` | `weekly` · `off` | `weekly` | The review digest (docs/MEMORY.md B.1): what waits for each person, gathered into a card in their Home (or their direct chat) at the first check after 09:00 in the workspace `timezone`, weekly and sooner when a proposal nears expiry, and sent to the operator's direct delivery targets. `off`: none. It is sent while memory is paused too. |
| `consolidation` | `off` · `weekly` | `off` | Weekly tidy-up suggestions (docs/MEMORY.md B.1): once a week, at the first check after 03:00 in the workspace `timezone`, the workspace's memory provider reads each person's approved facts and lessons (never a chat) and suggests merging, replacing or ending some, each filed as a proposal you decide in the Center's *Tidy-up suggestions*, with its before and after. Nothing changes until you keep one, and none is ever kept automatically or by a bulk keep. Not while memory is paused. |
| `limits.contextTokens` | 2000–32000 | 8000 | The budget for a call's system text (base prompt, persona, chat instructions, runtime facts) and its memory manifest together; the manifest is sent in a block of quoted data at the front of the newest message, not the system text. |
| `limits.evidence` | 0–20 | 10 | Records a call's manifest may carry; `0` retrieves none by search. |
| `limits.proposalDays` | 7–90 | 30 | Days a proposal waits before it expires (or its own end date, if sooner), and an expired or rejected one before it is erased — a preference or lesson that expired on its date counts them from when the sweep marked it. |
| `limits.maxRecords` | 10–20000 | 5000 | Records a person may keep across the scopes they read; the byte quota follows it (32 MiB at 5,000). Past it a write is `QUOTA_EXCEEDED`. |

*`retrieval hybrid`*:

- It needs a bound `embedding` role (`NOT_CONFIGURED`, exit `4`, naming `tavi models set-role embedding`). A local connection needs no disclosure.
- On a **remote** embedding connection it is refused until you accept its disclosure — "Memory text and each message's retrieval query will be sent to <connection> to compute embeddings: N approved memories of this workspace now, and each new one as it is approved. Personal memory is not sent unless you turn on personal memory too, so it is matched by its words only." — by running it again with `--yes=<connection>`, naming the connection the disclosure named.
  - Until then it is refused: `APPROVAL_REQUIRED`, which ends "Run it again with --yes=<connection> to confirm."
  - A bare `--yes`, or a connection other than the one bound now — the role rebound meanwhile — is refused with the disclosure of the one bound now.
  - Rebinding the `embedding` role to another remote connection later sends nothing there until you accept again.
- **Personal memory** (yours, shared by all your workspaces) goes through a remote connection only with `--include-personal`, which first says how many of your personal memories would be sent there (refused `APPROVAL_REQUIRED` until `--yes=<connection>`; both disclosures at once when hybrid is turning on too).
  - It covers the operator's own personal memory only — other people's (those bound on the workspace's channels) never go to a remote connection.
  - The owner stores the connection it was accepted for (`retrievalPersonal`), and another connection gets none until you accept again.
  - `retrieval hybrid` without the flag turns it off (the next tick deletes those vectors), as does `lexical`; `--include-personal` goes with `retrieval hybrid` only (exit `2`).
  - An external provider's `tavi memory egress personal on` does not stand in for it.
- The owner then embeds approved, non-sensitive memories of the workspace and personal ones — on a local connection its people's, with `--include-personal` accepted on a remote one the operator's own — 600 a minute.
- A chat on a local model never sends its query to a remote connection, and heartbeat checks stay lexical.
- `tavi config set memory` cannot turn it on offline.

A value out of bounds, or a key not listed, is refused (exit `2`). The provider and its egress are not `config` keys: they change only with the verbs below, and a `tavi config set memory` that changes them is refused (exit `2`). `tavi doctor` reports them under `memory`: the section as `memory.settings`: `state` (`on` or `paused`), `capture`, `autoApprove` (the kinds kept without asking, always shown, `[]` when none: they relax the approval gate), and `changed`, every other key that differs from its default (`sensitive: suggest`, for one), and `retrievalConnection` and `retrievalPersonal` when stored; the digest as `memory.digest`: the setting, and when each person's last digest went out; the idle review as `memory.review`: the last review and today's reviews, proposals, drops, failures, skips and spend; the epoch flush as `memory.flush`: today's spend; consolidation as `memory.consolidation`: the setting, the last run, what it drafted and filed, failures, weeks skipped and today's spend — the review, flush and consolidation lines summed over every workspace the owner serves; hybrid recall as `memory.vectors`, with today's embedding spend; and the provider as `memory.provider`. `capture off` also stops the idle review.

---

#### `tavi memory set-provider` and `tavi memory egress`

```bash
tavi memory set-provider <id>|builtin [--revision <n>] [--yes] [--workspace <id>] [--format text|json]
tavi memory egress <records|conversation|personal> on|off [--revision <n>] [--yes] [--workspace <id>] [--format text|json]
```

The workspace's memory provider (docs/MEMORY-PLUGINS.md): the built-in `tavi.memoryprovider` (`builtin`), or an installed, approved and running plugin that provides memory. Both need `tavi serve` running (without one they exit `2` saying so), go through the owner's `memory` command as the workspace's operator, and are held to the settings revision read, or the one `--revision` names (a moved revision is exit `3`).

- `set-provider <id>` shows what the provider does and may receive, and changes nothing until it is run again with `--yes` (refused: `APPROVAL_REQUIRED`, exit `2`). An id that is not installed here is refused (exit `2`). Its egress starts with every switch off; the provider it replaces is sent nothing more, and the answer says its own index is the plugin's to clear. `builtin` needs no `--yes`. A selected provider that stops running (disabled, not started, rejected) falls back to the built-in: the owner logs it once, and doctor and the Center say so.
- `egress <field> on` shows what that switch sends and needs `--yes`. `records`: approved memories of the workspace's scopes (never sensitive ones), sent as `candidates` to a provider that ranks the host's records, or kept in its own index through `sync`. `conversation`: each recall query and the chat spans it drafts proposals from; without it the provider is never asked to recall or capture, and the built-in serves. `personal`: the person's own memory too, which all their workspaces share; refused while `records` is off. Only a field the provider declares in `receives` can be turned on. `off` needs no `--yes`: turning `records` or `personal` off removes those records from the provider's index (`egress-off`), and `records` off turns `personal` off with it. The heartbeat's recall never reaches an external provider, whatever the switches.

The answer prints the selected provider (and that the built-in serves meanwhile, when it does), each switch, any forgotten records still waiting to be removed from a provider, and the revision. A forget whose removal a provider could not take now completes anyway: its receipt says "It will be removed from <provider> when it next runs" (on `/forget`, the Center, a card's *Undo* and `tavi tasks history … forget --with-memory` too), and `tavi memory forget` with no owner running says it for each provider a workspace selects that keeps an index of its own (as its approved plugin record declares) and is given records (one spanning workspaces, personal or an agent's with no workspace, only with `personal` on), leaving the removal for the next owner; and the removal is resent to that provider, whichever provider the workspace selects by then, on the owner's own upkeep timer (every minute, whether `tavi.memory` runs or not) and when the provider starts; the row completes once every provider that missed it has taken it. A provider whose `sync` has not answered within 10 seconds counts as having missed it. A record never approved, or a sensitive one approved or revoked, is never sent as a removal, so no receipt names a provider for it.

---

#### `tavi memory reindex`, `review-now` and `consolidate-now`

```bash
tavi memory reindex [--max-wait <seconds>] [--workspace <id>] [--format text|json]
tavi memory review-now [--chat <task-id>] [--workspace <id>] [--format text|json]
tavi memory consolidate-now [--principal <id>] [--workspace <id>] [--format text|json]
```

Operator conveniences: the `tavi.memory` host's background jobs run now, with the same code the tick runs, between ticks and never beside one. Each goes through a running owner's `memory` command (`reindex`, `review-now`, `consolidate-now`), or, with no owner, composes a runtime of its own under ownership (the memory host on with no tick, no sweep or scheduler). A host that is not running (`tavi plugins disable tavi.memory`) answers `UNAVAILABLE`.

- `reindex`: hybrid recall's vector backfill, one pass at a time — what the minute's allowance (600 texts, across the owner) lets it embed — until nothing is missing, waiting out the allowance between passes, with a progress line on stderr after each. It stops when nothing more can be embedded (texts failed three times on the model), when a failed call holds the backfill back for an hour, when nothing can be embedded (memory paused, no `embedding` role, a remote connection whose disclosure is not accepted), or at `--max-wait` (default 600 seconds). It prints `indexed N, missing M, failed F` and why it stopped; exit `0` when nothing is missing, `4` otherwise. With `retrieval: lexical` it says vectors are built only with hybrid recall, and exits `0`.
- `review-now`: the idle review for every eligible chat of the workspace, or the one `--chat` names, without the 10-minute idle wait or the one-review-a-tick spacing. Every other rule holds: only attended Home, side and ordinary chats with memory on; a chat seen for the first time is marked at its newest turn saved before the job started, so history from before is never reviewed (a runtime composed offline starts the job now); three new substantive person messages since the mark; an hour after a failed review; the person's 24 reviews a day; the marks. It prints one line a chat: `reviewed` with the proposals filed, or `not-due`, `waiting`, `capped`, `no-model`, `capture-off`, `failed` (exit `4` when one failed), or `not-eligible` for a `--chat` the review never reads (a worker's, a `run` or messaging chat, or one with memory off along its parents).
- `consolidate-now`: consolidation for each person who keeps approved memory in the workspace, or the one `--principal` names, without the weekly 03:00 schedule or a failure's hour. The setting must be `weekly` and memory on, else it says so and runs nothing. A run is still one a day (its mark is the day's: a second says `already`), reads only approved facts and lessons, needs the person's Home or an attended chat to record it on (`no-chat` otherwise), and files its tidy-ups as proposals. It prints one line a person with the tidy-ups filed.

---

### `tavi skills`

Inspect and manage versioned, content-addressed skills, approvals, rollbacks, and bounded rollout allowlists. With `tavi serve` running every action but the rollout ones goes to the live owner (IPC `skills`, the same command the canvas's Skills panel uses); the rollout actions refuse there (exit `5`) and work on the data directory once it stops.

```bash
tavi skills <action> [options]
```

#### Actions
- `list`: List all skill versions imported into the workspace, each with its review state (an agent's proposal waiting past 30 days is marked `(expired)`: still yours to approve or reject, no longer counted against the five that may wait), its name, its use count and its last use (an active skill unused for 60 days is flagged).
- `show <skill-id>`: The skill's active version, then each version on a line (its review state, when it was imported in your local time, and its provenance), then its activation history, newest first (`Activated 2.0.0 (was 1.0.0)`, with the local time and who). `--format json` prints the stored versions, activation and history as they are.
  - `--body`: Print a version's text (`--version <v>`, else the active one), headed by its hash and provenance; a package's files are printed one after another, each under `--- <path>`, `SKILL.md` first (an Agent Skills `SKILL.md` alone too). An agent's proposal also prints a warning naming what its turn read when that was untrusted content, and the tool calls of the task it came from (each tool and its input on one line, the first 40).
- `edit <skill-id> --version <v> --package <file>`: Edit an agent's waiting proposal before approving it: the file's text is filed as a new proposed version (`edited-<time>`) that follows the proposal, with its evidence and provenance kept; the proposal is set aside (rejected, without holding its topic). See [SKILLS.md](SKILLS.md#skills).
- `regenerate <skill-id> --version <v> --feedback <text>`: Send your feedback on an agent's proposal to the chat it came from, as your message asking the agent to propose it again (at most 4,000 characters). Needs `tavi serve` (exit `4` without it).
- `import <folder|SKILL.md|zip>`: Import an Agent Skills package as a proposed version: `SKILL.md`'s frontmatter gives its id (`name`), `description`, version (`metadata.version`, or `--version`), `allowed-tools` and `compatibility`; its other files (at most 32, 512 KiB in all, a `.zip` at most 1 MiB, no links, absolute paths or `..`) are stored with it as one deterministic bundle, scripts kept as text and never run. Without `--provenance` it is `archive:<file or folder name>`, another author's: approved only with `--yes`, and read as untrusted. Prints what was filed: `<id>@<version> imported: proposed, from <provenance>`, its files and declared tools, and the `show --body` command that reads it. See [SKILLS.md](SKILLS.md#skills).
- `import <skill-id>`: Import a single package file as a proposed version (enters proposed unless the exact bytes were already approved here), printed as the folder form's is. A `--package` file that does not exist is refused as `no such file: <path>` (exit `2`), as for `edit`.
  - `--version <text>` *(required)*: Version identifier.
  - `--package <path>` *(required)*: Path to skill package tarball or manifest.
  - `--name <text>` *(required)*: Manifest skill name.
  - `--provenance <text>` *(required)*: Source provenance URL or origin.
  - `--description <text>`: Optional skill description.
- `approve <skill-id> [--version <v>]`: Mark a proposed skill version (without `--version`, the skill's only proposed one) approved for activation. Prints the version's text and hash first (to stderr, as `show --body` does); a skill another author wrote (provenance `chat:…` or `archive:…`) needs `--yes`. Then `<id>@<version> approved.` and the `activate` command that turns it on.
- `reject <skill-id> [--version <v>]`: Reject a proposed version (without `--version`, the only one) (`<id>@<version> rejected`).
- `disable <skill-id>`: Clear the workspace's activation: no version of the skill is active.
- `activate <skill-id> [--version <v>]`: Set workspace activation pointer to an approved skill version (without `--version`, the skill's only approved one; with none or several it lists them and asks for one) (`<id>@<version> is active, since <local time>`).
- `rollback <skill-id> --version <v>`: Revert activation to a previously activated skill version.
- `pin-rollout <skill-id> --task <id> [--task <id> ...] [--version <v>]`: Restrict a skill version to an explicit allowlist of authorized task IDs. If `--version` is omitted, pins the currently active version. Prints the version and the tasks it is pinned to.
- `clear-rollout <skill-id> [--version <v>]`: Remove bounded rollout restriction, making the version available to all tasks.
- `rollout-status <skill-id>`: Show rollout pin status for the active version (pinned to which tasks, or every task gets it) and any other pinned version, with how many tasks it is still pinned to.

#### Options
- `--version <text>`: Skill version (required for `import`, `approve`, `activate` and `rollback`; optional for `pin-rollout` and `clear-rollout`, where it targets a specific, possibly non-active version).
- `--package <path>`: Package file to import (required for `import`), or the edited text (required for `edit`).
- `--feedback <text>`: `regenerate`: what to change (at most 4,000 characters).
- `--name <text>`, `--description <text>`, `--provenance <text>`: The manifest name (required for `import`), its description, and where the package came from (required for `import`).
- `--body`: `show`: print the version's text.
- `--yes`: `approve`: approve a skill another author wrote.
- `--task <id>`: Authorized task id for `pin-rollout` (repeatable, at least one required).
- `--workspace <id>`: Workspace to act in (default: `default`).
- `--principal <id>`: Acting principal (default: `operator`).
- `--format <text|json>`: Output format (default: `text`: the lines above; `json`: the stored record as the owner answers it).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

---

### `tavi bindings`

Explicitly link external channel identities (a sender on one of your connections, in its channel's form: a numeric chat user id, an email address) to principals, the Tavi users their messages act as. All identity bindings require explicit operator authorization; incoming messages from unknown senders are never automatically bound.

```bash
tavi bindings <action> [options]
```

#### Actions
- `bind`: Create an identity mapping. In text it prints one line (`bound 12345678 on telegram-<id> to operator (Sam)`); `--format json` prints the binding record.
  - `--connection <id>` *(required)*: Messaging connection ID, as `tavi channels list` shows it (`<provider>-<8 hex>`, e.g. `telegram-5bf25bcd`).
  - `--sender <id>` *(required)*: External sender ID, checked and normalized as the connection's channel names a sender (`tavi channels types`; an email address is case-folded). One that is not a sender there is refused (exit 2). A connection the data directory has no record of takes the id as given, an email address case-folded.
  - `--principal <id>` *(required)*: Application principal to associate with.
  - `--name <text>`: What the Command Center calls this person (at most 80 characters), in place of the principal id. Binding the same sender to the same principal again with another `--name` renames them; a name is the person's, so it is written to every binding of that principal in the workspace. The canvas's **Allowed people** form has the same optional **Display name** field, sent as IPC `channels { action: "allow", …, name? }`.
  - `--trust-unverified <yes|no>`: On a channel that checks each message's sender itself (email), admit this person's messages that fail that check (`yes`), or hold them again (`no`); the same as *Trust this person's unverified messages* in Allowed people, and its **Stop trusting unverified**. Anyone can then send as them, and an unverified message never decides an approval.
  - `--approved-by <text>`: Audit identifier of approving operator (default: `operator`).
- `unbind`: Remove an identity mapping.
  - `--connection <id>` *(required)*, `--sender <id>` *(required)*.
- `list`: List all identity bindings configured in the workspace. Text output is one tab-separated line per binding: connection, sender, principal, approved by, and display name (`-` when none).

#### Options
- `--workspace <id>`: Workspace to act in (default: `default`).
- `--format <text|json>`: Output format (default: `text`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).
- `bind`'s and `unbind`'s own options are listed under each above.

---

### `tavi channels`

Configure the channels' connections from a terminal: the same IPC `channels` command Settings → Channels uses ([CHANNELS.md](CHANNELS.md)). With `tavi serve` running it goes to the live owner and applies at once; otherwise it works on the data directory, and the owner opens what was saved at its next start (a test send and the webhook listener need a running owner, exit 4). Offline it knows the channels of enabled plugins from their approved manifests, running none of their code.

```bash
tavi channels <action> [options]
```

#### Actions
- `list`: The workspace's connections, one tab-separated line each: connection id, channel, name, account, state (`disabled` for one turned off), and the status detail; then the webhook listener's port and public address.
- `types`: Every installed channel, with its settings (`--<key>`, or `--set <key>=<value>` for a key that is also one of `channels`' own flags, such as Gmail's `label`), a choice's values and its default (Mailgun's `--region` reads `Region: us, eu (default us)`: `eu` for a domain in Mailgun's EU region, reached at `api.eu.mailgun.net`; only those two) and secrets (`--secret-file <key>=<path>`). `add` refuses such a key given as a flag and names the `--set` form.
- `add <provider>`: Add a connection. Settings are given as `--<key> <value>`, by the keys `types` lists (a number or a `yes`/`no` where the setting is one); secrets as `--secret-file <key>=<path>`, read from the file and stored in the credential store. `--name <text>` names it; `--disabled` saves it without opening it (an enabled connection needs every secret). Prints the new connection id.
- `set <connection>`: Change a connection's settings (`--<key> <value>`, an empty value clearing one) or `--name`; the rest stay as they are. `--set <key>=<value>` (repeatable, also on `add`) gives a setting whose key is one of this command's own options. A setting an earlier version kept that the channel no longer declares is dropped on the next change.
- `secret <connection> <key> --file <path>`: Store one of its secrets.
- `enable <connection>` / `disable <connection>`: Open or close it; a disabled connection keeps its settings and secrets.
- `remove <connection> [--yes]` (alias `rm`, `delete`): Close it, delete its secrets and revoke the people allowed on it; its history stays — except on a channel whose descriptor says it purges on removal (Telegram, and the group channels whose platform terms require it, [CHANNELS.md](CHANNELS.md#removal-and-purge)). There it first prints what will go — its conversations, messages and files, and the chat notes its chats taught — with a `tavi tasks history <task> export` line for each conversation, and removes nothing until it is run again with `--yes`; 24 hours after the removal all of it is erased, unless the same platform account is added back before then. Disable a connection instead to keep everything.
- `test <connection> --to <target> [--text <text>]`: Send a short message to a target, as its channel names one, then print what setting the connection up still asks, as its channel says: a warning, or a link such as Discord's invite (only to a host the channel declares). Exit 4 when it was not accepted.
- `ingress --port <port> [--public-url <url>] [--trusted-proxies <list>]`: Where the webhook listener listens, and the https address in front of it (empty to clear). `--trusted-proxies` names the reverse proxies on other machines whose `X-Forwarded-For` the listener believes, comma-separated IP addresses or CIDR ranges (`192.0.2.10,10.0.0.0/8`); a request from one of them is counted toward the failure limit under the last `X-Forwarded-For` entry, the one that proxy added, as one from a proxy on loopback always is. Left out, the saved list stays; empty clears it; anything that is neither an address nor a range is refused (`INVALID_INPUT`). The list is the owner's, like the port, applies to channel deliveries and schedule webhooks alike, and is shown by `channels list`.
- `connect <connection>`: Sign a connection in with its provider (OAuth), as **Connect with …** does: it prints the address to open in a browser and waits (up to 10 minutes) for the sign-in. The provider's redirect comes back to a listener this command opens on `127.0.0.1` — on the OAuth app's saved port when the channel takes one exact address — or through the public address for a channel that signs in there. Needs a running owner and encrypted credentials.
- `disconnect <connection>`: Sign it out at the provider and delete its token; it stays closed until connected again.
- `people [<connection>]`: The people allowed to start conversations in the workspace (or on `<connection>`, by connection id or provider id when the workspace has one connection of it), one tab-separated line each: connection id, sender id, principal id, display name (when set), and `trust-unverified` when set.
- `link [<connection>] [--principal <id>] [--name <text>] [--trust-unverified] [--yes]` (alias `pair`): Link a person with a 10-minute one-time pairing code (`XXXX-XXXX`) on `<connection>` (defaulting to the workspace's single connection when omitted, or resolved by provider id such as `telegram` when the workspace has one connection of it). Prints the code with its local expiry time (`Code: 4KX9-QM2P (valid until 10:10, once)`), the `/link <code>` command, and on Telegram the bot's `@username` and `https://t.me/<bot>?start=XXXX-XXXX` deep link, waits for a message carrying the code, and asks to confirm the sender who claimed it (*A message from … carried the code. Allow them as <name or principal>? [y/N]*, the question Settings → Allowed people asks about someone else; or confirms immediately with `--yes`). `--principal` defaults to the workspace's operator; `--name` sets their display name (otherwise falling back to the sender's platform display name when reported, such as Telegram's `First Last (@username)`). Needs a running owner (`tavi serve`, exit 4 without one).
- `unlink [<connection>] <sender>` (alias `revoke`, or `--sender <id>`): Revoke an allowed person's access on `<connection>` so new incoming messages from them are held again (turns already running are not cancelled). Works on the live owner when `tavi serve` runs, or directly on the data directory when stopped.
- `rooms <connection> [list]`: A group channel's rooms ([CHANNELS.md](CHANNELS.md#rooms)), one tab-separated line each: room id, your name for it, its trigger in words, who it hears (`bound` or `operator-only`), `threads` when it answers in threads, `reads recent` when it reads its recent messages, `paused`, `last send refused: …` when its last message was refused, and `introduction not sent` or `introduction may not have been sent`; then each room waiting to be added (the agent was added to it, or it spoke while nobody listed it), and how many messages its room policy dropped in this run, by reason. A channel without rooms is refused (exit 2).
- `rooms <connection> add <id> [--label <text>] [--trigger <kinds>] [--members bound|operator-only] [--auto-thread on|off]`: Listen in a room, by its id on the platform. `--trigger` is what addresses the agent there, comma-separated from `mention`, `reply`, `thread`, `command` and `picked` (only those the channel reports; default: the channel's own); `--members bound` (default) hears anyone you allowed, `operator-only` you alone. `--auto-thread on` answers each message that addresses the agent in a thread opened from that message, and that thread is the conversation from then on. The room then hears `thread` as well, whatever its trigger. Only a channel that can open threads takes it, such as Discord; it is off by default. The room gets one short introduction: whose agent this is, what addresses it there, that it never learns from the room for your private use, that it never reads people Tavi does not know, and to ask you to be left out. A room removed and added again is introduced again. Two connections cannot share a room. Needs a running owner with the connection open; an introduction that did not go out is said on stderr, and the room is listed all the same. Listing the rooms with the connection open tries a refused introduction again, except in a paused room (never one that may have gone out); the listing marks a room "introduction not sent" or "introduction may not have been sent".
- `rooms <connection> set <id>`: Change a room's `--label`, `--trigger`, `--members`, `--auto-thread` or `--context recent|off` (whether a message that addresses the agent there is read with up to 20 of the room's messages before it, as quoted data: anyone Tavi does not know left out, the room told when it starts; a channel that can read a room's recent messages) (a new `--trigger` needs a running owner with the connection open, to check it against the channel).
- `rooms <connection> remove <id>` (alias `rm`, `delete`): Stop listening in a room; its messages are then dropped, or admitted as before on a channel that still admits rooms nobody listed.
- `rooms <connection> leave <id>`: Leave a room the agent was added to, on a channel that can, and stop listening in it. Needs a running owner with the connection open.
- `grant <connection> room|contact <id> <tool> allow|deny [--expires <time>]`: An operator's grant of one tool on a connection ([CHANNELS.md](CHANNELS.md#rooms)). `deny` holds whatever else allows it, in a room (its threads too) or in one person's one-to-one chat. `allow` lifts a tool the messaging profile holds back (`sandbox.run`, `fs.write`, `fs.edit`, a credentialed `http.request`, `plugins.validate`) for one person in their one-to-one chat only, where it is still asked about. A room is never allowed a tool. A contact is named by their sender id, as a binding names them. A grant for the same scope and tool replaces the earlier one. Prints the connection's grants.
- `grants <connection> [list]`: The connection's grants: id, scope, tool, mode, and `revoked` or `expired` for one no longer in force.
- `grants <connection> revoke <grant-id>`: Revoke a grant; it no longer applies from its chat's next turn.
- `share-client <provider> <plugin>|off`: Lets a channel plugin whose reviewed descriptor asks for it (`app.provider`) sign in with the OAuth client `<provider>`'s apps share, or (`off`) takes that back. It binds the plugin's approved version (an update is bound again), and only a channel that signs in at the provider's own addresses (those this build's channel of it uses) is bound (`CONFLICT` otherwise), since the client's secret goes to its token address. The connections of the channels gaining or losing the client are signed out first, to be connected again; the binding is kept for the next start. A plugin with no installed channel asking for that provider is refused (`NOT_FOUND`).
- `forget-sender <connection> <sender> --yes`: A person's deletion request ([CHANNELS.md](CHANNELS.md#removal-and-purge)): erases their messages on the connection (admitted and held), the files those carried, their binding and contact grants, and the notes and memory their own chats taught, and takes their words out of other people's stored messages that quote them (`quoted`) (it needs a running owner, exit 4 without one); then prints each conversation they spoke or were quoted in, whose saved turns still hold their words, with the `tavi tasks history <task> forget` line that erases them. Without `--yes` it says what it will do and changes nothing (exit 2).

#### Options
- `--<key> <value>`: `add`/`set`: a setting, by the keys `types` lists.
- `--name <text>`: `add`/`set`: the connection's own name; `link`/`pair`: the person's display name.
- `--principal <id>`: `link`/`pair`: person ID to bind (default: the workspace operator).
- `--sender <id>`: `unlink`/`revoke`: the sender ID to revoke.
- `--trust-unverified`: `link`/`pair`: admit unverified messages on a per-message channel (email).
- `--disabled`: `add`: save it without opening it.
- `--secret-file <key>=<path>`: `add`: a secret, read from a file (repeatable).
- `--set <key>=<value>`: `add`/`set`: a setting, for one whose key is also an option here (repeatable).
- `--file <path>`: `secret`: the file the secret is read from.
- `--to <target>`: `test`: who to send to, as the channel names one.
- `--text <text>`: `test`: the message (default: a short test line).
- `--yes`: `remove`: erase what it brought in, on a channel that does, without asking; `link`/`pair`: confirm the sender who claims the code without asking; `forget-sender`: go ahead.
- `--port <port>`: `ingress`: the local port (1024-65535; one outside it is refused as such, exit 2).
- `--public-url <url>`: `ingress`: the https address in front of it.
- `--trusted-proxies <list>`: `ingress`: reverse proxies, besides one on this machine, whose `X-Forwarded-For` names the caller: IPs or CIDR ranges, comma-separated (empty to clear; left out, the list stays).
- `--label <text>`: `rooms add`/`set`: your name for the room.
- `--trigger <kinds>`: `rooms add`/`set`: what addresses the agent there, comma-separated: `mention`, `reply`, `thread`, `command`, `picked` (default: the channel's own).
- `--members <who>`: `rooms add`/`set`: `bound` (anyone you allowed, the default) or `operator-only`.
- `--auto-thread <on|off>`: `rooms add`/`set`: answer each message in a thread opened from it (a channel that can; default off).
- `--context <recent|off>`: `rooms set`: also read up to 20 of the room's messages before one that addresses the agent (a channel that can; default off).
- `--expires <time>`: `grant`: when it stops (an ISO time).
- `--workspace <id>`: Workspace to act in (default: `default`).
- `--format <text|json>`: Output format (default: `text`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

A setting the channel does not have, a value of the wrong form, or a missing secret is refused with exit 2, naming it. A connection named by `tavi serve` flags is not changed here: change the flags.

---

### `tavi artifacts`

Review and decide the files tools held back for review: a browser screenshot or download, and a chat's file that a rule-allowed `browser.act` upload or `messaging.send_to` sends by `path`. The files `sandbox.run` writes stay in the chat's working folder. When a task executes a tool that generates an artifact, the artifact enters `pending` review and the task suspends. The model is barred from viewing pending content until an operator approves it.

```bash
tavi artifacts <action> [options]
```

#### Actions
- `list [--limit <n>]`: List artifacts awaiting review.
- `approve <artifact-id> [options]`: Approve an artifact.
- `reject <artifact-id> [options]`: Reject an artifact.

#### Options
- `--reviewed-by <text>`: Operator name for audit log (default: `operator`).
- `--limit <n>`: Max rows for `list` (default: 50).
- `--workspace <id>`: Workspace scope (default: `default`).
- `--format <text|json>`: Output format (default: `text`).
- `--data-dir <path>`: Custom data directory path.
- `--resume` (`approve`/`reject` only): Also re-admit the task waiting on this artifact and report its outcome (default: record the decision only); it takes `--connection`, `--model`, `--api-key-file` and `--operation-key` (see below).

#### Copies into the chat's folder
- **Where copies go.** An approved browser download is copied into `downloads/` in its chat's managed folder (`<data-dir>/chats/<workspace>/<task-id>/downloads/`; a worker's goes to its root chat's), and a `reports.generate` PDF or a routine's published PDF report — stored approved — into `reports/` at once (a routine's once its publication commits, into its fire's folder, as `routine-report-<YYYY-MM-DD>.pdf`).
- **What is copied.** Every approval path copies: `approve` offline and under an owner (`review` over IPC, from `tavi chat` or the canvas), `--resume`, and a schedule's tool policy. A `pending` or `rejected` artifact is never copied, nor any other kind of artifact (screenshots, archived tool output, inbound channel media), and never into a host folder.
- **The file's name** is the one the page suggested (or `brief-<start>-to-<end>.pdf`), made safe: its last path component, without control or format characters (bidi overrides and isolates, zero-width characters, U+FEFF), line or paragraph separators or path characters (`/`, `\`, `:`), leading dots or surrounding spaces, at most 128 bytes with the extension kept.
  - A taken name gets ` (2)`, ` (3)`, … within the same 128 bytes (the stem is cut, then a long extension), unless that file already holds the same bytes.
- **Retrying.** Approving an artifact again — `review` with it already approved, or `approve` offline, which still refuses the second decision — retries a copy that failed.
- **How it is written.** The copy is a new file (never a hard link), created `O_EXCL | O_NOFOLLOW` under a `downloads/` or `reports/` that must be a plain folder, checked again just before and after each open: a link planted there is refused and nothing is written.
  - Residual: Node has no `openat`, so a folder swapped for a link between that last check and the open can leave an empty file at the link's target; nothing is written to it.
- A copy that fails never undoes the approval; `approve` says so on stderr, the owner logs it.

#### Resuming the Suspended Task (`--resume`)
By default, `approve` and `reject` only record the review decision in storage, leaving the suspended task paused. Passing `--resume` records the decision, re-admits the waiting task, streams its subsequent execution turn, and exits with the corresponding task code:

```bash
tavi artifacts approve art-456 \
  --resume \
  --connection openai \
  --model gpt-4.1-mini \
  --api-key-file /path/to/key
```

When `--resume` is used:
- `--connection <id>` *(required)*
- `--model <id>` *(required)*
- `--api-key-file <path>`: Credential file path.
- `--operation-key <key>`: Idempotency key for the resumed admission. Without it the acknowledgement is keyed on the review suspension it answers, so two front ends acknowledging one suspension converge on one admission; with it, a retry under the same key replays its first acknowledgement.

#### Under a live owner
While `tavi serve` owns the directory, `approve`/`reject` are decided on it over IPC (`review`), under the artifact's own task, and print the decided artifact's record as offline; `list` runs over IPC too, with the offline output. With `--resume` the resumed turn is followed to its end — only that turn, from where the owner's stream stood when it admitted it — with the same exit codes. `--connection`/`--model`, still required with `--resume`, must then name the target the owner runs (another is refused, exit `2`, before anything is written); `--api-key-file` and `--operation-key` are refused with `--resume` (exit `2`), since the owner resumes with its own credentials under the suspension's own key — a plain decision ignores them, as offline. An artifact already decided the same way is answered as decided (exit `0`), where the offline command refuses a second decision (exit `2`); decided the other way it is a refused decision (exit `4`). A `--resume` with nothing to resume still records the decision and exits `8`, as offline.

---

### `tavi approvals`

Answer the approvals a task is suspended on. A task that raises one stays
suspended until a decision is recorded — by an attached client, a run's
`--approval` policy, a schedule's tool policy, or this command, which is how an
operator records it. (`tavi run` in a non-interactive shell exits `3`
instead — a daemon has no caller to hand that code to, which is why this surface
exists.)

```bash
tavi approvals <action> [options]
```

#### Actions
- `list [--limit <n>]`: List approvals awaiting a decision, oldest first, in the workspace. A round whose chat read content Tavi does not trust says where under its line (`⚠ after reading news.example — once only`); the owner's answer carries it as each row's `provenance`, with the round's `label`.
- `history [--kind approval|review|question] [--state <states>] [--since <time>] [--until <time>] [--tool <tool-id>] [--principal <id>] [--cursor <cursor>] [--limit <n>]`: Decisions made before, newest first: approvals (granted, denied, expired, cancelled — by whom, through which channel, with what scope, and the rule an `always` grant created), artifact reviews and answered questions (by whom and through which channel, for a question answered since this was recorded). `--kind` and `--state` take comma-separated lists; `--since`/`--until` take an ISO date or time (a date alone covers that whole UTC day); `--tool` keeps approvals of that tool only (reviews and questions name no tool, so they are left out); `--principal` keeps decisions on that person's tasks; `--limit` is at most 100 (default 50). Text output is one tab-separated line per decision, then `(more: --cursor <cursor>)` when more remain: pass that `--cursor` with the same filters for the next page. `--format json` prints `{ items, nextCursor? }` as IPC `approvals history` answers it. Under a live owner it is answered over IPC, in the same text or JSON form; without one, a channel is named by its connection's recorded channel, with that channel's label (`Telegram`, `Email`), as the owner names its own.
- `needs [--limit <n>] [--format json]` (also `tavi needs`): Everything waiting on you, as one queue — open questions (with their options), pending approvals and reviews — the soonest deadline first, two lines each: what it asks (`?` a question with its numbered options, `!` an approval, `◆` a review), then, indented, its chat (title and task id), when it stops waiting, and the command that answers it (`tavi answer <task-id> <answer>`, `tavi approvals approve <task-id>`). `--format json` prints `{ needs, truncated }` as IPC `approvals needs` answers it. Under a live owner it is answered over IPC; without one, the directory is read directly.
- `answer <task-id> --answer <text> [--wait <wait-id>]` (also `tavi answer <task-id> <text…>`, where the words up to the first option are the answer): Answer the task's open question from the terminal, whichever channel it started from. The answer is read against the question's options as a typed chat answer is (a number or label, several comma-separated for a multi-select, or your own words where allowed). It needs a running owner, which resumes the task: without one it exits 4. A question already answered, or not the `--wait` given, is refused.
- `approve <task-id> [--scope once|session|always] [--call <call-id>] [--decided-by <name>]`: Grant the task's pending calls, and resume it. `--scope` is `once` (default), `session` (a grant for the rest of this chat — in Home or a messaging chat: a day, or until it rolls over) or `always` (a workspace allow rule matching exactly what the round showed), applied only where every call of the round offers it — see [`tavi permissions`](#tavi-permissions).
- `reject <task-id> [--note <reason>] [--call <call-id>] [--decided-by <name>]`: Deny them, and resume it. `--note` is the reason the task's model reads (there is no `--reason`); the decision's attribution is `--decided-by`.
- `show <task-id>`: The task's rounds — with their token, and the conversation and expiry of one sent to a chat (`-:-` for one that was not) — and their audit trail — announced, decided (by whom, via what, with what scope), refused, expired, notified (the outcome shown in the chat), grants and rules created, and each call's result (`tool_result`) — then every call the task asked about, with its full input.

#### Options
- `--call <call-id>` (`approve`/`reject` only): Names the effect-ledger call the decision answers. It asserts the round's only pending call: a round with more than one call is refused with `--call` (exit `2`; decide it whole), and a call the task is not waiting on is refused rather than silently applied (exit `8`).
- `--decided-by <name>`: The audit identity (default: `operator`); it is *recorded*, never used as the admission principal.
- `--workspace <id>`, `--data-dir <path>`, `--format <text|json>`, `-h, --help`.
- `--connection`/`--model`/`--api-key-file`: the resume's model target.
- `--operation-key <key>`: the resume's idempotency key. Without it the decision is keyed on the round it decides, so a decision from here and one from any other front end (chat, a client) converge on one admission. With it, a retry under the same key replays its first decision (or is refused if the round has moved on) — it never decides a round the first invocation surfaced. Either way the decision carries its round as a precondition: a round another front end decided first is refused (exit `4`), never applied to whatever is pending next.
- `--scope`, `--note`, `--answer`, `--wait`, `--limit` and `history`'s filters (`--kind`, `--state`, `--since`, `--until`, `--tool`, `--principal`, `--cursor`) belong to one action each, and are described with it above.

**From chat:** a message that is exactly `approve` or `reject` — optionally
followed by a task id — answers the pending approval of *that conversation's* own
task, so an operator does not have to carry an id through a chat. The decision is
recorded under the task's own principal and workspace, and the sender must be that
principal (a workspace match alone would let any sender bound in the workspace
decide someone else's task). Only a `waiting`, uncancelled task is resumed: a
completed task holding a stale pending row, or a cancelled one, is told so rather
than reporting a decision that did nothing. A message that would answer an active question to the operator is left
for that question — `approve` is a plausible answer to "shall I approve this?".
Otherwise the command is acknowledged in the conversation, or answered rather than
admitted as a model turn when there is nothing to decide.

#### Under a live owner
While `tavi serve` owns the directory, every action is the owner's over IPC. `approve`/`reject` decide the pending round on it and follow the resumed turn to its end — only that turn, from where the owner's stream stood when it admitted it — with the offline command's exit codes: `0`, `1`, `3` for the next round (reported, not asked, even on a terminal), `6`, `7`, and `8` when nothing is pending. `--connection`/`--model` only assert the target the owner runs (another is refused, exit `2`, deciding nothing); `--api-key-file` and `--operation-key` are refused (exit `2`): the owner resumes with its own credentials, and keys a decision by its round. An owner with no configured model refuses the decision (`NOT_CONFIGURED`, exit `2`) rather than fail the task in its model call. When the owner's answer is lost (a timeout, or the connection closing first), the decision may still have been admitted: check `tavi approvals list` or `tavi run --attach <task-id>` before deciding again, since a new decision applies to whatever round is pending then.

---

### `tavi needs`

Everything waiting on you, as one queue: open questions (with their options and deadline), pending approvals and reviews, soonest deadline first. Each is three lines: what it asks; its chat and when it stops waiting, indented; and the command that answers it, indented on a line of its own. The same as [`tavi approvals needs`](#tavi-approvals).

```bash
tavi needs [--limit <n>] [--format text|json] [--workspace <id>] [--data-dir <path>]
```

#### Options
- `--limit <n>`: Max rows (default: 50).
- `--format <text|json>`: Output format (default: `text`).
- `--workspace <id>`: Workspace (default: `default`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

### `tavi answer`

Answers the task's open question, whichever channel it started from: an option's number or label (several, comma-separated, for a multi-select), or your own words where the question allows them. Needs a running owner. The same as [`tavi approvals answer <task-id> --answer <text>`](#tavi-approvals).

```bash
tavi answer <task-id> <answer> [--wait <wait-id>] [--format text|json] [--workspace <id>] [--data-dir <path>]
```

#### Options
- `--wait <wait-id>`: Asserts it is the question still open.
- `--format <text|json>`: Output format (default: `text`).
- `--workspace <id>`: Workspace (default: `default`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

---

### `tavi permissions`

The rules that decide a tool call before any approval round, and the session
grants approvals created. A call is checked against the
hard-deny list, which nothing lifts, then the workspace's deny, ask and allow
rules (deny wins), then chat grants, then the gated effects. A `critical`
call is asked even when a rule or grant allows it, and a call an `ask` rule
matches is decided `once` only. Rules are *shipped* (a reply into the task's
own conversation and a question to the operator are allowed; the messaging
profile denies `sandbox.run`, `fs.write`, `fs.edit` and credentialed
`http.request` to chat-started tasks), *flag* rules from `serve --allow`, or
*operator* rules stored here or by an `always` approval. Every configured
workspace is seeded once, when a runtime is composed for it (with or without
the reminder sweep), with the operator rule `seeded-reminders` (allow
`reminders.*`); remove it to be asked for each reminder, and it is not
seeded again. Under a live owner
every action runs there, over IPC; otherwise on the data directory.

```bash
tavi permissions <action> [options]
```

#### Actions
- `list`: Every rule in force — shipped, `serve --allow`, stored — under a `RULE  DECISION  TOOL  SOURCE` header, in padded columns, with each rule's note indented on the lines below it. The source reads `shipped with tavi`, `serve --allow` or `yours` (`, all workspaces` for one of yours that holds in every workspace); `--format json` gives the rules as stored.
- `add --tool <pattern> --decision <allow|ask|deny> [--match <glob>] [--note <text>] [--match-unparsed]`: Store an operator rule. `<pattern>` is a tool id or a dotted glob (`browser.*`); `--match` (1–512 characters) is a glob over what the call does — a shell command, `POST https://…`, a destination — with `*` and `?` as wildcards and `\` to escape them; `--note` is 1–500 characters. An allow rule for every tool (`--tool '*'` with no `--match`) is refused. A deny or ask rule for `sandbox.run` also matches a command's other spellings (`env curl`, `/usr/bin/curl`, `timeout 5 curl` as `curl`); an allow rule matches only as written, and never covers a line no rule can read (`$(…)`, `eval`, a here-document) unless it is stored with `--match-unparsed` (allow only). An allow glob that starts with `*` is stored with a warning that it matches more than it reads as.
- `rm <rule-id>` (alias `remove`, `delete`): Remove a stored rule, and name it as `add` does (`removed rule-…: ask browser.*`). A shipped rule is refused (override it with a deny or ask rule), as is a `serve --allow` rule (restart without the flag).
- `grants [--task <task-id>]`: Chat grants — what an approval with scope `session` allowed for the rest of its chat. A grant in a Home or a messaging chat carries `expiresAt` (a day after it was made) and ends at the chat's next epoch (its workers' grants with it) or a `/new`, whichever comes first; the listing prints `until <time>`. Each grant names its chat by title, `chat "<title>" (<task-id>)` (`task <task-id>` for a chat with no title yet); the JSON carries it as `taskTitle`. One made there before ends existed is listed with — and lapses at — a day after it was made; a lapsed grant is not listed, and `tavi serve` deletes lapsed grants at start and hourly.
- `revoke <grant-id>`: Drop a chat grant.
- `taint [off|observe|enforce]`: Show or set the workspace's `security.taint` — the same setting and output as `tavi config get|set security.taint` (see [`tavi config`](#tavi-config)). `enforce` asks once before a call made after untrusted content that could send data out, use a credential or outlast the chat; `enforce` is the default; `observe` decides as if the taint step were absent and records what it would have asked, which `tavi doctor` reports under `taint`; `off` does neither and is deprecated. `tavi serve` (at start) and `tavi doctor` warn while a workspace has `observe` or `off`. A live owner's `serve --taint-policy` overrides it until the owner restarts without it, and the line says so. Any other mode, or more than one, is a usage error (exit `2`).

#### Options
- `--workspace <id>` (default `default`), `--format <text|json>`, `--data-dir <path>`, `-h, --help`.

Through the `tavi ui` bridge (the canvas's Settings → Permissions), `add` and the removal of a deny or ask rule are refused `NOT_AUTHORIZED`: either would widen what runs unasked. The canvas lists, revokes grants and removes allow rules only, and shows `security.taint` under *Untrusted content*, where it can only raise it: a write that lowers it is refused `NOT_AUTHORIZED` (use `tavi permissions taint`).

---

### `tavi credentials`

Manage the local credential store at `<data-dir>/credentials`, one `0600` file
per reference. No action here prints a credential's value, and none of it is
reachable from the agent: only you write credentials. Under a live
`tavi serve` every action runs on the owner over IPC (see "Configuration under a
live owner").

```bash
tavi credentials <action> [options]
```

#### Actions
- `set <ref> --file <path>`: Store the value read from a `0600` file (not a symlink).
- `list`: List configured references (names only). A file whose name is not a valid reference is reported as unusable rather than presented as configured; the store's in-progress write (`<ref>.tmp-<12 hex>`) is hidden.
- `delete <ref>` (alias `rm`, `remove`): Remove a reference. When model connections still name it, stderr lists them, with the way back (`tavi credentials set <ref>`, or `tavi models rebind`); over IPC the answer carries them as `namedBy`.
- `key [--to-file | --to-keychain | --to-systemd | --export]`: Say where the at-rest key is kept: in `credentials.key` itself, in the OS keychain it refers to (with the item's service and account), or in the systemd credential it refers to. `--to-file` moves the key out of the keychain into `credentials.key`: the same key, so nothing is re-encrypted; it is read from the keychain, written `0600` and flushed with a rename over the reference, read back, and only then is the keychain item deleted (an item that cannot be deleted is named on stderr, and the file is used either way). Use it before a backup that must restore on another machine, or for a service that cannot read the keychain (a system unit, a launchd daemon, a lingering user unit with a locked keyring). `--to-keychain` is the reverse: the key goes to a new keychain item, is read back, and `credentials.key` then refers to it; a keychain that refuses or is absent leaves the file as it was. A key already where it is asked to go is left alone. The key is never printed. It runs in this process, never on the owner (a service may be the process that cannot reach the keychain), and needs no stop: only `credentials.key` changes, replaced whole after checking it is unchanged, and either form yields the same key. `--format json` prints the result. It takes no reference.
  `--export` writes the key itself (hex) to standard output, for `systemd-creds encrypt` to take on its standard input; it refuses when standard output is a terminal (exit 2). `--to-systemd` makes the systemd credential `tavi-credential-key` the key's home on a headless Linux service (see [CONFIGURATION.md](CONFIGURATION.md#credentials)): it runs on the running owner, which alone reads `$CREDENTIALS_DIRECTORY`, and changes `credentials.key` into a reference only once the credential holds the same key (`CONFLICT` otherwise), reading the key back through it before a keychain item it left is deleted. `--to-file` from a systemd-kept key also runs on the owner. With no owner running both are refused (exit 69); a page is refused (`NOT_AUTHORIZED`). `--to-keychain` refuses a systemd-kept key: move it into the file first.
- `encrypt`: Encrypt every value at rest: AES-256-GCM with a fresh IV per value, bound to its reference (a file renamed to another reference does not decrypt), under a key in `<data-dir>/credentials.key` — created `0600` if absent (flushed to disk before any value is encrypted under it), used if present, never replaced. Where the OS keychain is available (the macOS Keychain, a libsecret Secret Service on Linux, or Windows Credential Manager), a new key goes there instead and `credentials.key` holds only a reference to it; the output then names the keychain. A new data directory gets such a key on its first open, so it is encrypted without running `encrypt` (see [CONFIGURATION.md](CONFIGURATION.md#credentials)). Each value is rewritten through a temporary file and a rename, so an interrupted run leaves every file readable, and a second run changes nothing. It removes the temporary files an interrupted write left (each holds a plain value), and says what it did not encrypt: a file that is no reference, a dotfile, and a value that looks encrypted but does not decrypt with this key (another directory's, or altered). Afterwards every new value is written encrypted; plain files are still read, so a plain file put back beside the ciphertext is used as it is. It takes no reference.

#### Options
- `--file <path>`: Source file for `set` (`0600`, not a symlink).
- `--to-file`: `key`: move the key into `credentials.key`.
- `--to-keychain`: `key`: move the key into the OS keychain.
- `--to-systemd`: `key`: move the key to the systemd credential `tavi-credential-key`, on the running service.
- `--export`: `key`: write the key to standard output, for `systemd-creds encrypt` (never to a terminal).
- `--format <text|json>`: Output format for `list`, `encrypt` and `key` (default: `text`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

What it buys is narrow, and stated: a copy of `credentials/` without the key — `tavi backup --include-credentials` makes one, and does not carry the key — does not yield the values. It still shows which references exist and roughly how long each value is, and a backup taken before `encrypt` stays plain. A process running as the operator reads both the files and the key, and is outside the threat model either way; the model's sandbox is denied the key as it is denied the credentials. Keep the key apart from any copy of the credentials: without it they cannot be read. The key file gets the checks a credential file gets — a symlink, or one other accounts can read, is refused, on the file actually read — and one of the wrong length is refused naming the file (`UNAVAILABLE`), never regenerated, since a new key cannot read what the old one wrote. A value in a format this build does not read (a later tavi's) is refused, never sent as a plain key; a file holding ciphertext is refused as the source of a value (`set --file`, `--credential-file`, a launcher's binding).

A missing action is a usage error (exit `2`), not a success — the rule holds for every family that takes one. Run `tavi credentials --help` for this page.

---

### `tavi reports`

Inspect a daily-brief PDF the agent stored (with `reports.generate`). A brief is
kept as a stored file (an artifact), never handed back to the model: even a
short one is past the 64 KiB a tool result may carry, so these commands are how
you read it.

```bash
tavi reports <action> <artifact-id> [options]
```

#### Actions
- `show <artifact-id>`: Print the artifact's metadata (never its body).
- `open <artifact-id> --out <path>`: Write the PDF to a path and print where it went.
- `list [--limit <n>] [--workspace <id>] [--from <yyyy-mm-dd>] [--to <yyyy-mm-dd>]`: The reporting history, newest first, under a header — period, generation time (UTC, to the minute), size, and how many projects/metrics it recorded, with each brief's artifact id on the line under it. The window is the same one `trends` takes, resolved against the *period* rather than the generation time. A row that cannot be read is named on stderr rather than dropped.
- `trends [--project <id>] [--metric <key>] [--from <yyyy-mm-dd>] [--to <yyyy-mm-dd>] [--limit <n>]`: One series per project and metric (so a delta never compares a `count` with a `usd`), chronological, with the change and percent change from the previous period and the overall change. Points are ordered by *period*, not generation time, so a backfilled brief does not invert the axis. When two briefs cover the same period — a re-run, a backfill — the most recently *generated* one is the point, so a correcting re-run's numbers are the ones plotted. A change that spans a missing period is flagged `gap`, and a percent change from a zero baseline or across a sign change is reported as unknown with the reason rather than as a number. The window goes into the query — `--limit` means the newest N *within* the window — and a window that matches nothing says so rather than printing an empty series.

#### Options
- `--out <path>`: Destination file for `open`.
- `--limit <n>`: `list`/`trends`: how many recent reports to read (default 12, max 52).
- `--workspace <id>`: `list`/`trends`: workspace (default: `default`).
- `--project <id>`: `trends`: limit the series to one project.
- `--metric <key>`: `trends`: limit the series to one metric key.
- `--from <yyyy-mm-dd>`: `list`/`trends`: earliest period start to include.
- `--to <yyyy-mm-dd>`: `list`/`trends`: latest period end to include.
- `--format <text|json>`: Output format (default: `text`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

A missing action is a usage error (exit `2`), like every other family. `list`
and `trends` run on a live owner too; `show` and `open` read the data directory
themselves and refuse while `tavi serve` owns it (exit `5`). The same
numbers are available to the model as the `reports.history` tool, which takes the
same `from`/`to` window.

A `--from`/`--to` that is date-*shaped* but names no day (`2026-02-31`), or a
window whose ends are the wrong way round, is a usage error on both the command
and the tool: either one matches nothing for a reason that has nothing to do with
the data, and answering "no recorded report" would report a typo as an absence.

---

### `tavi schedules`

Under a live `tavi serve` every action runs on the owner: `run-now` fires on its scheduler and follows the run (Ctrl-C detaches), with the owner's credentials (`--api-key-file` is refused) and target (`--connection`/`--model` must name it).

`add` and `update <id|name>` work offline or through the owner. Update accepts
the creation fields except `--name`; omitted fields stay unchanged. The times
(`--at`, `--every-hours` with `--between`) are replaced together when any is
given, and so are the days (`--days`, `--monthly`, `--yearly`, `--once`).
Update clears every day pattern with `--days none`, the end with `--until
none`, the agent with `--no-agent` and the alert target with `--no-alert`; IPC
clears them with `null` (`days`, `untilDate`, `between`; both alert fields
together), and the tool allowlist with `[]`. IPC `schedules add|update` take
the cadence as `at`, `times`, `everyHours`, `between: { from, to }`, `days`,
`monthly`, `yearly`, `once` and `untilDate` (the payload's `until` is the
agenda's window); `schedules.create`/`schedules.update` take `at`, `times`,
`everyHours`, `between` (`08:00-18:00`), `days`, `monthly` (`1`, `last:fri`),
`yearly` (`12-25`), `once` and `until`, and a routine's `daily` trigger takes
the same but `once`.

Author recurring unattended runs, and the tool policy each one executes under. A
schedule runs as the operator who created it, using their existing grants. Under
a live `tavi serve`, every action runs on the owner over IPC, and
`run-now` fires on its scheduler and follows the run (see "Configuration under a
live owner").

```bash
tavi schedules <action> [options]
```

#### Actions
- `add`: Create a schedule. Requires `--name`, `--at` (or `--every-hours`), `--timezone` and `--prompt`. The name is one line of text, with no tab, line break or other control character (`INVALID_INPUT` otherwise): `list` prints it in a tab-separated column.
- `watch <name> --page <https url> | --feed <https url> | --file <path>`: Create a watcher: an `add` of a schedule with the matching `--precheck` (`page-changed`, `feed-has-new` or `file-changed`), every `--every <n>h` (1h–12h, or minutes in whole hours; default every hour; under an hour is a usage error) through the day or `--between`, in `--timezone` (default: this machine's zone), marked a watcher. Requires `--prompt`; takes `add`'s other options but `--name`, `--at`, `--every-hours` and `--precheck`, which it sets. A check that finds nothing new makes no model call. A file watcher needs a running owner (its file is checked against its `--fs-root` folders); its run reads the file only when `--folder` names the file's folder (or one above it). While `tavi serve` runs, it is also checked about 30 s after its file changes, at most once a minute and 12 times an hour, recorded with the ledger reason `watch` and counted toward its failures (three in a row pause it); six runs in a row within an hour, each on a change, leave it to its cadence for an hour, told once. A chat's `schedules.update` cannot change a watcher's `precheck`. The record carries `watch: true`; `show` prints `watcher` with what it watches, and `list` and `add` print that sentence in place of the cadence. `update --watch off|on` stops a schedule being a watcher or makes one with a pre-check one again (IPC `schedules add|update` take `watch: boolean`; `true` needs a pre-check); removing the pre-check stops it being one. See [AUTOMATION.md](AUTOMATION.md).
- `list`: List schedules in the workspace. Text prints one line each: id, name, when it runs in the schedule's read-back words (`every Mon, Fri at 07:00 (Europe/Sofia)`), `enabled`, `disabled`, `finished` when its `--once` or `--until` date is past, or `paused:failures` when three failed fires in a row paused it, `next=` its next run in its own zone (`Wed 28 Oct 07:00`; `-` when paused or not armed), `failures=` its fires failed in a row, and `last=` its last outcome.
- `show <id|name>`: Show one schedule (`fires` in the read-back words, `next fire` in its zone, `last run` in the workspace zone (the last run that started, whatever started it), `running (fire due …)` while a fire is being handed to its run), including its effective policy and its ten most recent fires, newest first, one line each in the workspace zone: when it was due, why it ended so, its outcome and its task.
  - The reason is one of:
    - `ok`
    - `undelivered` (completed, sent nothing)
    - `quiet` (completed with nothing to tell, as its `--notify` allows)
    - `unchanged` (its `--precheck` found nothing new, so nothing ran)
    - `failed`
    - `timeout` (stopped at its `--max-run-minutes`)
    - `budget` (stopped past its `--max-tokens`)
    - `stopped` (a person stopped its run: not a failure, so nobody is alerted and it counts toward no pause, and what its pre-check found is kept as seen)
    - `waiting` (on a worker)
    - `asked` (a question)
    - `missed` (nothing ran at that time: the owner was not running, or it was too late to run)
    - `overlap` (the previous run was still going)
    - `disk` (refused on a nearly full disk; one line however many sweeps refused it)
    - `disabled` (its time has no next occurrence; a schedule that ended says `finished: … has no more runs`, after its last run, and is not alerted)
    - `orphaned` (started and never reported)
    - `manual` (`run-now`)
    - `webhook`
    - `webhook-refused`
    - `watch` (a file watcher's check after its file changed)
    - `email` (an email from a listed sender)
    - `email-refused`
    - `retry` (failed on a rate limit or retryable provider fault and tried again 2, 10 or 30 minutes later; not counted as a failure)
    - `paused` (paused after three failed fires in a row)
  - A run asked for now — `manual`, `webhook`, `watch`, `email` — keeps that reason however it ended; its outcome says how (`file-watch run: over budget: stopped after …`, `manual run: failed: …`), so search the outcome, not the reason, for such a run that went past its `--max-tokens` or timed out.
  - A retried try's reason reads `(retry N)`.
  - Its `state` says `paused after 3 failed runs in a row; resume it to run again` for a schedule its failures paused; `enable` resumes it and clears the reason and its failure count.
  - Each schedule keeps its last 100 fires and, apart from them, its last 24 `webhook-refused` and `email-refused` rows, removed with it; fires before this build are not listed.
  - `--format json` adds `timezone` and `recentFires` to the record, and IPC `schedules history` (`scheduleId`, `limit` 1–100, default 10) answers `{ scheduleId, name, timezone, fires }`.
- `remove <id|name>` (alias `rm`, `delete`): Delete it.
- `enable|disable <id|name>`: Arm or disarm it (disabling clears the next fire). Prints the id, name, new state and `next=` its next run in its zone (`-` once disabled); `add` and `update` print the same with its cadence after the name, offline or under an owner, then on stderr a note on what its `--allow` list covers and, with no alert target, that a failed or missed run is posted to your Home as a notice (only logged while Home is off).
- `run-now <id|name>`: Run it once, immediately, without disturbing the next scheduled fire (needs a model connection).
- `agenda`: Every upcoming occurrence of routine triggers, plain schedules and active reminders in the next `--days N` (1–31, default 7), at most `--limit N` (1–200, default 100), sorted by time; overdue fires the scheduler still owes come first, marked `overdue`. A cut list, and rows left out as unreadable, are noted on stderr. Text names the workspace zone once, then prints one line per occurrence in aligned columns — its time in that zone as `list` says one (`Tue 3 Nov 07:30`), kind (`to-do` for a to-do's due time, whose JSON item is a `reminder` with `todo: true`), title (with the routine trigger), cadence in the web app's words (a plain schedule's own: `Mon–Fri 07:30`, `Mon–Fri every 2 h 08:00–18:00`; a reminder's: `Mon–Fri 10:00, 15:00`, `Monthly on the 1st, 09:00`, `Once`, or an event's notice as `1 day before at 20:00 (event Thu 5 Nov 10:00)`; the zone left out when it is the workspace's), then its id; `--format json` prints the `schedules agenda` answer below. Runs on the owner when one serves the directory, offline otherwise.
- `webhook <id|name> on|off|rotate`: Let a call to `POST <public address>/hooks/schedules/<id>` on the webhook listener fire the schedule now (off by default). `on` (when it has none) and `rotate` print a new secret and signing key once; the secret is stored only as its SHA-256 and the signing key only encrypted with the credential key, made only while the credential store is encrypted (`tavi credentials encrypt`; without it only bearer calls are taken), and `on` for a webhook already on prints neither. A call sends `Authorization: Bearer <secret>`, or `X-Tavi-Timestamp` and `X-Tavi-Signature: sha256=<HMAC-SHA256 of "<timestamp>.<body>" keyed with the signing key>`; its body (at most 8 KiB) reaches the run as untrusted data, and the run starts tainted. At most one fire a minute and 12 an hour. `off` removes the route. `on` and `rotate` print the address to call: under the public address when one is set, else the listener's own `http://127.0.0.1:<port>/hooks/schedules/<id>` once `tavi channels ingress` has a port (reached only from this machine). `show` prints `webhook` as `on at <that address>` (`<path>` before the ingress is configured) with when its secret was made, or `off`; `--format json` adds `webhookUrl`. Under a live owner the listener opens or closes at once; offline, at the next `tavi serve`. See [AUTOMATION.md](AUTOMATION.md) and, for exposing the listener, [OPERATIONS.md](OPERATIONS.md#a-schedules-webhook).
- `email-trigger <id|name> on --connection <id> --from <addr|@domain>[,…] [--subject <text>]` and `email-trigger <id|name> off`: Let an email on an email connection of the schedule's workspace (Mailgun or Gmail; a channel that cannot authenticate each sender is refused) fire the schedule now (off by default).
  - Only from a listed sender (exact address, or `@domain` for that domain alone) whose domain the channel verified — it proves the domain, not the person, so an exact address relies on that domain's own mail servers — and with `--subject`, only when its subject holds that text (any case).
  - An `@domain` of a public mailbox domain (`@gmail.com`, `@outlook.com`, `@yahoo.com`, `@icloud.com`, `@proton.me` and a few more) is refused (`INVALID_INPUT`); an exact address there is allowed.
  - The run is tainted and **read-only**: no tool that changes, sends or fetches anything runs (`web_fetch`, `web_search` and MCP reads that reach a network included), whatever `--allow` says, besides its own delivery to its alert destination; its workers inherit that.
  - The email's subject and text (at most 8 KiB) reach it as a quoted-data message of their own, never in its prompt.
  - A matching email is the trigger's alone, never also a chat message, even when it is refused (rate limit, paused, in flight) or redelivered while its run starts; any other email flows as before.
  - At most one fire a minute and 12 an hour.
  - `show` prints `email` as what it listens for, or `off`. Under a live owner it applies at once; offline, at the next `tavi serve`.
  - See [AUTOMATION.md](AUTOMATION.md) and [SECURITY-MODEL.md](SECURITY-MODEL.md#a-schedules-email-trigger).

A fire **refuses to start** when the data directory's filesystem has less than
32 MiB free, and says so: the alert about a full disk goes through
`messaging.send`, whose outbox row is itself a database write, so a disk
discovered full at the moment of failure cannot announce its own failure. The fire
stays due and runs on the next sweep once space is freed; only past the 6 h
catch-up window does the ordinary missed-run policy take over.

#### Options
- `--at <HH:MM[,HH:MM]>`: Local wall-clock time, e.g. `07:00`, or up to six a day (`07:00,19:00`).
- `--every-hours <n>`, `--between <HH:MM-HH:MM>`: Every n hours (1–12) instead of `--at`, by the wall clock from 00:00, or through the window (both ends included). `--between` goes with `--every-hours`.
- `--monthly <day|nth:weekday>`, `--yearly <MM-DD>`, `--once <YYYY-MM-DD>`: Once a month (1–31, 31 a shorter month's last day; or `2:tue`, `last:fri`), once a year (`02-29` the 28th in a year without one), or only on that date, instead of `--days`. One day pattern at a time.
- `--until <YYYY-MM-DD|none>`: The last date it runs, inclusive (not with `--once`); `none` (update only) drops it. A schedule that ends finishes after its last run has settled (a provider failure is retried first): turned off, its ledger says so, nothing is alerted, and `enable` refuses it; an `update` that moves its `--once` or `--until` date later, or drops the until, turns it on again. A `--once` or `--until` date already past is refused.
- `--timezone <iana>`: IANA zone for `--at`, e.g. `Europe/Sofia`. A typo is refused as a usage error.
- `--allow <tool>`: A tool the schedule may call unattended (repeatable; exact id or `prefix.*` family). Omit to deny every tool. `*` is refused: it grants everything including `sandbox.run`. The list never approves a call the taint step asked about (the run read untrusted content, and the call would send data out, use a credential or persist), a tainted call of a tool that asks under taint, or a `critical` call: a fire denies those for every tool, and the run records the denial with its reason. An MCP tool is listed only by its exact id and only when it was approved `read-only`: `mcp.<name>.*`, a write and a tool not approved are refused, and a fire denies a listed MCP tool re-approved as a write since.
- `--days <0-6,...|none>`, `--missed <policy>`: Weekly mask and catch-up policy (`run-once-if-missed-within-6h` default, or `skip`). `--days none` (update only) makes it daily again. For `agenda`, `--days N` is the window in days instead.
- `--agent <id>`: Run as a named agent persona. `--no-agent` (update only) runs it on the base instructions again; it cannot be given with `--agent`.
- `--principal <id>`: Principal the run is admitted as (default: `operator`).
- `--alert-connection <id>`, `--alert-destination <id>`: Where a failed run reports. `--no-alert` (update only) clears both; it cannot be given with either.
- `--checkpoints <off|ask-with-default>`: Whether a fire may ask a question. Off by default.
  - With `ask-with-default`, a question must name its options and a default.
  - It is sent to the alert destination, headed `⏸ <schedule> asks:`, and decided 15 minutes before the next fire at the latest.
  - The fire records "asked a question" and returns. Once answered (anywhere) or defaulted, the task carries on under the schedule's `--allow` list, and its end is recorded as the fire's would be.
  - Refused without an alert destination, and so is clearing the alert of a schedule that asks.
  - `show` prints it as `questions`; IPC `schedules add|update` take it as `humanCheckpoints`.
- `--deliver-to <home|none>`: `home` posts each run's result into the schedule's person's Home as a notice when it settles (unset by default). Such a run has delivered: it is not alerted `run-undelivered` — unless the person has no Home or `chat.home` is off, when the fire reports as one with no such target. `none` clears it. A channel brief is still the run's own `messaging.send_to`. `show` prints `delivers`; IPC `schedules add|update` take `deliverTo: "home" | "none"`, and a schedule record carries `deliverTo: "home"` when set.
- `--max-run-minutes <n>`: How long a fire's run may work before it is stopped (1–1440; unset means 30). Past it, the run's task and workers are cancelled and its wait settled, the fire is recorded `failed` with the ledger reason `timeout` and alerted once, and the next fire runs as usual. Only working time counts — the run's turns and its workers' — not time the run or a worker waits (on a person's answer, a worker or a deadline), nor time the machine sleeps. `show` prints `run limit` (with `(the default)` when unset); IPC `schedules add|update` and `schedules.create`/`schedules.update` take `maxRunMinutes`, and a schedule record carries it when set. A fire skipped because the previous run is still going is alerted once per fire.
- `--max-tokens <n|off>`: How many tokens a fire's run, the workers it spawned included, may use before it is stopped (1000–100000000, `_` or `,` allowed between digits; unset means no ceiling, except that a run a webhook call or an email starts is stopped past 250,000 tokens, which `show` says). The tokens are model accounting's, counted as each model call ends, so a run can go past the ceiling by one call; a ceiling below one call's worth cannot hold, and `add`/`update` warn about one below 30,000 tokens (a run's first call alone takes about 25,000) and save it as asked. Past it, the run is stopped as at `--max-run-minutes`, recorded `failed` with the ledger reason `budget` and alerted once; the next fire runs as usual. `update --max-tokens off` removes it. `show` prints `tokens`; IPC `schedules add|update` and `schedules.create`/`schedules.update` take `maxTokens` (`null` removes it), and a schedule record carries it when set. IPC `schedules list` asked with `withUsage: true` (the Schedule page's Recurring list asks) also answers `scheduledWork`: the workspace's scheduled work this calendar month in its zone (`month`, `timezone`, `since`, `until`, `tokens`, `usd` or `null` when a call had no price sheet, and `budget` and `percent` when `scheduled.monthlyTokenBudget` is set).
- `--folder <path|off>`: The host folder each run works in, as a chat's primary folder (unset means each run's own folder; `update --folder off` removes it). It must be an absolute path under one of the owner's `--fs-root` folders: the running owner checks it when it is set and stores its real path (an offline write refuses `--folder`, "needs a running owner"), and each fire checks it again before its run starts, failing the fire, saying why, when it no longer passes. The run and its workers read and write there. Give a file watcher its file's folder, so its run can read the file. `show` prints `folder`; IPC `schedules add|update` take `folder` (`null` removes it), a schedule record carries it when set, and a chat's `schedules.create`/`schedules.update` never set it.
- `--notify <always|when-sent|if-changed>`: When a run that went well tells its person (unset means `always`, as before). `when-sent`: a run that attempted no `messaging.send_to` (while the schedule allows one) or ended with exactly `[nothing to report]` is a quiet success — ledger reason `quiet`, nothing posted to Home, no alert; a send the connector refused is still `undelivered`. `if-changed`: a result whose normalised words hash the same as the last one delivered is not posted to Home again, nor sent again as a `messaging.send_to` text to the alert destination (the call answers `status: "unchanged"`), and the fire is `quiet`. Failures are always alerted. `show` prints `notifies`; IPC `schedules add|update` and `schedules.create`/`schedules.update` take `notify`, and a schedule record carries `notify` (and, once an `if-changed` schedule delivered, `lastDeliveredHash`) when set.
- `--precheck <check|none>`: A read-only look before each scheduled fire (unset means none; `update --precheck none` removes it, and `add` refuses `none`). `page-changed:<https url>`, `feed-has-new:<https url>` or `file-changed:<path>` (a space works in place of the colon).
  - A page or feed address is https with a named host, no port and no credentials, written back lower-cased and without its fragment; it is fetched over the guarded public fetch from its own host only, and refused — when the schedule is saved and at each check — where a site profile does not allow reading it unattended.
  - A file must be under one of the running owner's `--fs-root` folders (outside the data directory and the credential homes), checked when the schedule is saved — offline, a `file-changed` pre-check is refused — and stored as its real path.
  - A fire whose pre-check finds nothing new is recorded `skipped` with the ledger reason `unchanged` and makes no model call; one that finds something, or has no earlier reading, runs with a note naming what changed; a check that cannot be made is recorded `failed` (`pre-check failed: …`) and alerted once until a check works again.
  - `run-now` is not checked.
  - `show` prints `pre-check` (and when it last read); IPC `schedules add|update` and `schedules.create`/`schedules.update` take `precheck` as the same text (`null` or `none` removes it), and a schedule record carries `precheck: { kind, target }` and, once a run took a reading, `precheckState: { fingerprint, checkedAt, latest?, ids? }`.
- `--every <n>h` (`watch` only): How often a watcher checks, 1h–12h (`120m` in whole hours also works; default 1h). A model runs at most once an hour on a cadence; a file watcher also checks soon after its file changes while `tavi serve` runs.
- `--watch <on|off>` (`update` only): Make a schedule that has a pre-check a watcher, or stop it being one (its pre-check then runs at its own times).
- `--format <text|json>`, `--workspace <id>`, `--data-dir <path>`, `-h, --help`.

---

### `tavi reminders`

The operator's reminders: the `reminders`
command as the workspace's operator (see [Reminders from an attached client](IPC.md#reminders-from-an-attached-client)).
Under a live `tavi serve` every action runs on the owner over IPC; with none,
the data directory is opened directly and nothing fires until the owner starts
(what fell due meanwhile follows the missed-fire rule). A reminder added here is
`createdBy: user` and delivered in the app — the Command Center's badge and
rail, and a browser notification when turned on; one for a chat is asked for
in that chat.

```bash
tavi reminders <action> [options]
```

#### Actions
- `list`: Active and paused reminders, newest first (`--status` picks others; `--task <task-id>` keeps the ones asked for in that chat). Text fits the terminal's width, or 80 columns in a pipe, a word too long for a line broken: `Reminders (<zone>)`, a header, and for each reminder a row of id, status and next fire in the workspace zone (`-` for none), then, indented and wrapped, its text and cadence (`event Mon 5 Oct 10:00 (1 day before at 20:00, 1 hour before)`, `daily 21:00`, `Mon,Tue,Wed,Thu,Fri 07:00,19:00 until 2026-12-31`; a one-off's `once Mon 5 Oct 10:00` only once it has no next fire, whose date it would repeat).
- `show <id>`: The reminder, its read-back line (`When: …`), where it is delivered, its task prompt, who added it (and the task it was asked in), its next fires and its recent fires (outcome, `late`, `seen`).
- `add "<text>"`: Create one with exactly one of `--at`, `--event` or `--repeat`; `--task <task-id>` asks it from that chat, which lists it (as its panel's **Remind me about this chat…** does). Prints `Added <id>: <text>` and the read-back — `every day at 21:00 Europe/Berlin; next Wed 30 Sep 21:00`, `Mon 5 Oct 10:00 Europe/Berlin; I'll remind you Sun 20:00 and Mon 09:00` — and any event notice already past (`Already past, not sent: …`). A second, identical active reminder is answered `Already set: <id>` rather than made twice.
- `cancel <id>`, `pause <id>`, `resume <id>`: Print `<id>\t<status>\t<text>`. Resuming starts again from now.
- `snooze <id> --minutes <n>`: The latest delivered fire not yet done comes back `n` minutes later (1 to 10,080, a week); prints `Snoozed <id> until <time>: <text>`. Nothing delivered to snooze is refused.

#### Options
- `--at <time>`: Once, at an ISO time with its offset (`2026-10-05T10:00+02:00`) or `"YYYY-MM-DD HH:MM"` (also `YYYY-MM-DDTHH:MM`) local time.
- `--event <time>`: An event at that time; it fires its notices, not the event itself.
- `--notify <offsets>`: With `--event`, comma-separated notices, each `-<n>m`, `-<n>h`, `-<n>d` or `-<n>d@HH:MM` (1–5, at most 30 days before). Default `-1d@20:00,-1h`: the evening before at 20:00, and one hour before.
- `--repeat <HH:MM[,HH:MM]>`: Every day at these 24-hour times (1–6).
- `--days <days>`: With `--repeat`: `mon-fri`, `sat,sun`, names or `0-6` (0 = Sunday), comma-separated, ranges allowed and may wrap (`fri-mon`). Absent: every day.
- `--monthly <day|nth:weekday>`: With `--repeat`: once a month, on a day of the month (`1`–`31`; `31` is a shorter month's last day) or on its nth weekday (`2:tue`, `last:fri`; `1`–`5` or `last`).
- `--yearly <MM-DD>`: With `--repeat`: once a year on that date (`12-25`); `02-29` fires on the 28th in a year without one, and a date no month has is a usage error.
- `--days`, `--monthly` and `--yearly` are one at a time.
- `--until <YYYY-MM-DD>`: With `--repeat`: the last local day it fires, inclusive.
- `--prompt <text>`: Also start a task with this prompt on each fire (origin `reminder`, no pre-approved tools).
- `--deliver-to <app|home>`: With `add`: where it is said (default `app`). `home` posts each fire as a notice in the person's Home, and its task's result as another when it settles; with no Home, or `chat.home` off, it is said in the app. `show` prints `Delivered: in Home, as a notice`.
- `--zone <iana>`: The zone local times are read in, and the reminder's zone. Absent: the workspace's (`tavi config get workspace.timezone`; the owner host's while none is set), which the reminder then keeps.
- `--status <list>`: With `list`: `active`, `paused`, `done`, `cancelled`, comma-separated.
- `--workspace <id>`, `--principal <id>`: Workspace (default `default`) and, offline, the operator principal a reminder is for (default `operator`); on an owner it is the operator the workspace is served for.
- `--format <text|json>`: `json` prints the owner's answer (`reminders` list/get/create/… below).
- `--data-dir <path>`: Data directory.

A malformed time, notice, day or flag is a usage error (exit `2`) before
anything is sent. The owner's refusals are printed in its words — `That time is
in the past`, `Reminders can be set at most 2 years ahead`, `A workspace can
have at most 100 active reminders; cancel some first` — with exit `2`, and so
is an unknown id (`Reminder <id> does not exist`).

### `tavi todos`

The operator's to-do list ([AUTOMATION.md](AUTOMATION.md#to-dos)): the
`reminders` command's to-do actions as the workspace's operator (see [Reminders from an attached
client](IPC.md#reminders-from-an-attached-client)). Under a live `tavi serve` every action runs on the
owner over IPC; with none, the data directory is opened directly (a due time
reminds once the owner runs). A to-do added here is `createdBy: user`, and its
due time is said in the app.

```bash
tavi todos <action> [options]
```

#### Actions
- `list`: Open to-dos, oldest first (every page, not only the first), one line each: text, its read-back, and its id last, the ids lined up (`open, on groceries, due 2026-10-30`; `open, on inbox, due Fri 30 Oct 17:00 Europe/Berlin; I'll remind you then`). `--all` adds done ones; `--list <name>` keeps one list. With none: `No to-dos.`
- `add "<text>"`: Add one (`--list`, `--due`, `--notes`); prints its text, read-back and id, or `Already on the list:` for an open to-do with the same text on that list.
- `done <id>`, `reopen <id>`: Tick a to-do off (its reminder no longer fires), or put it back on its list.
- `remove <id>` (alias `rm`, `delete`): Delete it for good; prints `Removed.`
- `export`: Every to-do, open and done (`--list` for one list), read page after page, as a Markdown checklist grouped by list (`- [x] Buy milk (groceries)`; a due time as `list` says it, `due Fri 6 Nov 17:00 Europe/London`), its words with control characters removed; `--format json` prints the records. There is no `move`: moving to a task app (`tasks.home`) is asked for in a chat, where the agent adds each to-do through the app's MCP server and ticks it off here, since only the owner's agent calls that server.

#### Options
- `--list <name>`: `add`: the list (default `inbox`; names are not case-sensitive). `list`, `export`: only that list.
- `--due <date|time>`: `add`: `YYYY-MM-DD` (shown), or an ISO time with its offset (`2026-10-30T17:00+01:00`), which also reminds then.
- `--notes <text>`: `add`: detail kept with it.
- `--all`: `list`: done to-dos too.
- `--workspace <id>`: Workspace (default `default`).
- `--principal <id>`: `list`, `export`: only this person's to-dos (default: every person's in the workspace). `add`: whose to-do it is (default: the operator).
- `--format <text|json>`: `json` prints the owner's answer.
- `--data-dir <path>`: Data directory.

A malformed `--due` or a missing id is a usage error (exit `2`); an unknown id exits `2` (`To-do <id> does not exist`).

### `tavi ideas`

Ideas: things Tavi offers to do for you, grounded in what
it knows about you and limited to what it can do here. A provider writes them —
the built-in one or an approved plugin — and Tavi checks every one before it is
shown. They also seed the
suggested prompts in an empty chat. Under a live `tavi serve` every action runs
on the owner over IPC (the `ideas` command); with none, the data directory is
opened directly. Trying an idea never runs anything: the terminal prints its
prompt to paste into a chat. `tavi serve` also looks for new ideas once a local
day inside each workspace's hours (08:00–22:00 by default), and answers
`/ideas` (the top four, with what to send) and `/ideas refresh` in a chat; on a
messaging channel only in the operator's own direct chat, never a group or an
email thread. A page (the web UI) cannot change the provider, the digest, the
hours or the budget: they are set here.

```bash
tavi ideas <action> [options]
```

#### Actions
- `list`: The active ideas, best first, grouped by section (`Productivity`, `Travel & errands`, …). Each prints `<id>\t<icon> <title>` with `(pinned)`, `(ready)` when its first step was prepared ahead of time, or its status when not active, and its pitch on the lines below, indented four and wrapped at spaces to the terminal's width (80 columns in a pipe). Then `Muted: …` when sections are muted, the last run: `Last run <time> UTC (<trigger>): <n> offered` (with `, <n> left out` when a provider's ideas were dropped, and the rules they broke on the line under it), or `skipped`/`failed` with its reason, and, under a live `tavi serve`, `Next run <time> UTC` for the daily run. `--all` adds tried, snoozed and dismissed ideas. With none: `No ideas yet`. While Ideas are off, `Ideas are off: none are offered (tavi ideas on)` comes first.
- `try <id>`: Prints the idea's prompt and marks it tried.
- `dismiss <id>`: *Not interested*: the idea's key is not offered again until the ledger is reset, and any other row of it ends at once. An idea that expired meanwhile is dismissed too.
- `digest [<connection> <day>|off]`: Prints the weekly ideas digest's setting, or sends your best three ideas each `<day>` (`mon` … `sun`, or the full name), inside your ideas hours, to your own authorized chat on messaging connection `<connection>`, or turns it off. Off by default. On a running owner, a connection where you have no chat is refused (`NOT_FOUND`). A reply of `try 2` there within a week, or `2` within a day, starts the idea you picked; one digest gives one pick (docs/CHANNELS.md). It goes at most once a week whatever is set since: a moved day, or a digest turned off and on, waits out the week from the last send (`off` keeps that send recorded).
- `hours [<HH:MM-HH:MM>]`: Prints the hours the daily look and the digest run in, or sets them (`08:00-22:00` by default, in the workspace's timezone; the range may cross midnight, and its start and end must differ). Prints `Ideas look once a day between <start> and <end>, in the workspace's timezone`.
- `budget [<tokens>]`: Prints the tokens a day Ideas' model turns may spend, or sets it (digits only, from 0 to 1,000,000; 20,000 by default; `""`, `1e3` or `0x10` is refused). Prints `Ideas' model turns may spend <n> tokens a day`, or, at 0, `Ideas' model turns are off: ideas keep their plain wording`. It is one budget: the prepared first steps spend from it too, at most 40,000 of it.
- `prepare [on|off]`: Prints or sets whether an ideas provider that reads your memory, tasks or brief may have its ideas' first steps prepared (an unattended, read-only run whose searches carry the idea's words, which may hold your notes). Off by default, and turned off again when the workspace switches providers; the built-in provider, and a plugin that reads only the ledger, are prepared either way. Set from a terminal only (a page is refused, `NOT_AUTHORIZED`).
- `reset [ledger|sections]`: Forgets every dismissal, snooze, exclusion, ignored idea and rewritten prompt kept as an example (`ledger`, the default; prints `Forgot <n> …`), or unmutes every section (`sections`; prints `Unmuted <n> sections`).
- `restore <id>`: Undoes a dismissal or a snooze; prints `Restored <id>: <title>`. To make room, another unpinned idea ends, never the one restored; with all 12 places pinned it is refused (`CONFLICT`) and the dismissal kept.
- `refresh`: Asks the owner's selected ideas provider for new ideas now, at most 3 an hour (`QUOTA_EXCEEDED` past that). While Ideas are off it is refused (`UNAVAILABLE`), not counted. One run at a time: a refresh during one prints `New ideas are already being looked for; this refresh follows` and runs once after it (refused with `QUOTA_EXCEEDED` at once when the hour's refreshes are spent); a run open from elsewhere prints `New ideas are being looked for elsewhere` and starts nothing. Offline, with no owner, it is refused (`no ideas host is running`).
- `provider [<id>]`: Lists the providers installed on the owner, `*` marking the one in use, with what each receives. With an id, switches to it (a running owner only; an id not installed is `NOT_FOUND`) and retires the old provider's unpinned ideas. The built-in provider is `tavi.ideasagent`; a plugin provider is described in docs/IDEAS-PLUGINS.md.
- `brief ["<text>"]`: Prints the ideas brief, or replaces it (`""` clears it; at most 2,000 characters): topics to favour or avoid, read as written by the generator.
- `on`, `off`: Turn ideas on or off. Off, `list` says so and `refresh` is refused; an empty chat still suggests what Tavi can do and *Continue*, unless suggestions are off in Settings → Ideas.

#### Options
- `--all`: With `list`, also tried, snoozed and dismissed ideas.
- `--workspace <id>`: Workspace (default `default`).
- `--format <text|json>`: `json` prints the owner's answer.
- `--data-dir <path>`: Data directory.

An unknown idea id exits `2` (`Idea <id> does not exist`).

### `tavi heartbeat`

The workspace operator's heartbeat ([HEARTBEAT.md](HEARTBEAT.md)): the `heartbeat` command. Under a live `tavi serve` every action runs on
the owner over IPC; with none, the data directory is opened directly — every
action is a store write — except `run-now`, which needs the owner's host.
Only the operator has a heartbeat in this version: the owner refuses any other
principal (`NOT_AUTHORIZED`).

```bash
tavi heartbeat <action> [options]
```

#### Actions
- `status`: Its settings and state: on or off (and any pause, with why and until when), interval, active hours and days, deep-look interval, how it tells you, its targets, provider (for a plugin provider, its disclosure and what its egress switches let it receive), model and persona, daily limits, extra tools, sites it may read, sources turned off, the size of its provider's notes, how many instruction lines, mutes, next and last check, whether this owner runs the host, and its revision. Before it is first saved: the defaults, at revision 0.
- `on`, `off`: Turn it on (its next check is placed in its next window) or off. Off keeps its history until retention (30 days).
- `pause [--for <d>]`: Pause it (`30m`, `2h`, `1d`, at most a week), or until `resume`. Refused for a heartbeat never saved, and `--for` is refused while it is paused for its own reason (failures, the budget, a missing provider): `resume` first.
- `resume`: End any pause — the person's, the daily limit's, repeated failures', a missing provider's.
- `every <d>`: How often it checks. The duration is snapped to the nearest of the owner's choices (production: `15m`, `30m`, `1h`, `2h`, `4h`); one outside them is refused. The deep-look interval must stay at least this long.
- `hours <HH:MM-HH:MM> [--days <days>]`: Its active hours (may cross midnight) and days (`mon-fri`, `sat,sun`, `0-6`).
- `tell <mode>`: `urgent-now` (urgent right away, the rest in the next window's summary), `everything-now` (still within the hourly limit) or `digest-only`.
- `edit [--file <path>]`: Its instructions: edited in `$VISUAL`/`$EDITOR` from the current text (a terminal only; unchanged text saves nothing), or set from a file (`-` reads standard input). Each change is kept in the instructions history.
- `run-now`: Check now: started at once, or queued behind a check in progress. Refused while it is off or paused, or with no owner running the host.
- `log [--since <time|d>] [--limit <n>]`: Its checks, newest first (default 50, at most 500): time, kind (`signal`, `deep`, `window`, `digest`), outcome and reason, items told now and later and resolved, tokens and cost, why it ran when not on schedule (an event, you asking, a catch-up), how many memories it used, any error, and what a mod decided about an item (held back, with its masked reason, or made to wait for the summary).
- `set-provider <id|builtin|off>`: Who decides what is worth telling. On the owner an id that is not an installed provider is refused (`INVALID_INPUT`); with no owner running it is saved unchecked. A new provider starts without the old one's notes and with every egress switch off, and choosing one (the same one too) ends a provider pause.
- `egress <instructions|signals|ledger|memory> on|off`: What an external provider may receive (all off by default; the built-in provider receives everything). Turning one on needs the provider loaded where the command runs, so it can be checked against what the provider declares: with no owner running, only `off` works for a plugin provider.
- `mute <key|prefix*>`, `unmute <key|prefix*>`: Never tell about an item key, or any key under a prefix ending in `*`.
- `forget --yes`: Delete its log, what it told you (muted items stay muted), what it had seen, its notes, its provider's panel and its settled tasks with their provider attempts and hook rows; its settings and instructions history stay, and today's checks still count toward the daily limits. Prints what it removed.

The other settings — the deep-look interval, the daily limits, the model and persona, channel targets, extra tools, the sites it may read and the signal sources it reads — are changed in Center → Heartbeat (chat's `heartbeat.propose` covers on/off, interval, hours, days, how it tells you and the instructions); `status` shows them, and the instructions history is in Center → Heartbeat → *History*.

#### Options
- `--revision <n>`: With `on`, `off`, `every`, `hours`, `tell`, `edit`, `set-provider`, `egress`, `mute` and `unmute`: write only over this revision (0 for a heartbeat never saved); a heartbeat changed since is refused (`CONFLICT`, exit `2`). Absent: the current revision.
- `--workspace <id>`: Workspace (default `default`).
- `--format <text|json>`: `json` prints the owner's answer (`get` for writes and `status`, `log`, `run-now`, `forget`).
- `--data-dir <path>`: Data directory.

A malformed duration, hours, mode, field or flag is a usage error (exit `2`)
before anything is sent, as is an interval outside the choices, an instruction
or mute the config refuses, and a stale revision. The owner's refusals exit `2`
too: `run-now` while off or paused, `pause`, `resume` or `forget` before the
heartbeat is first saved, and a workspace the owner does not serve. `run-now`
without a host exits `4`. `edit --format json` with unchanged text prints
`{"unchanged":true}`.

### `tavi projects`

Manage the projects your reports collect data for: the project registry the
report collectors read. `<data-dir>/projects.json` is read
only by `import`. Under a live
`tavi serve`, every action but `import` runs on the owner over IPC (see
"Configuration under a live owner").

```bash
tavi projects <action> [options]
```

#### Actions
- `add <id>`: Add a project (the id is positional), with any of the source options below.
- `list`, `show <id>`, `remove <id>` (alias `rm`, `delete`): Inspect and delete.
- `enable|disable <id>`: A parked project keeps its ids but is skipped by every collector.
- `import`: Read `<data-dir>/projects.json` into the registry; the file carries the deployment-wide settings itself (`googleServiceAccountRef`, `lookbackDays`, `news`). The file's deployment-wide `news` settings are the collector configuration: `feedUrls` are read as RSS/Atom, and `searchCredentialRef` now names the credential a **web-search provider** (Tavily) is called with, using each project's own keywords as the query. Its results are treated exactly like feed items — untrusted text, https-only, capped and relevance-filtered — and a missing credential or an unavailable provider costs a note on that project, not the report. The whole file is validated before the first write, and the settings row plus every project commit in one transaction, so a refusal leaves nothing half-applied.

#### Options
- `--name <name>`: A human-readable name.
- `--ga4 <property>`: A GA4 property (`properties/513076108`).
- `--gsc <site>`: A Search Console property (`sc-domain:example.com`).
- `--gcp-project <id>` with `--gcp-table <table>`: The BigQuery billing export.
- `--stripe-ref <ref>`: The credential reference of the Stripe key.
- `--keyword <word>` (repeatable, or comma-separated), `--language <code>` (`en`), `--region <code>` (`US`): The news search.
- `--format <text|json>`: Output format (default: `text`).
- `--workspace <id>`: Workspace (default: `default`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

---

### `tavi system-prompt`

Edit the default base instructions a **new** task runs under, for one workspace.
Under a live `tavi serve` each action runs on the owner, over IPC; otherwise on
the data directory directly spread over the same compare-and-set.

```bash
tavi system-prompt <action> [options]
```

#### Actions
- `show`: Print the saved override, or the shipped default, with the revision a
  write must assert.
- `set --file <path>`: Replace the base with the file's text. The file is read as
  UTF-8 **exactly as written** — no trimming, no credential-file rules — so a
  prompt may be multiline and may begin or end with whitespace. Max 20,000
  JavaScript string code units; empty, whitespace-only and over-limit text is
  refused before saving (exit `2`).
- `reset`: Clear the override; from the next message, chats follow the shipped default again.
- `preview [--agent <id>]`: List the layers a new task's prompt is built from, in
  the order the model receives them, with their lengths in JavaScript string code
  units: the shipped default (marked *not sent* when your prompt replaces it),
  your prompt, the agent's persona, then the runtime facts and the memory and
  skills context, which are generated for every model call and have no fixed
  length; the context line counts the workspace's active skills
  (`…generated per call, 2 active skills`). The facts are shown as a sample — the first step of an attended task,
  in the workspace's timezone now — not what any call received. The preview comes
  from the same function the workflow composes each request's base and persona
  with, so it cannot drift from it. IPC: `system-prompt { action: "preview",
  workspaceId?, agentId? }` answers `{ workspaceId, agentId?, layers, shippedLength,
  overridden, baseText, personaText? }`, each layer `{ kind, source?, label,
  length?, generated, active, detail?, sample?, skills? }` — `skills` on the
  context layer is the number of active (approved) skills the context may draw
  on; an unknown agent is `NOT_FOUND`.

#### Options
- `--file <path>`: The prompt text for `set` (required for `set`), read as described there.
- `--workspace <id>`: Workspace to act in (default: `default`).
- `--format <text|json>`: Output format (default: `text`).
- `--expected-revision <n>`: Assert the revision this write is based on instead of reading it first.
- `--agent <id>`: `preview` only: append this agent's persona.
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

**What it changes, and what it does not.** Changes apply from the next message
: a chat created after the save, and each existing chat's next message,
run under it. Each `start` or `reply` admission re-resolves the base and pins
it (a new pin is stored only when the base changed, so an unchanged base is
sent byte for byte the same and a provider's prompt cache holds); a turn
already running keeps its pin, and an approval or answer resumes it under that
pin. The base a task was created with stays stored with it. A chat whose base
is an explicit one keeps it. A persona is appended *after* the base
and adds to it rather than replacing it; an edited persona is read again at
each model call. A routine
keeps its own pinned instructions, which outrank a workspace edit, and the
compaction summary call keeps its own dedicated prompt — neither is affected. An
embedding may also supply its own base, which likewise outranks this setting;
none of the shipped entry points does, so no ordinary workspace task exhibits
that tier.

**Conflicts and unknown outcomes.** A write is a compare-and-set: without
`--expected-revision` the command reads the current revision and asserts it, and
a writer that got there first makes this one fail with `CONFLICT` (exit `2`)
rather than overwriting. Because the write is a compare-and-set, retrying with
the revision you actually read cannot apply the same change twice. If a write
*times out*, its outcome is unknown rather than a rollback: run
`tavi system-prompt show` and compare before retrying.

**Combined limits.** The editor bound covers the saved text. A composed request
that also carries a persona, generated runtime facts and retrieved context is
checked against the run's context budget separately; a request whose mandatory
instructions cannot fit fails the turn with a typed `INVALID_INPUT` rather than
truncating the base or silently using the default. One exemption is deliberate: a
workspace or shipped-default base is checked, but an adapter built with its own
**explicit** prompt and no memory service — the routine adapters — is not, because
routine instructions and pinned skills are long by design and failing them here
would break runs that pass today. Their own turn budget still applies.

**Privacy.** The text is stored locally in the data directory and is sent to
whichever model the run resolves. It should not contain credentials. Resetting
the setting does not erase the per-task snapshots: historical text is retained
with its task under normal task retention and backup rules, and never written to
the diagnostic log or an event payload.

**Retention: what survives, and what cannot be reconstructed.** Each task's
selected base is stored in `tavi_task_prompt_snapshots` alongside the task, and
nothing prunes it — `tavi prune` covers **only** transport state (a resolved
outbox row, a processed inbox row, an unbound sender's held message, a mailbox
envelope that is not `pending`, a settled wait intent), while the task, admission, effect, approval, report and
artifact tables are left alone as the audit trail. A snapshot therefore outlives
`set`, `reset` and the task's own completion, and goes away only when the
database does or when an older backup is restored over it.

That answers "what did this task run under?" permanently, but it does not make
every historical prompt recoverable. The workspace row keeps the *current* text
plus the revision, actor and time of the last change — not the text it replaced —
so once a `set` supersedes an override, the previous base survives only in the
snapshots of the tasks that were admitted while it was live.

Routes through `configOnOwner`, so a refusal is reported with the exit the
offline command gives it (`CONFLICT` → usage) and a lost answer to a write says
the owner may still have applied it.

---

### `tavi config`

Read and change the workspace settings. Under a live `tavi serve` each action
runs on the owner over IPC (the `workspace-settings` command); otherwise on the
data directory directly, with the same validation and compare-and-set.

```bash
tavi config get [key]
tavi config set <key> <value>
tavi config unset <key>
```

#### Actions
- `get [key]`: Print one setting, or every setting.
- `set <key> <value>`: Change a setting.
- `unset <key>`: Clear a setting and use its default.
- An unknown key is one line, exit `2`: `Unknown config key "<key>"; did you mean <nearest>? \`tavi config get\` lists every key` (or, with no near key, where the list and the help are), without the whole help.

#### Options
- `--workspace <id>`: Workspace to act in (default: `default`).
- `--format <text|json>`: Output format (default: `text`).
- `--expected-revision <n>`: Writes only: assert the revision this write is based on; without it the write asserts the revision it just read, so a concurrent change is still a `CONFLICT`, exit `2`.
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

Keys:

- `workspace.timezone`: the IANA time zone (`Europe/Berlin`, `America/New_York`)
  the agent states the current local time in, and that relative dates and times
  ("tomorrow", "next Monday at 10") resolve in. Unset, the owner host's zone
  applies. A zone the platform does not know is refused with the value named
  (exit `2`); a different spelling of a known zone (`europe/berlin`) is stored
  as the platform spells it. The zone is read on every model call, so a change
  reaches the next call of a running task.
- `operator.name`: what you are called (one line, up to 80 characters), as
  onboarding's about step sets it. Unset
  by default.
- `activity.summaries`: `on` or `off` (also `true`/`false`, `yes`/`no`).
  Default `on`: when a task finishes, the serving owner makes one model call
  (at most 60 output tokens, no tools, recorded against the task) for a title
  of at most 60 characters and a one-line summary of at most 120, which
  `tasks list` and Activity show. A task continued later is summarized again
  when it finishes again. `off`: no call; a task
  that finishes (or finishes a follow-up turn) while summaries are off is
  marked `summaryState: "skipped"` and keeps whatever title it had — its
  prompt-derived one, or the generated title and summary an earlier turn
  already received.
- `activity.summaryModel`: `<connection>/<model>` that writes summaries instead
  of the model the task itself used. Refused for a task that ran on a local
  connection (declared local-only, or an endpoint on `localhost`, `127.x`,
  `::1`, `*.localhost` or a unix socket) when this one is remote: that task's
  own model writes its summary. A task any of whose attempts ran on a local
  connection (or one the owner does not know) is never summarized by a remote
  model, its own included; it is skipped instead. An override naming a
  connection the owner does not know is ignored. Unset: the workspace's `fast` role when bound, else each task's own model
 .
- `browser.noThumbnailHosts`: a comma-separated list of hosts whose pages never
  get a browser thumbnail in the Command Center: an exact host
  (`mail.example.com`) or `*.domain`, which matches the domain and all its
  subdomains (`*.bank`). Entries are stored lower-case, with an
  internationalized name in its ASCII form; a URL, a port or a path is refused
  (exit `2`). `none` sets an empty list. The list replaces the default, which is
  `mail.google.com`, `outlook.live.com`, `outlook.office.com`,
  `outlook.office365.com`, `mail.yahoo.com`, `mail.proton.me`, `*.paypal.com`
  and `*.bank`. Whatever the list, a page with a password field, or a card
  number, security code, expiry or one-time-code field (in any frame), never
  gets one, and a sensitive page clears the session's earlier thumbnail
 .
- `ui.roles`: JSON naming the plugin that fills each UI role, such as
  `{"browser-view":"off"}`; `"off"` as a role's value turns the role off. Unset: the
  built-in (`tavi.browserview` for `browser-view`). Here a role may name only
  the built-in or `off`: another plugin is chosen with `tavi plugins ui
  set-role`, which shows what it would see and asks for `--yes` first. A
  plugin that is not enabled and approved, or does not declare the role,
  falls back to the built-in, and `tavi doctor` lists it under
  `uiRoleFallbacks`.
- `ui.placements`: JSON, per contribution (`<plugin-id>/<contribution-id>`),
  either `"hidden"` or `{"slots":[{"slot":"chat.panel.tab"}]}`: where it is
  shown instead of where its manifest places it. Unset: each manifest's own.

  Changing either (or a plugin's setting) bumps the Command Center's `plugin`
  change kind, so every open page re-reads its UI plugins at once.
  (A browser session's `inactive_since` is set while its task has ended and
  the session is kept open; a wait's `handoff_json` holds a browser
  handoff's session, reason and instructions.)
- `chat.home`: `on` or `off` — whether the workspace has a Home chat, one
  persistent chat that `/` and a bare `tavi chat` open. Unset: on. `off`:
  every chat is an ordinary chat, with no Home. While it is on, the canvas (`/`) and a bare `tavi chat` open on the
  person's Home, a prompt with nothing else open goes to Home, a new
  chat is a side chat (**New side chat**, `/side`), background work posts
  notices into Home, and `tavi run --home` posts a turn into it.
  Turning it off later
  leaves Home an ordinary chat: the canvas's sidebar lists it pinned on top,
  under no Home heading, as `Home`.
- `chat.home-dm`: `<connection>:<sender id>[,…]`, or `off` — the operator's
  own Telegram DM identities whose private chats with the bot are turns of
  their Home, at most 16. Unset or
  `off`: nothing linked. Only `telegram-…` connections and numeric user ids are
  accepted (anything else, `on` included, is a usage error); email is not
  linked yet (its SPF/DKIM pass is not aligned with the bound address). Setting
  it while `chat.home` is off is a usage error ("turn chat.home on first");
  turning `chat.home` off later leaves it set but out of effect
  (`chat.home-dm = telegram-<id>:42 (off: chat.home is off) (set)`). Any
  change that leaves the link in effect — setting it, or `chat.home on` under a
  stored list — prints a privacy note naming the identities under the setting
  (on stderr with `--format json`): Home's whole context can shape the answers
  sent to those DMs, and they are shown in Home. Linked: a message on a
  `telegram-…` connection whose chat id is the sender's own (a private chat),
  not a forum topic's, from a listed identity whose binding names the
  workspace's operator when it arrives, while the operator has a Home, is
  admitted as a `reply` turn of that Home, with the DM as that admission's
  `messagingReplyTo` only (the next canvas turn has the canvas's), so its reply,
  questions and approval announcements go to the DM and the turn is held to the
  messaging profile. No mapping is recorded: the DM is no conversation
  Home while linked, and a typed reply answers the question Home asked there.
  A bare `approve`/`reject` there decides only a round announced to that DM; a
  round raised in the canvas answers "Home's pending round was not asked in
  this chat…" and is decided from the DM only by its token. While Home waits on
  a round, a DM message is refused ("Home waits on its approval round …"), as a
  message to Home from the canvas is. `/new` there ends nothing and answers that
  Home never ends. With no Home yet, or for anything else, nothing changes.
  Turned off, a DM's next message goes to its own conversation (its earlier
  mapping if it had one, else a new one).
- `travel.flightSearch`: `on` or `off` — whether `travel.flights_search` asks
  Kiwi.com's public flight search. Unset: on. Off,
  the tool refuses and the agent browses flight sites instead.
- `travel.googleFlights`: `on` or `off` — whether flight answers link Google
  Flights, an unofficial and best-effort back end, to confirm a fare or when
  the search fails. Unset: on.
- `skills.suggestions`: `on` or `off` — whether the agent may offer, unasked,
  a procedure that worked as a skill for you to review (`skills.propose`).
  Unset: on. Off, it offers one only when you ask.
- `pdf.enabled`: `on` or `off` — whether the PDF tools (`pdf.read`,
  `pdf.view`, `pdf.fields`, `pdf.render`, `pdf.fill`, `pdf.overlay`) run
 . Unset: on. Off, they stay listed but
  refuse every call, a fill is refused before any card, and the canvas takes no
  PDF upload.
- `video.enabled`: `on` or `off` — whether the video tools (`video.info`,
  `video.frames`, `video.view`, `video.transcribe`, `video.pose`) run. Unset:
  on. Settings → General has the same switch; see [VIDEO.md](VIDEO.md).
- `browser.sessionIdleMinutes`: `0`–`1440` — how many minutes a browser session
  nobody is using stays open before it closes as `idle`; its profile keeps the
  sign-ins. `0` keeps it until it is closed. Unset: 30.
- `browser.downloadMaxMiB`: `1`–`4096` — the largest file a browser download
  keeps, in MiB; a larger one is cancelled and refused. Unset: 256.
- `browser.visionEngine`: `generic` or `native` — what drives acting by sight:
  Tavi's own loop, or (experimental) the model's native computer-use tool on a
  connection that offers one. Unset: generic.
- `desktop.grantedApps`: comma-separated bundle ids or app names, or `none` —
  the apps experimental desktop control may see and act in, each at its
  built-in tier; see [DESKTOP.md](DESKTOP.md). Unset: none.
- `video.keepDays`: `1`–`3650` — how many days a video sent from a channel,
  mail or the web is kept before it is deleted with its body. Unset: 30.
  Videos in your folders are never pruned.
- `tools.redactResults`: `on` or `off` — whether credential shapes in tool
  results are masked before anything keeps them.
  Unset: on. On, every string in a tool's output — and in the copy of a call's
  input sent to clients — has AWS keys, GitHub, GitLab and Slack tokens, Stripe
  and `sk-` API keys, Google API keys, JWTs, bearer tokens, Hugging Face, npm
  and PyPI tokens, SendGrid keys, Telegram bot tokens, the password in a
  connection string (`scheme://user:password@host`, up to the host's `@` when
  the password holds one; a whole-password placeholder such as `<password>`,
  `${DB_PASS}` or `$DB_PASS` is left) and PEM private keys
  replaced by `[redacted:<kind>]`; keys, numbers and the JSON shape are kept.
  The model, the archive, the effect ledger's receipt and the `tool.completed`
  event (which carries `redacted`: a count per kind) all see the masked text,
  and the tool card says "N secrets masked". A browser handoff's page
  observation is masked the same way. Whatever the setting, a non-read-only
  call whose input holds a placeholder is hard-denied, so a model cannot write
  a masked secret back over the real one.
- `tools.parallelReads`: `1`–`32` — how many independent read-only calls of
  one model step run at the same time. Unset: 8. `1` runs every call in turn;
  results, cards and approvals keep call order either way.
- `memory`: JSON, the whole memory section, such as `{"enabled":false}` or
  `{"capture":"off","limits":{"evidence":4}}` (docs/MEMORY.md B.3).
  Unset: memory on, the model may suggest memory, the default limits.
  `tavi memory config` changes one key of it at a time.
- `models.maxOutputTokens`: `256`–`1000000` — the most one model call may
  write (its `max_tokens`). Unset: `16384`. A heartbeat's or an idea's own
  cap is used instead. When a provider refuses a call because the key can
  pay for fewer output tokens than were asked for (OpenRouter's "can only
  afford N"), the same call is asked once more for that many; the error a
  chat shows never includes the key's settings link.
- `models.keptRequests`: `0`–`1000` — how many of a task's newest model calls
  keep their whole request in model accounting. Unset: `10`. An older
  call keeps its usage, cost estimate, ids, provider operation and the
  request's SHA-256 (`requestSha256`), so `tasks show`, `router explain`,
  `doctor`'s `chatMeasurement` and the check before each call for an attempt
  of unknown outcome read what they read before; only the request body is
  gone. A call still running always keeps it. Applied when a task's next call
  ends, to that task: lowering it trims a task at its next call, and raising
  it brings back nothing already stripped. Anything but a whole number in
  range is a usage error.
- `scheduled.monthlyTokenBudget`: tokens (1000 or more, `_` or `,` allowed
  between digits) the workspace's schedules and routines, with their workers,
  are meant to use in a calendar month in `workspace.timezone`. Your Home is
  told once a month when they reach 80%; nothing is stopped. `tavi doctor`'s
  `scheduledWork` and the Schedule page show the month's share. Unset: no
  budget, and no notice.
- `models.promptLayout`: `v1` or `v2` — how a model call's prompt is laid out
  for prompt caching. Unset: `v2`, the cache-stable layout; setting `v1`
  rolls its changes back. Read on every model call, so a change reaches a
  running task's next call. Under `v2` an attended chat (CLI, web, IPC) finds
  its rarely used built-in tools — `routines.*`, `heartbeat.status` and
  `heartbeat.propose`, `pdf.*`, `video.*`, `projects.*`, `reports.*`,
  `reminders.update`/`cancel`/`snooze`, `todos.update`/`remove`,
  `schedules.*`, `findings.*`, `plugins.*`, and
  `agents.send`/`request`/`reply`/`cancel` — through `tools.search`, whose
  description gives each family a line; the runtime facts tell the model to
  search before saying a capability is missing. A PDF or video the person's
  messages hold, or a reminder or a time they ask for (which brings in the
  reminder changes and `schedules.create`, `list`, `update` and `pause`), brings
  its tools in without a search, and a tool called by its exact name runs when its input fits its
  schema. `tools.search` takes a family's name (`pdf`) for all of it and
  `select:<id>[,<id>]` for exact tools. Channels, unattended runs and workers
  keep them listed, unless their list is past the 128 tools one request may
  carry, when they defer them too. `models.toolDeferral` decides it for a
  chat on a local model ([TOOLS-AND-SKILLS.md](TOOLS-AND-SKILLS.md)).
- `tasks.home`: `tavi` or `mcp:<server>` — where you keep your tasks. Unset:
  `tavi`, Tavi's own to-do list. `mcp:<server>` (such as `mcp:todoist`) is a
  task app connected as an MCP server (`tavi mcp add todoist --preset todoist`): the system prompt sends your to-dos
  there, and `todos.*` keep only Tavi's own follow-ups. No sync
  ([AUTOMATION.md](AUTOMATION.md#to-dos)).
- `models.toolDeferral`: `auto`, `on` or `off` — whether those families wait
  behind `tools.search` under `v2`. Unset: `auto`, which defers them unless the
  chat runs on a local model (one that may not search well keeps the whole
  list); `on` always, `off` never.
- `security.taint`: `off`, `observe` or `enforce` — how the gate's taint step
  applies. Unset: `enforce`. Under `enforce`, a
  call made after untrusted content entered the chat that could send data
  out, use a credential or outlast the chat asks once (`gateReason`), whatever
  a rule, grant or `serve --allow` says, and an unattended run denies it.
  Under `observe` every call is decided as it was without the step, and each
  call it would have asked is recorded in `tavi_gate_observations` (task, call
  and tool ids, effect, sink, both decisions and the reason — never the call's
  input; kept 30 days, pruned with lapsed chat grants at start and hourly,
  and erased with the chat's turns when they are forgotten);
  `enforce` records its asks the same way: an unattended routine's or
  heartbeat's denial is recorded as `deny`; a schedule fire's or
  `--approval approve`'s refusal of the round is recorded as the gate's `ask`.
  Observe leaves the taint step's decisions as they were; the unattended deny
  of tainted `askWhenTainted` and `critical` calls applies in every
  mode. `off` neither asks nor records; it is deprecated. The owner logs a
  warning at start, and `tavi doctor` warns, while a workspace has `observe`
  or `off`. The same
  setting as `tavi permissions taint`; `serve --taint-policy` overrides it
  (the text output then reads `enforce (serve --taint-policy; this
  workspace's own is observe)`, and the JSON answer carries `taintPolicy`).
  Through the `tavi ui` bridge a write that lowers it (`enforce` → `observe`,
  or anything → `off`) is refused `NOT_AUTHORIZED`.
- `security.injectionDetector`: `off`, `patterns` or `model` — whether a
  detector reads a tainted chat's untrusted content for likely prompt
  injections. Unset: `patterns`. A hit adds a
  reason to the verdict of each call gated after it (`possible prompt
  injection in <source> content (<signals>)`, shown as the card's warning
  line), raises its risk to `high` and logs a warning once per flagged message — read only for a call the gate asks about, the one whose card can show it; it never allows,
  denies or lowers anything, and a failure is no hit. `patterns` is local
  text matching on the newest 16 untrusted messages; `model` also puts what
  the patterns pass to a classifier call on the `fast` role, else the chat's
  own model (a chat on a local connection uses its own model), recorded with purpose
  `evaluation` and no kept request. A page may set it either way. Any other
  value is a usage error.

- `mcp.servers`: the MCP servers this workspace offers (`mcp.docs,mcp.home`,
  or `none`); `tavi plugins enable mcp.<name>` adds one. Unset: none.
- `mcp.people`: the allowed MCP servers whose tools other people's chats in
  this workspace are offered too (`tavi mcp people`). Unset: none.
- `sandbox.domains`: the domains this workspace's `sandbox.run` may reach
  beside `serve --sandbox-domain`'s: a
  comma-separated list of `host` or `*.domain`, each with an optional `:port`
  (`pypi.org,*.pythonhosted.org,api.example.com:443`), or `none`; at most 64.
  A bare `*` or `*.tld` is refused. A tainted chat gets no network whatever is
  listed. Unset: none.
- `sandbox.network`: `granted` or `ask`. Under `ask` a `sandbox.run` may name
  hosts nobody granted in `requestDomains`, shown on its approval card, which
  a person answers for that call alone (no rule, chat grant or unattended run
  does), and reached by that run alone once approved; never in a tainted chat,
  and never a pattern, an address or a paste site. Unset: `granted`.

An unknown key is a usage error listing the valid ones. `get` without a key
prints every setting. The text output is one line per key —
`workspace.timezone = Europe/Berlin (set)`, or
`workspace.timezone = Europe/London (default: host zone)`,
`activity.summaries = on (default)`,
`activity.summaryModel = the fast role when bound, else the task's own model (default)`,
`browser.noThumbnailHosts = mail.google.com,…,*.bank (default)`,
`browser.sessionIdleMinutes = 30 minutes (default)`, `browser.downloadMaxMiB = 256 MiB (default)`,
`browser.visionEngine = generic (default)`,
`ui.roles = built-in (default)`, `ui.placements = each manifest's own (default)`,
`chat.home = on (default)`, `chat.home-dm = off (default)` — and
`--format json` prints the answer described below.

The canvas edits the same settings in **Settings → General**.

---

### `tavi agents`

Manage named agent personas. A task, a spawn or a schedule may name an agent; its
instructions are then used for that task's model calls. Under a live `tavi
serve`, every action runs on the owner over IPC (see "Configuration under a live
owner").

```bash
tavi agents <action> [options]
```

#### Actions
- `add <id>`: Create a definition (the id is positional; `--name` and `--prompt` are required). An id that differs from another's only in case, or a name another agent has, is refused (`CONFLICT`): a chat names an agent by either, in any case.
- `list`, `show <id>`, `remove <id>` (alias `rm`, `delete`): Inspect and delete.
- `update <id>`: Edit `--name`, `--description` or `--prompt` in place, so a badly-worded persona is fixed without deleting the id every schedule and conversation names. Fields left out are untouched; an empty `--description` clears it; an update naming no field is a usage error rather than a no-op that reports success. A task picks the edit up on its **next turn** — the definition is a reference, not a snapshot. Over IPC, `agents` `update`, `enable` and `disable` take an optional `expectedUpdatedAt` — the definition's `updatedAt` as the client read it — which makes the write a compare-and-set: a definition changed since is refused with `CONFLICT` rather than overwritten (the canvas's persona editor relies on this). Every write moves `updatedAt` strictly forward, so the token is never reused; without `expectedUpdatedAt` the write stays unconditional. IPC `agents list` answers each definition without its prompt but with `systemPromptLength` and `updatedAt`, and `pinnedBy: [{ routineId, name }]` for an agent a routine runs: a routine's runs use the instructions pinned in its revision (the active one, or the latest before one is active; a completed or archived routine is not listed), so a persona edit does not reach them.
- `enable|disable <id>`: Arm or disarm it — a disabled agent cannot be admitted.

#### Options
- `--name <name>`: Human-readable name (required for `add`): one line of text, with no tab or other control character, as a schedule's `--name` is.
- `--prompt <text>`: The persona instructions (required for `add`).
- `--description <text>`: One line on what the agent is for; an empty value clears it on `update`.
- `--format <text|json>`: Output format (default: `text`).
- `--workspace <id>`: Workspace (default: `default`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

#### Naming a persona from chat

A chat message that **opens with `@name`** (or `@id`) runs under that persona: the
mention is resolved against the enabled definitions in the workspace — by id
first, then an exact case-insensitive display name — and is stripped from the
instruction before it reaches the model. An unresolved mention is not an error:
the message is admitted exactly as it would have been, so a typo costs the persona
rather than the message.

The persona is chosen when a conversation's task is *created*, and every later
turn of that task keeps it: the runtime carries the checkpointed agent reference
forward when an admission names none, so the second message of a conversation
answers as the same persona as the first. A later `@other` does not change it,
because the runtime validates an agent reference only for a new admission; the
mention stays in the text the model sees.

A definition that has been disabled, removed, or edited into a row that no longer
validates costs the persona and not the task: the turn runs under the base
instructions, and `tavi agents list` names an unreadable row for repair.

---

### `tavi search`

Configure the web search providers the `web_search` tool asks. Under a live `tavi serve` each action runs on the owner, over IPC; otherwise on the data directory directly.

```bash
tavi search <action> [options]
```

#### Actions
- `add <id> --kind <kind>`: Add a provider. `tavily` runs keyless with no `--credential` (Tavily's keyless mode), else with its API key; `brave` and `serper` need `--credential <ref>` (a key stored with `tavi credentials set`, under `search.<name>` or the kind's own `brave.<name>`/`serper.<name>` — a key stored for anything else, or one a model connection holds, is refused); `searxng` needs `--base-url <url>` — the operator's instance, with `json` in its `search.formats` — and takes no key. A configuration that cannot work is refused (exit `2`), saying why.
- `list`: The configured providers in insertion order: id, kind, key or instance, enabled. Select dispatch order in `web-providers.json`.
- `test <id> [--query <text>]`: One search through the same adapter `web_search` uses — on an owner with the owner's own credential chain, offline with the credentials directory's keys (a key an owner resolves another way, a launcher's binding, is not seen there): prints what it answered (exit `0`), or the refusal (exit `1`); a provider that does not exist exits `4`, and a key that breaks the key rule below is refused before any search (exit `2`), offline as on an owner. Offline, it holds the data directory only to read the provider, not while it waits on the network.
- `remove <id>` (alias `rm`, `delete`), `enable <id>`, `disable <id>`.

#### Options
- `--kind <kind>`: `tavily`, `brave`, `serper` or `searxng` (required for `add`).
- `--credential <ref>`: The provider's API key, by credential reference (`tavi credentials set`); `tavily` without one runs keyless; `brave` and `serper` need one.
- `--base-url <url>`: A `searxng` instance, e.g. `http://127.0.0.1:8888` — `searxng` only, which takes no key (enable `json` in its `search.formats`).
- `--query <text>`: What `test` searches for (default: `"tavi"`).
- `--format <text|json>`: Output format (default: `text`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

`web_search` uses a single available provider automatically. If several are available, select one or an explicit fallback chain in [web-providers.json](PLUGINS.md#web-provider-selection-and-receipts). Provider failures may use the next provider; authorization failure, revocation and cancellation stop dispatch.

A provider that answers `429` is left alone for as long as its `Retry-After` says (a minute when it names no time, fifteen minutes at most), in that `tavi serve`: a search is not sent to it meanwhile, and the next provider in the chain is asked. While every provider of the chain waits, `web_search` is refused before the approval gate asks anyone, and the model reads the time it may search again (*Web search is rate limited until 2026-11-17T10:01:30Z: do not call web_search again before then; …*).

It takes:

- `query`;
- `maxResults`;
- `recency` (`day`, `week`, `month`, `year`: Brave's `freshness`, Serper's `tbs`, Tavily's and SearXNG's `time_range`);
- and `site` (a domain: Tavily's `include_domains`, `site:` in the query elsewhere).

It returns `{ provider, content?, sources, truncated }`: at most 20 sources (URL, optional title, snippet and date), bounded to 48 KiB in all.

It is an `external` effect, and every workspace is seeded once with an operator allow rule for it, `seeded-web-search` (`tavi permissions list`; remove it, or add an `ask` rule, to be asked each time — a removed seeded rule is never put back), so a search asks no one, in a chat or a schedule (a schedule offers it only when its tools include it: `--allow web_search`).

- The taint step comes before every allow rule, so a chat that holds untrusted content and private data still asks before a search (`private-search`).
- In a tainted chat a query shaped like data leaving — one that holds a link carrying a query string, a fragment or a long path segment, a domain whose name carries data, a long code, a card or ID number, an email address, a secret's shape, or runs past 300 characters (`site` read with it) — asks a person whatever a rule allows, and an unattended run is refused it.
- A chat that read nothing untrusted runs such a query as any search: no injected page wrote it.
- A query shaped like a secret (a key or token) is the exception: it asks in any chat, and an unattended run is refused it.

Existing workspaces get the rule at their next start.

Provider instances are activated on demand: adding or enabling a provider takes effect from the next turn, with no restart of `tavi serve`; disabling or removing one excludes it from new calls immediately. The owner offers the tool once an available provider exists — at start, or after the `search` write that adds the first — and never while none does.

---

### `tavi router`

Optional routing ([ROUTER.md](ROUTER.md)). Output is JSON; every write needs `--revision <n>`, the current revision from `status`.

```bash
tavi router status
tavi router configure --file <json> --revision <n>
tavi router set-mode <feature> off|shadow|active --revision <n>
tavi router set-provider <plugin-id> --revision <n>
tavi router explain <task-id>
tavi router evaluate [--file <json>]
```

#### Actions
- `status`: Each feature's mode, budgets, key presence and price readiness.
- `configure --file <json>`: Replaces the settings (`{ "settings": { … }, "priceSheets": [ … ] }`) and optionally installs dated price sheets. The Jev provider's endpoint, model and `credentialRef` go under `settings.providerSettings["tavi.router"]`; secrets are stored with `tavi credentials` and named by reference only. `settings.enabled: false` disables routing everywhere; saved task routes stay.
- `set-mode <feature> <mode>`: Sets `model`, `memory`, `tools` or `skills` to `off`, `shadow` or `active`.
- `set-provider <plugin-id>`: Selects the routing provider (default `tavi.router`, the Jev provider).
- `explain <task-id>`: A task's saved route, its decisions, exposure and any costs not yet complete.
- `evaluate [--file <json>]`: Analyses recorded paired evidence; no live provider call. Runs alongside an owner without its lock. With no evidence it prints the verdict and its reasons (activation, protocol version, `liveExecution`), not the empty comparison tables.


#### Options
- `--revision <n>`: The current revision from `status`; every write needs it. A stale one is refused naming the current revision (`revision <n> is stale, it is now at revision <m>`), and it, like a file that is not valid JSON, exits `2`, with or without an owner.
- `--file <json>`: The settings file for `configure`, or the evidence for `evaluate`.
- `--data-dir <path>`, `--workspace <id>`, `--principal <id>`: The common data directory, workspace and principal.

---

### `tavi plugins`

List, install, review, enable and configure plugins. Under a live `tavi serve` each action runs on the owner over IPC; otherwise on the data directory directly. The **Plugins** settings view in `tavi ui` offers the same actions.

```bash
tavi plugins <action> [options]
```

#### Actions
- `list`: Every plugin: id, kind (`(core)` when it cannot be disabled, `(dev)` for one `tavi serve --dev-plugin` loaded), enabled or disabled, version, and under a live owner its phase (`ready`, `failed` with the error, `not_composed`, `degraded` while its hooks are suspended); versions awaiting review are named.
- `show <id>`: One plugin: its state (under a live owner its phase, or ``not loaded yet (restart `tavi serve` to load it)`` for an enabled one the owner has not loaded, `not loaded in the running owner` for a disabled one), its versions and their review state, hash and install time (`installed 2026-11-03 16:30 UTC`) — a `--dev-plugin` folder instead has one `dev` row naming the folder it is loaded from and that it runs unsandboxed in the owner's process, as nothing was installed or reviewed — its declared tools with their effects (`tools: none` without any), a routing provider it declares (what it would receive, how it is priced, and that it is shared across workspaces), and its settings (`settings: none` without any). A long line — the description, a version's network domains — goes on indented at spaces, to the terminal's width or 80 columns in a pipe; a tab-separated row is left whole. For a plugin with hooks or commands — built-in or external — its commands, each hook with how it fails and what it can read, under a live owner each event's hook time (median and worst `over its last call` or `over its last <n> calls`, up to 100 dispatches), and its hook activity (`<n> decisions, <n> failures`, then the newest rows, each timed as `2026-11-03 16:30 UTC`). `tavi approvals show` lists a round's call inputs masked when `tools.redactResults` is on, as the inbox's headlines always are.
- `install <path>` (alias `add`): Install a plugin directory as a proposed version awaiting review, and print the `tavi plugins approve <id> <version>` that approves it — with `--in-process` for a plugin whose code cannot run as a confined worker, or whose manifest asks to run in-process (`isolation: "in-process"`), saying it then runs unsandboxed in the owner's process. Refused: symbolic links; special files; more than 500 files, 20 MB, 500 directories or a depth of 32; an id in the reserved `tavi.` namespace; more than 50 versions of one plugin or 100 plugins.
- `validate <path>`: Check a plugin directory as `install` would — the strict manifest, its entry and ui files, the module rules and the size limits — without installing it, and print its id, version and hash. On macOS, and on Linux where the sandbox works (`tavi sandbox check`), it then runs the entry's `register` in the runtime sandbox (no network, no writes, an empty environment, 10 s) against a context that only records what it is handed, and compares that with the manifest: a hook, command, tool, provider, channel or router the manifest does not declare, or a hook whose match is wider than declared, is an error; a declaration `register` never adds, and a hook that can fail more than one way but states no `onFailure`, are warnings. Elsewhere `register` is not run, and the report says so. Needs no owner or data directory (`--data-dir`, given or from `$TAVI_DATA_DIR`, is accepted and unused); it makes a sandbox engine of its own and closes it when done, while the `plugins.validate` tool inside `serve` uses `serve`'s (its tier, `--sandbox-nested` and `--fs-root` check). Exit `0` valid, `1` not valid; `--format json` prints the report (`problems`, `warnings`, `registered`, `skipped`).
- `approve|reject <id> <version>`: Review a proposed version; `reject` also revokes an approved one, and the loaded version is withdrawn immediately. A rejection is final: install a new version to review again. `show` lists what each version itself declares, so a review sees the version it decides on. An approval records where the version runs: as a confined worker by default; in the owner's process, unsandboxed, only with `--in-process`. A version that cannot be a worker (it supplies messaging channels, search, fetch or model providers, a routing, heartbeat or memory provider) or whose manifest asks `isolation: "in-process"` is refused (`CONFLICT`, exit `2`) without the flag. The answer says which: `approved, runs as a confined worker` or `approved, runs UNSANDBOXED in the owner's process`. Approving an already-approved version changes only where it runs: one approved before workers (no isolation recorded, so in-process) becomes a worker, or the other way with the flag; the same choice again changes nothing, and a change to the running version asks for a restart. `list` tags an external plugin that runs code `worker` or `UNSANDBOXED`, `show` prints each version's isolation, why it cannot be a worker, its `network domains` and its raw secrets, and `doctor`'s plugin entries carry `isolation` (and `unsandboxed: true`, with the `audit` findings for an enabled one).
- `audit`: For each enabled plugin running in the owner's process, what it would lose as a worker, read from its approved files without running them: files it opens, hosts it names that its manifest's `network.domains` does not declare, the environment (`process.env`), child processes, native addons, and why it cannot be a worker at all when it cannot. A static reading: it can miss what code builds at run time.
- `remove <id>` of an MCP server's last version also runs its remove hook: its home (`<data-dir>/mcp/<id>/`), its credentials, its notices and every session approval of its tools are deleted, it leaves every workspace's `mcp.servers` and `mcp.people`, and allow rules still naming its tools are listed. Removing one of several versions removes only that version.
- `enable <id> [--version <v>]`: Run a built-in again, or an external plugin's approved version (the newest approved one by default). Required settings must be set first. An MCP server (`mcp.<name>`) also joins the `default` workspace's `mcp.servers`, and on a running owner its tools are offered from the next turn with no restart; one set to `exposure: always` whose tools would not fit the workspace's tool budget is refused with the count.
- `disable <id>`: Withdraw a loaded external plugin immediately and exclude it from the next start. A core built-in is refused (exit `2`). A routing provider (`tavi.router`, or a plugin that declares one) also stops routing at once in a running owner. If the withdrawn plugin's cleanup fails, the change still commits: the answer carries `cleanupWarning` (printed as `warning:`), and the plugin shows `failed` with the cleanup errors.
- `config <id> [--version <v>] --set <key>=<value> ... --unset <key> ...`: An external plugin's settings. Keys and types come from the manifest (`string`, `number`, `boolean`: `--set days=3`, `--set metric=true`; `credential`: a reference under `plugins.<id>.`, never the secret — store the value with `tavi credentials set plugins.<id>.<name>`); an unknown key or a wrong type is refused (exit `2`), and a required one cannot be unset from an enabled plugin. With `--version`, the settings are checked against that version's manifest, which prepares an upgrade whose settings differ; `enable --version` then drops keys the new version does not declare.
- `remove <id> [--version <v>] [--yes]` (alias `rm`, `delete`): Uninstall an external plugin (or one version), deleting its snapshot. An enabled plugin must be disabled first. Removing the last version of a channel plugin whose channel purges on removal schedules the same purge for each of its connections, 24 hours on. Without `--yes`, such a removal is refused first with what its connections would erase (conversations, messages, files); `--yes` goes ahead ([CHANNELS.md](CHANNELS.md#removal-and-purge)); the answer names them, and installing it again before then cancels it as each connection opens. `disable` keeps everything.
- `ui <action>`: The web canvas's UI plugins for one workspace; see `tavi plugins ui` below.

#### Options
- `--version <v>`: The version `enable`, `config` or `remove` acts on.
- `--set <key>=<value>`, `--unset <key>`: Repeatable, for `config`.
- `--in-process`: For `approve`: run the version in the owner's process, unsandboxed, rather than as a confined worker.
- `--instances <json>`: Replace the complete structured provider instance list for `config`; `[]` clears it. Each instance names its factory, workspace, account, settings and credential references. See [provider configuration](PLUGINS.md#provider-descriptor-v2-and-local-data).
- `--format <text|json>`, `--data-dir <path>`.

Exit codes: `0` done; `2` a usage error, a refusal (`INVALID_INPUT`, `CONFLICT`: not approved, core, immutable version, missing setting); `4` an unknown plugin or version.

Two kinds are listed:
- **Built-in** plugins are composed from this build (`tavi.persistence`, `tavi.schedules`, …). One that provides a service other plugins need is **core** and cannot be disabled; the others (`tavi.router`, `tavi.retention`, `tavi.agentwaitscheduler`, `tavi.schedules`, `tavi.reminderrule`, `tavi.reminders`, `tavi.tasksummaries`, `tavi.telegram`, `tavi.mailgun`, `tavi.gmail`, `tavi.collectors`, `tavi.flights`, `tavi.siteskills`, `tavi.memoryprovider`, the engines `tavi.browser`, `tavi.pdf` and `tavi.video`, and `tavi.guard`, which is off until enabled) can be, and composition then leaves them out; the confinement (`tavi.sandbox`, `tavi.limits`, `tavi.worker`) and `tavi.localmessaging`, the connection the terminal's and canvas's chats go through, are core. Disabling `tavi.router` also stops routing in a running owner immediately. Their own settings stay with their commands (`tavi schedules`, `tavi channels`).
- **External** plugins are directories with a `tavi-plugin.json` manifest and an ES module entry (see [PLUGINS.md](PLUGINS.md) for the format and the module API). `install` copies the directory into `<data-dir>/plugins/<id>/<version>/`, hashing every file; the version is **proposed** and runs only once it is **approved** and **enabled**. Installed versions are immutable: the same bytes again are a no-op, changed bytes need a new version.

#### `tavi plugins ui`

Which UI plugin fills each canvas role, and where contributions are shown, for one workspace: the `uiRoles` and `uiPlacements` settings (Settings → Plugins → **Canvas** offers the same, with the same checks; `tavi config set ui.placements` writes the JSON as given, without them; `tavi config set ui.roles` accepts only the built-in or `off`). Each write is a compare-and-set on the revision just read. Every open page picks a change up at once; nothing needs a restart.

```bash
tavi plugins ui list [--workspace <id>] [--format text|json]
tavi plugins ui set-role browser-view <plugin-id|builtin|off> [--yes]
tavi plugins ui place <plugin-id>/<contribution-id> <slots|hidden|default> [--show while-active|always]
```

- `list`: The plugin filling each role (`tavi.browserview (built-in)` by default), a warning for a chosen plugin that can no longer fill it (not enabled and approved, or not declaring the role — the built-in fills it meanwhile), and every enabled contribution: shown or not, its slots (`(chosen)` or `(hidden)` when overridden), the channels it receives. `--format json` gives `{ roles, placements, fallbacks, contributions }`.
- `set-role <role> <plugin>`: Only an enabled plugin with an approved version that declares the role can be chosen; `builtin` goes back to the built-in, `off` shows none. A plugin that receives a channel (the browser's pages) is chosen only with `--yes`: without it its disclosure is printed and the command exits `2`. Approving a plugin is not consent to let it watch the browser. For one that declares `browser.control`, the same disclosure says what that asks for — seeing and typing into pages you take over, sign-in pages included — and that the plugin is not given them: taking the browser over always uses Tavi's own surface.
- `place <key> <where>`: Comma-separated slots (`chat.panel.top`, `chat.panel.tab`, `overlay.takeover`, `center.browser`, `center.heartbeat`) instead of the manifest's — keeping the manifest's height and timing for a slot it had, `--show` to set when its `chat.panel.top` slot shows — or `hidden`, or `default` for the manifest's own again. A placement the canvas's choices do not express shows there as "Chosen elsewhere".

Exit codes: `0` done; `2` a usage error, an unknown role, slot or contribution, an unconfirmed disclosure, a plugin that cannot fill the role, or a change made elsewhere meanwhile (a conflict: run it again); `4` no owner reachable when one is needed.

#### Trust and what runs
An external plugin approved as a worker runs in its own confined Node process: its version folder and home readable, its home writable, its manifest's `network.domains` reachable through its own proxy, its credentials placeholders put back toward their exact hosts (see [PLUGINS.md](PLUGINS.md#trust)). One approved `--in-process` (or before workers) runs **inside the owner's process with its privileges**. Either way approval is the trust decision, so approve only code you have read.

What the owner loads at start is exactly what was approved: before importing, it re-hashes the snapshot and refuses one that changed on disk since.

A plugin's tools are registered only if it declared them in its manifest, under `<plugin-id>.<tool>`, with the manifest's description and effect (`read-only`, `mutating` or `external`) — never the code's — so the approval policy applies to them as to any tool: `mutating` and `external` tools need an approval round unless `serve --allow <tool>` exempts them, and an unattended schedule reaches them only through its tool policy.

A plugin that fails to load or start is reported (`failed`, with the error) and contributes nothing: every tool is checked before any registers, and a plugin whose `start` failed has its tools kept out of every offer and refusing calls. The owner and the other plugins start regardless.

The deadlines catch asynchronous hangs only. A synchronous loop blocks start, and an uncaught background exception can stop the owner; run `tavi plugins disable <id>` offline to recover.

The full prepared artifact is hashed; bare package imports, computed imports and CommonJS are refused. Enable and configuration changes activate at the next start; disable and loaded-version rejection withdraw contributions immediately.

An MCP server is a plugin too (kind `mcp`, id `mcp.<name>`): `tavi plugins` lists, configures, enables and removes it, but its approval goes through `tavi mcp` (below), and `plugins approve|reject` on one refuses, naming the command.

### `tavi mcp`

Add, probe, review and approve MCP servers ([MCP.md](MCP.md); also in Settings → Plugins → MCP servers). Under a live `tavi serve` each action runs on the owner over IPC; otherwise on the data directory. Only the operator can: no tool, chat or channel reaches these.

```bash
tavi mcp add <name> --url <url> [--header Name=value|Name=[prefix]@setting]... [--lan] [--oauth]
tavi mcp add <name> --npm <package>@<exact version> [-- <args>...]
tavi mcp add <name> --pypi <package>==<exact version> [-- <args>...]
tavi mcp add <name> --dir <path> -- <argv>...
tavi mcp add <name> --command <abs-path> -- <args>...
tavi mcp add <name> --mcpb <file> [-- <args>...]
tavi mcp add <name> --registry <server>[@<version>] --option npm|pypi|mcpb|remote
tavi mcp search [<words>] [--cursor <c>]
tavi mcp registry [<url> | --default]
tavi mcp add <name> --preset homeassistant|google-maps|todoist|todoist-token
#   stdio forms (--npm, --pypi, --dir, --command, --mcpb) also take:
#   [--env K=V|K=@setting]... [--secret <setting>]... [--domain <d>]... [--read <path>]... [--write <path>]... [--nested|--unsandboxed]
#   a header or env value fed by @setting is set with: tavi plugins config mcp.<name> --set <setting>
#   every form also takes: [--exposure auto|always|search] [--version <x.y.z>] [--name <text>] [--description <text>] [--no-probe]
tavi mcp import <file> [--dry-run] [--no-probe]
tavi mcp probe <id> [--version <v>] [--nested|--unsandboxed]
tavi mcp show <id> [--version <v>] [--full]
tavi mcp review <id> [--version <v>]
tavi mcp approve <id> <version> [--effect <tool>=<effect>]... [--floor <tool>=<risk>]... [--timeout <tool>=<ms>]... [--disable <tool>]... [--nested|--unsandboxed]
tavi mcp reject <id> <version>
tavi mcp verify <id> [--version <v>] [--full]
tavi mcp logs <id> [--lines <n>]
tavi mcp login <id> [--no-open] [--port <n>] [--paste | --public]
tavi mcp logout <id>
tavi mcp line <id> [<text> | --clear]
tavi mcp people <id> on|off [--workspace <w>]
tavi mcp list [--workspace <w>]
tavi mcp on | off
tavi mcp remove-all [--yes]
```

#### Actions
- `add`: Writes the server's manifest and installs it as a **proposed** version (`<data-dir>/plugins/mcp.<name>/<version>/`), then probes it unless `--no-probe`. Its launch spec (command or address, network, auth) is printed once: at the head of the probe's review, or above `not probed` without one.
  - `--url` is a remote server (https; plain http and private addresses only with `--lan`); a header fed by `@setting` becomes a credential setting.
  - `--npm` fetches the exact version with `npm install --ignore-scripts --no-bin-links --omit=peer` and an empty config, from the public registry only: every lockfile entry must carry its integrity and the top package's must equal npm's; a package anywhere in the tree with an install script, one that downloads a browser, or one that needs a missing peer is refused, naming it; prebuilt native files are listed and deprecated packages warn.
  - `--pypi` needs `uv` and an interpreter it manages: `uv pip compile --generate-hashes` pins the closure from public PyPI, `uv pip install --require-hashes --only-binary :all: --target` installs wheels only (an sdist-only package, or a hash that does not match, is refused), with no uv config read and no interpreter downloaded; the interpreter is pinned by path and SHA-256 in the manifest (`interpreter`) and checked before each start, and the server runs as `python -I -B` from its console script.
  - `--dir` copies a local server (its argv paths become `${package}/…`; `-- python …` pins the uv-managed interpreter the same way).
  - `--command` names a system binary, hashed when approved and checked at each start.
  - `--mcpb` reads a `.mcpb` bundle strictly (stored or deflated entries, no encryption, symbolic link, path outside it or name twice, every checksum checked, within the package limits), copies its files with the server and records the bundle file's SHA-512; its `server.mcp_config` (with this platform's override) is the command — Node on Tavi's Node, Python on the pinned uv interpreter with its `PYTHONPATH` folders first, a binary inside the bundle — and its `user_config` the settings, a `sensitive` field a credential.
    - A `uv` bundle, a setting inside an argument, a folder outside the bundle (`${HOME}` …) or another platform's bundle is refused; an appended signature is shown, never checked or trusted (MCP.md *Bundles*).
  - `--registry` reads an MCP Registry entry again at that version (`latest` when none) and adds the way in `--option` names, as `search` lists them: npm or PyPI at an exact version, a bundle downloaded over https and checked against the entry's SHA-256, or a Streamable HTTP remote; its environment variables and headers become settings, a secret one a credential.
  - `--preset homeassistant` writes Home Assistant's manifest (its `url` and `token` settings, the token a credential, `lan`), its settings set after with `tavi plugins config`; its floors join each tool's suggestion at `approve` (MCP.md *Home Assistant*).
  - `--preset google-maps` writes Google's Maps Grounding Lite server (its `apiKey` credential setting, sent as `X-Goog-Api-Key`); its six tools keep their read-only annotations (MCP.md *Google Maps*).
  - Launchers that download code at every start (`npx`, `uvx`, `bunx`, `pnpm dlx`, `docker`) and loader variables (`NODE_OPTIONS`, `LD_*`, `DYLD_*`, `PYTHONPATH`, `PYTHONHOME`, and Windows' `SystemRoot`, `ComSpec` and `PATHEXT`, in any case) are refused, and so are proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`), since the sandbox sets a server's proxy itself.
  - Options go before `--`; after it comes the server's own argv.
- `search`: A page of the MCP Registry's latest versions (30 at a time; `--cursor` for the next): each entry's labels (`installable`, `remote`, `<type>-unsupported`), the `add` for each way in, and why the rest cannot be added. The listings are cleaned and are not a trust signal.
- `registry`: Shows the registry searched (the official `https://registry.modelcontextprotocol.io` unless named), names another (https only), or goes back with `--default`. A page can read it, not change it.
- `import`: Reads the servers in another client's file — `mcpServers` (Claude Desktop, Cursor, `.mcp.json`, and each project's in `~/.claude.json`), VS Code's `servers` or `mcp.servers` (comments allowed) — and adds each one through `add`, `credentials set`, `plugins config` and `probe`: `npx -y pkg[@tag]` becomes `--npm pkg@<exact>` as npm resolves it now; `uvx pkg[@version]` becomes `--pypi pkg==<exact>` as PyPI names it; a literal secret (a secret-looking variable, a variable whose value is a URL with a password or a well-known token — then declared with `--secret` — an `Authorization` or secret-looking header) moves into the credential `plugins.mcp.<name>.<setting>`; `${input:…}` and `${env:…}` become settings to set; an absolute command becomes `--command`. Skipped, each with why: `uvx --from`, `docker`, `pnpm dlx`, a shell, an SSE server, plain http, a url carrying a secret, a secret in an argument (a URL with a password, a token, the value of a `--api-key`-like flag), a placeholder mixed into other text, a relative local command, a range, a name already taken. The file is only read and nothing is approved. `--dry-run` lists the commands without a secret; `--no-probe` skips the probes (a server with a setting left to set, or a login, is not probed). Exit `1` if a server failed to add.
- `probe`: Starts the server and lists its tools; no tool is called. A stdio server runs under its own `srt` process (Seatbelt on macOS, bubblewrap on Linux) with its own home (`<data-dir>/mcp/mcp.<name>/home`), no reads of `$HOME` beyond the runtime in use, no network but its granted domains, and an environment built from scratch; where srt cannot run, the probe refuses with the cause and its fix (missing `bwrap` or `socat`, AppArmor's user-namespace limit, a container), naming `--unsandboxed` (or `--nested` in a container that masks `/proc`), which is then recorded with the version. The same live check runs before every start and in `tavi doctor`. A remote server is reached through the guarded fetch (no redirects, the address pinned, metadata addresses never). The era (2025 `initialize` or 2026-07-28 `server/discover`) is negotiated once here and reused. More than 128 tools fails the probe.
- `show`: The review: the exact command or address, its `tools.search` line and the schema tokens of its approved tools (the line once a tool is approved, or you wrote one with `tavi mcp line`), the sandbox state, where calls go and which credentials the server receives, the protocol, the server's instructions (shown to you, never to the model), and each tool with its Tavi id, its suggested effect and floor (from its annotations, with the spec's defaults: an unannotated tool is an external write with a `high` floor; `readOnlyHint: true` wins), and its marks — **DOUBTFUL** (claims read-only but has a write name), **FLAGGED** (its description, title or schema prose reads like instructions, each place named by its JSON pointer), **SCHEMA** (its input schema cannot register). `--full` adds each tool's input and output schemas, cleaned (no control, zero-width or bidirectional characters, forged fences quoted, prose cut at 300 characters), as the model is shown them.
- `review`: `show` for what waits after a change: the server's open notices first (drift, failed, budget), then each tool marked `CHANGED since it was approved` (withheld), `NEW` (pending), or `(unchanged: as decided for <version>)`. Running servers are listed again on every connect and every 15 minutes in use: a changed tool is withheld and withdrawn and its session approvals deleted, a new one waits, a removed one is withdrawn, more than 128 tools fails the server.
- `approve`: The trust decision for every tool at once, in one transaction. A tool whose definition is unchanged from an earlier approval (this version's, or an earlier version's) takes that decision unless an option changes it, and a disabled one stays disabled; so after a drift or an upgrade only changed or new tools need `--effect` when marked. Approving closes the server's drift notice. Each tool takes its suggestion unless `--effect`, `--floor` (`critical` asks every time, once only) or `--timeout` (1000 to 600000 ms, default 60000) says otherwise; `--disable` keeps one out. A doubtful or flagged tool has no default: it needs `--effect` or `--disable`. A version probed `--unsandboxed` or `--nested` needs the same flag again. Every tool of a server that can reach the network asks once in a tainted chat, and so does every write of one that cannot.
- `reject`: Rejects a version; its tools become `rejected`.
- `logs`: The last `--lines` (default 100) lines of the server's log (`<data-dir>/mcp/mcp.<name>/server.log`, 512 KiB and one rotation): starts, connections, the protocol, each call by tool, outcome, duration and input digest (never its arguments), and its stderr, cleaned, with credential-shaped text scrubbed and every credential value it was given masked. Reads the data directory, with or without a running owner.
- `list`: Every server: its state (`running`; `stopped`, which is idle; `backing-off`; `failed`; `login-required`; `disabled`; every one `off` while MCP is off; `unknown` with no owner running), its sandbox state, exposure, the tools it lists against the workspace's budget (`default lists 6 of 75 MCP tools`) and whether they sit behind `tools.search`, whether the workspace's `mcp.servers` allows it and `mcp.people` opens it, proposed versions and tools waiting for review, and open notices.
- `on` / `off`: The owner's kill switch `mcp.enabled` (on by default; an owner that adds no server runs none), with or without a running owner. Off, no server starts and no MCP tool is offered: on a running owner every server stops and every tool is withdrawn at once; offline, the next start registers none. Adding, probing and reviewing work either way.
- `remove-all`: The `tavi plugins disable`/`remove` commands that remove every server (before downgrading below the MCP release); `--yes` runs them.
- `login`: Signs in to a server added with `--oauth`, through the running owner: a listener on 127.0.0.1 takes the server's redirect back (or the owner's public https address, when set), the https sign-in page is opened, never through a shell (`--no-open`, or any other address, prints it), and the command waits until it is signed in, failed or 10 minutes have passed. Refused before anything opens: an authorization server with no metadata, without PKCE (S256), with an endpoint that is not https or a loopback address, or whose issuer does not match; a private address without `--lan`. The client is a pre-registered one (`clientId`, credential `clientSecret` settings), else CIMD with a public https address, else dynamic registration (`client_name` `Tavi`, `application_type` `native` or `web`), else the login says to register one. The grant is stored as `plugins.mcp.<name>.oauth`, keyed by issuer. The sign-in page's address carries the flow's `state`: on macOS the opener reads it on stdin; elsewhere it is on the opener's command line, where other accounts on the computer can read it, so after opening it the login prints a line on stderr advising `--no-open` on a shared computer. `--port` fixes the listener's port (1024 to 65535; any free one by default), for a client that registers its redirect URI exactly, as a Google Web client does. A preset may add to the authorization request (Google's: offline access and its calendar scopes).
- `line`: The server's line in `tools.search`'s description while its tools wait behind search: your text (one line, at most 300 characters), or with `--clear` Tavi's own — your name for the server, its approved tools' count and Tavi names, never the server's text. The line is shown only in workspaces whose `mcp.servers` allows the server, and in other people's chats only with `mcp people … on`; it applies on the next turn. `show` prints it with the schema tokens every approved tool would cost.
- `login --public` comes back to the owner's https address instead of this computer; `--paste` prints the sign-in address and reads the address the browser lands on from stdin, the headless path with no tunnel (as `tavi apps connect`).
- `logout`: Revokes the grant where the server offers revocation, and deletes it; works with no owner running.
- `people`: Whether chats of other people bound on channels in the workspace (default `default`) are offered the server's tools (`mcp.people`); their calls then run with the operator's credentials for it. Off by default. Says so when the server is not yet in the workspace's `mcp.servers`.
- `verify`: Checks the installed files against what was approved: by the stored index (re-hashing only files whose size, mtime or inode changed), or every byte with `--full`, which also rewrites the index. After a restore every index is stale, so the next check re-hashes in full. Exit `1` when the files differ.

#### Options
- `--exposure <auto|always|search>`: Sets how its tools reach the model (`auto`, the default: listed with at most eight tools, else behind `tools.search`; `always`; `search`).
- `--version <x.y.z>`: Sets its plugin version (default `1.0.0`; a changed launch spec is a new version).
- `--name <text>`, `--description <text>`: Set what it is called and described as (the name is yours, never a bundle's or a listing's).
- `--no-probe`: Leaves the probe for later.
- `--env KEY=value | KEY=@setting`: A stdio server's variable (repeatable).
- `--secret <setting>`: Declares a setting an `--env` names a credential whatever its variable is called (`DATABASE_URL=@db --secret db`).
- `--domain <domain>`, `--read <path>`, `--write <path>`: Grant a stdio server a domain or a folder (a domain is reached only through that server's own proxy, needs Node 22.21 or later for a Node server, and never runs unsandboxed); `$HOME`, the data directory and other tools' credential folders are refused.
- `--workspace <w>`: The workspace `people` and `list` act on (default `default`).
- `--format <text|json>`: Output format (default: `text`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).
- Each action's own flags (`--full`, `--lines`, `--effect`, `--floor`, `--timeout`, `--disable`, `--nested`, `--unsandboxed`, `--no-open`, `--port`, `--paste`, `--public`, `--clear`, `--yes`, `--dry-run`, `--cursor`, `--default`, `--lan`, `--oauth`, `--header`) are described with it above.

Exit codes: `0` done; `1` verify found a difference, or an import's server failed to add; `2` a usage error or a refusal; `4` an unknown server or version.

---

### `tavi apps`

Connected apps ([APPS.md](APPS.md)) is every account and app, whatever its kind: MCP servers, channel connections and plugins. It shows each one's health and its fix, as Settings → Connected apps does. It needs a running owner (`tavi serve`). `tavi mcp` and `tavi channels` keep their own verbs: review, approve, ingress, people and logs.

```
tavi apps list [--needs-you]
tavi apps catalog [<words>] [--cursor <c>]
tavi apps add <preset> [--switch] | <registry-name>@<version> --option npm|pypi|mcpb|remote
tavi apps show <app>
tavi apps connect <app> [--account <id> | --add-account] [--no-open] [--port <n>] [--public | --paste]
tavi apps disconnect <app> --account <id> [--remove]
tavi apps test <app> [--account <id>]
tavi apps activity <app> [--account <id>] [--cursor <c>]
tavi apps permission <app> <tool> allow|ask|block
tavi apps sharing <app> <account> personal|shared
tavi apps mailbox <app> <account> off|read|send
tavi apps calendar <app> <account> on|off
tavi apps receive <app> <account> on|off
tavi apps sites <app> <site> on|off
tavi apps client <app> --file <path> | --id <client id> [--secret-file <path>]
tavi apps remove <app>
```

#### Actions
- `list`: Each app with its health and accounts, and its fix with the command for it. `--needs-you` shows only the apps that need you.
- `catalog`: Tavi's presets, the apps installed but not set up, and the channels, each with the command that adds it. Words also search the MCP Registry.
- `add`: Adds a preset by its id, or a registry entry by `<name>@<version>` and one way in, as `tavi mcp add --registry` does. It then names the next step: `tavi apps connect <app>` for an app that signs in, or, for one that takes a key or token (Google Maps, Todoist (API token), Home Assistant), Connected apps' sheet or the `tavi credentials set plugins.<plugin>.<key> --file <file>` and `tavi plugins config <plugin> --set <key>=…` that store it. Todoist's two presets (`todoist`, signing in, and `todoist-token`) reach one server, and Tavi keeps one: adding the other is refused with the switch to use, and `--switch` removes the one there (its sign-in or token, its approval) and adds the other as the same `mcp.todoist`, to be reviewed again.
- `show`: One app: its accounts, what each tool may do, where its calls go, and what it returns.
- `connect`: Signs an MCP account in, or in again, as `tavi mcp login` does:
  - with no flag, the browser comes back to this computer, on any free port (`--port` names one, for a tunnel);
  - `--public`: comes back to the owner's https address;
  - `--paste`: prints the sign-in address, then reads the address the browser lands on from stdin. This is the headless path with no tunnel.

  `--add-account` adds a preset's next account (`mcp.todoist2` …), then signs it in the same way. A channel connects with `tavi channels connect`.
- `disconnect`: Revokes the account's sign-in where the provider allows it, and forgets it. Google revokes a sign-in for every client of its Cloud project, so while another app holds a grant for the same project and account, the sign-in is only forgotten here and the output names the app that keeps it. `--remove` also removes a second account.
- `test`: Calls the account once (the app's first account by default).
- `activity`: What the app's tools changed or sent, what you were asked about them, and its read-only tools' calls, newest first. A mailbox's tools count as its channel app's, by account.
- `permission`: The page's own rule for one tool. An MCP tool that changes or sends something is never allowed without asking.
- `sharing`: Personal (only your own one-to-one chats) or Shared (people you allowed may use it).
- `mailbox`: What the agent may do in a mailbox account (a Gmail connection): `off`; `read`, its own search, read and draft tools; or `send`, also sending drafts you approve, each shown whole before it goes and never by a run nobody attends.
- `receive`: Whether a channel account takes messages in (a Google account's *Reach Tavi by email*); off, it only carries its mailbox's and calendar's tools, and asks Google for nothing of Gmail's unless its mailbox is on.
- `calendar`: Whether the agent may use the account's calendar (a Google account's): its read and free-time tools run without asking, each event it adds, changes or answers asks first, and deleting one asks every time. Turning it on asks Google for the calendar's access at the account's next sign-in.
- `sites`: Lets the agent browse a site the app's profile names, within the profile's rules and budgets, or stops it; every site is off until you turn it on. It also takes the id of a site note the app ships, where no site profile shares it ([PLUGINS.md](PLUGINS.md)).
- `client`: Sets the OAuth client every app of the app's provider shares (Gmail's and Calendar's, for Google), from either app: the client file its console downloads (`--file`, a Google *Desktop app* client's `client_secret_….json`; a Web client's is refused), or its id with the secret read from `--secret-file`, never an argument. The secret is kept only in an encrypted credential store; a channel's other settings stay with `tavi channels`. Changing it signs out a channel's sign-ins made with the old one (Gmail's), to be connected again.
- `remove` (alias `rm`, `delete`): Removes the app and every account of it.

#### Options
- `--needs-you`: `list`: only the apps that need you.
- `--cursor <c>`: `catalog`, `activity`: the next page.
- `--option npm|pypi|mcpb|remote`: `add`: the registry entry's way in.
- `--account <id>`: `connect`, `disconnect`, `test`, `activity`: the account (the app's first account by default for `test`).
- `--add-account`: `connect`: add a preset's next account first.
- `--no-open`: `connect`: print the sign-in address instead of opening a browser.
- `--port <n>`: `connect`: the port to come back on (any free one by default), for a tunnel.
- `--public`, `--paste`: `connect`: come back to the owner's https address, or paste the address the browser lands on.
- `--remove`: `disconnect`: also remove a second account.
- `--file <path>`: `client`: the client file the provider's console downloads.
- `--id <client id>`, `--secret-file <path>`: `client`: the OAuth client id, and the file its secret is read from.
- `--workspace <id>`: The workspace (default: `default`).
- `--format <text|json>`: Output format (default: `text`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

Exit codes: `0` done; `2` a usage error; `4` no owner running.

---

### `tavi sandbox`

Whether shell commands (`sandbox.run`), local (stdio) MCP servers and PDF processing can be confined on this host, and the one-time root step some Linux hosts need.

```bash
tavi sandbox <check|setup> [options]
```

#### Actions
- `check`: Runs the live probe (a denied read, an owner temporary file, a denied write, a `.git/hooks` write, a network connection, `AF_UNIX`/`AF_ALG` sockets and a Node child) and prints the tier — `full`, or `unavailable` with the cause and fix — and each check. `--nested` probes srt's weaker nested mode instead (`nested` when it works), as `serve --sandbox-nested` runs. Exit `0` when it confines (`full`, or `nested` under `--nested`), `4` otherwise. `--format json` prints `doctor`'s `sandbox` section.
- `setup`: Prints the root block this host needs: `bubblewrap`, `socat` and `ripgrep` when missing; on Ubuntu with the user-namespace restriction (24.04, and 25.04+ whose `bwrap-userns-restrict` profile denies srt's seccomp helper) a copy of the package-owned `/usr/bin/bwrap` at `/opt/tavi/libexec/bwrap` (root, mode 0750, the service's group), its package version and SHA-256 in `bwrap.source`, and an unconfined AppArmor profile with `userns` for that copy alone. It never writes a profile for `/usr/bin/bwrap`, never changes a sysctl and never copies from `PATH`. Nothing runs unless `--apply`, which runs the block with `sudo` after showing it. `--remove` undoes it; `--copy` makes the copy on a host that does not need it (an SELinux host, where it is labelled `bin_t` with `semanage` then `restorecon`); `--refresh-hook` adds an apt hook that re-copies after upgrades; `--group <name>` names the group that may run the copy, which must be the service account's (default: `tavi` when that group exists, else the group of the account that ran `sudo`, else yours; setup prints which). The block checks that `/usr/bin/bwrap` is root-owned, not group- or world-writable, owned by a package and unchanged from it (`dpkg --verify` / `rpm -V`), and makes `/opt/tavi` and `/opt/tavi/libexec` root-owned.

#### Options
- `--apply`: `setup`: run the block with `sudo` after showing it.
- `--remove`: `setup`: undo what setup did.
- `--copy`: `setup`: make the bubblewrap copy even where nothing restricts user namespaces (an SELinux host's choice).
- `--refresh-hook`: `setup`: also re-copy bubblewrap after every apt run.
- `--group <name>`: `setup`: the group that may run the copy: the service's (default: `tavi` when that group exists, else the group of the account that ran `sudo`, else yours).
- `--nested`: `check`: probe srt's weaker nested mode, as `serve --sandbox-nested` runs.
- `--format <text|json>`: `check`: output format (default: `text`).
- `--data-dir <path>`: `check`: data directory (default: `$TAVI_DATA_DIR`, else your user data directory); `setup` refuses it.

- `tavi doctor` has a `sandbox` section with the same answer, an `options` object with what the owner was started with (`pinnedOff`, `nested`, `pty`, `localBind`, `inspectTls`, `cache`), plus the copy's checks: root-owned, 0750, profile loaded, and the same bytes as its record and the distribution's current bubblewrap (a drift after an upgrade is a warning, with `tavi sandbox setup --apply` as the fix). Its facts come from the owner's host detection, as its tier does. It also lists, as `policy compile` warnings, what the running engine could not enforce here (srt's glob warnings, a write-deny pattern a run's policy held that Linux cannot express), which `serve` logs once each. Without `python3` the `socket families` check is a warning saying `AF_ALG` was not tried, with how many seccomp filters Tavi runs under.
- A running `serve` needs no restart after `setup --apply` or `--remove`: each `sandbox.run` reads which bubblewrap to use when it starts. At start, `serve` stops srt network-bridge `socat` helpers a killed owner left (only this user's, only with srt's exact arguments, only orphaned).

### `tavi service`

Generate the launchd or systemd unit, or Windows logon task, that runs `tavi serve` — and with it the
scheduler — so a reboot does not silently end the morning brief. Nothing is
installed: the unit is printed for you to review and place, and what it prints
last, on stderr, is the commands that install it (the ones its own header
gives).

```bash
tavi service <action> [options]
```

#### Actions
- `unit`: Render the service unit.

#### Options
- `--kind <launchd|systemd|task>`: Format (default: launchd on macOS, `task` on Windows, systemd on Linux). See [Windows: a logon task](#windows-a-logon-task).
- `--label <id>`: launchd label / systemd unit name / Windows task name (`schtasks /TN`) (default: `dev.tavi.serve`).
- `--node <path>`, `--executable <path>`: The node binary and tavi entry point the unit will exec.
- `--data-dir <path>`: Data directory the unit passes to `serve` (default: `$TAVI_DATA_DIR`, then your user data directory).
- `--log-dir <path>`: Directory for the service's stdout/stderr (created `0700` if missing). Its `tavi-serve.log` and `tavi-serve.err` are created `0600` beforehand, and an existing one is tightened to `0600`, so a log in a shared directory is never readable by other accounts.
- `--serve-arg <arg>`: Append an argument to the unit's `serve` invocation (repeatable, order preserved; `--dev-plugin` is refused: a service runs only approved plugins). **Pass the flags that make delivery work** — the token file, and the destination allowlist — or the unit starts `serve` with no connector and no allowlist, so the schedule fires and nothing is ever delivered.
- `--out <path>`: Write the unit here instead of printing it.

The unit sets `TAVI_SERVICE=1` in the owner's environment (launchd `EnvironmentVariables`, systemd `Environment=`; a Windows task's `serve --windowless` sets it on the owner it starts), so `serve` refuses `--dev-plugin` there.

#### systemd: a non-root, hardened unit
- `--user <name>`: The account `serve` runs as (default: `$SUDO_USER`, else a `tavi` system account the unit's header says how to create). Root is refused (`INVALID_INPUT`) unless `--allow-root`, which adds a warning header; a root owner is warned at every start and in `doctor`.
- `--group <name>`: Its group.
- `--scope <system|user>`: A system unit (default), or a `systemctl --user` unit (`WantedBy=default.target`, with the `loginctl enable-linger` hint).
- When `<data-dir>/credentials.key` refers to a key in the OS keychain, the command warns on stderr (any launchd or systemd kind or scope; a Windows logon task runs in your logon session, where Credential Manager is open, and is not warned): a system unit or launchd daemon has no login session to read it, and a lingering user unit finds the keyring locked, so encrypted credentials would fail `UNAVAILABLE`. The warning names `tavi credentials key --to-file --data-dir <dir>`, which moves the key into the `0600` file.
- `--credential <name=path>`: A `LoadCredential=` line (repeatable; system units). systemd hands the file to the unit at `/run/credentials/<label>.service/<name>`, which the unit's header names: pass that path to the `serve` flag that reads it (`--serve-arg=--api-key-file --serve-arg=/run/credentials/dev.tavi.serve.service/model-key`).
- `--credential-encrypted <name=path>`: A `LoadCredentialEncrypted=` line (repeatable; system units), for a file `systemd-creds encrypt` wrote; systemd decrypts it for the unit alone. Named `tavi-credential-key`, it is the credential key's home once `tavi credentials key --to-systemd` runs against the started unit, as the header says. The keychain warning above, for a system unit, also names that move.
- The unit's header says how to create the default `tavi` account (`useradd --system --home-dir /var/lib/tavi`) and to give it the data directory; that home is writable (`ReadWritePaths=-/var/lib/tavi`). A writable path holding whitespace is refused.
- The system unit sets `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK` (inherited by every sandbox, closing `AF_ALG` and the other families), `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict` with `ReadWritePaths=` the data directory, the `--log-dir` and every `--fs-root` among the `--serve-arg` flags, `Delegate=memory pids cpu` with `DelegateSubgroup=owner` (resource limits; on systemd older than 254 `serve` moves itself into `owner/`), `ProtectHome=read-only` unless one of those is under `/home`, `ProtectKernelModules=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `SystemCallArchitectures=native` and `RuntimeDirectory=tavi` (0700). It never sets `RestrictNamespaces=`, `PrivateUsers=`, `MemoryDenyWriteExecute=`, `ProtectControlGroups=yes` or `SystemCallFilter=`, which break bubblewrap or V8; a comment in the unit says why for each.

#### Windows: a logon task

`--kind task` renders a Task Scheduler task (`<label>.xml`) that starts `serve` when your account logs on, as your account with its least privilege (never elevated), with no time limit (Task Scheduler retries a start that fails, a minute later). A console program started at logon gets a window, so the task runs `serve --windowless`, which lets the window go and starts the owner again with none (as a service: `TAVI_SERVICE=1`), in a Job Object that ends with it; an owner that exits with an error is started again 5 seconds later; a clean stop ends the task, and so does a refusal (a usage error, `serve` unavailable here, or another owner holding the data directory), which a restart would only repeat. `--log-dir` is refused: the owner logs to its own log file (`tavi logs`). Write it with `--out` (printed, it is only for review): the file is then UTF-16, as `schtasks /Create /TN dev.tavi.serve /XML dev.tavi.serve.xml` reads it. Where a policy forbids your account to create tasks, a shortcut to the same command in the Startup folder (`shell:startup`) starts it at logon, without the restart. **Do not install it yet:** `tavi serve` itself is not yet available on native Windows (see the README), so the task would only start a refused owner at each logon. Run the owner under WSL2 until then; the task is for when `serve` runs on Windows.

#### Scope: the default unit is login-scoped

On macOS the rendered unit is a **LaunchAgent** (`~/Library/LaunchAgents`,
bootstrapped into `gui/$(id -u)`), which starts at *login*. That is right for a
laptop that is awake at 07:00 and wrong for a headless Mac mini, where nobody
logs in and the brief silently never runs. For a headless machine, render a
**LaunchDaemon** instead (or use the systemd unit on Linux) and check that
`launchctl print`/`systemctl status` shows it running after a reboot. The unit is
generated, never installed or reboot-tested, so that check is the operator's.

---

### `tavi remote`

Use a `tavi serve` running on another computer from this one, over SSH. See
[Using the owner from another computer](OPERATIONS.md#using-the-owner-from-another-computer).

```bash
tavi remote connect <ssh-target> [options]
```

#### Actions
- `connect`: Sign in to `<ssh-target>` (`user@host` or a `Host` alias from `~/.ssh/config`) with your own `ssh` — its config, keys and agent, and a password typed here when it asks — and keep a *mirror* directory on this computer connected to the owner there until Ctrl-C. While it runs, every client here (`tavi chat`, `tavi ui`, `tavi run`, `tavi tasks`, the configuration commands) reaches that owner by naming the mirror: `--data-dir ~/.tavi-remote/<host>` or `TAVI_DATA_DIR=~/.tavi-remote/<host>`.
  - The mirror holds the owner's discovery, its endpoint rewritten to a local socket that SSH forwards to the owner's socket there, and a copy of its token (`0600`, in a `0700` directory). The owner's own socket is reached through a link in a private temporary directory on the remote computer (`mktemp -d`), since ssh cannot forward a path with a space in it; it is removed on disconnect.
  - Each installed plugin version's folder there (`plugins/<id>/<version>`) is copied into the mirror's `plugins/`, whole, so the canvas here (`tavi ui --data-dir` the mirror) serves a plugin's own pages and app icons as it does there; it checks each folder against the hash the owner approved, as always. A version installed there is copied when it appears, one removed there is removed here, and all are copied again when the owner restarts. A copy that fails is said on stderr and leaves those pages unserved.
  - It reads the owner's discovery again every 2 seconds: an owner that restarts is followed (its new session and token are copied, and said), and one that stops is withdrawn from the mirror, so a client says it cannot reach it. A dropped connection is signed in again every 5 seconds (said, and the clients reconnect on their own); the first sign-in failing exits `4`.
  - `remote.json` marks the mirror. It holds no data of its own: a client never falls back to opening it when the owner cannot be reached (exit `4`, naming `tavi remote connect`), no offline command can take it, and `tavi serve` refuses it (exit `4`).
  - A client of a mirror sends the owner no folder of this computer: `tavi run` and `tavi chat` send no working directory (a new chat works in its own folder there), and a folder named with `--folder`, `/folder set|add` or `tavi tasks folder set|attach` is the remote computer's: `~` is the SSH user's home there, an absolute path is taken as written, and a relative path is refused (exit `2`).
  - The owner's computer must run macOS or Linux, and the SSH user must be the one that runs `tavi serve` there. Both sides should run the same tavi version: a client refuses an owner speaking another IPC protocol, and `connect` warns of it.
  - Anyone who can act as your user on this computer can use the owner while it is connected, as anyone who can act as that user there can.

#### Options
- `--data-dir <path>`: The mirror directory (default: `~/.tavi-remote/<host>`; never `$TAVI_DATA_DIR`, which names this computer's own data). It must be empty or an earlier mirror of the same target, and have no space or colon in its path and be short enough for a socket (exit `2` otherwise). A second `connect` on a mirror one already keeps is refused (exit `4`).
- `--remote-data-dir <path>`: The owner's data directory there (default: Tavi's default for that user: `$XDG_DATA_HOME/tavi` when set, else `~/Library/Application Support/tavi` on macOS and `~/.local/share/tavi` on Linux). Absolute, or `~/…` for the SSH user's home.
- `--ssh-option <opt>`: Pass `-o <opt>` to every ssh call (repeatable), e.g. `--ssh-option Port=2222`.

### `tavi prune`

Delete finished message-delivery records older than a cutoff: processed inbox
messages, held messages from senders nobody allowed, resolved outbox sends,
delivered/expired/rejected messages between agents (mailbox envelopes), and
settled waits (wait intents).

```bash
tavi prune [options]
```

#### Options
- `--older-than <days>`: Keep rows newer than this (default: 30).
- `--dry-run`: Count what would go; delete nothing.
- `--include-artifacts`: Also delete artifacts past the window — a screenshot per `browser.capture`, a download, an archived tool output. **Never** a `pending` artifact (an undecided review item) and never a report PDF a `tavi_reports` row references, unless `includeReports` is set by a caller. Off by default, because the brief is the deliverable and this is the operator saying the rest may go.
- `--format <text|json>`, `--data-dir <path>`, `-h, --help`.

The transport tables grow one row per inbound message, per send, per delegation
and per suspension, and nothing pruned them — so the path from a long-lived
daemon to "the disk is full, and then the alert about the disk being full cannot
be written" had no gate on it. `serve` runs this same sweep every six hours with
the default 30-day window; the command is for running it now, or inspecting what
it would do.

**Untouched by design:** tasks, effects, approvals, reports, artifacts and the
database's own history are the audit trail rather than transport state, and a
delivered PDF is the deliverable. An inbox row a task has not processed yet is
also left alone when its sender is bound, or while a replay or admission has it
claimed — it is still somebody's message, and it is counted separately by
`tavi doctor` (`transport.inboxUnprocessed`). A held message from a sender with
no binding is not: past the window it goes, counted under `inbox`.

Like every command that writes, this one needs the data directory to itself and
refuses with exit `5` while `serve` owns it (the daemon's own sweep covers that
case) — `--dry-run` too, since it reads through the same database.

---

### `tavi inbox`

Inspect the inbound messages Tavi recorded but held back (most often because the
sender was not yet linked with `tavi bindings`), and replay one now that its
sender is bound.

```bash
tavi inbox <action> [options]
```

#### Actions
- `list [--limit <n>]`: Held messages, oldest first, with the principal each would resolve to *now* (`- (unbound)` means binding is still needed). A truncated listing says how many more there are.
- `replay <provider-event-id> --connection <id>`: Admit one again through the same two steps a fresh message takes — resolve the sender against the current bindings, then run admission — and mark it processed. Outcomes: `admitted`, `already-processed` (exit 0), `unbound`, `in-flight` or `admission-closed` (exit 4), `not-found` (exit 2). A `not-found` or `already-processed` event is answered before any owner is composed (no model needed); otherwise the owner it composes logs nowhere unless the replay fails, when its log lines are printed with the error. In text, each outcome is one line.

  The replay **claims** the row before admitting, so two replays cannot both admit the same message (`markProcessed` only lands afterwards). A failed admission gives the claim straight back, and a claim older than ten minutes is takeable again, so a crashed replay retries rather than stranding the message.

#### Options
- `--connection <id>`: The messaging connection the held event belongs to (required for `replay`).
- `--limit <n>`: Max rows for `list` (default: 50).
- `--format <text|json>`: Output format (default: `text`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

An inbound message from an unbound sender is durably held rather than dropped —
and if the sender is bound only *after* that exact event was recorded, the
ordinary path never admits it: the provider's redelivery is a duplicate, so it is
not re-admitted either, and the row stays `received` forever. `tavi doctor`
counts those as `transport.inboxUnprocessed`; this command is where they are
listed and cleared.

Anyone can message a bot, so what is held from senders with no binding is
bounded: the newest 20 per sender on each connection and 5,000 in all are kept
(older ones go as new ones arrive), and the retention sweep (`tavi prune`)
expires them after its window (30 days by default). A bound sender's held
message, and one a replay or admission has claimed, are never taken. Bind a
sender and replay soon: what is older than that may be gone.

`replay` needs a model connection, because admitting a message is a model call,
and it takes the data directory to itself: stop `tavi serve` first (exit 5).

---

### Browser installation, allowlist and history

Installing Playwright and Chromium, what the browser may open without
asking, and what a session records are in [BROWSER.md](BROWSER.md): see
[Installing it](BROWSER.md#installing-it), [Allowing the
browser](BROWSER.md#allowing-the-browser) and [What a session records](BROWSER.md#what-a-session-records).

### `tavi browser history`

The browser sessions tasks opened in the last 30 days, newest first — the same
list as the Command Center's Browser section. Under a live `tavi serve` it is
read from the owner over IPC (`browser list`, page after page up to
`--limit`); with none, from the data directory.

```bash
tavi browser history [--live] [--limit N] [--workspace <id>] [--format text|json] [--data-dir <path>]
```

#### Options
- `--live`: Only sessions open now.
- `--limit <n>`: The most sessions to list, 1–500 (default 20).
- `--format <text|json>`: Text prints, per session, `LIVE`, `ENDED` (its task has ended; still open, with its id and "kept open for the chat's next turn") or `closed`, when it opened, `N pages · duration`, the host and page title, then the task id and title and the last page's scrubbed URL; `json` prints `{ sessions }`, each as `browser list` answers it. With none: `Nothing browsed in the last 30 days.`, or with `--live`: `No browser session is open now.`
- `--workspace <id>`: Workspace (default `default`); one the owner does not serve exits `2`.
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

### `tavi browser close`

Closes browser sessions the operator no longer wants kept. A browser
session stays open when its task ends — **inactive**, kept for the chat's next
turn, which takes it up again with its pages and sign-ins — and holds a browser
context in memory until closed; there is no time limit. Under a live
`tavi serve` the owner closes it in the browser (`browser close` over IPC, the
same as the canvas's **Close browser**); with none, or for a session the owner
no longer holds, it is closed in the record. Either way browser history records
it as "closed by operator".

```bash
tavi browser close <session-id> | --inactive [--workspace <id>] [--data-dir <path>]
```

#### Options
- `<session-id>`: The session to close, as `tavi browser history` lists it; one not open in the workspace exits `2`.
- `--inactive`: Every open session whose task has ended. Exactly one of the two is required.
- `--workspace <id>`: Workspace (default `default`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

It prints `Closed N browser session(s): <ids>`, or `No browser session to close.`

### `tavi browser live`

A debug aid for the live view of the agent's browser. It opens a `browser-live` watch on the live owner over the task's
browser sessions, and its sub-agents' sessions, and writes each frame it
receives to `--out` as a JPEG named `<session>-<n>.jpg`. Each frame is
acknowledged once written: the owner sends at most two unacknowledged, so the
writes set the pace. Everything else the watch carries is printed, one line
each: a session's state, a page it moved to (scrubbed URL and title), an action
starting or ending, a page held back as sensitive (`hidden`), and a session that
ended. Tavi itself keeps no frame: these files are the only copies, and they are
yours.

```bash
tavi browser live <task-id> --out <dir> [--session <id>] [--width <px>] [--frames <n>] [--workspace <id>] [--data-dir <path>]
```

#### Options
- `--out <dir>`: Where frames are written; created `0700` when missing. Required.
- `--session <id>`: Only this session (its id from `tavi browser history`). Otherwise every session of the task's tree, including ones opened after the watch starts.
- `--width <px>`: The widest frame wanted, 160–960 (default 640).
- `--frames <n>`: Stop after writing this many frames.
- `--workspace <id>`: Workspace (default `default`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

It stops after `--frames`, once every session it watched has ended, or on Ctrl-C, and unwatches on the way out. It needs a live `tavi serve` (exit `4` without one); an unknown task or session exits `2`.

### `tavi browser clear-profile`

Forgets the workspace's browser profile: the cookies, consent choices and sign-ins the agent's browser keeps between sessions. On a live `tavi serve` it closes the workspace's open browser sessions first.

```bash
tavi browser clear-profile [--workspace <id>] [--data-dir <path>]
```

#### Options
- `--workspace <id>`: Workspace (default `default`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

### `tavi browser recipes`

Lists the browser steps that last led to results on each site, which the agent is shown the next time it reaches the site. A recipe never holds what was typed.

```bash
tavi browser recipes [--forget <host> | --forget-all] [--replay <host> | --stop-replay <host>] [--workspace <id>] [--format text|json] [--data-dir <path>]
```

#### Options
- `--forget <host>`: Forgets one site's recipe first.
- `--forget-all`: Forgets every recipe first.
- `--replay <host>`: Marks a site's recipe to replay: a session that first reaches the site, in an attended run whose chat read nothing untrusted, runs its steps before the model sees the page, each checked as `browser.act` is, stopping at the first mismatch or commit. A recipe that replays is listed with `replays`.
- `--stop-replay <host>`: Undoes `--replay`.
- `--workspace <id>`: Workspace (default `default`).
- `--format <text|json>`: Output format (default: `text`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

### `tavi browser site-notes`

Lists the operator's site notes: the `.json` files in the data directory's `site-notes/`, a `tavi.sitenotes/1` note each (hosts, path globs, notes, a search URL, an extract schema). The agent is shown an enabled note the first time it reaches the site, as reference notes, never instructions. Each is off until turned on, and off again once its file changes ([BROWSER.md](BROWSER.md)). Listing, `--on` and `--off` read and change the data directory, so they need `tavi serve` stopped: while an owner runs they exit `5`. `--propose` runs on a live owner too.

```bash
tavi browser site-notes [--propose <host> | --on <id> | --off <id>] [--workspace <id>] [--format text|json] [--data-dir <path>]
```

#### Options
- `--propose <host>`: Writes a site's recipe as a proposed note (off) to review.
- `--on <id>`: Turns a note on, as its file reads now.
- `--off <id>`: Turns it off.
- `--workspace <id>`: The recipe's workspace, for `--propose` (default `default`).
- `--format <text|json>`: Output format (default: `text`).
- `--data-dir <path>`: Data directory (default: `$TAVI_DATA_DIR`, else your user data directory).

### `tavi logs`

Read back `tavi serve`'s own log file — the same JSON lines it writes to
stderr, kept in `<data-dir>/logs/tavi.log` and rotated by size.

```bash
tavi logs [options]
```

#### Options
- `--tail <n>`: How many lines to print, newest last (default: 200).
- `--file <path>`: Read this file instead of `<data-dir>/logs/tavi.log`.
- `--format <text|json>`: `text` prints one `time → level → message` line per entry; `json` prints the raw lines as an array. A line that is not JSON is printed as-is rather than dropped.
- `--data-dir <path>`, `-h, --help`.

`serve` writes every warning it emits (a denied tool call, a stale dispatch
marker, a failed alert send) to stderr **and** to this file, so the service
manager's redirect keeps working while Tavi can read the stream back. Rotation
keeps the current file plus `<n>` rotated ones (`tavi.log.1` … `tavi.log.<n>`, 3
by default); the read path follows one rotation, so a tail that straddles a
rotation still shows the newest lines in order.

`serve` warns at startup when the data directory's filesystem is below the 32 MiB
fire floor, while there is still room to act on it; `tavi doctor` reports the same
figure as `disk.freeBytes` with a `disk.belowFloor` verdict.

`serve` accepts `--log-file <path>` (default `<data-dir>/logs/tavi.log`),
`--log-rotate-bytes <n>` (default 5242880) and `--log-keep <n>` (default 3) to
change where and how that file is written.

---

### `tavi backup`

Write a consistent snapshot of a data directory — the database, the artifacts
directory, the installed plugins' snapshots, the chats' working folders, and
(only when asked) the credentials — for an upgrade, a move, or a recovery point. The plugins always
travel with the database that records them, and `tavi restore` puts them back,
so an enabled plugin still loads (its hash is checked again at start).

```bash
tavi backup --out <dir> [options]
```

#### Options
- `--out <dir>` *(required)*: Snapshot directory; must be empty unless `--force`. It must be outside the data directory — a folder inside it (a new one included) is refused before anything is written, as `tavi restore` would refuse it. `--force` **replaces** the entries a snapshot owns (database, manifest, `artifacts/`, `chats/`, `credentials/`, `plugins/`, `web-providers.json`), so a re-taken snapshot cannot keep a previous run's credentials beside a manifest that excludes them.
- `--force`: Overwrite a non-empty snapshot directory.
- `--no-artifacts`: Skip the artifacts directory (it can be large).
- `--include-credentials`: Copy `<data-dir>/credentials` too (0600, in a 0700 directory). Off by default: copying secrets to a second location is a decision the operator makes on purpose. The at-rest key, `<data-dir>/credentials.key`, is never copied: encrypted values in the snapshot need the key kept apart, and a restore onto another directory needs it put back beside them. When the key is in the OS keychain, `credentials.key` holds only a reference; run `tavi credentials key --to-file` first to have a key file to keep.
- `--format <text|json>`, `--data-dir <path>`, `-h, --help`.

The snapshot is taken with SQLite's own consistent-snapshot operation from a
read-only connection, not by copying files, so **it is safe while `tavi serve`
owns the directory** — a copy of a live WAL database without its `-wal` sidecar
would silently miss the newest commits. `manifest.json` records what the snapshot
contains (tables, row counts, migrations, saver schema, and what was left out),
so a restore is never read as "everything came back". The text output gives the
snapshot's size in units (`2.0 MB`) and an `includes:` line naming only what was
copied: `database`, then `artifacts/` and `plugins/` when there were any, then
`chats/ (<size>)` and `credentials/`; `includes.artifacts` is `false` in a
directory with no artifacts yet. A `web-providers.json` that is not valid stops
the backup with one line naming the file and its first problem. The daemon's rotated log
(`logs/`) is deliberately never part of a snapshot: it is diagnostic, not state.
Approved plugin artifacts and web-provider selection travel with the database.
The source must carry `profile.format=tavi-1`; old profiles are refused
before output is replaced. Credential references and operation history are retained;
`provider-bindings.key` is excluded, so restored credential-backed providers need
fresh binding-specific approvals after their keys are re-entered.

The chats' working folders (`chats/`) are copied whenever there are any
(`includes.chats` in the manifest; the text output names their size, the JSON
`chatsBytes`). Each chat's `.tmp/` and `.home/` and the prune trash
`chats/.trash/` are left out (named in `excluded`): scratch and build caches
that the chat's next turn makes again. A symbolic link in a folder is copied as
a link with its target as written, never followed, so a link a chat's shell
planted to a file outside its folder brings no copy of that file; sockets,
FIFOs and devices are skipped. Chats keep running during a backup, so a file a
chat's shell removes while it is copied is left out rather than failing the
backup, and so is one it swaps for a link, a FIFO (never waited on) or a file where a folder was after it was looked at: each file is
read from a descriptor opened without following a link, and only while it is
the file looked at, at a path that still resolves to itself. Any other error
fails it, with no manifest written. A `chats` that is itself a link is
refused. `--force` replaces an earlier snapshot's `chats/` even where a
toolchain left folders in it read-only.
Snapshots therefore hold every chat's files, and the folder records in the
database hold host folders' absolute paths.

---

### `tavi export`

Write every application table to `<dir>/<table>.ndjson`.

```bash
tavi export --out <dir> [options]
```

#### Options
- `--out <dir>` *(required)*, `--force`, `--format <text|json>`, `--data-dir <path>`, `-h, --help`.

The portable half of a backup: a snapshot restores *this* build's schema, while
an export can be read by anything. A table-level dump, so the columns are the
schema's own (`project_id`), not the port's camelCase projection. Read-only, like
`backup`, so it is safe while `tavi serve` runs.

BLOB columns (the saver's `checkpoints`/`writes` carry them) are written as
`{"$blob": "<base64>"}` rather than skipped, so the file stays valid NDJSON and
the value is recoverable. The FTS5 shadow tables are excluded: they are SQLite's
index internals for `tavi_memory_fts`, they hold BLOBs, and they can be rebuilt
from `tavi_memory_records`, which *is* exported.

Host paths are written as stored: `tavi_task_folders` holds each chat's
host primary and attachments by their absolute real paths, a routine's pinned
folder is its real path, and the saver's checkpoints hold each turn's context
with its folder, absolute paths included — as a `tavi backup` does. The chat
export, `tavi tasks history <task-id>`, carries no folder record at all.

---

### `tavi restore`

Restore a snapshot written by `tavi backup` into the data directory.

```bash
tavi restore --from <dir> [options]
```

#### Options
- `--from <dir>` *(required)*: Snapshot directory to restore.
- `--format <text|json>`, `--data-dir <path>`, `-h, --help`.

The snapshot and any existing destination database must carry the supported
`tavi-1` format. The snapshot is validated before anything moves: it must carry a migration
ledger, and every migration it records must be one this build ships — a snapshot
from a newer build is refused with exit `4`, exactly as this build refuses to
*open* such a schema. A `manifest.json` that is not JSON, or is not a whole
Tavi manifest (one from another tool, or missing a field such as `includes` or
`migrations`), is refused the same way, before anything moves; a directory with
no manifest at all is read as a bare database copy. `--from` must be outside the
data directory (restoring a directory onto itself is refused, not attempted).

The new database is staged in the target directory and renamed into place, so a
failure leaves the previous one where it was; that one is moved aside to
`tavi.sqlite.pre-restore-<timestamp>` rather than deleted, and put back if the
rename fails. The copy goes through SQLite, so a `--from` directory that is
itself live (its newest rows still in `tavi.sqlite-wal`) restores those rows
rather than silently dropping them. Artifacts, plugins and credentials are copied back
only when the snapshot's `manifest.json` says it carries them; the live `artifacts/`
and `plugins/` are first moved aside to `<name>.pre-restore-<timestamp>`, as `chats/` is, so a
same-named artifact is never overwritten without a copy — a directory whose
contents disagree with its manifest has the extras reported as `ignored`, never
restored. The chats' working folders are restored when the manifest says the
snapshot carries them: the live `chats/` is moved aside to
`chats.pre-restore-<timestamp>` (never written through or merged), and links
come back as links with their targets as written. The output names where the
previous `artifacts/`, `chats/` and `plugins/` went, one line each (`directoriesMovedAside` in JSON), and
so does the error when the copy stops partway; `tavi reset` deletes these
`*.pre-restore-*` copies like the database's. A snapshot with no chats'
folders (no `includes.chats`) leaves the live `chats/` as it is, and the text
output says so. Web-provider selection is replaced according to the manifest, so a
missing selection does not retain a stale destination chain. Previous selection
and provider-binding key files are moved aside; the restored profile generates
a new private binding key.

**Forgotten memory stays forgotten**. Before the restored
database is put in place, every `tavi_memory_deletions` row of the database it
replaces that the restored one lacks is copied into it, pending and complete
alike (ids, scope and generation only, never a body), and each scope's
revocation generation is raised to the larger of the two. At the next start the
database worker, before it serves anything, forgets every record a journal row
names that is not deleted, through the ordinary forget path (its revisions,
vectors, search entry, card rows and any waiting tidy-up merging it go), with
reason `reconciled after restore`; a provider removal still pending is resent
by the provider sync. The output says `N forgotten memories stay
forgotten` when N is more than 0 (`forgottenMemory: { stayForgotten }` in JSON, 0 included). A replaced database
that is corrupt or not a database is moved aside all the same (with its
`-wal` and `-shm`), and the restore completes
with `forgotten memories could not be checked: anything you forgot after
<snapshot time> may be back; forget it again` (`{ unchecked: true,
snapshotAt? }`); any other failure to open it (locked, not permitted, an
I/O error) refuses the restore and moves nothing. A restore into an empty directory has nothing to reconcile
and says nothing of it. Chat history forgotten after the snapshot is not
journaled and comes back with it.

Unlike `backup` and `export`, this command writes: it takes the data-directory
ownership lock and refuses with exit `5` while `tavi serve` owns it.

---

### `tavi reset`

Delete everything in the data directory, as if tavi had just been installed.

```bash
tavi reset --yes [options]
```

#### Options
- `--yes` *(required)*: Confirm the deletion.
- `--format <text|json>`, `--data-dir <path>`, `-h, --help`.

Deleted: the database (`tavi.sqlite` and its WAL files: chats, tasks, memory,
schedules, reminders, settings), `artifacts/`, `chats/` (every chat's working
folder: tavi manages it, so keep files you need in a host folder a chat
attaches), `credentials/` and
`credentials.key`, `provider-bindings.key`, `plugins/`, `web-providers.json`,
`channels/` (messaging settings), `browser-profiles/` (the agent browser's cookies and storage), `ui/`, `logs/`, `runtime/`, `sandbox-home/`, `sandbox/` (the sandbox's read roots and its probe's scratch), a legacy `projects.json`, and any `*.pre-restore-*`
copies of these. Nothing is moved aside; take a `tavi backup` first to keep a
copy. Only these names are deleted: anything else in the directory (a file of
yours, a `--data-dir` pointed at the wrong place) is left, and the output names
it. A `--log-file` outside the directory is not touched. A link in a chat's
folder is deleted, never what it points at; a folder a toolchain left
read-only (Go's module cache under `.home/`) or a shell made unreadable is
made its owner's (`0700`) and deleted. `chats/`, `sandbox-home/` and their
copies go first, then the database: an entry that still cannot be deleted (a
file flagged immutable) stops the reset, naming it and what was deleted before
it, with the database and the rest in place when it was one of those first —
run `tavi reset` again once it can be deleted.

When `credentials.key` referred to a key in the OS keychain, that item
(service `tavi-credential-key`) is deleted too, once the directory is reset;
the output says so. A keychain that refuses or does not answer does not stop
the reset: the output names the item to delete by hand.

With `tavi serve` running, the command asks the owner (`reset-instance` over
IPC): it stops as on `SIGTERM`, deletes under the ownership lock, and serves
again on the empty directory with the flags it was started with, in the same
process. A stop that was not clean (a drain past its deadline) deletes nothing
and exits non-zero. A `SIGTERM` or Ctrl-C during the drain still resets, but the
owner then exits instead of serving again. An owner started with `--connection`
and no `--model` named a stored connection, which the reset deleted: it serves
again without `--connection`. With no owner, the directory is reset here under the
ownership lock. Settings → General → **Reset instance** in `tavi ui` sends the
same request after the person types `reset`.

A memory provider other than the built-in that a workspace selects may keep an
index of its own outside the directory: the reset cannot reach it, and
says so, naming each such provider any workspace selects (`memoryProviders` in
JSON, from the owner's answer too; offline, every workspace's stored settings
are read) — clearing that index is the plugin's.

---

## Operational Workflows & Guides

### 1. Configuring a Model Once, then Chatting

The short way is `tavi onboard` ([above](#tavi-onboard)): it asks for the key hidden, adds the connection, proposes the models and checks the main one. By hand, store the key in the credential store and make a connection the default, so no command needs a key flag again:

```bash
# A key file readable only by you (printf writes an empty file if the variable is unset)
mkdir -p ~/.config/tavi && chmod 700 ~/.config/tavi
printf '%s' "$OPENAI_API_KEY" > ~/.config/tavi/openai.key && chmod 600 ~/.config/tavi/openai.key

tavi credentials set openai.apiKey --file ~/.config/tavi/openai.key
tavi models add openai --base-url https://api.openai.com/v1 --credential openai.apiKey --model gpt-4.1-mini
tavi models set-default --connection openai --model gpt-4.1-mini

# The owner, then a front end in another terminal
tavi serve
tavi chat          # or: tavi ui
```

A one-shot task without an owner uses the same configuration, or explicit flags:

```bash
tavi run "Clone the repo and run the test suite" --approval ask
tavi run "…" --connection openai --model gpt-4.1-mini --api-key-file ~/.config/tavi/openai.key
```

---

### 2. Deploying a Persistent Daemon with Messaging

Save the channels first; `tavi channels list` shows each connection's id:
```bash
tavi channels add telegram --data-dir /var/lib/tavi --secret-file token=/etc/tavi/telegram.token
tavi channels add mailgun --data-dir /var/lib/tavi --domain mg.example.com \
  --secret-file apiKey=/etc/tavi/mailgun-api.key --secret-file webhookSigningKey=/etc/tavi/mailgun-signing.key
tavi channels ingress --data-dir /var/lib/tavi --port 8025
```

Bind the Telegram users you trust first — `tavi bindings` needs the owner stopped (exit `5` while it runs), or once `tavi serve` is running use `tavi channels link telegram` to pair with a one-time code and `tavi channels unlink telegram <sender>` to revoke:
```bash
tavi bindings bind \
  --data-dir /var/lib/tavi \
  --connection telegram-<id> \
  --sender 12345678 \
  --principal operator
```

Then run `tavi serve` as a system service ([`tavi service unit`](#tavi-service)) or a background process to handle incoming Telegram and Mailgun messages. `--messaging-allow-destination` lets a task send to that chat unprompted (`messaging.send_to`); without it, only replies go out:

```bash
tavi serve \
  --data-dir /var/lib/tavi \
  --connection openai \
  --model gpt-4.1-mini \
  --api-key-file /etc/tavi/openai.key \
  --messaging-allow-destination telegram-<id>:12345678
```

A message from a sender not yet bound is held, not dropped: bind the sender, then `tavi inbox replay <provider-event-id>`.

---

### 3. Human-in-the-Loop Artifact Reviews

When a task executes sandboxed code or takes a browser screenshot, it suspends with exit code `6` (`reviewRequired`):

```bash
# Inspect pending artifact metadata (also works against a live owner)
tavi artifacts list

# Approve the artifact and resume task execution
tavi artifacts approve art-789 \
  --resume \
  --connection openai \
  --model gpt-4.1-mini \
  --api-key-file ~/.config/tavi/openai.key
```

---

Artifact listing returns bounded metadata pages (100 rows per IPC request) in
creation order; the CLI follows pages up to `--limit`. JSON lists contain
`artifactId`, `workspaceId`, `runId`, `contentType` (up to 256 characters),
`byteSize` and `reviewState`. Paths, hashes, notes and artifact bodies are not
included. Both attached and offline lists use this projection. The canvas shows
these facts beside each review request, supports individual or all-pending
approval/rejection, and resumes after the final pending artifact is decided.
An older owner without the `artifacts` read must be restarted with this build. `artifacts { action: "read" }` is a different thing: it serves browser thumbnails to the Command Center and refuses every other artifact ([Browser history from an attached client](IPC.md#browser-history-from-an-attached-client)).

### 4. Rolling out a skill version

Hold a new version to chosen tasks before every task gets it. Importing, approving and activating work with `tavi serve` running or stopped; the rollout commands (`pin-rollout`, `rollout-status`, `clear-rollout`) are set on the directory itself and need the owner stopped:

```bash
# 1. Import the new version; it starts proposed
tavi skills import skill-deployer --version 2.0.0 --package ./skill-deployer.md \
  --name "Deployer" --provenance "team wiki"

# 2. Approve it
tavi skills approve skill-deployer --version 2.0.0

# 3. Pin it to chosen tasks before it is active, then activate it
tavi skills pin-rollout skill-deployer --version 2.0.0 --task task-canary-1 --task task-canary-2
tavi skills activate skill-deployer --version 2.0.0

# 4. Check rollout status
tavi skills rollout-status skill-deployer

# 5. Clear the rollout restriction once validated
tavi skills clear-rollout skill-deployer --version 2.0.0
```

While pinned, every other task gets no version of the skill; see [SKILLS.md](SKILLS.md#bounded-rollout).

---

### 5. Dead Execution Slot Recovery

If a system process running a task is killed abruptly (e.g. `kill -9` or node OOM):

```bash
# Check task status to obtain generation number
tavi tasks task-dead-102

# Terminate the dead generation and free the slot
tavi recover task-dead-102 --generation 1 --reason "Node OOM killed process pid 4821; verified dead"
```
