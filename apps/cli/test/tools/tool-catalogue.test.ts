import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { inAttendedDeferredFamily } from "@tavi/agent-host/workflow";
import type { RegisteredTool } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * docs/TOOLS-AND-SKILLS.md's tool catalogue is the registry an owner composes:
 * every built-in tool, with its effect, where its input goes, whether its
 * output is third-party content, and whether an attended chat sees it at once
 * or finds it with `tools.search`. A tool added, removed or re-declared
 * without the table following fails here; `TAVI_UPDATE_GOLDEN=1` writes the
 * table between its markers.
 */

const UPDATE = process.env["TAVI_UPDATE_GOLDEN"] === "1";
const docPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/TOOLS-AND-SKILLS.md");
const START = "<!-- tool-catalogue:start -->";
const END = "<!-- tool-catalogue:end -->";

const runtimes: TaviRuntime[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

/** A description's first sentence, kept to one table cell. */
function purpose(description: string): string {
  // A sentence ends where the next one starts with a capital (or a code span): `e.g. 1-3` does not end one.
  const first = /^(.+?[.!?])(?=\s+[A-Z`(]|$)/s.exec(description)?.[1] ?? description;
  const clipped = first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first;
  return clipped.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

function row(tool: RegisteredTool): string {
  // As the taint gate reads a built-in's result (`labelOfMessage`): untrusted only when declared, or labelled by its store per result.
  const output =
    tool.labelledByStore === true || (tool.outputSource !== undefined && tool.untrustedOutput !== true)
      ? "per result"
      : tool.untrustedOutput === true
        ? "untrusted"
        : "trusted";
  const offered = inAttendedDeferredFamily(tool.id) ? "search" : "listed";
  return `| \`${tool.id}\` | ${tool.effect} | ${tool.sink} | ${output} | ${offered} | ${purpose(tool.description)} |`;
}

/** The rows in the registry's own order (code units, whatever the host's locale). */
function catalogue(tools: readonly RegisteredTool[]): string {
  const lines = [
    "",
    "| Tool | Effect | Input goes to | Output | Attended chat | What it does |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |",
  ];
  return `${[...lines, ...tools.map(row)].join("\n")}\n`;
}

it("the tool catalogue is the registry an owner composes", async () => {
  const directory = directories.create("tavi-tool-catalogue-");
  // A decoder stands in for the host's FFmpeg, so the video tools are listed whatever is installed here.
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory), {
    modelOverride: createFixtureModel({ turns: [] }),
    videoDecoderOverride: { close: async () => undefined } as never,
  });
  runtimes.push(runtime);
  // The listing leaves out what the gate reads (a store's labels, the sink): each tool's whole registration has them.
  const tools = runtime.tools
    .list()
    .filter((tool) => !tool.id.startsWith("mcp."))
    .flatMap((tool) => runtime.tools.get(tool.id) ?? []);
  expect(tools.map((tool) => tool.id)).toContain("browser.close");
  const expected = catalogue(tools);
  const doc = readFileSync(docPath, "utf8");
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  expect(start, `docs/TOOLS-AND-SKILLS.md has no ${START} … ${END} block`).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const current = doc.slice(start + START.length, end);
  if (UPDATE && current !== expected) {
    writeFileSync(docPath, `${doc.slice(0, start + START.length)}${expected}${doc.slice(end)}`);
    return;
  }
  expect(current, "the tool catalogue is out of date; TAVI_UPDATE_GOLDEN=1 rewrites it").toBe(expected);
});
