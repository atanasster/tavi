import type { ModelCatalogEntry, ModelConnection, ModelLifecycleEntry } from "@tavi/contracts";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT, main } from "../../src/main.js";

import {
  lifecycleSyncLogLine,
  lifecycleSyncReport,
  startLifecycleSync,
  NO_CLOUD_CONNECTION_HINT,
  storedLifecycleReport,
  syncModelLifecycle,
  type LifecycleSyncReport,
  type LifecycleSyncSources,
  RHUMB_KEY_HINT,
} from "../../src/features/models/lifecycle-sync.js";
import type { RhumbCall } from "../../src/features/models/rhumb-client.js";
import type { ModelTargetsInUse } from "../../src/features/models/targets-in-use.js";

const AT = "2026-11-01T00:00:00.000Z";
const NOW = new Date("2026-11-20T08:00:00.000Z");

const connection = (connectionId: string, baseUrl: string, localOnly = false): ModelConnection => ({
  connectionId,
  label: connectionId,
  kind: "openai-compatible",
  baseUrl,
  credentialRef: connectionId,
  localOnly,
  createdAt: AT,
  updatedAt: AT,
});

const catalogRow = (connectionId: string, modelId: string): ModelCatalogEntry => ({
  connectionId,
  modelId,
  provenance: "catalog",
  state: "available",
  capabilities: [],
});

function harness(options: { readonly pages?: unknown[]; readonly stored?: readonly ModelLifecycleEntry[] } = {}) {
  const replaced = new Map<string, readonly ModelLifecycleEntry[]>();
  const queries: Record<string, string>[] = [];
  const inUse: ModelTargetsInUse = {
    targets: [
      { connectionId: "openai", model: "gpt-5", usedBy: [{ kind: "workspace-default", workspaceId: "default" }] },
      { connectionId: "gemini", model: "models/gemini-2.5-pro", usedBy: [{ kind: "role", workspaceId: "default", detail: "fast" }] },
      { connectionId: "local", model: "qwen3:8b", usedBy: [{ kind: "connection-default" }] },
    ],
    unread: ["default chats of guest: database is locked"],
  };
  const sources: LifecycleSyncSources = {
    connections: async () => [
      connection("openai", "https://api.openai.com/v1"),
      connection("gemini", "https://generativelanguage.googleapis.com/v1beta/openai"),
      connection("local", "http://localhost:11434/v1", true),
      connection("gateway", "https://gateway.example/v1"),
    ],
    catalog: async (connectionId) => (connectionId === "openai" ? [catalogRow("openai", "gpt-5"), catalogRow("openai", "gpt-4.1")] : []),
    inUse: async () => inUse,
    stored: async () => options.stored ?? [],
    replace: async (connectionId, entries) => {
      replaced.set(connectionId, entries);
    },
  };
  const pages = options.pages ?? [
    {
      catalog_version: "2026-11-20.1",
      total: 2,
      models: [
        { offerings: [{ provider: "openai", provider_model_id: "gpt-5", status: "deprecated", retires_on: "2026-12-11" }] },
        {
          offerings: [
            {
              provider: "gemini",
              provider_model_id: "gemini-2.5-pro",
              status: "ga",
              redirect: { on: "2026-12-01", to: "gemini-3.8-flash" },
            },
          ],
        },
      ],
    },
  ];
  const call: RhumbCall = async (_path, query) => {
    queries.push(query);
    return pages[queries.length - 1];
  };
  return { sources, call, replaced, queries };
}

describe("the model lifecycle sync", () => {
  it("stores each cloud connection's models, skips custom and local ones, and warns of the models in use", async () => {
    const { sources, call, replaced, queries } = harness();
    const result = await syncModelLifecycle(sources, call, NOW);
    // Provider names and paging only: never a model id in use.
    expect(queries).toEqual([{ providers: "gemini,openai", limit: "500", offset: "0", include_retired: "true", include_hidden: "true" }]);
    expect(result.connections).toEqual([
      { connectionId: "openai", provider: "openai", models: 2 },
      { connectionId: "gemini", provider: "gemini", models: 1 },
      { connectionId: "local", models: 0, skipped: "runs on this computer, where nothing retires" },
      { connectionId: "gateway", models: 0, skipped: "a custom endpoint Rhumb does not know" },
    ]);
    expect(replaced.get("openai")?.map((entry) => [entry.modelId, entry.lifecycle.status])).toEqual([
      ["gpt-4.1", "unknown"],
      ["gpt-5", "deprecated"],
    ]);
    expect(replaced.get("gemini")?.[0]).toMatchObject({
      modelId: "models/gemini-2.5-pro",
      lifecycle: { redirect: { to: "gemini-3.8-flash" } },
    });
    expect(replaced.has("local")).toBe(false);

    const report = lifecycleSyncReport(result);
    expect(report.unread).toEqual(["default chats of guest: database is locked"]);
    expect(report.warnings.map((warning) => [warning.connectionId, warning.model, warning.level])).toEqual([
      ["gemini", "models/gemini-2.5-pro", "warning"],
      ["openai", "gpt-5", "warning"],
    ]);
    expect(lifecycleSyncLogLine(report)).toContain("openai/gpt-5 retires on 2026-12-11");
  });

  it("keeps what was stored for a model past the pages it read", async () => {
    const full = {
      catalog_version: "2026-11-20.1",
      models: Array.from({ length: 500 }, (_, index) => ({ offerings: [{ provider: "openai", provider_model_id: `m${index}` }] })),
    };
    const kept: ModelLifecycleEntry = {
      connectionId: "openai",
      modelId: "gpt-5",
      lifecycle: { status: "deprecated", retiresOn: "2026-12-11", catalogVersion: "2026-11-19.1", checkedAt: AT },
    };
    const { sources, call, replaced } = harness({ pages: [full, full, full, full, full], stored: [kept] });
    const result = await syncModelLifecycle(sources, call, NOW);
    expect(result.complete).toBe(false);
    // gpt-4.1 was never stored and is not on the pages read: left out, not called unknown.
    expect(replaced.get("openai")).toEqual([kept]);
    expect(replaced.get("gemini")).toEqual([]);
  });

  it("asks Rhumb nothing when no connection is a cloud provider it knows", async () => {
    const { sources, call, queries } = harness();
    const result = await syncModelLifecycle(
      { ...sources, connections: async () => [connection("local", "http://localhost:11434/v1", true)] },
      call,
      NOW,
    );
    expect(queries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("replaces a stored row with what the pages read say, and writes nothing once aborted", async () => {
    const old: ModelLifecycleEntry = {
      connectionId: "openai",
      modelId: "gpt-5",
      lifecycle: { status: "ga", catalogVersion: "2026-11-01.1", checkedAt: AT },
    };
    const { sources, call, replaced } = harness({ stored: [old] });
    await syncModelLifecycle(sources, call, NOW);
    expect(replaced.get("openai")?.find((entry) => entry.modelId === "gpt-5")?.lifecycle).toMatchObject({
      status: "deprecated",
      retiresOn: "2026-12-11",
      checkedAt: NOW.toISOString(),
    });

    const aborted = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(syncModelLifecycle(aborted.sources, aborted.call, NOW, controller.signal)).rejects.toThrow();
    expect(aborted.replaced.size).toBe(0);
  });
});

describe("doctor's stored lifecycle", () => {
  const gpt5 = (checkedAt: string, retiresOn = "2026-11-19"): ModelLifecycleEntry => ({
    connectionId: "openai",
    modelId: "gpt-5",
    lifecycle: { status: "deprecated", retiresOn, catalogVersion: "2026-11-18.1", checkedAt },
  });

  it("says how to start when nothing in use was checked, and that nothing can be with no cloud connection", async () => {
    const { sources } = harness();
    const empty = await storedLifecycleReport({ ...sources, stored: async () => [] }, NOW);
    expect(empty).toMatchObject({ checkedAt: null, warnings: [], unchecked: ["openai/gpt-5", "gemini/models/gemini-2.5-pro"] });
    expect(empty.hint).toContain("RHUMB_KEY");
    const local = await storedLifecycleReport(
      { ...sources, stored: async () => [], connections: async () => [connection("local", "http://localhost:11434/v1", true)] },
      NOW,
    );
    expect(local).toMatchObject({ checkedAt: null, hint: NO_CLOUD_CONNECTION_HINT, unchecked: [] });
  });

  it("reads the rows of the models in use for today: the oldest dates the check, and one never synced is named", async () => {
    const { sources } = harness();
    const report = await storedLifecycleReport(
      {
        ...sources,
        stored: async () => [
          gpt5(AT),
          // Fresher, but not in use: it must not date the check.
          {
            connectionId: "openai",
            modelId: "gpt-4.1",
            lifecycle: { status: "ga", catalogVersion: "2026-11-20.1", checkedAt: NOW.toISOString() },
          },
        ],
      },
      NOW,
    );
    expect(report).toMatchObject({
      checkedAt: AT,
      catalogVersion: "2026-11-18.1",
      stale: true,
      unchecked: ["gemini/models/gemini-2.5-pro"],
    });
    expect(report.hint).toBeUndefined();
    expect(report.warnings.map((warning) => [warning.model, warning.level])).toEqual([["gpt-5", "error"]]);
    const fresh = await storedLifecycleReport({ ...sources, stored: async () => [gpt5("2026-11-19T08:00:00.000Z")] }, NOW);
    expect(fresh.stale).toBe(false);
  });
});

describe("serve's lifecycle sync", () => {
  const KEY = { RHUMB_KEY: "key" };
  const report: LifecycleSyncReport = { complete: true, connections: [], warnings: [], unread: [] };
  const logger = () => {
    const lines: string[] = [];
    return { lines, info: (line: string) => void lines.push(`info ${line}`), warn: (line: string) => void lines.push(`warn ${line}`) };
  };

  it("does nothing without a key", () => {
    let calls = 0;
    startLifecycleSync(
      logger(),
      async () => {
        calls += 1;
        return report;
      },
      new AbortController().signal,
      { env: {} },
    );
    expect(calls).toBe(0);
  });

  it("logs a sync's line or its failure, never runs two at once, and stops on abort", async () => {
    const log = logger();
    const controller = new AbortController();
    const results: (() => Promise<LifecycleSyncReport>)[] = [
      async () => report,
      async () => {
        throw new Error("the resolver answered 503");
      },
    ];
    let calls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    startLifecycleSync(
      log,
      async () => {
        const result = results[calls];
        calls += 1;
        await held;
        return (result ?? (async () => report))();
      },
      controller.signal,
      { env: KEY, intervalMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    release();
    await vi.waitFor(() => expect(log.lines).toContain("warn model lifecycle sync failed"));
    expect(log.lines[0]).toBe("info model lifecycle: no model in use is retiring or redirected");
    controller.abort();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(after);
  });
});

describe("tavi models sync", () => {
  const directories = temporaryDirectories({ prefix: "tavi-sync-" });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    directories.cleanup();
  });

  it("prints the RHUMB_KEY hint and opens no data directory with no key", async () => {
    vi.stubEnv("RHUMB_KEY", "");
    vi.stubEnv("RESOLVER_KEY", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const directory = join(directories.create(), "never-created");
    const captured = capture();
    expect(await main(["models", "sync", "--data-dir", directory], { io: captured.io })).toBe(EXIT.ok);
    expect(captured.stderr()).toContain(RHUMB_KEY_HINT);
    expect(captured.stdout()).toBe("");
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(directory)).toBe(false);
  });
});
