import type { ModelRequest } from "@tavi/contracts";
import { ModelAccounting } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, expect, it, vi } from "vitest";

import type { TaviRuntime } from "../../src/runtime/types.js";
import { compose, ROUTED, run, scope, seed } from "./router-fixtures.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

it("routes tools, memory, skills and the model together under default call limits", async () => {
  const directory = directories.create("tavi-router-combined-");
  const store = await seed(directory);
  const accounting = new ModelAccounting(store.asPort());
  const requests: ModelRequest[] = [];
  const routerFetch = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const answers =
      body.questions.selection === undefined
        ? Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.99 }]))
        : { selection: { type: "choice", choice: "fast", probabilities: { main: 0.01, fast: 0.99 } } };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 100, output_tokens: 0 } }));
  });
  let runtime: TaviRuntime | undefined;
  try {
    runtime = await compose(directory, store, routerFetch, requests);
    await runtime.routerRepository.configure(scope, ROUTED, 0);
    const result = await run(runtime, "combined");
    expect(result?.outcome.status).toBe("completed");
    expect(routerFetch).toHaveBeenCalledTimes(2);
    const taskId = result?.taskId ?? "missing";
    const receipts = await runtime.routerRepository.receipts(scope, taskId);
    for (const feature of ["tools", "memory", "skills", "model"])
      expect(
        receipts.some((receipt) => receipt.feature === feature && receipt.selectedIds.length > 0 && receipt.batchedFeatures === undefined),
      ).toBe(true);
    expect(requests[0]?.connectionId).toBe("fast");
    expect(JSON.stringify(requests[0]?.messages)).toContain("- wombat project uses TypeScript (memory ");
    expect(
      (await runtime.routerRepository.contextProjections(scope, taskId))[0]?.recommendedSkills?.map((skill) => skill.skillId),
    ).toContain("wombat");
    expect((await accounting.list(taskId)).filter((attempt) => attempt.purpose === "router")).toHaveLength(2);
  } finally {
    if (runtime !== undefined) await runtime.close();
    else store.close();
  }
});
