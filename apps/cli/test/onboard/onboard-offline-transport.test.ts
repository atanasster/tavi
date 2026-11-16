import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import type { OnboardingFlowAnswer, OnboardingStatus } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { DatabaseClient } from "@tavi/runtime";

import { offlineTransport } from "../../src/features/onboard/transport.js";

/** Offline setup follows the plugin settings an owner starts with: the built-in flow and the channels only while enabled. */

const directories = temporaryDirectories({ prefix: "tavi-onboard-offline-" });
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  directories.cleanup();
});

async function offline() {
  const directory = directories.create();
  const store = await DatabaseClient.open({
    databasePath: join(directory, "tavi.sqlite"),
    artifactsDirectory: join(directory, "artifacts"),
  });
  cleanup.push(async () => await store.close());
  const transport = offlineTransport(store, { dataDirectory: directory, principalOf: () => "operator" });
  const enable = async (pluginId: string, enabled: boolean) => {
    await store
      .asPort()
      .repositories.plugins.putSetting({ pluginId, enabled, config: {}, updatedBy: "operator", updatedAt: nowTimestamp() });
  };
  return { transport, enable };
}

describe("the offline transport", () => {
  it("answers with the built-in flow while tavi.onboarding is enabled, and with none once it is disabled", async () => {
    const { transport, enable } = await offline();
    expect(
      (await transport.request<OnboardingFlowAnswer>("onboarding", { action: "flow", workspaceId: "default", surface: "cli" })).providerId,
    ).toBe("tavi.onboarding");
    await enable("tavi.onboarding", false);
    expect(
      (await transport.request<OnboardingStatus>("onboarding", { action: "status", workspaceId: "default", surface: "cli" })).providerId,
    ).toBeNull();
    // Turned back on, it answers again, read on each call.
    await enable("tavi.onboarding", true);
    expect(
      (await transport.request<OnboardingStatus>("onboarding", { action: "status", workspaceId: "default", surface: "cli" })).providerId,
    ).toBe("tavi.onboarding");
  });

  it("offers no channel once every channel's plugin is disabled", async () => {
    const { transport, enable } = await offline();
    const channels = async () =>
      (await transport.request<OnboardingStatus>("onboarding", { action: "status", workspaceId: "default", surface: "cli" })).steps.find(
        (step) => step.kind === "channels",
      )?.state;
    expect(await channels()).not.toBe("unavailable");
    await enable("tavi.telegram", false);
    expect(await channels()).not.toBe("unavailable");
    for (const pluginId of ["tavi.mailgun", "tavi.gmail"]) await enable(pluginId, false);
    expect(await channels()).toBe("unavailable");
  });
});
