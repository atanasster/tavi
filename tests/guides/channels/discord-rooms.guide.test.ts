import { expect } from "vitest";

import {
  allowThem,
  connection,
  DISCORD_ID,
  DISCORD_PLUGIN,
  DISCORD_VERSION,
  discordToken,
  installDiscord,
  messageAnswered,
  opened,
  pairingClaimed,
  pick,
  ROOM_LABEL,
  rooms,
  chatPage,
  YOU,
} from "../support/rooms.js";
import { dismissChecklist } from "../support/steps.js";
import { account, askUser } from "../support/user.js";
import { walkGuide } from "../support/walk.js";

const GUIDE = "channels/discord-rooms";
let connectionId = "";

walkGuide(GUIDE, {
  configured: true,
  model: true,
  steps: {
    "install-the-discord-plugin": async (walk) => {
      const screen = await walk.terminal({ title: "tavi plugins install", args: ["plugins", "install", DISCORD_PLUGIN] });
      expect(screen.join("\n")).toContain(`installed ${DISCORD_ID}@${DISCORD_VERSION} (proposed)`);
    },
    "approve-it-and-turn-it-on": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi plugins approve",
        args: ["plugins", "approve", DISCORD_ID, DISCORD_VERSION, "--in-process"],
      });
      expect(screen.join("\n")).toContain("approved");
      await installDiscord(walk, { install: true, approve: true });
    },
    "create-your-bot": async (walk) => {
      const page = await walk.open("/settings/messaging");
      await dismissChecklist(page);
      await pick(page, page.getByRole("combobox", { name: "New connection channel" }), "Discord");
      await page.getByRole("button", { name: "Add connection" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Turn Public Bot off", { exact: false }).first().waitFor();
      await walk.shot(dialog);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    },
    "add-the-bot-to-tavi": async (walk) => {
      // From here on the steps need the person's own bot (TAVI_GUIDE_PROVIDED=discord).
      const token = discordToken(walk);
      const screen = await walk.terminal({
        title: "tavi channels add",
        args: ["channels", "add", "discord", "--secret-file", `token=${token}`],
      });
      await opened(walk, "discord");
      connectionId = connection(walk, "discord").connectionId;
      expect(screen.join("\n")).toContain(connectionId);
    },
    "invite-the-bot-to-your-server": async (walk) => {
      const page = await walk.open("/settings/messaging");
      await page.locator("li.row", { hasText: "Discord" }).first().getByRole("link", { name: "Open app" }).click();
      const invite = page.getByRole("link", { name: "Invite the bot to a server" });
      await invite.waitFor({ timeout: 60_000 });
      const href = (await invite.getAttribute("href")) ?? "";
      expect(href).toMatch(/^https:\/\/discord\.com\/(api\/)?oauth2\/authorize\?/);
      const row = page.locator(".apps-account-setup").locator("xpath=ancestor::li[1]");
      await walk.shot(row);
      // The bot is in the server once the platform lists the room's channel among the ones it can see.
      await askUser(GUIDE, `Open ${href} in your browser, choose your test server (id ${account("discordGuildId")}) and Authorize`, () =>
        (rooms(walk, connectionId).candidates ?? []).some((room) => room.id === account("discordChannelId")),
      );
    },
    "allow-yourself": async (walk) => {
      const { panel } = await pairingClaimed(walk, GUIDE, {
        connectionId,
        label: "Discord",
        me: true,
        name: YOU,
        how: (code) => `In Discord, open a DM with your bot and send it: ${code}`,
      });
      await walk.shot(panel);
      await allowThem(walk, panel, connectionId, "operator", true);
    },
    "add-a-room": async (walk) => {
      const room = account("discordChannelId");
      const screen = await walk.terminal({
        title: "tavi channels rooms",
        args: ["channels", "rooms", connectionId, "add", room, "--label", ROOM_LABEL],
        cols: 120,
      });
      expect(screen.join("\n")).toContain(ROOM_LABEL);
      expect(rooms(walk, connectionId).rooms.map((each) => each.conversationId)).toEqual([room]);
    },
    "mention-the-bot-in-the-room": async (walk) => {
      const chat = await messageAnswered(
        walk,
        GUIDE,
        "discord",
        "In the room's channel, write: @<your bot> What can you help me with, in one sentence?",
        // `tavi tasks` reads the data directory, which keeps no conversation home: the room's chat names its channel.
        (each) => JSON.stringify(each).includes(account("discordChannelId")),
      );
      const page = await chatPage(walk, chat.taskId);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
  },
});
