import { expect } from "vitest";

import {
  abortWhileCardWaits,
  desktopOn,
  grantedTo,
  grantsGiven,
  linkDesktopHelper,
  openCall,
  openScratchDocument,
  refusedDesktopCalls,
  remind,
} from "../support/apps.js";
import { allowUntilAnswered, newChat, nextCard, sendPrompt } from "../support/browser-site.js";
import { walkGuide } from "../support/walk.js";

const GUIDE = "desktop/stop-desktop-control";

/** How many answers the chat had before the action that waits: the hotkey's step allows its cards until a new one. */
let before = 0;

walkGuide(GUIDE, {
  configured: true,
  model: true,
  timeoutMs: 1_800_000,
  steps: {
    "leave-an-action-waiting": async (walk) => {
      walk.needsUser("desktop");
      // Before you start: desktop control on, TextEdit granted, the helper the person built linked in, its grants given.
      linkDesktopHelper(walk.dataDir);
      await desktopOn(walk);
      await grantsGiven(GUIDE);
      openScratchDocument();
      const page = await walk.open("/");
      await newChat(page);
      before = await sendPrompt(page, 'Type "Stop test" in my TextEdit document.');
      const card = await nextCard(page);
      await expect(card.textContent()).resolves.toMatch(/desktop\.(act|observe)/);
      await walk.shot(card);
    },
    "press-the-abort-hotkey": async (walk) => {
      const page = await walk.page();
      await walk.shot(await openCall(page, await abortWhileCardWaits(walk, page, GUIDE, before)));
    },
    "see-what-it-refuses-on-its-own": async (walk) => {
      const page = await walk.page();
      await newChat(page);
      // Refused before anyone is asked; a look at TextEdit first may ask, and is allowed.
      await allowUntilAnswered(page, await sendPrompt(page, 'Use desktop control to type "hello" in Notes.'));
      // Notes' own refusal: a look at the frontmost app first may be refused for that app instead.
      const refused = refusedDesktopCalls(walk).find((call) => /'Notes' is not granted/.test(call.said));
      expect(refused, "a desktop call in Notes refused as not granted").toBeDefined();
      await walk.shot(await openCall(page, (refused as { tool: string }).tool, "'Notes' is not granted"));
    },
    "take-its-apps-away": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi config set desktop.grantedApps none",
        args: ["config", "set", "desktop.grantedApps", "none"],
      });
      expect(screen.join("\n")).toMatch(/desktop\.grantedApps = none/);
    },
    "turn-it-off-and-revoke-the-grants": async (walk) => {
      const screen = await walk.terminal({ title: "tavi plugins disable tavi.desktop", args: ["plugins", "disable", "tavi.desktop"] });
      expect(screen.join("\n")).toMatch(/tavi\.desktop disabled/);
      // Revoking is the person's: macOS keeps the grants until they take them back.
      walk.unwalked("revoking the grants in System Settings: the person's call; the walk reminds them");
      remind(
        GUIDE,
        `when you are done with the desktop walks, turn off Accessibility and Screen Recording for ${grantedTo()} in System Settings → Privacy & Security, and close the "Tavi scratch" TextEdit document`,
      );
    },
  },
});
