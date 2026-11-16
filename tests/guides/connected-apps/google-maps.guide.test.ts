import { expect } from "vitest";

import {
  approveAndTurnOn,
  askInNewChat,
  chooseSuggestedForFlagged,
  dialogOf,
  discoverCard,
  pasteKeyAndTest,
  reviewFromSheet,
  shownApp,
} from "../support/apps.js";
import { walkGuide } from "../support/walk.js";

walkGuide("connected-apps/google-maps", {
  configured: true,
  model: true,
  steps: {
    "add-google-maps": async (walk) => {
      const page = await walk.open("/settings/apps/discover");
      const card = await discoverCard(page, "Google Maps");
      await card.getByRole("button", { name: "Add", exact: true }).click();
      const sheet = dialogOf(page);
      await sheet.getByText("What it can do").first().waitFor();
      await walk.shot(sheet);
      await sheet.getByRole("button", { name: "Next" }).click();
    },
    "paste-your-key": async (walk) => {
      await pasteKeyAndTest(walk, { gate: "google-maps", file: "google-maps.key", pluginId: "mcp.gmaps", tools: 6 });
    },
    "review-its-tools": async (walk) => {
      const page = await walk.page();
      await page.setViewportSize({ width: 1280, height: 1000 });
      const dialog = await reviewFromSheet(page);
      // Google's descriptions name each other's tools (and one a link), so the review flags them: each waits on
      // "Choose…" until the person picks an effect. All six are read-only by Google's own annotations.
      expect(await chooseSuggestedForFlagged(page, dialog)).toBeGreaterThan(0);
      await walk.shot(dialog);
    },
    "turn-it-on": async (walk) => {
      const page = await walk.page();
      await approveAndTurnOn(page, "Google Maps");
      expect(shownApp(walk, "google-maps").accounts[0]?.on).toBe(true);
      const section = page.getByRole("region", { name: "What it can do" });
      await section.scrollIntoViewIfNeeded();
      await walk.shot(section);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "ask-about-a-place": async (walk) => {
      const home = await walk.open("/");
      await askInNewChat(
        walk,
        home,
        "Use Google Maps: find a café near the British Museum and how long the walk from King's Cross takes.",
        ["mcp.gmaps.search_places", "mcp.gmaps.compute_routes"],
      );
    },
  },
});
