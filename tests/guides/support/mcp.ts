/**
 * What the connected-apps MCP guides' walks share: the notes server they add (a fixture run with `node`, copied by
 * `tavi mcp add --dir`), its home folder in the walk's data directory, its review read back as JSON, and its review
 * opened in Settings → Connected apps.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { cli, withDataDir } from "../../../scripts/docs/session.mjs";

/** The notes server's folder, relative to the repository (where `walk.terminal` runs `tavi`). */
const NOTES_SERVER = "tests/guides/fixtures/add-an-mcp-server/notes-server";

/**
 * Runs `tavi mcp add notes --dir <the fixture> -- node server.mjs` on the walk's data directory, from the repository,
 * and returns what it printed.
 */
export function addNotes(dataDir: string, ...options: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TAVI_")));
  return execFileSync(
    process.execPath,
    [cli, ...withDataDir(["mcp", "add", "notes", "--dir", NOTES_SERVER, ...options, "--", "node", "server.mjs"], dataDir)],
    { encoding: "utf8", env: { ...env, TAVI_CREDENTIAL_KEYCHAIN: "off" }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
}

/** The server's own home, where its sandbox lets it write (its notes, and the update a walk drops in). */
export const notesHome = (dataDir: string): string => join(dataDir, "mcp", "mcp.notes", "home");

/** One tool of `tavi mcp review mcp.notes --format json`. */
interface ReviewedTool {
  readonly name: string;
  readonly toolId: string;
  readonly state: string;
}

/** `tavi mcp review mcp.notes --format json`: the fields these walks read. */
export interface Review {
  readonly reviewState: string;
  readonly tools: readonly ReviewedTool[];
  readonly warnings?: readonly string[];
}

/** The notes server's review, as the owner has it now. */
export const notesReview = (walk: { taviJson<T>(...args: string[]): T }): Review => walk.taviJson<Review>("mcp", "review", "mcp.notes");

/** Each of the notes server's tools by name, and its state. */
export const toolStates = (walk: { taviJson<T>(...args: string[]): T }): Record<string, string> =>
  Object.fromEntries(notesReview(walk).tools.map((tool) => [tool.name, tool.state]));

/** Opens the notes app's page in Settings → Connected apps, settled on its heading. */
export async function notesApp(walk: { open(route: string): Promise<Page> }): Promise<Page> {
  const page = await walk.open("/settings/apps/mcp.notes");
  await page.locator("header.apps-head h1", { hasText: "notes" }).waitFor();
  return page;
}

/** Opens the notes server's review from its app's page: the dialog, its tools' table drawn. */
export async function openNotesReview(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Review notes' tools" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("table.mcp-tools").waitFor();
  return dialog;
}
