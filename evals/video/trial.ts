import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConfinementPort, VideoContainer, VideoSandbox } from "@tavi/contracts";
import { createSrtConfinement } from "@tavi/plugin-sandbox/srt-cli";
import { findFfmpeg, libraryRoots } from "@tavi/plugin-video";
import {
  audioArgs,
  createRunner,
  frameAtArgs,
  parseLibraryListing,
  probeArgs,
  SNIFF_BYTES,
  sheetArgs,
  sniffVideo,
  timelineArgs,
  VideoOpenError,
  type ExecResult,
  type Runner,
} from "@tavi/plugin-video/internals";

// Loaded by URL: Node runs these files as they are, so the import names the `.ts` file.
const { FIXTURES, buildFixtures } = (await import(
  new URL("./build-fixtures.ts", import.meta.url).href
)) as typeof import("./build-fixtures.js");
const { denyListDecision, judge } = (await import(new URL("./judge.ts", import.meta.url).href)) as typeof import("./judge.js");
type ManifestEntry = import("./judge.js").ManifestEntry;
type StepCost = import("./judge.js").StepCost;

/**
 * The video qualification trial:
 * every fixture through the decoder's templates and runner under the real
 * confinement (srt: home and the data directory denied, the run directory
 * the only writable path, no network), twice: with the standard deny list,
 * and with the extended one (also `/tmp`, `/var/tmp` and the users'
 * directories). It records whether each fixture behaved as its manifest
 * entry says, the owner's worst event-loop delay, and what each run cost;
 * the deny-list decision (`judge.ts`) adopts the extended list only if every
 * fixture ends the same under both.
 *
 * `node evals/video/trial.ts [--fixture a,b] [--fixtures <built dir>] [--label name] [--out dir]`
 * writes `results/<label>.json`. Without `--fixture` it runs every fixture
 * but the `measure` group, which is named explicitly. Build
 * `@tavi/plugin-video` and `@tavi/plugin-sandbox` first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

interface FixtureResult {
  readonly fixture: string;
  readonly policy: "standard" | "extended";
  readonly sniff: VideoContainer | null;
  readonly steps: readonly StepCost[];
  readonly ownerLagMs: number;
  readonly expected: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/** The owner's wrap, as the video host will make it: home and data denied, the run directory alone writable, the library closure reopened. */
function wrapOf(confinement: ConfinementPort, denyRead: readonly string[]): VideoSandbox {
  return {
    kind: "wrapped",
    wrap: (launch) =>
      confinement.wrap({
        argv: launch.argv,
        env: launch.env,
        policyFile: join(launch.runDirectory, "srt.json"),
        policy: {
          denyRead,
          allowRead: [launch.runDirectory, ...launch.readRoots],
          allowWrite: [launch.runDirectory],
          domains: [],
          nested: false,
        },
      }),
  };
}

/** The owner's event loop's worst delay over a run. */
function lagMeter(): { readonly stop: () => number } {
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 50);
    last = now;
  }, 50);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.round(worst);
    },
  };
}

/** A file's first bytes, read without taking the whole file. */
function head(file: string): Uint8Array {
  const buffer = Buffer.alloc(SNIFF_BYTES);
  const fd = openSync(file, "r");
  try {
    return buffer.subarray(0, readSync(fd, buffer));
  } finally {
    closeSync(fd);
  }
}

async function trialOne(
  runner: Runner,
  paths: { readonly ffmpeg: string; readonly ffprobe: string },
  file: string,
): Promise<{ readonly sniff: VideoContainer | null; readonly steps: StepCost[] }> {
  const container = sniffVideo(head(file)) ?? null;
  const steps: StepCost[] = [];
  if (container === null) return { sniff: null, steps };
  let run;
  try {
    run = runner.open({ file }, container);
  } catch (error) {
    if (error instanceof VideoOpenError)
      return { sniff: container, steps: [{ step: "open", outcome: `refused:${error.refusal}`, wallMs: 0, peakKb: 0 }] };
    throw error;
  }
  try {
    const exec = async (
      step: string,
      binary: string,
      args: readonly string[],
      timeoutMs: number,
      stdoutMaxBytes: number,
    ): Promise<ExecResult> => {
      const started = performance.now();
      const result = await runner.exec({ binary, args, run, timeoutMs, stdoutMaxBytes });
      const wallMs = Math.round(performance.now() - started);
      const outcome = result.ok
        ? "ok"
        : "exitCode" in result
          ? `exit:${String(result.exitCode)}`
          : "refused" in result
            ? `refused:${result.failure}`
            : `failure:${result.failure}`;
      steps.push({
        step,
        outcome,
        wallMs: result.ok ? result.wallMs : wallMs,
        peakKb: result.ok ? result.peakKb : 0,
        ...("stderr" in result && !result.ok ? { stderr: result.stderr.slice(-300) } : {}),
      });
      return result;
    };
    const probed = await exec("probe", paths.ffprobe, probeArgs(run.input.path, container, 4096 * 4096), 10_000, 256 * 1024);
    if (!probed.ok) return { sniff: container, steps };
    const facts = JSON.parse(probed.stdout.toString()) as {
      readonly format?: { readonly duration?: string };
      readonly streams?: readonly { readonly codec_type?: string }[];
    };
    const duration = Number(facts.format?.duration ?? 0);
    if (!Number.isFinite(duration) || duration > 600)
      return { sniff: container, steps: [...steps, { step: "limits", outcome: "refused:too-long", wallMs: 0, peakKb: 0 }] };
    const mid = Math.max(0, Math.min(duration / 2, duration - 0.1));
    await exec(
      "frame",
      paths.ffmpeg,
      frameAtArgs(run.input.path, container, 4096 * 4096, mid, 1568, join(run.path, "f.jpg")),
      60_000,
      1024,
    );
    const times = Array.from({ length: 9 }, (_, index) => (duration * (index + 0.5)) / 9);
    await exec(
      "sheet",
      paths.ffmpeg,
      sheetArgs(run.input.path, container, 4096 * 4096, times, 3, 3, 400, join(run.path, "s.jpg")),
      60_000,
      1024,
    );
    await exec(
      "timeline",
      paths.ffmpeg,
      timelineArgs(run.input.path, container, 4096 * 4096, 0, Math.min(duration, 600), duration > 120 ? 1 : 5, 10),
      60_000,
      1024 * 1024,
    );
    if (facts.streams?.some((stream) => stream.codec_type === "audio") === true)
      await exec(
        "audio",
        paths.ffmpeg,
        audioArgs(run.input.path, container, 4096 * 4096, 0, Math.min(duration, 30), join(run.path, "a.wav")),
        60_000,
        1024,
      );
    return { sniff: container, steps };
  } finally {
    run.dispose();
  }
}

const label = flag("--label") ?? `v1.0-${platform()}`;
const outDirectory = resolve(flag("--out") ?? join(here, "results"));
const names =
  flag("--fixture")?.split(",") ??
  Object.entries(FIXTURES)
    .filter(([, spec]) => spec.group !== "measure")
    .map(([name]) => name);
const found = findFfmpeg();
if ("missing" in found) {
  console.error(found.missing);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(here, "fixtures", "manifest.json"), "utf8")) as {
  readonly fixtures: Readonly<Record<string, ManifestEntry>>;
};
const fixturesDirectory = flag("--fixtures");
const built =
  fixturesDirectory === undefined
    ? buildFixtures(found.ffmpeg, undefined, names)
    : buildFixtures(found.ffmpeg, resolve(fixturesDirectory), names);
const scratch = mkdtempSync(join(tmpdir(), "tavi-video-trial-"));
const data = join(scratch, "data");
mkdirSync(data, { recursive: true, mode: 0o700 });
const standard = [homedir(), data];
const extended = [...standard, "/tmp", "/private/tmp", "/var/tmp", ...(platform() === "darwin" ? ["/Users"] : ["/home"])];
const confinement = createSrtConfinement();
const list = (binary: string): readonly string[] => {
  try {
    return parseLibraryListing(
      execFileSync(platform() === "darwin" ? "otool" : "ldd", platform() === "darwin" ? ["-L", binary] : [binary], { encoding: "utf8" }),
    );
  } catch {
    return [];
  }
};
const results: FixtureResult[] = [];
for (const [policy, denyRead] of [
  ["standard", standard],
  ["extended", extended],
] as const) {
  const readRoots = [...new Set([...libraryRoots(found.ffmpeg, denyRead, list), ...libraryRoots(found.ffprobe, denyRead, list)])];
  const runner = createRunner({ sandbox: wrapOf(confinement, denyRead), runsDirectory: join(data, "video", "runs"), readRoots });
  for (const name of names) {
    const outcome = built[name];
    const expected = manifest.fixtures[name];
    if (outcome === undefined || expected === undefined) throw new Error(`fixture ${name} is not in the manifest`);
    if ("skipped" in outcome) {
      results.push({
        fixture: name,
        policy,
        sniff: null,
        steps: [],
        ownerLagMs: 0,
        expected: expected.expect,
        passed: true,
        detail: `skipped: ${outcome.skipped}`,
      });
      continue;
    }
    const lag = lagMeter();
    const { sniff, steps } = await trialOne(runner, found, outcome.path);
    const ownerLagMs = lag.stop();
    const verdict = judge(expected, sniff, steps, ownerLagMs);
    results.push({ fixture: name, policy, sniff, steps, ownerLagMs, expected: expected.expect, ...verdict });
    console.log(
      `${verdict.passed ? "pass" : "FAIL"} ${policy.padEnd(8)} ${name.padEnd(24)} ${steps.map((step) => `${step.step}=${step.outcome}(${String(step.wallMs)}ms,${String(step.peakKb)}KiB)`).join(" ")}${verdict.detail === undefined ? "" : ` — ${verdict.detail}`}`,
    );
  }
  await runner.close();
}
const { decision, differ } = denyListDecision(results);
const report = {
  label,
  platform: platform(),
  ffmpeg: found,
  at: new Date().toISOString(),
  fixtures: names.length,
  denyListDecision: decision,
  differ,
  results,
};
mkdirSync(outDirectory, { recursive: true });
writeFileSync(join(outDirectory, `${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
rmSync(scratch, { recursive: true, force: true });
console.log(
  `deny list: ${decision}${differ.length === 0 ? "" : ` (differ: ${differ.join(", ")})`}; ${String(results.filter((result) => !result.passed).length)} failed; written to ${join(outDirectory, `${label}.json`)}`,
);
process.exit(results.every((result) => result.passed) ? 0 : 1);
