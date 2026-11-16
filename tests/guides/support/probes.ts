// The functions handed to page.evaluate run in the browser, against its DOM.
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Page, root } from "../../../scripts/docs/browser.mjs";

/**
 * The checks a guide walk runs on every screen it photographs, besides the
 * step itself: what a careful reader would notice is wrong. A hit is a
 * finding, collected for the batch's QA report; it fails the walk only under
 * `TAVI_GUIDE_STRICT=1`.
 */
export interface Finding {
  readonly kind: "console" | "network" | "a11y" | "layout" | "theme" | "terminal" | "copy";
  readonly step: string;
  readonly detail: string;
}

const AXE = join(root, "apps/ui/node_modules/axe-core/axe.min.js");

/** Text a reader should never see: a value that was never filled in, or an object printed as text. */
const LEAKED = /\[object Object\]|\bundefined\b|\bNaN\b/;

interface LayoutHit {
  readonly what: string;
}

/** Horizontal page scroll, clipped text that isn't meant to be cut, broken images, and leaked values. */
async function layout(page: Page): Promise<string[]> {
  const hits = await page.evaluate((leaked) => {
    const found: LayoutHit[] = [];
    const describe = (element: Element) => {
      const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
      return `<${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? ` class="${element.className}"` : ""}> "${text}"`;
    };
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      found.push({ what: `the page scrolls sideways (${document.documentElement.scrollWidth}px wide in ${window.innerWidth}px)` });
    }
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = element.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      const clips = (style.overflowX === "hidden" || style.overflowX === "clip") && element.scrollWidth > element.clientWidth + 1;
      const intended = style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none" || element.closest("[data-scroll]") !== null;
      const ownText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
      if (clips && !intended && ownText) found.push({ what: `clipped text: ${describe(element)}` });
      if (element instanceof HTMLImageElement && element.complete && element.naturalWidth === 0) {
        found.push({ what: `a broken image: ${element.getAttribute("src") ?? ""}` });
      }
    }
    // biome-ignore lint/performance/useDomNodeTextContent: only the text a reader sees counts, which textContent does not tell.
    const visible = document.body.innerText;
    const match = new RegExp(leaked).exec(visible);
    if (match !== null) {
      const at = visible.indexOf(match[0]);
      found.push({ what: `"${match[0]}" shown to the reader: "…${visible.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, " ")}…"` });
    }
    return found;
  }, LEAKED.source);
  return hits.map((hit) => hit.what);
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly { readonly target: readonly string[] }[];
}

/** An axe-core scan: serious and critical violations only (`rules` narrows it, e.g. to colour contrast). */
async function axe(page: Page, rules?: readonly string[]): Promise<string[]> {
  // The canvas's CSP refuses an injected <script>, rightly; evaluating the source runs outside it.
  if (!(await page.evaluate(() => "axe" in window))) await page.evaluate(readFileSync(AXE, "utf8"));
  const violations = await page.evaluate(
    async (only) => {
      const run = (window as unknown as { axe: { run: (context: Document, options: object) => Promise<{ violations: AxeViolation[] }> } })
        .axe.run;
      const options =
        only === undefined ? { resultTypes: ["violations"] } : { runOnly: { type: "rule", values: only }, resultTypes: ["violations"] };
      return (await run(document, options)).violations;
    },
    rules as string[] | undefined,
  );
  return violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes.length} element(s), first ${violation.nodes[0]?.target.join(" ") ?? "?"}`,
    );
}

/**
 * Every check on the page as it stands, then the same screen in the dark
 * theme (contrast and layout), at phone width (layout) and with reduced motion
 * (nothing may break), the page put back as it was afterwards.
 */
export async function probePage(page: Page, step: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (kind: Finding["kind"], details: readonly string[], prefix = "") => {
    for (const detail of details) findings.push({ kind, step, detail: `${prefix}${detail}` });
  };
  add("layout", await layout(page));
  add("a11y", await axe(page));
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(900);
  add("theme", await axe(page, ["color-contrast"]), "dark theme: ");
  add("theme", await layout(page), "dark theme: ");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  add("layout", await layout(page), "at 390px: ");
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(200);
  add("layout", await layout(page), "reduced motion: ");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForTimeout(400);
  return findings;
}

/** A spinner frame, a raw escape or a stack trace left on a settled terminal screen. */
export function probeTerminal(lines: readonly string[], step: string): Finding[] {
  const findings: Finding[] = [];
  const add = (detail: string) => findings.push({ kind: "terminal", step, detail });
  lines.forEach((line, index) => {
    if (/\x1b|\[\d+(;\d+)*[mK]/.test(line)) add(`line ${index + 1} shows a raw escape sequence: ${JSON.stringify(line.slice(0, 80))}`);
    if (LEAKED.test(line)) add(`line ${index + 1} shows a leaked value: ${JSON.stringify(line.trim().slice(0, 80))}`);
    if (/^\s+at .+:\d+:\d+\)?$/.test(line)) add(`line ${index + 1} is a stack trace: ${JSON.stringify(line.trim())}`);
  });
  const last = lines.filter((line) => line.trim() !== "").at(-1) ?? "";
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last)) add(`the screen settled on a spinner frame: ${JSON.stringify(last.trim())}`);
  return findings;
}

/** The failed step rows `clip` (or the whole window) shows, in their own words. */
export async function failedRows(page: Page, clip?: { x: number; y: number; width: number; height: number }): Promise<string[]> {
  const rows: string[] = [];
  for (const row of await page.locator("details.tools-failed").all()) {
    const at = await row.boundingBox();
    if (at === null || !(await row.isVisible())) continue;
    const shown =
      clip === undefined ||
      (at.y < clip.y + clip.height && at.y + at.height > clip.y && at.x < clip.x + clip.width && at.x + at.width > clip.x);
    if (shown) rows.push((await row.textContent()) ?? "");
  }
  return rows;
}
