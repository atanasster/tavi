import { spawnSync } from "node:child_process";
import type { SandboxPort } from "@tavi/contracts";

/** A sandbox that runs the command unconfined, as the sandbox would with everything allowed: for tests about what runs, not where. */
export const directSandbox: SandboxPort = {
  capabilities: () => ({ available: true, platforms: ["darwin"] }),
  run: async (_policy, command) => {
    const run = spawnSync(command.command, [...(command.args ?? [])], { cwd: command.cwd, encoding: "utf8" });
    return {
      session: { sessionId: "s", state: "completed" },
      exitCode: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      truncated: false,
    };
  },
  cancel: async () => {},
  dispose: async () => {},
};
