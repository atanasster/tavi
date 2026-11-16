import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { homeId } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

/** The approval card the brief waits on. */
const card = (page: Page) => page.locator("section.round").last();

/**
 * Stops the walk's own `tavi serve`, as the reader stops theirs with Ctrl-C: `tavi reports` refuses to read the
 * store while an owner holds it. Only the process serving this walk's throwaway data directory is stopped.
 */
async function stopOwner(dataDir: string): Promise<void> {
  const owners = () =>
    execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(" serve ") && line.includes(`--data-dir ${dataDir}`))
      .map((line) => Number.parseInt(line.trim(), 10));
  for (const pid of owners()) process.kill(pid, "SIGTERM");
  await expect.poll(() => owners().length, { timeout: 30_000, interval: 500 }).toBe(0);
}

let reportId = "";

walkGuide("documents/daily-brief-pdf", {
  configured: true,
  model: true,
  steps: {
    "register-your-project": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi projects add",
        args: ["projects", "add", "willow", "--name", "Willow Bakery", "--keyword", "Willow Bakery", "--language", "en", "--region", "GB"],
      });
      expect(screen.join("\n")).toContain("willow");
      const projects = walk.taviJson<{ projects: { id: string }[] }>("projects", "list").projects;
      expect(projects.map((project) => project.id)).toEqual(["willow"]);
    },
    "check-what-it-will-collect": async (walk) => {
      const screen = await walk.terminal({ title: "tavi projects show willow", args: ["projects", "show", "willow"] });
      expect(screen.join("\n")).toMatch(/stripe\s+\(not configured\)/);
    },
    "ask-for-the-brief": async (walk) => {
      const page = await walk.open("/");
      const box = page.locator(".composer-box textarea");
      // The guide's words, with the tool named: asked for "the brief", the model may write one into the chat instead.
      const answers = page.getByRole("button", { name: /^Copy response/ });
      /** Sends `text`: true once an approval card waits, false when the model answered without one. */
      const ask = async (text: string): Promise<boolean> => {
        const before = await answers.count();
        await box.fill(text);
        await box.press("Enter");
        const waiting = page.getByText("Needs your approval");
        await expect
          .poll(async () => (await waiting.count()) > 0 || (await answers.count()) > before, { timeout: 180_000, interval: 1_000 })
          .toBe(true)
          .catch(async (error: unknown) => {
            // A turn the model connection failed shows why in the transcript: say it, rather than only that time ran out.
            const failed = page.getByText(/^Failed \(/).last();
            if ((await failed.count()) > 0) throw new Error((await failed.textContent()) ?? "the model failed");
            throw error;
          });
        const failed = page.getByText(/^Failed \(/).last();
        if ((await failed.count()) > 0) throw new Error((await failed.textContent()) ?? "the model failed");
        return (await waiting.count()) > 0;
      };
      // One re-ask when the model answers itself instead of calling the tool.
      if (!(await ask("Make today's daily brief PDF for my projects with reports.generate."))) {
        expect(await ask("Please call reports.generate now to write the daily brief PDF.")).toBe(true);
      }
      await card(page).getByRole("button", { name: "Allow once" }).waitFor();
      const pending = walk.taviJson<{ rows: { record: { toolId: string } }[] }>("approvals", "list").rows;
      expect(pending.map((row) => row.record.toolId)).toEqual(["reports.generate"]);
      await walk.shot(card(page));
    },
    "allow-it": async (walk) => {
      const page = await walk.page();
      await card(page).getByRole("button", { name: "Allow once" }).click();
      await page
        .getByRole("button", { name: /^Copy response/ })
        .first()
        .waitFor({ timeout: 180_000 });
      expect(walk.tavi("tasks", "history", homeId(walk.tavi))).toContain("`reports.generate` completed");
      const answer = page
        .locator("article")
        .filter({ has: page.getByRole("button", { name: /^Copy response/ }) })
        .last();
      await answer.scrollIntoViewIfNeeded();
      await walk.shot(answer, { mask: [answer.locator(".text")] });
    },
    "list-your-briefs": async (walk) => {
      // The list is read through the running owner.
      const screen = await walk.terminal({ title: "tavi reports list", args: ["reports", "list"], cols: 140 });
      expect(screen.join("\n")).toContain("1 project, ");
      const listed = JSON.stringify(walk.taviJson("reports", "list"));
      reportId = /"(art-[0-9a-f-]+)"/.exec(listed)?.[1] ?? "";
      expect(reportId).not.toBe("");
    },
    "open-a-brief": async (walk) => {
      // Opening a brief reads the store directly: the owner is stopped first, as the guide says.
      await stopOwner(walk.dataDir);
      // Beside the data directory's own files: removed with it, and shown in the picture as its place, not this machine's.
      const file = join(walk.dataDir, "brief.pdf");
      const screen = await walk.terminal({ title: "tavi reports open", args: ["reports", "open", reportId, "--out", file] });
      expect(screen.join("\n")).toContain("brief.pdf");
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).subarray(0, 5).toString()).toBe("%PDF-");
    },
  },
});
