# Browser eval

The yardstick for the browser agent ([BROWSER.md](../../docs/BROWSER.md)): real browsing tasks, each
with a rubric of constraints the final answer must meet, run end to end through
`tavi run` and judged item by item by a model.

- `tasks.json` — the tasks: travel (flights, hotels, trains), shopping and price
  comparison, reading pages and tables, forms (date pickers, autocomplete,
  filters), walls (consent banners, captchas, sign-in), and deterministic
  transactional tasks against the local mini-web (`fixtures/server.ts`). `{{date:+N}}` in a
  prompt is today plus N days, `{{month:+N}}` that day's month, so no task ever
  asks about the past. A `"miniweb": true` task runs on a mini-web the runner
  starts: `{{origin}}` in its prompt is that server's address, its exact
  host:port is the one host the run may open, and a rubric item with a `state`
  check (`MINIWEB_CHECKS` in `eval.ts`) is scored from what the server
  recorded, not by the judge. Category `actions` holds the action-tool tasks
  on it: a file upload, a click-started download, a list kept open while each
  detail opens in a tab (`open_in_tab`/`close_tab`), a coupon field in an
  iframe's shadow DOM, refs gone stale after `browser.find` and after a
  scoped `browser.observe`, a slider set with `browser.vision_act`, and an
  infinite scroll. The file and sandbox action tasks are in
  [the fs eval](../fs/README.md).
- `eval.ts` — the runner and its pure parts (task parsing, stream summary,
  judge prompt and verdicts, scoring, reports), tested in
  `tests/browser-eval.test.ts`.
- `baseline.json` — the committed baseline: one run's summary per taint mode
  (`securityTaint: "enforce"` and `"observe"`), each with its commit, platform
  and model, so agent failures are separated from taint-gate refusals per
  category. Only a run writes it (`--baseline-out evals/browser/baseline.json`,
  once from an enforce template and once from an observe one); it says
  `"status": "pending"` until the first is recorded.
- `timing.ts` — per-action p50/p95 wall-clock latency benchmark against the
  local mini-web server.
- `results/` — one JSON report per run (git-ignored).

## Run

Node runs the TypeScript directly. Each task is a standalone `tavi run
--approval approve`, and its answer is judged by a second `tavi run --approval
deny`, so the judge can use no tools.

Every run leaves its task in the data directory it ran in, so each task gets
its own private copy of a **template data directory**, shared by the task's
repeats and their judge and removed when the task ends (and on Ctrl-C). Make a
dedicated template that holds nothing but model connections, and never point
the eval at the data directory you use. The template is held to the same
allowlist as the memory eval's (`evals/template.ts`; see
[the memory eval's README](../memory/README.md)): model connections and their
credentials, the model catalog, role bindings, workspace defaults and what a
fresh data directory holds; anything else (chats, browser profiles, plugins,
memory records, …) is refused, named. With neither `--template` nor
`--data-dir` it refuses to run: it never writes into the default data
directory.

A blanket approve is not a person allowing a site, so `browser.navigate` opens
only hosts on `--browser-allow-host`. The runner passes the common top-level
domains (`EVAL_BROWSER_HOSTS` in `eval.ts`), plus your `--browser-allow-host`
entries and a task's own `hosts`. A run under `tavi serve` cannot carry its own
allowlist, so the eval refuses a template, or a `--data-dir`, that a running
`tavi serve` owns: stop `tavi serve` first.

```bash
EVAL_TEMPLATE=/tmp/tavi-eval-template
tavi models add … --data-dir "$EVAL_TEMPLATE"   # a connection and its credential
node evals/browser/eval.ts --template "$EVAL_TEMPLATE" --label baseline
node evals/browser/eval.ts --template "$EVAL_TEMPLATE" --task flights-sof-tpa --connection openrouter --model google/gemini-3.8-flash
node evals/browser/eval.ts --template "$EVAL_TEMPLATE" --judge-connection anthropic --judge-model claude-sonnet-5-5
node evals/browser/eval.ts --compare results/a.json --compare results/b.json
```

Options: `--template <dir>` (each task in a fresh copy) or `--data-dir <dir>`
(every task in that one existing directory, which keeps each run's task — an
explicit opt-in, for a throwaway directory), `--task <id[,id]>` (repeatable),
`--connection`/`--model` for the runs, `--judge-connection`/`--judge-model` for
the judge (default: the run's), `--browser-allow-host <host>` (repeatable), `--label`,
`--out <dir>`, `--timeout-s <seconds per run>` (default 600, a positive
number), `--tasks <file>`, `--repeat <runs>` (each task this many times in a
row, 1–20, default 1), `--baseline-out <file>` (the run's summary into that
baseline under its taint mode; the whole suite, once, only).

The tools a browsing run calls pick their own models by role: page reading
(`browser.extract`, `browser.find`) the `extraction` role, else `fast`, else
`main`; acting by sight the first role that reads images. To compare role
defaults, set the roles in the template
(`TAVI_DATA_DIR=<template> tavi models set-role extraction --connection … --model …`)
and run the suite once per setting with its own `--label`.

## Reading a report

Each run records the effective workspace taint mode (`taintMode`: `enforce`,
`observe`, or `off`, read from the template's `securityTaint` workspace setting),
approval cards requested (`approvalCards`), the taint and provenance gate's
cards and the ones refused, by `gateReason` (`gateAsks`, `gateRefusals`; in an
unattended run every gate card is refused), model turns per completed tool action
(`turnsPerAction`, summarized as `meanTurnsPerAction`), median browser
observation size in characters (`medianObservationChars`), provider-reported
tokens (`tokens` and `tokensPerCall`), and blocked pages both overall
(`blockedRate`) and by normalized hostname (`blockedByHost`), and the OS the
browser ran on (`platform`: Linux runs a confined headless shell, so compare its
blocked pages only with other Linux runs). Per category, `gateRefusedRuns` counts the runs the
gate refused a call in and `failedUngated` the failures it did not touch: the
agent's own. Any published
score must state which `taintMode` (`enforce` or `observe`) it ran under;
running once with `securityTaint: "enforce"` and once in a template with
`securityTaint: "observe"` isolates the taint gate's share of refusals per
category (see `baseline.json`).

With `--repeat`, `byTask` gives
each task's pass rate over its runs and its first run's tokens against the
later runs' mean: the later runs see the site recipes the first one learned, so
that ratio is how much cheaper a repeat is. Together they measure the browser
agent's bars: blocked-page rate, pass rates over runs, tokens per step, and
the cost of a repeat.

A task's **score** is the share of its rubric items that passed; it **passes**
only when every item did. Beside it each run records its status, tool calls by
tool, failed calls, handoffs, wall time, and whether the runner stopped it at
`--timeout-s`. A judge reply the eval could not read fails every item with that
reason, apart from items the judge left out. Sites change from day to day: compare
builds run on the same day, and read a task's per-item reasons before trusting a
single score.

The judge is a model, not ground truth: it sees only the final answer and the
rubric, and is told not to reward hedged ranges or missing data. Use a different
(stronger) model as judge than the one under test when you can.
