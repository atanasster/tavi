import { describe, expect, it } from "vitest";
import { APPROVAL_HISTORY_KINDS, DECIDED_NEED_KINDS, NEED_KINDS, TASK_NEEDS, TaskNeedSchema } from "../src/index.js";

describe("need kinds", () => {
  it("names every kind once, and the decided lists are that subset", () => {
    expect(TASK_NEEDS).toEqual(["approval", "review", "question", "handoff", "connect"]);
    expect(NEED_KINDS).toBe(DECIDED_NEED_KINDS);
    expect(APPROVAL_HISTORY_KINDS).toBe(DECIDED_NEED_KINDS);
    for (const kind of DECIDED_NEED_KINDS) expect(TaskNeedSchema.safeParse(kind).success).toBe(true);
    expect(DECIDED_NEED_KINDS).not.toContain("handoff");
    // A connect need is decided by connecting or *Not now*.
    expect(DECIDED_NEED_KINDS).toContain("connect");
  });
});
