import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChatFolder } from "@tavi/contracts";
import { createRuntimeSandbox } from "@tavi/plugin-sandbox/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { canApplySeatbeltProfile } from "@tavi/test-support/sandbox";
import { afterAll, describe, expect, it } from "vitest";

import { sandboxArgv } from "../../apps/cli/src/features/sandbox/command-line.js";
import { sandboxCallFor } from "../../apps/cli/src/features/sandbox/tools.js";
import { parseCasesFile, type UsabilityCase } from "../../evals/sandbox-usability/eval.js";

/**
 * The benchmark's `real` cases in the real sandbox, with the policy and
 * environment a chat's `sandbox.run` gets (`sandboxCallFor`) over this
 * host's real home and toolchains: how many ordinary commands fail. A case
 * whose program is not on this host is skipped. The commands every host has
 * must pass; the rest are reported, with the failures, in
 * `evals/sandbox-usability/results/real-<platform>.json` (git-ignored).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const folderOf = join(root, "evals", "sandbox-usability");
const cases = parseCasesFile(JSON.parse(readFileSync(join(folderOf, "cases.json"), "utf8"))).cases.filter((entry) => entry.real === true);

/** What every host runs: a failure of one of these is the sandbox's, never the host's. */
const MUST_PASS = new Set(["explore-ls", "explore-ls-la", "explore-pwd", "explore-echo-hello", "toolchain-node-version"]);

const confines = process.platform === "linux" || (process.platform === "darwin" && canApplySeatbeltProfile());
const directories = temporaryDirectories();
afterAll(() => directories.cleanup());

const onPath = (program: string): boolean => spawnSync("/bin/sh", ["-c", `command -v ${program}`], { stdio: "ignore" }).status === 0;

/** A chat's managed folder with the files the cases read, and a repository made on the host. */
function chatFolder(): { readonly folder: ChatFolder; readonly dataDirectory: string } {
  const base = realpathSync(directories.create("tavi-usability-"));
  const dataDirectory = join(base, "data");
  const managed = join(dataDirectory, "chats", "default", "t1");
  for (const entry of [".tmp", ".home", "src"]) mkdirSync(join(managed, entry), { recursive: true });
  writeFileSync(join(managed, "README.md"), "# demo\n");
  writeFileSync(join(managed, "log.txt"), "ok\nerror one\nerror two\n");
  writeFileSync(join(managed, "data.txt"), "b\na\nb\n");
  writeFileSync(join(managed, "src", "index.ts"), "export const x = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: managed });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: managed });
  return {
    dataDirectory,
    folder: {
      primary: managed,
      primaryKind: "managed",
      managed,
      scratch: join(managed, ".tmp"),
      home: join(managed, ".home"),
      attachments: [],
      revision: 1,
    },
  };
}

interface Outcome {
  readonly id: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly exitCode?: number | null;
  readonly stderr?: string;
}

describe.skipIf(!confines)("the sandbox usability benchmark, run for real", () => {
  it("runs the ordinary commands a chat's shell runs, and reports which fail", { timeout: 300_000 }, async () => {
    const { folder, dataDirectory } = chatFolder();
    const sandbox = createRuntimeSandbox();
    const call = await sandboxCallFor({ dataDirectory, ownerTemporaryDirectories: [tmpdir()] }, folder);
    const outcomes: Outcome[] = [];
    for (const entry of cases as readonly UsabilityCase[]) {
      const missing = (entry.requires ?? []).filter((program) => !onPath(program));
      if (missing.length > 0 || (entry.platforms !== undefined && !entry.platforms.includes(process.platform))) {
        outcomes.push({ id: entry.id, status: "skipped" });
        continue;
      }
      const argv = sandboxArgv(entry.line, undefined);
      // A pseudo-terminal and a listener are the operator's opt-ins (`serve --sandbox-pty`, `--sandbox-local-bind`):
      // their cases run with them, to show they work.
      const local =
        entry.category === "pty"
          ? { pty: true }
          : entry.category === "ipc"
            ? { localBinding: true, unixSocketsIn: [folder.scratch] }
            : undefined;
      const policy = local === undefined ? call.policy : { ...call.policy, local: { ...call.policy.local, ...local } };
      const result = await sandbox.run(policy, {
        command: argv.command,
        args: [...argv.args],
        ...(entry.stdin === undefined ? {} : { stdin: entry.stdin }),
        cwd: folder.managed,
        env: call.env,
        inheritEnv: false,
        denyEnv: call.denyEnv,
      });
      outcomes.push({
        id: entry.id,
        status: result.exitCode === 0 ? "passed" : "failed",
        exitCode: result.exitCode,
        ...(result.exitCode === 0 ? {} : { stderr: result.stderr.slice(0, 400) }),
      });
    }
    const failed = outcomes.filter((outcome) => outcome.status === "failed");
    const ran = outcomes.filter((outcome) => outcome.status !== "skipped").length;
    const report = {
      platform: process.platform,
      ran,
      failed: failed.length,
      failuresPer100: ran === 0 ? 0 : Math.round((failed.length / ran) * 1000) / 10,
      outcomes,
    };
    mkdirSync(join(folderOf, "results"), { recursive: true });
    writeFileSync(join(folderOf, "results", `real-${process.platform}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.info(`[sandbox usability] ${ran} ran, ${failed.length} failed: ${failed.map((outcome) => outcome.id).join(", ") || "none"}`);
    expect(failed.filter((outcome) => MUST_PASS.has(outcome.id))).toEqual([]);
  });
});
