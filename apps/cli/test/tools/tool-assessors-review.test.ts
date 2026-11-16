import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema, PluginToolDeclarationSchema, type PluginVersionRecord, type SecretReaderPort } from "@tavi/contracts";
import { ToolRegistry, PluginHost } from "@tavi/runtime";
import { temporaryDirectories, partialFake } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { loadExternalPlugins } from "../../src/features/plugins/external.js";
import { registerHttpTools } from "../../src/features/http/tools.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/** The context an assessor is given with a call; these tools do not read it. */
const assessContext = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };

/** Assessors that read the handler's own refusals, and a manifest's risk floor. */

const secretReader: SecretReaderPort = partialFake<SecretReaderPort>({ getSecret: async () => null });

describe("http.request assessment", () => {
  const registry = new ToolRegistry();
  registerHttpTools(registry, { secretReader, allowedHosts: ["api.example.com"], credentialHosts: { "acme.key": ["api.example.com"] } });
  const assess = (input: unknown) => registry.get("http.request")?.assess?.(input, assessContext);

  it("hard-denies a host outside the allowlist with the handler's reason", () => {
    expect(assess({ url: "https://evil.example.net/x" })?.hardDeny).toMatch(
      /^http\.request refused: .*evil\.example\.net is not in the operator's allowlist/,
    );
    expect(assess({ url: "http://api.example.com/x" })?.hardDeny).toMatch(/only https is permitted/);
    expect(assess({ url: "not a url" })?.hardDeny).toBe("http.request refused: the URL is not absolute");
    // With no browser registered, a site off the list names no browser tool.
    expect(assess({ url: "https://smart.example.org/" })?.hardDeny).not.toContain("browser");
    // A site off the list points at the browser, where the person can allow it, while the browser is registered.
    registry.register({
      id: "browser.create_session",
      sink: "network",
      urlOnly: true,
      version: "1.0.0",
      description: "Browser fixture",
      effect: "external",
      requiredPermissions: [],
      inputSchema: z.looseObject({ url: z.string() }),
      handler: async () => ({}),
    });
    expect(assess({ url: "https://smart.example.org/" })?.hardDeny).toContain("browser.create_session");
  });

  it("hard-denies a credential not bound to the host, and passes an allowed call through", () => {
    expect(assess({ url: "https://api.example.com/x", credentialRef: "other.key" })?.hardDeny).toMatch(
      /other\.key is not bound to any host/,
    );
    const allowed = assess({ url: "https://api.example.com/x", credentialRef: "acme.key" });
    expect(allowed?.hardDeny).toBeUndefined();
    expect(allowed?.risk).toBe("medium");
  });
});

describe("external plugin manifest risk", () => {
  const directories = temporaryDirectories();
  afterEach(() => directories.cleanup());

  it("accepts minRisk and untrustedOutput on a tool declaration, and nothing looser", () => {
    expect(
      PluginToolDeclarationSchema.parse({ name: "wire", effect: "external", description: "d", minRisk: "critical", untrustedOutput: true }),
    ).toMatchObject({ minRisk: "critical", untrustedOutput: true });
    expect(PluginToolDeclarationSchema.safeParse({ name: "wire", effect: "external", description: "d", minRisk: "extreme" }).success).toBe(
      false,
    );
  });

  it("raises a tool's risk to the manifest's floor, never lowers it, and marks untrusted output", async () => {
    const directory = directories.create("tavi-plugin-risk-");
    const entryPath = join(directory, "index.mjs");
    writeFileSync(
      entryPath,
      "export function register({ registerTool, z }) { for (const name of ['wire', 'read', 'plain', 'own']) registerTool({ name, inputSchema: z.object({}), handler: async () => name }); }\n",
    );
    const manifest = PluginManifestSchema.parse({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.bank",
      version: "1.0.0",
      name: "Bank fixture",
      entry: "index.mjs",
      tools: [
        { name: "wire", effect: "external", description: "Send money", minRisk: "critical" },
        { name: "read", effect: "external", description: "Read a feed", minRisk: "low", untrustedOutput: true },
        { name: "plain", effect: "read-only", description: "Plain" },
        { name: "own", effect: "read-only", description: "The plugin's own data", untrustedOutput: false },
      ],
      config: {},
    });
    const record: PluginVersionRecord = {
      pluginId: "acme.bank",
      version: "1.0.0",
      contentHash: "a".repeat(64),
      manifest,
      reviewState: "approved",
      installedBy: "test",
      installedAt: "2026-09-28T00:00:00.000Z",
    };
    const tools = new ToolRegistry();
    const load = await loadExternalPlugins(
      [{ ok: true, record, directory, entryPath, config: {}, instances: [] }],
      tools,
      silentLog,
      async () => null,
      { bind: () => async () => {} },
    );
    const host = new PluginHost([foundationPlugin(), ...load.definitions], { buildId: "risk-test" });
    await host.start();
    try {
      expect(load.failures.size).toBe(0);
      expect(tools.get("acme.bank.wire")?.assess?.({}, assessContext)).toMatchObject({
        risk: "critical",
        subjects: [],
        reasons: ["the plugin's approved manifest rates this tool at least critical risk"],
      });
      // A floor below the effect's own risk leaves the effect's.
      expect(tools.get("acme.bank.read")?.assess?.({}, assessContext)?.risk).toBe("medium");
      expect(tools.get("acme.bank.read")?.untrustedOutput).toBe(true);
      expect(tools.get("acme.bank.plain")?.assess).toBeUndefined();
      // Silent on untrustedOutput is untrusted; only an explicit false is trusted.
      expect(tools.get("acme.bank.plain")?.untrustedOutput).toBe(true);
      expect(tools.get("acme.bank.own")?.untrustedOutput).toBeUndefined();
    } finally {
      await host.stop();
    }
  });
});
