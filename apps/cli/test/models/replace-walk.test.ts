import { HEARTBEAT_PRODUCTION_OPTIONS, defaultHeartbeatConfig, type ModelTarget } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { previewReplace, replaceModel, type ReplaceRuntime } from "../../src/features/models/replace.js";

/**
 * The replace walk on a runtime of plain objects: each place a model is kept,
 * moved or left with its reason, and the preview the same walk writing nothing.
 */

const OLD: ModelTarget = { connectionId: "openai", model: "gpt-5" };
const NEW: ModelTarget = { connectionId: "openai", model: "gpt-6.2-sol" };
const HASH = "a".repeat(64);

function runtime(options: { readonly catalog?: readonly string[]; readonly chatsFail?: boolean } = {}) {
  const writes: { what: string; value: unknown }[] = [];
  const routine = (routineId: string, name: string, status: string) => ({
    routine: { routineId, name, status, latestRevision: 4 },
    revision: {
      snapshot: {
        objective: "x",
        models: {
          research: { primary: { ...OLD, bindingHash: HASH }, fallbacks: [NEW] },
          synthesis: { primary: { connectionId: "other", model: "m" }, fallbacks: [OLD] },
        },
      },
    },
  });
  const routines = [routine("r1", "digest", "active"), routine("r2", "old digest", "archived")];
  const fake = {
    clock: { now: () => Date.parse("2026-11-20T08:00:00.000Z") },
    heartbeat: { options: HEARTBEAT_PRODUCTION_OPTIONS },
    access: {
      workspaceIds: () => ["default", "elsewhere"],
      resolveWorkspace: () => ({ principalId: "operator" }),
      peopleOf: () => ["bob"],
    },
    store: {
      services: {
        modelConfig: {
          listConnections: async () => [
            {
              connectionId: "openai",
              label: "OpenAI",
              kind: "openai-compatible",
              baseUrl: "https://api.openai.com/v1",
              credentialRef: "k",
              defaultModel: "gpt-5",
              videoModels: ["gpt-5"],
            },
          ],
          listCatalog: async () => (options.catalog ?? ["gpt-5", "gpt-6.2-sol"]).map((modelId) => ({ modelId, state: "available" })),
          putConnection: async (value: unknown) => void writes.push({ what: "connection", value }),
          setWorkspaceDefault: async (value: unknown) => void writes.push({ what: "default", value }),
          listRoleBindings: async (workspaceId: string) =>
            workspaceId === "default"
              ? [
                  { role: "main", target: OLD, fallback: [] },
                  { role: "fast", target: NEW, fallback: [OLD] },
                ]
              : [],
          setRoleBinding: async (value: unknown) => void writes.push({ what: "role", value }),
        },
      },
      asPort: () => ({
        repositories: {
          modelConfig: { getWorkspaceDefault: async () => ({ target: OLD }) },
          workspaceSettings: {
            get: async () => ({ revision: 3, settings: { timezone: "UTC", activitySummaryModel: OLD } }),
            set: async (value: unknown) => void writes.push({ what: "settings", value }),
          },
          heartbeats: {
            get: async (_workspaceId: string, principalId: string) =>
              principalId === "bob" ? { config: { ...defaultHeartbeatConfig(), model: OLD, revision: 7 } } : undefined,
            save: async (value: unknown) => {
              writes.push({ what: "heartbeat", value });
              return value;
            },
          },
        },
      }),
    },
    routerRepository: {
      chosenTargets: async ({ principalId }: { principalId: string }) => (principalId === "operator" ? [{ ...OLD, chats: 2 }] : []),
      retargetChosen: async () => {
        if (options.chatsFail === true) throw new Error("database is locked");
        writes.push({ what: "chats", value: 2 });
        return 2;
      },
    },
    routines: {
      owners: async () => [],
      list: async ({ principalId }: { principalId: string }) => (principalId === "operator" ? routines.map((entry) => entry.routine) : []),
      get: async (_scope: unknown, routineId: string) => routines.find((entry) => entry.routine.routineId === routineId),
      update: async (...args: unknown[]) => void writes.push({ what: "routine", value: args }),
    },
  };
  return { runtime: fake as unknown as ReplaceRuntime, writes };
}

describe("the replace walk", () => {
  it("previews every place in the workspace, writing nothing, as the change then moves it", async () => {
    const preview = runtime();
    const listed = await previewReplace(preview.runtime, OLD, NEW, "default");
    expect(preview.writes).toEqual([]);
    expect(listed.usedBy.map((use) => use.kind)).toEqual([
      "connection-default",
      "workspace-default",
      "role",
      "role-fallback",
      "activity-summary",
      "chat",
      "routine",
      "heartbeat",
      "video",
      "routine",
    ]);

    const change = runtime();
    const result = await replaceModel(change.runtime, OLD, NEW, "default");
    expect(result.changed.map((use) => use.kind)).toEqual(listed.usedBy.slice(0, 8).map((use) => use.kind));
    // Video asks its own disclosure; an archived routine cannot be edited.
    expect(result.skipped.map((entry) => entry.use.kind)).toEqual(["video", "routine"]);
    expect(result.failed).toEqual([]);
    expect(result.notes[0]).toContain("once that revision's quality check passes");
  });

  it("keeps a chain free of repeats, a routine's binding on its connection, and names the operator as the author", async () => {
    const { runtime: fake, writes } = runtime();
    await replaceModel(fake, OLD, NEW, "default");
    const roles = writes.filter((write) => write.what === "role").map((write) => write.value);
    expect(roles).toEqual([
      { workspaceId: "default", role: "main", target: NEW, fallback: [] },
      { workspaceId: "default", role: "fast", target: NEW, fallback: [] },
    ]);
    const [scope, input, provenance, author] = writes.find((write) => write.what === "routine")?.value as [
      unknown,
      { expectedRevision: number; snapshot: { models: Record<string, unknown> } },
      unknown,
      string,
    ];
    expect(scope).toEqual({ workspaceId: "default", principalId: "operator" });
    expect(input.expectedRevision).toBe(4);
    expect(input.snapshot.models).toEqual({
      research: { primary: { ...NEW, bindingHash: HASH }, fallbacks: [] },
      synthesis: { primary: { connectionId: "other", model: "m" }, fallbacks: [NEW] },
    });
    expect(provenance).toBeUndefined();
    expect(author).toBe("operator");
    // The heartbeat is saved against the revision read: a change since is a conflict.
    expect(writes.find((write) => write.what === "heartbeat")?.value).toMatchObject({ expectedRevision: 7, config: { model: NEW } });
  });

  it("names a place that fails and moves the rest", async () => {
    const { runtime: fake, writes } = runtime({ chatsFail: true });
    const result = await replaceModel(fake, OLD, NEW, "default");
    expect(result.failed).toEqual([{ use: { kind: "chat", workspaceId: "default", count: 2 }, error: "database is locked" }]);
    expect(writes.some((write) => write.what === "routine")).toBe(true);
  });

  it("refuses a model its connection's catalog does not list", async () => {
    await expect(previewReplace(runtime({ catalog: ["gpt-5"] }).runtime, OLD, NEW, "default")).rejects.toThrow(
      "openai does not list gpt-6.2-sol",
    );
  });
});
