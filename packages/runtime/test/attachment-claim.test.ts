import { join } from "node:path";

import { chatOwnsArtifact, untrustedLabel } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

/**
 * An attachment given the chat it arrived in: an upload (`art-up-`) or a
 * channel message's file (`art-in-`), once, by the first chat; never
 * anything else. Claimed, only that chat's tools read it.
 */

const stores: SqliteStore[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});

function fixture(): SqliteStore {
  const directory = directories.create("tavi-attachment-claim-");
  const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  stores.push(store);
  return store;
}

const put = (store: SqliteStore, artifactId: string, untrusted = true) =>
  store.putArtifact({
    artifactId,
    workspaceId: "w1",
    contentType: "audio/ogg",
    body: artifactId,
    extension: "ogg",
    ...(untrusted ? { untrusted: true, label: untrustedLabel("attachment") } : {}),
  });

describe("claimAttachmentForRun", () => {
  it("gives an upload or a channel's file to the first chat that claims it, and nothing else", () => {
    const store = fixture();
    put(store, "art-in-voice");
    put(store, "art-up-form");
    put(store, "art-in-trusted", false);
    put(store, "art-report");
    for (const artifactId of ["art-in-voice", "art-up-form", "art-in-trusted", "art-report"])
      store.claimAttachmentForRun({ artifactId, runId: "task-1" });
    // A second chat never takes it over.
    store.claimAttachmentForRun({ artifactId: "art-in-voice", runId: "task-2" });
    expect(store.getArtifact("art-in-voice")?.runId).toBe("task-1");
    expect(store.getArtifact("art-up-form")?.runId).toBe("task-1");
    expect(store.getArtifact("art-in-trusted")?.runId).toBeNull();
    expect(store.getArtifact("art-report")?.runId).toBeNull();
  });
});

describe("chatOwnsArtifact", () => {
  const attachment = { untrusted: true as const, label: untrustedLabel("attachment") };
  it("keeps a claimed attachment to its chat, and leaves the rest to the workspace check", () => {
    expect(chatOwnsArtifact({ ...attachment, runId: "task-1" }, { runId: "task-1" })).toBe(true);
    expect(chatOwnsArtifact({ ...attachment, runId: "task-1" }, { runId: "worker-1", chatTaskId: "task-1" })).toBe(true);
    expect(chatOwnsArtifact({ ...attachment, runId: "task-1" }, { runId: "task-2" })).toBe(false);
    // Not claimed (kept before claims, or its message started no turn): the workspace's, as before.
    expect(chatOwnsArtifact({ ...attachment, runId: null }, { runId: "task-2" })).toBe(true);
    // Not an attachment: a chat's own download or report keeps its tool's rule.
    expect(chatOwnsArtifact({ runId: "task-1" }, { runId: "task-2" })).toBe(true);
    expect(chatOwnsArtifact({ untrusted: true, label: untrustedLabel("web"), runId: "task-1" }, { runId: "task-2" })).toBe(true);
  });
});
