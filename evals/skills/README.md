# Skill eval pair

Whether loading a skill helps: each task runs twice through the whole agent,
once with nothing to go on and once with a curated skill for it approved and
active, which the agent may load with `skills.read`. A skill that does not
help, or makes answers worse (as self-written skills did in SkillsBench), shows
here before it ships.

- `cases.json` — tasks, each with the skill that describes how we do it (an
  exact format, headings, words to avoid), the checks an answer must pass, and
  two `examples`: an answer that follows the skill (it must pass) and a typical
  one without it (it must fail), which the tests hold every case to.
- `eval.ts` — the runner and its pure parts (the stream it reads, the checks,
  the per-arm summary), tested in `tests/skill-eval.test.ts`.
- `results/` — one JSON report per run (git-ignored).

## How it judges

Not with the model under test. Each case's checks are written with its skill:
text the answer must hold (`mustInclude`), must not (`mustNotInclude`),
patterns it must match (`mustMatch`, multiline), and headings in order
(`inOrder`). Markdown emphasis is read as its text, so `**TL;DR:**` is
`TL;DR:`. They pass only an answer that followed the procedure, so a fluent
answer that ignored the skill fails. A skill whose conventions a model would
follow anyway measures nothing: each case's procedure is specific enough that
an answer without it rarely passes.

## What it reports

- **Pass rate and pass^k per arm** (`without`, `with`).
- **Lift:** the "with" pass rate minus the "without" one. Below zero, the
  skills hurt.
- **Worse with the skill:** cases runs without the skill passed more often
  than with it, by more than one run in three (one noisy run of three is not a
  regression). The runner exits 1 when there is one. A skill that fails to
  install fails that run, not the eval.
- **Loaded the skill:** how often the "with" arm called `skills.read`. A low
  rate means the listing does not lead the agent to the skill.

## Run

It is opt-in, like the other live evals: it spends model tokens. Each run is a
`tavi run --approval deny` in its own copy of a template data directory that
holds nothing but model connections (see
[the heartbeat eval's README](../heartbeat/README.md) for making one); the
"with" arm imports, approves and activates the case's skill in that copy first.
A shared `--data-dir` is refused, since one arm's skill would reach the other.

```bash
node evals/skills/eval.ts --template "$EVAL_TEMPLATE" --label baseline
node evals/skills/eval.ts --template "$EVAL_TEMPLATE" --case release-notes --repeat 5
```

Options: `--template <dir>`, `--case <id[,id]>`, `--connection`/`--model`,
`--label`, `--out <dir>`, `--timeout-s <seconds per run>` (default 180),
`--repeat <n>` (default 3), `--cases <file>`.

No baseline is committed yet: one needs a live model run.
