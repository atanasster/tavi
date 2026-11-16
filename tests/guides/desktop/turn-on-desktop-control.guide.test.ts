import { expect } from "vitest";

import {
  abortWhileCardWaits,
  completedCalls,
  grantedTo,
  grantsGiven,
  linkDesktopHelper,
  openCall,
  openScratchDocument,
  refusedDesktopCalls,
  remind,
} from "../support/apps.js";
import { allowUntilAnswered, newChat, sendPrompt } from "../support/browser-site.js";
import { restartOwner } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const GUIDE = "desktop/turn-on-desktop-control";
const LOOK = "Use desktop control to look at my TextEdit window, with a screenshot.";
const TYPE = 'Type "Hello from Tavi" in my TextEdit document.';

walkGuide(GUIDE, {
  configured: true,
  model: true,
  timeoutMs: 1_800_000,
  steps: {
    "turn-on-desktop-control": async (walk) => {
      const screen = await walk.terminal({ title: "tavi plugins enable tavi.desktop", args: ["plugins", "enable", "tavi.desktop"] });
      expect(screen.join("\n")).toMatch(/tavi\.desktop enabled/);
      await restartOwner(walk.dataDir, []);
    },
    "choose-the-one-app-it-may-use": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi config set desktop.grantedApps com.apple.TextEdit",
        args: ["config", "set", "desktop.grantedApps", "com.apple.TextEdit"],
      });
      expect(screen.join("\n")).toMatch(/desktop\.grantedApps = com\.apple\.TextEdit/);
    },
    "build-its-helper": async (walk) => {
      // No helper yet: the call refuses before anything reaches the screen, printing the commands that build it.
      const page = await walk.open("/");
      await newChat(page);
      // Looking asks too: its card is allowed, and the call then refuses.
      await allowUntilAnswered(page, await sendPrompt(page, LOOK));
      expect(refusedDesktopCalls(walk).some((call) => /helper is not built/.test(call.said))).toBe(true);
      // The refusal is one line of the call; the answer relays its commands: the picture is the chat, Tavi's words masked.
      const call = await openCall(page, "desktop.observe");
      await call
        .getByText(/helper is not built/)
        .first()
        .waitFor();
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
      walk.needsUser("desktop");
      // The person built the helper once, from these commands, in their accounts folder: the walk links it.
      walk.unwalked("running the build commands: the walk links the helper the person built once (codesign is theirs)");
      linkDesktopHelper(walk.dataDir);
    },
    "allow-it-in-system-settings": async (walk) => {
      await grantsGiven(GUIDE);
      // The helper starts with its permissions, as after the restart the step asks for.
      await restartOwner(walk.dataDir, []);
      openScratchDocument();
      const page = await walk.open("/");
      await newChat(page);
      await allowUntilAnswered(page, await sendPrompt(page, LOOK));
      expect(completedCalls(walk, "desktop.observe")).toBeGreaterThanOrEqual(1);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "try-the-abort-hotkey-first": async (walk) => {
      const page = await walk.page();
      await newChat(page);
      const before = await sendPrompt(page, TYPE);
      await page.locator("section.round").last().getByRole("button", { name: "Allow once" }).waitFor({ timeout: 240_000 });
      await walk.shot(await openCall(page, await abortWhileCardWaits(walk, page, GUIDE, before)));
    },
    "approve-an-action": async (walk) => {
      const page = await walk.page();
      await newChat(page);
      let pictured = false;
      await allowUntilAnswered(page, await sendPrompt(page, TYPE), {
        onCard: async (card) => {
          if (pictured || !/desktop\.act/.test((await card.textContent()) ?? "")) return;
          await walk.shot(card);
          pictured = true;
        },
      });
      expect(pictured).toBe(true);
      expect(completedCalls(walk, "desktop.act")).toBeGreaterThanOrEqual(1);
      remind(
        GUIDE,
        `the grants stay until you take them back: Stop desktop control's walk ends with that, or turn off Accessibility and Screen Recording for ${grantedTo()} in System Settings → Privacy & Security`,
      );
    },
  },
});
