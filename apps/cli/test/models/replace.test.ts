import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { parseReplaceTarget } from "../../src/features/models/parse.js";

/** `tavi models replace`: every use of a model moved to another, only once asked. */

const directories = temporaryDirectories({ prefix: "tavi-replace-" });
afterEach(() => directories.cleanup());

async function run(directory: string, args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const captured = capture();
  const code = await main([...args, "--data-dir", directory], { io: captured.io });
  return { code, out: captured.stdout(), err: captured.stderr() };
}

async function configured(): Promise<string> {
  const directory = directories.create();
  // Nothing is called: the endpoint is never reached by add, set-default or set-role.
  for (const args of [
    ["models", "add", "local", "--base-url", "http://127.0.0.1:9/v1", "--model", "llama3", "--local-only"],
    ["models", "set-default", "--connection", "local", "--model", "llama3"],
    ["models", "set-role", "main", "--connection", "local", "--model", "llama3"],
    ["models", "set-role", "fast", "--connection", "local", "--model", "small", "--fallback", "local/llama3"],
  ]) {
    const result = await run(directory, args);
    expect(result.code, result.err).toBe(EXIT.ok);
  }
  return directory;
}

async function roles(directory: string) {
  const read = await run(directory, ["models", "roles"]);
  return JSON.parse(read.out) as {
    workspaceDefault: { target: { connectionId: string; model: string } };
    roles: { role: string; target: { model: string }; fallback: { model: string }[] }[];
  };
}

describe("tavi models replace", () => {
  it("lists every use and changes nothing without --yes off a terminal", async () => {
    const directory = await configured();
    const listed = await run(directory, ["models", "replace", "local/llama3", "--with", "qwen3"]);
    expect(listed.code).toBe(EXIT.usage);
    expect(listed.err).toContain("local/llama3 is used by:");
    expect(listed.err).toContain("the connection's default");
    expect(listed.err).toContain("the workspace default (default)");
    expect(listed.err).toContain("the main role (default)");
    expect(listed.err).toContain("a fallback of the fast role (default)");
    expect(listed.err).toContain("Nothing changed: run again with --yes");
    expect((await roles(directory)).workspaceDefault.target.model).toBe("llama3");
  });

  it("moves the defaults, roles and fallbacks with --yes, never one twice in a chain", async () => {
    const directory = await configured();
    const replaced = await run(directory, ["models", "replace", "local/llama3", "--with", "qwen3", "--yes"]);
    expect(replaced.code, replaced.err).toBe(EXIT.ok);
    const result = JSON.parse(replaced.out) as { changed: { kind: string }[]; skipped: unknown[]; failed: unknown[] };
    expect(result.changed.map((use) => use.kind).sort()).toEqual(["connection-default", "role", "role-fallback", "workspace-default"]);
    expect(result.failed).toEqual([]);
    const after = await roles(directory);
    expect(after.workspaceDefault.target.model).toBe("qwen3");
    expect(after.roles.find((entry) => entry.role === "main")?.target.model).toBe("qwen3");
    expect(after.roles.find((entry) => entry.role === "fast")?.fallback.map((entry) => entry.model)).toEqual(["qwen3"]);

    // The fast role's own model in place of its fallback: the chain keeps it once.
    const merged = await run(directory, ["models", "replace", "local/qwen3", "--with", "small", "--yes"]);
    expect(merged.code, merged.err).toBe(EXIT.ok);
    const fast = (await roles(directory)).roles.find((entry) => entry.role === "fast");
    expect(fast?.target.model).toBe("small");
    expect(fast?.fallback).toEqual([]);
  });

  it("refuses a model replacing itself, a connection that does not exist, and a bad target", async () => {
    const directory = await configured();
    const itself = await run(directory, ["models", "replace", "local/llama3", "--with", "llama3", "--yes"]);
    expect(itself.code).toBe(EXIT.usage);
    expect(itself.err).toContain("would replace itself");
    const elsewhere = await run(directory, ["models", "replace", "local/llama3", "--with", "x", "--connection", "nowhere", "--yes"]);
    expect(elsewhere.err).toContain("No connection nowhere");
    const unused = await run(directory, ["models", "replace", "local/never-used", "--with", "qwen3", "--yes"]);
    expect(unused.code).toBe(EXIT.ok);
    expect(unused.err).toContain("not used anywhere");
    const bad = await run(directory, ["models", "replace", "llama3", "--with", "qwen3"]);
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.err).toContain("needs <connection>/<model>");
  });

  it("splits a target at its first slash, so an OpenRouter model keeps its own", () => {
    expect(parseReplaceTarget("openrouter/anthropic/claude-sonnet-5.5")).toEqual({
      connectionId: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
    });
    expect(parseReplaceTarget("openrouter/")).toBeUndefined();
    expect(parseReplaceTarget("/x")).toBeUndefined();
  });
});
