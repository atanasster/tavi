import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig, type TestProjectInlineConfiguration, type ViteUserConfig } from "vitest/config";

/**
 * Vitest configuration for the whole repository: the shared settings, and one project per
 * workspace with a `test` script plus the repository-wide `tests/` project.
 *
 * A plain `vitest run` here runs only the repository-wide project; `--project <package name>`
 * (or a wildcard such as `'@tavi/*'`) picks workspaces. Each workspace's own `vitest.config.ts`
 * is `workspaceConfig(import.meta.dirname)`, so `vitest run` in its folder (what turbo's `test`
 * task does) runs that workspace's project alone.
 */

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

/** The `pnpm-workspace.yaml` package folders. */
const WORKSPACE_PARENTS = ["apps", "packages", "packages/builtin", "packages/external"];

/**
 * Suites that drive a real browser, sandbox, worker process or remote site. They need host
 * setup the default run does not assume, so they run only with `TAVI_REAL_TESTS=1`
 * (`pnpm test:real`, and the sandbox matrix).
 */
const REAL_SUITES = ["**/*.real.test.ts", "**/*.live.test.ts", "**/*.soak.test.ts"];

/**
 * The how-to guides' walks (`tests/guides/`): each drives a real owner, canvas and model through a
 * guide's steps and retakes its pictures, so they run only on purpose, with `TAVI_GUIDE_TESTS=1`
 * (`pnpm test:guides`).
 */
const GUIDE_WALKS = ["**/*.guide.test.ts"];

type ProjectTestOptions = NonNullable<TestProjectInlineConfiguration["test"]>;

/** What a workspace's project changes from the shared settings. */
const PROJECT_OVERRIDES: Record<string, ProjectTestOptions> = {
  // The hook timeout covers an owner's shutdown (a 5 s drain, then a 5 s disposal deadline) after a test.
  "@tavi/cli": { hookTimeout: 30_000 },
  "@tavi/ui": { include: ["test/**/*.test.ts", "test/**/*.test.tsx"] },
  // The plugin's source reads its skills dictionary from the package's own git-ignored `assets/`: copied from
  // jobs-kit's export before every run, however the tests are started.
  "@tavi/plugin-jobs": { globalSetup: [join(repoRoot, "packages/external/jobs/scripts/dictionary.mjs")] },
};

interface Workspace {
  readonly name: string;
  readonly dir: string;
}

function readWorkspace(dir: string): Workspace | undefined {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; scripts?: Record<string, string> };
  return manifest.name && manifest.scripts?.["test"] ? { name: manifest.name, dir } : undefined;
}

/** Every workspace with a `test` script. */
function workspaces(): Workspace[] {
  return WORKSPACE_PARENTS.flatMap((parent) =>
    readdirSync(join(repoRoot, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readWorkspace(join(repoRoot, parent, entry.name)))
      .filter((workspace): workspace is Workspace => workspace !== undefined),
  );
}

/**
 * A workspace's own module cache. Turbo runs every workspace's Vitest at once: a cache shared at the
 * repository root is cleared by one process while another fills it (`ENOTEMPTY ... .vitest-cache`
 * at startup).
 */
function moduleCachePath(dir: string): string {
  return join(dir, "node_modules", ".vitest-cache");
}

function workspaceProject({ name, dir }: Workspace): TestProjectInlineConfiguration {
  return {
    extends: true,
    test: {
      name,
      root: dir,
      fsModuleCachePath: moduleCachePath(dir),
      ...PROJECT_OVERRIDES[name],
    },
  };
}

const REPOSITORY_PROJECT = (readWorkspace(repoRoot) as Workspace).name;

function sharedConfig(projects: TestProjectInlineConfiguration[], project?: string, cacheDir = repoRoot): ViteUserConfig {
  return defineConfig({
    test: {
      passWithNoTests: true,
      include: ["test/**/*.test.ts", "tests/**/*.test.ts"],
      exclude: [
        ...configDefaults.exclude,
        ...(process.env["TAVI_REAL_TESTS"] === "1" ? [] : REAL_SUITES),
        ...(process.env["TAVI_GUIDE_TESTS"] === "1" ? [] : GUIDE_WALKS),
      ],
      // A command run with no --data-dir resolves the per-user default: under test that is a
      // scratch directory, never the developer's own data (XDG_DATA_HOME wins on every platform).
      // A TAVI_DATA_DIR in the developer's shell is blanked too (an empty one falls through).
      // No test puts a key in the developer's OS keychain: a new data directory's credential key
      // stays out of it (tests that exercise the keychain inject an in-memory one).
      env: { TAVI_DATA_DIR: "", XDG_DATA_HOME: join(tmpdir(), "tavi-test-data-home"), TAVI_CREDENTIAL_KEYCHAIN: "off" },
      fsModuleCachePath: moduleCachePath(cacheDir),
      // Tests that take well under a second alone take several times that while turbo runs every
      // workspace's suite at once (CLI integration tests, FFmpeg, real Chromium, React views, the
      // database worker), and Vitest's 5 s default cut them off mid-run. One cut-off view test also
      // leaves its `act()` running into the next, failing the rest of its file.
      testTimeout: 30_000,
      // Native database handles and timing assertions prefer a single worker.
      pool: "forks",
      fileParallelism: false,
      projects,
      ...(project === undefined ? {} : { project }),
    },
    // Workspace packages resolve to their sources rather than to `dist/`.
    resolve: {
      conditions: ["development", "import", "node", "default"],
    },
  });
}

/** The configuration a workspace's own `vitest.config.ts` exports: its project alone. */
export function workspaceConfig(dir: string): ViteUserConfig {
  const workspace = readWorkspace(dir);
  if (!workspace) throw new Error(`${relative(repoRoot, dir)} is not a workspace with a test script`);
  return sharedConfig([workspaceProject(workspace)], undefined, dir);
}

export default sharedConfig(
  [{ extends: true, test: { name: REPOSITORY_PROJECT, root: repoRoot } }, ...workspaces().map(workspaceProject)],
  REPOSITORY_PROJECT,
);
