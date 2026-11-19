import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Code reaches for the shared helper instead of writing it out again: an
 * error's message through `errorMessage`, a run of optional fields through
 * `definedOnly`, a whole-number flag through `integerFlag`, a wait through
 * `sleep` or `delay`, and in a test a temporary folder through
 * `temporaryDirectories` and a canvas mount through `test/support/dom.tsx`.
 * Each rule names the files that keep the long form, and why.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that keep the long form, for one reason. */
interface Allowed {
  readonly paths: readonly string[];
  readonly reason: string;
}

interface Rule {
  readonly name: string;
  /** What to write instead. */
  readonly instead: string;
  readonly applies: (path: string) => boolean;
  /** The 1-based lines of `text` that write the helper out. */
  readonly find: (text: string) => number[];
  readonly allowed: readonly Allowed[];
  /** Each piece of text the rule catches on its own, and text that only looks like it. */
  readonly planted: readonly string[];
  readonly nearMiss: string;
}

const SOURCE = /^(?:apps\/[^/]+\/src|packages\/(?:[^/]+\/)*src)\/.*\.tsx?$/;
const TEST = /^(?:apps\/[^/]+\/test|packages\/(?:[^/]+\/)*test|tests)\/.*\.tsx?$/;
const SKIPPED = /(^|\/)(dist|fixtures?|node_modules)\//;

/** The lines of `text` a single-line pattern matches. */
const linesMatching =
  (pattern: RegExp) =>
  (text: string): number[] =>
    text.split("\n").flatMap((line, index) => (pattern.test(line) ? [index + 1] : []));

/** The lines of `text` any of the single-line `patterns` matches. */
const linesMatchingAny =
  (...patterns: readonly RegExp[]) =>
  (text: string): number[] =>
    text.split("\n").flatMap((line, index) => (patterns.some((pattern) => pattern.test(line)) ? [index + 1] : []));

/** `...(x === undefined ? {} : { key: x })`, or `{ x }` when the key is the expression. */
const OPTIONAL_FIELD = /^\s*\.\.\.\(\s*([\w$.?]+) === undefined \? \{\} : \{ (?:[\w$]+: \1|\1) \}\),?\s*$/;

/** The first line of each run of three or more consecutive optional fields. */
function optionalFieldRuns(text: string): number[] {
  const starts: number[] = [];
  let run = 0;
  text.split("\n").forEach((line, index) => {
    run = OPTIONAL_FIELD.test(line) ? run + 1 : 0;
    if (run === 3) starts.push(index - 1);
  });
  return starts;
}

/** An anchored digits-only test of a value: `/^\d+$/.test(x)`, or `/^\d{1,3}$/u.test(x ?? "")`. */
const DIGITS_TEST = /\/\^\\d(?:\+|\{\d+(?:,\d+)?\})\$\/u?\.test\(([\w$]+)/;

/**
 * Each line that tests a value for digits only and then reads it with `Number(` in
 * the same condition, on that line or the few after it: the body of integerFlag.
 */
function digitsThenNumber(text: string): number[] {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
    const tested = DIGITS_TEST.exec(line)?.[1];
    if (tested === undefined) return [];
    const reads = new RegExp(`\\bNumber\\(${tested.replace(/\$/g, "\\$")}\\b`);
    const after = line.slice(line.indexOf(".test(") + 1);
    return [after, ...lines.slice(index + 1, index + 4)].some((next) => reads.test(next)) ? [index + 1] : [];
  });
}

/** `new Promise((r) => setTimeout(r, ms))`, the wait a helper already writes. */
const TIMER_PROMISE = /new Promise(?:<[^>]*>)?\(\(?\s*([\w$]+)\s*\)?\s*=>\s*\{?\s*setTimeout\(\s*\1\s*,/;

const LEFTOVER = "Written before the helper; to move onto it.";

const RULES: readonly Rule[] = [
  {
    name: "an error's message written out",
    instead: "errorMessage from @tavi/contracts/util",
    applies: (path) => SOURCE.test(path),
    find: linesMatchingAny(/\b([\w$]+) instanceof Error \? \1\.message\b/, /\(\s*[\w$]+ as Error\s*\)\.message\b/),
    allowed: [
      {
        paths: [
          "packages/builtin/worker/src/worker.ts",
          "packages/video-pose/src/child.ts",
          "packages/video-pose/src/run.ts",
          "packages/video-transcribe/src/child.ts",
          "packages/video-transcribe/src/run.ts",
        ],
        reason: "Built into an entry that runs confined and cannot load a workspace package at run time (tests/confined-entries.test.ts).",
      },
      { paths: ["packages/node-kit/src/private-path.ts"], reason: "@tavi/node-kit does not depend on @tavi/contracts." },
      {
        paths: ["packages/agent-host/src/hosts/ideas-host.ts"],
        reason: "A thrown value that is neither an Error nor a string reads as no message, which errorMessage cannot answer.",
      },
      {
        paths: ["packages/builtin/browser/src/page-status.ts"],
        reason: "A page error with no value reads as empty, not as the text `undefined`.",
      },
      {
        paths: [
          "apps/cli/src/features/models/client.ts",
          "apps/cli/src/features/search/web-search.ts",
          "apps/cli/src/features/service/client.ts",
        ],
        reason: LEFTOVER,
      },
    ],
    planted: [
      "const text = error instanceof Error ? error.message : String(error);",
      "throw new Error(`failed: ${(error as Error).message}`);",
    ],
    nearMiss: "if (error instanceof Error && PATTERN.test(error.message)) throw error;\nconst failure = error as Error;",
  },
  {
    name: "a TaviError's message read through from()",
    instead: "errorMessage, or keep the TaviError and read its code too",
    applies: (path) => SOURCE.test(path),
    find: linesMatching(/\bTaviError\.from\([^()]*\)\.message\b/),
    allowed: [],
    planted: ["reply(TaviError.from(error).message);"],
    nearMiss: "const failure = TaviError.from(error);",
  },
  {
    name: "three or more optional fields spread one by one",
    instead: "definedOnly from @tavi/contracts/util",
    applies: (path) => SOURCE.test(path),
    find: optionalFieldRuns,
    allowed: [
      {
        paths: [
          "apps/cli/src/features/credentials/parse.ts",
          "apps/cli/src/features/memory/parse.ts",
          "packages/builtin/desktop/src/bridge.ts",
        ],
        reason: LEFTOVER,
      },
    ],
    planted: [
      [
        "...(a === undefined ? {} : { a }),",
        "...(options.b === undefined ? {} : { b: options.b }),",
        "...(c === undefined ? {} : { c }),",
      ].join("\n"),
    ],
    nearMiss: [
      "...(a === undefined ? {} : { a }),",
      "...(b === undefined ? {} : { b: String(b) }),",
      "...(c === undefined ? {} : { c }),",
    ].join("\n"),
  },
  {
    name: "an integer flag parsed by hand",
    instead: "integerFlag from apps/cli/src/cli/argv.ts",
    applies: (path) => /^apps\/cli\/src\/(?:features\/[^/]+|server)\/parse\.ts$/.test(path),
    find: (text) => [...new Set([...linesMatching(/\bNumber\.parseInt\(/)(text), ...digitsThenNumber(text)])].sort((a, b) => a - b),
    allowed: [
      {
        paths: ["apps/cli/src/features/folders/parse.ts"],
        reason: "`--older-than` takes a `d` suffix (`30d`), which integerFlag refuses.",
      },
      {
        paths: ["apps/cli/src/features/reminders/parse.ts"],
        reason:
          "Reads the parts of a matched local timestamp, not a flag; its `--minutes` bound is written before the helper, to move onto it.",
      },
      {
        paths: ["apps/cli/src/features/schedules/parse.ts"],
        reason:
          "Reads one item of the `--days` list, already matched against `[0-6]`, and checks `--max-run-minutes` against the stored schema, not a min/max; its agenda `--days`, `--limit` and `--every-hours` bounds are written before the helper, to move onto it.",
      },
      {
        paths: [
          "apps/cli/src/features/apps/parse.ts",
          "apps/cli/src/features/config/parse.ts",
          "apps/cli/src/features/ideas/parse.ts",
          "apps/cli/src/features/mcp/parse.ts",
          "apps/cli/src/features/models/parse.ts",
          "apps/cli/src/features/router/parse.ts",
          "apps/cli/src/features/tasks/parse.ts",
          "apps/cli/src/features/ui/parse.ts",
        ],
        reason: LEFTOVER,
      },
    ],
    planted: [
      "const limit = Number.parseInt(raw, 10);",
      "if (!/^\\d+$/.test(lines) || Number(lines) < 1) throw x;",
      "if (\n  !/^\\d{1,5}$/.test(minutes) ||\n  Number(minutes) < 1\n)",
      'budget = /^\\d+$/u.test(positionals[0] ?? "") ? Number(positionals[0]) : Number.NaN;',
    ],
    nearMiss: "const limit = integerFlag(raw, { min: 1 }, refusal, usage);\nif (!/^\\d+$/.test(day)) throw x;\nconst n = Number(lines);",
  },
  {
    name: "a wait written as a timer promise",
    instead: "sleep from @tavi/node-kit, or delay from apps/ui/src/lib/delay.ts in the canvas",
    applies: (path) => SOURCE.test(path),
    find: linesMatching(TIMER_PROMISE),
    allowed: [
      { paths: ["packages/test-support/src/wait.ts"], reason: "Defines the tests' `delay` itself." },
      {
        paths: ["packages/external/discord/src/rest.ts"],
        reason: "The real clock behind an injected one, in an external plugin that does not depend on @tavi/node-kit.",
      },
      { paths: ["packages/agent-host/src/workflow/dispatch.ts", "packages/test-support/src/discord.ts"], reason: LEFTOVER },
    ],
    planted: ["await new Promise((resolve) => setTimeout(resolve, 50));"],
    nearMiss: "await new Promise((resolve) => setTimeout(() => resolve(value), 50));",
  },
  {
    name: "a canvas test's own mount, click or settle",
    instead: "mount, click and settle from apps/ui/test/support/dom.tsx",
    applies: (path) => path.startsWith("apps/ui/test/") && path !== "apps/ui/test/support/dom.tsx",
    find: linesMatching(
      /^\s*(?:export\s+)?(?:(?:async\s+)?function\s+(?:mount|click|settle)\s*[<(]|(?:const|let)\s+(?:mount|click|settle)\s*=)/,
    ),
    allowed: [
      {
        paths: [
          "apps/ui/test/features/chat-panel/chat-panel-activity.test.tsx",
          "apps/ui/test/features/chat-panel/chat-panel-details.test.tsx",
          "apps/ui/test/features/chat/model-picker.test.tsx",
          "apps/ui/test/features/welcome/welcome-connect-dom.test.tsx",
          "apps/ui/test/features/welcome/welcome-first-value-dom.test.tsx",
          "apps/ui/test/features/welcome/welcome-tasks-dom.test.tsx",
        ],
        reason: "A wrapper over the shared harness: its mount with this file's settle, or the view before it taken down first.",
      },
      {
        paths: ["apps/ui/test/features/shell/route-dom.test.tsx"],
        reason: "Wraps the shared mount to take the last page down and put the route announcer on the page first.",
      },
      {
        paths: ["apps/ui/test/features/settings/channels-settings.test.tsx"],
        reason: "Its mount builds the owner's answers and returns the writes; its click finds a control by label for the shared click.",
      },
      {
        paths: ["apps/ui/test/features/routines/routines-dom.test.tsx"],
        reason: "Its click focuses the control first and finds links as well as buttons by their text.",
      },
      {
        paths: [
          "apps/ui/test/features/center/heartbeat-dom.test.tsx",
          "apps/ui/test/features/settings/canvas-plugins-settings.test.tsx",
          "apps/ui/test/features/shell/app-dom.test.tsx",
        ],
        reason: "A name for the shared flush with this file's rounds.",
      },
      {
        paths: [
          "apps/ui/test/features/center/center-dom.test.tsx",
          "apps/ui/test/features/center/center-soul.test.tsx",
          "apps/ui/test/features/center/schedules-dom.test.tsx",
          "apps/ui/test/features/chat/store/store.test.ts",
          "apps/ui/test/features/shell/route-module.test.tsx",
        ],
        reason: LEFTOVER,
      },
    ],
    planted: [
      "async function settle(): Promise<void> {",
      "const settle = async (): Promise<void> => {",
      "let click = (target: Element) => {",
    ],
    nearMiss: "const { container } = await mount(<Panel />);\nconst settled = await settle();",
  },
  {
    name: "a test's temporary folder made by hand",
    instead: "temporaryDirectories from @tavi/test-support",
    applies: (path) => TEST.test(path),
    find: linesMatching(/\bmkdtemp(?:Sync)?\(/),
    allowed: [
      {
        paths: ["apps/cli/test/sandbox/sandbox-isolation.test.ts"],
        reason: "The folder sits under the owner's staging directory, not the system temporary directory.",
      },
      {
        paths: ["packages/builtin/sandbox/test/egress.real.test.ts"],
        reason: "The folder sits under XDG_RUNTIME_DIR, where the confined command may write.",
      },
      {
        paths: ["packages/builtin/sandbox/test/runtime-lifecycle.test.ts"],
        reason: "A socket path holds 108 bytes, so the folder sits directly under /tmp, not macOS's deep temporary directory.",
      },
      {
        paths: ["packages/runtime/test/swap-races.test.ts"],
        reason: "The folder is resolved through realpath and its mode restored before removal, which the helper does not do.",
      },
      {
        paths: ["tests/artifacts.test.ts"],
        reason: "Written in the script the built graph runs in a child process, where @tavi/test-support is not loaded.",
      },
      {
        paths: [
          "packages/node-kit/test/directory-flush.test.ts",
          "packages/node-kit/test/files.test.ts",
          "packages/node-kit/test/no-follow.test.ts",
          "packages/node-kit/test/path-env.test.ts",
          "packages/node-kit/test/understated.test.ts",
          "packages/node-kit/test/windows-endpoint.test.ts",
        ],
        reason: "@tavi/node-kit does not depend on @tavi/test-support.",
      },
      {
        paths: [
          "packages/builtin/sandbox/test/golden.test.ts",
          "packages/external/jobs/test/drift.live.test.ts",
          "packages/external/jobs/test/search.live.test.ts",
          "packages/external/places-open/test/bulgaria.live.test.ts",
          "packages/external/places-open/test/search.live.test.ts",
          "packages/external/trends/test/footprint.soak.test.ts",
          "packages/external/trends/test/lists.live.test.ts",
          "packages/external/trends/test/sweep.live.test.ts",
          "tests/fs-eval.test.ts",
          "tests/integration/browser-miniweb.real.test.ts",
          "tests/support/video-analyzer-conformance.ts",
        ],
        reason: LEFTOVER,
      },
    ],
    planted: ['const dir = await mkdtemp(join(tmpdir(), "tavi-"));'],
    nearMiss: 'const dir = temp.create("tavi-");',
  },
  {
    name: "a test's wait written as a timer promise",
    instead: "delay from @tavi/test-support, or in the canvas settle from test/support/dom.tsx or delay from src/lib/delay.ts",
    applies: (path) => TEST.test(path),
    find: linesMatching(TIMER_PROMISE),
    allowed: [
      { paths: ["apps/ui/test/support/dom.tsx"], reason: "Defines the canvas tests' `settle` itself." },
      {
        paths: ["apps/cli/test/onboard/onboarding-welcome.browser.test.ts"],
        reason: "The wait is a string evaluated in the browser page, where no helper is loaded.",
      },
      {
        paths: [
          "packages/builtin/desktop/test/bridge.test.ts",
          "packages/builtin/limits/test/limits.real.test.ts",
          "packages/builtin/telegram/test/connector.test.ts",
        ],
        reason: "The package does not depend on @tavi/test-support.",
      },
      {
        paths: [
          "apps/ui/test/features/center/center-dom.test.tsx",
          "apps/ui/test/features/center/center-shell.test.tsx",
          "apps/ui/test/features/center/center-soul.test.tsx",
          "apps/ui/test/features/center/heartbeat-dom.test.tsx",
          "apps/ui/test/features/center/schedules-dom.test.tsx",
          "apps/ui/test/features/chat-panel/chat-folder.test.tsx",
          "apps/ui/test/features/chat/approvals-provenance.test.tsx",
          "apps/ui/test/features/chat/composer-pdf.test.tsx",
          "apps/ui/test/features/chat/model-picker.test.tsx",
          "apps/ui/test/features/chat/store/store.test.ts",
          "apps/ui/test/features/routines/routines-dom.test.tsx",
          "apps/ui/test/features/routines/routines-page.test.tsx",
          "apps/ui/test/features/settings/channels-settings.test.tsx",
          "apps/ui/test/features/settings/general-settings.test.tsx",
          "apps/ui/test/features/settings/mcp-settings-dom.test.tsx",
          "apps/ui/test/features/takeover/takeover.test.tsx",
          "apps/ui/test/hooks/modal-focus.test.tsx",
          "apps/ui/test/hooks/row-keys-and-reset.test.tsx",
          "apps/ui/test/pick.ts",
          "apps/ui/test/ui/cadence-field.test.tsx",
          "packages/agent-host/test/context.test.ts",
          "packages/agent-host/test/models.test.ts",
          "packages/agent-host/test/schedule-scheduler.test.ts",
          "packages/agent-host/test/tool-check-hooks.test.ts",
          "packages/agent-host/test/workflow.test.ts",
          "packages/builtin/browser/test/egress-proxy.test.ts",
          "packages/builtin/browser/test/egress.real.test.ts",
          "packages/builtin/browser/test/history.test.ts",
          "packages/builtin/browser/test/navigation-pdf.real.test.ts",
          "packages/builtin/browser/test/playwright.real.test.ts",
          "packages/builtin/browser/test/playwright.test.ts",
          "packages/builtin/sandbox/test/escape.test.ts",
          "packages/builtin/sandbox/test/host.test.ts",
          "packages/builtin/sandbox/test/runtime-lifecycle.test.ts",
          "packages/builtin/video/test/registry.test.ts",
          "packages/builtin/video/test/run.test.ts",
          "packages/builtin/worker/test/worker.test.ts",
          "packages/external/discord/test/connector.test.ts",
          "packages/external/discord/test/rest.test.ts",
          "packages/runtime/test/routine-evaluation.test.ts",
          "packages/runtime/test/routine-worker-lifecycle.test.ts",
          "tests/async-checkpoint.test.ts",
          "tests/integration/browser-miniweb.real.test.ts",
        ],
        reason: LEFTOVER,
      },
    ],
    planted: ["await new Promise((r) => setTimeout(r, 20));"],
    nearMiss: "await delay(20);",
  },
];

function trackedFiles(): string[] {
  return (
    execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      // This file spells out every pattern it looks for, in its rules and its planted cases.
      .filter(
        (path) =>
          (SOURCE.test(path) || TEST.test(path)) &&
          !SKIPPED.test(path) &&
          path !== "tests/shared-helpers.test.ts" &&
          existsSync(join(root, path)),
      )
  );
}

const allowedPaths = (rule: Rule): string[] => rule.allowed.flatMap((entry) => entry.paths);

describe("code uses the shared helpers", () => {
  const files = trackedFiles();
  // Read each file once for every rule; an allowlisted path outside the listing is read when asked.
  const texts = new Map(files.map((path) => [path, readFileSync(join(root, path), "utf8")]));
  const textOf = (path: string): string => texts.get(path) ?? readFileSync(join(root, path), "utf8");

  it("finds the sources and tests", () => {
    // An empty listing (git missing, a filter gone wrong) would pass silently.
    expect(files.filter((path) => SOURCE.test(path)).length).toBeGreaterThan(1000);
    expect(files.filter((path) => TEST.test(path)).length).toBeGreaterThan(500);
  });

  it.each(RULES)("writes out no $name", (rule) => {
    const allowed = new Set(allowedPaths(rule));
    const offenders = files
      .filter((path) => rule.applies(path) && !allowed.has(path))
      .flatMap((path) => {
        const text = textOf(path);
        const lines = text.split("\n");
        return rule.find(text).map((line) => `${path}:${line}: ${(lines[line - 1] ?? "").trim().slice(0, 160)}`);
      });
    expect(offenders, `use ${rule.instead}`).toEqual([]);
  });

  it.each(RULES)("allows only files that still write out $name", (rule) => {
    // An entry whose file has moved onto the helper, or is gone, is stale.
    const stale = allowedPaths(rule).filter(
      (path) => !existsSync(join(root, path)) || !rule.applies(path) || rule.find(textOf(path)).length === 0,
    );
    expect(stale).toEqual([]);
  });

  it.each(RULES)("catches a planted $name and passes a near miss", (rule) => {
    for (const planted of rule.planted) expect(rule.find(planted), planted).not.toEqual([]);
    expect(rule.find(rule.nearMiss)).toEqual([]);
  });
});
