import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Browser, launchBrowser, type Locator, type Page } from "../scripts/docs/browser.mjs";
import { failedRows } from "./guides/support/probes.js";
import { readFromTheTop, shotAlone, wholeAnswer } from "./guides/support/recipes.js";
import { hidingJump } from "./guides/support/walk.js";

/**
 * What a guide picture may show, on a small page shaped as the chat is: the part it is of and nothing around it, an
 * answer whole, and on a cover no failed step. The walks that take the real pictures need a model; these do not.
 */

const CHAT = `<!doctype html><body style="margin:0"><main style="height:100vh;display:flex;flex-direction:column">
  <header class="task-header">ready</header>
  <div class="scroller" style="flex:1;min-height:0;overflow:auto;position:relative">
    <div class="runs">
      <details class="tools" id="above"><summary>Worked · 2 steps</summary></details>
      <section class="round" id="card"><p>Needs your approval</p></section>
      <article><header id="name">Tavi</header><details class="tools" id="worked"><summary>Worked</summary></details>
        <div class="markdown" id="words" style="height:ANSWERpx">words</div>
        <button aria-label="Copy response">Copy</button>
      </article>
    </div>
  </div>
  <p class="jump-latest"><button>Jump to latest</button></p>
  <div class="composer"><textarea class="composer-box"></textarea></div>
</main><footer id="foot">8-flash · Keyboard</footer></body>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
}, 60_000);
afterAll(() => browser.close());

const visibility = (id: string): Promise<string> => page.locator(`#${id}`).evaluate((element) => getComputedStyle(element).visibility);

describe("the picture of a part of a chat", () => {
  it("shows that part alone, whatever sits beside it in the transcript", async () => {
    await page.setContent(CHAT.replace("ANSWER", "100"));
    const seen: Record<string, string> = {};
    const take = async (ids: readonly string[]) => {
      for (const id of ids) seen[id] = await visibility(id);
    };
    await shotAlone({ open: () => Promise.resolve(page), shot: () => take(["above", "foot", "words", "name"]) }, page.locator("#card"));
    expect(seen).toEqual({ above: "hidden", foot: "hidden", words: "hidden", name: "hidden" });
    await shotAlone({ open: () => Promise.resolve(page), shot: () => take(["name", "words", "card", "above"]) }, page.locator("#worked"));
    expect(seen).toMatchObject({ name: "hidden", words: "hidden", card: "hidden", above: "hidden" });
    expect(await visibility("name"), "put back after the picture").toBe("visible");
  });

  it("still finds a part named by what is hidden around it", async () => {
    await page.setContent(CHAT.replace("ANSWER", "100"));
    const answer = page.locator("article").filter({ has: page.getByRole("button", { name: /^Copy response/ }) });
    let height: number | undefined;
    const shot = async (target?: Locator) => {
      height = (await target?.boundingBox({ timeout: 2_000 }))?.height;
    };
    await shotAlone({ open: () => Promise.resolve(page), shot }, answer.locator("#worked"));
    expect(height).toBeGreaterThan(0);
  });

  it("hides Jump to latest while the picture is taken, and puts it back", async () => {
    await page.setContent(CHAT.replace("ANSWER", "100"));
    const during = await hidingJump(page, () => page.locator(".jump-latest").evaluate((element) => getComputedStyle(element).visibility));
    expect(during).toBe("hidden");
    await expect(page.locator(".jump-latest").evaluate((element) => getComputedStyle(element).visibility)).resolves.toBe("visible");
  });
});

describe("the picture of an answer", () => {
  it("holds an answer longer than the window, to its last line", async () => {
    await page.setContent(CHAT.replace("ANSWER", "1500"));
    let cut: number | undefined;
    const shot = async () => {
      cut = await page.locator("article").evaluate((answer) => {
        const scroller = answer.closest(".scroller") as HTMLElement;
        return answer.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
      });
    };
    await wholeAnswer({ open: () => Promise.resolve(page), shot }, page);
    expect(cut).toBeLessThanOrEqual(0);
    expect(page.viewportSize(), "the window is put back").toEqual({ width: 1280, height: 800 });
  });
});

describe("the picture of the start of an answer", () => {
  it("ends on a whole line, with nothing of the next in the crop's margin", async () => {
    await page.setContent(CHAT.replace("ANSWER", "400").replace(">words<", `>${"<p style='height:30px;margin:0'>line</p>".repeat(12)}<`));
    let under: boolean | undefined;
    const shot = async (target?: Locator) => {
      const box = await target?.boundingBox();
      under = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x as number, y as number)?.closest(".markdown") !== null,
        [(box?.x ?? 0) + 40, (box?.y ?? 0) + (box?.height ?? 0) + 8],
      );
    };
    await readFromTheTop({ open: () => Promise.resolve(page), shot }, page, 200);
    expect(under).toBe(false);
    await expect(page.locator("article").evaluate((answer) => getComputedStyle(answer).clipPath)).resolves.toBe("none");
  });
});

describe("a failed step on a picture", () => {
  const FAILED = `<body style="margin:0"><div style="height:300px">answer</div>
    <details class="tools tools-failed" id="row"><summary>Worked · 3 steps <span>1 failed</span></summary></details></body>`;

  it("names the row the picture shows", async () => {
    await page.setContent(FAILED);
    expect(await failedRows(page)).toEqual([expect.stringContaining("1 failed")]);
    expect(await failedRows(page, { x: 0, y: 290, width: 400, height: 30 })).toHaveLength(1);
  });

  it("leaves out a row outside the picture, or hidden for it", async () => {
    await page.setContent(FAILED);
    expect(await failedRows(page, { x: 0, y: 0, width: 400, height: 200 })).toEqual([]);
    await page.locator("#row").evaluate((row) => ((row as HTMLElement).style.visibility = "hidden"));
    expect(await failedRows(page)).toEqual([]);
  });
});
