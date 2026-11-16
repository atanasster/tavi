import { createFixtureModel } from "@tavi/test-support/fakes";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/** The workflow an owner composes keeps `openHome`: a wrapper that drops it leaves a schedule's result nowhere to go. */
it("opens a Home with no turn through the composed workflow, and a first message is its first turn", async () => {
  const model = createFixtureModel({ turns: [{ text: "hello" }] });
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directories.create("tavi-open-home-"), {}), { modelOverride: model });
  try {
    const home = { workspaceId: "default", principalId: "operator" };
    const taskId = await runtime.workflow?.openHome?.(home);
    expect(taskId).toBeDefined();
    const tasks = runtime.store.asPort().repositories.tasks;
    expect(await tasks.homeOf(home.workspaceId, home.principalId)).toBe(taskId);
    const first = await runtime.workflow?.admit({
      context: { ...home, runId: taskId ?? "", caller: "test" },
      operationKey: "home-1",
      kind: "reply",
      ...(taskId === undefined ? {} : { taskId }),
      prompt: "hi",
    });
    expect([first?.taskId, first?.outcome.status, first?.outcome.finalText]).toEqual([taskId, "completed", "hello"]);
  } finally {
    await runtime.close();
  }
});
