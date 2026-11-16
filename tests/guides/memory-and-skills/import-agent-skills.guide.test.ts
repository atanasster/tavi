import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { approveAndActivate, fixture, openVersion, skillsSection, skillVersions } from "../support/skills.js";
import { allowOnce, askForApproval, dismissChecklist, homeId, lastAnswer } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const SKILL = "meeting-minutes";
const VERSION = "0.3.0";
const NOTES =
  "Standup, 3 November. Present: Ana, Ben, Chloe. Decided: ship the beta on Friday. " +
  "TODO Ana: write the release post. ACTION Ben: fix the sign-in freeze. TODO Chloe: book the demo room.";

walkGuide("memory-and-skills/import-agent-skills", {
  configured: true,
  model: true,
  steps: {
    "import-the-package": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi skills import",
        args: ["skills", "import", fixture("import-agent-skills", SKILL)],
      });
      expect(screen.join("\n")).toContain(`archive:${SKILL}`);
      const row = skillVersions(walk.taviJson).find((each) => each.skillId === SKILL);
      expect(row?.version).toBe(VERSION);
      expect(row?.reviewState).toBe("proposed");
    },
    "read-every-file": async (walk) => {
      const { page } = await skillsSection(walk.open);
      const viewer = await openVersion(page, SKILL, VERSION);
      await viewer.getByText(/written by another author/).waitFor();
      await viewer.getByText(/a ceiling, never a grant/).waitFor();
      await viewer.getByRole("region", { name: "scripts/count_actions.py", exact: true }).waitFor();
      // The whole review, every file down to the script, is taller than the window.
      await page.setViewportSize({ width: 1280, height: 1700 });
      await viewer.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await walk.shot(viewer);
    },
    "approve-it-then-activate-it": async (walk) => {
      const page = await walk.page();
      // Another author's archive: Approve asks once, as the CLI asks for --yes.
      await approveAndActivate(walk, page.locator(`section.soul-skill-viewer[aria-label="${SKILL}@${VERSION}"]`), SKILL, VERSION, true);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "ask-for-the-job-it-does": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await askForApproval(
        page,
        `Use the meeting-minutes skill to write up these notes as minutes, and save them as minutes.md in this chat's folder: ${NOTES}`,
      );
      await page.getByText("skills.read").first().waitFor();
      const card = page.locator("section.round").last();
      await card.getByText("Why am I asked?").waitFor();
      await walk.shot(card);
    },
    "allow-what-you-expect": async (walk) => {
      const page = await walk.page();
      await allowOnce(page);
      expect(existsSync(join(walk.dataDir, "chats/default", homeId(walk.tavi), "minutes.md"))).toBe(true);
      const answer = await lastAnswer(page);
      await walk.shot(undefined, { mask: [answer.locator(".text")] });
    },
  },
});
