# Router evaluation fixtures

There is no measured routing benchmark. The recorded-evidence evaluator below reads and reports results; a live experiment must build a corpus, freeze its revision and price sheet, and provide executable or blinded review outcomes. Tool names in its scenarios are fixture requirements and must be mapped to each runner's authorized registry.

The unrouted request snapshot in `packages/agent-host/test/workflow.test.ts` captures model targets, complete messages and descriptors before and after approval. That snapshot is the disabled-mode baseline.

Existing baseline coverage is also retained in:

- `apps/cli/test/models/model-target.test.ts`: model-only, connection-only, main/fast role distinction and configured fallback behavior.
- `packages/agent-host/test/context.test.ts`: preference precedence, evidence budgeting, skill rollout filtering and mailbox context.
- `packages/agent-host/test/workflow.test.ts`: permission denial, argument validation, approval, resume and effect handling.
- `apps/cli/test/routines/routine-workflow.test.ts`: pinned research/synthesis targets, grant revocation and durable recovery.

Calibration and held-out families must remain disjoint. Do not tune routing on held-out outcomes or present fixture passes as evidence of live task quality or savings.

## Recorded-evidence evaluator

`tavi router evaluate` emits an inconclusive report with no data-directory access or provider calls. `tavi router evaluate --file observations.json` validates and analyzes a frozen, operator-supplied evidence document, capped at 8 MiB. This is an offline evidence runner and randomized pilot-order planner, not a live task executor. It does not establish provenance just because an input passes its schema. A successful command exit means a valid report, not approval to activate.

No live experiment has been performed and experimental spend is zero, so there is no activation decision: modes remain disabled by default. Do not infer a measured savings figure from test fixtures.

The versioned protocol is `router-eval-v2`; implementation and input schema are in `apps/cli/src/features/router/evaluation.ts`. Freeze corpus, policy, environment, model and price revisions before collecting data. Fields:

- Top level: `schemaVersion: 1`, `protocolVersion: "router-eval-v2"`, `corpusRevision`, `policyRevision`, `environmentRevision`, nonempty `priceRevisions` and `modelRevisions`, `cases`, `observations`.
- Cases: `id`, `family`, `split` (`calibration` or `held-out`). Families cannot cross splits. Start with 50 calibration and 100 held-out cases; these sample counts alone do not prove the quality margin.
- Observations: `caseId`, `arm`, optional `providerId` (the routing provider behind the routed arms; absent means `tavi.router`, the Jev provider), `repetition` (0–2), `success`, `usd`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `totalLatencyMs`, `routerWaitMs`, `invariantViolations`, `requiredTools`, `offeredRequiredTools`, `discoveryRecovered`, `mandatoryEvidenceLost`, `explicitSkillPreserved`, `judgedBy` (`executable` or `blinded-human`). Cost, tokens and feature labels accept `null` for unknown. All dollars include every attempt, summaries, retries and router overhead; retain the attempt ledger and immutable prices as independently auditable source artifacts.

Arms: `baseline`, `fixed-main`, `fixed-fast`, `lexical`, `router-model`, `router-memory`, `router-tools`, `router-skills`, `combined`. One evidence file measures one routing provider: routed arms (`router-*`, `combined`) that mix `providerId` values are rejected, and the report names the provider it measured. Each case has three paired repetitions per arm, from the same repository/environment snapshot. The output's deterministic shuffled arm order is a plan, not execution evidence. Independent executable checks or blinded human reviewers must judge success; Jev must not be the sole judge. Record missing executions instead of inventing observations.

Only complete held-out pairs enter the comparisons. The report includes the number of paired tasks, success-rate difference, cost-per-success ratio, required-tool recall and 95% percentile bootstrap intervals from 2,000 resamples clustered by task (all repetitions travel together). Cost is total arm dollars divided by successful attempts. Missing costs or zero successes yield no finite ratio; cache-read tokens are subsets, not additive input. The p95 latency ratio is descriptive. `statisticalTargetsMet` covers only the stated sample/quality/cost/latency thresholds, not safety, memory quality or activation approval.

Activation always requires a separate audited operator decision. Any invariant violation blocks it. Incomplete data remains inconclusive; memory's degradation margin still needs ratification, skill utility needs independent labels, and tool recovery/recall cannot substitute for final task success. Archive abort, abstention and recovery traces alongside observations; this version does not infer those rates from provider receipts. The report never changes configuration.

Before live execution, supply a controlled task harness, immutable task snapshots, independent outcome checks, scoped credentials, permitted data categories and an explicit maximum experiment spend. The harness must reserve a conservative upper bound for **all** model attempts before dispatch (router-local budgets alone do not bound a generation-model experiment), stop on exhausted budget or invariant failure, and retain uncertain charges. Live task execution is deliberately not started by this offline command; without those prerequisites the recorded decision remains inconclusive.
