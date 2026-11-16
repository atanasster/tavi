import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { delay } from "@tavi/test-support";
import { expect } from "vitest";

import { type Locator, type Page, root } from "../../../scripts/docs/browser.mjs";
import { spanning } from "./automation.js";
import { ownerStopped } from "./walk.js";

/**
 * What the skills guides' walks share: the workspace's skill versions read back
 * as `tavi skills list` gives them, a fixture package's path, the canvas's
 * Skills section in Soul & memory and one version opened in it, and stopping
 * the walk's owner for the commands that work on the data directory alone.
 */

/** Runs a tavi command with `--format json` on the walk's data directory, parsed (`walk.taviJson`). */
type TaviJson = <T>(...args: string[]) => T;

export interface SkillRow {
  readonly skillId: string;
  readonly version: string;
  readonly reviewState: "proposed" | "approved" | "rejected";
  readonly provenance: string;
  readonly importedAt: string;
  readonly manifest: { readonly name: string; readonly proposal?: { readonly requested: boolean; readonly taskId: string } };
  readonly usage?: { readonly uses: number };
}

interface Shown {
  readonly activation?: { readonly activeVersion?: string };
}

/** Every version of every skill in the workspace (`tavi skills list`). */
export const skillVersions = (taviJson: TaviJson): SkillRow[] => taviJson<SkillRow[]>("skills", "list");

/** The skill's active version, if any (`tavi skills show`). */
export const activeVersion = (taviJson: TaviJson, skillId: string): string | undefined =>
  taviJson<Shown>("skills", "show", skillId).activation?.activeVersion;

/** A fixture under `tests/guides/fixtures/<slug>/`, relative to the repository, as the terminal pictures run from there. */
export const fixture = (slug: string, ...path: string[]): string => join("tests/guides/fixtures", slug, ...path);

/** The same fixture, absolute. */
export const fixturePath = (slug: string, ...path: string[]): string => join(root, fixture(slug, ...path));

/** Soul & memory's Skills section, scrolled to the top of the window. */
export async function skillsSection(open: (route: string) => Promise<Page>): Promise<{ page: Page; section: Locator }> {
  const page = await open("/center/identity");
  const section = page.locator("section.soul-skills");
  await section.getByRole("heading", { name: "Skills", exact: true }).waitFor();
  await section.evaluate((element) => element.scrollIntoView({ block: "start" }));
  return { page, section };
}

/** Opens `skillId@version` from the Skills section's list, and waits for its text, hash and provenance. */
export async function openVersion(page: Page, skillId: string, version: string): Promise<Locator> {
  await page
    .locator("section.soul-skills")
    .getByRole("button", { name: new RegExp(`· ${skillId}@${version.replace(/[.]/g, "\\.")}$`) })
    .first()
    .click();
  const viewer = page.locator(`section.soul-skill-viewer[aria-label="${skillId}@${version}"]`);
  await viewer.getByText(/sha256 /).waitFor();
  return viewer;
}

/** Until the version's review state is `state` (the canvas's decision reached the owner). */
export async function reviewed(taviJson: TaviJson, skillId: string, version: string, state: SkillRow["reviewState"]): Promise<void> {
  await expect
    .poll(() => skillVersions(taviJson).find((row) => row.skillId === skillId && row.version === version)?.reviewState, {
      timeout: 15_000,
    })
    .toBe(state);
}

/**
 * In an opened version: Approve (for another author's archive, `confirm`, then the confirmation's own button), the picture of the version approved with Activate offered (its header, state and
 * buttons), then Activate, until the owner says the version is active.
 */
export async function approveAndActivate(
  walk: { taviJson: TaviJson; page(): Promise<Page>; shot(target?: Locator): Promise<void> },
  viewer: Locator,
  skillId: string,
  version: string,
  confirm = false,
): Promise<void> {
  const page = await walk.page();
  await viewer.getByRole("button", { name: "Approve", exact: true }).click();
  if (confirm) await page.getByRole("dialog").getByRole("button", { name: "Yes, approve", exact: true }).click();
  await reviewed(walk.taviJson, skillId, version, "approved");
  const activate = viewer.getByRole("button", { name: "Activate", exact: true });
  await activate.waitFor();
  const span = await spanning(page, viewer.locator("header"), viewer.locator(".soul-skill-actions"));
  await walk.shot(span.box);
  await span.remove();
  await activate.click();
  await expect.poll(() => activeVersion(walk.taviJson, skillId), { timeout: 15_000 }).toBe(version);
}

/**
 * Stops the walk's own `tavi serve` (found by its data directory, which no other walk shares), as a reader stops
 * theirs before a command that works on the data directory alone. `restartOwner` starts it again.
 */
export async function stopOwner(dataDir: string): Promise<void> {
  const pattern = `serve .*--data-dir ${dataDir}$`;
  ownerStopped();
  spawnSync("pkill", ["-TERM", "-f", pattern]);
  for (let waited = 0; spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim() !== ""; waited += 250) {
    if (waited > 30_000) throw new Error("the walk's owner did not stop");
    await delay(250);
  }
}
