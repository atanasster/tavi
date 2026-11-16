import { existsSync } from "node:fs";
import { join } from "node:path";

import { createSrtConfinement } from "@tavi/plugin-sandbox/srt-cli";
import { createPluginIsolation } from "@tavi/plugin-worker";
import { confinedPluginWorker } from "@tavi/test-support/plugin-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The package under test, from the repository's tests. */
const packageDirectory = join(import.meta.dirname, "..", "..", "packages", "external", "jobs");

/**
 * The built jobs.finder bundle in a real confined worker: its store in
 * its home, kept across a stop, and nothing outside its home written. Run
 * after `pnpm --filter @tavi/plugin-jobs build`; macOS always, Linux in the
 * sandbox matrix.
 */
const worker = confinedPluginWorker({
  pluginId: "jobs.finder",
  bundle: join(packageDirectory, "dist-plugin"),
  isolation: ({ caDirectory, ...paths }) => createPluginIsolation({ confinement: createSrtConfinement({ caDirectory }), ...paths }),
  effect: (tool) => (tool === "track" || tool === "ingest" ? "write" : "read"),
});

describe.skipIf(!worker.runs)(`jobs.finder in a confined worker (${process.platform})`, () => {
  beforeAll(() => worker.prepare("tavi-jobs-worker-"));
  afterAll(() => worker.cleanup());

  const profile = {
    titles: ["Nurse"],
    skills: [],
    places: [],
    remote: "open",
    remoteRegions: [],
    employmentTypes: [],
    exclusions: { companies: [], keywords: [] },
    needsSponsorship: [],
  };

  it("keeps jobs.db and what the person saved in its home across stops, and answers sink-none tools with no request", async () => {
    const handle = await worker.start();
    try {
      const sources = (await worker.call(handle, "sources")) as { sources: { id: string; on: boolean }[] };
      expect(sources.sources.map((source) => source.id)).toContain("greenhouse");
      expect(await worker.call(handle, "pipeline")).toMatchObject({ counts: { saved: 0 } });
    } finally {
      await handle.stop();
    }
    expect(existsSync(join(worker.home, "jobs.db"))).toBe(true);
    const again = await worker.start();
    let postingId = "";
    try {
      expect(await worker.call(again, "pipeline")).toMatchObject({ counts: { saved: 0 } });
      await expect(worker.call(again, "track", { postingId: "greenhouse:nope", state: "saved" })).rejects.toThrow(/no posting/);
      // Something the person keeps: a posting the agent gathered, saved to the pipeline.
      const ingested = (await worker.call(again, "ingest", {
        items: [
          { kind: "record", url: "https://jobs.example.org/42", title: "Nurse", company: "City Hospital", location: "Berlin, Germany" },
        ],
      })) as { kept: { postingId: string }[] };
      postingId = ingested.kept[0]?.postingId ?? "";
      await worker.call(again, "track", { postingId, state: "saved" });
    } finally {
      await again.stop();
    }
    const third = await worker.start();
    try {
      // What was saved survives the stop.
      expect(await worker.call(third, "pipeline")).toMatchObject({ counts: { saved: 1 }, applications: [{ postingId, state: "saved" }] });
      // match is sink none: the worker refuses any request it would make, so an answer is one made with none.
      expect(await worker.call(third, "match", { postingIds: [postingId], profile })).toMatchObject({ results: [{ postingId }] });
    } finally {
      await third.stop();
    }
  }, 180_000);
});
