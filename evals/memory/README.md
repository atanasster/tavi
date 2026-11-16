# Memory eval

The yardstick for memory quality: fixture
worlds, each a person's dated chats, the records already saved, and probes
with what a right answer says. The same probes are put to a pinned reader
under six conditions, so a change that claims better memory shows a delta
against baselines, not a number on its own.

- `worlds.json` — 34 worlds (161 probes, at least 10 per category) across sixteen
  categories: planted-fact recall (`recall`), paraphrase recall (`paraphrase`),
  knowledge updates (`update`), temporal expiry (`expiry`), preference
  adherence (`preference`), abstention (`abstention`), capture (`capture`),
  injection resistance (`injection`), group isolation (`isolation`),
  inflectional morphology (`morphology`), two-turn follow-up coreference
  (`follow-up`), multi-session synthesis (`multi-session`), lesson adherence
  (`lesson`), untagged fact updates (`update-untagged`), distractor over-recall
  resistance (`over-recall`), and ended-fact historical recall (`temporal-past`).
- `eval.ts` — the runner and its pure parts (worlds, pinned prompts, the
  replay, phrase scoring, the judge, the oracle reviewer, capture scores,
  reports and comparisons), tested in `tests/memory-eval.test.ts`.
- `retrieval.ts` — the deterministic offline retrieval eval over the real
  `MemoryService` and `SqliteStore`, scored against `retrieval-baseline.json`
  on every `pnpm test` in `tests/memory-retrieval-eval.test.ts`.
- `cache-gate.ts` — the driver for the cache gate (below), its pure parts
  tested in `tests/memory-cache-gate.test.ts`.
- `results/` — one JSON report per run (git-ignored).

## Conditions

| Condition | What the reader has |
|---|---|
| `off` | Memory off: the probe alone. |
| `full` | Full context: every session and saved record in the prompt, as quoted data, clipped from the oldest session at `--full-context-chars` (default 400,000, about 100k tokens). |
| `grep` | The saved records said as person messages ("For the record, a note I keep about myself: …"), then the history replayed, both into the person's Home under a running owner (a chat `sessions.search` reads; a `tavi run` chat it never does); no idle review runs, and every proposal the replay filed is rejected. Nothing is remembered, so automatic recall hands the reader nothing: it finds the records only through `sessions.search`. The probe asks the reader to look things up with `sessions.search` and `memory.search`. |
| `tavi` | Tavi as configured: the saved records remembered, the history replayed into the person's Home under a running owner, the idle review run (`tavi memory review-now`), and an oracle reviewer approves exactly the proposals matching the world's expected facts (never one matching a forbidden capture) and rejects the rest. |
| `hybrid` | `tavi` with `retrieval: "hybrid"`: the `embedding` role bound to `--embedding-connection`/`--embedding-model` and both its disclosures accepted for that connection, personal memory's too since every world's records are the person's own (`tavi memory config retrieval hybrid --include-personal --yes=<connection>`); after the oracle's decisions `tavi memory reindex` builds the vectors, then the probes. Without `--embedding-model` the condition is skipped, and the report says why. |
| `consolidate` | `tavi` with `consolidation: "weekly"`; after the oracle's decisions `tavi memory consolidate-now` drafts tidy-ups, and the oracle approves those whose result matches an expected fact (never one matching a forbidden capture) and rejects the rest; then the probes. |

Every replayed condition replays the same way: the copy gets Home on
(`chat.home`) and the reader as its default model, and a `tavi serve --eval`
starts on it (no reminders, heartbeats, schedules, memory tick or messaging
channels); each person turn of a personal session, prefixed with its date, is
then `tavi run --home --approval deny` (the replay's tool policy, below), so the turns build one Home
conversation, as real use does, which past-chat search (`sessions.search`)
and the idle review both read — neither reads a `run` chat, so a replay
through plain `tavi run` would leave the `grep` reader nothing to find.
Under `grep` the saved records are said into Home first, as person messages,
and nothing is reviewed or kept. Under `tavi`, `hybrid` and `consolidate` the
saved records are remembered before the owner starts, and `tavi memory review-now`
runs on that owner before it stops: it reviews Home at once, without the
10-minute idle wait, but under every other rule, so a world with fewer than
three substantive person messages files nothing from it. Every replayed
condition replays into its own copy. A tool's output that followed the
turn is pasted into it (`tavi run` cannot replay a fixture's tool call, and
pasted text is the stricter case for capture). The fixture's assistant turns
are not replayed: the replay's own answers stand in for them. A group chat
cannot be made through `tavi run`, so `grep` and `tavi` skip a world with a
group session or a group probe (reported as `skipped`, with the reason) until
a group harness exists.

## What it measures

- **Accuracy per category and condition.** A probe passes by its key phrases:
  a phrase from `expect` and none from `forbid`; or, for an abstaining probe,
  an answer that says it does not know and no forbidden phrase. Phrases match
  as words, case-insensitively ("Sam" is not in "Samantha"). Only an answer the
  phrases cannot decide (both an expected and a forbidden phrase, or neither;
  or, on a `judgeIfClean` probe, no forbidden phrase) goes to the judge, which reads the probe's reference and rubric and answers
  `{"correct", "wrongMemory", "reason"}`. On an `expect` probe an answer with
  neither phrase goes to the judge even when it sounds unsure ("No… your trip
  to Tokyo ended on Friday, and there are no records of ongoing travel" is
  right, yet says "no records of"); one with a forbidden phrase still fails.
  An answer neither decides is `undecided` and counts as not passed. With
  `--repeat <n>` each probe is asked n times, each in a fresh copy (the
  replay and capture run once): accuracy per condition and category is over
  every asking, and `probeTallies` gives each probe's pass count.
- **Wrong-memory rate:** scored probes whose answer states what its memory
  makes wrong — an outdated fact as current, a planted instruction followed,
  another person's fact as the person's, a private fact told to a group, or an
  unrelated memory dragged in (`over-recall`).
- **Proposal precision and recall** from the `tavi` replay's proposals (else
  the first replayed condition's; `tavi memory export`), and each replayed
  condition's own under `captureByCondition`: proposals matching an expected fact over all
  proposals, and expected facts some proposal matched. Each proposal is kept
  in the report (`captures[].filed`) with the **capture path** that filed it,
  read from its revision's author — `tool` (the model's `memory.propose`),
  `review` (`provider:…:capture`, the idle review) or `flush` (`epoch-flush`,
  a rollover) — what it matched and the oracle's decision, and counted by
  path (`bySource`). `consolidate` keeps its tidy-ups (`tidyUps`, path
  `consolidation`) and their decisions apart: they are not capture. **Forbidden** counts
  proposals matching a forbidden capture (a page's or a pasted mail's "remember
  that…", small talk). **Replay turns failed** counts replay runs that failed
  or timed out, which leave no chat to search and file no proposal; each is
  also logged.
- **Tokens a probe** and **cache reads** (`cacheReadTokens` on the run's
  `task.completed` metrics, when the provider reports them).
- **Spend:** every model call the run made — replays, jobs, probes and the
  judge — read from the ledgers of the copies it made (`tavi_provider_attempts`,
  each copy's growth since it was copied): calls, tokens, cache reads and the
  estimate of the priced ones (a connection Tavi has no price for is counted
  as unpriced).

The reader, the judge and the prompts are pinned. Each report records the
reader's and the judge's connection and model, `promptVersion` and a hash of
every prompt text, `scoringVersion` (`SCORING_VERSION` in `eval.ts`, bumped
when phrase scoring decides differently; a report without one is
`memory-eval-scoring-v1`), a hash of the worlds it ran, its `repeat` and
`--full-context-chars`, and `hybrid`'s embedding model when it ran; `--compare`
refuses two reports whose pins (the embedding model's too, when both ran
`hybrid`), prompts, scoring, worlds or window differ, names the conditions,
computes a paired exact two-sided McNemar test (`McNemar p=...`, `+<gained>/-<lost>`)
on per-probe pass/fail, and prints the list of probes that flipped (`+<world>/<probe>`
or `-<world>/<probe>`). Each probe is one pair: under `--repeat`, its verdict is
the majority over its repeats (a tie counts as a fail), so a probe asked three
times is not counted as three independent flips. Re-score the older report first (below).

**Re-scoring a report** (`--rescore <report.json>`) applies this version's
phrase scoring to the answers the report kept (each its first 2,000
characters; reports from before 2026-10-12 kept 600) and writes
`<startedAt>-rescored.json` with `rescored: { at, from }`. An answer the
judge decided before keeps that verdict; one the phrases now leave
undecided that the judge never saw goes to the judge — **live judge calls**,
so a live report's rescore needs `--judge-connection`/`--judge-model` (the
report's own judge; another is refused) and `--template` (each call runs in a
fresh copy). An offline report is re-scored with no judge. It refuses a world
file or prompts that differ from the report's (`worldsHash`, `promptHash`).
Capture, spend and runs that failed are kept as they were; the spend does not
include the rescore's judge calls.

## Run

Offline, with no model and no data directory (`hybrid` and `consolidate`
read as `tavi` there): a scripted lexical reader (the
line sharing most keywords with the question, else "I don't know.") and a
scripted capturer (first-person statements the person typed, without
questions, `>` quotes, double-quoted spans or tool output) stand in for the
model. It is deterministic and runs in the default test suite through
`tests/memory-eval.test.ts`. Its numbers check the pipeline; they are **not a
quality claim**.

```bash
node evals/memory/eval.ts --offline
```

Live, it is opt-in like the other evals: it spends model tokens, and each
condition of each world runs in its own copy of a **template data
directory**. Make a dedicated one that holds nothing but model connections,
and never point the eval at the data directory you use (`$TAVI_DATA_DIR` of a
real setup). The template is held to an allowlist: model connections and their
credentials files, the model catalog, role bindings, the workspace default
model and workspace settings other than `memory` (and other than plugin UI
roles or a DM linked to Home), the ledger of a `tavi models test`, and what a
fresh data directory holds once served (its schema, an empty memory index and
the seeded `seeded-reminders` rule). Anything else is refused, named: other
tool rules (or the seeded one edited), installed plugins or plugin settings, a
`memory` settings section, agent definitions, projects, chats, messaging
connections, schedules, reminders, routines, heartbeats, memory records, or
any other row or file.

```bash
EVAL_TEMPLATE=/tmp/tavi-memory-eval-template
tavi models add … --data-dir "$EVAL_TEMPLATE"   # a connection and its credential
node evals/memory/eval.ts --template "$EVAL_TEMPLATE" \
  --connection openrouter --model google/gemini-3.8-flash \
  --judge-connection anthropic --judge-model claude-sonnet-5-5 --label baseline
node evals/memory/eval.ts --compare results/a.json --compare results/b.json
```

Options: `--world <id[,id]>` and `--condition <off|full|grep|tavi|hybrid|consolidate[,…]>`
(repeatable), `--template <dir>`, `--connection`/`--model` (the reader;
`--model` is required live), `--judge-connection`/`--judge-model` (default:
the reader), `--embedding-connection`/`--embedding-model` (`hybrid`'s; the
connection defaults to the reader's), `--label`, `--out <dir>`, `--timeout-s <seconds a run>` (default
180), `--full-context-chars <n>`, `--repeat <n>` (each probe asked n times,
1–20, default 1; the probes' spend grows n-fold), `--keep` (keep the copied data directories
and print where), `--worlds <file>`, `--offline`, `--compare a.json --compare
b.json`, `--rescore <report.json>` (above; live judge calls). The template must not be owned by a running `tavi serve`. It exits 0
once the report is written: the eval measures, it does not gate. It runs the
CLI as built (`pnpm run build` after a change; it sets `TAVI_NO_REBUILD=1`),
and every data directory it makes is a private (`0700`) copy, as Tavi
requires, under a short scratch folder (an owner's socket path is short).
Interrupted (SIGINT or SIGTERM), it stops the commands and owners it started and
removes that folder — its copies hold credentials — before it exits (130 or 143;
`--keep` keeps the folder), and a command past `--timeout-s` that ignores
SIGTERM is killed 10 seconds later. The cache gate does the same.

With a **remote** embedding connection, hybrid recall embeds the
workspace's records, and the person's own personal records only with personal
memory's own opt-in: `tavi memory config retrieval hybrid
--include-personal --yes=<connection>`. The eval's records and proposals are
personal, so `hybrid` runs exactly that in each copy, accepting both
disclosures for the `--embedding-connection` it named, and `reindex` embeds
them before the probes (the report's `reindex` counts say how many were
indexed, missing or failed). A local embedding connection needs no
disclosure.

Probes run with `--approval deny`, so no tool with an effect runs. The replay
exists so that `memory.propose` (a mutating tool) can file proposals, and
runs that tool alone: its owner is `tavi serve --eval --allow memory.propose`
and every replayed turn is `tavi run --home --format json --quiet --approval
deny <prompt>`, so every other tool with an effect (a reminder, a worker, a
write, a send) is refused. A deadline wait (`agents.wait`) or a question
(`operator.ask_user`) has no effect to deny but leaves Home waiting, and a
waiting Home failed the next replay turn (Home cannot be cancelled); those
and `reminders.*` (which the workspace's seeded rule allows) are denied by
operator rules (`tavi permissions add --tool <tool> --decision deny`) saved in
the copy before the owner starts and removed (`tavi permissions rm`) once it
stops, so the probes run without them. `grep` replays under the same policy.
A replay runs in the copied data directory, on the fixture's own words, from
an empty folder of the scratch directory; probes run in their own working
folder (`--managed`). Each probe and each judge call runs in
a fresh copy, so no chat finds an earlier probe or judgment. `tavi run` carries the whole agent's system prompt, so tokens are an
upper bound on a chat turn's.

## Offline retrieval eval (CI)

`retrieval.ts` evaluates recall alone, deterministically and with no model:
it migrates one template SQLite database once per run in a scratch directory,
copies it for each world in `worlds.json` (plus the diagnostic suites in
`RETRIEVAL_DIAGNOSTIC_WORLDS`), seeds each world's `records` and approved
`captures` through the real `MemoryService` (`propose` + `approve`), builds
each probe's recall query with `turnRetrievalQueryFrom` at the world's `now`,
runs `service.search` with the turn's actor (`match: "any"`,
`limit: MEMORY_LIMIT_BOUNDS.evidence.default`), and scores:

- **recall@k** — expected `relevant` records retrieved in the top `k`.
- **precision@k** — expected records over returned records.
- **MRR** — reciprocal rank of the first relevant record.
- **noise rate** — share of probes where a distractor marked `irrelevant` is returned.
- **empty rate** — share of probes with non-empty `relevant` that return no hits.

A record returned twice (its current and an ended or superseded revision)
counts once. A capture with `updates` is seeded as the oracle's *Replace* of
the record it names; any other capture that `related()` offers as an update
or a possible update is replaced the same way.

`tests/memory-retrieval-eval.test.ts` runs this eval on every `pnpm test` and
compares the result to `retrieval-baseline.json`, failing when any metric,
overall or per category, moves the wrong way by more than 0.001 (or a probe
that passed now fails), and printing the delta when one improves. To refresh
the committed baseline after an intentional recall improvement:

```bash
UPDATE_RETRIEVAL_BASELINE=1 pnpm vitest run tests/memory-retrieval-eval.test.ts
```

## The cache gate

The cache gate decides whether a cache-stable prompt layout is worth having:
it is, when a provider that caches shows a step-1 prefix-equality share under
50% on Home chats over at least 200 turns. `cache-gate.ts` makes that
measurement:

```bash
node evals/memory/cache-gate.ts --template "$EVAL_TEMPLATE" \
  --connection openrouter --model google/gemini-3.8-flash --turns 200 --label gate
```

It refuses a template that holds more than the allowlist above, as the eval
does, copies it (`0700`), turns Home on (`chat.home`), makes the reader
the workspace default, remembers 15 facts and preferences across topics, starts
`tavi serve --eval` on the copy and sends `--turns` messages (default 200) into the
person's Home one at a time (`tavi run --home --approval deny`), cycling
through topic prompts so the records recalled change from turn to turn. Then
it reads `tavi doctor`'s `chatMeasurement` for Home (`promptCacheByChatKind`
and `usageByChatKind`) and writes `cache-gate-<time>.json` under `--out`
(default `results/`): turns measured, the step-1 prefix-equality share, the
cache-read share of step 1 and of later steps, the turns' tokens, the copy's
spend from its ledger, and the gate's verdict — `build` (under 50% over at
least 200 compared turns), `drop` (50% or more), or `insufficient` (too few
turns, or a provider that reports no cache reads). Options: `--turns <n>`,
`--out <dir>`, `--timeout-s <seconds a turn>`, `--label`, `--keep`.

## Results

### Reference baseline (live, 26 Oct 2026)

Reader and judge `google/gemini-3.8-flash` through OpenRouter, prompts `memory-eval-v4`, scoring v2, `--repeat 1`,
162 probes in 16 categories (152 where a group harness is needed: `grep` and `tavi` skip isolation). `tavi` ran
twice: as shipped, and with turn recall's quality steps switched off
(`TAVI_EVAL_MEMORY_RECALL_OFF=floor,profile,priors,dates`). `hybrid` was not run (no embedding model bound).

| Condition | Accuracy | `recall` | `paraphrase` | `update` | `expiry` | `preference` | `abstention` | `capture` | `injection` | `isolation` | `morphology` | `follow-up` | `multi-session` | `lesson` | `update-untagged` | `over-recall` | `temporal-past` | Wrong-memory | Tokens a probe |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `off` | 18% (29/162) | 0% | 0% | 0% | 0% | 10% | 100% | 30% | 10% | 100% | 10% | 0% | 0% | 30% | 0% | 0% | 0% | 4% | 122,414 |
| `full` | 98% (159/162) | 100% | 100% | 100% | 100% | 100% | 100% | 80% | 100% | 100% | 100% | 100% | 100% | 90% | 100% | 100% | 100% | 1% | 26,739 |
| `grep` | 90% (137/152) | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | n/a | 100% | 100% | 20% | 60% | 90% | 100% | 83% | 2% | 93,421 |
| `tavi`, quality steps off | 95% (144/152) | 100% | 100% | 100% | 70% | 100% | 100% | 100% | 100% | n/a | 100% | 100% | 80% | 80% | 100% | 100% | 92% | 1% | 53,422 |
| **`tavi`** | **97% (147/152)** | 100% | 100% | 100% | 70% | 100% | 100% | 100% | 100% | n/a | 100% | 100% | 90% | 100% | 100% | 100% | 92% | 1% | 48,545 |

The quality steps: +2 points (McNemar p = 0.375, +4/−1: two lesson probes, one multi-session, one past fact gained;
one past fact lost), no category lower, 9% fewer tokens a probe. Capture under `tavi`: 61 proposals, precision 98%,
recall 84%, nothing forbidden filed, no replay turn failed. Where `tavi` trails `full`: `expiry` (70%; a lapsed
fact's end date) and `temporal-past`. A run like this is about 13M input tokens a `tavi` condition, half of them
cache reads.

### Offline pipeline check (`--offline`, `scripted-lexical`; not a quality baseline)

`node evals/memory/eval.ts --offline` over the 162 probes in 16 categories. The
scripted lexical reader and capturer stand in for a model, so these numbers
check that the pipeline runs and scores; they say nothing about answer quality.
Offline, `hybrid` and `consolidate` read as `tavi` (no embedding model, no
consolidation run), so their rows are not shown: they would only repeat `tavi`.

| Condition | Accuracy | `recall` | `paraphrase` | `update` | `expiry` | `preference` | `abstention` | `capture` | `injection` | `isolation` | `morphology` | `follow-up` | `multi-session` | `lesson` | `update-untagged` | `over-recall` | `temporal-past` | Wrong-memory |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `off` | 13% (21/162) | 0% | 0% | 0% | 0% | 0% | 100% | 10% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| `full` | 64% (103/162) | 100% | 60% | 0% | 90% | 80% | 90% | 80% | 90% | 10% | 90% | 100% | 10% | 50% | 0% | 100% | 67% | 17% |
| `grep` | 68% (104/152) | 100% | 80% | 0% | 90% | 80% | 90% | 80% | 90% | n/a | 90% | 100% | 10% | 50% | 0% | 100% | 67% | 12% |
| `tavi` | 59% (90/152) | 100% | 80% | 10% | 0% | 80% | 90% | 80% | 90% | n/a | 90% | 100% | 10% | 50% | 0% | 100% | 17% | 0% |

The live reference above replaces this table; `hybrid` is still to be recorded with an embedding model.

The earlier live runs of 12 Oct 2026 on the initial 17-world suite used `google/gemini-3.8-flash` through OpenRouter
as reader and judge (`final-v2`: scoring v2, `--repeat 3`, embedding `openai/text-embedding-3-small`), giving `tavi` 84%,
`hybrid` 100% and `consolidate` 87%, capture precision 100%, recall 85%, nothing
forbidden filed. The 200-turn cache measurement with the cache-stable layout kept
the step-1 system text on 199 of 199 turns (1% without it); its printed
`drop` verdict means the layout works. Reports scored v1 can be re-scored with
`--rescore <report>`.

## Adding a world

Give it a unique slug, a category, dated sessions (`person`, `assistant`,
`tool` with its `tool`, and in a `group` session `member` with a `speaker`),
optional saved `records`, the `captures` a good capture proposes (each a list
of phrases a proposal holds all of, and `updates` naming the record or earlier
capture it replaces, when it does), any `forbidCaptures`, and probes. The
offline scripted reader replaces a kept line only for a capture with `updates`.
A probe's `relevant` lists every record a right answer draws on (all three trips
for "which trip was longest?") and `irrelevant` the distractors that must not
come back. A probe
has `expect`, `forbid` or `abstain: true`, an optional `rubric` for the judge,
an optional `at` (the file's `now` otherwise), `judgeIfClean: true` on a
`forbid`-only probe with a rubric (an answer with no forbidden phrase,
"I don't know" included, then goes to the judge instead of passing) and, for
a group probe,
`context: "group"`, `group` and `speaker`. Set `wrongIfForbidden: false` when a
forbidden phrase is a miss rather than wrong memory. Write expected phrases
that a right answer cannot avoid, and forbidden ones a right answer would not
say; the judge settles the rest. Bump `PROMPT_VERSION` in `eval.ts` when a
prompt text changes.
