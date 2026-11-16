import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createSrtConfinement } from "@tavi/plugin-sandbox/srt-cli";
import { createPluginIsolation } from "@tavi/plugin-worker";
import { confinedPluginWorker } from "@tavi/test-support/plugin-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The package under test, from the repository's tests. */
const packageDirectory = join(import.meta.dirname, "..", "..", "packages", "external", "places-open");

/**
 * The built places.open bundle in a real confined worker: its store in
 * its home, kept across a stop, and nothing outside its home written. Run
 * after `pnpm --filter @tavi/plugin-places-open build`; macOS always, Linux in the
 * sandbox matrix.
 */
const worker = confinedPluginWorker({
  pluginId: "places.open",
  bundle: join(packageDirectory, "dist-plugin"),
  isolation: ({ caDirectory, ...paths }) => createPluginIsolation({ confinement: createSrtConfinement({ caDirectory }), ...paths }),
});

describe.skipIf(!worker.runs)(`places.open in a confined worker (${process.platform})`, () => {
  beforeAll(() => worker.prepare("tavi-places-worker-"));
  afterAll(() => worker.cleanup());

  it("keeps places.db in its home across stops, and answers sink-none tools with no request", async () => {
    const handle = await worker.start();
    try {
      const sources = (await worker.call(handle, "sources")) as { sources: { id: string; on: boolean }[] };
      expect(sources.sources.map((source) => source.id).sort()).toEqual([
        "afdc",
        "at-econtrol",
        "de-bnetza",
        "es-geoportal",
        "eu-oil-bulletin",
        "fr-carburants",
        "it-mimit",
        "nominatim",
        "nsw-fuelcheck",
        "nyc-311",
        "nyc-dob",
        "ocm",
        "open311-boston",
        "open311-sf",
        "ors",
        "overpass",
        "overture",
        "photon",
        "police-uk",
        "tankerkoenig",
        "tdlr",
        "us-eia",
        "wa-fuelwatch",
      ]);
      // compare reads only the store: the worker's noNetwork guard would refuse a request.
      expect(await worker.call(handle, "compare", { placeIds: ["pl_0000000000000000"] })).toMatchObject({ rows: [{ missing: true }] });
    } finally {
      await handle.stop();
    }
    expect(existsSync(join(worker.home, "places.db"))).toBe(true);
    const again = await worker.start();
    try {
      expect(await worker.call(again, "compare", { placeIds: ["pl_0000000000000000"] })).toMatchObject({ rows: [{ missing: true }] });
    } finally {
      await again.stop();
    }
    // Nothing outside its home was written.
    expect(readdirSync(join(worker.root, "data", "plugins", "places.open"))).toEqual(["home"]);
  });
});
