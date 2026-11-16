// The functions handed to page.evaluate run in the browser, against its DOM.
/// <reference lib="dom" />
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Browser, type Locator, launchBrowser, type Page, root } from "../../../scripts/docs/browser.mjs";
import { type Guide, type GuideStep, guidesRoot, readGuide, stepImagePath } from "../../../scripts/docs/guides.mjs";
import {
  cleanUp,
  defaultKeyFile,
  keyFileProblem,
  openSession,
  type Session,
  settled,
  type TerminalSpec,
  terminalLines,
} from "../../../scripts/docs/session.mjs";
import { svgOf } from "../../../scripts/docs/terminal-svg.mjs";
import { failedRows, type Finding, probePage, probeTerminal } from "./probes.js";
import { personalLeft, personalSwaps } from "./user.js";

/**
 * A how-to guide as an executable specification: `walkGuide` reads the page
 * under docs/use-cases/, and runs one function per step **in the article's
 * order**, each doing only what the step tells a reader to do and checking what
 * it says they will then see. A step in the article with no walk, or a walk for
 * a step the article no longer has, fails before anything runs.
 *
 * Each step takes its own picture: `shot()` for the web canvas (a WebP at the
 * path the page shows) or `terminal()` for what a command printed (an SVG,
 * light and dark). Pictures are written only with `TAVI_GUIDE_UPDATE_SHOTS=1`
 * (or when one is missing), once every step has passed, and all together: a
 * guide's pictures are kept unless one of them changed — a canvas picture that
 * moved outside the boxes its step masks (`mask`, for the model's own words), a
 * terminal picture whose text differs — and then every one is retaken, so the
 * steps never show different runs. A retaken cover may show no failed step. Every screen is
 * also checked (`probes.ts`); the findings go to `plans/qa/` for the batch's
 * QA report.
 */

export interface WalkContext {
  /** The throwaway data directory. */
  readonly dataDir: string;
  /** `tavi <args> --data-dir <dataDir>`: what it printed. */
  tavi(...args: string[]): string;
  /** The same, with `--format json`, parsed. */
  taviJson<T = unknown>(...args: string[]): T;
  /** The canvas, signed in, opened on first use. */
  page(): Promise<Page>;
  /** Opens `route` on the canvas and waits for it to settle. */
  open(route: string): Promise<Page>;
  /**
   * The step's picture of the canvas: the whole page, or `target` cropped with padding; `mask` hides the model's own
   * words from the change check. A whole page with an answer below the fold (**Jump to latest** showing), or with
   * `frame: "answer"`, is first scrolled to the latest answer: whole above the composer, or from its start.
   */
  shot(target?: Locator, options?: ShotOptions): Promise<void>;
  /** The step's picture of a terminal: what the command printed. Returns its lines as text. */
  terminal(spec: TerminalSpec & { readonly title: string }): Promise<string[]>;
  /** This step (or a part of it) is not walked, and why: it stays listed, and the report says so. */
  unwalked(reason: string): void;
  /** Something only the person can provide (`TAVI_GUIDE_PROVIDED` names what they have): without it, the guide is skipped. */
  needsUser(what: string): void;
}

export interface WalkOptions {
  /** A data directory with the model connection and `seed` (true), or one with nothing set up (false). */
  readonly configured: boolean;
  /** Turns talk to the real model (needs the key file). */
  readonly model?: boolean;
  /** tavi argument lists run once the owner is up. */
  readonly seed?: readonly (readonly string[])[];
  /**
   * Flags for the owner's `tavi serve` known before the walk (`--fs-root`, `--browser-allow-host`); a flag a step
   * only learns as it runs (a fixture site's port) is `restartOwner`'s.
   */
  readonly serve?: readonly string[];
  /** The main model in place of the pinned one, for a feature that needs another kind of model. */
  readonly main?: string;
  /**
   * Web search on: Tavily, with the key in `.env.tutorials` when there is one (the session adds it), else keyless.
   * Needs `configured`.
   */
  readonly search?: boolean;
  /** The whole walk's time limit. */
  readonly timeoutMs?: number;
  /** One function per step, by the step's key (its title, lower case, hyphenated). */
  readonly steps: Readonly<Record<string, (walk: WalkContext) => Promise<void>>>;
}

const update = process.env["TAVI_GUIDE_UPDATE_SHOTS"] === "1";
/** A wait that misses, or a command that printed nothing, fails the walk: the step did not show what it says. */
const fail = (what: string): never => {
  throw new Error(what);
};
const strict = process.env["TAVI_GUIDE_STRICT"] === "1";
const provided = new Set((process.env["TAVI_GUIDE_PROVIDED"] ?? "").split(",").filter((item) => item !== ""));
/** The plain-text OpenRouter key the walks use (`--key-file`), by default the `openrouter` credential of your data directory. */
export const keyFile = process.env["TAVI_GUIDE_KEY_FILE"] ?? defaultKeyFile();

/** How long after a restarted owner serves an answer to a request made while it was down may still arrive. */
const OWNER_BACK_GRACE_MS = 2_000;
/** When a walk's owner was down: `[stopped, serving again]`, the second absent while it is down. */
const ownerDown: [number, number | undefined][] = [];

/**
 * Marks the walk's owner stopped, until `ownerServing`. Meanwhile an open canvas asks `tavi ui` for the owner and
 * is told `503`, no owner serving — what the page is meant to hear then, as a reader's would when they restart
 * `tavi serve` with the canvas open, so not a finding.
 */
export function ownerStopped(): void {
  if (ownerDown.at(-1)?.[1] !== undefined || ownerDown.length === 0) ownerDown.push([Date.now(), undefined]);
}

/** The walk's owner serves again: ends the window `ownerStopped` opened. */
export function ownerServing(): void {
  const last = ownerDown.at(-1);
  if (last !== undefined && last[1] === undefined) last[1] = Date.now();
}

/** Whether `at` falls while the owner was down for a restart, or within the grace after it served again. */
function whileOwnerDown(at: number): boolean {
  return ownerDown.some(([from, to]) => at >= from && (to === undefined || at <= to + OWNER_BACK_GRACE_MS));
}

/** The canvas's owner probe answered `503` (its response, or the console line the browser logs for it). */
const OWNER_PROBE_503 = /^503 \/api\/owner$|status of 503 \(Service Unavailable\)/;

/** Paths a picture must never show, longest first, and what each becomes. */
// Each path as given and as the system resolves it: on macOS the temporary folder is a link into /private/var.
// Spelled as /private… too whether or not the path exists yet: the owner prints real paths, and a folder made after
// the list was taken has no realpath to read.
const both = (path: string): string[] => [
  ...new Set([path, existsSync(path) ? realpathSync(path) : path, ...(/^\/(?:var|tmp)\//.test(path) ? [`/private${path}`] : [])]),
];

/** The folders a walk made to stand for the reader's own (a project, a plugins folder), and the name a picture gives each. */
const shownFolders = new Map<string, string>();

/** Names `path` as `shown` in every picture: the reader's folder, not the walk's temporary one. */
export function showFolderAs(path: string, shown: string): void {
  shownFolders.set(path, shown);
}

const folderSwaps = (): [string, string][] =>
  [...shownFolders].flatMap(([path, shown]) => both(path).map((each): [string, string] => [each, shown]));

function redactions(dataDir: string): readonly (readonly [string, string])[] {
  const pairs: [string, string][] = [
    ...both(dataDir).map((path): [string, string] => [path, "~/tavi-demo"]),
    ...both(tmpdir()).map((path): [string, string] => [path, "/tmp"]),
    // macOS keeps a user's other temporary folders beside `T` (`/var/folders/xx/yyy/C`, …): the same per-user prefix.
    ...(basename(tmpdir()) === "T" ? both(dirname(tmpdir())).map((path): [string, string] => [path, "/tmp"]) : []),
    [homedir(), "~"],
    // A listing's owner column (`ls -l`) names the account that runs the walk.
    [userInfo().username, "you"],
  ];
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

/**
 * A walk's own temporary folder (`/tmp/tavi-guide-<name>`) that the whole-path swaps missed: one the canvas cut
 * short (`/tmp/tavi-guide-clone-a-rep…`) or one no step named. A project's `code` folder, or one cut short, is ~/code
 * as the pages call it; any other keeps its name in the reader's home (`tavi-guide-backups` → ~/backups).
 */
const WALK_FOLDER = String.raw`(?:/private)?/tmp/tavi-guide-([\w.-]*)(/code)?(…)?`;

const walkFolderShown = (_match: string, name: string, code?: string, cut?: string): string =>
  code !== undefined || cut !== undefined ? `~/code${cut ?? ""}` : `~/${name}`;

/**
 * `text` with each private path swapped for what the reader would type. A shell expands `~` only outside quotes, so a
 * home path the walk's answer quoted (`'/Users/x/tavi-demo/desktop'`) is shown as `~/'tavi-demo/desktop'`, which still
 * names the same folder when typed, not `'~/tavi-demo/desktop'`, which makes a folder called `~`.
 */
export function redact(text: string, pairs: readonly (readonly [string, string])[]): string {
  return pairs
    .reduce((out, [from, to]) => out.split(from).join(to), text)
    .replace(new RegExp(WALK_FOLDER, "g"), walkFolderShown)
    .replace(/'~(\/|')/g, (_match, after: string) => (after === "/" ? "~/'" : "~"));
}

/** What a platform serves a person's face from: hidden in every picture. */
const AVATARS = ["cdn.discordapp.com", "googleusercontent.com", "telegram.org", "t.me"];

/** The QR code's encoder, from the canvas's own dependencies. */
const QR_ENCODER = join(root, "apps/ui/node_modules/uqr/dist/index.mjs");

/** Each pairing QR code holds the bot's address: it is drawn again from its link with the placeholders in. */
async function redactQrCodes(page: Page, pairs: readonly (readonly [string, string])[]): Promise<void> {
  for (const box of await page.locator(".pairing-layout:has(svg.qr-code)").all()) {
    const link = await box.locator(".pairing-links a").getAttribute("href");
    if (link === null) throw new Error("a pairing QR code with no link: it cannot be redacted");
    const { encode } = (await import(QR_ENCODER)) as {
      encode(value: string, options: object): { data: boolean[][]; size: number };
    };
    const { data, size } = encode(redact(link, pairs), { ecc: "M", border: 2 });
    let path = "";
    for (const [y, row] of data.entries()) for (const [x, dark] of row.entries()) if (dark) path += `M${String(x)} ${String(y)}h1v1h-1z`;
    await box.locator("svg.qr-code").evaluate(
      (svg, drawn) => {
        svg.setAttribute("viewBox", `0 0 ${String(drawn.size)} ${String(drawn.size)}`);
        svg.querySelector("path")?.setAttribute("d", drawn.path);
      },
      { path, size },
    );
  }
}

/** The page's words a picture can show: its text and its fields. */
const pageText = (page: Page): Promise<string> =>
  page.evaluate(() =>
    [
      document.body.textContent,
      ...[...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].map((field) => field.value),
    ].join("\n"),
  );

/** Replaces every path and personal value the picture must not show in the page's text and fields, before the shot. */
async function redactPage(page: Page, pairs: readonly (readonly [string, string])[]): Promise<void> {
  await page.evaluate(
    ({ list, folder }) => {
      // As walkFolderShown, written out again: the page has no access to this module.
      const shown = (_match: string, name: string, code?: string, cut?: string): string =>
        code !== undefined || cut !== undefined ? `~/code${cut ?? ""}` : `~/${name}`;
      // As redact: a quoted home path is shown as ~/'…', which a shell expands, not '~/…'.
      const swap = (text: string) =>
        list
          .reduce((out, [from, to]) => out.split(from).join(to), text)
          .replace(new RegExp(folder, "g"), shown)
          .replace(/'~(\/|')/g, (_match, after: string) => (after === "/" ? "~/'" : "~"));
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        const next = swap(text);
        if (next !== text) node.textContent = next;
      }
      for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
        const next = swap(field.value);
        if (next !== field.value) field.value = next;
      }
    },
    { list: pairs as [string, string][], folder: WALK_FOLDER },
  );
  await page.evaluate((hosts) => {
    for (const image of document.images) {
      if (hosts.some((host) => image.src.includes(host))) image.style.visibility = "hidden";
    }
  }, AVATARS);
  await redactQrCodes(page, pairs);
}

/**
 * How much of a picture may move before it counts as changed: about 200 pixels of a 1280×800 screen, enough to
 * pass WebP's own noise and to catch a word changed in a sentence (0.2% let a removed "(0600)" through).
 */
const CHANGED = 0.0002;

/**
 * In a blank page of the same browser: the PNG as WebP, and whether it differs
 * from the WebP already committed outside the masked boxes (more than 0.02% of
 * its pixels moved by more than a little in any channel).
 */
async function encode(
  browser: Browser,
  png: Buffer,
  previous: Buffer | undefined,
  masks: readonly { x: number; y: number; width: number; height: number }[],
): Promise<{ webp: Buffer; changed: boolean }> {
  const page = await browser.newPage();
  try {
    const result = await page.evaluate(
      async ({ next, before, boxes, threshold }) => {
        const load = async (src: string) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          return image;
        };
        const draw = (image: HTMLImageElement) => {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d") as CanvasRenderingContext2D;
          context.drawImage(image, 0, 0);
          return { canvas, context };
        };
        const fresh = draw(await load(`data:image/png;base64,${next}`));
        const webp = fresh.canvas.toDataURL("image/webp", 0.9).split(",")[1] as string;
        if (before === undefined) return { webp, changed: true };
        const old = draw(await load(`data:image/webp;base64,${before}`));
        if (old.canvas.width !== fresh.canvas.width || old.canvas.height !== fresh.canvas.height) return { webp, changed: true };
        for (const { context } of [fresh, old]) {
          context.fillStyle = "#000";
          for (const box of boxes) context.fillRect(box.x, box.y, box.width, box.height);
        }
        const a = fresh.context.getImageData(0, 0, fresh.canvas.width, fresh.canvas.height).data;
        const b = old.context.getImageData(0, 0, old.canvas.width, old.canvas.height).data;
        let moved = 0;
        for (let index = 0; index < a.length; index += 4) {
          const delta = Math.max(
            Math.abs((a[index] ?? 0) - (b[index] ?? 0)),
            Math.abs((a[index + 1] ?? 0) - (b[index + 1] ?? 0)),
            Math.abs((a[index + 2] ?? 0) - (b[index + 2] ?? 0)),
          );
          if (delta > 32) moved++;
        }
        return { webp, changed: moved / (a.length / 4) > threshold };
      },
      {
        next: png.toString("base64"),
        before: previous?.toString("base64"),
        boxes: masks as { x: number; y: number; width: number; height: number }[],
        threshold: CHANGED,
      },
    );
    return { webp: Buffer.from(result.webp, "base64"), changed: result.changed };
  } finally {
    await page.close();
  }
}

/** How a step's canvas picture is taken. */
interface ShotOptions {
  /** The model's own words: hidden from the change check, not from the picture. */
  readonly mask?: readonly Locator[];
  /** `answer`: frame the latest answer even when the step left the view elsewhere in the chat. */
  readonly frame?: "answer";
}

/**
 * Scrolls the transcript so a picture shows what the step is about. A sent turn keeps its message at the top of
 * the view and leaves a long answer below the composer (**Jump to latest**), and a card the step crops may sit
 * under the composer. `target`: brought wholly above the composer. None: the latest answer, whole if it fits (with
 * what came before it above), else from its start, its tool lines included.
 */
async function frameForShot(page: Page, target: Locator | undefined, frame: ShotOptions["frame"]): Promise<void> {
  // The button: its paragraph takes no height, which Playwright counts as hidden.
  const behind = await page
    .locator(".jump-latest button")
    .first()
    .isVisible()
    .catch(() => false);
  if (target === undefined && frame === undefined && !behind) return;
  // The latest answer, as `lastAnswer` finds it: the last article with a Copy response button.
  const subject =
    target ??
    page
      .locator("main .runs article")
      .filter({ has: page.getByRole("button", { name: /^Copy response/ }) })
      .last();
  const handle = await subject.elementHandle({ timeout: 1_000 }).catch(() => null);
  if (handle === null) return;
  await page.evaluate(
    ({ subject, whole }) => {
      const scroller = document.querySelector<HTMLElement>("main .runs");
      if (scroller === null || !scroller.contains(subject)) {
        // A crop elsewhere (a Settings card below the fold): brought wholly into the window, or from its top if taller.
        if (!whole) {
          const box = subject.getBoundingClientRect();
          if (box.top < 0 || box.bottom > innerHeight)
            subject.scrollIntoView({ block: box.height <= innerHeight - 32 ? "center" : "start" });
        }
        return;
      }
      const view = scroller.getBoundingClientRect();
      const composer = document.querySelector<HTMLElement>("main .composer-box")?.getBoundingClientRect();
      const top = view.top + 8;
      const bottom = Math.min(view.bottom, composer?.top ?? view.bottom) - 8;
      const outer = subject.getBoundingClientRect();
      // A crop already clear of the composer stays where the step put it.
      if (!whole && outer.top >= top && outer.bottom <= bottom) return;
      // A turn's article holds its message too: the answer starts at Tavi's heading. The message shows above it when
      // there is room; a long answer is pictured from its heading.
      const heading = whole ? subject.querySelector<HTMLElement>(".assistant-heading") : null;
      const start = heading?.getBoundingClientRect().top ?? outer.top;
      scroller.scrollTop += outer.bottom - start <= bottom - top ? outer.bottom - bottom : start - top;
    },
    { subject: handle, whole: target === undefined },
  );
  await handle.dispose();
}

/** Runs `take` with **Jump to latest** hidden: it floats over the foot of whatever a crop of the chat shows. */
export async function hidingJump<T>(page: Page, take: () => Promise<T>): Promise<T> {
  const jump = page.locator(".jump-latest");
  const set = (visibility: string) =>
    jump.evaluateAll((elements, value) => {
      for (const element of elements) (element as HTMLElement).style.visibility = value;
    }, visibility);
  await set("hidden");
  const taken = await take();
  await set("");
  return taken;
}

/** Where a step's picture goes, absolute, and which kind the page shows for it. */
function expectedImage(guide: Guide, step: GuideStep): { kind: "webp" | "svg"; file: string } {
  const src = step.images[0]?.src ?? "";
  const kind = src.endsWith(".svg") ? "svg" : "webp";
  return { kind, file: join(root, stepImagePath(guide, step, kind)) };
}

/** Walks the guide at `docs/use-cases/<path>.md` as one test, a step at a time. */
export function walkGuide(path: string, options: WalkOptions): void {
  const guide = readGuide(join(guidesRoot, `${path}.md`));
  const findings: Finding[] = [];
  const unwalked: { step: string; reason: string }[] = [];
  let browser: Browser | undefined;
  let session: Session | undefined;
  /** Set once the walk is under way: a skipped or refused walk leaves the last real report as it was. */
  let walked = false;

  describe(`guide: ${guide.title}`, () => {
    beforeAll(async () => {
      browser = await launchBrowser();
    }, 60_000);

    // Stopping an owner, its canvas and the browser takes longer than a test hook's default ten seconds.
    afterAll(async () => {
      await browser?.close();
      await cleanUp();
      if (!walked) return;
      const report = join(root, "plans/qa", `guide-walk-${guide.folder.replace(/\//g, "-")}-${guide.slug}.json`);
      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(report, `${JSON.stringify({ guide: path, walkedAt: new Date().toISOString(), findings, unwalked }, null, 2)}\n`);
      if (findings.length > 0) console.warn(`${path}: ${findings.length} finding(s) — ${report.slice(root.length + 1)}`);
    }, 60_000);

    it(`walks ${path}`, { timeout: options.timeoutMs ?? 600_000 }, async (test) => {
      // The article is the list: every step it has is walked, and nothing else.
      expect(Object.keys(options.steps).sort(), "the walk's steps are the article's").toEqual(guide.steps.map((step) => step.key).sort());
      if (options.model === true) {
        const problem = keyFileProblem(keyFile);
        if (problem !== undefined) test.skip(problem);
      }
      session = await openSession({
        configured: options.configured,
        withModel: options.model === true,
        keyFile,
        searchKeys: process.env["TAVI_GUIDE_SEARCH_KEYS"],
        seed: options.seed ?? [],
        serve: options.serve ?? [],
        ...(options.main === undefined ? {} : { main: options.main }),
      });
      walked = true;
      if (options.search === true && !/\btavily\b/.test(session.tavi("search", "list"))) {
        session.tavi("search", "add", "tavily", "--kind", "tavily");
      }
      const { dataDir } = session;
      const paths = redactions(dataDir);
      /** The swaps for a picture, read at each one: a walk finds out some of the person's ids as it goes. */
      const swaps = (): readonly (readonly [string, string])[] =>
        [...personalSwaps(), ...folderSwaps(), ...paths].sort((a, b) => b[0].length - a[0].length);
      let ui: { page: Page; link: string } | undefined;
      let current: GuideStep | undefined;
      let pictured = false;
      /** The pictures this walk took, written together once every step has passed. */
      const pending: {
        readonly file: string;
        readonly data: Buffer | string;
        readonly changed: boolean;
      }[] = [];

      const page = async (): Promise<Page> => {
        if (ui === undefined) {
          const opened = await (session as Session).openUi(browser as Browser);
          const label = () => current?.title ?? "start";
          opened.page.on("console", (message) => {
            if (OWNER_PROBE_503.test(message.text()) && message.location().url.endsWith("/api/owner") && whileOwnerDown(Date.now())) return;
            if (message.type() === "error" || message.type() === "warning") {
              findings.push({ kind: "console", step: label(), detail: `${message.type()}: ${message.text().slice(0, 300)}` });
            }
          });
          opened.page.on("pageerror", (error) => findings.push({ kind: "console", step: label(), detail: `uncaught: ${error.message}` }));
          opened.page.on("response", (response) => {
            if (response.status() >= 400 && response.url().startsWith(new URL(opened.link).origin)) {
              const detail = `${response.status()} ${new URL(response.url()).pathname}`;
              if (OWNER_PROBE_503.test(detail) && whileOwnerDown(Date.now())) return;
              findings.push({ kind: "network", step: label(), detail });
            }
          });
          ui = { page: opened.page, link: opened.link };
        }
        return ui.page;
      };

      const walk: WalkContext = {
        dataDir,
        tavi: (...args) => (session as Session).tavi(...args),
        taviJson: <T>(...args: string[]) => JSON.parse((session as Session).tavi(...args, "--format", "json")) as T,
        page,
        async open(route) {
          const opened = await page();
          await opened.goto(new URL(route, (ui as { link: string }).link).href.replace(/#.*$/, ""));
          await opened.waitForLoadState("networkidle");
          await settled(opened, `${path} ${route}`, fail);
          return opened;
        },
        async shot(target, shotOptions) {
          const step = current as GuideStep;
          const image = expectedImage(guide, step);
          expect(image.kind, `${step.title}: the page shows a terminal picture for this step`).toBe("webp");
          const opened = await page();
          await opened.mouse.move(1, 1);
          await opened.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
          const take = async () => {
            await redactPage(opened, swaps());
            await frameForShot(opened, target, shotOptions?.frame);
            await opened.waitForTimeout(600);
            const box = target === undefined ? undefined : await target.boundingBox();
            const clip =
              box === null || box === undefined
                ? undefined
                : { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 };
            return { clip, png: await hidingJump(opened, () => opened.screenshot(clip === undefined ? {} : { clip })) };
          };
          let { clip, png } = await take();
          // A page that drew itself again after the swap may show the real words: one more go, then the walk fails.
          if (personalLeft(await pageText(opened)).length > 0) ({ clip, png } = await take());
          expect(personalLeft(await pageText(opened)), `${step.title}: the picture shows something personal`).toEqual([]);
          const masks = [];
          for (const locator of shotOptions?.mask ?? []) {
            for (const element of await locator.all()) {
              const at = await element.boundingBox();
              if (at !== null) masks.push({ x: at.x - (clip?.x ?? 0), y: at.y - (clip?.y ?? 0), width: at.width, height: at.height });
            }
          }
          const exists = existsSync(image.file);
          // A cover stands for the page in every index: a run that stumbled does not, however it ended.
          if (step.images[0]?.src === guide.cover?.src && (update || !exists)) {
            expect(await failedRows(opened, clip), `${step.title}: the page's cover shows a failed step`).toEqual([]);
          }
          // The checks come after the picture: their other widths and themes would close an open list or menu first.
          findings.push(...(await probePage(opened, step.title)));
          pictured = true;
          if (exists && !update) return;
          const { webp, changed } = await encode(browser as Browser, png, exists ? readFileSync(image.file) : undefined, masks);
          pending.push({ file: image.file, data: webp, changed });
        },
        async terminal(spec) {
          const step = current as GuideStep;
          const image = expectedImage(guide, step);
          expect(image.kind, `${step.title}: the page shows a canvas picture for this step`).toBe("svg");
          const cols = spec.cols ?? 100;
          const lines = await terminalLines(dataDir, spec, `${path} ${step.title}`, (transcript) => redact(transcript, swaps()), fail);
          const text = lines.map((cells) =>
            cells
              .map((cell) => cell.ch)
              .join("")
              .trimEnd(),
          );
          expect(personalLeft(text.join("\n")), `${step.title}: the picture shows something personal`).toEqual([]);
          findings.push(...probeTerminal(text, step.title));
          pictured = true;
          for (const theme of ["light", "dark"] as const) {
            const file = theme === "dark" ? image.file.replace(/\.svg$/, "-dark.svg") : image.file;
            const svg = svgOf(lines, { theme, title: spec.title, cols });
            const exists = existsSync(file);
            if (exists && !update) continue;
            pending.push({ file, data: svg, changed: !exists || readFileSync(file, "utf8") !== svg });
          }
          return text;
        },
        unwalked(reason) {
          unwalked.push({ step: current?.title ?? "", reason });
          console.log(`${path}: "${current?.title}" not walked: ${reason}`);
        },
        needsUser(what) {
          if (!provided.has(what)) test.skip(`needs ${what} from you (TAVI_GUIDE_PROVIDED=${what})`);
        },
      };

      for (const step of guide.steps) {
        current = step;
        pictured = false;
        await (options.steps[step.key] as (walk: WalkContext) => Promise<void>)(walk);
        // A step the walk could not show still has its picture from a walk that could, and says so.
        if (!pictured && !unwalked.some((entry) => entry.step === step.title)) {
          throw new Error(`${step.title}: the walk took no picture (call shot() or terminal(), or unwalked())`);
        }
      }
      // A guide's pictures tell one story: when any of them changed, all are written, so no step shows a run the
      // others did not. Nothing is written for a walk that failed.
      if (pending.some((picture) => picture.changed)) {
        for (const { file, data } of pending) {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, data);
          console.log(`wrote ${file.slice(root.length + 1)}`);
        }
      }
      if (strict) expect(findings, "findings on the screens this guide shows").toEqual([]);
    });
  });
}
