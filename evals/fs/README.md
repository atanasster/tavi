# File and sandbox action eval

Whether a model gets small file and shell tasks done with the action tools,
end to end through `tavi run`: a multi-part `fs.edit`, an `fs.grep` followed
by a line-window `fs.read` over a large file, and a `sandbox.run` data script
fed on `stdin`. The browser action tasks (upload, download, tabs, frames and
shadow DOM, stale refs, `vision_act`, infinite scroll) are in
[the browser eval](../browser/README.md), category `actions`.

- `cases.json` — the cases: a prompt, the files the chat's folder starts with
  (`files`: a file in `fixtures/`, or `generated:<name>`, built by `eval.ts`
  from a fixed seed), and what is checked afterwards (`expect`):
  - `files`: a file the run leaves, `equals` a fixture, or `contains`/`lacks` text;
  - `calls`: how many calls of a tool (`min`/`max`), counting only those whose
    input sets the `has` fields and carries the `where` words (`*` is the whole input);
  - `answer`: facts the final answer states, each with its accepted spellings
    (numbers compared without thousands separators).

  No judge: every check is read from the folder, the stream or the answer text.
- `fixtures/` — `inventory.py` and the `inventory.expected.py` its three edits
  make, and `sales.csv`. The >1 MiB `app.log` is generated (`appLog` in
  `eval.ts`), never committed.
- `eval.ts` — the runner and its pure parts (case parsing, fixtures, the
  stream, scoring), tested offline in `tests/fs-eval.test.ts`.
- `results/` — one JSON report per run (git-ignored).

| Case | Checks |
| --- | --- |
| `edit-three-hunks` | `inventory.py` equals the expected file; exactly one `fs.edit` of it, passing `edits`; no `fs.write` |
| `grep-window-big-log` | an `fs.grep` for the error, an `fs.read` with `startLine`, no `sandbox.run`; the answer names line 9137, request `r-7f3a9c`, order 55821 and the retry |
| `sandbox-script-stdin` | a `sandbox.run` of python with `stdin` set; `sales.csv` unchanged; the answer gives the four region totals |

## Run

It spends model tokens, like the other live evals. Each case gets a folder
of its own under a private scratch folder, seeded with its fixtures, and runs
as `tavi run --folder <it> --approval approve` on one `tavi serve --eval`
owner whose `--fs-root` is that scratch folder (a run with no owner works only
in its own managed folder, which cannot be seeded before its first turn). The
owner runs on a private copy of a template data directory that holds nothing
but model connections (see [the memory eval's README](../memory/README.md));
stop any `tavi serve` on the template first. `sandbox-script-stdin` needs the
sandbox on this host (`tavi sandbox check`).

```bash
node evals/fs/eval.ts --template "$EVAL_TEMPLATE" --label baseline
node evals/fs/eval.ts --template "$EVAL_TEMPLATE" --case grep-window-big-log --repeat 3 --connection openrouter --model google/gemini-3.8-flash
```

Options: `--template <dir>` or `--data-dir <dir>`, `--case <id[,id]>`,
`--connection`/`--model`, `--label`, `--out <dir>`, `--timeout-s <seconds
per run>` (default 300), `--repeat <n>` (1–20, default 1), `--cases <file>`.
It exits 0 when every case passed every run; the report gives each check's
reason, the calls by tool, and pass^k over repeats.
