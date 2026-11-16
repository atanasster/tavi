import { expect } from "vitest";

import { allowOnce, askForApproval, dismissChecklist, restartOwner } from "../support/steps.js";
import { addBot, lastSend, person, sendCodeFrom, sentSince } from "../support/telegram.js";
import { walkGuide } from "../support/walk.js";

const SLUG = "channels/message-someone-by-name";

/**
 * Ana is played by the person's own Telegram account, paired under a person ID of its own: the one message the walk
 * sends goes to the person themselves, nobody else.
 */
const ANA = { principal: "ana", name: "Ana" };

let connection = "";

interface Pending {
  readonly rows: readonly { readonly record: { readonly toolId: string } }[];
}

walkGuide(SLUG, {
  configured: true,
  model: true,
  timeoutMs: 30 * 60_000,
  steps: {
    "allow-them-with-a-name": async (walk) => {
      // Where the page starts: the person's bot added.
      connection = await addBot(walk);
      const page = await walk.open("/settings/people");
      const form = page.locator("form", { has: page.getByRole("heading", { name: "Allow a person" }) });
      await form.getByRole("textbox", { name: "Person ID" }).fill(ANA.principal);
      await form.getByRole("textbox", { name: "Display name" }).fill(ANA.name);
      await walk.shot(form);
      await form.getByRole("button", { name: "Pair with a code" }).click();
      const pairing = page.getByRole("region", { name: "Pairing" });
      await pairing.getByRole("img", { name: /QR code/ }).waitFor();
      await sendCodeFrom(pairing, pairing.getByRole("button", { name: "Allow them" }), SLUG);
      // The question names the person's Telegram account: it is answered, never pictured.
      await pairing.getByRole("button", { name: "Allow them" }).click();
      await expect.poll(() => person(walk, ANA.principal)?.displayName, { timeout: 15_000 }).toBe(ANA.name);
    },
    "let-tavi-send-to-their-chat": async (walk) => {
      const screen = await walk.terminal({ title: "tavi channels people", args: ["channels", "people", "telegram"], cols: 120 });
      expect(screen.join("\n")).toMatch(/\bana\b.*\bAna\b/);
      const ana = person(walk, ANA.principal)?.externalSenderId as string;
      await restartOwner(walk.dataDir, ["--messaging-allow-destination", `${connection}:${ana}`]);
    },
    "ask-tavi-to-message-them": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await askForApproval(page, "Send Ana a message on Telegram: Dinner is at 7 tonight.");
      expect(walk.taviJson<Pending>("approvals", "list").rows.map((row) => row.record.toolId)).toEqual(["messaging.send_to"]);
      const card = page.locator("section.round").last();
      // The card names where Ana resolved to: her name, the connection and her chat.
      await expect(card.textContent()).resolves.toContain(`Ana (${connection}:`);
      await walk.shot(card);
    },
    "allow-it": async (walk) => {
      const page = await walk.page();
      const since = lastSend(walk);
      await allowOnce(page);
      await sentSince(walk, since, 60_000);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
  },
});
