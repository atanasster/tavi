# Contributing to Tavi

Thanks for helping. Issues and pull requests are welcome; for a large change,
open an issue first so we can agree on the approach.

## Set up

You need Node.js `>= 22.22.2`, pnpm `12.16.1` and macOS, Linux or WSL2 (see the
README's requirements for the optional system tools).

```bash
git clone https://github.com/atanasster/tavi.git
cd tavi
pnpm install
pnpm run build
```

## Check your change

```bash
pnpm run format         # format the repository (Biome)
pnpm run check          # lint, typecheck and every test
pnpm run lint           # formatting and lint rules (biome.jsonc), as CI runs them
pnpm run knip           # unused files, exports and dependencies
pnpm run lint:css       # the canvas stylesheets use the design tokens
pnpm run test:real      # also the suites that drive a real browser, sandbox or site
pnpm run test:release   # the packed, installed CLI (packaging changes)
```

CI (`.github/workflows/ci.yml`) runs Biome, the build, typecheck, knip (also
`knip --production`, which fails on a runtime dependency only tests import), CSS
lint, tests (the packages' on Node 22.22.2, 24 and 26), the browser's guards
against real Chromium on local fixture pages, the release gate and a gitleaks
scan of the history on every pull request; the sandbox matrix runs on demand
or with the `sandbox-matrix` label. [DEVELOPMENT.md](docs/DEVELOPMENT.md#ci)
lists each job.

`pnpm test` includes the repository's doc gates: `tests/doc-links.test.ts`
fails on a broken relative link or anchor, and
`tests/no-planning-citations.test.ts` on a planning citation.

A package's own tests run with `npx vitest run` in its folder, and one file
with `npx vitest run test/<file>.test.ts`. Tests never use your real data
directory: the shared Vitest config points them at a scratch one.

## Shared code

Reach for the shared helper or component before writing one, and add a new
one to its home instead of copying it when a second caller needs it. The
homes, their exports and the boundary each keeps are listed in
[DEVELOPMENT.md](docs/DEVELOPMENT.md#shared-code); a change the canvas or the
terminal shows also retakes its screenshots
([Documentation images](docs/DEVELOPMENT.md#documentation-images)); in short:

- `@tavi/contracts/util` (and `./zod-util`, `./print-theme`): small helpers for
  any package (`errorMessage`, `definedOnly`, `clip`); no Node or DOM APIs.
- `@tavi/node-kit`: Node-side helpers (atomic writes, bounded body reads,
  `sleep`); Node built-ins only.
- `@tavi/child-kit`, `@tavi/channel-kit`, `@tavi/domain-kit`: what every
  confined engine child, messaging connector or domain plugin shares; the
  channel kit depends on contracts and zod alone.
- `@tavi/test-support`: test helpers (`temporaryDirectories`, `waitFor`),
  imported from tests only.
- In the CLI, `apps/cli/src/cli/` (`argv.ts`'s `integerFlag`, `exit.ts`'s
  `refusalExit`, `output.ts`) and `apps/cli/src/shared/`; `tavi chat`'s
  look is `apps/cli/src/tui/theme.ts`.
- In the canvas, `apps/ui/src/ui/` (`Button`, `Field`, `Select`, `Modal`,
  `Popover`, `Pending`, `LoadState`), `apps/ui/src/hooks/`, `apps/ui/src/lib/`,
  and the design tokens in `apps/ui/src/styles/tokens.css` and
  `breakpoints.css`.

A confined child loads no workspace package. `tests/shared-helpers.test.ts`,
`apps/ui/test/ui/shared-components.test.ts`,
`apps/ui/test/ui/inline-style.test.ts`, `tests/confined-entries.test.ts`,
`tests/duplication.test.ts` and stylelint fail a change that writes one of
these out again.

## Pull requests

- Keep a pull request to one change, with tests for what it adds or fixes.
- Update the README or `docs/` in the same pull request when a command, a
  setting or what a user sees changes.
- Comments and messages explain *why* in their own words; they don't cite
  planning documents or issue numbers.
- Only documentation is tracked. Keep research, plans and progress notes in
  `plans/`, which git ignores (so are Markdown files named for a plan,
  research, evidence or progress anywhere in the tree).
- Never commit a secret, even a test one that looks real: run
  `gitleaks dir .` before you push. `.gitleaks.toml` allows each deliberate
  fake by its value, and only inside a test folder: a new fake secret in a
  test needs its own entry there.
- Write commit messages in the imperative mood, with the area first when it
  helps (`gmail: keep the thread's first message id in References`).

By contributing you agree that your work is licensed under the
[MIT licence](LICENSE), and to follow the [code of conduct](CODE_OF_CONDUCT.md).
