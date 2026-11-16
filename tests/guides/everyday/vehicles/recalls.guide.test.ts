import { expect } from "vitest";

import type { Locator, Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE, spanning } from "../../support/automation.js";
import { promptAnswered, readFromTheTop, recipePrompt, searchedTheWeb } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = recipePrompt("travel.recalls", { "make, model, year": "Honda Civic 2018" });

let page: Page;

/** A row of `tavi schedules list`. */
interface Row {
  readonly spec: { readonly at?: string; readonly daysOfWeek?: readonly number[] };
}

/**
 * **Repeat this…** on the message `prompt`, set to Mondays at 09:00: a chat that only searched opens **Create routine**,
 * and one that used anything else **Create schedule**, whose name is filled in from the message too.
 */
async function repeatOnMondays(page: Page, prompt: string): Promise<Locator> {
  const message = page.locator("article").filter({ hasText: prompt }).first();
  await message.hover();
  await message.getByRole("button", { name: "Repeat this…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Create (routine|schedule)$/ });
  await dialog.getByText("Filled in from this chat").waitFor({ timeout: 15_000 });
  await dialog.getByRole("radio", { name: "On days of the week" }).check();
  await dialog.getByRole("button", { name: "Weekdays" }).click();
  for (const day of ["Tue", "Wed", "Thu", "Fri"]) await dialog.getByRole("button", { name: day, exact: true }).click();
  await dialog.getByRole("textbox", { name: "Time", exact: true }).fill("09:00");
  await dialog.locator(".cadence-preview ol li").nth(2).waitFor();
  return dialog;
}

walkGuide("everyday/vehicles/recalls", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptAnswered(walk, PROMPT);
    },
    "read-the-result": async (walk) => {
      await searchedTheWeb(page);
      // The picture stops before the model's own list of campaigns: its numbers can be wrong, and a page keeps them for good.
      const answer = await lastAnswer(page);
      const start = await answer.boundingBox();
      const list = await answer
        .getByRole("heading", { name: /(major|known|notable|recalls? (for|on|affecting))/i })
        .first()
        .boundingBox();
      expect(list, "the answer lists recalls under a heading").not.toBeNull();
      await readFromTheTop(walk, page, Math.ceil((list?.y ?? 0) - (start?.y ?? 0)) - 8);
    },
    "make-it-recurring": async (walk) => {
      const dialog = await repeatOnMondays(page, PROMPT);
      await page.setViewportSize({ width: 1280, height: 1400 });
      const span = await spanning(
        page,
        dialog.getByRole("heading").first(),
        dialog.getByRole("button", { name: /^Save (routine|schedule)$/ }),
      );
      await walk.shot(span.box);
      await span.remove();
      await page.setViewportSize({ width: 1280, height: 800 });
      await dialog.getByRole("button", { name: /^Save (routine|schedule)$/ }).click();
      await dialog.waitFor({ state: "detached", timeout: 120_000 });
      // The weekly run is listed among the schedules, a routine's trigger under its routine.
      await expect
        .poll(() => walk.taviJson<readonly Row[]>("schedules", "list")[0]?.spec, {
          timeout: 30_000,
        })
        .toMatchObject({ at: "09:00", daysOfWeek: [1] });
    },
  },
});
