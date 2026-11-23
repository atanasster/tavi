# Reply-language eval

Whether the agent answers in the language its workspace asks for ([LANGUAGES.md](../../docs/LANGUAGES.md)). A workspace set to a language other than English adds one line to the agent's runtime facts: "The person's language is Bulgarian: reply in Bulgarian unless they write in another language." (`replyLanguageFact` in `packages/agent-host/src/prompts/system-prompt.ts`). An English workspace adds nothing.

- `cases.json`: prompts, each in a workspace set to `en` or `bg`, with the prompt's own language (`en`, `bg`, or `neutral` for one with no letters at all, such as emoji) and the language the reply must be in.
- `eval.ts`: the runner and its pure parts, tested in `tests/reply-language-eval.test.ts`.
- `results/`: one JSON report per run (git-ignored).

## What it expects

The line asks for Bulgarian unless the person writes in another language, so:

| Workspace | Prompt | Reply |
| :--- | :--- | :--- |
| `bg` | Bulgarian | Bulgarian |
| `bg` | English | English: the person wrote in another language |
| `bg` | no words (emoji only) | Bulgarian: the case the line alone decides |
| `en` | Bulgarian | Bulgarian, as before languages: models answer in the person's language |
| `en` | English | English |
| `en` | no words | English |

`parseCasesFile` checks every case against this table and reads each prompt's language, so a case cannot drift from the line. If the line changes, the test fails and the table changes with it.

## What it measures

A run passes when it completed and its answer reads in the expected language. The language is read from the answer's letters, with no judge model. Code blocks, inline code, web and email addresses are taken out first. Then the share of Cyrillic letters among Cyrillic and Latin ones decides:

- at least 70% is Bulgarian, so names, units and codes in Latin are allowed for (`BULGARIAN_AT` in `evals/language.ts`, which the ideas eval reads too);
- at most 10% is English;
- anything between is mixed and fails;
- fewer than 12 letters can't be told and fails.

- **Pass rate:** runs that passed.
- **pass^k:** cases every run of which passed.

## Run

A run spends model tokens, so it is opt-in like the other live evals, and nothing in `pnpm test` runs it. Each run is one `tavi run --approval deny` in its own copy of a template data directory (`evals/template.ts`; see [the heartbeat eval's README](../heartbeat/README.md) for what a template may hold). Before each run, a `bg` case sets `workspace.locale` with `tavi config set`. An `en` case clears it with `tavi config unset`, as a workspace from before languages has it, whatever the template or an earlier case left.

```bash
EVAL_TEMPLATE=/tmp/tavi-eval-template
node evals/reply-language/eval.ts --template "$EVAL_TEMPLATE" --label baseline
node evals/reply-language/eval.ts --template "$EVAL_TEMPLATE" --case bg-workspace-en-sleep,bg-workspace-neutral --repeat 5
```

**Options:**
- `--template <dir>` or `--data-dir <dir>`;
- `--case <id[,id]>`;
- `--connection` / `--model`;
- `--label`, `--out <dir>`;
- `--timeout-s <seconds per run>` (default 120);
- `--repeat <n>` (default 3);
- `--cases <file>`.

It exits 0 when every case passed every run. Without `--template` or `--data-dir` it refuses to run, so it never writes into the data directory you use.

## Baseline

None recorded yet. Record one per model before changing the reply-language line, and keep the label and model in the report.
