import { expect } from "vitest";

import { spanning } from "../support/automation.js";
import { walkGuide } from "../support/walk.js";

interface Settings {
  readonly settings: { readonly timezone?: string; readonly activitySummaries?: boolean };
  readonly effective: { readonly timezone: string; readonly activitySummaries: boolean };
}

const settings = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<Settings>("config", "get");

walkGuide("run-and-maintain/workspace-settings", {
  configured: true,
  steps: {
    "see-every-setting": async (walk) => {
      const screen = await walk.terminal({ title: "tavi config get", args: ["config", "get"], cols: 160 });
      expect(screen.join("\n")).toMatch(/workspace\.timezone = Europe\/London \(default/);
      expect(screen.join("\n")).toMatch(/security\.taint = enforce/);
    },
    "change-one-in-the-terminal": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi config set",
        args: ["config", "set", "workspace.timezone", "Europe/Berlin"],
        lines: 4,
      });
      expect(screen.join("\n")).toContain("Europe/Berlin");
      expect(settings(walk).settings.timezone).toBe("Europe/Berlin");
    },
    "change-one-on-the-canvas": async (walk) => {
      const page = await walk.open("/settings/general");
      const zone = page.getByRole("heading", { name: "Timezone" });
      await page.getByText("Europe/Berlin").first().waitFor();
      const box = page.getByRole("checkbox", { name: "Summarize finished tasks" });
      await box.click();
      await expect.poll(() => settings(walk).effective.activitySummaries, { timeout: 15_000 }).toBe(false);
      await expect.poll(() => box.isChecked(), { timeout: 15_000 }).toBe(false);
      await zone.scrollIntoViewIfNeeded();
      const span = await spanning(page, zone, page.getByText("Summarize finished tasks"));
      await walk.shot(span.box);
      await span.remove();
    },
    "mistype-a-value": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi config set",
        args: ["config", "set", "workspace.timezone", "Europe/Berln"],
        tty: true,
        // Typed into, the refusal's exit status (2) is not a failed run: it is what the step shows.
        input: [{ until: "not an IANA time zone", wait: 30 }],
        lines: 4,
      });
      expect(screen.join("\n")).toMatch(/not an IANA time zone/);
      expect(settings(walk).settings.timezone).toBe("Europe/Berlin");
    },
    "put-a-setting-back": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi config unset",
        args: ["config", "unset", "workspace.timezone"],
        lines: 4,
      });
      expect(screen.join("\n")).toMatch(/Europe\/London \(default/);
      expect(settings(walk).settings.timezone).toBeUndefined();
    },
  },
});
