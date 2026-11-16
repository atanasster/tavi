# Sandbox usability benchmark

How often `sandbox.run` stops to ask, and how often an ordinary command fails
in the sandbox. No model and no tokens: every number comes from the real
approval assessor and gate, or from the real sandbox.

- `cases.json` — about 175 command lines a model runs while coding, by
  category: exploring files, searching, inspecting git, pipelines, builds and
  tests, installs, toolchain checks, scripts, `stdin`, changes to files,
  redirects, the network, lines no rule can read, and escape attempts. A case
  marked `real` also runs in the real sandbox; `requires` names the programs
  it needs on `PATH`, and `platforms` the systems whose spelling of the
  command it is (`script` differs between macOS and Linux).
- `eval.ts` — reads each case's decision (`allow`, `ask` or `deny`) from
  `assessSandboxRun` and `evaluateGate` with the shipped rules, in an untainted
  chat and in a tainted one, with the scopes a card offers and the risk it
  shows, and totals them. The headline numbers are prompts per 100 commands
  in an untainted chat, and how many of those are asked every time (offered
  only `once`, so no grant ever stops them).
- `baseline.json` — the decisions and totals as they stand.
  `tests/sandbox-usability-eval.test.ts` fails when any decision changes, so a
  change that adds or removes a prompt is made on purpose:

  ```bash
  TAVI_UPDATE_SANDBOX_BASELINE=1 pnpm vitest run tests/sandbox-usability-eval.test.ts
  ```

- `results/` — the real run's report, one file per platform (git-ignored):

  ```bash
  TAVI_REAL_TESTS=1 pnpm vitest run tests/integration/sandbox-usability.real.test.ts
  ```

  It runs the `real` cases with the policy and environment a chat's
  `sandbox.run` gets, over this host's home and toolchains, skips a case whose
  program is missing, and fails only when a command every host has
  (`ls`, `pwd`, `echo`, `node --version`) fails.
