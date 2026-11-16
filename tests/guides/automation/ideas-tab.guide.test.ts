import { expect } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { SEED_ZONE, spanning } from "../support/automation.js";
import { dismissChecklist } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Idea {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly prompt: string;
  readonly pinned: boolean;
  readonly status: string;
  readonly basis: readonly { readonly kind: string }[];
}
interface Ideas {
  readonly ideas: readonly Idea[];
  readonly lastRun?: { readonly trigger?: string } | null;
}
type Schedules = readonly { readonly name: string; readonly routineId?: string }[];

/** The catalogue's flight-fare idea, the one the seeded memory about a trip makes personal: it repeats daily. */
const FARES = "travel.fare-watch";

type Walk = { taviJson<T>(...args: string[]): T };
const fares = (walk: Walk): Idea | undefined => walk.taviJson<Ideas>("ideas", "list", "--all").ideas.find((idea) => idea.key === FARES);

/** The flight-fare idea's card on the Ideas tab, found by the title the owner gave it. */
function card(page: Page, walk: Walk): Locator {
  const idea = fares(walk);
  if (idea === undefined) throw new Error("no flight-fare idea");
  return page.getByRole("article", { name: idea.title, exact: true }).first();
}

walkGuide("automation/ideas-tab", {
  configured: true,
  model: true,
  // Something the reader told Tavi, so an idea cites it.
  seed: [[...SEED_ZONE], ["memory", "remember", "--body", "I'm flying to Lisbon in March to visit my sister, and I want a cheap flight."]],
  steps: {
    "open-the-ideas-tab": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await page.getByRole("navigation", { name: "pages" }).getByRole("button", { name: "Ideas" }).click();
      await page.getByRole("heading", { name: "Ideas", level: 1 }).waitFor();
      await page.getByRole("button", { name: "Refresh" }).click();
      // The look runs on the owner; the fast model rewords the ideas that cite something of yours.
      await expect
        .poll(() => fares(walk)?.basis.some((basis) => basis.kind === "memory") ?? false, { timeout: 180_000, interval: 3_000 })
        .toBe(true);
      const forYou = page.getByRole("region", { name: "For you" });
      await forYou.getByRole("article", { name: fares(walk)?.title ?? "", exact: true }).waitFor({ timeout: 60_000 });
      await walk.shot(undefined, { mask: [page.locator("main article")] });
    },
    "pin-the-one-you-want-to-keep": async (walk) => {
      const page = await walk.page();
      const idea = card(page, walk);
      await idea.getByRole("button", { name: /^More for/ }).click();
      await idea.getByRole("button", { name: "Pin" }).waitFor();
      // The menu reaches below the card: the picture spans both.
      const span = await spanning(page, idea, idea.getByRole("button", { name: /^Don.t use/ }));
      await walk.shot(span.box);
      await span.remove();
      await idea.getByRole("button", { name: "Pin" }).click();
      await expect.poll(() => fares(walk)?.pinned, { timeout: 15_000 }).toBe(true);
    },
    "make-it-recurring": async (walk) => {
      const page = await walk.page();
      const idea = card(page, walk);
      await idea.getByRole("button", { name: /^More for/ }).click();
      await idea.getByRole("button", { name: "Make it recurring…" }).click();
      const dialog = page.getByRole("dialog", { name: "Make it recurring" });
      const what = dialog.getByRole("textbox", { name: "What to do each time" });
      await what.fill((await what.inputValue()).replace(/\[[^\]]*\]/g, "London"));
      await expect(what.inputValue()).resolves.not.toMatch(/\[/);
      await walk.shot(dialog);
      await dialog.getByRole("button", { name: "Create routine" }).click();
      await dialog.waitFor({ state: "detached", timeout: 60_000 });
      // The routine's daily trigger is listed among the schedules, under its routine.
      await expect
        .poll(() => walk.taviJson<Schedules>("schedules", "list").some((row) => row.routineId !== undefined), { timeout: 30_000 })
        .toBe(true);
    },
    "try-one": async (walk) => {
      const page = await walk.page();
      // The idea made recurring has left the tab: another one is tried.
      await card(page, walk).waitFor({ state: "detached", timeout: 15_000 });
      const other = page.getByRole("region", { name: "For you" }).getByRole("article").first();
      const title = (await other.getAttribute("aria-label")) ?? (await other.getByRole("heading").textContent()) ?? "";
      const idea = walk.taviJson<Ideas>("ideas", "list").ideas.find((entry) => entry.title === title);
      expect(idea, title).toBeDefined();
      await other.getByRole("button", { name: "Try it" }).click();
      // A new chat of its own, not yet started: its message box holds the prompt.
      const box = page.locator(".composer-box textarea");
      await expect.poll(() => box.inputValue(), { timeout: 15_000 }).toBe(idea?.prompt);
      // The part to fill in, when the prompt has one, is selected a moment later, ready to type over.
      const parts = () =>
        box.evaluate((field: HTMLTextAreaElement) => ({
          wanted: /\[[^\]\n]+\]/.exec(field.value)?.[0] ?? "",
          selected: field.value.slice(field.selectionStart, field.selectionEnd),
        }));
      await expect
        .poll(
          async () => {
            const { wanted, selected } = await parts();
            return selected === wanted;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      // Nothing was sent: the new chat has no turn.
      await expect(page.getByRole("button", { name: "Copy response" }).count()).resolves.toBe(0);
      await walk.shot(page.locator("form").last());
    },
    "choose-when-tavi-looks": async (walk) => {
      const screen = await walk.terminal({ title: "tavi ideas hours", args: ["ideas", "hours", "07:00-21:00"] });
      expect(screen.join("\n")).toContain("07:00");
      expect(walk.tavi("ideas", "hours")).toMatch(/07:00.*21:00/);
    },
  },
});
