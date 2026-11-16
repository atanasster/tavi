import { ModelConfigService } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import { resolveRunTarget, type RunTarget } from "../../src/features/models/target.js";

const chainOf = (resolved: RunTarget | undefined) =>
  resolved === undefined ? [] : [resolved.target, ...resolved.fallback.map((entry) => entry.target)];

/** The target a run resolves: one resolution for `tavi run`, `tavi serve` and a simulated restart. */

const stores: SqliteStore[] = [];
afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

let lastStore: SqliteStore | undefined;
async function configured(): Promise<ModelConfigService> {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  lastStore = store;
  stores.push(store);
  const service = new ModelConfigService(store.asPort());
  for (const connectionId of ["primary", "backup", "spare"]) {
    await service.putConnection({
      connectionId,
      label: connectionId,
      baseUrl: `http://127.0.0.1:1/${connectionId}/v1`,
      credentialRef: `${connectionId}.key`,
      localOnly: true,
      defaultModel: `${connectionId}-default`,
    });
  }
  return service;
}

describe("resolveRunTarget", () => {
  it("resolves nothing when nothing is configured, and runs exactly what both flags name", async () => {
    const service = await configured();
    expect(await resolveRunTarget(service, { workspaceId: "default" })).toBeUndefined();
    expect(await resolveRunTarget(service, { workspaceId: "default", connectionId: "elsewhere", model: "m" })).toEqual({
      source: "flags",
      target: { connectionId: "elsewhere", model: "m" },
      fallback: [],
      skipped: [],
    });
  });

  it("prefers role main's binding and its fallback to the workspace default", async () => {
    const service = await configured();
    await service.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "spare", model: "s" } });
    expect(await resolveRunTarget(service, { workspaceId: "default" })).toMatchObject({
      source: "default",
      target: { connectionId: "spare", model: "s" },
      fallback: [],
    });
    await service.setRoleBinding({
      workspaceId: "default",
      role: "main",
      target: { connectionId: "primary", model: "p" },
      fallback: [{ connectionId: "backup", model: "b" }],
    });
    const resolved = await resolveRunTarget(service, { workspaceId: "default" });
    expect(resolved).toMatchObject({ source: "role", target: { connectionId: "primary", model: "p" } });
    expect(chainOf(resolved)).toEqual([
      { connectionId: "primary", model: "p" },
      { connectionId: "backup", model: "b" },
    ]);
    expect((await resolved)?.fallback[0]?.connection.baseUrl).toBe("http://127.0.0.1:1/backup/v1");
    // Another role is no run's.
    await service.setRoleBinding({ workspaceId: "default", role: "fast", target: { connectionId: "spare", model: "f" } });
    expect((await resolveRunTarget(service, { workspaceId: "default" }))?.target).toEqual({ connectionId: "primary", model: "p" });
  });

  it("passes over a fallback the catalog marks unavailable, as it would a primary, and says so", async () => {
    const service = await configured();
    await service.setRoleBinding({
      workspaceId: "default",
      role: "main",
      target: { connectionId: "primary", model: "p" },
      fallback: [
        { connectionId: "backup", model: "b" },
        { connectionId: "spare", model: "s" },
      ],
    });
    await service.replaceCatalog("backup", [{ modelId: "b", provenance: "manual", state: "unavailable" }]);
    const resolved = await resolveRunTarget(service, { workspaceId: "default" });
    // A failover from primary goes straight to spare, never to a model the catalog refused.
    expect(chainOf(resolved)).toEqual([
      { connectionId: "primary", model: "p" },
      { connectionId: "spare", model: "s" },
    ]);
    expect((await resolved)?.skipped).toEqual([{ target: { connectionId: "backup", model: "b" }, reason: "unavailable-model" }]);

    // A fallback whose connection is gone — a store edited underneath — is passed over and said, too.
    await lastStore?.asPort().repositories.modelConfig.deleteConnection("spare");
    const without = await resolveRunTarget(service, { workspaceId: "default" });
    expect(chainOf(without)).toEqual([{ connectionId: "primary", model: "p" }]);
    expect((await without)?.skipped).toContainEqual({ target: { connectionId: "spare", model: "s" }, reason: "missing-connection" });
  });

  it("resolves in the default workspace for a workspace that configures neither, and in its own when it does", async () => {
    const service = await configured();
    await service.setRoleBinding({ workspaceId: "default", role: "main", target: { connectionId: "primary", model: "p" } });
    expect(await resolveRunTarget(service, { workspaceId: "team" })).toMatchObject({ source: "role", target: { connectionId: "primary" } });
    // `--connection` alone in another workspace inherits the default workspace's model on that connection.
    await service.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "backup", model: "inherited" } });
    expect((await resolveRunTarget(service, { workspaceId: "team", connectionId: "backup" }))?.target).toEqual({
      connectionId: "backup",
      model: "inherited",
    });
    await service.setWorkspaceDefault({ workspaceId: "team", target: { connectionId: "spare", model: "t" } });
    expect(await resolveRunTarget(service, { workspaceId: "team" })).toMatchObject({
      source: "default",
      target: { connectionId: "spare", model: "t" },
    });
  });

  it("passes over an unusable target and records why; refuses when none is usable", async () => {
    const service = await configured();
    await service.setRoleBinding({
      workspaceId: "default",
      role: "main",
      target: { connectionId: "primary", model: "p" },
      fallback: [{ connectionId: "backup", model: "b" }],
    });
    await service.replaceCatalog("primary", [{ modelId: "p", provenance: "manual", state: "unavailable" }]);
    expect(await resolveRunTarget(service, { workspaceId: "default" })).toMatchObject({
      target: { connectionId: "backup", model: "b" },
      fallback: [],
      skipped: [{ target: { connectionId: "primary", model: "p" }, reason: "unavailable-model" }],
    });
    await service.replaceCatalog("backup", [{ modelId: "b", provenance: "manual", state: "unavailable" }]);
    // Configured, but nothing usable: a refusal, not "unconfigured" — and not the default workspace's either.
    await expect((async () => await resolveRunTarget(service, { workspaceId: "default" }))()).rejects.toThrowError(
      expect.objectContaining({ code: "NOT_CONFIGURED" }),
    );
  });

  it("runs --model alone on the connection main names first, whatever the catalog says of the configured model", async () => {
    const service = await configured();
    await service.setRoleBinding({
      workspaceId: "default",
      role: "main",
      target: { connectionId: "primary", model: "p" },
      fallback: [{ connectionId: "backup", model: "b" }],
    });
    await service.replaceCatalog("primary", [{ modelId: "p", provenance: "manual", state: "unavailable" }]);
    expect(await resolveRunTarget(service, { workspaceId: "default", model: "x" })).toEqual({
      source: "role",
      target: { connectionId: "primary", model: "x" },
      connection: expect.objectContaining({ connectionId: "primary" }),
      fallback: [],
      skipped: [],
    });
  });

  it("refuses a connection with no model to run, as the operator's to name", async () => {
    const service = await configured();
    await service.putConnection({
      connectionId: "bare",
      label: "bare",
      baseUrl: "http://127.0.0.1:1/bare/v1",
      credentialRef: "bare.key",
      localOnly: true,
    });
    await expect((async () => await resolveRunTarget(service, { workspaceId: "default", connectionId: "bare" }))()).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT", details: expect.objectContaining({ reason: "connection-without-model" }) }),
    );
  });

  it("drops the fallback for an explicit --model, and takes --connection alone with the model it has", async () => {
    const service = await configured();
    await service.setRoleBinding({
      workspaceId: "default",
      role: "main",
      target: { connectionId: "primary", model: "p" },
      fallback: [{ connectionId: "backup", model: "b" }],
    });
    expect(await resolveRunTarget(service, { workspaceId: "default", model: "chosen" })).toMatchObject({
      target: { connectionId: "primary", model: "chosen" },
      fallback: [],
    });
    expect(await resolveRunTarget(service, { workspaceId: "default", connectionId: "backup" })).toMatchObject({
      source: "connection",
      target: { connectionId: "backup", model: "backup-default" },
      fallback: [],
    });
    await service.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "backup", model: "from-default" } });
    expect((await resolveRunTarget(service, { workspaceId: "default", connectionId: "backup" }))?.target.model).toBe("from-default");
    await expect((async () => await resolveRunTarget(service, { workspaceId: "default", connectionId: "nowhere" }))()).rejects.toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });
});
