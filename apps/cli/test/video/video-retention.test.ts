import type { WorkspaceSettings } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { sweepVideoRetention } from "../../src/features/video/retention.js";

/** The owner's video retention sweep: each workspace's own days, one failure never skipping the rest. */

describe("the video retention sweep", () => {
  it("prunes each workspace's videos past its own keepDays, and goes on past a workspace that fails", async () => {
    const pruned: { workspaceId: string; olderThan: string }[] = [];
    const errors: unknown[] = [];
    const logged: unknown[] = [];
    const settings: Record<string, WorkspaceSettings> = { a: {}, b: { videoKeepDays: 7 } };
    await sweepVideoRetention({
      workspaceIds: ["a", "broken", "b"],
      settingsOf: async (workspaceId) => {
        if (workspaceId === "broken") throw new Error("no settings");
        return settings[workspaceId] ?? {};
      },
      pruneVideo: async (input) => {
        pruned.push(input);
        // Only what was pruned is logged.
        return input.workspaceId === "a" ? { artifacts: 1, bytes: 10 } : { artifacts: 0, bytes: 0 };
      },
      now: () => "2026-10-31T00:00:00.000Z",
      log: {
        info: (_message, fields) => void logged.push(fields["workspaceId"]),
        error: (_message, fields) => void errors.push(fields["workspaceId"]),
      },
    });
    // 30 days by default; the workspace's own 7 days where it set them.
    expect(pruned).toEqual([
      { workspaceId: "a", olderThan: "2026-10-01T00:00:00.000Z" },
      { workspaceId: "b", olderThan: "2026-10-24T00:00:00.000Z" },
    ]);
    expect(errors).toEqual(["broken"]);
    expect(logged).toEqual(["a"]);
  });
});
