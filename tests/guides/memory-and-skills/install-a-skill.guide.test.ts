import { expect } from "vitest";

import { activeVersion, approveAndActivate, fixture, openVersion, skillsSection, skillVersions } from "../support/skills.js";
import { dismissChecklist, lastAnswer, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const SKILL = "release-notes";
const VERSION = "1.0.0";

const uses = (walk: { taviJson<T>(...args: string[]): T }) =>
  skillVersions(walk.taviJson).find((row) => row.skillId === SKILL)?.usage?.uses ?? 0;

walkGuide("memory-and-skills/install-a-skill", {
  configured: true,
  model: true,
  steps: {
    "write-a-skill-md-and-import-it": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi skills import",
        args: ["skills", "import", fixture("install-a-skill", SKILL), "--provenance", "my own notes"],
      });
      expect(screen.join("\n")).toContain(SKILL);
      const row = skillVersions(walk.taviJson).find((each) => each.skillId === SKILL);
      expect(row?.version).toBe(VERSION);
      expect(row?.reviewState).toBe("proposed");
    },
    "read-it-before-you-approve-it": async (walk) => {
      const { page, section } = await skillsSection(walk.open);
      await section.getByRole("heading", { name: "Waiting for review" }).waitFor();
      const viewer = await openVersion(page, SKILL, VERSION);
      await viewer.getByText("Group the changes under").waitFor();
      await viewer.scrollIntoViewIfNeeded();
      await walk.shot(viewer);
    },
    "approve-it-then-activate-it": async (walk) => {
      const page = await walk.page();
      await approveAndActivate(walk, page.locator(`section.soul-skill-viewer[aria-label="${SKILL}@${VERSION}"]`), SKILL, VERSION);
    },
    "ask-for-the-job-it-does": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await send(
        page,
        "Write release notes for version 2.1.0: you can now export a chat as a PDF, and the sign-in page no longer freezes. Priya reported the freeze.",
      );
      // The chat loaded the skill: a use is recorded.
      await expect.poll(() => uses(walk), { timeout: 15_000 }).toBeGreaterThan(0);
      await page.getByText("skills.read").first().waitFor();
      const answer = await lastAnswer(page);
      await walk.shot(undefined, { mask: [answer.locator(".text")] });
    },
    "see-that-it-was-used": async (walk) => {
      const screen = await walk.terminal({ title: "tavi skills list", args: ["skills", "list"] });
      expect(screen.join("\n")).toContain(SKILL);
    },
    "turn-it-off": async (walk) => {
      const { section } = await skillsSection(walk.open);
      const row = section.getByRole("article", { name: SKILL });
      await row.getByRole("button", { name: "Disable" }).click();
      await row.getByText("not active").waitFor();
      expect(activeVersion(walk.taviJson, SKILL)).toBeUndefined();
      await walk.shot(row);
    },
  },
});
