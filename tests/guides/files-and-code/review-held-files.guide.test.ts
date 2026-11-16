import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, onTestFinished } from "vitest";

import { homeId, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

interface Held {
  readonly artifactId: string;
  readonly contentType: string;
  readonly reviewState: string;
}

const REPORT = "month,sales\nJanuary,1200\nFebruary,1350\nMarch,1610\n";

/** A small site of the walk's own on this computer: a page with one link to a CSV report, sent as a download. */
async function reportsSite(): Promise<number> {
  const server: Server = createServer((request, response) => {
    if (request.url === "/sales-q1.csv") {
      response.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="sales-q1.csv"' });
      response.end(REPORT);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><title>Quarterly reports</title><h1>Quarterly reports</h1><p><a href="/sales-q1.csv" download>Download the Q1 sales report (CSV)</a></p>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

const held = (walk: { taviJson<T>(...args: string[]): T }): Held[] => walk.taviJson<Held[]>("artifacts", "list");

walkGuide("files-and-code/review-held-files", {
  configured: true,
  model: true,
  steps: {
    "ask-for-a-download": async (walk) => {
      const port = await reportsSite();
      // The site is on this computer: the browser may open it only when the owner lists it.
      await restartOwner(walk.dataDir, ["--browser-allow-host", `127.0.0.1:${port}`]);
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        cols: 110,
        input: [
          { wait: 4 },
          { text: `Open http://127.0.0.1:${port}/ in the browser and download the Q1 sales report.`, wait: 1 },
          { text: "\r" },
          { until: "Round 1 needs approval[\\s\\S]*n refuses", wait: 180 },
          { text: "y", wait: 2 },
          { until: "Round 2 needs approval[\\s\\S]*n rejects", wait: 180 },
          { text: "y", wait: 2 },
          { until: "y releases the output", wait: 180 },
        ],
      });
      expect(screen.join("\n")).toContain("Output needs review");
      expect(held(walk).map((file) => [file.contentType, file.reviewState])).toEqual([["text/csv", "pending"]]);
    },
    "list-what-is-held": async (walk) => {
      const screen = await walk.terminal({ title: "tavi artifacts list", args: ["artifacts", "list"] });
      expect(screen.join("\n")).toMatch(/art-\S+\s+text\/csv\s+50B/);
    },
    "find-it-on-the-canvas": async (walk) => {
      const page = await walk.open("/");
      const card = page.locator("section").filter({ hasText: "Review held files" }).last();
      await card.getByRole("button", { name: "Approve artifact" }).waitFor({ timeout: 30_000 });
      await walk.shot(card);
    },
    "keep-it-or-reject-it": async (walk) => {
      const page = await walk.page();
      const answers = page.getByRole("button", { name: "Copy response" });
      const before = await answers.count();
      await page.getByRole("button", { name: "Approve artifact" }).click();
      await expect.poll(() => held(walk).length, { timeout: 30_000 }).toBe(0);
      // The chat picks up again and answers.
      await expect.poll(() => answers.count(), { timeout: 180_000, interval: 1_000 }).toBeGreaterThan(before);
      expect(existsSync(join(walk.dataDir, "chats/default", homeId(walk.tavi), "downloads/sales-q1.csv"))).toBe(true);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "pick-up-the-file": async (walk) => {
      const page = await walk.page();
      // The panel hangs to the right of its chip: a wide window shows it whole.
      await page.setViewportSize({ width: 1920, height: 1000 });
      await page.locator(".folder-chip:visible").last().click();
      const panel = page.locator(".folder-panel");
      await panel.getByRole("button", { name: "Open downloads" }).click();
      await panel.getByRole("button", { name: "Download sales-q1.csv" }).waitFor();
      await walk.shot(panel);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
  },
});
