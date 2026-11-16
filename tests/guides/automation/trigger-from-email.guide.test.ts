import { expect } from "vitest";

import { fireRecorded, homeNoticeShot, SEED_ZONE, scheduleFires, scheduleShown } from "../support/automation.js";
import { gmailSignedIn, pick } from "../support/rooms.js";
import { chats, dismissChecklist, send } from "../support/steps.js";
import { askUser, emailSender, plusAddress } from "../support/user.js";
import { walkGuide } from "../support/walk.js";

const GUIDE = "automation/trigger-from-email";
const NAME = "new-order";
const SUBJECT = "new order";
const PROMPT = "If the email names an order, say in one line who it is for and what it holds. With no email, there is nothing to tell.";

let scheduleId = "";

walkGuide(GUIDE, {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "make-the-schedule": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi schedules add",
        args: [
          ...["schedules", "add", "--name", NAME, "--at", "09:00", "--timezone", "Europe/London"],
          ...["--deliver-to", "home", "--notify", "when-sent", "--prompt", PROMPT],
        ],
        lines: 4,
      });
      expect(screen.join("\n")).toContain(NAME);
      scheduleId = scheduleShown(walk, NAME).scheduleId;
    },
    "turn-on-its-email-trigger": async (walk) => {
      // Before you start: the person's Gmail signed in, and a first message in Home.
      await gmailSignedIn(walk, GUIDE);
      const home = await walk.open("/");
      await dismissChecklist(home);
      if (!chats(walk.tavi).some((chat) => chat.chatKind === "home")) await send(home, "Hello! Just say hi back in a few words.");
      const page = await walk.open(`/center/schedule/schedules/${scheduleId}`);
      const section = page.locator(".schedule-email-trigger");
      await section.getByRole("button", { name: "Set up" }).click();
      await pick(page, section.getByRole("combobox", { name: "Email connection" }), /^Gmail/);
      await section.getByRole("textbox", { name: "From" }).fill(emailSender());
      await section.getByRole("textbox", { name: "Subject holds (optional)" }).fill(SUBJECT);
      await section.scrollIntoViewIfNeeded();
      await walk.shot(section);
      await section.getByRole("button", { name: "Turn on email trigger" }).click();
      await expect.poll(() => JSON.stringify(scheduleShown(walk, NAME)), { timeout: 15_000 }).toContain("emailTrigger");
    },
    "send-it-an-email": async (walk) => {
      let fired = false;
      await askUser(
        GUIDE,
        `From ${emailSender()}, send an email to ${plusAddress()} with the subject "New order A-1042" and the text: 2 bags of compost for Sam`,
        async () =>
          (fired = (await fireRecorded(walk, NAME, (fire) => fire.reasonCode === "email", 2_000).catch(() => undefined)) !== undefined),
      );
      expect(fired).toBe(true);
      const fire = await fireRecorded(walk, NAME, (each) => each.reasonCode === "email" && !/running/.test(each.outcome));
      expect(fire.outcome).toMatch(/completed$/);
      const fires = await scheduleFires(walk, scheduleId, 1);
      await fires.page
        .getByRole("link", { name: /Open its task/ })
        .first()
        .waitFor();
      await walk.shot(fires.box);
      await fires.remove();
    },
    "read-the-result-in-home": async (walk) => {
      await homeNoticeShot(walk, NAME, dismissChecklist);
    },
    "turn-it-off": async (walk) => {
      await walk.terminal({ title: "tavi schedules email-trigger", args: ["schedules", "email-trigger", NAME, "off"] });
      expect(JSON.stringify(scheduleShown(walk, NAME))).not.toContain("emailTrigger");
    },
  },
});
