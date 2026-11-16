/**
 * What the automation guides' walks share: the workspace's time zone, dates a
 * few days from now in it, a box over two elements for a picture, and a
 * research routine made from Schedule, waited on until its setup check has
 * passed and run. Each writer keeps to their own clearly named exports here.
 */
import { expect } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";

/** The zone every automation walk's workspace is in: the owner's `TZ` and the canvas's too. */
const WALK_ZONE = "Europe/London";

/** A seed command that sets the workspace's time zone, so every read-back and picture says the same zone. */
export const SEED_ZONE: readonly string[] = ["config", "set", "workspace.timezone", WALK_ZONE];

/** `YYYY-MM-DD`, `days` from today in the walk's zone. */
export function inDays(days: number): string {
  const when = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: WALK_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
}

/** A routine's schedule rows (`tavi schedules list` under the owner names each routine's triggers by its routine). */
interface ScheduleRow {
  readonly scheduleId: string;
  readonly name: string;
  readonly routineId?: string;
}

/** The routine's id, read from its trigger's row in `tavi schedules list`. */
export function routineIdOf(walk: { taviJson<T>(...args: string[]): T }): string {
  const rows = walk.taviJson<readonly ScheduleRow[]>("schedules", "list");
  const id = rows.find((row) => row.routineId !== undefined)?.routineId;
  if (id === undefined) throw new Error("no routine's trigger among the schedules");
  return id;
}

/**
 * Fills Center → Schedule's **New routine** form with a name and an objective, leaving the dialog open for the step's
 * picture: returns the dialog.
 */
export async function fillNewRoutine(page: Page, routine: { readonly name: string; readonly objective: string }): Promise<Locator> {
  await page.getByRole("button", { name: "New routine" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(routine.name);
  await dialog.getByLabel("Objective").fill(routine.objective);
  await dialog.locator(".cadence-preview ol li").nth(2).waitFor();
  return dialog;
}

/** Saves the New routine form and waits for it to close: the owner has the routine, and starts its setup check. */
export async function saveRoutine(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Save routine" }).click();
  await dialog.waitFor({ state: "detached", timeout: 120_000 });
}

/**
 * On a routine's page, until its setup check has passed: the heading's badge says `active` (the evaluation makes
 * about 36 model calls and may take up to 15 minutes). A routine starts as a draft, so a draft is waited through too.
 */
export async function routineActive(page: Page): Promise<void> {
  const badge = page.locator("h2.page-title .badge").first();
  await badge.waitFor({ timeout: 60_000 });
  await expect
    .poll(
      async () => {
        const status = ((await badge.textContent()) ?? "").trim();
        if (status !== "active") {
          await page
            .getByRole("button", { name: "Refresh details" })
            .click({ timeout: 5_000 })
            .catch(() => undefined);
        }
        return status;
      },
      { timeout: 20 * 60_000, interval: 10_000 },
    )
    .toBe("active");
}

/**
 * On a run's page (Run now opens it), until the run has ended: its heading's badge is no longer queued, running or
 * interrupted. Returns how it ended.
 */
export async function routineRunEnded(page: Page): Promise<string> {
  const status = page.locator("h2.page-title", { hasText: /^Run / }).locator(".badge");
  await status.waitFor({ timeout: 60_000 });
  let last = "";
  await expect
    .poll(
      async () => {
        last = ((await status.textContent()) ?? "").trim();
        if (last === "" || /queued|running|interrupted/.test(last)) {
          await page
            .getByRole("button", { name: "Refresh run" })
            .click({ timeout: 5_000 })
            .catch(() => undefined);
          return false;
        }
        return true;
      },
      { timeout: 20 * 60_000, interval: 5_000 },
    )
    .toBe(true);
  return last;
}

/**
 * A box over `from` down to `to` (two elements of one column, such as a heading and the list under it), for
 * `walk.shot` to crop to both: an empty, invisible element laid over them where they stand in the window (scroll them
 * into view first), removed by the returned function.
 */
export async function spanning(page: Page, from: Locator, to: Locator): Promise<{ box: Locator; remove: () => Promise<void> }> {
  const top = await from.boundingBox();
  const bottom = await to.boundingBox();
  if (top === null || bottom === null) throw new Error("spanning: an element is not on the page");
  await page.evaluate(
    ({ x, y, width, height }) => {
      const box = document.createElement("div");
      box.id = "walk-span";
      box.setAttribute("aria-hidden", "true");
      Object.assign(box.style, {
        position: "fixed",
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: "none",
      });
      document.body.append(box);
    },
    {
      x: Math.min(top.x, bottom.x),
      y: top.y,
      width: Math.max(top.x + top.width, bottom.x + bottom.width) - Math.min(top.x, bottom.x),
      height: bottom.y + bottom.height - top.y,
    },
  );
  return {
    box: page.locator("#walk-span"),
    remove: () => page.evaluate(() => document.getElementById("walk-span")?.remove()),
  };
}

/* ---- Schedules' fires, Home and the schedule page: watch-a-page-or-feed, tell-me-only-when-it-changes,
   trigger-from-a-webhook, cap-what-it-spends and why-didnt-it-run. ---- */

/** One row of a schedule's fire history (`tavi schedules show <name> --format json`'s `recentFires`). */
export interface ScheduleFire {
  readonly fireTime: string;
  readonly outcomeKind: string;
  readonly outcome: string;
  readonly reasonCode: string;
  readonly taskId: string | null;
}

/** A schedule as `tavi schedules show <name> --format json` prints it: the fields these walks read. */
export interface ScheduleShown {
  readonly scheduleId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly pausedReason?: string;
  readonly consecutiveFailures: number;
  readonly lastOutcome: string | null;
  readonly notify?: string;
  readonly maxTokens?: number;
  readonly watch?: boolean;
  readonly precheck?: { readonly kind: string; readonly target: string };
  readonly webhook?: { readonly since: string };
  readonly recentFires: readonly ScheduleFire[];
}

type TaviJson = { taviJson<T>(...args: string[]): T };

/** The schedule called `name`, with its recent fires, newest first. */
export const scheduleShown = (walk: TaviJson, name: string): ScheduleShown => walk.taviJson<ScheduleShown>("schedules", "show", name);

/** Until the schedule's newest fire is one `matches` accepts (within `timeoutMs`): that fire. */
export async function fireRecorded(
  walk: TaviJson,
  name: string,
  matches: (fire: ScheduleFire) => boolean,
  timeoutMs = 180_000,
): Promise<ScheduleFire> {
  let found: ScheduleFire | undefined;
  await expect
    .poll(
      () => {
        found = scheduleShown(walk, name).recentFires.find(matches);
        return found !== undefined;
      },
      { timeout: timeoutMs, interval: 3_000 },
    )
    .toBe(true);
  return found as ScheduleFire;
}

/**
 * Opens the schedule's page in the canvas and returns a box over its **Fires** heading and list (the first `rows`
 * fires), scrolled into view for `walk.shot`; call `remove` after the shot.
 */
export async function scheduleFires(
  walk: { open(route: string): Promise<Page> },
  scheduleId: string,
  rows = 3,
): Promise<{ page: Page; box: Locator; remove: () => Promise<void> }> {
  const page = await walk.open(`/center/schedule/schedules/${scheduleId}`);
  const heading = page.getByRole("heading", { name: "Fires" });
  await heading.waitFor();
  const fires = page.locator("ol.schedule-fires > li");
  await fires.first().waitFor();
  const last = fires.nth(Math.min(rows, await fires.count()) - 1);
  await heading.evaluate((element) => element.scrollIntoView({ block: "start" }));
  const span = await spanning(page, heading, last);
  return { page, ...span };
}

/** Opens Home and takes the step's picture of the schedule's latest result there, its words masked from the change check. */
export async function homeNoticeShot(
  walk: { open(route: string): Promise<Page>; shot(target?: Locator, options?: { readonly mask?: readonly Locator[] }): Promise<void> },
  name: string,
  dismiss: (page: Page) => Promise<void>,
): Promise<void> {
  const page = await walk.open("/");
  await dismiss(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  const notice = page.locator("main").getByText(`Scheduled run “${name}”`).last();
  await notice.waitFor({ timeout: 60_000 });
  await notice.scrollIntoViewIfNeeded();
  await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
  await page.setViewportSize({ width: 1280, height: 800 });
}
