import { type ChildProcess, spawn, spawnSync } from "node:child_process";

import { delay } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import { cli } from "../../../scripts/docs/session.mjs";
import { stopOwner } from "../support/skills.js";
import { type Chat, chats, restartOwner } from "../support/steps.js";
import { ownerStopped, walkGuide } from "../support/walk.js";

/** The owner runs shell commands without a card, so a chat's turn stays busy on `sleep` while the walk acts on it. */
const SERVE = ["--allow", "sandbox.run"];
const PROMPT = "Run `sleep 45` in the shell, then say done.";

interface Stranded {
  readonly strandedAdmissions: {
    readonly admissions: readonly {
      readonly taskId: string;
      readonly slot: string;
      readonly execution?: { readonly generation: number };
    }[];
  };
}

/** A chat whose turn runs now: its execution holds the task's slot. */
type Running = Chat & { readonly execution?: { readonly state: string; readonly generation: number } };

/** The `tavi run`s the walk leaves going in the background, stopped when it ends. */
const runs: ChildProcess[] = [];
afterAll(() => {
  for (const run of runs) if (run.exitCode === null) run.kill("SIGKILL");
});

/** The chat step 3 stopped, which step 4 cancels. */
let aborted = "";

/** Kills the walk's own owner as a power cut would (by its data directory, never another walk's), and waits until it is gone. */
async function crashOwner(dataDir: string): Promise<void> {
  const pattern = `serve .*--data-dir ${dataDir}$`;
  ownerStopped();
  spawnSync("pkill", ["-KILL", "-f", pattern]);
  for (let waited = 0; spawnSync("pgrep", ["-f", pattern]).status === 0; waited += 250) {
    if (waited > 30_000) throw new Error("the walk's owner did not stop");
    await delay(250);
  }
}

/** Starts `tavi run` on the owner in the background, as a chat a reader left busy, and returns its task once it runs. */
async function busyChat(dataDir: string, tavi: (...args: string[]) => string): Promise<Running> {
  const before = new Set(chats(tavi).map((chat) => chat.taskId));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TAVI_"))),
    TAVI_CREDENTIAL_KEYCHAIN: "off",
  };
  runs.push(spawn(process.execPath, [cli, "run", PROMPT, "--data-dir", dataDir], { env, stdio: "ignore" }));
  for (let waited = 0; waited < 60_000; waited += 1_000) {
    const running = (chats(tavi) as Running[]).find((chat) => !before.has(chat.taskId) && chat.execution?.state === "active");
    // A few seconds in, the model has asked for the shell and the turn waits on `sleep`.
    if (running !== undefined) {
      await delay(8_000);
      return running;
    }
    await delay(1_000);
  }
  throw new Error(`no chat started running: ${JSON.stringify(chats(tavi).map((chat) => [chat.taskId, chat.status]))}`);
}

const find = (tavi: (...args: string[]) => string, taskId: string) => (chats(tavi) as Running[]).find((chat) => chat.taskId === taskId);
const status = (tavi: (...args: string[]) => string, taskId: string) => find(tavi, taskId)?.status;

walkGuide("run-and-maintain/health-check", {
  configured: true,
  model: true,
  serve: SERVE,
  steps: {
    "run-the-health-check": async (walk) => {
      const screen = await walk.terminal({ title: "tavi doctor --format text", args: ["doctor", "--format", "text"], cols: 130 });
      const text = screen.join("\n");
      expect(text).toContain("The owner is running");
      expect(text).toMatch(/Database: not checked/);
      const report = walk.taviJson<{ health: { intervalMinutes: number; now: { rssBytes: number } }; integrity: { checked: boolean } }>(
        "doctor",
      );
      expect(report.integrity.checked).toBe(false);
      expect(report.health.intervalMinutes).toBe(10);
      expect(report.health.now.rssBytes).toBeGreaterThan(0);
    },
    "check-the-database-in-depth": async (walk) => {
      await stopOwner(walk.dataDir);
      const screen = await walk.terminal({
        title: "tavi doctor --deep --format text",
        args: ["doctor", "--deep", "--format", "text"],
        cols: 130,
      });
      expect(screen.join("\n")).toContain("Database: full check, no problems");
      const report = walk.taviJson<{ integrity: { checked: boolean; mode: string; ok: boolean } }>("doctor", "--deep");
      expect(report.integrity).toMatchObject({ checked: true, mode: "full", ok: true });
      await restartOwner(walk.dataDir, SERVE);
    },
    "stop-a-turn-that-runs-too-long": async (walk) => {
      const chat = await busyChat(walk.dataDir, walk.tavi);
      const screen = await walk.terminal({ title: "tavi abort", args: ["abort", chat.taskId] });
      expect(screen.join("\n")).toContain('"aborted": true');
      for (let waited = 0; find(walk.tavi, chat.taskId)?.execution?.state === "active" && waited < 20_000; waited += 500) await delay(500);
      // Stopped, and still there to reply to: not cancelled.
      expect(find(walk.tavi, chat.taskId)?.execution?.state).not.toBe("active");
      expect(status(walk.tavi, chat.taskId)).toBe("stopped");
      aborted = chat.taskId;
    },
    "cancel-a-task-for-good": async (walk) => {
      const taskId = aborted;
      const screen = await walk.terminal({
        title: "tavi cancel",
        args: ["cancel", taskId, "--reason", "no longer needed", "--operator", "operator"],
      });
      expect(screen.join("\n")).toContain('"reason": "no longer needed"');
      expect(status(walk.tavi, taskId)).toBe("cancelled");
    },
    "free-a-task-a-crash-left-behind": async (walk) => {
      const chat = await busyChat(walk.dataDir, walk.tavi);
      await crashOwner(walk.dataDir);
      await restartOwner(walk.dataDir, SERVE);
      const report = walk.taviJson<Stranded>("doctor");
      const stranded = report.strandedAdmissions.admissions.find((entry) => entry.taskId === chat.taskId);
      expect(stranded?.slot).toBe("held");
      const generation = String(stranded?.execution?.generation);
      const screen = await walk.terminal({
        title: "tavi recover",
        args: ["recover", chat.taskId, "--generation", generation, "--reason", "the owner was killed", "--operator", "operator"],
      });
      expect(screen.join("\n")).toContain(`"generation": ${generation}`);
      const after = walk.taviJson<Stranded>("doctor");
      expect(after.strandedAdmissions.admissions.find((entry) => entry.taskId === chat.taskId)?.slot).not.toBe("held");
    },
    "read-the-logs": async (walk) => {
      const screen = await walk.terminal({ title: "tavi logs --tail 20", args: ["logs", "--tail", "20"], cols: 130 });
      // The owner's restart after the crash left its own line.
      expect(screen.join("\n")).toMatch(/^\d{4}-\d\d-\d\dT\S+\s+(warn|info|error)\s+\S/m);
    },
  },
});
