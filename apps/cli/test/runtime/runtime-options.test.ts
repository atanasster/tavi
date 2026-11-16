import { describe, expect, it } from "vitest";

import { runtimeOptionsFor } from "../../src/cli/runtime-options.js";
import type { RunCommandOptions } from "../../src/features/run/parse.js";

const baseOptions: RunCommandOptions = {
  prompt: "hi",
  format: "text",
  workspaceId: "default",
  principalId: "operator",
  connectionId: "fake",
  model: "fake",
  approval: "ask",
  quiet: false,
  inMemory: true,
};

describe("runtimeOptionsFor — the fixture tool", () => {
  it("never puts fixture.echo on a real invocation's surface, whatever the environment says", () => {
    expect(runtimeOptionsFor(baseOptions, {}).devFixtureTools).toBeUndefined();
    expect(runtimeOptionsFor(baseOptions, { TAVI_DEV_FIXTURE_TOOL: "1" }).devFixtureTools).toBeUndefined();
  });
});

it("keeps managed provider targets out of builtin transports and CLI credential overrides", () => {
  const options = runtimeOptionsFor(
    baseOptions,
    { TAVI_API_KEY_FILE: "/unused" },
    { providerManaged: true, kind: "openai-compatible", baseUrl: "https://example.com/v1", credentialRef: "plugin.account.key" },
    [
      {
        connectionId: "external-backup",
        model: "m",
        connection: {
          providerManaged: true,
          kind: "openai-compatible",
          baseUrl: "https://example.org/v1",
          credentialRef: "plugin.backup.key",
        },
      },
    ],
  );
  expect(options.providers).toEqual([]);
  expect(options.credentials).toEqual({});
  expect(options.modelFallback).toEqual([{ connectionId: "external-backup", model: "m" }]);
});

describe("serve --sandbox-credential", () => {
  it("binds each variable to its reference's exact --http-credential-host hosts", () => {
    const options = runtimeOptionsFor(
      {
        ...baseOptions,
        httpCredentialHosts: ["github.token=api.github.com", "github.token=uploads.github.com"],
        sandboxCredentials: ["GH_TOKEN=github.token"],
      },
      {},
    );
    expect(options.sandboxCredentials).toEqual([{ env: "GH_TOKEN", ref: "github.token", hosts: ["api.github.com", "uploads.github.com"] }]);
    expect(runtimeOptionsFor(baseOptions, {})).not.toHaveProperty("sandboxCredentials");
  });

  it("refuses a reference bound to no host, or to a pattern, when the owner starts", () => {
    expect(() => runtimeOptionsFor({ ...baseOptions, sandboxCredentials: ["GH_TOKEN=github.token"] }, {})).toThrow(
      /not bound to a host; bind it with --http-credential-host github\.token=<host>/,
    );
    expect(() =>
      runtimeOptionsFor(
        { ...baseOptions, httpCredentialHosts: ["github.token=*.github.com"], sandboxCredentials: ["GH_TOKEN=github.token"] },
        {},
      ),
    ).toThrow(/must be one exact host/);
    // srt matches inject hosts by name alone: a port would never match.
    expect(() =>
      runtimeOptionsFor(
        { ...baseOptions, httpCredentialHosts: ["github.token=api.github.com:443"], sandboxCredentials: ["GH_TOKEN=github.token"] },
        {},
      ),
    ).toThrow(/with no port/);
  });
});
