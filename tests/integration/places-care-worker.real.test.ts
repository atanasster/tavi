import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createSrtConfinement } from "@tavi/plugin-sandbox/srt-cli";
import { createPluginIsolation } from "@tavi/plugin-worker";
import { confinedPluginWorker } from "@tavi/test-support/plugin-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The package under test, from the repository's tests. */
const packageDirectory = join(import.meta.dirname, "..", "..", "packages", "external", "places-care");

/**
 * The built places.care bundle in a real confined worker: its store in
 * its home, kept across a stop, and nothing outside its home written. Run
 * after `pnpm --filter @tavi/plugin-places-care build`; macOS always, Linux in the
 * sandbox matrix.
 */
const worker = confinedPluginWorker({
  pluginId: "places.care",
  bundle: join(packageDirectory, "dist-plugin"),
  isolation: ({ caDirectory, ...paths }) => createPluginIsolation({ confinement: createSrtConfinement({ caDirectory }), ...paths }),
});

describe.skipIf(!worker.runs)(`places.care in a confined worker (${process.platform})`, () => {
  beforeAll(() => worker.prepare("tavi-care-worker-"));
  afterAll(() => worker.cleanup());

  it("keeps care.db in its home across stops, and answers sources with no request", async () => {
    const handle = await worker.start();
    try {
      const sources = (await worker.call(handle, "sources")) as { sources: { id: string }[]; payers: { id: string; directory: string }[] };
      expect(sources.sources.map((source) => source.id).sort()).toEqual(["cms-dc", "npi", "plannet-humana"]);
      expect(sources.payers.find((payer) => payer.id === "humana")).toMatchObject({ directory: "plan-net" });
    } finally {
      await handle.stop();
    }
    expect(existsSync(join(worker.home, "care.db"))).toBe(true);
    const again = await worker.start();
    try {
      expect(await worker.call(again, "sources")).toMatchObject({ recentRequests: [] });
    } finally {
      await again.stop();
    }
    expect(readdirSync(join(worker.root, "data", "plugins", "places.care"))).toEqual(["home"]);
  });
});
