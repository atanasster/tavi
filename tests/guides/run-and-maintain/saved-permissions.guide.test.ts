import { expect } from "vitest";

import { spanning } from "../support/automation.js";
import { askForApproval, dismissChecklist, turnEnded } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Rules {
  readonly rules: readonly { readonly ruleId: string; readonly toolPattern: string; readonly decision: string; readonly source: string }[];
}
interface Grants {
  readonly grants: readonly { readonly grantId: string; readonly toolId: string; readonly taskId: string }[];
}

const rules = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<Rules>("permissions", "list").rules;
const grants = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<Grants>("permissions", "grants").grants;

walkGuide("run-and-maintain/saved-permissions", {
  configured: true,
  model: true,
  steps: {
    "open-the-rules": async (walk) => {
      const page = await walk.open("/settings/permissions");
      const heading = page.getByRole("heading", { name: "Rules" });
      const rows = page.locator("section.settings ul.rows").first().locator("li");
      await rows.first().waitFor();
      expect(await rows.count()).toBe(rules(walk).length);
      // Every rule on one screen: the list is taller than the window.
      await page.setViewportSize({ width: 1280, height: 2400 });
      await heading.evaluate((element) => element.scrollIntoView({ block: "start" }));
      const span = await spanning(page, heading, rows.last());
      await walk.shot(span.box);
      await span.remove();
      await page.setViewportSize({ width: 1280, height: 800 });
      expect(rules(walk).some((rule) => rule.ruleId === "seeded-reminders" && rule.source === "operator")).toBe(true);
    },
    "check-the-untrusted-content-guard": async (walk) => {
      const page = await walk.page();
      const heading = page.getByRole("heading", { name: "Untrusted content" });
      await heading.scrollIntoViewIfNeeded();
      await expect(page.getByLabel("taint mode").textContent()).resolves.toContain("Ask (enforce)");
      const span = await spanning(page, heading, page.getByText("A likely injection in a page"));
      await walk.shot(span.box);
      await span.remove();
      expect(walk.tavi("permissions", "taint")).toMatch(/security\.taint = enforce/);
    },
    "see-what-a-chat-was-allowed": async (walk) => {
      // A grant to show: a chat whose file write was allowed for the rest of it.
      const page = await walk.open("/");
      await dismissChecklist(page);
      await page
        .getByRole("button", { name: /^New (side )?chat$/ })
        .first()
        .click();
      await askForApproval(page, "Write a file called notes.txt in this chat's folder containing the line: Buy milk.");
      await page.locator("section.round").last().getByRole("button", { name: "Allow for this chat" }).click();
      await turnEnded(page);
      expect(grants(walk).map((grant) => grant.toolId)).toEqual(["fs.write"]);
      await walk.open("/settings/permissions");
      const heading = page.getByRole("heading", { name: "Chat grants" });
      const row = page.locator("li").filter({ has: page.getByRole("button", { name: "Revoke" }) });
      await row.waitFor();
      await heading.scrollIntoViewIfNeeded();
      const span = await spanning(page, heading, row);
      await walk.shot(span.box);
      await span.remove();
    },
    "revoke-a-grant": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: "Revoke" }).click();
      await expect.poll(() => grants(walk).length, { timeout: 15_000 }).toBe(0);
      await page.getByText("No chat grants.").waitFor();
      const screen = await walk.terminal({ title: "tavi permissions grants", args: ["permissions", "grants"], lines: 4 });
      expect(screen.join("\n")).toContain("no chat grants");
    },
    "add-a-rule-of-your-own": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi permissions add",
        args: ["permissions", "add", "--tool", "browser.*", "--decision", "ask", "--note", "Ask before every browser step"],
        lines: 4,
      });
      expect(screen.join("\n")).toMatch(/added rule-.*ask browser\.\*/);
      expect(rules(walk).some((rule) => rule.toolPattern === "browser.*" && rule.decision === "ask" && rule.source === "operator")).toBe(
        true,
      );
    },
    "override-a-shipped-rule": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi permissions rm",
        args: ["permissions", "rm", "shipped-browser-submit"],
        tty: true,
        // Typed into, the refusal's exit status (2) is not a failed run: it is what the step shows.
        input: [{ until: "is shipped with tavi", wait: 30 }],
        lines: 4,
      });
      expect(screen.join("\n")).toMatch(/is shipped with tavi; override it with a deny or ask rule/);
      expect(rules(walk).some((rule) => rule.ruleId === "shipped-browser-submit")).toBe(true);
    },
  },
});
