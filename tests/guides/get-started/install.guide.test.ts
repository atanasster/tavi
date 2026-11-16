import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import { root } from "../../../scripts/docs/browser.mjs";
import { walkGuide } from "../support/walk.js";

/** The walk's own folder: the temporary clone and a home of its own, deleted at the end. Nothing is installed globally. */
const directories = temporaryDirectories();
const scratch = directories.create("tavi-docs-install-");
afterAll(() => directories.cleanup());

const VERSION = /^tavi \d+\.\d+\.\d+ \([0-9a-f]{12}\)$/m;

/** A login-free shell with only this walk's home and a PATH holding node and the system tools. */
function shell(script: string, home: string): string {
  return execFileSync("bash", ["--noprofile", "--rcfile", join(home, ".bashrc"), "-i", "-c", script], {
    encoding: "utf8",
    env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TAVI_NO_REBUILD: "1", TERM: "dumb" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

walkGuide("get-started/install", {
  configured: false,
  steps: {
    "clone-and-build": async (walk) => {
      // The clone is real (of this checkout, shallow, into the walk's folder); it is the same commit the build here is of.
      const clone = join(scratch, "tavi");
      execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${root}`, clone], { stdio: "ignore", timeout: 120_000 });
      const head = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      expect(head(clone)).toBe(head(root));
      walk.unwalked(
        "pnpm install and pnpm run build in the clone: they take minutes and compile the native SQLite driver; the walk uses this checkout's build of the same commit",
      );
      const screen = await walk.terminal({ title: "node scripts/tavi.mjs --version", args: ["--version"] });
      expect(screen.join("\n")).toMatch(VERSION);
      expect(screen.join("\n")).toContain(head(root).slice(0, 12));
    },
    "put-tavi-on-your-path": async (walk) => {
      // The alias goes into a startup file in the walk's own home, from the checkout's folder, as the step says.
      const home = join(scratch, "home");
      execFileSync("mkdir", ["-p", home]);
      execFileSync("bash", ["-c", `echo "alias tavi=\\"node $(pwd)/scripts/tavi.mjs\\"" >> "$HOME/.bashrc"`], {
        cwd: root,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
      });
      expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain(`alias tavi="node ${root}/scripts/tavi.mjs"`);
      // A new terminal, in another folder: `tavi` answers there.
      expect(shell(`cd "${scratch}" && tavi --version`, home)).toMatch(VERSION);
      const screen = await walk.terminal({ title: "tavi onboard status", args: ["onboard", "status"], tty: true, input: [{ wait: 4 }] });
      const text = screen.join("\n");
      expect(text).toMatch(/○ Choose the model/);
      expect(text).toContain("run tavi onboard");
    },
    "check-the-sandbox": async (walk) => {
      const screen = await walk.terminal({ title: "tavi sandbox check", args: ["sandbox", "check"] });
      expect(screen.join("\n")).toMatch(/^sandbox: /m);
      const check = walk.taviJson<{ tier: string; checks: { name: string; ok: boolean }[] }>("sandbox", "check");
      expect(check.checks.every((item) => item.ok)).toBe(true);
    },
    "start-tavi-and-open-the-chat": async (walk) => {
      // The walk's owner (tavi serve) is already running on its throwaway data directory.
      const screen = await walk.terminal({ title: "tavi chat", args: ["chat"], tty: true, input: [{ wait: 6 }] });
      expect(screen.join("\n")).toContain("No model is set up");
      expect(screen.join("\n")).toContain("tavi onboard");
    },
  },
});
