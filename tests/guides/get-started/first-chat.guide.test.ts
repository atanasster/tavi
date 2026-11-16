import { expect } from "vitest";

import { askInChat } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const QUESTION = "In one sentence, what can you help me with?";

walkGuide("get-started/first-chat", {
  configured: true,
  model: true,
  steps: {
    "open-the-chat": async (walk) => {
      const screen = await walk.terminal({ title: "tavi chat", args: ["chat"], tty: true, input: [{ wait: 5 }] });
      expect(screen.join("\n")).toContain("/help lists the commands");
    },
    "ask-something": async (walk) => {
      const screen = await askInChat(walk, QUESTION);
      // The answer arrived and the turn finished: the prompt is back.
      expect(screen.join("\n"), screen.join("\n")).toMatch(/Done\./);
      expect(screen.at(-1)).toMatch(/^❯/);
    },
    "see-what-you-can-type": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [{ wait: 4 }, { text: "/help", wait: 1 }, { text: "\r" }, { until: "commands", wait: 15 }],
        lines: 16,
      });
      expect(screen.join("\n")).toContain("/needs");
    },
    "come-back-later": async (walk) => {
      // Reopened, Home shows the earlier turn again; Ctrl-C then leaves it cleanly.
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [{ wait: 5 }, { text: "\u0003", wait: 2 }],
      });
      expect(screen.join("\n")).toContain(QUESTION);
      expect(screen.join("\n")).not.toMatch(/Error|\bat .+:\d+:\d+/);
    },
  },
});
