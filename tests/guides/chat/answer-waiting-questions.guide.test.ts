import { expect } from "vitest";

import { leaveWaiting } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Need {
  readonly kind: string;
  readonly taskId: string;
  readonly question?: { readonly question: string; readonly deadlineAt?: string };
}
interface Needs {
  readonly needs: readonly Need[];
}

/** Two questions and an approval, each left waiting by a run started from the terminal, as a reader's chats would leave them. */
const WAITING = [
  "Plan a dinner for Saturday. Before anything else, ask me with a question whether I want Italian, Thai or Mexican food.",
  "Help me choose a gift for my sister. Before anything else, ask me with a question what my budget is: under £20, £20 to £50, or over £50.",
  "Write a file called notes.txt in this chat's folder containing the line: Buy milk.",
];

/** The question answered on the canvas, and the one answered from the terminal. */
let first: Need | undefined;
let second: Need | undefined;

walkGuide("chat/answer-waiting-questions", {
  configured: true,
  model: true,
  steps: {
    "list-what-is-waiting": async (walk) => {
      for (const prompt of WAITING) leaveWaiting(walk.tavi, prompt);
      const needs = walk.taviJson<Needs>("needs").needs;
      expect(needs.map((need) => need.kind).sort()).toEqual(["approval", "question", "question"]);
      [first, second] = needs.filter((need) => need.kind === "question");
      const screen = await walk.terminal({ title: "tavi needs", args: ["needs"], cols: 150 });
      expect(screen.join("\n")).toMatch(/^\?[\s\S]*^\?[\s\S]*^!/m);
    },
    "check-from-the-chat": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [{ wait: 6 }, { text: "/needs", wait: 1 }, { text: "\r" }, { until: "needs you", wait: 30 }, { wait: 2 }],
      });
      expect(screen.join("\n")).toContain(`tavi answer ${first?.taskId}`);
    },
    "open-the-approvals-queue": async (walk) => {
      const page = await walk.open("/");
      await page
        .getByRole("navigation", { name: "pages" })
        .getByRole("button", { name: /^Center/ })
        .click();
      await page.locator(".center-nav-item", { hasText: "Approvals" }).click();
      await page.waitForURL(/\/center\/approvals$/);
      await page.locator("#center-waiting").waitFor();
      await page.locator("li.center-card-question").nth(1).waitFor();
      await walk.shot();
    },
    "answer-a-question-on-the-canvas": async (walk) => {
      const page = await walk.page();
      const card = page.locator("li.center-card-question").first();
      const asked = (await card.getAttribute("aria-label"))?.replace(/^Question: /, "");
      await card.locator(".need-option").first().click();
      // The answer is sent once its undo window has passed.
      await expect
        .poll(() => walk.taviJson<Needs>("needs").needs.some((need) => need.question?.question === asked), { timeout: 30_000 })
        .toBe(false);
      // Found by its name, not by a selector built from the model's words, which may hold quotes.
      const answered = page.getByRole("listitem", { name: `Question: ${asked}`, exact: true });
      await answered.waitFor();
      await walk.shot(answered);
      // The other question is the one the terminal answers.
      const left = walk.taviJson<Needs>("needs").needs.filter((need) => need.kind === "question");
      expect(left).toHaveLength(1);
      second = left[0];
    },
    "answer-from-the-terminal": async (walk) => {
      const screen = await walk.terminal({ title: "tavi answer", args: ["answer", second?.taskId ?? "", "2"] });
      expect(screen.join("\n")).toMatch(/Answered/);
      expect(walk.taviJson<Needs>("needs").needs.filter((need) => need.kind === "question")).toEqual([]);
    },
    "decide-the-waiting-call": async (walk) => {
      // Still on Approvals, where the call's card waits under the answered questions.
      const page = await walk.page();
      const card = page.locator("li.center-card").filter({ has: page.getByRole("button", { name: "Allow once" }) });
      await card.first().waitFor();
      await walk.shot(card.first());
      await card.first().getByRole("button", { name: "Allow once" }).click();
      await expect.poll(() => walk.taviJson<Needs>("needs").needs.length, { timeout: 60_000 }).toBe(0);
    },
    "check-that-nothing-is-left": async (walk) => {
      const screen = await walk.terminal({ title: "tavi needs", args: ["needs"] });
      expect(screen.join("\n")).toContain("(nothing needs you)");
    },
  },
});
