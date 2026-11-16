import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { IDEAS_ABI, PluginManifestSchema, type IdeasProvider, type PluginVersionRecord } from "@tavi/contracts";
import { ToolRegistry, PluginHost } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { loadExternalPlugins, type ExternalIdeasHost } from "../../src/features/plugins/external.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/**
 * Where plugin code meets Ideas (docs/IDEAS-PLUGINS.md): `provideIdeas`
 * refuses a provider the approved manifest does not declare, one without a
 * generate function, and a second supply — each failing the plugin's load even
 * when the plugin catches it — and what it installs answers only while the
 * plugin runs, and is withdrawn when it stops.
 */

const directories = temporaryDirectories();
const hosts: PluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  directories.cleanup();
  delete (globalThis as { __taviIdeasError?: unknown }).__taviIdeasError;
});

const IDEAS = { abi: IDEAS_ABI, receives: ["ledger"] };

async function load(code: string, declarations: Record<string, unknown>) {
  const directory = directories.create("tavi-ideas-plugin-");
  const entryPath = join(directory, "index.mjs");
  writeFileSync(entryPath, code);
  const manifest = PluginManifestSchema.parse({
    schemaVersion: 2,
    abi: "tavi.providers/1",
    provenance: { format: "bundled-esm", packages: [] },
    id: "acme.ideas",
    version: "1.0.0",
    name: "Acme ideas",
    entry: "index.mjs",
    isolation: "in-process",
    ...declarations,
  });
  const record: PluginVersionRecord = {
    pluginId: "acme.ideas",
    version: "1.0.0",
    contentHash: "c".repeat(64),
    manifest,
    reviewState: "approved",
    installedBy: "test",
    installedAt: "2026-10-19T00:00:00.000Z",
  };
  const installed: { providers: IdeasProvider[]; withdrawn: number } = { providers: [], withdrawn: 0 };
  const ideas: ExternalIdeasHost = {
    installProvider: (_record, provider) => {
      installed.providers.push(provider);
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ideas,
  );
  const host = new PluginHost([foundationPlugin(), ...loaded.definitions], { buildId: "ideas-plugin-test" });
  hosts.push(host);
  await host.start();
  return { host, installed, failure: loaded.failures.get("acme.ideas") };
}

const generate = "async generate() { return { ideas: [] }; }";

describe("provideIdeas", () => {
  it("installs a declared provider once the plugin runs, frozen as supplied, and withdraws it when the plugin stops", async () => {
    const { host, installed, failure } = await load(
      `export function register({ provideIdeas }) {
      const provider = { ${generate} };
      provideIdeas(provider);
      provider.generate = async () => { throw new Error("swapped"); };
    }`,
      { provides: ["ideas"], ideas: IDEAS },
    );
    expect(failure).toBeUndefined();
    expect(installed.providers).toHaveLength(1);
    expect(Object.isFrozen(installed.providers[0])).toBe(true);
    expect(await installed.providers[0]?.generate({ signal: new AbortController().signal } as never)).toEqual({ ideas: [] });
    await host.stop();
    hosts.splice(0);
    expect(installed.withdrawn).toBe(1);
    await expect(installed.providers[0]?.generate({ signal: new AbortController().signal } as never)).rejects.toMatchObject({
      reason: "transport",
    });
  });

  it.each([
    ["a provider the manifest does not declare", `provideIdeas({ ${generate} });`, {}, "provideIdeas"],
    ["a provider with no generate", "provideIdeas({});", { provides: ["ideas"], ideas: IDEAS }, "provideIdeas needs a generate function"],
    [
      "a second provider",
      `provideIdeas({ ${generate} }); try { provideIdeas({ ${generate} }); } catch {}`,
      { provides: ["ideas"], ideas: IDEAS },
      "provideIdeas was already called",
    ],
  ])("refuses %s, failing the load even when the plugin catches it", async (_name, body, declarations, message) => {
    const { installed, failure } = await load(
      `export function register(context) { const { provideIdeas } = context; try { if (provideIdeas === undefined) throw new Error("provideIdeas is not offered"); ${body} } catch (error) { globalThis.__taviIdeasError = String(error); } }`,
      declarations,
    );
    expect(installed.providers).toHaveLength(0);
    const said = failure ?? String((globalThis as { __taviIdeasError?: unknown }).__taviIdeasError);
    expect(said).toContain(message);
  });
});
