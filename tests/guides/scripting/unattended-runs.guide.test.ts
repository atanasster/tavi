import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { root } from "../../../scripts/docs/browser.mjs";
import { taviScript } from "../support/scripting.js";
import { chats, projectsFolder, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

const SUMMARY = "Write a one-line summary of the last git commit into SUMMARY.md.";
const DIGEST = "List the last three commits, one line each.";
/** The hook's one line, as step 3 shows it. */
const HOOK = `tavi run --approval approve --quiet --folder "$(git rev-parse --show-toplevel)" "${SUMMARY}"`;
/** The cron job's tavi command, as step 4 shows it inside its crontab line. */
const CRON = `tavi run --approval deny --quiet "${DIGEST}"`;

/** The reader's `~/code/app`: a git repository. */
let app = "";

/**
 * `git` in the throwaway repository, with a fixed author and date (so the pictures do not change) and no hooks: the
 * walk never lets git run a hook it wrote, which macOS would hold on its first run.
 */
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], {
    cwd: app,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-02T09:00:00Z", GIT_COMMITTER_DATE: "2026-11-02T09:00:00Z" },
  });

const summary = () => join(app, "SUMMARY.md");
const latest = (tavi: (...args: string[]) => string) => chats(tavi).find((chat) => chat.chatKind === "run");

walkGuide("scripting/unattended-runs", {
  configured: true,
  model: true,
  steps: {
    "let-it-read-but-never-change": async (walk) => {
      app = join(projectsFolder("unattended-runs", { "app/README.md": "# App\n\nA tiny app that greets people.\n" }), "app");
      git("init", "-q");
      git("add", ".");
      git("commit", "-qm", "Add the README");
      await restartOwner(walk.dataDir, ["--fs-root", join(app, "..")]);
      const screen = await walk.terminal({
        title: "tavi run --approval deny",
        args: ["run", "--approval", "deny", "--folder", app, SUMMARY],
        cols: 120,
      });
      expect(screen.join("\n")).toMatch(/\[approval\] Write SUMMARY\.md/);
      expect(existsSync(summary()), "nothing was written").toBe(false);
      expect(latest(walk.tavi)?.status).toBe("completed");
    },
    "let-it-change-the-folder-it-works-in": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi run --approval approve",
        args: ["run", "--approval", "approve", "--folder", app, SUMMARY],
        cols: 120,
      });
      expect(screen.join("\n")).toMatch(/\[tool\] fs\.(write|edit) →/);
      expect(readFileSync(summary(), "utf8")).toMatch(/README/i);
      expect(latest(walk.tavi)?.status).toBe("completed");
    },
    "call-it-from-a-git-hook": async (walk) => {
      // The hook as the page shows it, in the throwaway repository; git is not let run it (see `git`).
      expect(readFileSync(join(root, "docs/use-cases/scripting/unattended-runs.md"), "utf8")).toContain(`\n${HOOK}\n`);
      const hook = join(app, ".git/hooks/post-commit");
      writeFileSync(hook, `#!/bin/sh\n${HOOK}\n`);
      execFileSync("sh", ["-n", hook]);
      writeFileSync(join(app, "CHANGELOG.md"), "# Changelog\n\n- Greets people by name.\n");
      git("add", ".");
      git("commit", "-qm", "Add a changelog");
      const before = readFileSync(summary(), "utf8");
      // What the hook runs after that commit, run once here: its folder is the repository's top.
      const screen = await walk.terminal({
        title: ".git/hooks/post-commit",
        args: ["run", "--approval", "approve", "--quiet", "--folder", git("rev-parse", "--show-toplevel").trim(), SUMMARY],
        cols: 120,
      });
      expect(screen.join("\n").trim()).not.toBe("");
      expect(readFileSync(summary(), "utf8")).not.toBe(before);
      expect(latest(walk.tavi)?.status).toBe("completed");
    },
    "run-it-on-a-timetable-with-cron": async (walk) => {
      expect(readFileSync(join(root, "docs/use-cases/scripting/unattended-runs.md"), "utf8")).toContain(`cd ~/code/app && ${CRON} >>`);
      const before = readFileSync(summary(), "utf8");
      const status = git("status", "--porcelain");
      // The crontab line's command, run once here instead of installed: `cd ~/code/app` is `--folder`.
      const screen = await walk.terminal({
        title: "crontab: tavi run --approval deny",
        args: ["run", "--approval", "deny", "--quiet", "--folder", app, DIGEST],
        cols: 120,
      });
      expect(screen.join("\n").trim()).not.toBe("");
      expect(readFileSync(summary(), "utf8"), "the digest changed nothing").toBe(before);
      expect(git("status", "--porcelain"), "nor anything else in the repository").toBe(status);
    },
    "catch-a-run-that-stopped-to-ask": async (walk) => {
      const ran = taviScript(walk.dataDir, "run", "--folder", app, SUMMARY);
      expect(ran.status, ran.stderr).toBe(3);
      const waiting = latest(walk.tavi);
      expect(waiting?.status).toBe("waiting");
      expect(ran.stderr).toContain(`tavi approvals approve ${waiting?.taskId}`);
      const screen = await walk.terminal({ title: "tavi needs", args: ["needs"], cols: 120 });
      expect(screen.join("\n")).toContain(`tavi approvals approve ${waiting?.taskId}`);
    },
  },
});
