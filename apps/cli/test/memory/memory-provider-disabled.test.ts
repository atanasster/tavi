import { BUILTIN_MEMORY_PROVIDER_ID } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { captureProviderOf } from "../../src/features/memory/providers.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** The built-in memory provider is an optional plugin: off, recall is the host's own search and nothing drafts. */

describe("the built-in memory provider, disabled", () => {
  const directories = temporaryDirectories();
  afterEach(() => directories.cleanup());

  it("installs no provider from the next start, so neither the idle review nor the epoch flush drafts anything", async () => {
    const dataDir = directories.create("tavi-memoryprovider-off-");
    const options = fixtureRuntimeOptions(dataDir, { scheduleSweepEnabled: false });
    const first = await composeTaviRuntime(options, { requireModelTransport: false });
    try {
      expect(first.memoryProviders.get(BUILTIN_MEMORY_PROVIDER_ID)).toBeDefined();
      await first.plugins.registry.disable(BUILTIN_MEMORY_PROVIDER_ID, "operator");
    } finally {
      await first.close();
    }
    const second = await composeTaviRuntime(options, { requireModelTransport: false });
    try {
      expect(second.memoryProviders.list()).toEqual([]);
      expect((await second.memoryProviders.choice("default")).provider).toBeUndefined();
      expect(await captureProviderOf(second.memoryProviders, "default")).toBeUndefined();
    } finally {
      await second.close();
    }
  });
});
