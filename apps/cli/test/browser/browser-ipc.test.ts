import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { fixturePromptPolicy } from "../support/prompt-policy.js";
import {
  ARTIFACT_READ_CHUNK_BYTES,
  type ArtifactReadAnswer,
  type ArtifactRecord,
  type ArtifactsResult,
  type BrowserListAnswer,
  type BrowserSessionListing,
  type BrowserVisitsAnswer,
  type CenterSummaryAnswer,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { artifactsReadCommand, browserCommand, type BrowserDependencies } from "../../src/features/browser/owner.js";
import { browserProfileDirectory } from "../../src/features/browser/profile.js";
import { SqliteStore } from "../support/database-fixture.js";
import { BROWSER_USAGE } from "../../src/features/browser/parse.js";
import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `browser` and `artifacts read`: the Command
 * Center's browser history over IPC — live and earlier sessions, paging, the
 * workspace check, scrubbed URLs only — and thumbnails as the only artifacts
 * `artifacts read` serves; then `tavi browser history`.
 */

const directories = temporaryDirectories({ prefix: "tavi-browser-ipc-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

async function owner(dataDirectory: string): Promise<ServeHandle> {
  const handle = await serve(
    fixtureServeOptions(dataDirectory, {
      workspaces: [
        { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
        { workspaceId: "other", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
      ],
      reminderSweepEnabled: false,
    }),
    { dataDirectory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  return handle;
}

async function connect(dataDirectory: string): Promise<IpcClient> {
  const discovered = await findLiveOwner(dataDirectory);
  if (discovered === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return client;
}

// One reference instant, so an opened/closed pair is exactly the minutes apart it says.
const SEEDED_AT = Date.now();
const minutesAgo = (minutes: number) => new Date(SEEDED_AT - minutes * 60_000).toISOString();
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** Two tasks: one with a live session and two closed ones in `default`, one with a session in `other`. */
async function seed(handle: ServeHandle) {
  const repositories = handle.runtime.store.asPort().repositories;
  const admit = (taskId: string, workspaceId: string) =>
    repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId,
      principalId: "operator",
      operationKey: `op-${taskId}`,
      kind: "start",
      intent: { prompt: `Browse for ${taskId}\nmore` },
      checkpointNamespace: "",
      newTaskId: taskId,
      newAdmissionId: `adm-${taskId}`,
      newThreadId: `thread-${taskId}`,
      now: nowTimestamp(),
    });
  await admit("task-a", "default");
  await admit("task-z", "other");
  const history = repositories.browserHistory;
  await history.open({ sessionId: "s-old", workspaceId: "default", taskId: "task-a", openedAt: minutesAgo(90) });
  await history.recordPage({
    sessionId: "s-old",
    url: "https://shop.example.com/cart?session=secret#pay",
    title: "Cart",
    at: minutesAgo(89),
  });
  await history.close({ sessionId: "s-old", closedAt: minutesAgo(80), reason: "closed" });
  await history.open({ sessionId: "s-mid", workspaceId: "default", taskId: "task-a", openedAt: minutesAgo(60) });
  await history.close({ sessionId: "s-mid", closedAt: minutesAgo(55), reason: "closed" });
  await history.open({
    sessionId: "s-live",
    workspaceId: "default",
    taskId: "task-a",
    openedAt: minutesAgo(18),
    openedByCallId: "call-open-live",
  });
  for (let index = 1; index <= 3; index += 1) {
    await history.recordPage({
      sessionId: "s-live",
      url: `https://docs.example.com/p${index}?q=term`,
      title: `Page ${index}`,
      at: minutesAgo(18 - index),
    });
  }
  const thumbnail = await repositories.artifacts.putArtifact({
    workspaceId: "default",
    runId: "task-a",
    contentType: "image/jpeg",
    body: JPEG,
    extension: "jpg",
    reviewState: "approved",
    purpose: "thumbnail",
  });
  await history.setThumbnail({ sessionId: "s-live", artifactId: thumbnail.artifactId });
  const ordinary = await repositories.artifacts.putArtifact({
    workspaceId: "default",
    runId: "task-a",
    contentType: "image/png",
    body: "png",
    extension: "png",
  });
  await history.open({ sessionId: "s-other", workspaceId: "other", taskId: "task-z", openedAt: minutesAgo(5) });
  const otherThumbnail = await repositories.artifacts.putArtifact({
    workspaceId: "other",
    runId: "task-z",
    contentType: "image/jpeg",
    body: JPEG,
    extension: "jpg",
    reviewState: "approved",
    purpose: "thumbnail",
  });
  await history.setThumbnail({ sessionId: "s-other", artifactId: otherThumbnail.artifactId });
  return { thumbnail, ordinary, otherThumbnail };
}

async function request(client: IpcClient, command: string, payload: Record<string, unknown>) {
  return await client.request(command, payload, `${command}-${Math.random().toString(36).slice(2)}`);
}

describe("browser on a live owner", () => {
  it("lists live and earlier sessions newest first, pages them, and keeps to the workspace", async () => {
    const dataDirectory = directories.create();
    const handle = await owner(dataDirectory);
    const { thumbnail } = await seed(handle);
    const client = await connect(dataDirectory);

    const live = await request(client, "browser", { action: "list", workspaceId: "default", open: true });
    expect(live.ok).toBe(true);
    const liveAnswer = live.result as BrowserListAnswer;
    expect(liveAnswer.items).toHaveLength(1);
    expect(liveAnswer.nextCursor).toBeUndefined();
    const [session] = liveAnswer.items;
    expect(session).toMatchObject({
      sessionId: "s-live",
      taskId: "task-a",
      taskTitle: "Browse for task-a",
      principalId: "operator",
      live: true,
      closedAt: null,
      lastUrl: "https://docs.example.com/p3",
      host: "docs.example.com",
      lastTitle: "Page 3",
      pages: 3,
      thumbnail: { artifactId: thumbnail.artifactId },
      // The call that opened it, for the Command Center to open the task at.
      openedByCallId: "call-open-live",
    });
    expect(session?.durationMs).toBeGreaterThanOrEqual(18 * 60_000 - 1_000);

    const first = (await request(client, "browser", { action: "list", workspaceId: "default", open: false, limit: 1 }))
      .result as BrowserListAnswer;
    expect(first.items.map((item) => item.sessionId)).toEqual(["s-mid"]);
    expect(first.items[0]).toMatchObject({ live: false, durationMs: 5 * 60_000, lastUrl: null, host: null, pages: 0 });
    expect(first.items[0]?.thumbnail).toBeUndefined();
    // A session recorded without its call names none.
    expect(first.items[0]?.openedByCallId).toBeUndefined();
    expect(first.nextCursor).toBeDefined();
    const second = (
      await request(client, "browser", { action: "list", workspaceId: "default", open: false, limit: 1, cursor: first.nextCursor })
    ).result as BrowserListAnswer;
    expect(second.items.map((item) => item.sessionId)).toEqual(["s-old"]);
    expect(second.items[0]).toMatchObject({ lastUrl: "https://shop.example.com/cart", host: "shop.example.com", closeReason: "closed" });
    expect(second.nextCursor).toBeUndefined();

    // A closed list's cursor does not page the live one.
    const crossed = await request(client, "browser", { action: "list", workspaceId: "default", open: true, cursor: first.nextCursor });
    expect(crossed.ok).toBe(false);
    expect(crossed.error?.code).toBe("INVALID_INPUT");

    const all = (await request(client, "browser", { action: "list", workspaceId: "default" })).result as BrowserListAnswer;
    expect(all.items.map((item) => item.sessionId)).toEqual(["s-live", "s-mid", "s-old"]);
    // One task's sessions only, paged under that task.
    const mine = (await request(client, "browser", { action: "list", workspaceId: "default", taskId: "task-a", limit: 2 }))
      .result as BrowserListAnswer;
    expect(mine.items.map((item) => item.sessionId)).toEqual(["s-live", "s-mid"]);
    expect(
      (
        (await request(client, "browser", { action: "list", workspaceId: "default", taskId: "task-a", cursor: mine.nextCursor }))
          .result as BrowserListAnswer
      ).items.map((item) => item.sessionId),
    ).toEqual(["s-old"]);
    expect(await request(client, "browser", { action: "list", workspaceId: "default", cursor: mine.nextCursor })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(
      ((await request(client, "browser", { action: "list", workspaceId: "default", taskId: "task-none" })).result as BrowserListAnswer)
        .items,
    ).toEqual([]);
    expect(JSON.stringify(all)).not.toMatch(/secret|term|#pay|\?/);

    const other = (await request(client, "browser", { action: "list", workspaceId: "other" })).result as BrowserListAnswer;
    expect(other.items.map((item) => item.sessionId)).toEqual(["s-other"]);
    const unknown = await request(client, "browser", { action: "list", workspaceId: "nowhere" });
    expect(unknown.error?.code).toBe("NOT_FOUND");

    // The summary counts live sessions.
    const summary = (await request(client, "center", { action: "summary", workspaceId: "default" })).result as CenterSummaryAnswer;
    expect(summary.counts.liveBrowserSessions).toBe(1);
  });

  it("pages a session's visits, scrubbed, and refuses another workspace's session", async () => {
    const dataDirectory = directories.create();
    const handle = await owner(dataDirectory);
    await seed(handle);
    const client = await connect(dataDirectory);

    const first = (await request(client, "browser", { action: "visits", workspaceId: "default", sessionId: "s-live", limit: 2 }))
      .result as BrowserVisitsAnswer;
    expect(first.items.map((visit) => [visit.seq, visit.url, visit.title])).toEqual([
      [1, "https://docs.example.com/p1", "Page 1"],
      [2, "https://docs.example.com/p2", "Page 2"],
    ]);
    const rest = (
      await request(client, "browser", {
        action: "visits",
        workspaceId: "default",
        sessionId: "s-live",
        limit: 2,
        cursor: first.nextCursor,
      })
    ).result as BrowserVisitsAnswer;
    expect(rest.items.map((visit) => visit.seq)).toEqual([3]);
    expect(rest.nextCursor).toBeUndefined();

    const elsewhere = await request(client, "browser", { action: "visits", workspaceId: "default", sessionId: "s-other" });
    expect(elsewhere.error?.code).toBe("NOT_FOUND");
    const crossed = await request(client, "browser", {
      action: "visits",
      workspaceId: "default",
      sessionId: "s-old",
      cursor: first.nextCursor,
    });
    expect(crossed.error?.code).toBe("INVALID_INPUT");
    const tooMany = await request(client, "browser", { action: "visits", workspaceId: "default", sessionId: "s-live", limit: 201 });
    expect(tooMany.ok).toBe(false);
  });

  it("reads a thumbnail's bytes and nothing else through artifacts read", async () => {
    const dataDirectory = directories.create();
    const handle = await owner(dataDirectory);
    const { thumbnail, ordinary, otherThumbnail } = await seed(handle);
    const client = await connect(dataDirectory);

    const read = await request(client, "artifacts", { action: "read", workspaceId: "default", artifactId: thumbnail.artifactId });
    expect(read.ok).toBe(true);
    const answer = read.result as ArtifactReadAnswer;
    expect(answer).toMatchObject({
      artifactId: thumbnail.artifactId,
      contentType: "image/jpeg",
      totalBytes: JPEG.length,
      offset: 0,
      nextOffset: null,
    });
    expect([...Buffer.from(answer.base64, "base64")]).toEqual([...JPEG]);

    for (const [workspaceId, artifactId] of [
      ["default", ordinary.artifactId],
      ["default", otherThumbnail.artifactId],
      ["default", "art-missing"],
    ] as const) {
      const refused = await request(client, "artifacts", { action: "read", workspaceId, artifactId });
      expect(refused.ok, artifactId).toBe(false);
      expect(refused.error?.code).toBe("NOT_FOUND");
    }
    const past = await request(client, "artifacts", {
      action: "read",
      workspaceId: "default",
      artifactId: thumbnail.artifactId,
      offset: JPEG.length + 1,
    });
    expect(past.error?.code).toBe("INVALID_INPUT");
    // A list, with no action, is what it was.
    const listed = await request(client, "artifacts", { workspaceId: "default", includeDecided: true });
    expect((listed.result as ArtifactsResult).rows.map((row) => row.artifactId)).toEqual([ordinary.artifactId]);
  });
});

describe("the browser command over a repository", () => {
  const deps = (overrides: {
    sessions?: readonly BrowserSessionListing[];
    record?: ArtifactRecord;
    body?: Uint8Array;
  }): BrowserDependencies =>
    ({
      repositories: {
        browserHistory: {
          sessions: async () => overrides.sessions ?? [],
          visitPage: async () => [
            { sessionId: "s1", seq: 1, url: "https://example.com/a?token=secret#x", title: null, at: "2026-09-30T10:00:00.000Z" },
          ],
        },
        artifacts: {
          getArtifact: async () => overrides.record,
          readArtifactBody: async () => overrides.body,
        },
      },
      principalOf: (workspaceId: string) => (workspaceId === "default" ? "operator" : undefined),
      now: () => new Date("2026-09-30T10:30:00.000Z"),
    }) as unknown as BrowserDependencies;

  it("scrubs a URL again on the way out, whatever the row holds", async () => {
    const listing: BrowserSessionListing = {
      sessionId: "s1",
      workspaceId: "default",
      taskId: "t1",
      openedAt: "2026-09-30T10:00:00.000Z",
      closedAt: null,
      closeReason: null,
      lastUrl: "https://user:pw@example.com/a?token=secret#x",
      lastTitle: "A",
      thumbnailArtifactId: null,
      pages: 1,
      openedByCallId: null,
      inactiveSince: null,
      taskTitle: null,
      principalId: "operator",
    };
    const listed = await browserCommand(deps({ sessions: [listing] }), { action: "list" });
    expect(listed.ok && listed.result).toMatchObject({
      items: [{ lastUrl: "https://example.com/a", host: "example.com", live: true, durationMs: 30 * 60_000 }],
    });
    const visits = await browserCommand(deps({}), { action: "visits", sessionId: "s1" });
    expect(visits.ok && visits.result).toMatchObject({ items: [{ url: "https://example.com/a" }] });
  });

  it("reads a large thumbnail in 256 KiB chunks", async () => {
    const body = new Uint8Array(ARTIFACT_READ_CHUNK_BYTES * 2 + 100).map((_, index) => index % 251);
    const record = {
      artifactId: "art-big",
      workspaceId: "default",
      runId: "t1",
      relativePath: "default/art-big.jpg",
      contentType: "image/jpeg",
      byteSize: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      createdAt: "2026-09-30T10:00:00.000Z",
      reviewState: "approved",
      reviewedBy: null,
      reviewedAt: null,
      purpose: "thumbnail",
    } as ArtifactRecord;
    const chunks: Buffer[] = [];
    let offset: number | null = 0;
    const offsets: number[] = [];
    while (offset !== null) {
      offsets.push(offset);
      const answer = await artifactsReadCommand(deps({ record, body }), {
        action: "read",
        workspaceId: "default",
        artifactId: "art-big",
        offset,
      });
      if (!answer.ok) throw new Error(answer.error.message);
      chunks.push(Buffer.from(answer.result.base64, "base64"));
      offset = answer.result.nextOffset;
    }
    expect(offsets).toEqual([0, ARTIFACT_READ_CHUNK_BYTES, ARTIFACT_READ_CHUNK_BYTES * 2]);
    expect(Buffer.concat(chunks).equals(Buffer.from(body))).toBe(true);

    const damaged = await artifactsReadCommand(deps({ record, body: body.slice(1) }), {
      action: "read",
      workspaceId: "default",
      artifactId: "art-big",
    });
    expect(damaged.ok || damaged.error.code).toBe("UNAVAILABLE");
    const { purpose: _purpose, ...plain } = record;
    const ordinary = await artifactsReadCommand(deps({ record: plain, body }), {
      action: "read",
      workspaceId: "default",
      artifactId: "art-big",
    });
    expect(ordinary.ok || ordinary.error.code).toBe("NOT_FOUND");
    const unserved = await artifactsReadCommand(deps({ record, body }), { action: "read", workspaceId: "nowhere", artifactId: "art-big" });
    expect(unserved.ok || unserved.error.code).toBe("NOT_FOUND");
  });

  it("reads a PDF page preview as it reads a thumbnail, and no other workspace's", async () => {
    const body = new Uint8Array([137, 80, 78, 71]);
    const record = {
      artifactId: "art-page",
      workspaceId: "default",
      runId: "t1",
      relativePath: "default/art-page.png",
      contentType: "image/png",
      byteSize: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      createdAt: "2026-10-15T10:00:00.000Z",
      reviewState: "approved",
      reviewedBy: null,
      reviewedAt: null,
      preview: "pdf-fill",
    } as ArtifactRecord;
    const answer = await artifactsReadCommand(deps({ record, body }), { action: "read", workspaceId: "default", artifactId: "art-page" });
    expect(answer.ok && Buffer.from(answer.result.base64, "base64").equals(Buffer.from(body))).toBe(true);
    const other = await artifactsReadCommand(deps({ record: { ...record, workspaceId: "other" }, body }), {
      action: "read",
      workspaceId: "default",
      artifactId: "art-page",
    });
    expect(other.ok || other.error.code).toBe("NOT_FOUND");
    // A whole PDF pdf.view stored, tagged to go with the chat, is not a page preview: never served as one.
    const whole = await artifactsReadCommand(deps({ record: { ...record, contentType: "application/pdf", preview: "pdf-render" }, body }), {
      action: "read",
      workspaceId: "default",
      artifactId: "art-page",
    });
    expect(whole.ok || whole.error.code).toBe("NOT_FOUND");
  });
});

describe("tavi browser history", () => {
  const run = async (dataDirectory: string, ...argv: string[]) => {
    const captured = capture();
    const code = await main(["browser", "history", ...argv, "--data-dir", dataDirectory], { io: captured.io });
    return { code, out: captured.out(), err: captured.err() };
  };

  it("parses its options", () => {
    expect(parseArgs(["browser", "history", "--live", "--limit", "5", "--format", "json"])).toEqual({
      command: "browser",
      browser: { action: "history", workspaceId: "default", live: true, limit: 5, format: "json" },
      format: "json",
    });
    expect(() => parseArgs(["browser", "history", "--limit", "0"])).toThrow(UsageError);
    expect(() => parseArgs(["browser", "list"])).toThrow(UsageError);
    expect(parseArgs(["browser", "--help"])).toEqual({ command: "help", usage: BROWSER_USAGE });
  });

  it("lists through a live owner and offline", async () => {
    const dataDirectory = directories.create();
    const handle = await owner(dataDirectory);
    await seed(handle);

    const live = await run(dataDirectory, "--live", "--format", "json");
    expect(live.code, live.err).toBe(EXIT.ok);
    expect((JSON.parse(live.out) as { sessions: { sessionId: string }[] }).sessions.map((item) => item.sessionId)).toEqual(["s-live"]);
    const text = await run(dataDirectory, "--limit", "2");
    expect(text.code, text.err).toBe(EXIT.ok);
    expect(text.out).toMatch(
      /^LIVE .* 3 pages · 1[78] min {2}docs\.example\.com · Page 3\n {7}task task-a — Browse for task-a\n {7}https:\/\/docs\.example\.com\/p3$/m,
    );
    expect(text.out).toContain("closed");
    expect(text.out).not.toContain("s-old");

    await handles.pop()?.shutdown("offline next");
    const offline = await run(dataDirectory, "--format", "json");
    expect(offline.code, offline.err).toBe(EXIT.ok);
    const sessions = (JSON.parse(offline.out) as { sessions: { sessionId: string; live: boolean }[] }).sessions;
    // The restart cleanup has not run (no owner started since), so the live one is still open.
    expect(sessions.map((item) => item.sessionId)).toEqual(["s-live", "s-mid", "s-old"]);
    expect(offline.out).not.toContain("secret");
  });
});

describe("browser list with tree, while active", () => {
  it("lists a task's sessions and every sub-task's, and needs the task", async () => {
    const asked: unknown[] = [];
    const deps = {
      repositories: { browserHistory: { sessions: async (input: unknown) => (asked.push(input), []) }, artifacts: {} },
      principalOf: () => "operator",
      now: () => new Date("2026-10-03T00:00:00.000Z"),
      taskTree: async (_workspaceId: string, taskId: string) => [taskId, `${taskId}-worker`],
    } as unknown as BrowserDependencies;
    expect(
      await browserCommand(deps, { action: "list", workspaceId: "default", taskId: "t1", tree: true, open: true, limit: 1 }),
    ).toMatchObject({ ok: true });
    expect(asked).toEqual([{ workspaceId: "default", open: true, taskIds: ["t1", "t1-worker"], limit: 2 }]);
    expect(await browserCommand(deps, { action: "list", workspaceId: "default", tree: true })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });
});

describe("browser close", () => {
  const row = (sessionId: string, inactiveSince: string | null): BrowserSessionListing => ({
    sessionId,
    workspaceId: "default",
    taskId: "t1",
    openedAt: "2026-10-03T10:00:00.000Z",
    closedAt: null,
    closeReason: null,
    lastUrl: null,
    lastTitle: null,
    thumbnailArtifactId: null,
    pages: 0,
    openedByCallId: null,
    inactiveSince,
    taskTitle: null,
    principalId: "operator",
  });

  it("closes one session, or every inactive one, through the adapter, and in the record alone when the adapter does not hold it", async () => {
    const asked: unknown[] = [];
    const recorded: unknown[] = [];
    const adapter: string[] = [];
    const rows = [row("s-ended", "2026-10-03T10:05:00.000Z"), row("s-live", null)];
    const deps = {
      repositories: {
        browserHistory: {
          sessions: async (input: { inactive?: boolean }) => (
            asked.push(input), rows.filter((candidate) => input.inactive !== true || candidate.inactiveSince !== null)
          ),
          close: async (input: unknown) => void recorded.push(input),
        },
        artifacts: {},
      },
      principalOf: (workspaceId: string) => (workspaceId === "default" ? "operator" : undefined),
      now: () => new Date("2026-10-03T11:00:00.000Z"),
      closeSession: async (sessionId: string, reason: string) => (adapter.push(`${sessionId}:${reason}`), sessionId === "s-live"),
    } as unknown as BrowserDependencies;

    expect(await browserCommand(deps, { action: "close", workspaceId: "default", sessionId: "s-live" })).toEqual({
      ok: true,
      result: { closed: ["s-live"] },
    });
    expect(adapter).toEqual(["s-live:closed by operator"]);
    expect(recorded).toEqual([]);
    expect(await browserCommand(deps, { action: "close", workspaceId: "default", inactive: true })).toEqual({
      ok: true,
      result: { closed: ["s-ended"] },
    });
    expect(asked.at(-1)).toMatchObject({ workspaceId: "default", open: true, inactive: true });
    // The adapter did not hold it (an owner restarted since): closed in the record.
    expect(recorded).toEqual([{ sessionId: "s-ended", closedAt: "2026-10-03T11:00:00.000Z", reason: "closed by operator" }]);

    expect(await browserCommand(deps, { action: "close", workspaceId: "default", sessionId: "s-gone" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await browserCommand(deps, { action: "close", workspaceId: "default" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await browserCommand(deps, { action: "close", workspaceId: "default", sessionId: "s-live", inactive: true })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await browserCommand(deps, { action: "close", workspaceId: "nowhere", inactive: true })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("closes a session past the first page of open ones, and every inactive one however many", async () => {
    const many = Array.from({ length: 450 }, (_, index) => row(`s-${String(index).padStart(3, "0")}`, "2026-10-03T10:05:00.000Z"));
    const pages: unknown[] = [];
    const deps = {
      repositories: {
        browserHistory: {
          sessions: async (input: { before?: { sessionId: string }; limit: number }) => {
            pages.push(input.before?.sessionId);
            const from =
              input.before === undefined ? 0 : many.findIndex((candidate) => candidate.sessionId === input.before?.sessionId) + 1;
            return many.slice(from, from + Math.min(input.limit, 200));
          },
          close: async () => undefined,
        },
        artifacts: {},
      },
      principalOf: () => "operator",
      now: () => new Date("2026-10-03T11:00:00.000Z"),
    } as unknown as BrowserDependencies;
    expect(await browserCommand(deps, { action: "close", workspaceId: "default", sessionId: "s-300" })).toEqual({
      ok: true,
      result: { closed: ["s-300"] },
    });
    expect(pages).toEqual([undefined, "s-199"]);
    const all = await browserCommand(deps, { action: "close", workspaceId: "default", inactive: true });
    expect(all.ok && (all.result as { closed: string[] }).closed).toHaveLength(450);
  });

  it("lists an inactive session as ended, not live, its time stopping when its task ended", async () => {
    const deps = {
      repositories: { browserHistory: { sessions: async () => [row("s-ended", "2026-10-03T10:05:00.000Z")] }, artifacts: {} },
      principalOf: () => "operator",
      now: () => new Date("2026-10-03T11:00:00.000Z"),
    } as unknown as BrowserDependencies;
    const listed = await browserCommand(deps, { action: "list", workspaceId: "default" });
    expect(listed.ok && (listed.result as BrowserListAnswer).items).toEqual([
      expect.objectContaining({ sessionId: "s-ended", live: false, inactive: true, closedAt: null, durationMs: 5 * 60_000 }),
    ]);
  });

  it("parses tavi browser close", () => {
    expect(parseArgs(["browser", "close", "s1"])).toEqual({
      command: "browser",
      browser: { action: "close", workspaceId: "default", inactive: false, sessionId: "s1" },
    });
    expect(parseArgs(["browser", "close", "--inactive", "--workspace", "w2"])).toEqual({
      command: "browser",
      browser: { action: "close", workspaceId: "w2", inactive: true },
    });
    expect(() => parseArgs(["browser", "close"])).toThrow(UsageError);
    expect(() => parseArgs(["browser", "close", "s1", "--inactive"])).toThrow(UsageError);
    expect(() => parseArgs(["browser", "close", "s1", "s2"])).toThrow(UsageError);
    expect(() => parseArgs(["browser", "close", "--limit", "2"])).toThrow(UsageError);
  });

  it("closes through a live owner and offline, and history shows an ended session until then", async () => {
    const dataDirectory = directories.create();
    const handle = await owner(dataDirectory);
    await seed(handle);
    const history = handle.runtime.store.asPort().repositories.browserHistory;
    await history.setInactive({ sessionId: "s-live", since: minutesAgo(10) });
    const run = async (...argv: string[]) => {
      const io = capture();
      const code = await main(["browser", ...argv, "--data-dir", dataDirectory], { io: io.io });
      return { code, out: io.out(), err: io.err() };
    };

    const listed = await run("history", "--limit", "1");
    expect(listed.out).toMatch(/^ENDED .*\n {7}session s-live: kept open for the chat's next turn\n/m);
    expect(await run("close", "s-nope")).toMatchObject({ code: EXIT.usage });
    // tavi doctor counts open sessions, in use and inactive, across workspaces.
    const doctor = capture();
    expect(await main(["doctor", "--data-dir", dataDirectory], { io: doctor.io }), doctor.err()).toBe(EXIT.ok);
    const report = JSON.parse(doctor.out()) as { browserSessions: unknown; browser: { confined: boolean; why?: string; display: string } };
    expect(report.browserSessions).toEqual({ open: 1, inactive: 1 });
    // How the browser is bounded: confined only headless on Linux; elsewhere, why not.
    expect(report.browser.display).toBe("headless");
    if (process.platform === "darwin")
      expect(report.browser).toMatchObject({ confined: false, why: expect.stringContaining("Chromium's own sandbox") });
    const closed = await run("close", "--inactive");
    expect(closed.code, closed.err).toBe(EXIT.ok);
    expect(closed.out).toBe("Closed 1 browser session: s-live\n");
    expect((await history.sessions({ workspaceId: "default", open: true, limit: 10 })).map((item) => item.sessionId)).toEqual([]);
    expect((await run("close", "--inactive")).out).toBe("No browser session to close.\n");
    // With --live and none open, it says so, though earlier sessions are listed without it.
    expect((await run("history", "--live")).out).toBe("No browser session is open now.\n");
    expect((await run("history", "--limit", "1")).out).toContain("closed");

    await history.open({ sessionId: "s-after", workspaceId: "default", taskId: "task-a", openedAt: minutesAgo(1) });
    await handles.pop()?.shutdown("offline next");
    const offline = await run("close", "s-after");
    expect(offline.code, offline.err).toBe(EXIT.ok);
    expect(offline.out).toBe("Closed 1 browser session: s-after\n");
  });
});

describe("browser clear-profile", () => {
  const deps = (clearProfile?: (workspaceId: string) => Promise<{ closed: number }>): BrowserDependencies =>
    ({
      repositories: { browserHistory: {}, artifacts: {} },
      principalOf: (workspaceId: string) => (workspaceId === "default" ? "operator" : undefined),
      now: () => new Date("2026-10-08T11:00:00.000Z"),
      ...(clearProfile === undefined ? {} : { clearProfile }),
    }) as unknown as BrowserDependencies;

  it("clears a served workspace's profile through the adapter, and is refused without one", async () => {
    const cleared: string[] = [];
    expect(
      await browserCommand(
        deps(async (workspaceId) => (cleared.push(workspaceId), { closed: 2 })),
        { action: "clear-profile", workspaceId: "default" },
      ),
    ).toEqual({ ok: true, result: { closed: 2 } });
    expect(cleared).toEqual(["default"]);
    expect(await browserCommand(deps(), { action: "clear-profile", workspaceId: "default" })).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
    expect(
      await browserCommand(
        deps(async () => ({ closed: 0 })),
        { action: "clear-profile", workspaceId: "nowhere" },
      ),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("parses tavi browser clear-profile", () => {
    expect(parseArgs(["browser", "clear-profile"])).toEqual({
      command: "browser",
      browser: { action: "clear-profile", workspaceId: "default" },
    });
    expect(parseArgs(["browser", "clear-profile", "--workspace", "w2"])).toEqual({
      command: "browser",
      browser: { action: "clear-profile", workspaceId: "w2" },
    });
    expect(() => parseArgs(["browser", "clear-profile", "extra"])).toThrow(UsageError);
    expect(() => parseArgs(["browser", "clear-profile", "--inactive"])).toThrow(UsageError);
  });

  it("removes the profile's directory offline, where no owner holds it", async () => {
    const dataDirectory = directories.create();
    const profile = browserProfileDirectory(dataDirectory, "default");
    mkdirSync(join(profile, "Default"), { recursive: true });
    let out = "";
    const code = await main(["browser", "clear-profile", "--data-dir", dataDirectory], {
      io: {
        stdout: (text) => void (out += text),
        stderr: () => undefined,
        isTty: false,
      },
    });
    expect(code).toBe(EXIT.ok);
    expect(out).toBe("Cleared the browser profile of workspace default.\n");
    expect(existsSync(profile)).toBe(false);
  });

  it("parses tavi browser recipes", () => {
    expect(parseArgs(["browser", "recipes"])).toEqual({
      command: "browser",
      browser: { action: "recipes", workspaceId: "default", format: "text" },
    });
    expect(parseArgs(["browser", "recipes", "--forget", "google.com", "--format", "json"])).toEqual({
      command: "browser",
      browser: { action: "recipes", workspaceId: "default", format: "json", forget: "google.com" },
      format: "json",
    });
    expect(parseArgs(["browser", "recipes", "--forget-all"])).toMatchObject({ browser: { forget: true } });
    expect(() => parseArgs(["browser", "recipes", "--forget", "a", "--forget-all"])).toThrow(UsageError);
    expect(parseArgs(["browser", "recipes", "--replay", "shop.example"])).toMatchObject({
      browser: { replay: { host: "shop.example", on: true } },
    });
    expect(parseArgs(["browser", "recipes", "--stop-replay", "shop.example"])).toMatchObject({
      browser: { replay: { host: "shop.example", on: false } },
    });
    expect(() => parseArgs(["browser", "recipes", "--replay", "a", "--stop-replay", "a"])).toThrow(UsageError);
    expect(() => parseArgs(["browser", "recipes", "--replay", "a", "--forget-all"])).toThrow(UsageError);
  });

  it("lists and forgets recipes offline", async () => {
    const dataDirectory = directories.create();
    let out = "";
    const io = { stdout: (text: string) => void (out += text), stderr: () => undefined, isTty: false };
    expect(await main(["browser", "recipes", "--data-dir", dataDirectory], { io })).toBe(EXIT.ok);
    expect(out).toBe("No site recipes.\n");
    // A host is forgotten as it is kept: lower-cased, without www.
    const store = await SqliteStore.open({
      databasePath: join(dataDirectory, "tavi.sqlite"),
      artifactsDirectory: join(dataDirectory, "artifacts"),
    });
    store
      .asPort()
      .repositories.siteRecipes.put({ workspaceId: "default", host: "google.com", steps: [{ kind: "click" }], results: 1, updatedAt: "t" });
    store.close();
    // Marked to replay, by host as recipes are kept; a site with no recipe says so.
    out = "";
    expect(await main(["browser", "recipes", "--replay", "WWW.Google.com", "--data-dir", dataDirectory], { io })).toBe(EXIT.ok);
    expect(out).toBe(
      "WWW.Google.com's recipe replays when a session next reaches it.\ngoogle.com — 1 time, last t, 1 results, replays\n  click the page\n",
    );
    out = "";
    expect(await main(["browser", "recipes", "--stop-replay", "nowhere.example", "--data-dir", dataDirectory], { io })).toBe(EXIT.ok);
    expect(out).toContain("No recipe for nowhere.example: nothing to stop.");
    out = "";
    expect(await main(["browser", "recipes", "--forget", "WWW.Google.com", "--data-dir", dataDirectory], { io })).toBe(EXIT.ok);
    expect(out).toBe("Forgot 1 recipe.\nNo site recipes.\n");
  });

  it("names a profile directory per workspace that a strange id cannot escape", () => {
    expect(browserProfileDirectory("/data", "default")).toMatch(/^\/data\/browser-profiles\/default-[0-9a-f]{12}$/);
    expect(browserProfileDirectory("/data", "../etc")).toMatch(/^\/data\/browser-profiles\/___etc-[0-9a-f]{12}$/);
    expect(browserProfileDirectory("/data", "a/b")).not.toBe(browserProfileDirectory("/data", "a_b"));
  });
});
