import { expect } from "vitest";

import { BOOKSHOP_HOST as HOST, findBooksForRecipe, fixtureSite } from "../support/browser-site.js";
import { walkGuide } from "../support/walk.js";

interface Recipes {
  readonly recipes: readonly { readonly host: string; readonly steps: readonly { readonly kind: string; readonly label?: string }[] }[];
}
interface History {
  readonly sessions: readonly { readonly host?: string; readonly lastUrl?: string; readonly url?: string }[];
}

const site = fixtureSite();

walkGuide("web-and-browser/site-recipes-and-profile", {
  configured: true,
  model: true,
  steps: {
    "ask-tavi-to-find-something-on-a-site": async (walk) => {
      // The walk names the tool that reads the results: a recipe is kept when browser.extract finds them.
      await findBooksForRecipe(walk, site);
    },
    "see-the-recipe-it-kept": async (walk) => {
      const recipe = walk.taviJson<Recipes>("browser", "recipes").recipes.find((entry) => entry.host === HOST);
      expect(recipe?.steps.map((step) => step.label)).toEqual(expect.arrayContaining(["Fiction", "Sort by price"]));
      const screen = await walk.terminal({ title: "tavi browser recipes", args: ["browser", "recipes"] });
      expect(screen.join("\n")).toContain(`${HOST} — `);
    },
    "read-the-steps-in-settings": async (walk) => {
      const page = await walk.open("/settings/general");
      await page.getByRole("heading", { name: "Browser profile" }).evaluate((heading) => heading.scrollIntoView({ block: "start" }));
      await page.getByText("Steps", { exact: true }).click();
      await page.getByText("click button “Sort by price”").waitFor();
      await expect(page.getByRole("button", { name: `Save as a site note: ${HOST}` }).isVisible()).resolves.toBe(true);
      await walk.shot();
    },
    "check-where-the-browser-went": async (walk) => {
      const { sessions } = walk.taviJson<History>("browser", "history");
      expect(sessions.length).toBeGreaterThan(0);
      const screen = await walk.terminal({ title: "tavi browser history", args: ["browser", "history"] });
      expect(screen.join("\n")).toContain("Harbour Lane Books");
    },
    "forget-a-recipe": async (walk) => {
      const screen = await walk.terminal({
        title: `tavi browser recipes --forget ${HOST}`,
        args: ["browser", "recipes", "--forget", HOST],
      });
      expect(screen.join("\n")).toContain("No site recipes.");
      expect(walk.taviJson<Recipes>("browser", "recipes").recipes).toEqual([]);
    },
    "clear-the-browser-profile": async (walk) => {
      const page = await walk.open("/settings/general");
      await page.getByRole("button", { name: "Clear browser profile…" }).click();
      const dialog = page.getByRole("dialog", { name: "Clear the browser profile?" });
      await dialog.getByRole("button", { name: "Clear profile" }).waitFor();
      // The picture is the question as the reader answers it.
      await walk.shot(dialog);
      await dialog.getByRole("button", { name: "Clear profile" }).click();
      // The notice on the page; the screen reader's announcer says it too.
      await page.locator(".notice", { hasText: "Browser profile cleared." }).waitFor();
    },
  },
});
