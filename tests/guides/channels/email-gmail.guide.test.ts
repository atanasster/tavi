import { expect } from "vitest";

import { allowPerson, allowYourAddress, chatPage, connection, gmailSignedIn, messageAnswered } from "../support/rooms.js";
import { dismissChecklist } from "../support/steps.js";
import { emailSender, plusAddress } from "../support/user.js";
import { walkGuide } from "../support/walk.js";

const GUIDE = "channels/email-gmail";
let connectionId = "";

walkGuide(GUIDE, {
  configured: true,
  model: true,
  steps: {
    "label-the-mail-tavi-reads": async (walk) => {
      // Before you start: the person's Gmail signed in through their own Google client.
      connectionId = await gmailSignedIn(walk, GUIDE);
      const page = await walk.open("/settings/messaging");
      await dismissChecklist(page);
      await page.getByRole("button", { name: "Edit Gmail" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText(/^Connected as /).waitFor();
      const label = dialog.getByRole("textbox", { name: /Label to read/ });
      await expect(label.inputValue()).resolves.toBe("tavi");
      await label.scrollIntoViewIfNeeded();
      await walk.shot(dialog);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    },
    "allow-your-own-address": async (walk) => {
      const { form } = await allowYourAddress(walk, "Gmail", emailSender());
      await walk.shot(form);
      await allowPerson(walk, form, connectionId);
    },
    "email-tavi": async (walk) => {
      const chat = await messageAnswered(
        walk,
        GUIDE,
        "gmail",
        `From ${emailSender()}, send an email to ${plusAddress()} with the subject "Hello Tavi" and the text: What can you help me with, in one sentence?`,
      );
      const page = await chatPage(walk, chat.taskId);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "check-the-connection": async (walk) => {
      const page = await walk.open("/settings/messaging");
      const row = page.locator("li.row", { hasText: "Gmail" }).first();
      await row.waitFor();
      expect(connection(walk, "gmail").status.lastSendAt).toBeDefined();
      await walk.shot(row);
    },
  },
});
