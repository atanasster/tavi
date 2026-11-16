import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PluginManifestSchema,
  workerRefusal,
  type HeartbeatProvider,
  type HeartbeatSignalSource,
  type PluginIsolationPort,
  type PluginVersionRecord,
} from "@tavi/contracts";
import { ToolRegistry, PluginHost } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { loadExternalPlugins, type ExternalHeartbeatHost } from "../../src/features/plugins/external.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/**
 * Where plugin code meets the heartbeat:
 * `provideHeartbeat` and `provideSignals` refuse what the approved manifest
 * does not declare, a second supply, and a call after `register` returned —
 * each failing the plugin's load even when the plugin catches it — and what
 * they install answers only while the plugin runs.
 */

const directories = temporaryDirectories();
const hosts: PluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  directories.cleanup();
  delete (globalThis as { __taviLateProvide?: unknown }).__taviLateProvide;
});

const HEARTBEAT = { abi: "tavi.heartbeat/1", receives: ["signals"], usesTurns: false, maxTickSeconds: 5 };
const SIGNALS = { abi: "tavi.heartbeat/1", sources: ["queue"] };

/** Load one plugin with `code` as its entry under `manifest`'s declarations, recording what reached the heartbeat. */
async function load(code: string, declarations: Record<string, unknown>) {
  const directory = directories.create("tavi-heartbeat-plugin-");
  const entryPath = join(directory, "index.mjs");
  writeFileSync(entryPath, code);
  const manifest = PluginManifestSchema.parse({
    schemaVersion: 2,
    abi: "tavi.providers/1",
    provenance: { format: "bundled-esm", packages: [] },
    id: "acme.watch",
    version: "1.0.0",
    name: "Watch",
    entry: "index.mjs",
    ...declarations,
  });
  const record: PluginVersionRecord = {
    pluginId: "acme.watch",
    version: "1.0.0",
    contentHash: "b".repeat(64),
    manifest,
    reviewState: "approved",
    installedBy: "test",
    installedAt: "2026-10-11T00:00:00.000Z",
  };
  const installed: { providers: HeartbeatProvider[]; sources: HeartbeatSignalSource[]; withdrawn: number } = {
    providers: [],
    sources: [],
    withdrawn: 0,
  };
  const heartbeat: ExternalHeartbeatHost = {
    installProvider: (_record, provider) => {
      installed.providers.push(provider);
      return () => {
        installed.withdrawn += 1;
      };
    },
    installSource: (_record, source) => {
      installed.sources.push(source);
      return () => {
        installed.withdrawn += 1;
      };
    },
  };
  const loaded = await loadExternalPlugins(
    [{ ok: true, record, directory, entryPath, config: {}, instances: [] }],
    new ToolRegistry(),
    silentLog,
    async () => null,
    { bind: () => async () => {} },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    heartbeat,
  );
  const host = new PluginHost([foundationPlugin(), ...loaded.definitions], { buildId: "heartbeat-plugin-test" });
  hosts.push(host);
  await host.start();
  return { loaded, installed, failure: loaded.failures.get("acme.watch") };
}

const tick = "async tick() { return { items: [] }; }";
const collect = "async collect() { return []; }";

describe("provideHeartbeat and provideSignals", () => {
  it("install a declared provider and source once the plugin runs, frozen as supplied", async () => {
    const { installed, failure } = await load(
      `export function register({ provideHeartbeat, provideSignals }) {
      const provider = { ${tick} };
      provideHeartbeat(provider);
      // Changed after it was supplied: the host keeps what it was given.
      provider.tick = async () => { throw new Error("swapped"); };
      provideSignals({ id: "queue", ${collect} });
    }`,
      { provides: ["heartbeat", "heartbeat-signals"], heartbeat: HEARTBEAT, heartbeatSignals: SIGNALS },
    );
    expect(failure).toBeUndefined();
    expect(installed.providers).toHaveLength(1);
    expect(Object.isFrozen(installed.providers[0])).toBe(true);
    expect(await installed.providers[0]?.tick({ signal: new AbortController().signal } as never)).toEqual({ items: [] });
    expect(installed.sources.map((source) => source.id)).toEqual(["queue"]);
  });

  it.each([
    [
      "a provider the manifest does not declare",
      `provideHeartbeat({ ${tick} });`,
      {},
      "provideHeartbeat needs a heartbeat declaration in the approved manifest",
    ],
    [
      "a provider with no tick",
      "provideHeartbeat({});",
      { provides: ["heartbeat"], heartbeat: HEARTBEAT },
      "provideHeartbeat needs a tick function",
    ],
    [
      "a second provider",
      `provideHeartbeat({ ${tick} }); try { provideHeartbeat({ ${tick} }); } catch {}`,
      { provides: ["heartbeat"], heartbeat: HEARTBEAT },
      "provideHeartbeat was already called",
    ],
    [
      "a source the manifest does not declare",
      `provideSignals({ id: "inbox", ${collect} });`,
      { provides: ["heartbeat-signals"], heartbeatSignals: SIGNALS },
      "the source inbox is not declared",
    ],
    [
      "a source with no collect",
      `provideSignals({ id: "queue" });`,
      { provides: ["heartbeat-signals"], heartbeatSignals: SIGNALS },
      "provideSignals needs a source with an id and a collect function",
    ],
    [
      "one source twice",
      `provideSignals({ id: "queue", ${collect} }); try { provideSignals({ id: "queue", ${collect} }); } catch {}`,
      { provides: ["heartbeat-signals"], heartbeatSignals: SIGNALS },
      "provideSignals was already called for queue",
    ],
  ])("refuse %s, failing the load even when the plugin catches it", async (_name, body, declarations, message) => {
    const { installed, failure } = await load(
      `export function register({ provideHeartbeat, provideSignals }) { try { ${body} } catch {} }`,
      declarations,
    );
    expect(failure).toContain(message);
    expect(installed.providers).toEqual([]);
    expect(installed.sources).toEqual([]);
  });

  it("refuse a call after register returned", async () => {
    const { failure } = await load(`export function register({ provideHeartbeat }) { globalThis.__taviLateProvide = provideHeartbeat; }`, {
      provides: ["heartbeat"],
      heartbeat: HEARTBEAT,
    });
    expect(failure).toBeUndefined();
    const late = (globalThis as { __taviLateProvide?: (provider: HeartbeatProvider) => void }).__taviLateProvide;
    expect(() => late?.({ tick: async () => ({ items: [] }) })).toThrow("plugin registration is closed");
  });

  it("take a source's offer line from the approved manifest, never from its code", async () => {
    const { installed } = await load(
      `export function register({ provideSignals }) {
      provideSignals({ id: "queue", offer: "Line from code", ${collect} });
    }`,
      { provides: ["heartbeat-signals"], heartbeatSignals: { ...SIGNALS, offers: { queue: "Jobs stuck in the queue" } } },
    );
    expect(installed.sources[0]?.offer).toBe("Jobs stuck in the queue");
    const { installed: silent } = await load(
      `export function register({ provideSignals }) {
      provideSignals({ id: "queue", offer: "Line from code", ${collect} });
    }`,
      { provides: ["heartbeat-signals"], heartbeatSignals: SIGNALS },
    );
    expect(silent.sources[0]?.offer).toBeUndefined();
  });

  it("answer only while the plugin runs: withdrawn, a tick and a collection are refused", async () => {
    const { loaded, installed } = await load(
      `export function register({ provideHeartbeat, provideSignals }) {
      provideHeartbeat({ ${tick} });
      provideSignals({ id: "queue", ${collect} });
    }`,
      { provides: ["heartbeat", "heartbeat-signals"], heartbeat: HEARTBEAT, heartbeatSignals: SIGNALS },
    );
    await loaded.withdraw("acme.watch");
    expect(installed.withdrawn).toBe(2);
    await expect(installed.providers[0]?.tick({ signal: new AbortController().signal } as never)).rejects.toMatchObject({
      reason: "transport",
    });
    await expect(
      installed.sources[0]?.collect({
        workspaceId: "default",
        principalId: "operator",
        now: "2026-10-11T09:00:00.000Z",
        timezone: "UTC",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("a confined worker's heartbeat signal sources", () => {
  const manifest = (extra: Record<string, unknown>) =>
    PluginManifestSchema.parse({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.watch",
      version: "1.0.0",
      name: "Watch",
      entry: "index.mjs",
      ...extra,
    });

  it("no longer keep a plugin out of a worker; a heartbeat provider still does", () => {
    expect(workerRefusal(manifest({ provides: ["heartbeat-signals"], heartbeatSignals: SIGNALS }))).toBeUndefined();
    expect(workerRefusal(manifest({ provides: ["heartbeat"], heartbeat: HEARTBEAT }))).toContain("a heartbeat provider");
  });

  /** The plugin loaded through a stand-in worker that registered `registered` and answers each collection, recording what it was asked. */
  async function viaWorker(registered: readonly { readonly id: string; readonly retracts?: false }[]) {
    const directory = directories.create("tavi-heartbeat-worker-");
    const asked: unknown[] = [];
    const isolation: PluginIsolationPort = {
      start: async () => ({
        registrations: { tools: [], hooks: [], commands: [], signalSources: registered },
        callTool: async () => undefined,
        beforeCall: async () => undefined,
        collect: async (id, input) => {
          asked.push({ id, input });
          return [{ key: "job-1", title: "New match" }];
        },
        hook: async () => undefined,
        command: async () => ({ text: "" }),
        status: () => ({ state: "running", restarts: 0 }),
        stop: async () => undefined,
      }),
    };
    const record: PluginVersionRecord = {
      pluginId: "acme.watch",
      version: "1.0.0",
      contentHash: "b".repeat(64),
      manifest: manifest({ provides: ["heartbeat-signals"], heartbeatSignals: SIGNALS }),
      reviewState: "approved",
      installedBy: "test",
      installedAt: "2026-10-11T00:00:00.000Z",
      isolation: "process",
    };
    const sources: HeartbeatSignalSource[] = [];
    const heartbeat: ExternalHeartbeatHost = {
      installProvider: () => () => undefined,
      installSource: (_record, source) => {
        sources.push(source);
        return () => undefined;
      },
    };
    const loaded = await loadExternalPlugins(
      [{ ok: true, record, directory, entryPath: join(directory, "index.mjs"), config: {}, instances: [] }],
      new ToolRegistry(),
      silentLog,
      async () => null,
      { bind: () => async () => {} },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      heartbeat,
      undefined,
      isolation,
    );
    const host = new PluginHost([foundationPlugin(), ...loaded.definitions], { buildId: "heartbeat-worker-test" });
    hosts.push(host);
    await host.start();
    return { sources, asked, failure: loaded.failures.get("acme.watch") };
  }

  it("are installed as sources the owner checks against the manifest, each collection asked of the worker", async () => {
    const { sources, asked, failure } = await viaWorker([{ id: "queue", retracts: false }]);
    expect(failure).toBeUndefined();
    expect(sources.map((source) => [source.id, source.retracts])).toEqual([["queue", false]]);
    const answer = await sources[0]?.collect({
      workspaceId: "default",
      principalId: "operator",
      now: "2026-10-16T12:00:00.000Z",
      timezone: "UTC",
      signal: new AbortController().signal,
    });
    expect(answer).toEqual([{ key: "job-1", title: "New match" }]);
    expect(asked).toEqual([
      { id: "queue", input: { workspaceId: "default", principalId: "operator", now: "2026-10-16T12:00:00.000Z", timezone: "UTC" } },
    ]);
  });

  it("refuse a source the manifest does not declare, as in-process", async () => {
    expect((await viaWorker([{ id: "inbox" }])).failure).toContain("the source inbox is not declared");
  });
});
