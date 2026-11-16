import { existsSync } from "node:fs";
import { join } from "node:path";

import type { PluginWorkerServices } from "@tavi/contracts";
import { createSrtConfinement } from "@tavi/plugin-sandbox/srt-cli";
import { createPluginIsolation } from "@tavi/plugin-worker";
import { confinedPluginWorker, quietWorkerServices } from "@tavi/test-support/plugin-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The package under test, from the repository's tests. */
const packageDirectory = join(import.meta.dirname, "..", "..", "packages", "external", "trends");

/**
 * The built trends.radar bundle in a real confined worker: its stores
 * in its home, kept across a stop, and the store-only tools answered with no
 * request. Run after `pnpm --filter @tavi/plugin-trends build`; macOS always,
 * Linux in the sandbox matrix.
 */
const worker = confinedPluginWorker({
  pluginId: "trends.radar",
  bundle: join(packageDirectory, "dist-plugin"),
  isolation: ({ caDirectory, ...paths }) => createPluginIsolation({ confinement: createSrtConfinement({ caDirectory }), ...paths }),
  effect: (tool) => (tool === "watch" ? "write" : "read"),
});

describe.skipIf(!worker.runs)(`trends.radar in a confined worker (${process.platform})`, () => {
  beforeAll(() => worker.prepare("tavi-trends-worker-"));
  afterAll(() => worker.cleanup());

  it("keeps trends.db and the person's topics in its home across stops, and answers sink-none tools with no request", async () => {
    const handle = await worker.start();
    let topicId = "";
    try {
      const first = await worker.call(handle, "topics");
      expect(first).toEqual({ topics: [] });
      const sources = (await worker.call(handle, "sources")) as {
        sources: { id: string; on: boolean; needs?: string }[];
        excluded: { id: string }[];
      };
      expect(sources.sources.map((source) => source.id)).toContain("gdelt-doc");
      // A key setting that holds nothing reads as not set, never as a failure.
      expect(sources.sources.find((source) => source.id === "threads")).toMatchObject({ on: false, needs: "key" });
      expect(sources.excluded.map((entry) => entry.id)).toContain("telegram");
      const added = (await worker.call(handle, "watch", {
        op: "add",
        topic: { label: "Solid-state batteries", terms: { en: ["solid-state battery"] } },
      })) as { topic: { topicId: string } };
      topicId = added.topic.topicId;
    } finally {
      await handle.stop();
    }
    expect(existsSync(join(worker.home, "trends.db"))).toBe(true);
    expect(existsSync(join(worker.home, "cache", "items.db"))).toBe(true);
    const again = await worker.start();
    try {
      expect(await worker.call(again, "topics")).toMatchObject({ topics: [{ topicId, label: "Solid-state batteries", state: "quiet" }] });
      // velocity and brief are sink none: the worker refuses any request they would make, so an answer is one made with none.
      expect(await worker.call(again, "velocity", { topicId, window: "7d" })).toMatchObject({ topicId, series: [], tests: [] });
      expect(
        await worker.call(again, "brief", { topicId, bullets: [{ text: "Reuters reported it.", cites: ["gdelt-doc:none"] }] }),
      ).toMatchObject({ ok: false, problems: [{ problem: "unknown-item" }] });
    } finally {
      await again.stop();
    }
  }, 180_000);

  it("holds header keys only as the proxy's placeholders and asks the owner only for its rawSecrets", async () => {
    const asked: string[] = [];
    const keyed: PluginWorkerServices = { ...quietWorkerServices, rawSecret: async (key) => (asked.push(key), `raw-${key}`) };
    const masked = { naverClientId: "masked-nid", naverClientSecret: "masked-nsecret", threadsToken: "masked-th" };
    const handle = await worker.start({ services: keyed, maskedSecrets: masked });
    try {
      const sources = (await worker.call(handle, "sources")) as { sources: { id: string; needs?: string }[] };
      // Every keyed source sees its keys set: the header keys through the worker's masked environment, the rest from the owner.
      for (const id of ["naver-datalab", "threads", "youtube"])
        expect(
          sources.sources.find((source) => source.id === id),
          id,
        ).not.toHaveProperty("needs");
      // Only rawSecrets were ever asked of the owner: a header key's value never reaches the worker raw.
      expect(new Set(asked)).toEqual(new Set(["youtubeKey", "googleTrendsKey", "redditClientId", "redditSecret"]));
    } finally {
      await handle.stop();
    }
  }, 180_000);
});
