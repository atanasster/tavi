import { describe, expect, it } from "vitest";

import { taskListText } from "../../src/features/tasks/client.js";

/** `tavi tasks` at a terminal: a line a task, and counts of what waits, never the JSON document. */
describe("tavi tasks as text", () => {
  it("lists each task on a line, its title said once, and counts what waits with the commands that show it", () => {
    const text = taskListText({
      tasks: [
        { taskId: "task-2", status: "waiting", updatedAt: "2026-11-16T09:30:12.000Z", title: "Count the vowels\nin a word" },
        { taskId: "task-1", status: "completed", updatedAt: "2026-11-15T08:00:00.000Z", title: null, summary: null, finalText: "Done." },
      ],
      pendingApprovals: [{}],
      unresolvedEffects: [{}, {}],
      pendingDeliveries: [],
      expiredLeases: [],
      cancellations: [],
    });
    expect(text.split("\n")).toEqual([
      "waiting    2026-11-16 09:30  task-2  Count the vowels in a word",
      "completed  2026-11-15 08:00  task-1  Done.",
      "",
      "Also: 1 pending approval, 2 effects of unknown outcome.",
      "",
      "One task in full: tavi tasks <task-id>. Everything as JSON: tavi tasks --format json.",
      "",
    ]);
    expect(text).not.toContain("{");
  });

  it("says there are none", () => {
    expect(taskListText({ tasks: [] })).toMatch(/^No tasks yet\.\n\nOne task in full/);
  });
});
