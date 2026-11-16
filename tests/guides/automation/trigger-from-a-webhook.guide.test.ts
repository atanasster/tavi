import { createServer } from "node:net";

import { expect } from "vitest";

import { fireRecorded, homeNoticeShot, SEED_ZONE, scheduleFires, scheduleShown } from "../support/automation.js";
import { chats, dismissChecklist, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const NAME = "new-order";
/** The listener's port, as the guide shows it: fixed, so the pictures do not change from run to run. */
const PORT = 48731;
const ORDER = JSON.stringify({ order: "A-1042", for: "Sam", items: ["2 bags of compost"] });
const PROMPT =
  "If the webhook's data names an order, say in one line who it is for and what it holds. With no data, there is nothing to tell.";

let secret = "";
let scheduleId = "";

/** Whether nothing listens on the port yet. */
const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

/** A POST to the schedule's webhook on the walk's listener: the answer's status. */
const call = async (bearer: string, body: string): Promise<number> =>
  (
    await fetch(`http://127.0.0.1:${PORT}/hooks/schedules/${scheduleId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body,
    })
  ).status;

walkGuide("automation/trigger-from-a-webhook", {
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
    "choose-a-port-for-the-listener": async (walk) => {
      expect(await portFree(PORT), `port ${PORT} is free for the walk's listener`).toBe(true);
      const screen = await walk.terminal({
        title: "tavi channels ingress",
        args: ["channels", "ingress", "--port", String(PORT)],
        lines: 4,
      });
      expect(screen.join("\n")).toMatch(/saved/);
    },
    "turn-on-its-webhook": async (walk) => {
      // Before you start: a first message in Home, where the results go.
      const home = await walk.open("/");
      await dismissChecklist(home);
      if (!chats(walk.tavi).some((chat) => chat.chatKind === "home")) await send(home, "Hello! Just say hi back in a few words.");
      const page = await walk.open(`/center/schedule/schedules/${scheduleId}`);
      const section = page.locator(".schedule-webhook");
      await section.getByRole("button", { name: "Turn on webhook" }).click();
      const field = section.getByRole("textbox", { name: "Webhook secret", exact: true });
      await field.waitFor();
      secret = await field.inputValue();
      expect(secret).not.toBe("");
      expect(scheduleShown(walk, NAME).webhook).toBeDefined();
      // The picture never shows a secret, even a throwaway one: the field draws its characters as dots.
      await field.evaluate((input: HTMLInputElement) => input.style.setProperty("-webkit-text-security", "disc"));
      await section.scrollIntoViewIfNeeded();
      await walk.shot(section);
    },
    "call-it": async (walk) => {
      const page = await walk.page();
      await page.locator(".schedule-webhook").getByRole("button", { name: "Done" }).click();
      expect(await call(secret, ORDER)).toBe(202);
      const fire = await fireRecorded(walk, NAME, (each) => each.reasonCode === "webhook" && !/running/.test(each.outcome));
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
    "make-a-new-secret-when-you-need-one": async (walk) => {
      const page = await walk.open(`/center/schedule/schedules/${scheduleId}`);
      await page.locator(".schedule-webhook").getByRole("button", { name: "New secret" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("heading", { name: "Make a new secret?" }).waitFor();
      await walk.shot(dialog);
      await dialog.getByRole("button", { name: "New secret" }).click();
      await page.locator(".schedule-webhook").getByRole("textbox", { name: "Webhook secret", exact: true }).waitFor();
      // The old secret is refused from now on, with no detail.
      expect(await call(secret, ORDER)).toBe(401);
    },
  },
});
