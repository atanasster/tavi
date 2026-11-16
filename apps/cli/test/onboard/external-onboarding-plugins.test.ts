import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ONBOARDING_ABI, PluginManifestSchema, workerRefusal, type OnboardingProvider, type PluginVersionRecord } from "@tavi/contracts";
import { ToolRegistry, PluginHost } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { loadExternalPlugins, type ExternalOnboardingHost } from "../../src/features/plugins/external.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/**
 * Where plugin code meets setup (docs/ONBOARDING-PLUGINS.md):
 * `provideOnboarding` is offered only to a plugin whose approved manifest
 * declares a flow, and refuses one without a flow function and a second
 * supply — each failing the plugin's load even when the plugin catches it — and what it
 * installs answers only while the plugin runs, and is withdrawn when it stops,
 * so the host falls back to the built-in flow. A flow is a live object: it runs
 * in-process only.
 */

const directories = temporaryDirectories();
const hosts: PluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  directories.cleanup();
  delete (globalThis as { __taviOnboardingError?: unknown }).__taviOnboardingError;
});

const ONBOARDING = { abi: ONBOARDING_ABI, disclosure: "Slack first." };

async function load(code: string, declarations: Record<string, unknown>) {
  const directory = directories.create("tavi-onboarding-plugin-");
  const entryPath = join(directory, "index.mjs");
  writeFileSync(entryPath, code);
  const manifest = PluginManifestSchema.parse({
    schemaVersion: 2,
    abi: "tavi.providers/1",
    provenance: { format: "bundled-esm", packages: [] },
    id: "acme.onboarding",
    version: "1.0.0",
    name: "Acme onboarding",
    entry: "index.mjs",
    isolation: "in-process",
    ...declarations,
  });
  const record: PluginVersionRecord = {
    pluginId: "acme.onboarding",
    version: "1.0.0",
    contentHash: "c".repeat(64),
    manifest,
    reviewState: "approved",
    installedBy: "test",
    installedAt: "2026-10-19T00:00:00.000Z",
  };
  const installed: { providers: OnboardingProvider[]; withdrawn: number } = { providers: [], withdrawn: 0 };
  const onboarding: ExternalOnboardingHost = {
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
    undefined,
    onboarding,
  );
  const host = new PluginHost([foundationPlugin(), ...loaded.definitions], { buildId: "onboarding-plugin-test" });
  hosts.push(host);
  await host.start();
  return { host, installed, failure: loaded.failures.get("acme.onboarding") };
}

const flow = `async flow() { return { abi: "${ONBOARDING_ABI}", version: 1, title: "Acme", steps: [{ id: "model", kind: "model", title: "Model", body: "Pick one.", optional: false }], done: { title: "Done", body: "Done." } }; }`;

describe("provideOnboarding", () => {
  it("installs a declared flow once the plugin runs, frozen as supplied, and withdraws it when the plugin stops", async () => {
    const { host, installed, failure } = await load(
      `export function register({ provideOnboarding }) {
      const provider = { ${flow} };
      provideOnboarding(provider);
      provider.flow = async () => { throw new Error("swapped"); };
    }`,
      { provides: ["onboarding"], onboarding: ONBOARDING },
    );
    expect(failure).toBeUndefined();
    expect(installed.providers).toHaveLength(1);
    expect(Object.isFrozen(installed.providers[0])).toBe(true);
    expect(await installed.providers[0]?.flow({ signal: new AbortController().signal } as never)).toMatchObject({ title: "Acme" });
    await host.stop();
    hosts.splice(0);
    expect(installed.withdrawn).toBe(1);
    await expect(installed.providers[0]?.flow({ signal: new AbortController().signal } as never)).rejects.toThrow("not running");
  });

  it("is not offered to a plugin whose manifest declares no flow, so nothing is installed", async () => {
    const { installed, failure } = await load(
      `export function register(context) {
      if (context.provideOnboarding === undefined) { globalThis.__taviOnboardingError = "provideOnboarding is not offered"; return; }
      context.provideOnboarding({ ${flow} });
    }`,
      {},
    );
    expect((globalThis as { __taviOnboardingError?: unknown }).__taviOnboardingError).toBe("provideOnboarding is not offered");
    expect(installed.providers).toHaveLength(0);
    // Nothing was refused: a plugin that never asked for setup loads as any other.
    expect(failure).toBeUndefined();
    // One that calls it anyway, unguarded, fails its own register.
    const unguarded = await load(`export function register({ provideOnboarding }) { provideOnboarding({ ${flow} }); }`, {});
    expect(unguarded.installed.providers).toHaveLength(0);
    expect(unguarded.failure).toContain("provideOnboarding is not a function");
  });

  it.each([
    [
      "a flow with no flow function",
      "provideOnboarding({});",
      { provides: ["onboarding"], onboarding: ONBOARDING },
      "provideOnboarding needs a flow function",
    ],
    [
      "a second flow",
      `provideOnboarding({ ${flow} }); try { provideOnboarding({ ${flow} }); } catch {}`,
      { provides: ["onboarding"], onboarding: ONBOARDING },
      "provideOnboarding was already called",
    ],
  ])("refuses %s, failing the load even when the plugin catches it", async (_name, body, declarations, message) => {
    const { installed, failure } = await load(
      `export function register(context) { const { provideOnboarding } = context; try { if (provideOnboarding === undefined) throw new Error("provideOnboarding is not offered"); ${body} } catch (error) { globalThis.__taviOnboardingError = String(error); } }`,
      declarations,
    );
    expect(installed.providers).toHaveLength(0);
    // The load fails whatever the plugin did with the refusal.
    expect(failure).toContain(message);
  });

  it('is declared only with provides: ["onboarding"], and runs in-process only', () => {
    const base = {
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.onboarding",
      version: "1.0.0",
      name: "Acme onboarding",
      entry: "index.mjs",
    };
    expect(PluginManifestSchema.safeParse({ ...base, onboarding: ONBOARDING }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, provides: ["onboarding"] }).success).toBe(false);
    const manifest = PluginManifestSchema.parse({ ...base, provides: ["onboarding"], onboarding: ONBOARDING });
    expect(workerRefusal(manifest)).toContain("an onboarding flow");
  });
});
