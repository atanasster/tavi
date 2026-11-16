import type { ModelRoleBinding, ModelTarget } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { utilityTarget, visionTarget, type BrowserModelConfig } from "../../src/features/browser/models.js";

const started: ModelTarget = { connectionId: "started", model: "started-model" };
const target = (model: string): ModelTarget => ({ connectionId: "c", model });
const binding = (role: ModelRoleBinding["role"], model: string, fallback: readonly string[] = []): ModelRoleBinding =>
  ({ workspaceId: "w", role, target: target(model), fallback: fallback.map(target) }) as ModelRoleBinding;

function config(bindings: readonly ModelRoleBinding[], fallback?: string): BrowserModelConfig {
  return {
    listRoleBindings: async () => bindings,
    getWorkspaceDefault: async () => (fallback === undefined ? undefined : ({ workspaceId: "w", target: target(fallback) } as never)),
  };
}

describe("utilityTarget", () => {
  it("prefers the extraction role, then fast, then main", async () => {
    expect(
      await utilityTarget(config([binding("main", "big"), binding("fast", "flash"), binding("extraction", "reader")]), "w", started),
    ).toEqual(target("reader"));
    expect(await utilityTarget(config([binding("main", "big"), binding("fast", "flash")]), "w", started)).toEqual(target("flash"));
    expect(await utilityTarget(config([binding("main", "big")]), "w", started)).toEqual(target("big"));
  });

  it("falls to the workspace default, then the target the process started with", async () => {
    expect(await utilityTarget(config([binding("compaction", "small")], "default"), "w", started)).toEqual(target("default"));
    expect(await utilityTarget(config([]), "w", started)).toEqual(started);
  });
});

describe("visionTarget", () => {
  const readsImages = (candidate: ModelTarget): boolean => candidate.model.startsWith("seeing");

  it("takes main when it reads images", async () => {
    expect(await visionTarget(config([binding("fast", "seeing-small"), binding("main", "seeing-big")]), "w", started, readsImages)).toEqual(
      target("seeing-big"),
    );
  });

  it("passes over a main that reads text only for its fallback, the default, then another role", async () => {
    expect(await visionTarget(config([binding("main", "text", ["seeing-fallback"])], "seeing-default"), "w", started, readsImages)).toEqual(
      target("seeing-fallback"),
    );
    expect(await visionTarget(config([binding("main", "text")], "seeing-default"), "w", started, readsImages)).toEqual(
      target("seeing-default"),
    );
    expect(
      await visionTarget(
        config([binding("main", "text"), binding("embedding", "seeing-vectors"), binding("fast", "seeing-flash")]),
        "w",
        started,
        readsImages,
      ),
    ).toEqual(target("seeing-flash"));
  });

  it("returns main when nothing reads images, so the tool names it in its refusal", async () => {
    expect(await visionTarget(config([binding("main", "text")], "plain"), "w", started, readsImages)).toEqual(target("text"));
    expect(await visionTarget(config([binding("fast", "text-flash")]), "w", started, readsImages)).toEqual(target("text-flash"));
    expect(await visionTarget(config([]), "w", started, readsImages)).toEqual(started);
  });
});

describe("a workspace that configures no model of its own", () => {
  /** Each workspace's own bindings and default; one not listed configures none. */
  function workspaces(
    byWorkspace: Readonly<Record<string, { readonly bindings?: readonly ModelRoleBinding[]; readonly fallback?: string }>>,
  ): BrowserModelConfig {
    return {
      listRoleBindings: async (workspaceId) => byWorkspace[workspaceId]?.bindings ?? [],
      getWorkspaceDefault: async (workspaceId) => {
        const fallback = byWorkspace[workspaceId]?.fallback;
        return fallback === undefined ? undefined : ({ workspaceId, target: target(fallback) } as never);
      },
    };
  }
  const readsImages = (candidate: ModelTarget): boolean => candidate.model.startsWith("seeing");

  it("reads pages on the default workspace's model, as resolveRunTarget runs it, before the target the owner started with", async () => {
    expect(await utilityTarget(workspaces({ default: { fallback: "first" } }), "w", started)).toEqual(target("first"));
    expect(await utilityTarget(workspaces({ default: { bindings: [binding("fast", "flash")], fallback: "first" } }), "w", started)).toEqual(
      target("flash"),
    );
    // Its own configuration still wins.
    expect(await utilityTarget(workspaces({ default: { fallback: "first" }, w: { fallback: "own" } }), "w", started)).toEqual(
      target("own"),
    );
    expect(await utilityTarget(workspaces({}), "w", started)).toEqual(started);
  });

  it("acts by sight on the default workspace's main and default, keeping its own other roles as candidates", async () => {
    expect(await visionTarget(workspaces({ default: { bindings: [binding("main", "seeing-main")] } }), "w", started, readsImages)).toEqual(
      target("seeing-main"),
    );
    expect(await visionTarget(workspaces({ default: { fallback: "seeing-default" } }), "w", started, readsImages)).toEqual(
      target("seeing-default"),
    );
    expect(
      await visionTarget(
        workspaces({ default: { fallback: "text" }, w: { bindings: [binding("fast", "seeing-flash")] } }),
        "w",
        started,
        readsImages,
      ),
    ).toEqual(target("seeing-flash"));
    // A `main` of its own: nothing is inherited.
    expect(
      await visionTarget(
        workspaces({ default: { fallback: "seeing-default" }, w: { bindings: [binding("main", "text")] } }),
        "w",
        started,
        readsImages,
      ),
    ).toEqual(target("text"));
    expect(await visionTarget(workspaces({}), "w", started, readsImages)).toEqual(started);
  });
});

describe("a chat on a local connection", () => {
  const on = (connectionId: string, model: string): ModelTarget => ({ connectionId, model });
  const bound = (role: ModelRoleBinding["role"], bindingTarget: ModelTarget, fallback: readonly ModelTarget[] = []): ModelRoleBinding =>
    ({ workspaceId: "w", role, target: bindingTarget, fallback }) as ModelRoleBinding;
  const locality = async (connectionId: string) => (connectionId.startsWith("ollama") ? ("local" as const) : ("remote" as const));
  const readsImages = (candidate: ModelTarget): boolean => candidate.model.startsWith("seeing");

  it("reads pages only with a local model, passing over remote roles", async () => {
    const roles = config([
      bound("extraction", on("cloud", "reader")),
      bound("fast", on("cloud", "flash"), [on("ollama", "small")]),
      bound("main", on("ollama", "big")),
    ]);
    expect(await utilityTarget(roles, "w", started, locality)).toEqual(on("ollama", "small"));
    // A chat on a remote model keeps the extraction role.
    expect(await utilityTarget(roles, "w", started)).toEqual(on("cloud", "reader"));
  });

  it("refuses to read pages, naming the role, when only remote models are bound", async () => {
    await expect(
      utilityTarget(config([bound("extraction", on("cloud", "reader")), bound("main", on("cloud", "big"))]), "w", started, locality),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED", message: expect.stringContaining("`extraction` role") });
  });

  it("acts by sight only with a local model, and refuses when every one is remote", async () => {
    const roles = config([bound("main", on("cloud", "seeing-big")), bound("fast", on("ollama", "seeing-local"))]);
    expect(await visionTarget(roles, "w", started, readsImages, locality)).toEqual(on("ollama", "seeing-local"));
    expect(await visionTarget(roles, "w", started, readsImages)).toEqual(on("cloud", "seeing-big"));
    await expect(
      visionTarget(config([bound("main", on("cloud", "seeing-big"))]), "w", started, readsImages, locality),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED", message: expect.stringContaining("reads images to the `main` role") });
  });
});
