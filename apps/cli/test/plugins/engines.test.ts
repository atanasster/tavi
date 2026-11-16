import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { BROWSER_WORKER_AGENT_ID, withBuiltinAgents } from "../../src/features/agents/builtin.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** The engines are built-ins: the browser, PDF and video ones disable-only, the confinement ones core. */

describe("the engines as built-in plugins", () => {
  const directories = temporaryDirectories();
  afterEach(() => directories.cleanup());

  it("leaves a disabled engine's tools out from the next start, and never disables the confinement", async () => {
    const dataDir = directories.create("tavi-engines-");
    const options = fixtureRuntimeOptions(dataDir, { scheduleSweepEnabled: false });
    // A decoder stands in for the host's FFmpeg, so the video tools are offered whatever is installed here.
    const overrides = { requireModelTransport: false, videoDecoderOverride: { close: async () => undefined } as never };
    const first = await composeTaviRuntime(options, overrides);
    try {
      expect(first.tools.get("browser.navigate")).toBeDefined();
      expect(first.tools.get("pdf.read")).toBeDefined();
      expect(first.tools.list().some((tool) => tool.id.startsWith("video."))).toBe(true);
      for (const id of ["tavi.browser", "tavi.pdf", "tavi.video"]) await first.plugins.registry.disable(id, "operator");
      for (const id of ["tavi.sandbox", "tavi.limits", "tavi.worker"])
        await expect(first.plugins.registry.disable(id, "operator")).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await first.close();
    }
    const second = await composeTaviRuntime(options, overrides);
    try {
      const ids = second.tools.list().map((tool) => tool.id);
      expect(ids.filter((id) => id.startsWith("browser.") || id.startsWith("pdf.") || id.startsWith("video."))).toEqual([]);
      expect(ids).toContain("fs.read");
    } finally {
      await second.close();
    }
  });
});

describe("the browser worker, with the browser engine off", () => {
  it("is not a built-in agent to spawn: it would be told to browse with no browser", async () => {
    const repository = { get: async () => undefined } as unknown as Parameters<typeof withBuiltinAgents>[0];
    expect(await withBuiltinAgents(repository).get("default", BROWSER_WORKER_AGENT_ID)).toMatchObject({ agentId: "browser" });
    expect(await withBuiltinAgents(repository, false).get("default", BROWSER_WORKER_AGENT_ID)).toBeUndefined();
  });
});
