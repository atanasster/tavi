# Tool-choice eval

Whether a model picks the right tool for an everyday request, through
the whole agent: its system prompt, its tool list as a real turn offers it,
deferral behind `tools.search` included.

- `cases.json` — about 40 requests, each with the tools (`id`, `family.*`,
  or `*.verb`) that are a right call, and optionally words that call's input
  must carry (`args`). `noToolOk` marks a request a plain answer serves too;
  `leadIn` names look-ups beyond the default set the case allows before its
  call; `requires` names what the data directory must hold (`mail`,
  `calendar`) for the case to run at all.
- `eval.ts` — the runner and its pure parts (the stream it reads, scoring,
  pass^k), tested in `tests/tool-choice-eval.test.ts`.
- `results/` — one JSON report per run (git-ignored).

## What it measures

`tools.search` and `plan.update` set up rather than choose: they are skipped
wherever they come and never count as a call. Of the calls left, a run
**passes** when:

- one the case expects comes within the first 3 calls, with the arguments
  it names, and
- every call before it is a read-only look-up: `*.list`, `*.search`,
  `*.status`, `*.info`, `fs.glob`, `fs.list`, `fs.read`, `fs.grep`, or one
  the case's `leadIn` adds (the routine cases add `routines.targets`).
  Listing schedules before creating one, finding the file before reading it,
  or searching memory before asking are sensible first steps.

A call before the expected one that is no look-up — a write, a send, a
browser session, a sandbox run — fails the run (`chose <tool>`), even when
the expected call follows. So does a run that only looked up, or reached the
expected call past the window. A run with no call passes only when it
completed and the case is `noToolOk` (or expects nothing).

- **Pass rate:** runs that passed.
- **pass^k:** cases every run of which passed. A model that gets a request
  right two times in three fails it here: consistency is the measure.
- **Strict pass rate and pass^k:** the same, counting a run only when its very
  first call was the expected one. The report keeps both; `strictFailing`
  lists cases that passed only after look-ups, and each such run notes its
  `leadIn`.
- **Skipped:** cases whose `requires` the data directory lacks, listed in the
  report and not counted.
- **Tokens a run.**

## Run

It is opt-in, like the other live evals: it spends model tokens. Each run is
one `tavi run --approval deny`, so no gated tool runs; a call that asks is
counted as the choice and refused. Each run gets its own copy of a template
data directory that holds nothing but model connections (see
[the heartbeat eval's README](../heartbeat/README.md) for making one).

```bash
node evals/tool-choice/eval.ts --template "$EVAL_TEMPLATE" --label baseline
node evals/tool-choice/eval.ts --template "$EVAL_TEMPLATE" --case remind-monthly,text-ana --repeat 5
```

Options: `--template <dir>` or `--data-dir <dir>`, `--case <id[,id]>`,
`--with <mail,calendar>` (what the `--data-dir` holds; a template holds
neither),
`--connection`/`--model`, `--label`, `--out <dir>`, `--timeout-s <seconds
per run>` (default 120), `--repeat <n>` (default 3), `--cases <file>`. It
exits 0 when every case passed every run.

Every tool the cases name is registered today (`schedules.*`, `todos.*` and
`memory.forget` among them). `apps/cli/test/tools/tool-selection-eval.test.ts`
keeps a list of planned ids, now empty, for a case written ahead of its tool
(such a case also accepts a tool that exists, or an answer with no call), and
fails when a case names any other tool the registry does not hold or an
argument its schema lacks, or when a planned tool has since been built.

Some cases name tools a plain data directory does not offer: the mail cases
need a connected account, the calendar case a connected calendar (an MCP
server, or an app to connect). They carry `requires`, and are skipped — and
reported as skipped — unless `--with` says the `--data-dir` holds it; a
run that would skip every case it chose is refused. A
template never does: its allowlist refuses accounts and servers.

## Baseline

None recorded yet. Record one per model before changing tool descriptions,
deferral or the system prompt, and keep the label and model in the report.
