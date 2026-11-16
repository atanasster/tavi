import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { nowTimestamp } from "@tavi/contracts/util";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `tavi tasks instructions`: one chat's own
 * instructions from the terminal, through a running owner or from the data
 * directory when none runs.
 */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

/** An owner on a fresh data directory with one chat, `t1`. */
async function owner(): Promise<{ readonly directory: string; readonly handle: ServeHandle }> {
  const directory = directories.create("tavi-task-instructions-");
  const handle = await serve(
    fixtureServeOptions(directory),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  await handle.runtime.store.asPort().repositories.tasks.admit({
    prompt: fixturePromptPolicy,
    workspaceId: "default",
    principalId: "operator",
    operationKey: "op-t1",
    kind: "start",
    intent: { prompt: "hi" },
    checkpointNamespace: "",
    newTaskId: "t1",
    newAdmissionId: "adm-t1",
    newThreadId: "thread-t1",
    now: nowTimestamp(),
  });
  return { directory, handle };
}

const run = async (directory: string, ...argv: string[]) => {
  const captured = capture();
  const code = await main(["tasks", "instructions", ...argv, "--data-dir", directory], { io: captured.io });
  return { code, out: captured.out(), err: captured.err() };
};

describe("parsing tavi tasks instructions", () => {
  it("reads a task id, an action and quoted text, and refuses what the action does not take", () => {
    expect(parseArgs(["tasks", "instructions", "t1"])).toMatchObject({
      command: "tasks",
      taskInstructions: { action: "show", taskId: "t1", workspaceId: "default" },
    });
    expect(parseArgs(["tasks", "instructions", "t1", "set", "Be brief.", "--revision", "3", "--workspace", "team"])).toMatchObject({
      taskInstructions: { action: "set", text: "Be brief.", revision: 3, workspaceId: "team" },
    });
    expect(() => parseArgs(["tasks", "instructions"])).toThrow(UsageError);
    expect(() => parseArgs(["tasks", "instructions", "t1", "set"])).toThrow(/needs the text/);
    expect(() => parseArgs(["tasks", "instructions", "t1", "set", "Be", "brief"])).toThrow(/quote the instructions/);
    expect(() => parseArgs(["tasks", "instructions", "t1", "reset", "extra"])).toThrow(UsageError);
    expect(() => parseArgs(["tasks", "instructions", "t1", "show", "--revision", "2"])).toThrow(/set and reset only/);
    expect(() => parseArgs(["tasks", "instructions", "t1", "erase"])).toThrow(/Unknown tasks instructions action/);
    expect(() => parseArgs(["tasks", "instructions", "t1", "set", "x".repeat(8_001)])).toThrow(/at most/);
    expect(() => parseArgs(["tasks", "instructions", "t".repeat(129)])).toThrow(/at most 128/);
    expect(() => parseArgs(["tasks", "instructions", "t1", "--workspace", "w".repeat(129)])).toThrow(/at most 128/);
    expect(() => parseArgs(["tasks", "instructions", "t1", "reset", "--revision", "99999999999999999999"])).toThrow(/whole number/);
  });
});

describe("tavi tasks instructions", () => {
  it("saves, shows, clears and lists a chat's instructions through the running owner", async () => {
    const { directory } = await owner();
    expect((await run(directory, "t1")).out).toBe("No instructions of its own.\n");
    expect(await run(directory, "t1", "set", "Answer in French.")).toMatchObject({
      code: EXIT.ok,
      out: "Saved revision 1; it applies from the chat's next turn.\n",
    });
    const shown = await run(directory, "t1", "show");
    expect(shown.out).toMatch(/^Revision 1 \(operator:cli, .+\):\nAnswer in French\.\n$/);
    // A write that expects an older revision is a usage conflict, and changes nothing.
    expect((await run(directory, "t1", "set", "Late", "--revision", "0")).code).toBe(EXIT.usage);
    expect((await run(directory, "t1", "reset")).out).toContain("Saved revision 2");
    expect((await run(directory, "t1", "show")).out).toBe("Cleared in revision 2.\n");
    const history = (await run(directory, "t1", "history")).out.trim().split("\n");
    expect(history.map((line) => line.split("\t")[0])).toEqual(["2", "1"]);
    expect(history[0]).toContain("(cleared)");
    expect((await run(directory, "nope")).code).toBe(EXIT.unavailable);
    // A write that cannot read the revision it would assert sends nothing.
    const missing = await run(directory, "nope", "set", "x");
    expect(missing.code).toBe(EXIT.unavailable);
    expect(missing.err).toContain("does not exist");
  });

  it("says an agent's task runs under its agent's instructions, naming its chat", async () => {
    const { directory, handle } = await owner();
    const repositories = handle.runtime.store.asPort().repositories;
    await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-w1",
      kind: "start",
      intent: { prompt: "work" },
      checkpointNamespace: "",
      newTaskId: "w1",
      newAdmissionId: "adm-w1",
      newThreadId: "thread-w1",
      now: nowTimestamp(),
    });
    await repositories.agentDelegations.recordSpawn({
      operationKey: "op-w1",
      workspaceId: "default",
      principalId: "operator",
      workerTaskId: "w1",
      workerAgentId: "agent-1",
      parentTaskId: "t1",
      rootTaskId: "t1",
      createdAt: nowTimestamp(),
      depth: 1,
    });
    expect((await run(directory, "w1")).out).toBe(
      "An agent's task: it runs under its agent's instructions, not those of its chat t1.\nNo instructions of its own.\n",
    );
  });

  it("does the same from the data directory when no owner runs", async () => {
    const { directory, handle } = await owner();
    await handle.shutdown("offline");
    handles.pop();
    expect(await run(directory, "t1", "set", "Be brief.")).toMatchObject({
      code: EXIT.ok,
      out: "Saved revision 1; it applies from the chat's next turn.\n",
    });
    expect((await run(directory, "t1")).out).toContain("Be brief.");
    expect((await run(directory, "nope", "set", "x")).code).toBe(EXIT.unavailable);
    const stale = await run(directory, "t1", "set", "Late", "--revision", "0");
    expect(stale.code).toBe(EXIT.usage);
    expect(stale.err).toContain("changed since they were read");
  });
});
