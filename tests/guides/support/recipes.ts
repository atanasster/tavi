import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { join } from "node:path";

import { delay } from "@tavi/test-support";
import { expect } from "vitest";

import { root, type Locator, type Page } from "../../../scripts/docs/browser.mjs";
import { IDEA_CATALOGUE } from "../../../packages/plugin-kit/src/ideas/catalogue.js";
import { newChat } from "./browser-site.js";
import { dismissChecklist, lastAnswer, restartOwner, send, turnEnded } from "./steps.js";

/**
 * What the everyday recipes' walks share: the prompt of the recipe's Ideas template with its `[placeholders]` filled
 * in, as a reader fills them, asked in a new chat, and the answer pictured. The words come from the catalogue, so a
 * reworded template fails its walk rather than leaving the page behind.
 */

interface Walk {
  open(route: string): Promise<Page>;
  shot(target?: Locator, options?: { readonly mask?: readonly Locator[] }): Promise<void>;
}

/** What the step that installs an app needs of the walk. */
interface Installing {
  readonly dataDir: string;
  tavi(...args: string[]): string;
  terminal(spec: { readonly title: string; readonly args: readonly string[]; readonly lines: number }): Promise<string[]>;
}

/** What the turn's cards get and how long it may take (`answered`). */
interface Answering {
  /** What each card gets; by default it is refused. */
  readonly onCard?: (round: Locator) => Promise<void>;
  /** How long the turn may take. */
  readonly timeoutMs?: number;
  /** A turn that does not end says so with the end of the chat. */
  readonly quotesTheChat?: boolean;
}

/** The prompt of the template `key`, each `[placeholder]` replaced from `fills`: one left over fails. */
export function recipePrompt(key: string, fills: Readonly<Record<string, string>>): string {
  const template = IDEA_CATALOGUE.find((candidate) => candidate.key === key);
  if (template === undefined) throw new Error(`no Ideas template ${key}`);
  const prompt = template.prompt.replace(/\[([^\]]+)\]/g, (whole, name: string) => fills[name] ?? whole);
  expect(prompt, `${key}: every placeholder filled in`).not.toMatch(/\[[^\]]*\]/);
  return prompt;
}

/** The chat shows that it searched the web. */
export async function searchedTheWeb(page: Page): Promise<void> {
  await expect(page.locator("main").textContent()).resolves.toContain("web_search");
}

/** A new chat with `prompt` in its box, pictured and not sent: for a prompt that leads to a card. Returns the page. */
export async function promptInTheBox(walk: Walk, prompt: string): Promise<Page> {
  const page = await walk.open("/");
  await dismissChecklist(page);
  await newChat(page);
  const box = page.locator(".composer-box");
  await box.locator("textarea").fill(prompt);
  // With the hint under the box, whole: the clip would cut through it.
  await shotAlone(walk, box.locator(".."));
  return page;
}

/** A new chat with `prompt` in its box, pictured, then sent, not waited for: for a step that goes on to its cards. Returns the page. */
export async function promptSent(walk: Walk, prompt: string): Promise<Page> {
  const page = await promptInTheBox(walk, prompt);
  await page.locator(".composer-box textarea").press("Enter");
  return page;
}

/** Step "Ask for it": a new chat with the prompt in its box, pictured, then sent and answered. Returns the page. */
export async function askForIt(walk: Walk, prompt: string): Promise<Page> {
  const page = await promptInTheBox(walk, prompt);
  await send(page, prompt);
  return page;
}

/**
 * Runs `take` with all of the chat but `target` hidden: from it up to the page, whatever sits beside each level, a
 * row of the turn above, the name over the answer, the box and the footer under it. `take` gets `target` by a
 * mark: a locator that goes through what is now hidden no longer finds it.
 */
async function aloneOnScreen(target: Locator, take: (alone: Locator) => Promise<void>): Promise<void> {
  const hidden = await target.evaluateHandle((kept) => {
    const others: HTMLElement[] = [];
    for (let at: Element = kept; at.parentElement !== null; at = at.parentElement) {
      for (const other of at.parentElement.children) {
        if (other !== at && other instanceof HTMLElement && other.style.visibility === "") others.push(other);
      }
    }
    for (const other of others) other.style.visibility = "hidden";
    kept.setAttribute("data-alone", "");
    return others;
  });
  await take(target.page().locator("[data-alone]"));
  await hidden.evaluate((others) => {
    for (const other of others) other.style.visibility = "";
    document.querySelector("[data-alone]")?.removeAttribute("data-alone");
  });
}

/** The picture of one part of a chat, a card or a tool row, with nothing else of the chat around it. */
export async function shotAlone(walk: Walk, target: Locator): Promise<void> {
  await aloneOnScreen(target, (alone) => walk.shot(alone));
}

/**
 * The picture of a card whole, down to its foot, which can run on past its buttons: in the middle of a window tall
 * enough for it, as a card scrolled only as far as its buttons is cut off there.
 */
export async function shotCard(walk: Walk, card: Locator): Promise<void> {
  await card.page().setViewportSize({ width: 1280, height: 1500 });
  await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await shotAlone(walk, card);
  await card.page().setViewportSize({ width: 1280, height: 800 });
}

/**
 * Step "Read the result": the latest answer pictured whole, whose words change from run to run: they do not count as a
 * change. The window grows to hold it, so the chat's header and foot do not cut through it.
 */
export async function wholeAnswer(walk: Walk, page: Page): Promise<void> {
  const answer = await lastAnswer(page);
  const height = (await answer.boundingBox())?.height ?? 0;
  await page.setViewportSize({ width: 1280, height: Math.ceil(height) + 480 });
  await scrollToStart(answer);
  await aloneOnScreen(answer, (alone) => walk.shot(alone, { mask: [alone] }));
  await page.setViewportSize({ width: 1280, height: 800 });
}

/** Scrolls `answer` to the top of the chat, clear of its sticky header. */
const scrollToStart = (answer: Locator): Promise<void> =>
  answer.evaluate((element) => {
    (element as HTMLElement).style.scrollMarginTop = "96px";
    element.scrollIntoView({ block: "start" });
  });

/**
 * The start of the latest answer pictured, not its end: what a long answer leads with is what the step talks about, and
 * a whole one may be too large a picture. A box the size of what shows above the composer marks the picture, or
 * `height` pixels of the answer, for a picture that must stop before what follows.
 */
export async function readFromTheTop(walk: Walk, page: Page, height?: number): Promise<void> {
  // A tall window, so the picture holds more of the answer than the composer leaves room for.
  await page.setViewportSize({ width: 1280, height: 1300 });
  const answer = await lastAnswer(page);
  await scrollToStart(answer);
  await answer.evaluate((element, tall) => {
    const from = element.getBoundingClientRect();
    const composer = document.querySelector(".composer-box")?.getBoundingClientRect();
    const limit = from.top + (tall ?? (composer?.top ?? innerHeight) - from.top - 32);
    // It ends where a line ends, under the last whole block that fits; a heading alone at the foot says nothing.
    const blocks = [...element.querySelectorAll(".markdown p, .markdown li, .markdown tr, .markdown pre")];
    const bottoms = blocks.map((block) => block.getBoundingClientRect().bottom).filter((bottom) => bottom <= limit);
    const end = bottoms.length === 0 ? limit : Math.max(...bottoms) + 4;
    // The crop's margin would show the top of the next line: what follows `end` is not drawn.
    (element as HTMLElement).style.clipPath = `inset(0 -32px ${from.bottom - end}px -32px)`;
    const box = document.createElement("div");
    box.dataset["answerTop"] = "";
    box.style.cssText = `position:fixed;pointer-events:none;left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${end - from.top}px`;
    document.body.append(box);
  }, height);
  const box = page.locator("[data-answer-top]");
  await aloneOnScreen(answer, () => walk.shot(box, { mask: [box] }));
  await box.evaluate((element) => element.remove());
  await answer.evaluate((element) => ((element as HTMLElement).style.clipPath = ""));
  await page.setViewportSize({ width: 1280, height: 800 });
}

/**
 * How far down the answer (from its top, as `readFromTheTop` measures) a picture of at most `limit` pixels may run and
 * end on a whole one of `blocks`, not on a heading, a lead-in or part of a list.
 */
export const footOf = (answer: Locator, blocks: string, limit: number): Promise<number> =>
  answer.evaluate(
    (element, { blocks, limit }) => {
      const top = element.getBoundingClientRect().top;
      const ends = [...element.querySelectorAll(blocks)]
        .filter((block) => !(block.textContent ?? "").trimEnd().endsWith(":"))
        .map((block) => block.getBoundingClientRect().bottom - top)
        .filter((bottom) => bottom <= limit);
      return Math.ceil(Math.max(0, ...ends));
    },
    { blocks, limit },
  );

/**
 * Step "Add the … app": a plugin the repository builds (`packages/external/<folder>/dist-plugin`), installed,
 * approved and enabled, pictured with `tavi plugins show`, and loaded by restarting the owner.
 */
export async function addTheApp(walk: Installing, folder: string, id: string, lines = 11, cols?: number): Promise<void> {
  walk.tavi("plugins", "install", join(root, `packages/external/${folder}/dist-plugin`));
  walk.tavi("plugins", "approve", id, "0.1.0");
  walk.tavi("plugins", "enable", id);
  const screen = await walk.terminal({
    title: `tavi plugins show ${id}`,
    args: ["plugins", "show", id],
    lines,
    ...(cols === undefined ? {} : { cols }),
  });
  expect(screen.join("\n")).toMatch(/state: enabled/);
  // A plugin composes when the owner starts.
  await restartOwner(walk.dataDir, []);
}

/** Step "Add the Places app" (pnpm --filter @tavi/plugin-places-open build). */
export const addThePlacesApp = (walk: Installing): Promise<void> => addTheApp(walk, "places-open", "places.open");

/** Sends `text` and allows each card the turn stops on: once a chat has read the web, a further search can ask first. */
export async function sendThroughCards(page: Page, text: string): Promise<void> {
  const answers = page.getByRole("button", { name: "Copy response" });
  const before = await answers.count();
  const box = page.locator(".composer-box textarea");
  await box.fill(text);
  await box.press("Enter");
  const allow = page.getByRole("button", { name: /^(Allow once|Allow selected; deny unchecked)$/ }).last();
  await expect
    .poll(
      async () => {
        if (await allow.isVisible()) await allow.click();
        return (await answers.count()) > before;
      },
      { timeout: 240_000, interval: 1_000 },
    )
    .toBe(true);
  await turnEnded(page);
}

/** Refuses the newest card, as a reader may a browser they did not ask for. */
export async function denyCard(round: Locator): Promise<void> {
  // A card just answered keeps its buttons for a moment: a click that finds them gone is no failure.
  await round
    .getByRole("button", { name: "Deny…" })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  await round
    .getByRole("button", { name: "Deny", exact: true })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
}

/** Allows the newest card, once: Allow once, or Allow selected; deny unchecked on a card of several calls. */
export const allowCard = (round: Locator): Promise<void> =>
  round
    .getByRole("button", { name: /^(Allow once|Allow selected; deny unchecked)$/ })
    .click({ timeout: 3_000 })
    .catch(() => undefined);

/** Refuses a card for the browser, which the recipe does without, as a reader may, and allows `allow`s the rest. */
export async function refuseTheBrowser(round: Locator, allow: (round: Locator) => Promise<void> = allowCard): Promise<void> {
  if (/browser/i.test((await round.textContent()) ?? "")) await denyCard(round);
  else await allow(round);
}

/** What shows once the turn is over. */
const turnOver = (page: Page): Locator =>
  page
    .locator("main .task-header")
    .getByText(/^(ready|completed)$/)
    .first();

/** Whether `round` is a card waiting to be answered. */
const waitsForAnswer = async (round: Locator): Promise<boolean> => (await round.getByRole("button", { name: "Deny…" }).count()) > 0;

/** Each second until `over`, for at most `timeoutMs`: `onRound` gets the chat's newest round. */
async function untilOver(
  page: Page,
  over: () => Promise<boolean>,
  onRound: (round: Locator) => Promise<void>,
  timeoutMs: number,
  overdue: () => Promise<string> = async () => "the turn did not end",
): Promise<void> {
  for (let waited = 0; !(await over()); waited += 1_000) {
    if (waited > timeoutMs) throw new Error(await overdue());
    await onRound(page.locator("section.round").last());
    await delay(1_000);
  }
}

/** Sends what the box holds and, until the turn ends, answers its cards: each refused, unless `onCard` says otherwise. */
export async function answered(
  page: Page,
  { onCard = denyCard, timeoutMs = 240_000, quotesTheChat = false }: Answering = {},
): Promise<void> {
  const answers = page.getByRole("button", { name: "Copy response" });
  const before = await answers.count();
  await page.locator(".composer-box textarea").press("Enter");
  const ended = turnOver(page);
  await untilOver(
    page,
    async () => (await answers.count()) > before && (await ended.isVisible()),
    async (round) => {
      if (await waitsForAnswer(round)) await onCard(round);
    },
    timeoutMs,
    async () => `the turn did not end${quotesTheChat ? `: ${((await page.locator("main").textContent()) ?? "").slice(-800)}` : ""}`,
  );
}

/** A new chat with `prompt` in its box, pictured, then sent and its cards answered (`answered`). Returns the page. */
export async function promptAnswered(walk: Walk, prompt: string, answering?: Answering): Promise<Page> {
  const page = await promptInTheBox(walk, prompt);
  await answered(page, answering);
  return page;
}

/** Allows the turn's cards until it ends, the chat's first answer in: a chat may go on using a site it has been allowed. */
export async function allowUntilEnded(page: Page, timeoutMs: number): Promise<void> {
  const answers = page.getByRole("button", { name: "Copy response" });
  const ended = turnOver(page);
  await untilOver(
    page,
    async () => (await answers.count()) > 0 && (await ended.isVisible()),
    async (round) => {
      for (const name of ["Allow for this chat", "Allow once", "Allow selected; deny unchecked"]) {
        const button = round.getByRole("button", { name });
        if ((await button.count()) > 0) {
          await button.click({ timeout: 3_000 }).catch(() => undefined);
          break;
        }
      }
    },
    timeoutMs,
  );
}

/** Whether the chat's newest card asks to create a schedule. */
const proposesSchedule = async (round: Locator): Promise<boolean> =>
  /Needs your approval\s*Schedule/i.test((await round.textContent()) ?? "");

/** Until the schedule's approval card waits: a call of the browser before it is refused. */
async function scheduleCard(page: Page): Promise<Locator> {
  for (let waited = 0; waited < 240_000; waited += 1_000) {
    const round = page.locator("section.round").last();
    if (await waitsForAnswer(round)) {
      if (await proposesSchedule(round)) return round;
      await denyCard(round);
    }
    await delay(1_000);
  }
  throw new Error("no schedule was proposed");
}

/** Until the turn ends, whatever other cards it leads to: a further schedule allowed, the browser refused. */
async function scheduleAnswered(page: Page): Promise<void> {
  const ended = turnOver(page);
  await untilOver(
    page,
    () => ended.isVisible(),
    async (round) => {
      if (await waitsForAnswer(round)) await ((await proposesSchedule(round)) ? allowCard(round) : denyCard(round));
    },
    240_000,
  );
}

/** Step "Make it recurring": the schedule's card pictured and allowed, the turn over, the schedule there and on. */
export async function allowTheSchedule(walk: Walk & { taviJson<T>(...args: string[]): T }, page: Page): Promise<void> {
  const card = await scheduleCard(page);
  // Tall enough for the whole card: its buttons are what the step names.
  await page.setViewportSize({ width: 1280, height: 1300 });
  await card.getByRole("button", { name: "Allow once" }).scrollIntoViewIfNeeded();
  await shotAlone(walk, card);
  await page.setViewportSize({ width: 1280, height: 800 });
  await card.getByRole("button", { name: "Allow once" }).click();
  await scheduleAnswered(page);
  const rows = walk.taviJson<readonly { readonly enabled: boolean }[]>("schedules", "list");
  expect(rows.length, "the schedule exists").toBeGreaterThan(0);
  expect(rows[0]?.enabled).toBe(true);
}

/** One line of a made-up PDF: its words, size and face. */
export type PdfLine = readonly [text: string, size: number, face: "plain" | "bold"];

/** A one-page made-up PDF of `lines`, top down: a chapter, a résumé, nobody's real document. */
export async function onePagePdf(lines: readonly PdfLine[]): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([595, 842]);
  const fonts = { plain: await document.embedFont(StandardFonts.Helvetica), bold: await document.embedFont(StandardFonts.HelveticaBold) };
  let y = 780;
  for (const [text, size, face] of lines) {
    page.drawText(text, { x: 56, y, size, font: fonts[face] });
    y -= size + 8;
  }
  return document.save();
}
