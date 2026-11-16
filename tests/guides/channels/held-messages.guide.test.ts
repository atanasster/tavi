import { expect } from "vitest";

import { restartOwner } from "../support/steps.js";
import { PLACEHOLDER_NAME, addBot, askToSend, lastSend, person, stopOwner, shotTelegramChat } from "../support/telegram.js";
import { hidePersonal } from "../support/user.js";
import { completedCalls } from "../support/apps.js";
import { walkGuide } from "../support/walk.js";

const SLUG = "channels/held-messages";

interface Held {
  readonly held: readonly {
    readonly connectionId: string;
    readonly providerEventId: string;
    readonly externalSenderId: string;
  }[];
}

/** The held message the walk lets in, and its bot's connection. */
let held: Held["held"][number] | undefined;
let connection = "";

walkGuide(SLUG, {
  configured: true,
  model: true,
  timeoutMs: 30 * 60_000,
  steps: {
    "see-what-was-held": async (walk) => {
      // Where the page starts: the person's bot added, and nobody allowed on it. The sender is the person's own
      // account, not paired yet: their message is held like a stranger's.
      connection = await addBot(walk);
      expect(person(walk, "operator")).toBeUndefined();
      await askToSend(walk, SLUG, "Hi! In one sentence, what can you do?");
      // Held, not answered.
      expect(lastSend(walk)).toBe("");
      await stopOwner(walk.dataDir);
      held = walk.taviJson<Held>("inbox", "list").held.find((row) => row.connectionId === connection);
      expect(held).toBeDefined();
      hidePersonal(held?.externalSenderId as string);
      // Its event id carries the bot's numeric id (`bot:<id>:chat:<chat>:msg:<n>`): kept out of the pictures too.
      const botId = /^bot:(\d+):/.exec(held?.providerEventId ?? "")?.[1];
      if (botId !== undefined) hidePersonal(botId);
      const screen = await walk.terminal({ title: "tavi inbox list", args: ["inbox", "list"], cols: 140 });
      expect(screen.join("\n")).toContain("- (unbound)");
    },
    "allow-the-sender": async (walk) => {
      const sender = held?.externalSenderId as string;
      const screen = await walk.terminal({
        title: "tavi bindings bind",
        args: ["bindings", "bind", "--connection", connection, "--sender", sender, "--principal", "operator", "--name", PLACEHOLDER_NAME],
        cols: 120,
      });
      expect(screen.join("\n")).toContain("operator");
      expect(walk.tavi("bindings", "list")).toContain(sender);
    },
    "let-the-message-in": async (walk) => {
      const id = held?.providerEventId as string;
      // Admitting it runs its turn: on a terminal, until the command says how it went.
      const screen = await walk.terminal({
        title: "tavi inbox replay",
        args: ["inbox", "replay", id, "--connection", connection],
        tty: true,
        input: [{ until: "admitted|still unbound|already|no held message", wait: 300 }],
        cols: 120,
      });
      // The ids in it are the pictures' placeholders, not the real ones: the message's own number says which it was.
      expect(screen.join("\n")).toMatch(new RegExp(`admitted bot:\\d+:chat:\\d+:msg:${id.split(":msg:")[1] ?? ""} as operator`));
    },
    "start-tavi-again": async (walk) => {
      await restartOwner(walk.dataDir, []);
      // The replay answered the held message through the bot before it ended: the conversation shows that send done.
      await expect.poll(() => completedCalls(walk, "messaging.send"), { timeout: 60_000, interval: 2_000 }).toBeGreaterThanOrEqual(1);
      await shotTelegramChat(walk);
    },
  },
});
