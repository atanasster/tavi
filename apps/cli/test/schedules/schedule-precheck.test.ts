import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { TaviError, type SchedulePrecheck, type SchedulePrecheckState, type ScheduleRecord, type ToolDefinition } from "@tavi/contracts";
import { ChatFolders, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it, vi } from "vitest";

import { writeSchedule } from "../../src/features/schedules/actions.js";
import { createSchedulePrecheck, feedItems, precheckSiteRefusal } from "../../src/features/schedules/precheck.js";
import { registerScheduleTools } from "../../src/features/schedules/tools.js";
import { SqliteStore } from "../support/database-fixture.js";

/** A schedule's pre-check: a page, a feed or a file read with no tool and no model, against its last reading. */

/** Run once after the next pre-check open's `stat` of what it opened: a change made between the checks and the read. */
const afterOpenStat = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }));
/** Run once after the next `lstat`: a change made between the pre-check's check of the path and its open. */
const afterLstat = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    const status = await actual.lstat(...args);
    const run = afterLstat.run;
    afterLstat.run = undefined;
    run?.();
    return status;
  }) as typeof actual.lstat;
  const open = async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
    const handle = await actual.open(...args);
    const stat = handle.stat.bind(handle);
    handle.stat = (async (...options: Parameters<FileHandle["stat"]>) => {
      const status = await stat(...options);
      const run = afterOpenStat.run;
      afterOpenStat.run = undefined;
      run?.();
      return status;
    }) as FileHandle["stat"];
    return handle;
  };
  return { ...actual, lstat, open, default: { ...actual, lstat, open } };
});

const MKFIFO = "/usr/bin/mkfifo";

const directories = temporaryDirectories({ prefix: "tavi-schedule-precheck-" });
afterAll(() => directories.cleanup());

const NOW = "2026-10-27T08:00:00.000Z";
const schedule = { scheduleId: "s-1" } as ScheduleRecord;
const signal = new AbortController().signal;

/** A stub of the guarded fetch: what each address answers, and every call it got. */
function pages(answers: Record<string, string | { readonly status: number; readonly text: string } | Error>) {
  const calls: { url: string; allowedHosts: readonly string[] }[] = [];
  const fetchPage = async (url: string, allowedHosts: readonly string[]) => {
    calls.push({ url, allowedHosts });
    const answer = answers[url];
    if (answer === undefined) throw new Error(`no stub for ${url}`);
    if (answer instanceof Error) throw answer;
    return typeof answer === "string" ? { status: 200, text: answer } : answer;
  };
  return { fetchPage, calls };
}

/** An owner's folder rule over one `--fs-root`, in a data directory of its own. */
function folders() {
  const root = directories.create();
  const data = directories.create();
  const chatFolders = new ChatFolders({
    dataDirectory: data,
    fsRoots: [root],
    homeDirectory: directories.create(),
    repository: { get: () => undefined, revision: () => 0, write: () => ({}) as never },
    tasks: { get: async () => undefined } as never,
    agentDelegations: { getByWorkerTaskId: async () => undefined } as never,
    actsIn: () => true,
    now: () => NOW,
  } as ConstructorParameters<typeof ChatFolders>[0]);
  return { root, data, checkFile: (path: string) => chatFolders.checkReadableFile(path) };
}

const rss = (...items: readonly { readonly guid: string; readonly date?: string }[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>${items
    .map(
      (item) =>
        `<item><title>${item.guid}</title><guid>${item.guid}</guid>${item.date === undefined ? "" : `<pubDate>${item.date}</pubDate>`}</item>`,
    )
    .join("")}</channel></rss>`;

describe("a page pre-check", () => {
  const page: SchedulePrecheck = { kind: "page-changed", target: "https://example.com/news" };

  it("takes a first reading, finds the same text unchanged however it is spaced, and a change changed", async () => {
    const stub = pages({ [page.target]: "Hello   world\n" });
    const check = createSchedulePrecheck({ fetchPage: stub.fetchPage, checkFile: () => "", now: () => NOW });
    const first = await check(schedule, page, undefined, signal);
    expect(first).toMatchObject({ kind: "first", state: { checkedAt: NOW } });
    // Dialling only the page's own host.
    expect(stub.calls).toEqual([{ url: page.target, allowedHosts: ["example.com"] }]);
    const state = (first as { state: SchedulePrecheckState }).state;
    const same = createSchedulePrecheck({
      fetchPage: pages({ [page.target]: " Hello world " }).fetchPage,
      checkFile: () => "",
      now: () => NOW,
    });
    expect(await same(schedule, page, state, signal)).toMatchObject({ kind: "unchanged", state: { fingerprint: state.fingerprint } });
    const changed = createSchedulePrecheck({
      fetchPage: pages({ [page.target]: "Hello there" }).fetchPage,
      checkFile: () => "",
      now: () => NOW,
    });
    expect(await changed(schedule, page, state, signal)).toMatchObject({ kind: "changed" });
  });

  it("fails, never throws, on a refusal by the egress guard or an error answer", async () => {
    const refused = createSchedulePrecheck({
      fetchPage: pages({ [page.target]: new TaviError("NOT_AUTHORIZED", "example.com resolves to a non-public address (10.0.0.5)") })
        .fetchPage,
      checkFile: () => "",
      now: () => NOW,
    });
    expect(await refused(schedule, page, undefined, signal)).toEqual({
      kind: "failed",
      reason: "example.com resolves to a non-public address (10.0.0.5)",
    });
    const down = createSchedulePrecheck({
      fetchPage: pages({ [page.target]: { status: 503, text: "busy" } }).fetchPage,
      checkFile: () => "",
      now: () => NOW,
    });
    expect(await down(schedule, page, undefined, signal)).toEqual({ kind: "failed", reason: "https://example.com/news answered 503" });
  });
});

describe("a pre-check on a profiled site", () => {
  const page: SchedulePrecheck = { kind: "page-changed", target: "https://example.com/news" };
  /** Site profiles that refuse reading example.com unattended, and every check they were asked. */
  const refusing = () => {
    const asked: { taskId: string; url: string; unattended: boolean }[] = [];
    const ended: string[] = [];
    const sites = {
      beforeNavigate: async (input: { taskId: string; url: string; unattended: boolean }) => {
        asked.push({ taskId: input.taskId, url: input.url, unattended: input.unattended });
        return new URL(input.url).hostname === "example.com"
          ? { refused: "Example is read only while the person attends", host: "example.com" }
          : undefined;
      },
      taskEnded: (taskId: string) => void ended.push(taskId),
    };
    return { sites, asked, ended };
  };

  it("is not fetched when the owner's site profiles refuse reading it unattended, and fails with their reason", async () => {
    const stub = pages({ [page.target]: "Hello" });
    const { sites, asked, ended } = refusing();
    const check = createSchedulePrecheck({ fetchPage: stub.fetchPage, checkFile: () => "", sites, now: () => NOW });
    expect(await check(schedule, page, undefined, signal)).toEqual({
      kind: "failed",
      reason: "Example is read only while the person attends",
    });
    expect(stub.calls).toEqual([]);
    expect(asked).toEqual([{ taskId: "schedule-precheck:s-1", url: page.target, unattended: true }]);
    expect(ended).toEqual(["schedule-precheck:s-1"]);
  });

  it("is refused when a schedule is saved with an address the site profiles refuse", async () => {
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const repositories = store.asPort().repositories;
      const { sites } = refusing();
      const precheckSite = (workspaceId: string, url: string) =>
        precheckSiteRefusal(sites, { workspaceId, taskId: "schedule-precheck-save", url, signal });
      const base = { action: "add" as const, name: "News", prompt: "Summarise the news", at: "07:00", timezone: "UTC" };
      await expect(
        writeSchedule(repositories, { ...base, precheck: `page-changed:${page.target}` }, new Date(NOW), { precheckSite }),
      ).rejects.toThrow(/read only while the person attends/);
      expect(await repositories.schedules.list("default")).toEqual([]);
      const saved = await writeSchedule(repositories, { ...base, precheck: "page-changed:https://example.org/" }, new Date(NOW), {
        precheckSite,
      });
      expect(saved.precheck).toEqual({ kind: "page-changed", target: "https://example.org/" });
    } finally {
      store.close();
    }
  });
});

describe("a feed pre-check", () => {
  const feed: SchedulePrecheck = { kind: "feed-has-new", target: "https://example.com/feed.xml" };
  const reading = async (text: string, last?: SchedulePrecheckState) =>
    createSchedulePrecheck({ fetchPage: pages({ [feed.target]: text }).fetchPage, checkFile: () => "", now: () => NOW })(
      schedule,
      feed,
      last,
      signal,
    );

  it("finds an item not seen at the last reading, and none when the feed only lost or reordered items", async () => {
    const first = await reading(
      rss({ guid: "a", date: "Mon, 26 Oct 2026 08:00:00 GMT" }, { guid: "b", date: "Sun, 25 Oct 2026 08:00:00 GMT" }),
    );
    expect(first).toMatchObject({ kind: "first", state: { latest: "2026-10-26T08:00:00.000Z" } });
    const state = (first as { state: SchedulePrecheckState }).state;
    expect(state.ids).toHaveLength(2);
    expect(await reading(rss({ guid: "b" }, { guid: "a" }), state)).toMatchObject({ kind: "unchanged" });
    expect(
      await reading(rss({ guid: "c", date: "Tue, 27 Oct 2026 07:00:00 GMT" }, { guid: "a", date: "Mon, 26 Oct 2026 08:00:00 GMT" }), state),
    ).toEqual(expect.objectContaining({ kind: "changed", newItems: 1 }));
    // An unseen item older than the newest seen is an old one come back, not news.
    expect(await reading(rss({ guid: "old", date: "Sat, 24 Oct 2026 08:00:00 GMT" }, { guid: "a" }), state)).toMatchObject({
      kind: "unchanged",
    });
  });

  it("finds a new item dated the same as the newest seen, as a feed stamped by day lists it", async () => {
    const atom = (...ids: readonly string[]) =>
      `<feed xmlns="http://www.w3.org/2005/Atom">${ids.map((id) => `<entry><id>${id}</id><updated>2026-10-29</updated></entry>`).join("")}</feed>`;
    const first = await reading(atom("a"));
    const state = (first as { state: SchedulePrecheckState }).state;
    expect(await reading(atom("b", "a"), state)).toEqual(expect.objectContaining({ kind: "changed", newItems: 1 }));
    expect(await reading(atom("a"), state)).toMatchObject({ kind: "unchanged" });
  });

  it("compares only the items it remembers, newest first, so a long feed read again is unchanged", async () => {
    const undated = rss(...Array.from({ length: 150 }, (_, index) => ({ guid: `u${String(index)}` })));
    const first = (await reading(undated)) as { state: SchedulePrecheckState };
    expect(first.state.ids).toHaveLength(100);
    expect(await reading(undated, first.state)).toMatchObject({ kind: "unchanged" });
    const day = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toUTCString();
    const oldestFirst = Array.from({ length: 150 }, (_, index) => ({ guid: `d${String(index)}`, date: day(index) }));
    const dated = (await reading(rss(...oldestFirst))) as { state: SchedulePrecheckState };
    expect(dated.state.latest).toBe(new Date(day(149)).toISOString());
    expect(await reading(rss(...oldestFirst), dated.state)).toMatchObject({ kind: "unchanged" });
    expect(await reading(rss(...oldestFirst, { guid: "d150", date: day(150) }), dated.state)).toEqual(
      expect.objectContaining({ kind: "changed", newItems: 1 }),
    );
  });

  it("reads a hostile feed of unclosed tags in linear time", () => {
    const size = 2 * 1024 * 1024;
    const started = performance.now();
    expect(feedItems(`<rss>${"<item>".repeat(size / "<item>".length)}`)).toEqual([]);
    expect(feedItems(`<rss><item>${"<guid>".repeat(size / "<guid>".length)}</item></rss>`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads at most its cap of items from a feed", () => {
    const many = rss(...Array.from({ length: 5000 }, (_, index) => ({ guid: `m${String(index)}`, date: "Mon, 26 Oct 2026 08:00:00 GMT" })));
    expect(feedItems(many).length).toBeLessThan(5000);
  });

  it("reads Atom entries by their id, and refuses an answer that is not a feed", async () => {
    expect(
      feedItems(
        `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:x,2026:1</id><updated>2026-10-27T07:00:00Z</updated><link href="https://example.com/1"/></entry><entry><link href="https://example.com/2"/></entry></feed>`,
      ),
    ).toEqual([{ id: "tag:x,2026:1", at: Date.parse("2026-10-27T07:00:00Z") }, { id: "https://example.com/2" }]);
    expect(await reading("<html><body>Moved</body></html>")).toEqual({
      kind: "failed",
      reason: "the address did not answer an RSS or Atom feed",
    });
  });
});

describe("a file pre-check", () => {
  it("reads a file under an --fs-root by its content, and refuses one outside it or in the data directory", async () => {
    const { root, data, checkFile } = folders();
    const path = join(root, "notes.txt");
    writeFileSync(path, "first");
    const file: SchedulePrecheck = { kind: "file-changed", target: path };
    const check = createSchedulePrecheck({ fetchPage: pages({}).fetchPage, checkFile, now: () => NOW });
    const first = await check(schedule, file, undefined, signal);
    expect(first).toMatchObject({ kind: "first" });
    const state = (first as { state: SchedulePrecheckState }).state;
    expect(await check(schedule, file, state, signal)).toMatchObject({ kind: "unchanged" });
    writeFileSync(path, "second");
    expect(await check(schedule, file, state, signal)).toMatchObject({ kind: "changed" });
    const outside = join(directories.create(), "elsewhere.txt");
    writeFileSync(outside, "x");
    expect(await check(schedule, { kind: "file-changed", target: outside }, undefined, signal)).toEqual({
      kind: "failed",
      reason: expect.stringMatching(/is not under an --fs-root/),
    });
    mkdirSync(join(data, "inner"), { recursive: true });
    writeFileSync(join(data, "inner", "secret.txt"), "x");
    expect(() => checkFile(join(data, "inner", "secret.txt"))).toThrow(/not under an --fs-root|data directory/);
    expect(await check(schedule, { kind: "file-changed", target: join(root, "gone.txt") }, undefined, signal)).toMatchObject({
      kind: "failed",
      reason: expect.stringMatching(/does not exist/),
    });
  });

  it("is refused when a schedule is saved with a file outside the owner's --fs-root, and kept as its real path inside it", async () => {
    const { root, checkFile } = folders();
    writeFileSync(join(root, "notes.txt"), "x");
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const repositories = store.asPort().repositories;
      const base = { action: "add" as const, name: "Notes", prompt: "Summarise my notes", at: "07:00", timezone: "UTC" };
      const outside = join(directories.create(), "notes.txt");
      writeFileSync(outside, "x");
      await expect(
        writeSchedule(repositories, { ...base, precheck: `file-changed:${outside}` }, new Date(NOW), { precheckFile: checkFile }),
      ).rejects.toThrow(/is not under an --fs-root/);
      expect(await repositories.schedules.list("default")).toEqual([]);
      const saved = await writeSchedule(repositories, { ...base, precheck: `file-changed:${join(root, "notes.txt")}` }, new Date(NOW), {
        precheckFile: checkFile,
      });
      expect(saved.precheck).toEqual({ kind: "file-changed", target: checkFile(join(root, "notes.txt")) });
    } finally {
      store.close();
    }
  });

  it.skipIf(!existsSync(MKFIFO))("refuses a FIFO swapped in between the check and the open, without blocking", async () => {
    const { root, checkFile } = folders();
    const path = join(root, "notes.txt");
    writeFileSync(path, "first");
    const check = createSchedulePrecheck({ fetchPage: pages({}).fetchPage, checkFile, now: () => NOW });
    afterLstat.run = () => {
      rmSync(path);
      execFileSync(MKFIFO, [path]);
    };
    expect(await check(schedule, { kind: "file-changed", target: path }, undefined, signal)).toEqual({
      kind: "failed",
      reason: `${path} is not a file`,
    });
    expect(afterLstat.run).toBeUndefined();
  });

  it("refuses another file swapped in between the check and the open", async () => {
    const { root, checkFile } = folders();
    const path = join(root, "notes.txt");
    const other = join(root, "other.txt");
    writeFileSync(path, "first");
    writeFileSync(other, "other");
    const check = createSchedulePrecheck({ fetchPage: pages({}).fetchPage, checkFile, now: () => NOW });
    afterLstat.run = () => renameSync(other, path);
    expect(await check(schedule, { kind: "file-changed", target: path }, undefined, signal)).toEqual({
      kind: "failed",
      reason: `${path} changed while it was being opened`,
    });
  });

  it("refuses a folder above the file swapped for a link between the check and the open", async () => {
    const { root, checkFile } = folders();
    const outside = directories.create();
    const folder = join(root, "dir");
    const path = join(folder, "notes.txt");
    mkdirSync(folder);
    writeFileSync(path, "inside");
    writeFileSync(join(outside, "notes.txt"), "outside");
    const check = createSchedulePrecheck({ fetchPage: pages({}).fetchPage, checkFile, now: () => NOW });
    // The last segment stays a regular file, so O_NOFOLLOW and the device and inode check alone would read the outside one.
    const swapped = createSchedulePrecheck({
      fetchPage: pages({}).fetchPage,
      checkFile: (target) => {
        const real = checkFile(target);
        renameSync(folder, `${folder}-old`);
        symlinkSync(outside, folder);
        return real;
      },
      now: () => NOW,
    });
    expect(await check(schedule, { kind: "file-changed", target: path }, undefined, signal)).toMatchObject({ kind: "first" });
    expect(await swapped(schedule, { kind: "file-changed", target: path }, undefined, signal)).toEqual({
      kind: "failed",
      reason: `${path} changed while it was being opened`,
    });
  });

  it("follows a symlink at the watched path to the regular file it leads to", async () => {
    const { root, checkFile } = folders();
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    writeFileSync(target, "first");
    symlinkSync(target, link);
    const check = createSchedulePrecheck({ fetchPage: pages({}).fetchPage, checkFile, now: () => NOW });
    const first = await check(schedule, { kind: "file-changed", target: link }, undefined, signal);
    expect(first).toMatchObject({ kind: "first" });
    const state = (first as { state: SchedulePrecheckState }).state;
    expect(await check(schedule, { kind: "file-changed", target: target }, undefined, signal)).toMatchObject({
      kind: "first",
      state: { fingerprint: state.fingerprint },
    });
    writeFileSync(target, "second");
    expect(await check(schedule, { kind: "file-changed", target: link }, state, signal)).toMatchObject({ kind: "changed" });
  });

  it("fingerprints a file that grew past the hash limit after its check by size and time", async () => {
    const { root, checkFile } = folders();
    const path = join(root, "growing.log");
    writeFileSync(path, "small");
    const check = createSchedulePrecheck({ fetchPage: pages({}).fetchPage, checkFile, now: () => NOW });
    const small = await check(schedule, { kind: "file-changed", target: path }, undefined, signal);
    afterOpenStat.run = () => appendFileSync(path, Buffer.alloc(16 * 1024 * 1024));
    const grown = await check(schedule, { kind: "file-changed", target: path }, (small as { state: SchedulePrecheckState }).state, signal);
    expect(afterOpenStat.run).toBeUndefined();
    expect(grown).toMatchObject({ kind: "changed" });
    // Read again with no change, a file over the limit is fingerprinted the same way: unchanged.
    expect(
      await check(schedule, { kind: "file-changed", target: path }, (grown as { state: SchedulePrecheckState }).state, signal),
    ).toMatchObject({
      kind: "unchanged",
    });
  });
});

describe("a pre-check from a chat", () => {
  const catalog: readonly ToolDefinition[] = [];

  it("is given, read back and removed through schedules.create and update, and its card says what it reads first", async () => {
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const registry = new ToolRegistry();
      registerScheduleTools(registry, {
        repositories: store.asPort().repositories,
        tools: () => catalog,
        now: () => new Date(NOW),
        routineOwner: () => undefined,
        routineOwners: (scheduleIds) => scheduleIds.map(() => undefined),
        fireInFlight: () => false,
        workspaceTimezone: async () => "UTC",
      });
      const context = { workspaceId: "default", principalId: "operator", runId: "chat-1", caller: "test" };
      const call = async (name: string, input: unknown) =>
        (await registry.get(`schedules.${name}`)?.handler({ input, context, signal })) as Record<string, unknown>;
      const input = { name: "News", prompt: "Summarise what is new", at: "07:00", precheck: "feed-has-new:https://example.com/feed.xml" };
      expect(registry.get("schedules.create")?.assess?.(input, context)?.display.detail).toContain(
        "Checks first: runs only when the feed https://example.com/feed.xml has new items since the last check",
      );
      expect(await call("create", input)).toMatchObject({
        precheck: "feed-has-new:https://example.com/feed.xml",
        prechecks: expect.stringContaining("new items"),
      });
      // Sent again as it is, it is the same schedule.
      expect(await call("create", input)).toMatchObject({ replayed: true });
      expect(await call("update", { schedule: "News", precheck: "page-changed https://example.com/" })).toMatchObject({
        precheck: "page-changed:https://example.com/",
      });
      expect(await call("update", { schedule: "News", precheck: "none" })).not.toHaveProperty("precheck");
      await expect(call("update", { schedule: "News", precheck: "page-changed:https://192.168.1.1/" })).rejects.toThrow(/https address/);
      // A file needs the owner's --fs-root rule, which these tools were given none of.
      await expect(call("update", { schedule: "News", precheck: "file-changed:/tmp/notes.txt" })).rejects.toThrow(/needs a running owner/);
    } finally {
      store.close();
    }
  });
});
