import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { delay } from "@tavi/test-support";
import { expect } from "vitest";

import { root } from "../../../scripts/docs/browser.mjs";
import { cli } from "../../../scripts/docs/session.mjs";
import { guidesRoot, readGuide } from "../../../scripts/docs/guides.mjs";
import { projectsFolder } from "./steps.js";

/**
 * What the extend guides' walks share: the plugin a page tells the reader to write, taken from the page's own code
 * blocks (so the code a reader copies is the code the walk runs), the repository's examples, and a plugin's state and
 * a chat's tool calls read back through the CLI.
 */

type Walk = { tavi(...args: string[]): string; taviJson<T>(...args: string[]): T };

/** The file each code block's language stands for in a plugin's folder. */
const FILES: Readonly<Record<string, string>> = { json: "tavi-plugin.json", js: "index.mjs" };

/**
 * The plugin `docs/use-cases/<path>.md` shows: its first `json` block is `tavi-plugin.json`, its first `js` block
 * `index.mjs`.
 */
export function guideCode(path: string): { readonly manifest: string; readonly module: string } {
  const { text } = readGuide(join(guidesRoot, `${path}.md`));
  const blocks = new Map<string, string>();
  for (const match of text.matchAll(/```(json|js)\n([\s\S]*?)```/g)) {
    const [, language = "", code = ""] = match;
    if (!blocks.has(language)) blocks.set(language, code);
  }
  const manifest = blocks.get("json");
  const module = blocks.get("js");
  if (manifest === undefined || module === undefined) throw new Error(`${path} shows no json and js blocks to write`);
  return { manifest, module };
}

/**
 * An empty plugin folder, the reader's `~/tavi-plugins/<name>`, made under the system's temporary folder for this
 * walk (`slug` keeps walks run together apart) and deleted when it ends: its path, and `write(language, code)` to save
 * a code block into it as the page says.
 */
export function pluginFolder(slug: string, name: string): { readonly dir: string; write(language: "json" | "js", code: string): void } {
  const dir = join(projectsFolder(slug, {}), name);
  mkdirSync(dir);
  return {
    dir,
    write(language, code) {
      writeFileSync(join(dir, FILES[language] as string), code);
    },
  };
}

/** A plugin of the repository's `examples/` folder, by its path there (`plugins/acme-units`). */
export const example = (path: string): string => join(root, "examples", path);

export interface PluginState {
  readonly id: string;
  readonly enabled: boolean;
  readonly activeVersion?: string;
  readonly phase?: string;
  readonly versions: readonly { readonly version: string; readonly reviewState: string }[];
}

/** One plugin as `tavi plugins list` has it, or undefined when it is not installed. */
export const plugin = (walk: Walk, id: string): PluginState | undefined =>
  walk.taviJson<{ plugins: readonly PluginState[] }>("plugins", "list").plugins.find((entry) => entry.id === id);

/** Until the running owner reports `id` ready. */
export async function ready(walk: Walk, id: string): Promise<void> {
  await expect.poll(() => plugin(walk, id)?.phase, { timeout: 30_000, interval: 1_000 }).toBe("ready");
}

/** The tools a chat called, in order, read from its event stream. */
export function toolsCalled(walk: Walk, taskId: string): string[] {
  return walk
    .tavi("run", "--attach", taskId, "--format", "json")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { kind: string; toolName?: string })
    .filter((event) => event.kind === "tool.started")
    .map((event) => event.toolName ?? "");
}

/**
 * Stops the walk's own `tavi serve`, as a reader stops theirs before starting it with a new flag: by the process id of
 * the owner serving this walk's data directory. `restartOwner` starts one again.
 */
export async function stopOwner(dataDir: string): Promise<void> {
  const owners = () =>
    spawnSync("pgrep", ["-f", `serve .*--data-dir ${dataDir}$`], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((pid) => pid.trim() !== "");
  for (const pid of owners()) spawnSync("kill", ["-TERM", pid]);
  for (let waited = 0; owners().length > 0; waited += 250) {
    if (waited > 30_000) throw new Error("the walk's owner did not stop");
    await delay(250);
  }
}

export interface Validation {
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  readonly registered?: { readonly tools: readonly string[]; readonly hookCount: number; readonly providers: readonly unknown[] };
}

/**
 * `tavi plugins validate <dir> --format json`, the check a reader runs on their folder: it needs no data directory (a
 * `--data-dir` is accepted and unused), so it runs here rather than through `walk.tavi`.
 */
export function validate(dir: string): Validation {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TAVI_")));
  const ran = spawnSync(process.execPath, [cli, "plugins", "validate", dir, "--format", "json"], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return JSON.parse(ran.stdout) as Validation;
}
