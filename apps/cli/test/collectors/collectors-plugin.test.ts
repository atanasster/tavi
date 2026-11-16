import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { COLLECTORS_PLUGIN_ID } from "../../src/features/collectors/host.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

describe("tavi.collectors as a built-in", () => {
  const directories = temporaryDirectories();
  afterEach(() => directories.cleanup());

  it("composes the brief's tools while it is enabled, and leaves them out once disabled", async () => {
    const dataDir = directories.create("tavi-collectors-");
    const options = fixtureRuntimeOptions(dataDir, { scheduleSweepEnabled: false });
    const first = await composeTaviRuntime(options, { requireModelTransport: false });
    try {
      for (const id of ["collect.daily", "reports.generate"]) expect(first.tools.get(id), id).toBeDefined();
      await first.plugins.registry.disable(COLLECTORS_PLUGIN_ID, "operator");
    } finally {
      await first.close();
    }
    const second = await composeTaviRuntime(options, { requireModelTransport: false });
    try {
      for (const id of ["collect.daily", "projects.get", "reports.generate", "reports.history"])
        expect(second.tools.get(id), id).toBeUndefined();
    } finally {
      await second.close();
    }
  });
});
