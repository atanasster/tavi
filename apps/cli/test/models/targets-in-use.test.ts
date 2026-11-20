import { describe, expect, it } from "vitest";

import { modelTargetsInUse, type TargetSources } from "../../src/features/models/targets-in-use.js";

const sources = (overrides: Partial<TargetSources> = {}): TargetSources => ({
  connections: async () => [
    { connectionId: "openai", defaultModel: "gpt-5" },
    { connectionId: "gemini", videoModels: ["gemini-2.5-pro"] },
  ],
  workspaceIds: () => ["default"],
  people: async () => ["owner", "guest"],
  workspaceDefault: async () => ({ connectionId: "openai", model: "gpt-5" }),
  roleBindings: async () => [
    {
      role: "fast",
      target: { connectionId: "openai", model: "gpt-5-mini" },
      fallback: [{ connectionId: "gemini", model: "gemini-2.5-pro" }],
    },
  ],
  activitySummaryModel: async () => ({ connectionId: "openai", model: "gpt-5-mini" }),
  heartbeatModel: async (scope) => (scope.principalId === "owner" ? { connectionId: "anthropic", model: "claude-sonnet-4-5" } : undefined),
  chosenTargets: async (scope) => (scope.principalId === "guest" ? [{ connectionId: "openai", model: "o3", chats: 2 }] : []),
  routineModels: async (scope) =>
    scope.principalId === "owner"
      ? {
          complete: true,
          routines: [
            {
              name: "Daily news",
              stages: {
                research: { primary: { connectionId: "openai", model: "gpt-5-mini" }, fallbacks: [] },
                synthesis: { primary: { connectionId: "openai", model: "gpt-5" }, fallbacks: [{ connectionId: "openai", model: "o3" }] },
              },
            },
          ],
        }
      : { complete: true, routines: [] },
  ...overrides,
});

describe("models in use", () => {
  it("lists every model referenced, each with every place that uses it", async () => {
    const { targets, unread } = await modelTargetsInUse(sources());
    expect(unread).toEqual([]);
    expect(targets).toEqual([
      { connectionId: "anthropic", model: "claude-sonnet-4-5", usedBy: [{ kind: "heartbeat", workspaceId: "default" }] },
      {
        connectionId: "gemini",
        model: "gemini-2.5-pro",
        usedBy: [{ kind: "video" }, { kind: "role-fallback", workspaceId: "default", detail: "fast" }],
      },
      {
        connectionId: "openai",
        model: "gpt-5",
        usedBy: [
          { kind: "connection-default" },
          { kind: "workspace-default", workspaceId: "default" },
          { kind: "routine", workspaceId: "default", detail: "Daily news (synthesis)" },
        ],
      },
      {
        connectionId: "openai",
        model: "gpt-5-mini",
        usedBy: [
          { kind: "role", workspaceId: "default", detail: "fast" },
          { kind: "activity-summary", workspaceId: "default" },
          { kind: "routine", workspaceId: "default", detail: "Daily news (research)" },
        ],
      },
      {
        connectionId: "openai",
        model: "o3",
        usedBy: [
          { kind: "routine-fallback", workspaceId: "default", detail: "Daily news (synthesis)" },
          { kind: "chat", workspaceId: "default", count: 2 },
        ],
      },
    ]);
  });

  it("keeps the other sources when one cannot be read, and says which", async () => {
    const { targets, unread } = await modelTargetsInUse(
      sources({
        roleBindings: async () => {
          throw new Error("database is locked");
        },
      }),
    );
    expect(unread).toEqual(["default model roles: database is locked"]);
    expect(targets.some((target) => target.model === "gpt-5")).toBe(true);
    expect(targets.flatMap((target) => target.usedBy).some((use) => use.kind === "role")).toBe(false);
  });

  it("says so when a person has more routines than one list returns", async () => {
    const { unread } = await modelTargetsInUse(sources({ routineModels: async () => ({ complete: false, routines: [] }) }));
    expect(unread).toEqual([
      "default routines of owner: only the first 0 were read",
      "default routines of guest: only the first 0 were read",
    ]);
  });
});
