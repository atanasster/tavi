import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Every place the workflow runs a tool's handler goes through the plugins'
 * hooks: a new execution path added without a
 * hooks entry fails here, rather than quietly skipping every guard.
 */
const workflow = join(dirname(fileURLToPath(import.meta.url)), "../src/workflow");
/** The workflow's sources, each file on its own: a function never spans two. */
const sources = (readdirSync(workflow, { recursive: true, encoding: "utf8" }) as string[])
  .filter((name) => name.endsWith(".ts"))
  .map((name) => readFileSync(join(workflow, name), "utf8"));

/** The functions a `.handler(` call may stand in, each with the hook calls that cover it. */
const COVERED: Readonly<Record<string, readonly string[]>> = {
  dispatchTool: ["callDeniedByHooks(", "resultThroughHooks("],
  runHandler: ["resultThroughHooks("],
};

/** The name and body of the top-level function an offset in `source` falls in. */
function enclosing(source: string, at: number): { readonly name: string; readonly body: string } {
  const starts = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)].filter((match) => (match.index ?? 0) < at);
  const start = starts.at(-1);
  if (start === undefined) throw new Error(`no function encloses offset ${at}`);
  const next = source.slice(at).search(/^(?:export )?(?:async )?function \w+\(/m);
  return { name: start[1] ?? "", body: source.slice(start.index ?? 0, next === -1 ? source.length : at + next) };
}

describe("tool execution paths", () => {
  it("runs every tool handler where plugins' call and result hooks see it", () => {
    const calls = sources.flatMap((source) => [...source.matchAll(/\.handler\(/g)].map((match) => enclosing(source, match.index ?? 0)));
    expect(calls.map((call) => call.name).sort()).toEqual(Object.keys(COVERED).sort());
    for (const call of calls) for (const hook of COVERED[call.name] ?? []) expect(call.body, `${call.name} calls ${hook}`).toContain(hook);
  });

  it("shows a directly dispatched call's result to the result hooks", () => {
    const source = sources.find((text) => text.includes("async function startDirectCall(")) ?? "";
    const direct = source.slice(
      source.indexOf("async function startDirectCall("),
      source.indexOf("async function startDirectCall(") + 2_000,
    );
    expect(direct).toContain("resultThroughHooks(");
  });
});
