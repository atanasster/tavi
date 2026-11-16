import { CENTER_APPS_LIMIT, CenterSummaryAnswerSchema } from "@tavi/contracts";
import { MemoryService } from "@tavi/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { centerCommand } from "../../src/server/center.js";
import { SqliteStore } from "../support/database-fixture.js";

/** The Center summary's Connected apps repairs. */

const stores: SqliteStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
});

async function summary(appRepairs?: Parameters<typeof centerCommand>[0]["appRepairs"]) {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const answer = await centerCommand(
    {
      repositories: store.asPort().repositories,
      memory: new MemoryService(store.asPort()),
      principalOf: () => "operator",
      now: () => new Date("2026-10-16T09:00:00.000Z"),
      ...(appRepairs === undefined ? {} : { appRepairs }),
    },
    { action: "summary" },
  );
  if (!answer.ok) throw new Error(answer.error.message);
  return CenterSummaryAnswerSchema.parse(answer.result);
}

const repair = (index: number) => ({
  kind: "sign-in" as const,
  accountId: `mcp.app${String(index)}`,
  title: `Sign in to App ${String(index)} again`,
  detail: "Its sign-in expired.",
  cli: `tavi mcp login mcp.app${String(index)}`,
  appId: `app-${String(index)}`,
  appName: `App ${String(index)}`,
});

describe("the Center summary's apps", () => {
  it("lists the owner's app repairs, at most its limit, and none when the owner cannot read its apps", async () => {
    expect((await summary(async () => [repair(1)])).apps).toEqual([repair(1)]);
    expect((await summary(async () => Array.from({ length: CENTER_APPS_LIMIT + 5 }, (_, index) => repair(index)))).apps).toHaveLength(
      CENTER_APPS_LIMIT,
    );
    expect((await summary(async () => undefined)).apps).toBeUndefined();
    expect((await summary()).apps).toBeUndefined();
  });
});
