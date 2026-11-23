import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Browser, launchBrowser, type Page, root } from "../../scripts/docs/browser.mjs";
import { cleanUp, cli, openSession, type Session } from "../../scripts/docs/session.mjs";

/**
 * The overflow walk (docs/LANGUAGES.md, "The overflow walk"): every canvas screen in
 * Bulgarian and in the stretched `qps` pseudo-locale, at phone, tablet and
 * desktop widths, light and dark, each checked by apps/ui/scripts/overflow-probe.js
 * for words that spill out of their box, labels an ellipsis cuts, buttons that
 * wrap, controls that overlap and a page that scrolls sideways.
 *
 * It drives a real owner and canvas (build first: `pnpm run build`), so it runs
 * only under `pnpm test:real`. Every finding goes to plans/qa/overflow-bg.json
 * with a picture of its screen; the test fails on any finding not on the
 * allow-list (tests/fixtures/overflow-allow.json), each entry of which says why
 * that cut or wrap is meant.
 */

interface ProbeFinding {
  readonly kind: "spill" | "cut" | "wrapped" | "overlap" | "sideways";
  readonly text: string;
  readonly selector: string;
  readonly detail: string;
}

interface Allowed {
  readonly kind: ProbeFinding["kind"];
  /** A part of the finding's own element (the last step of its selector). */
  readonly selector: string;
  /** A part of the path to it, when given: the element only inside this one. */
  readonly within?: string;
  /** Only on this route, when given. */
  readonly route?: string;
  /** Only in this language, when given: a wrap the stretched `qps` text causes and Bulgarian does not. */
  readonly locale?: "bg" | "qps";
  readonly why: string;
}

interface Found extends ProbeFinding {
  readonly locale: "bg" | "qps";
  readonly route: string;
  readonly width: number;
  readonly scheme: "light" | "dark";
  readonly picture: string;
}

const PROBE = readFileSync(join(root, "apps/ui/scripts/overflow-probe.js"), "utf8");
const ALLOWED = JSON.parse(readFileSync(join(root, "tests/fixtures/overflow-allow.json"), "utf8")) as readonly Allowed[];
const REPORT = join(root, "plans/qa/overflow-bg.json");
const PICTURES = join(root, "plans/qa/overflow");

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;
const SCHEMES = ["light", "dark"] as const;
const ROUTES = [
  "/",
  "/ideas",
  "/welcome/model?all=1",
  "/center/activity",
  "/center/approvals",
  "/center/schedule",
  "/center/heartbeat",
  "/center/identity",
  "/center/browser",
  "/settings/general",
  "/settings/models",
  "/settings/search",
  "/settings/system-prompt",
  "/settings/apps",
  "/settings/apps/discover",
  "/settings/credentials",
  "/settings/messaging",
  "/settings/people",
  "/settings/plugins",
  "/settings/permissions",
  "/settings/ideas",
] as const;

/** Something on each list, so a screen is measured with rows, not only its empty state. */
const SEED = [
  ["config", "set", "operator.name", "Alex"],
  ["reminders", "add", "Take the bins out", "--repeat", "19:30"],
  ["reminders", "add", "Call the dentist about the crown", "--repeat", "09:15"],
  ["todos", "add", "Renew the car insurance before the end of the month"],
  ["memory", "remember", "Prefers vegetarian dinners"],
] as const;

const allowed = (found: Found): boolean =>
  ALLOWED.some(
    (entry) =>
      entry.kind === found.kind &&
      (found.selector.split(" > ").at(-1) ?? "").includes(entry.selector) &&
      (entry.within === undefined || found.selector.includes(entry.within)) &&
      (entry.route === undefined || entry.route === found.route) &&
      (entry.locale === undefined || entry.locale === found.locale),
  );

/** Until the page has stopped asking the owner for things, at most 10 seconds: a screen still loading is measured as it stands. */
async function quiet(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

describe.skipIf(!existsSync(cli))("the canvas in Bulgarian fits its boxes", () => {
  let session: Session | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    session = await openSession({ configured: true, seed: SEED });
    session.tavi("config", "set", "workspace.locale", "bg");
    browser = await launchBrowser();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await cleanUp();
  }, 60_000);

  it("leaves no word spilt, cut or wrapped on any screen, in bg and qps, at every width", { timeout: 1_800_000 }, async () => {
    const found: Found[] = [];
    mkdirSync(PICTURES, { recursive: true });
    for (const locale of ["bg", "qps"] as const) {
      const { context, page, link } = await (session as Session).openUi(browser as Browser, VIEWPORTS[0]);
      const origin = new URL(link).origin;
      // As text, run in the page: this file's program has no DOM types.
      await page.evaluate(
        locale === "qps" ? 'localStorage.setItem("tavi.pseudoLocale", "1")' : 'localStorage.removeItem("tavi.pseudoLocale")',
      );
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        for (const scheme of SCHEMES) {
          await page.emulateMedia({ colorScheme: scheme });
          for (const route of ROUTES) {
            await page.goto(`${origin}${route}`);
            await quiet(page);
            const hits = (await page.evaluate(PROBE)) as ProbeFinding[];
            if (hits.length === 0) continue;
            const picture = join(PICTURES, `${locale}-${viewport.width}-${scheme}${route.replace(/[/?=]+/g, "-")}.png`);
            await page.screenshot({ path: picture, fullPage: true });
            for (const hit of hits)
              found.push({ ...hit, locale, route, width: viewport.width, scheme, picture: picture.slice(root.length + 1) });
          }
        }
      }
      await context.close();
    }
    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, `${JSON.stringify({ walkedAt: new Date().toISOString(), findings: found }, null, 2)}\n`);
    const left = found.filter((finding) => !allowed(finding));
    expect(
      left.map(
        (finding) =>
          `${finding.locale} ${finding.width} ${finding.scheme} ${finding.route}: ${finding.kind} ${finding.selector} "${finding.text}" (${finding.detail})`,
      ),
    ).toEqual([]);
  });
});
