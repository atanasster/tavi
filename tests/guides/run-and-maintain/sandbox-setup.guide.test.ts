import { expect } from "vitest";

import { walkGuide } from "../support/walk.js";

interface Check {
  readonly tier: string;
  readonly checks: readonly { readonly name: string; readonly ok: boolean }[];
}

const allOk = (check: Check) => check.checks.length > 0 && check.checks.every((item) => item.ok);

walkGuide("run-and-maintain/sandbox-setup", {
  configured: false,
  steps: {
    "check-the-sandbox": async (walk) => {
      const screen = await walk.terminal({ title: "tavi sandbox check", args: ["sandbox", "check"] });
      expect(screen.join("\n")).toMatch(/^sandbox: full /m);
      const check = walk.taviJson<Check>("sandbox", "check");
      expect(check.tier).toBe("full");
      expect(allOk(check)).toBe(true);
    },
    "see-what-it-bounds": async (walk) => {
      const screen = await walk.terminal({ title: "tavi doctor --format text", args: ["doctor", "--format", "text"], cols: 130 });
      const text = screen.join("\n");
      expect(text).toContain("Sandbox: full");
      for (const workload of ["run", "server", "worker", "browser", "pdf", "video"])
        expect(text).toMatch(new RegExp(`^ +${workload}: \\d+ MiB`, "m"));
    },
    "on-linux-run-the-one-time-setup": async (walk) => {
      // `tavi sandbox setup` takes no --data-dir, which every command a walk runs carries, so the picture is the
      // command's help: what setup prints and the flags that run or undo it. The Linux output in the step was taken
      // in a Debian container (node:26-slim, no bubblewrap).
      walk.unwalked("tavi sandbox setup: it refuses the --data-dir every walk command carries; on macOS it prints that nothing is needed");
      const screen = await walk.terminal({ title: "tavi sandbox --help", args: ["sandbox", "--help"] });
      const text = screen.join("\n");
      for (const flag of ["--apply", "--remove", "--copy", "--refresh-hook", "--group", "--nested"]) expect(text).toContain(flag);
      walk.unwalked("tavi sandbox setup --apply: it runs a root block with sudo");
    },
    "in-a-container-try-the-nested-mode": async (walk) => {
      const screen = await walk.terminal({ title: "tavi sandbox check --nested", args: ["sandbox", "check", "--nested"] });
      expect(screen.join("\n")).toMatch(/^sandbox: nested /m);
      expect(allOk(walk.taviJson<Check>("sandbox", "check", "--nested"))).toBe(true);
      walk.unwalked("tavi serve --sandbox-nested: this Mac runs the full sandbox, so the walk's owner keeps it");
    },
  },
});
