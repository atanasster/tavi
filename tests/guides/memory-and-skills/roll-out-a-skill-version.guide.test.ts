import { expect } from "vitest";

import { activeVersion, fixture, fixturePath, openVersion, skillsSection, skillVersions, stopOwner } from "../support/skills.js";
import { chats, restartOwner } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const SKILL = "release-notes";
const SLUG = "roll-out-a-skill-version";
const MANIFEST = ["--name", "Release notes", "--provenance", "team wiki"];

interface Rollout {
  readonly active?: { readonly version: string; readonly pinned: boolean; readonly authorizedTaskIds: readonly string[] };
}

const rollout = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<Rollout>("skills", "rollout-status", SKILL).active;

/** The chat the new version is tried in: the one the walk's seed ran. */
let chat = "";

walkGuide("memory-and-skills/roll-out-a-skill-version", {
  configured: true,
  model: true,
  seed: [
    // Before you start: version 1.0.0 active, and a chat to try the new version in.
    ["skills", "import", SKILL, "--version", "1.0.0", "--package", fixturePath(SLUG, "release-notes-1.md"), ...MANIFEST],
    ["skills", "approve", SKILL, "--version", "1.0.0"],
    ["skills", "activate", SKILL, "--version", "1.0.0"],
    ["run", "Reply with the single word: ready."],
  ],
  steps: {
    "import-the-new-version": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi skills import",
        args: ["skills", "import", SKILL, "--version", "2.0.0", "--package", fixture(SLUG, "release-notes-2.md"), ...MANIFEST],
      });
      expect(screen.join("\n")).toContain("release-notes@2.0.0 imported: proposed, from team wiki");
      expect(skillVersions(walk.taviJson).find((row) => row.version === "2.0.0")?.reviewState).toBe("proposed");
      expect(activeVersion(walk.taviJson, SKILL)).toBe("1.0.0");
    },
    "read-it-and-approve-it": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi skills approve",
        args: ["skills", "approve", SKILL, "--version", "2.0.0"],
        tty: true,
        cols: 110,
      });
      expect(screen.join("\n")).toContain("sha256");
      expect(skillVersions(walk.taviJson).find((row) => row.version === "2.0.0")?.reviewState).toBe("approved");
    },
    "hold-it-to-one-chat": async (walk) => {
      chat = chats(walk.tavi)[0]?.taskId ?? "";
      expect(chat).not.toBe("");
      await stopOwner(walk.dataDir);
      await walk.terminal({
        title: "tavi skills pin-rollout",
        args: ["skills", "pin-rollout", SKILL, "--version", "2.0.0", "--task", chat],
      });
    },
    "activate-it": async (walk) => {
      await walk.terminal({ title: "tavi skills activate", args: ["skills", "activate", SKILL, "--version", "2.0.0"] });
      expect(activeVersion(walk.taviJson, SKILL)).toBe("2.0.0");
    },
    "check-who-gets-it": async (walk) => {
      await walk.terminal({ title: "tavi skills rollout-status", args: ["skills", "rollout-status", SKILL] });
      expect(rollout(walk)).toEqual({ version: "2.0.0", pinned: true, authorizedTaskIds: [chat] });
    },
    "open-it-to-every-chat": async (walk) => {
      await walk.terminal({ title: "tavi skills clear-rollout", args: ["skills", "clear-rollout", SKILL, "--version", "2.0.0"] });
      expect(rollout(walk)?.pinned).toBe(false);
      await restartOwner(walk.dataDir, []);
    },
    "roll-back-if-it-goes-wrong": async (walk) => {
      const { page } = await skillsSection(walk.open);
      const viewer = await openVersion(page, SKILL, "1.0.0");
      const back = viewer.getByRole("button", { name: "Roll back to this" });
      await back.waitFor();
      await viewer.getByRole("region", { name: "Activation history" }).waitFor();
      await viewer.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await walk.shot(viewer);
      await back.click();
      await expect.poll(() => activeVersion(walk.taviJson, SKILL), { timeout: 15_000 }).toBe("1.0.0");
    },
  },
});
