import { join } from "node:path";

import { expect } from "vitest";

import { root } from "../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../support/automation.js";
import { askForApproval, dismissChecklist, lastAnswer, restartOwner, send, turnEnded } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface History {
  readonly items: readonly Record<string, unknown>[];
}

const DIGEST_TOOLS = ["trends.radar.sweep", "trends.radar.velocity", "trends.radar.cluster", "trends.radar.brief"];

walkGuide("automation/trend-routine", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  timeoutMs: 20 * 60_000,
  steps: {
    "add-the-trends-app": async (walk) => {
      // The repository's built plugin (pnpm --filter @tavi/plugin-trends build), installed, approved and enabled.
      walk.tavi("plugins", "install", join(root, "packages/external/trends/dist-plugin"));
      walk.tavi("plugins", "approve", "trends.radar", "0.1.0");
      walk.tavi("plugins", "enable", "trends.radar");
      const screen = await walk.terminal({ title: "tavi plugins show trends.radar", args: ["plugins", "show", "trends.radar"], lines: 12 });
      expect(screen.join("\n")).toMatch(/state: enabled/);
      // A plugin composes when the owner starts.
      await restartOwner(walk.dataDir, []);
    },
    "name-a-topic-to-watch": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await askForApproval(page, "Use trends.radar.watch to start watching the topic solid-state batteries.");
      const card = page.locator("section.round").last();
      await expect(card.textContent()).resolves.toContain("trends.radar.watch");
      await walk.shot(card);
      await card.getByRole("button", { name: "Allow once" }).click();
      await turnEnded(page);
      const decided = walk.taviJson<History>("approvals", "history").items;
      expect(decided.some((item) => item["toolId"] === "trends.radar.watch" && item["state"] === "granted")).toBe(true);
    },
    "see-how-it-is-moving": async (walk) => {
      const page = await walk.page();
      await send(page, "Run trends.radar.sweep now: how is it trending, compared with last week?");
      const home = walk
        .taviJson<{ tasks: { taskId: string; chatKind?: string }[] }>("tasks")
        .tasks.find((task) => task.chatKind === "home");
      expect(walk.tavi("tasks", "history", home?.taskId ?? "")).toContain("trends.radar.sweep");
      const answer = await lastAnswer(page);
      await walk.shot(undefined, { mask: [answer.locator(".text"), page.locator("main .markdown")], frame: "answer" });
    },
    "get-a-digest-every-morning": async (walk) => {
      walk.tavi(
        ...[
          "schedules",
          "add",
          "--name",
          "trends-digest",
          "--at",
          "08:00",
          "--timezone",
          "Europe/London",
          "--allow",
          DIGEST_TOOLS.join(","),
        ],
        ...["--deliver-to", "home", "--prompt", "Sweep my trend topics and give me a short digest of what moved."],
      );
      const schedule = walk.taviJson<{ autoApproveTools: readonly string[]; deliverTo: string }>("schedules", "show", "trends-digest");
      expect(schedule).toMatchObject({ deliverTo: "home" });
      expect([...schedule.autoApproveTools].sort()).toEqual([...DIGEST_TOOLS].sort());
      const screen = await walk.terminal({
        title: "tavi schedules show trends-digest",
        args: ["schedules", "show", "trends-digest"],
        lines: 24,
      });
      expect(screen.join("\n")).toContain("trends.radar.sweep");
    },
  },
});
