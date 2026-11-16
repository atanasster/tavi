import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * A heartbeat signal source over a JSON feed (docs/HEARTBEAT-PLUGINS.md),
 * for tests: each job in the feed whose status is `failed` is a signal, keyed
 * by the job's id and hashed over what it says, so a job that changes is new
 * again. Model-free, and its titles are treated as untrusted text.
 */

export function createQueueSource(feed) {
  return {
    id: "queue",
    async collect({ signal }) {
      const jobs = JSON.parse(await readFile(feed, { encoding: "utf8", signal }));
      return jobs
        .filter((job) => job.status === "failed")
        .map((job) => ({
          key: `job:${job.id}`,
          hash: createHash("sha256").update(JSON.stringify([job.name, job.status, job.at])).digest("hex"),
          title: `Job ${job.name} failed`,
          at: job.at,
          source: "Job queue",
        }));
    },
  };
}

export function register({ config, provideSignals }) {
  provideSignals(createQueueSource(config.feed));
}
