import { existsSync } from "node:fs";
import { join } from "node:path";

import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * Browser history on the owner: a
 * restart closes the sessions the previous owner left open, and the retention
 * sweep deletes history older than 30 days with its thumbnails even when the
 * deployment never opted into the artifact sweep.
 */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

async function start(
  directory: string,
  extra: { readonly retentionSweepEnabled?: boolean; readonly retentionSweepIntervalMs?: number } = {},
): Promise<ServeHandle> {
  const handle = await serve(
    fixtureServeOptions(directory, { ...extra }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  return handle;
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe("browser history on the owner", () => {
  it("closes sessions left open by the previous owner and sweeps history past 30 days, thumbnails included", async () => {
    const directory = directories.create("tavi-browser-history-");

    // The first owner: a task with an old session (and its thumbnail), a
    // recent one still open when the owner stops, and an ordinary old artifact.
    const first = await start(directory);
    const repositories = first.runtime.store.asPort().repositories;
    await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-browse",
      kind: "start",
      intent: { prompt: "browse" },
      checkpointNamespace: "",
      newTaskId: "task-browse",
      newAdmissionId: "adm-browse",
      newThreadId: "thread-browse",
      now: nowTimestamp(),
    });
    await repositories.browserHistory.open({ sessionId: "old", workspaceId: "default", taskId: "task-browse", openedAt: daysAgo(40) });
    await repositories.browserHistory.recordPage({ sessionId: "old", url: "https://example.com/old?token=x", at: daysAgo(40) });
    const thumbnail = await repositories.artifacts.putArtifact({
      workspaceId: "default",
      runId: "task-browse",
      contentType: "image/jpeg",
      body: new Uint8Array([0xff, 0xd8, 0xff]),
      extension: "jpg",
      reviewState: "approved",
      purpose: "thumbnail",
    });
    await repositories.browserHistory.setThumbnail({ sessionId: "old", artifactId: thumbnail.artifactId });
    await repositories.browserHistory.close({ sessionId: "old", closedAt: daysAgo(40), reason: "closed" });
    await repositories.browserHistory.open({ sessionId: "live", workspaceId: "default", taskId: "task-browse", openedAt: daysAgo(1) });
    const capture = await repositories.artifacts.putArtifact({
      workspaceId: "default",
      runId: "task-browse",
      contentType: "image/png",
      body: "png",
      extension: "png",
    });
    const thumbnailFile = join(directory, "artifacts", thumbnail.relativePath);
    const captureFile = join(directory, "artifacts", capture.relativePath);
    expect(existsSync(thumbnailFile)).toBe(true);
    await first.shutdown("restart");
    handles.pop();

    // The second owner, with the retention sweep but not the artifact sweep.
    const second = await start(directory, { retentionSweepEnabled: true, retentionSweepIntervalMs: 100 });
    const history = second.runtime.store.asPort().repositories.browserHistory;
    const deadline = Date.now() + 10_000;
    const sessions = async () => history.sessions({ workspaceId: "default", limit: 10 });
    while (Date.now() < deadline) {
      const rows = await sessions();
      if (rows.length === 1 && rows[0]?.closedAt !== null) break;
      await delay(50);
    }
    expect(await sessions()).toEqual([expect.objectContaining({ sessionId: "live", closeReason: "owner restarted" })]);
    expect(await history.visitPage({ workspaceId: "default", sessionId: "old", limit: 10 })).toBeUndefined();
    expect(await second.runtime.store.asPort().repositories.artifacts.getArtifact(thumbnail.artifactId)).toBeUndefined();
    expect(existsSync(thumbnailFile)).toBe(false);
    // Not a browser thumbnail: kept, as the artifact sweep is off.
    expect(await second.runtime.store.asPort().repositories.artifacts.getArtifact(capture.artifactId)).toBeDefined();
    expect(existsSync(captureFile)).toBe(true);
  }, 30_000);
});
