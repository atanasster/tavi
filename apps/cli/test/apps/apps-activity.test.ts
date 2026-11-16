import type {
  ApprovalHistoryInput,
  ApprovalsHistoryResult,
  ConnectableApp,
  EffectActivity,
  EffectActivityQuery,
  ToolCallActivity,
  ToolCallActivityQuery,
} from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { ACTIVITY_PAGE, appActivity, type AppsActivitySources } from "../../src/features/apps/activity.js";

/** An app's Recent activity: effects, approvals and reads merged by time, paged. */

const T0 = Date.parse("2026-10-16T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const app = (pluginIds: readonly string[]): ConnectableApp => ({
  appId: "google-calendar",
  name: "Google Calendar",
  summary: "",
  category: "calendar",
  source: { kind: "mcp", pluginIds: [...pluginIds], verified: "tavi-preset", isolation: "remote" },
  auth: { kind: "none" },
  tools: [
    {
      toolId: "mcp.gcal.create_event",
      title: "Create an event",
      access: "send",
      effect: "external",
      sink: "network",
      state: "offered",
      decision: "ask",
      because: [],
      canSetHere: ["ask", "block"],
    },
    ...pluginIds.map((pluginId) => ({
      toolId: `${pluginId}.list_events`,
      title: "List events",
      access: "read" as const,
      effect: "read-only" as const,
      sink: "none" as const,
      state: "offered" as const,
      decision: "allow" as const,
      because: [],
      canSetHere: ["ask" as const, "block" as const],
    })),
  ],
  egress: { hosts: [], lan: false, anyNetwork: false },
  credentials: [],
  settings: [],
  trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
  accounts: [],
  health: "ready",
  repairs: [],
  warnings: [],
});

/** Sources over fixed rows, filtered and ordered as the repositories are. */
function sources(
  effects: readonly EffectActivity[],
  approvals: readonly { readonly id: string; readonly toolId: string; readonly at: string }[],
  calls: readonly ToolCallActivity[] = [],
) {
  const asked: { effects: EffectActivityQuery[]; approvals: ApprovalHistoryInput[]; calls: ToolCallActivityQuery[] } = {
    effects: [],
    approvals: [],
    calls: [],
  };
  const within = (toolId: string, prefixes: readonly string[]) => prefixes.some((prefix) => toolId.startsWith(prefix));
  const answer: AppsActivitySources = {
    effects: async (query) => {
      asked.effects.push(query);
      return [...effects]
        .filter(
          (row) =>
            within(row.toolId, query.prefixes) &&
            (query.before === undefined ||
              row.createdAt < query.before.at ||
              (row.createdAt === query.before.at && row.effectKey < query.before.effectKey)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.effectKey.localeCompare(a.effectKey))
        .slice(0, query.limit);
    },
    approvals: async (input): Promise<ApprovalsHistoryResult> => {
      asked.approvals.push(input);
      const rows = [...approvals]
        .filter((row) => within(row.toolId, input.toolPrefixes ?? []) && (input.until === undefined || row.at <= input.until))
        .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      return {
        items: rows.slice(0, input.limit).map((row) => ({
          kind: "approval",
          approvalId: row.id,
          taskId: "t1",
          taskTitle: "Plan the week",
          principalId: "operator",
          toolId: row.toolId,
          state: "granted",
          decidedBy: "operator",
          decidedAt: row.at,
          note: null,
        })),
        ...(rows.length > input.limit ? { nextCursor: "more" } : {}),
      };
    },
    calls: async (query) => {
      asked.calls.push(query);
      return [...calls]
        .filter(
          (row) =>
            query.toolIds.includes(row.toolId) &&
            (query.before === undefined || row.at < query.before.at || (row.at === query.before.at && row.callKey < query.before.callKey)),
        )
        .sort((a, b) => b.at.localeCompare(a.at) || b.callKey.localeCompare(a.callKey))
        .slice(0, query.limit);
    },
  };
  return { answer, asked };
}

const effect = (key: string, toolId: string, minutes: number): EffectActivity => ({
  effectKey: key,
  taskId: "t1",
  taskTitle: "Plan the week",
  toolId,
  state: "accepted",
  createdAt: at(minutes),
});

describe("an app's Recent activity", () => {
  it("merges what its tools did and what you were asked, newest first, each with its tool's title and account", async () => {
    const { answer, asked } = sources(
      [effect("e1", "mcp.gcal.create_event", 1), effect("e2", "mcp.gcal2.delete_event", 3)],
      [{ id: "a1", toolId: "mcp.gcal.create_event", at: at(2) }],
    );
    const activity = await appActivity(answer, app(["mcp.gcal", "mcp.gcal2"]), { workspaceId: "default" });
    expect(activity.rows.map((row) => [row.kind, row.id, row.accountId, row.at])).toEqual([
      ["effect", "e2", "mcp.gcal2", at(3)],
      ["approval", "a1", "mcp.gcal", at(2)],
      ["effect", "e1", "mcp.gcal", at(1)],
    ]);
    expect(activity.rows[2]?.title).toBe("Create an event · Plan the week");
    expect(activity.rows[0]?.title).toBe("mcp.gcal2.delete_event · Plan the week");
    expect(activity).toMatchObject({ readsListed: true });
    expect(activity.cursor).toBeUndefined();
    expect(asked.effects[0]?.prefixes).toEqual(["mcp.gcal.", "mcp.gcal2."]);
    expect(asked.approvals[0]).toMatchObject({ workspaceId: "default", kinds: ["approval"], toolPrefixes: ["mcp.gcal.", "mcp.gcal2."] });
  });

  it("pages through both sources without losing or repeating a row", async () => {
    const effects = Array.from({ length: 70 }, (_, index) =>
      effect(`e${String(index).padStart(3, "0")}`, "mcp.gcal.create_event", index * 2),
    );
    const approvals = Array.from({ length: 40 }, (_, index) => ({
      id: `a${String(index).padStart(3, "0")}`,
      toolId: "mcp.gcal.create_event",
      at: at(index * 2 + 1),
    }));
    const { answer } = sources(effects, approvals);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const activity = await appActivity(answer, app(["mcp.gcal"]), {
        workspaceId: "default",
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(activity.rows.length).toBeLessThanOrEqual(ACTIVITY_PAGE);
      seen.push(...activity.rows.map((row) => `${row.kind}:${row.at}`));
      cursor = activity.cursor;
      if (cursor === undefined) break;
    }
    expect(seen).toHaveLength(110);
    expect(new Set(seen).size).toBe(110);
    expect([...seen].sort((a, b) => b.slice(b.indexOf(":") + 1).localeCompare(a.slice(a.indexOf(":") + 1)))).toEqual(seen);
  });

  it("narrows to one account, and refuses an account or a cursor it does not know", async () => {
    const { answer } = sources([effect("e1", "mcp.gcal.create_event", 1), effect("e2", "mcp.gcal2.create_event", 2)], []);
    expect(
      (await appActivity(answer, app(["mcp.gcal", "mcp.gcal2"]), { workspaceId: "default", accountId: "mcp.gcal2" })).rows.map(
        (row) => row.accountId,
      ),
    ).toEqual(["mcp.gcal2"]);
    await expect(appActivity(answer, app(["mcp.gcal"]), { workspaceId: "default", accountId: "mcp.other" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(appActivity(answer, app(["mcp.gcal"]), { workspaceId: "default", cursor: "not-ours" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await appActivity(answer, app([]), { workspaceId: "default" })).toEqual({ rows: [], readsListed: true });
  });

  it("lists what its read-only tools read, in time with the rest, and only those tools' calls", async () => {
    const call = (key: string, toolId: string, minutes: number): ToolCallActivity => ({
      callKey: key,
      taskId: "t1",
      taskTitle: "Plan the week",
      toolId,
      at: at(minutes),
    });
    const { answer, asked } = sources(
      [effect("e1", "mcp.gcal.create_event", 1)],
      [],
      [call("t1:1:c1", "mcp.gcal.list_events", 2), call("t1:1:c2", "mcp.gcal.create_event", 3)],
    );
    const activity = await appActivity(answer, app(["mcp.gcal"]), { workspaceId: "default" });
    expect(activity.rows.map((row) => [row.kind, row.id, row.state, row.title])).toEqual([
      ["read", "t1:1:c1", "called", "List events · Plan the week"],
      ["effect", "e1", "accepted", "Create an event · Plan the week"],
    ]);
    // Asked only for its read-only tools, so a write is never listed twice.
    expect(asked.calls[0]?.toolIds).toEqual(["mcp.gcal.list_events"]);
  });

  it("pages through reads alone without repeating one", async () => {
    const calls = Array.from(
      { length: 120 },
      (_, index): ToolCallActivity => ({
        callKey: `t1:${String(index).padStart(3, "0")}:c`,
        taskId: "t1",
        toolId: "mcp.gcal.list_events",
        at: at(index),
      }),
    );
    const { answer } = sources([], [], calls);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const activity = await appActivity(answer, app(["mcp.gcal"]), {
        workspaceId: "default",
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...activity.rows.map((row) => row.id));
      cursor = activity.cursor;
      if (cursor === undefined) break;
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });
});
