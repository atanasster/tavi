import { delay } from "@tavi/test-support";
import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";

import { approveAndActivate, openVersion, reviewed, type SkillRow, skillsSection, skillVersions } from "../support/skills.js";
import { dismissChecklist, homeId, lastAnswer, projectsFolder, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const NOTES = [
  "# Standup, 3 November",
  "",
  "Ana showed the new sign-in page. Ben is still chasing the freeze.",
  "",
  "TODO Ana: write the release post",
  "TODO Ben: fix the sign-in freeze",
  "TODO Ana: book the demo room",
  "TODO Chloe: send the beta invites",
  "",
].join("\n");

/**
 * Sends `text` from the chat's composer and waits for its answer. Nothing on the way asks: reading a file is not
 * asked about, nor is a skill proposal (the seeded `seeded-skills-propose` rule), so an approval card fails the step.
 */
async function send(page: Page, text: string): Promise<void> {
  const box = page.locator(".composer-box textarea");
  const answers = page.getByRole("button", { name: "Copy response" });
  const before = await answers.count();
  await box.fill(text);
  await box.press("Enter");
  for (let waited = 0; ; waited += 1_000) {
    if (waited > 240_000) throw new Error(`"${text}" got no answer`);
    if ((await page.locator("section.round").getByRole("button", { name: "Allow once" }).count()) > 0)
      throw new Error(`"${text}" stopped on an approval card`);
    if ((await answers.count()) > before && !/^Queue/.test((await box.getAttribute("placeholder")) ?? "")) return;
    await delay(1_000);
  }
}

/** The proposals the walk's chat filed, oldest first. */
const proposals = (walk: { taviJson<T>(...args: string[]): T }, chat: string): SkillRow[] =>
  skillVersions(walk.taviJson)
    .filter((row) => row.provenance === `chat:${chat}`)
    .sort((a, b) => a.importedAt.localeCompare(b.importedAt));

let chat = "";
let first: SkillRow | undefined;
let second: SkillRow | undefined;
let edited: SkillRow | undefined;

walkGuide("memory-and-skills/review-a-proposed-skill", {
  configured: true,
  model: true,
  steps: {
    "ask-tavi-to-keep-how-it-did-a-job": async (walk) => {
      useRealTmpdir();
      const code = projectsFolder("review-a-proposed-skill", { "standup.md": NOTES });
      await restartOwner(walk.dataDir, ["--fs-root", code]);
      const page = await walk.open("/");
      await dismissChecklist(page);
      await send(page, `Read standup.md in ${code} and list its action items (lines starting with TODO) with their owners.`);
      await send(page, "That's right. Save how you did that as a skill called action-items.");
      chat = homeId(walk.tavi);
      await expect.poll(() => proposals(walk, chat).length, { timeout: 15_000 }).toBeGreaterThan(0);
      first = proposals(walk, chat)[0];
      expect(first?.reviewState).toBe("proposed");
      await page.getByText("skills.propose").first().waitFor();
      const answer = await lastAnswer(page);
      await walk.shot(undefined, { mask: [answer.locator(".text")], frame: "answer" });
    },
    "open-the-proposal": async (walk) => {
      const proposal = first as SkillRow;
      const { page, section } = await skillsSection(walk.open);
      await section.getByRole("heading", { name: "Waiting for review" }).waitFor();
      const viewer = await openVersion(page, proposal.skillId, proposal.version);
      await viewer.getByText(/^Proposed by the agent/).waitFor();
      await viewer.locator("details.soul-skill-trace ol li").first().waitFor();
      await page.setViewportSize({ width: 1280, height: 1400 });
      await viewer.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await walk.shot(viewer);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "send-it-back-with-feedback": async (walk) => {
      const proposal = first as SkillRow;
      const page = await walk.page();
      const viewer = page.locator(`section.soul-skill-viewer[aria-label="${proposal.skillId}@${proposal.version}"]`);
      await viewer.getByRole("button", { name: "Regenerate with feedback" }).click();
      const form = viewer.locator("form.soul-skill-feedback");
      await form.getByRole("textbox").fill("Also group the action items by owner.");
      await form.scrollIntoViewIfNeeded();
      await walk.shot(form);
      await form.getByRole("button", { name: "Send feedback" }).click();
      await viewer.getByText(/^Sent to chat /).waitFor({ timeout: 15_000 });
      // The chat's turn proposes it again: a second proposal from the same chat, filed without asking.
      const chatPage = await walk.open("/");
      for (let waited = 0; proposals(walk, chat).length < 2; waited += 2_000) {
        if (waited > 240_000) throw new Error("the feedback brought no second proposal");
        if ((await chatPage.locator("section.round").getByRole("button", { name: "Allow once" }).count()) > 0)
          throw new Error("the second skill proposal stopped on an approval card");
        await delay(2_000);
      }
      second = proposals(walk, chat).at(-1);
      expect(proposals(walk, chat)[0]?.reviewState).toBe("proposed");
    },
    "edit-the-new-proposal": async (walk) => {
      const proposal = second as SkillRow;
      const { page } = await skillsSection(walk.open);
      const viewer = await openVersion(page, proposal.skillId, proposal.version);
      await viewer.getByRole("button", { name: "Edit", exact: true }).click();
      const box = viewer.locator("form.soul-skill-edit textarea");
      const text = await box.inputValue();
      await box.fill(`${text.trimEnd()}\n\nLeave out a line marked DONE: it is no longer an action item.\n`);
      await viewer.getByRole("button", { name: "Save as a new version" }).click();
      await expect.poll(() => proposals(walk, chat).some((row) => row.version.startsWith("edited-")), { timeout: 15_000 }).toBe(true);
      edited = proposals(walk, chat).find((row) => row.version.startsWith("edited-"));
      await reviewed(walk.taviJson, proposal.skillId, proposal.version, "rejected");
      const after = page.locator(`section.soul-skill-viewer[aria-label="${edited?.skillId}@${edited?.version}"]`);
      await after.locator(".diff-added").first().waitFor();
      await page.setViewportSize({ width: 1280, height: 1400 });
      await after.evaluate((element) => element.scrollIntoView({ block: "center" }));
      // The added lines come at the end of the body, which scrolls inside the viewer: brought into it.
      await after
        .locator(".diff-added")
        .first()
        .evaluate((line) => line.scrollIntoView({ block: "nearest" }));
      await walk.shot(after);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "approve-it-then-activate-it": async (walk) => {
      const version = edited as SkillRow;
      const page = await walk.page();
      const viewer = page.locator(`section.soul-skill-viewer[aria-label="${version.skillId}@${version.version}"]`);
      await approveAndActivate(walk, viewer, version.skillId, version.version, true);
      // The first proposal still waits: rejected from its own review.
      const proposal = first as SkillRow;
      const left = await openVersion(page, proposal.skillId, proposal.version);
      await left.getByRole("button", { name: "Reject", exact: true }).click();
      await reviewed(walk.taviJson, proposal.skillId, proposal.version, "rejected");
    },
  },
});
