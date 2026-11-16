# Operations

This page covers running Tavi day to day: where its data lives, keeping the
owner running, reading its log, checking its health with `tavi doctor`, keeping
the database and the chats' folders small, backing up, exporting and restoring,
starting over with `tavi reset`, and upgrading. For what the owner and the data
directory are, see [CONCEPTS.md](CONCEPTS.md); for settings, see
[CONFIGURATION.md](CONFIGURATION.md). [CLI.md](CLI.md) lists every flag.

```bash
tavi logs [--tail <n>]                         # the owner's own log (<data-dir>/logs/tavi.log)
tavi doctor                                    # composition, migrations, tools, models, health
tavi prune [--older-than <n>]                  # delete finished transport rows past a cutoff
tavi tasks folders prune [--older-than <days>] # move unused run folders to the trash
tavi backup --out <dir> [--include-credentials]   # snapshot while in use
tavi export --out <dir>                        # every table as NDJSON
tavi restore --from <dir>                      # restore a snapshot (keeps the replaced database)
tavi reset --yes                               # delete all data, as if tavi had just been installed
```

## Contents

- [The data directory](#the-data-directory)
- [Running the owner](#running-the-owner)
- [A schedule's webhook](#a-schedules-webhook)
- [Logs](#logs)
- [Health: tavi doctor](#health-tavi-doctor)
- [Keeping storage small](#keeping-storage-small)
- [Limits](#limits)
- [Backups](#backups)
- [Export](#export)
- [Restore](#restore)
- [Starting over](#starting-over)
- [Upgrading](#upgrading)
- [Architecture](#architecture)

## The data directory

The data directory is `--data-dir <path>`, else `$TAVI_DATA_DIR`, else your
user data directory: `$XDG_DATA_HOME/tavi` when that is set to an absolute
path, else `~/Library/Application Support/tavi` on macOS,
`~/.local/share/tavi` on Linux and `%LOCALAPPDATA%\tavi` on Windows. Use the same one for the owner and every
client.

| Entry | Holds |
| :--- | :--- |
| `tavi.sqlite` | The database: chats, tasks, memory, schedules, settings, approvals. |
| `artifacts/` | Stored files: screenshots, downloads, reports, archived conversation spans. |
| `chats/<workspace>/<task-id>/` | Each chat's working folder; `chats/.trash/` holds pruned folders for 7 days. |
| `credentials/` | The credential store, one 0600 file per reference. |
| `credentials.key` | The at-rest encryption key, or a reference to it in the OS keychain: from the first open of a new data directory where the keychain keeps the key, else once `tavi credentials encrypt` has run. |
| `provider-bindings.key` | The key that binds credential-backed providers to their approvals. |
| `web-providers.json` | Web search provider selection. |
| `plugins/` | Installed and approved plugins, with each worker's home. |
| `browser-profiles/` | Each workspace's agent browser profile (cookies, sign-ins). |
| `video/` | `analyzers.json`, your analyser models (`video/models`) and per-run scratch. |
| `sandbox/`, `sandbox-ca/` | The shell sandbox's state, and the certificate authority its proxy terminates credential hosts' TLS with (no command reads it). |
| `ui/` | `port.json`, the web canvas's saved port, so a sign-in client registered for one loopback redirect keeps working. |
| `desktop/` | The desktop-control helper, built once on this Mac (only with `tavi.desktop` enabled; see [DESKTOP.md](DESKTOP.md)). |
| `logs/` | The owner's log, `tavi.log`, and its rotated files. |
| `runtime/` | The running owner's discovery files. |
| `owner.lock`, `owner.process.json` | Ownership of the directory; see [Running the owner](#running-the-owner). |

## Running the owner

`tavi serve` owns the data directory; while it runs, other `tavi` commands are
its clients (see [CONCEPTS.md](CONCEPTS.md#the-owner)). It runs schedules,
reminders, the heartbeat, messaging channels and the six-hourly retention
sweep.

**As a service.** `tavi service unit` renders a launchd (macOS) or systemd
(Linux) unit, or a Windows Task Scheduler logon task, that keeps `tavi serve`, and with it the scheduler, running
across reboots. Nothing is installed: the unit is printed (or written with
`--out`) for you to review and place. Pass the `serve` flags delivery needs
with `--serve-arg` (repeatable); every `--fs-root` among them, and the
`--log-dir`, becomes a `ReadWritePaths=` entry. The log files are created
`0600`.

```bash
tavi service unit \
  --serve-arg=--api-key-file --serve-arg=/etc/tavi/model.key \
  --log-dir ~/Library/Logs/tavi --out ~/Library/LaunchAgents/dev.tavi.serve.plist

# Name the format yourself, to start at login:
tavi service unit --kind launchd --out ~/Library/LaunchAgents/dev.tavi.serve.plist        # macOS
tavi service unit --kind systemd --scope user --out ~/.config/systemd/user/tavi.service   # Linux
```

On WSL2 the distribution stops soon after its last terminal closes, and the
unit with it, unless `.wslconfig` keeps it running ([SANDBOX](SANDBOX.md#wsl2)).
On native Windows `tavi serve` does not run yet; `--kind task` renders the logon
task for when it does ([CLI](CLI.md#windows-a-logon-task)).

The systemd unit runs `serve` as an ordinary user (`--user`, else the `sudo`
user, else a `tavi` account it says how to create; root only with
`--allow-root`), hardened, with a read-only system and the `--fs-root` folders
writable. `--scope user` renders a `systemctl --user` unit. A service may
not reach the OS keychain: a system unit and a launchd daemon have no login
session, and a user unit kept running with `loginctl enable-linger` finds the
keyring locked until you log in. Where `credentials.key` refers to the
keychain, every encrypted credential then fails `UNAVAILABLE`, so `tavi
service unit` warns on stderr; run `tavi credentials key --to-file` (as the
account that owns the keychain item) before installing the unit. The system unit
delegates its cgroup so the sandbox's children cannot take the owner down (see
[SANDBOX.md](SANDBOX.md)). The unit sets `TAVI_SERVICE=1`, under which
`--dev-plugin` is refused.

**Shutdown.** `tavi serve` shuts down on Ctrl-C or `SIGTERM`: it stops
admitting, lets running turns finish within `--drain-deadline` (10000 ms), then
exits. It exits non-zero if the drain does not finish.

**After an unhandled fault.** An unhandled rejection or uncaught exception in
the owner is logged with its stack, and the owner drains the same way, releases
the data directory and exits `70`, so a service manager restarts it.

**After a crash.** An owner that crashed leaves `owner.process.json` in the
data directory. The next owner takes over once that process is gone, or once
its pid names a process started at another time (the record keeps the start
time, so a pid the system gave again does not block the start); it
recognises the machine by its platform machine ID, so a hostname change
(common on macOS when networks change) does not block the takeover. A record
from another machine refuses with exit `5` and names the file: remove it once
the process it names has stopped. A turn cut off by a crash shows in `tavi doctor`'s `strandedAdmissions` with the step that
settles it (`tavi recover`, a retry, or `tavi cancel`); the text report crosses **Stranded turns** for it, and
`tavi serve` logs one warning per such turn at start, which `tavi logs` shows.

**Evaluation owner.** `tavi serve --eval` starts an owner for the memory eval
only: no reminders, heartbeats, schedules, memory tick (digest, idle review,
vector backfill, consolidation) or messaging channels, and no task summaries.
The memory jobs run on demand (`tavi memory reindex | review-now |
consolidate-now`).

**Idle cost.** An idle owner sleeps until its next due work instead of
sweeping on timers: a reminder, a schedule's fire, an agent's wait deadline,
an approval round's expiry and a heartbeat's check each run when they fall
due, and anything written (a new reminder, an edited schedule) is planned for
within a second. Task summaries are written as each task ends. With nothing
due and no browser tab open, the owner calls its database about once a minute
or less, and its slow periodic checks (memory upkeep, the heartbeat's need
poll, file watchers, health samples, the sweeps' fallbacks) share one timer
that wakes the process once or twice a minute, so it costs a laptop little.
An owner with active routines keeps their bookkeeping on a 30-second beat, as
does one owing a routine's pause notice or holding a routine evaluation that
waits for its setup. Due work a sleeping laptop missed runs within 30 seconds
of waking.

## A schedule's webhook

A schedule's webhook (`tavi schedules webhook <schedule> on`, off by default;
see [AUTOMATION.md](AUTOMATION.md)) is answered by the channels' webhook
listener, which binds `127.0.0.1` on the `tavi channels ingress` port. Nothing
outside the machine reaches it until you expose it, and Tavi opens no port of
its own beyond that listener: while any schedule's webhook is on, `tavi serve`
keeps the listener open even with no channel, and closes it after the last is
turned off.

- **Exposing it.** Put an HTTPS reverse proxy or a tunnel in front of the
  listener and forward only `/hooks/schedules/*` (and `/hooks/*` and `/i/*` if
  channels use them). Set the public address with `tavi channels ingress
  --public-url https://…`; the address may carry a path, which the listener
  takes with or without. Do not bind the listener to a public interface
  directly: plain HTTP carries the bearer secret in the clear.
- **Secrets.** The secret and its signing key are printed once by `on` or
  `rotate`. The database keeps only the secret's SHA-256, and the signing key
  encrypted with the credential key (`<data dir>/credentials.key`, which a
  copy of the database alone does not carry), so the database by itself can
  neither send a bearer call nor sign one. A signing key is made only while
  the credential store is encrypted (`tavi credentials encrypt`); without one,
  only bearer calls are taken, and a `rotate` after encrypting makes a signing
  key. Store both in the calling system's secret store, and rotate them
  (`tavi schedules webhook <schedule> rotate`) when they may have leaked or
  someone with them leaves; the old ones are refused at once.
- **Limits.** One fire a minute and 12 an hour per schedule, 8 KiB a call;
  past either is refused and counted in the schedule's history as
  `webhook-refused`. Failed calls (a wrong secret or signature, a body over
  the cap) are also counted per sending address (a burst of 10 a minute);
  once that is spent, a call with neither the secret nor fresh signature
  headers is refused before its body is read, while a bearer or signed call
  is still checked and charged only if it fails. Behind a reverse proxy on
  another machine every caller shares the proxy's address, so unauthenticated
  callers share one burst, unless you name it with `tavi channels ingress
  --port <port> --trusted-proxies <ip or CIDR range>`; then, as behind a proxy
  on loopback, each caller is counted by the address the proxy forwards in
  `X-Forwarded-For`. A good call whose fire started no run (`409`) uses none of the
  hour's 12. The counts are the running owner's and start again after a
  restart.
- **Logs.** A refused call is logged with its schedule and cause, at most
  once per schedule every 5 seconds with the count since; neither the
  secret nor the body is ever logged or stored.

## Logs

`tavi serve` writes its JSON log to stderr and to `<data-dir>/logs/tavi.log`,
rotated by size. A field whose name looks secret (`token`, `apiKey`,
`password`, `authorization`…) is written as `[redacted]` at any depth, and
every string value, the message included, has secret-shaped text masked: an
`Authorization` or API-key header, a quoted `"access_token": "…"`, a
`key=`/`token=` parameter, a URL's OAuth `code=` and a `Bearer`/`Basic`
token. A logged error keeps its name, message, fields and cause.

| Flag | Meaning | Default |
| :--- | :--- | :--- |
| `--log-file <path>` | Write the log here as well as stderr | `<data-dir>/logs/tavi.log` |
| `--log-rotate-bytes <n>` | Rotate at this size (at least 1024) | 5242880 |
| `--log-keep <n>` | Rotated files kept, 1–20 | 3 |

```bash
tavi logs                  # the newest 200 lines, newest last
tavi logs --tail 50
tavi logs --file <path>    # read another log file
tavi logs --format json
```

## Health: tavi doctor

`tavi doctor` reports the runtime's composition, SQLite migration status,
available tools, model connection health and capability availability. With
`tavi serve` running it asks the live owner; without one it opens the database
directly, needs no model credentials, and runs no plugin code (each enabled
plugin is verified against its approved hash and reported, not imported). It
exits `0` when admission is open and dependencies are healthy, and `4` when
unavailable.

Offline, `tavi doctor` checks the database with SQLite's quick check (`PRAGMA
quick_check`); `tavi doctor --deep` runs the full `integrity_check`, which also
checks every index against its table and takes longer on a large database. A
running owner skips the check either way, since it would hold up its event loop.

Sections worth knowing:

| Section | Says |
| :--- | :--- |
| `node` | The Node.js version answering, the supported floor and whether it is met. |
| `integrity` | SQLite's verdict on the database: `mode` (`quick`, or `full` with `--deep`), `ok` and `problems`; `checked: false` from a running owner. |
| `health` | The running owner's resident memory, open file descriptors (open handles on Windows) and child processes, sampled every 10 minutes and kept in memory for a day: `now`, `windowStart` (6 hours back) and `growth`, each that more than doubled over 6 hours and stayed there, with a `warning`. The Command Center's Activity view shows the same warning. Offline: `running: false`. |
| `sandbox`, `sandbox.limits` | Whether the shell sandbox works, what it cannot enforce on this platform, and how its limits are applied. |
| `browser`, `browserSessions` | How the browser is bounded; how many sessions are open or inactive. |
| `pdf` | Whether the PDF tools are on (and every workspace where they are off), the OCR add-on, and how the parser runs. |
| `video` | FFmpeg, and each analyser chain with why an entry cannot run. |
| `webSearch` | Whether `web_search` is offered (a provider is enabled) and whether the default workspace still holds the seeded allow rule that lets a search run without asking; once removed, it is never seeded again. |
| `mcp` | MCP servers, their state, the tool budget and the sandbox check. |
| `memory` | Memory settings, provider, digest, idle review, consolidation and hybrid recall, as counts only. |
| `taint` | The taint mode in force and the calls it asked, or would have asked, in the last 7 days; a `warning` when the mode is `observe` or `off` (the owner also logs it at start). |
| `scheduledWork` | The default workspace's schedules and routines this calendar month, in its zone: `tokens`, `usd` (`unknown` when a call had no price sheet), and `budget` and `percent` when `scheduled.monthlyTokenBudget` is set; a `warning` from 80% of it. |
| `routineReports` | Every published routine report hashed in full against what was published: `checked`, `damaged`, and for a damaged one its run, artifact and `problem` (`missing`, `size` or `hash`) with a `warning`. The owner's start only checks each file is there at its recorded size, so a report changed in place is found here, or refused when it is opened or delivered. |
| `pluginRegistry` | Every plugin with its phase. |
| `strandedAdmissions` | Turns cut off by a crash, with the remedy for each. |
| `chatMeasurement` | Local usage and prompt-cache measurement by chat kind; never sent anywhere. Its `prefixChurn.folds` and `chatsWithFold` count stage-2 folds: each one re-sends a chat's history after the system text, so on a model whose window the catalog knows, few folds per chat is the goal. A chat whose model reports cache reads folds later (up to 128,000 tokens instead of 64,000), and a model with no known window folds at 32,000 tokens (6,000 on a local connection). Its `usageBySite` shows token and prompt-cache use per call site over the last 30 days. |

[CLI.md](CLI.md#tavi-doctor) describes every field.

## Keeping storage small

What grows, what keeps it in check, and how to change it:

| Data | Kept | Change it with |
| :--- | :--- | :--- |
| Model requests | a task's newest 10 whole; older ones keep usage, cost and a hash | `tavi config set models.keptRequests <0-1000>` |
| Checkpoints | a chat's newest 20 | fixed; `TAVI_CHECKPOINT_BLOBS=1` makes each smaller (stored per channel) |
| Transport rows (inbox, held messages, outbox, mailbox, waits) | 30 days once finished; held messages from unbound senders capped at 20 per sender and 5,000 in all | `tavi prune --older-than <days>` |
| Artifacts (screenshots, downloads, archived output) | until removed; never a `pending` one or a report PDF | `tavi prune --include-artifacts`, `serve --retention-sweep-artifacts` |
| Routine runs | kept; old runs drop a duplicate revision snapshot | (automatic) |
| Browser history | 30 days | (automatic) |
| Videos from channels, mail or the web | 30 days | `tavi config set video.keepDays <days>` |
| Chats' folders | 2 GB each, 20 GB together, 1 GB free floor; pruned folders 7 days in the trash | `serve --folder-cap`, `--chats-cap`, `--free-space-floor`; `tavi tasks folders prune` |

The owner runs its sweep every six hours; each row is explained below.

**Model requests.** Each model call is recorded for cost and usage, but only a
task's newest 10 calls keep the whole request they sent (useful when debugging
a reply); older calls keep their usage, cost, ids and a hash of the request.
Change the number per workspace with
`tavi config set models.keptRequests <0-1000>` (`0` keeps none once a call
ends).

**Checkpoints.** Every turn deletes all but a chat's newest 20 checkpoints, and
`tavi serve`'s six-hourly sweep returns freed space to the disk.
`TAVI_CHECKPOINT_BLOBS=1` in `tavi serve`'s environment (off by default) stores
each checkpoint per channel, so a step writes only the channels it changed:
about half the checkpoint bytes in a long chat. Turning it off again reads
what it wrote; a downgrade to a build without it is refused, as after any
migration. See [ASYNC-PERSISTENCE.md](ASYNC-PERSISTENCE.md#checkpoints-and-ownership).

**Transport rows.** `tavi prune` deletes finished transport rows older than a
cutoff: processed inbox messages, held messages from senders with no binding
(never a bound sender's, nor one being admitted), resolved outbox sends,
delivered, expired or rejected mailbox envelopes, and settled wait intents.
Held messages from unbound senders are also capped as they arrive: the newest
20 per sender on a connection and 5,000 in all. `serve` runs the same
sweep every six hours with the default window; the command is for running it
now or seeing what it would do.

```bash
tavi prune                       # rows older than 30 days
tavi prune --older-than 7 --dry-run
tavi prune --include-artifacts   # also artifacts past the window
```

Tasks, effects, approvals, reports, artifacts and the database's own history
are the audit trail and are left alone; so is an inbox row a task has not
processed yet. `--include-artifacts` also deletes screenshots, downloads and
archived tool output past the window, but never a `pending` artifact and never
a report PDF a report row references. `serve --retention-sweep-artifacts` lets
the six-hourly sweep do the same.

**Routine runs.** A routine's runs and ledger are kept. Expired prompt and
evidence details are pruned by each run's saved retention, and a settled run
older than 30 days, outside its routine's 50 newest, drops its copy of the
revision snapshot it ran under when that copy is the revision's own, byte for
byte ([AUTOMATION.md](AUTOMATION.md#agent-routines)); the owner's sweep and
`tavi prune` both do it.

**Browser history.** The owner deletes browser sessions older than 30 days,
with their thumbnails, on its six-hourly sweep, whatever
`--retention-sweep-artifacts` says.

**Videos.** A video taken from a channel, mail or the web is deleted after
`video.keepDays` (30); its frames stay with the chat.

**Chats' folders.** Each chat's folder has a budget (2 GB each, 20 GB
together; `serve --folder-cap`, `--chats-cap`) and the owner refuses writes
below 1 GB free on the data directory's disk (`--free-space-floor`). With the
owner stopped, `tavi tasks folders prune` moves runs' folders unused for 30
days (`--older-than`) into `chats/.trash/`; a Home's, a side chat's or any one
chat's folder goes only with `--chat <task-id>`. It skips a chat whose turn is
in progress or whose folder settings cannot be read, and, by age, a folder a
side chat reads. It prints its plan and asks first (`--yes` off a terminal,
`--dry-run` to look only). The trash is deleted after 7 days, when a later
prune runs or an owner starts, and counts toward the 20 GB. See [CONCEPTS.md](CONCEPTS.md#folder-budget) and
[WORKING-FOLDERS.md](WORKING-FOLDERS.md).

**Derived files.** PDF page previews, and a video's frames, sheets and pose
overlays, are tagged with what made them and the source each was made from, so
forgetting a chat removes them, and erasing a message, an upload or a sender
removes what was derived from its videos.

## Limits

**Tool budget.** A workspace lists at most `128 − (other tools + 1) − 16` MCP
tools. The six built-in PDF tools lower that limit by six whether or not
`pdf.enabled` is on, and the video tools (`video.info`, `video.frames`,
`video.pose`, `video.view`, `video.transcribe`), offered where FFmpeg is
installed, take five more whether or not `video.enabled` is on. A workspace at
its MCP limit gets a `budget` notice at start, and a server that no longer fits
waits behind search under `auto` (see [MCP.md](MCP.md)).

## Backups

```bash
tavi backup --out <dir>                        # must be empty unless --force
tavi backup --out <dir> --include-credentials
tavi backup --out <dir> --no-artifacts
```

A backup is safe to run while `tavi serve` owns the directory: the database is
copied with SQLite's own consistent-snapshot operation, not as files a live
write could be halfway through. A manifest records what the snapshot contains,
so a restore is never read as "everything came back": its `includes:` line and
the manifest name only what was copied (no `artifacts/` before there are any).
`<dir>` must be outside the data directory, as a restore requires; one inside
it is refused before anything is written. A damaged `web-providers.json` stops
the backup with one line naming the file.

A backup carries:

- the database;
- artifacts (unless `--no-artifacts`);
- approved plugins (`plugins/`, with each worker's home but not its
  `home/cache/`; a SQLite store there is snapshotted whole, even while its
  worker writes it);
- `web-providers.json`;
- the chats' working folders (`chats/`, without each folder's `.tmp/` and
  `.home/` or the prune trash; a link is copied as a link, never followed, and
  the backup names the folders' size);
- with `--include-credentials`, the credential files (0600).

It never carries the credential key (`credentials.key`): back it up apart,
as without it encrypted credentials cannot be read. In a new data directory
that file is usually only a reference to a key in the OS keychain (`tavi
credentials key` says which), and copying it saves nothing: a restore on
another machine, or after the keychain item is lost, cannot read a single
credential. Before backing up a directory whose credentials you want back
anywhere else, move the key into the file:

```bash
tavi credentials key --to-file    # same key, written 0600 into credentials.key; keychain item deleted after
```

Nothing is re-encrypted and the key is never printed. Back up `credentials.key`
apart from the snapshot, and on restore put it back beside `credentials/`
(`0600`): the values read with no keychain at all. `tavi credentials key
--to-keychain` moves it back into the keychain on the new machine if you want
it there. The provider binding key
(`provider-bindings.key`) is never copied either, so after a restore,
credential-backed providers need fresh binding approvals. Browser profiles,
logs and `video/` are not backed up. Host folders a chat attached are yours to
back up: backups and exports hold them by their full paths only.

## Export

`tavi export --out <dir>` writes every application table to
`<dir>/<table>.ndjson`. It is the portable half of a backup: a snapshot restores
this build's schema, while an export can be read by anything. It is read-only,
so it is safe while `tavi serve` runs. Exports keep host paths: each chat's
host folders are held by their full paths, in its folder record and its
checkpoints, while `tavi tasks history <task-id>` carries no folder at all.

## Restore

```bash
tavi restore --from <dir>
```

The snapshot is validated before anything moves: it must carry a migration
ledger, and every migration it records must be one this build ships (a
snapshot from a newer build is refused). The existing database is moved aside,
never deleted, so a wrong snapshot is recoverable; so are the current
`artifacts/`, `plugins/` and `chats/` when the snapshot carries them (one it
does not carry is left as it is), each moved to `<name>.pre-restore-<time>` and
named in the output. Restore needs the data directory to itself and refuses
while `tavi serve` owns it.

**A restore never brings back memory you forgot.** It carries the replaced
database's deletion journal (ids only, no text) into the restored one, and the
next start forgets each record it names again before the first turn (its text,
vectors, search entry and card rows). The restore says "N forgotten memories
stay forgotten" (nothing when there are none). If the replaced database is corrupt, it is moved aside and the
restore still completes, saying that forgotten memories could not be checked
and anything forgotten after the snapshot time may be back. Chat history you
forgot after the backup is not journaled and comes back with it (a private
chat's is forgotten again by the next sweep).

**Bindings after a restore.** Replacing the secret behind an unchanged
credential reference (for a model connection, a search provider or a plugin
instance) is a new binding, whose grants and routine pins must be approved
again. A model connection that a plugin instance published is removed with that
instance: at the next start once the instance leaves the plugin's
configuration, and at once when its plugin is disabled, rejected or removed.

## Starting over

`tavi reset --yes` (or Settings → General → **Reset instance**) deletes the
database, artifacts, every chat's working folder (`chats/`; files in host
folders a chat attached are not touched), credentials and their key, installed
plugins, the web-search choice, messaging settings, the agent browser's
profiles (its cookies and sign-ins), UI preferences and logs.

Nothing is moved aside, so run `tavi backup` first if you may want any of it.
With `tavi serve` running, the owner stops, deletes and starts again by itself;
otherwise the directory is reset in place. Only files Tavi writes are deleted:
anything else in the data directory (your `video/` analyser setup, for one) is
left and named. A chat's folder a toolchain left read-only is deleted too; one
that still cannot be stops the reset before the database, naming it, so running
it again finishes.

## Upgrading

1. Stop `tavi serve`.
2. `tavi backup --out <dir>`.
3. Install the new build.
4. Start `tavi serve`; it applies new migrations.
5. Restart `tavi ui` and any other long-running client.

A build with new migrations makes the directory unreadable to older builds:
rolling back is `tavi restore` from the backup. A CLI and an owner of different
builds (different IPC protocol) refuse to talk, with "restart the service".

The data directory carries a profile format (`tavi-1`). A directory written in
another format is refused with "Unsupported data profile format"; start that
build in a separate directory with `--data-dir`. The original data is left
unchanged.

## Architecture

Day-to-day operations, data-directory ownership, diagnostics, retention, backups, and service unit generation are implemented across `@tavi/runtime` and `@tavi/cli`:

| Layer | Module / Path | Responsibility |
| :--- | :--- | :--- |
| **Ownership & Crash Recovery** | `packages/runtime/src/persistence/{ownership,ownership-client,ownership-worker,owner-process}.ts` | Exclusive data-directory locking (`owner.lock`, `owner.process.json`), machine-ID verification across hostname changes, and detection of stranded execution slots. |
| **Migrations, Backup, Export & Reset** | `packages/runtime/src/persistence/{administration,administration-client,reset,migrations,baseline-schema}.ts` | Forward-only SQLite migrations (`0001_baseline`), online consistent-snapshot backups, NDJSON table export, snapshot validation and deletion-journal replay on restore, and `tavi reset`. |
| **Diagnostics (`tavi doctor`) & Logs** | `apps/cli/src/features/doctor/{client,reports,health}.ts`, `apps/cli/src/features/maintenance/{client,parse}.ts`, `apps/cli/src/server/log-file.ts` | Live-owner and offline zero-plugin-import health checks (`node`, `sandbox`, `browser`, `pdf`, `video`, `mcp`, `memory`, `taint`, `webSearch`, `pluginRegistry`, `routineReports`, `strandedAdmissions`, `chatMeasurement`, `integrity`, `health`) and secret-redacting log rotation (`tavi logs`). |
| **Retention & Service Units** | `apps/cli/src/features/maintenance/*`, `apps/cli/src/features/service/*` | Six-hourly transport/artifact/browser-history retention sweep (`tavi prune`), chat-folder trash pruning (`tavi tasks folders prune`), and hardened `launchd` / `systemd` unit and Windows logon-task generation (`tavi service unit`). |

See [ASYNC-PERSISTENCE.md#architecture](ASYNC-PERSISTENCE.md#architecture) and [ARCHITECTURE.md](ARCHITECTURE.md) for the worker-thread SQLite architecture.
