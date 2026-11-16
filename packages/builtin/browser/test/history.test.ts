import { tmpdir } from "node:os";
import {
  BROWSER_CLOSE_REASON_IDLE,
  BROWSER_THUMBNAIL_INTERVAL_MS,
  TaviError,
  type ArtifactRecord,
  type ArtifactRepositoryPort,
  type BrowserHistoryRepositoryPort,
} from "@tavi/contracts";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";

import type { BrowserLiveSource } from "../src/live.js";
import { createPlaywrightBrowser } from "../src/playwright.js";
import { thumbnailFor, type ThumbnailPage } from "../src/thumbnail.js";
import { fakeMatches } from "./fake-matches.js";

/**
 * Browser history in the Playwright adapter: a durable session row per task session, pages and titles recorded
 * on navigate/observe, and the thumbnail rules — all against fakes, so no
 * Chromium is needed.
 */

function fakeArtifacts(): ArtifactRepositoryPort & { readonly records: Map<string, ArtifactRecord> } {
  const records = new Map<string, ArtifactRecord>();
  const bodies = new Map<string, Uint8Array>();
  let counter = 0;
  return {
    records,
    async putArtifact(input) {
      const artifactId = `art-${(counter += 1)}`;
      const bytes = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
      const record: ArtifactRecord = {
        artifactId,
        workspaceId: input.workspaceId,
        runId: input.runId ?? null,
        relativePath: `${input.workspaceId}/${artifactId}`,
        contentType: input.contentType,
        byteSize: bytes.byteLength,
        sha256: "fixture",
        reviewState: input.reviewState ?? "approved",
        reviewedBy: null,
        reviewedAt: null,
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
      };
      records.set(artifactId, record);
      bodies.set(artifactId, bytes);
      return record;
    },
    getArtifact: async (artifactId) => records.get(artifactId),
    readArtifactBody: async (artifactId) => bodies.get(artifactId),
    // No video previews in these fixtures (video retention's check).
    derivedPreviewExists: async () => false,
    listPendingReview: async () => [],
    async setReviewState() {
      throw new TaviError("UNSUPPORTED", "not in this fake");
    },
  };
}

type HistoryCall = { readonly method: string; readonly input: unknown };

function fakeHistory(): BrowserHistoryRepositoryPort & { readonly calls: HistoryCall[] } {
  const calls: HistoryCall[] = [];
  const record = (method: string) => async (input: unknown) => {
    calls.push({ method, input });
    return undefined;
  };
  return {
    calls,
    open: record("open") as BrowserHistoryRepositoryPort["open"],
    recordPage: record("recordPage") as BrowserHistoryRepositoryPort["recordPage"],
    setThumbnail: (async (input: unknown) => {
      calls.push({ method: "setThumbnail", input });
      return null;
    }) as BrowserHistoryRepositoryPort["setThumbnail"],
    close: record("close") as BrowserHistoryRepositoryPort["close"],
    setInactive: record("setInactive") as BrowserHistoryRepositoryPort["setInactive"],
    counts: async () => ({ open: 0, inactive: 0 }),
    closeOpen: async () => 0,
    sweep: async () => ({ sessions: 0, thumbnails: 0 }),
    sessions: async () => [],
    visitPage: async () => undefined,
  };
}

interface FakePageState {
  url: string;
  title: string | (() => Promise<string>);
  password: boolean;
  /** Frame URLs besides the top one. */
  frames?: string[];
  /** Where the page's one element (a link) goes when clicked or submitted; no element without it. */
  link?: string;
}

function fakeSetup(state: FakePageState) {
  const follow = async () => {
    if (state.link !== undefined) state.url = state.link;
  };
  const link = {
    click: vi.fn(follow),
    press: vi.fn(follow),
    fill: vi.fn(async () => undefined),
    boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 30, height: 40 })),
    // The protected-field reads (`factsOfLocator`): a link, which is no field.
    ariaSnapshot: vi.fn(async () => '- link "Next"'),
    getAttribute: vi.fn(async () => null),
    locator: vi.fn(() => ({ count: async () => 0 })),
    isVisible: vi.fn(async () => true),
  } as unknown as Locator;
  const page = {
    goto: vi.fn(async (target: string) => {
      state.url = target;
      return null;
    }),
    url: vi.fn(() => state.url),
    // The page's own frames, for the sensitivity its tools' outputs carry; the thumbnail's is `thumbnailPage` below.
    frames: vi.fn(() => [state.url, ...(state.frames ?? [])].map((url) => ({ url: () => url, $: async () => null }))),
    title: vi.fn(async () => (typeof state.title === "string" ? state.title : state.title())),
    locator: vi.fn(() => fakeMatches(state.link === undefined ? [] : [link], [{ text: "Next" }])),
    screenshot: vi.fn(async () => Buffer.from("png-bytes")),
    waitForLoadState: vi.fn(async () => undefined),
    on: vi.fn(),
  } as unknown as Page;
  // No click here opens a new tab: the wait for one gives up at once.
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
    waitForEvent: vi.fn(async () => {
      throw new Error("Timeout");
    }),
  } as unknown as BrowserContext;
  const browser = { newContext: vi.fn(async () => context) } as unknown as Browser;
  const jpeg = vi.fn(async (): Promise<Uint8Array> => new Uint8Array([0xff, 0xd8, 0xff]));
  const hasPasswordField = vi.fn(async () => state.password);
  const thumbnailPage = (): ThumbnailPage => ({
    url: () => state.url,
    frameUrls: () => [state.url, ...(state.frames ?? [])],
    hasPasswordField,
    hasPaymentField: async () => false,
    jpeg,
  });
  return { page, launch: vi.fn(async () => browser), thumbnailPage, jpeg, hasPasswordField };
}

function clock(start = Date.parse("2026-09-30T08:00:00.000Z")) {
  let current = start;
  return { now: () => new Date(current).toISOString(), advance: (ms: number) => (current += ms) };
}

function adapterWith(state: FakePageState, blockedHosts?: readonly string[]) {
  const setup = fakeSetup(state);
  const history = fakeHistory();
  const artifacts = fakeArtifacts();
  const time = clock();
  const errors: unknown[] = [];
  const adapter = createPlaywrightBrowser({
    stagingDirectory: tmpdir(),
    launch: setup.launch,
    artifacts,
    history,
    now: time.now,
    newHistoryId: () => "11111111-2222-4333-8444-555555555555",
    thumbnailPage: setup.thumbnailPage,
    onHistoryError: (error) => errors.push(error),
    ...(blockedHosts === undefined ? {} : { noThumbnailHosts: async () => blockedHosts }),
  });
  return { adapter, history, artifacts, time, errors, ...setup };
}

/** Let the session's thumbnail queue, which runs after the call answers, finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const thumbnailCalls = (history: { readonly calls: HistoryCall[] }) =>
  history.calls.filter((call) => call.method === "setThumbnail").map((call) => call.input);

describe("session history", () => {
  it("records a durable session for a task, pages with titles, and the close", async () => {
    const state = { url: "about:blank", title: "Example Domain", password: false };
    const { adapter, history, time } = adapterWith(state);
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    // The model keeps the adapter's own id; the durable row gets a UUID.
    expect(session.sessionId).toBe("browser-session-1");
    expect(history.calls[0]).toEqual({
      method: "open",
      input: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        workspaceId: "w1",
        taskId: "task-1",
        openedAt: "2026-09-30T08:00:00.000Z",
      },
    });

    const observation = await adapter.navigate(session.sessionId, "https://example.com/?q=1");
    expect(observation.title).toBe("Example Domain");
    time.advance(1_000);
    state.title = "Example Domain (updated)";
    const again = await adapter.observe(session.sessionId);
    expect(again.title).toBe("Example Domain (updated)");
    expect(history.calls.filter((call) => call.method === "recordPage").map((call) => call.input)).toEqual([
      // The adapter hands over the page URL; the repository scrubs it.
      {
        sessionId: "11111111-2222-4333-8444-555555555555",
        url: "https://example.com/?q=1",
        title: "Example Domain",
        at: "2026-09-30T08:00:00.000Z",
      },
      {
        sessionId: "11111111-2222-4333-8444-555555555555",
        url: "https://example.com/?q=1",
        title: "Example Domain (updated)",
        at: "2026-09-30T08:00:01.000Z",
      },
    ]);

    await adapter.close(session.sessionId);
    await expect(adapter.close(session.sessionId)).resolves.toBeUndefined();
    expect(history.calls.filter((call) => call.method === "close")).toEqual([
      {
        method: "close",
        input: { sessionId: "11111111-2222-4333-8444-555555555555", closedAt: "2026-09-30T08:00:01.000Z", reason: "closed" },
      },
    ]);
  });

  it("records the tool call that opened the session", async () => {
    const { adapter, history } = adapterWith({ url: "about:blank", title: "T", password: false });
    await adapter.createSession({ workspaceId: "w1", taskId: "task-1", callId: "call-open-1" });
    expect(history.calls[0]).toMatchObject({ method: "open", input: { taskId: "task-1", openedByCallId: "call-open-1" } });
  });

  it("records nothing for a session without a task", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, history } = adapterWith(state);
    const session = await adapter.createSession({ workspaceId: "w1" });
    await adapter.navigate(session.sessionId, "https://example.com/");
    await adapter.close(session.sessionId);
    expect(history.calls).toEqual([]);
  });

  it("goes without a title that fails or does not arrive in time", async () => {
    vi.useFakeTimers();
    try {
      const state: FakePageState = { url: "about:blank", title: () => new Promise<string>(() => undefined), password: false };
      const { adapter } = adapterWith(state);
      const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
      const pending = adapter.observe(session.sessionId);
      await vi.advanceTimersByTimeAsync(1_500);
      expect((await pending).title).toBeUndefined();
      state.title = () => Promise.reject(new Error("page closed"));
      expect((await adapter.observe(session.sessionId)).title).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fails a browser call because history could not be written", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, history, errors } = adapterWith(state);
    history.open = async () => {
      throw new Error("database is locked");
    };
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await expect(adapter.navigate(session.sessionId, "https://example.com/")).resolves.toMatchObject({ url: "https://example.com/" });
    expect(errors).toHaveLength(1);
    // With no row, nothing further is written.
    expect(history.calls).toEqual([]);
  });
});

describe("thumbnails", () => {
  it("stores one as an approved internal artifact of the task after a navigate, at most once per interval", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, artifacts, history, time, jpeg } = adapterWith(state);
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await adapter.navigate(session.sessionId, "https://example.com/one");
    await settle();
    expect([...artifacts.records.values()]).toEqual([
      expect.objectContaining({
        workspaceId: "w1",
        runId: "task-1",
        contentType: "image/jpeg",
        reviewState: "approved",
        purpose: "thumbnail",
      }),
    ]);
    expect(thumbnailCalls(history)).toEqual([{ sessionId: "11111111-2222-4333-8444-555555555555", artifactId: "art-1" }]);

    // Within the interval: no new thumbnail, from a navigate or an observe.
    time.advance(BROWSER_THUMBNAIL_INTERVAL_MS - 1);
    await adapter.navigate(session.sessionId, "https://example.com/two");
    await settle();
    await adapter.observe(session.sessionId);
    await settle();
    expect(jpeg).toHaveBeenCalledTimes(1);

    // Past it, an observe refreshes the thumbnail too.
    time.advance(1);
    await adapter.observe(session.sessionId);
    await settle();
    expect(jpeg).toHaveBeenCalledTimes(2);

    time.advance(BROWSER_THUMBNAIL_INTERVAL_MS);
    await adapter.navigate(session.sessionId, "https://example.com/three");
    await settle();
    expect(jpeg).toHaveBeenCalledTimes(3);
    expect(thumbnailCalls(history)).toEqual([
      { sessionId: "11111111-2222-4333-8444-555555555555", artifactId: "art-1" },
      { sessionId: "11111111-2222-4333-8444-555555555555", artifactId: "art-2" },
      { sessionId: "11111111-2222-4333-8444-555555555555", artifactId: "art-3" },
    ]);
  });

  it("takes none of a page with a password field, and clears the previous one", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, history, time, jpeg } = adapterWith(state);
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await adapter.navigate(session.sessionId, "https://example.com/");
    await settle();
    time.advance(BROWSER_THUMBNAIL_INTERVAL_MS);
    state.password = true;
    await adapter.navigate(session.sessionId, "https://example.com/login");
    await settle();
    expect(jpeg).toHaveBeenCalledTimes(1);
    expect(thumbnailCalls(history).at(-1)).toEqual({ sessionId: "11111111-2222-4333-8444-555555555555", artifactId: null });
  });

  it("takes none on a blocked host, by exact host or *. pattern, even within the interval", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, history, jpeg } = adapterWith(state, ["mail.example.com", "*.bank"]);
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await adapter.navigate(session.sessionId, "https://online.mybank.bank/accounts");
    await settle();
    await adapter.navigate(session.sessionId, "https://mail.example.com/inbox");
    await settle();
    expect(jpeg).not.toHaveBeenCalled();
    expect(thumbnailCalls(history)).toEqual([
      { sessionId: "11111111-2222-4333-8444-555555555555", artifactId: null },
      { sessionId: "11111111-2222-4333-8444-555555555555", artifactId: null },
    ]);
  });

  it("uses the default list when the workspace sets none", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, jpeg } = adapterWith(state);
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await adapter.navigate(session.sessionId, "https://mail.google.com/mail/u/0/");
    await settle();
    expect(jpeg).not.toHaveBeenCalled();
  });

  it("takes none of a page with a frame on a blocked host", async () => {
    const state: FakePageState = { url: "about:blank", title: "T", password: false, frames: ["https://www.paypal.com/checkout"] };
    const { adapter, history, jpeg } = adapterWith(state);
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await adapter.navigate(session.sessionId, "https://shop.example.com/cart");
    await settle();
    expect(jpeg).not.toHaveBeenCalled();
    expect(thumbnailCalls(history)).toEqual([{ sessionId: "11111111-2222-4333-8444-555555555555", artifactId: null }]);
  });

  it("checks a page reached by a click when it is observed, clearing the thumbnail of the page before", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, history, jpeg } = adapterWith(state);
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await adapter.navigate(session.sessionId, "https://example.com/");
    await settle();
    // A click took the page to a login form; the model observes it within the interval.
    state.url = "https://accounts.example.com/login?next=%2F";
    state.password = true;
    await adapter.observe(session.sessionId);
    await settle();
    expect(jpeg).toHaveBeenCalledTimes(1);
    expect(history.calls.filter((call) => call.method === "recordPage").at(-1)?.input).toMatchObject({
      url: "https://accounts.example.com/login?next=%2F",
    });
    expect(thumbnailCalls(history)).toEqual([
      { sessionId: "11111111-2222-4333-8444-555555555555", artifactId: "art-1" },
      { sessionId: "11111111-2222-4333-8444-555555555555", artifactId: null },
    ]);
  });

  it("records the page a click or a submit leads to, and takes its thumbnail, without waiting for an observe", async () => {
    const state: FakePageState = { url: "about:blank", title: "Next page", password: false, link: "https://example.com/next?token=1" };
    const { adapter, history, time, jpeg } = adapterWith(state);
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    const observed = await adapter.navigate(session.sessionId, "https://example.com/");
    await settle();
    time.advance(BROWSER_THUMBNAIL_INTERVAL_MS);
    await expect(adapter.act({ sessionId: session.sessionId, epoch: observed.epoch, ref: "el-0", kind: "click" })).resolves.toMatchObject({
      status: "accepted",
      detail: "the page is now https://example.com/next?token=1",
      page: expect.objectContaining({ url: "https://example.com/next?token=1" }),
    });
    await settle();
    expect(history.calls.filter((call) => call.method === "recordPage").map((call) => call.input)).toEqual([
      {
        sessionId: "11111111-2222-4333-8444-555555555555",
        url: "https://example.com/",
        title: "Next page",
        at: "2026-09-30T08:00:00.000Z",
      },
      {
        sessionId: "11111111-2222-4333-8444-555555555555",
        url: "https://example.com/next?token=1",
        title: "Next page",
        at: "2026-09-30T08:00:10.000Z",
      },
    ]);
    expect(jpeg).toHaveBeenCalledTimes(2);

    // A submit that leads on is recorded too; its thumbnail waits out the interval.
    state.link = "https://example.com/done";
    await adapter.act({ sessionId: session.sessionId, epoch: observed.epoch, ref: "el-0", kind: "submit" });
    await settle();
    expect(history.calls.filter((call) => call.method === "recordPage").at(-1)?.input).toMatchObject({ url: "https://example.com/done" });
    expect(jpeg).toHaveBeenCalledTimes(2);
  });

  it("records nothing more for a click or a typed value that stays on the page", async () => {
    const state: FakePageState = { url: "about:blank", title: "T", password: false, link: "https://example.com/" };
    const { adapter, history, jpeg } = adapterWith(state);
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    const observed = await adapter.navigate(session.sessionId, "https://example.com/");
    await settle();
    await adapter.act({ sessionId: session.sessionId, epoch: observed.epoch, ref: "el-0", kind: "click" });
    await adapter.act({ sessionId: session.sessionId, epoch: observed.epoch, ref: "el-0", kind: "type", value: "hello" });
    await settle();
    expect(history.calls.filter((call) => call.method === "recordPage")).toHaveLength(1);
    expect(jpeg).toHaveBeenCalledTimes(1);
  });

  it("answers the call before the thumbnail is taken", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, jpeg } = adapterWith(state);
    let release: () => void = () => undefined;
    jpeg.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((resolve) => {
          release = () => resolve(new Uint8Array([0xff, 0xd8, 0xff]));
        }),
    );
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await expect(adapter.navigate(session.sessionId, "https://example.com/")).resolves.toMatchObject({ title: "T" });
    await settle();
    expect(jpeg).toHaveBeenCalledTimes(1);
    release();
  });

  it("drops an image of a page the session left while it was being taken", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, artifacts, history, jpeg } = adapterWith(state);
    // A client-side redirect lands while the screenshot is taken.
    jpeg.mockImplementationOnce(async () => {
      state.url = "https://example.com/elsewhere";
      return new Uint8Array([0xff, 0xd8, 0xff]);
    });
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await adapter.navigate(session.sessionId, "https://example.com/");
    await settle();
    expect(jpeg).toHaveBeenCalledTimes(1);
    expect(artifacts.records.size).toBe(0);
    expect(thumbnailCalls(history)).toEqual([]);
  });

  it("discards an image of a page that showed a password field once it was taken", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, artifacts, history, jpeg } = adapterWith(state);
    jpeg.mockImplementationOnce(async () => {
      state.password = true;
      return new Uint8Array([0xff, 0xd8, 0xff]);
    });
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await adapter.navigate(session.sessionId, "https://example.com/");
    await settle();
    expect(artifacts.records.size).toBe(0);
    expect(thumbnailCalls(history)).toEqual([{ sessionId: "11111111-2222-4333-8444-555555555555", artifactId: null }]);
  });

  it("never stores a run that outlived its time bound once the session moved to a sensitive page", async () => {
    vi.useFakeTimers();
    try {
      const state = { url: "about:blank", title: "T", password: false };
      const { adapter, artifacts, history, hasPasswordField } = adapterWith(state, ["*.bank"]);
      let release: () => void = () => undefined;
      hasPasswordField.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(false);
          }),
      );
      const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
      await adapter.navigate(session.sessionId, "https://example.com/");
      // The first run is stuck past its bound; the next navigate goes to a bank.
      await vi.advanceTimersByTimeAsync(6_000);
      await adapter.navigate(session.sessionId, "https://online.mybank.bank/");
      await vi.advanceTimersByTimeAsync(100);
      release();
      await vi.advanceTimersByTimeAsync(100);
      expect(artifacts.records.size).toBe(0);
      expect(thumbnailCalls(history).at(-1)).toEqual({ sessionId: "11111111-2222-4333-8444-555555555555", artifactId: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a queued run a newer page has superseded", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, artifacts, history, jpeg } = adapterWith(state);
    let release: () => void = () => undefined;
    jpeg.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((resolve) => {
          release = () => resolve(new Uint8Array([0xff, 0xd8, 0xff]));
        }),
    );
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await adapter.navigate(session.sessionId, "https://example.com/one");
    await settle();
    await adapter.navigate(session.sessionId, "https://example.com/two");
    await adapter.navigate(session.sessionId, "https://example.com/three");
    release();
    await settle();
    // The first image is of a page the session left; "two" never runs; "three" is taken.
    expect(jpeg).toHaveBeenCalledTimes(2);
    expect([...artifacts.records.values()]).toHaveLength(1);
    expect(thumbnailCalls(history)).toEqual([{ sessionId: "11111111-2222-4333-8444-555555555555", artifactId: "art-1" }]);
  });
});

describe("artifacts the model's calls make", () => {
  it("carry the task as their run", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const { adapter, artifacts } = adapterWith(state);
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    const capture = await adapter.capture(session.sessionId);
    expect(artifacts.records.get(capture.artifactId)).toMatchObject({ runId: "task-1", reviewState: "pending", contentType: "image/png" });
    expect(artifacts.records.get(capture.artifactId)?.purpose).toBeUndefined();
  });

  it("never upload a thumbnail to a page", async () => {
    const state = { url: "about:blank", title: "T", password: false };
    const locator = { setInputFiles: vi.fn(async () => {}) } as unknown as Locator;
    const setup = fakeSetup(state);
    (setup.page as unknown as { locator: unknown }).locator = vi.fn(() => fakeMatches([locator], [{ role: "file" }]));
    const artifacts = fakeArtifacts();
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: setup.launch, artifacts });
    const thumbnail = await artifacts.putArtifact({ workspaceId: "w1", contentType: "image/jpeg", body: "jpg", purpose: "thumbnail" });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.observe(session.sessionId);
    await expect(
      adapter.act({
        sessionId: session.sessionId,
        ref: "el-0",
        epoch: observation.epoch,
        kind: "upload",
        artifactId: thumbnail.artifactId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(locator.setInputFiles).not.toHaveBeenCalled();
  });
});

describe("thumbnailFor", () => {
  const page = (overrides: Partial<ThumbnailPage> = {}): ThumbnailPage => ({
    url: () => "https://example.com/",
    frameUrls: () => ["https://example.com/"],
    hasPasswordField: async () => false,
    hasPaymentField: async () => false,
    jpeg: async () => new Uint8Array([1]),
    ...overrides,
  });

  it("applies the rules in order: blocked host, password field, throttle, image", async () => {
    expect(
      await thumbnailFor(page({ url: () => "https://x.bank/" }), { lastCapturedAt: undefined, now: 0, blockedHosts: ["*.bank"] }),
    ).toEqual({ kind: "sensitive", reason: "blocked-host" });
    expect(
      await thumbnailFor(page({ frameUrls: () => ["https://example.com/", "https://pay.x.bank/widget"] }), {
        lastCapturedAt: undefined,
        now: 0,
        blockedHosts: ["*.bank"],
      }),
    ).toEqual({ kind: "sensitive", reason: "blocked-host" });
    expect(await thumbnailFor(page({ hasPasswordField: async () => true }), { lastCapturedAt: 0, now: 1, blockedHosts: [] })).toEqual({
      kind: "sensitive",
      reason: "password-field",
    });
    expect(await thumbnailFor(page(), { lastCapturedAt: 0, now: BROWSER_THUMBNAIL_INTERVAL_MS - 1, blockedHosts: [] })).toEqual({
      kind: "throttled",
    });
    expect(await thumbnailFor(page(), { lastCapturedAt: 0, now: BROWSER_THUMBNAIL_INTERVAL_MS, blockedHosts: [] })).toEqual({
      kind: "image",
      bytes: new Uint8Array([1]),
    });
  });

  it("checks the page again once the image is taken, and discards it on any doubt", async () => {
    let checks = 0;
    const turned = page({ hasPasswordField: async () => (checks += 1) > 1 });
    expect(await thumbnailFor(turned, { lastCapturedAt: undefined, now: 0, blockedHosts: [] })).toEqual({
      kind: "sensitive",
      reason: "password-field",
    });
    let url = "https://example.com/";
    const redirected = page({
      url: () => url,
      frameUrls: () => [url],
      jpeg: async () => {
        url = "https://x.bank/";
        return new Uint8Array([1]);
      },
    });
    expect(await thumbnailFor(redirected, { lastCapturedAt: undefined, now: 0, blockedHosts: ["*.bank"] })).toEqual({
      kind: "sensitive",
      reason: "blocked-host",
    });
    let calls = 0;
    const failing = page({
      hasPasswordField: async () => {
        calls += 1;
        if (calls > 1) throw new Error("frame detached");
        return false;
      },
    });
    expect(await thumbnailFor(failing, { lastCapturedAt: undefined, now: 0, blockedHosts: [] })).toEqual({
      kind: "sensitive",
      reason: "password-field",
    });
  });

  it("counts a password check that fails as a password field", async () => {
    const failing = page({
      hasPasswordField: async () => {
        throw new Error("frame detached");
      },
    });
    expect(await thumbnailFor(failing, { lastCapturedAt: undefined, now: 0, blockedHosts: [] })).toEqual({
      kind: "sensitive",
      reason: "password-field",
    });
  });

  it("takes no thumbnail of a payment or one-time-code field, and counts a failing check as one", async () => {
    expect(
      await thumbnailFor(page({ hasPaymentField: async () => true }), { lastCapturedAt: undefined, now: 0, blockedHosts: [] }),
    ).toEqual({ kind: "sensitive", reason: "payment-field" });
    const failing = page({
      hasPaymentField: async () => {
        throw new Error("frame detached");
      },
    });
    expect(await thumbnailFor(failing, { lastCapturedAt: undefined, now: 0, blockedHosts: [] })).toEqual({
      kind: "sensitive",
      reason: "payment-field",
    });
    let checks = 0;
    const turned = page({ hasPaymentField: async () => (checks += 1) > 1 });
    expect(await thumbnailFor(turned, { lastCapturedAt: undefined, now: 0, blockedHosts: [] })).toEqual({
      kind: "sensitive",
      reason: "payment-field",
    });
  });
});

describe("the live view's hooks", () => {
  /** A live source that only records what the adapter reports to it. */
  function recordingLive(): BrowserLiveSource & { readonly reports: unknown[] } {
    const reports: unknown[] = [];
    return {
      reports,
      sessions: () => [],
      watch: () => ({ demand: () => undefined, close: () => undefined }),
      onSession: () => () => undefined,
      opened: ({ sessionId, workspaceId, taskId, openedByCallId }) =>
        void reports.push({ opened: { sessionId, workspaceId, taskId, openedByCallId } }),
      retarget: (sessionId) => void reports.push({ retarget: sessionId }),
      navigated: (sessionId, page) => void reports.push({ navigated: sessionId, ...page }),
      action: (sessionId, event) => void reports.push({ actionOn: sessionId, ...event }),
      thumbnail: (sessionId, jpeg) => void reports.push({ thumbnail: sessionId, bytes: jpeg?.byteLength }),
      inactive: (sessionId) => void reports.push({ inactive: sessionId }),
      activated: (sessionId) => void reports.push({ activated: sessionId }),
      closed: (sessionId, reason) => void reports.push({ closed: sessionId, reason }),
      agentCall: () => () => undefined,
      controlState: () => "agent",
      requestHandoff: () => undefined,
      endControl: () => undefined,
    };
  }

  it("reports a task's session by its history id: opening, pages, actions with their call and box but never a typed value, thumbnails and closing", async () => {
    const state: FakePageState = { url: "about:blank", title: "Shop", password: false, link: "https://example.com/next" };
    const setup = fakeSetup(state);
    const live = recordingLive();
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: setup.launch,
      artifacts: fakeArtifacts(),
      history: fakeHistory(),
      newHistoryId: () => "11111111-2222-4333-8444-555555555555",
      thumbnailPage: setup.thumbnailPage,
      live,
      liveTarget: () => ({
        screencast: async () => ({ stop: async () => undefined }),
        sensitivity: async () => undefined,
        onNavigated: () => () => undefined,
      }),
    });
    const id = "11111111-2222-4333-8444-555555555555";
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1", callId: "call-open" });
    const page = await adapter.navigate(session.sessionId, "https://example.com/?q=1", { callId: "call-nav" });
    await adapter.act({
      sessionId: session.sessionId,
      ref: "el-0",
      epoch: page.epoch,
      kind: "type",
      value: "hunter2",
      callId: "call-type",
    });
    await vi.waitFor(() => expect(live.reports.some((report) => (report as { thumbnail?: string }).thumbnail === id)).toBe(true));
    await adapter.close(session.sessionId);
    // The thumbnail is taken off the call's path, so where it lands among the actions is timing; that it is reported is not.
    const isThumbnail = (report: unknown): boolean => (report as { thumbnail?: string }).thumbnail !== undefined;
    expect(live.reports.filter(isThumbnail)).toEqual([{ thumbnail: id, bytes: 3 }]);
    expect(live.reports.filter((report) => !isThumbnail(report))).toEqual([
      { opened: { sessionId: id, workspaceId: "w1", taskId: "task-1", openedByCallId: "call-open" } },
      { actionOn: id, phase: "started", action: "navigate", callId: "call-nav" },
      { actionOn: id, phase: "ended", action: "navigate", status: "accepted", callId: "call-nav" },
      { navigated: id, url: "https://example.com/?q=1", title: "Shop", epoch: 1 },
      { actionOn: id, phase: "started", action: "type", box: { x: 10, y: 20, width: 30, height: 40 }, callId: "call-type" },
      { actionOn: id, phase: "ended", action: "type", status: "accepted", callId: "call-type" },
      { closed: id, reason: "closed" },
    ]);
    expect(JSON.stringify(live.reports)).not.toContain("hunter2");
  });

  it("offers nothing to the live view for a session with no task", async () => {
    const setup = fakeSetup({ url: "about:blank", title: "", password: false });
    const live = recordingLive();
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: setup.launch, history: fakeHistory(), live });
    const session = await adapter.createSession({ workspaceId: "w1" });
    await adapter.navigate(session.sessionId, "https://example.com/");
    expect(live.reports).toEqual([]);
  });

  it("keeps a finished task's session open but inactive, wakes it on the task's next call, and closes it for the operator", async () => {
    const state: FakePageState = { url: "about:blank", title: "Shop", password: false };
    const setup = fakeSetup(state);
    const live = recordingLive();
    const history = fakeHistory();
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: setup.launch,
      history,
      newHistoryId: () => "11111111-2222-4333-8444-555555555555",
      thumbnailPage: setup.thumbnailPage,
      live,
      liveTarget: () => ({
        screencast: async () => ({ stop: async () => undefined }),
        sensitivity: async () => undefined,
        onNavigated: () => () => undefined,
      }),
    });
    const id = "11111111-2222-4333-8444-555555555555";
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    await adapter.taskEnded?.("task-other");
    expect(live.reports.some((report) => (report as { inactive?: string }).inactive !== undefined)).toBe(false);
    await adapter.taskEnded?.("task-1");
    await adapter.taskEnded?.("task-1");
    expect(live.reports.filter((report) => (report as { inactive?: string }).inactive === id)).toHaveLength(1);
    expect(
      history.calls.filter((call) => call.method === "setInactive").map((call) => (call.input as { since: string | null }).since !== null),
    ).toEqual([true]);
    // Every browser call, whichever chat makes it, first asks whether a person holds the session: that look-up wakes nothing.
    expect(adapter.handoffTarget?.(session.sessionId)).toEqual({ historyId: id, taskId: "task-1" });
    expect(live.reports).not.toContainEqual({ activated: id });
    expect(history.calls.filter((call) => call.method === "setInactive")).toHaveLength(1);
    await adapter.navigate(session.sessionId, "https://example.com/");
    await vi.waitFor(() =>
      expect(
        history.calls.filter((call) => call.method === "setInactive").map((call) => (call.input as { since: string | null }).since),
      ).toEqual([expect.any(String), null]),
    );
    expect(live.reports).toContainEqual({ activated: id });
    expect(await adapter.closeRecorded?.("not-a-session", "closed by operator")).toBe(false);
    expect(await adapter.closeRecorded?.(id, "closed by operator")).toBe(true);
    expect(history.calls.find((call) => call.method === "close")?.input).toMatchObject({ sessionId: id, reason: "closed by operator" });
    expect(live.reports.at(-1)).toEqual({ closed: id, reason: "closed by operator" });
    await expect(adapter.navigate(session.sessionId, "https://example.com/")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("reaps an inactive session after sessionIdleMinutes unless reactivated or held by a takeover/handoff", async () => {
    vi.useFakeTimers();
    try {
      const state: FakePageState = { url: "about:blank", title: "Shop", password: false };
      const setup = fakeSetup(state);
      let controlState: "agent" | "requested" | "operator" = "agent";
      const live = {
        ...recordingLive(),
        controlState: () => controlState,
      };
      const history = fakeHistory();
      let counter = 0;
      const adapter = createPlaywrightBrowser({
        stagingDirectory: tmpdir(),
        launch: setup.launch,
        history,
        newHistoryId: () => `11111111-2222-4333-8444-55555555555${(counter += 1)}`,
        thumbnailPage: setup.thumbnailPage,
        live,
        liveTarget: () => ({
          screencast: async () => ({ stop: async () => undefined }),
          sensitivity: async () => undefined,
          onNavigated: () => () => undefined,
        }),
        sessionIdleMinutes: 5,
      });

      // 1. Session reactivated before expiry is not reaped.
      const s1 = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
      await adapter.taskEnded?.("task-1");
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await adapter.observe(s1.sessionId);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(history.calls.filter((call) => call.method === "close")).toHaveLength(0);

      // 2. Session held by an operator takeover or handoff is not reaped.
      await adapter.taskEnded?.("task-1");
      controlState = "operator";
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(history.calls.filter((call) => call.method === "close")).toHaveLength(0);

      // 3. Inactive session in agent control is reaped with reason "idle" after sessionIdleMinutes,
      // and the one the person held once it has been idle that long again after they let it go.
      controlState = "agent";
      const s2 = await adapter.createSession({ workspaceId: "w1", taskId: "task-2" });
      await adapter.taskEnded?.("task-2");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(history.calls.filter((call) => call.method === "close").map((call) => call.input)).toEqual([
        expect.objectContaining({
          sessionId: "11111111-2222-4333-8444-555555555551",
          reason: BROWSER_CLOSE_REASON_IDLE,
        }),
        expect.objectContaining({
          sessionId: "11111111-2222-4333-8444-555555555552",
          reason: BROWSER_CLOSE_REASON_IDLE,
        }),
      ]);
      expect(live.reports).toContainEqual({
        closed: "11111111-2222-4333-8444-555555555552",
        reason: "idle",
      });
      await expect(adapter.observe(s2.sessionId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaps after the workspace's own idle minutes, and never when it says 0", async () => {
    vi.useFakeTimers();
    try {
      const state: FakePageState = { url: "about:blank", title: "Shop", password: false };
      const setup = fakeSetup(state);
      const history = fakeHistory();
      let counter = 0;
      const adapter = createPlaywrightBrowser({
        stagingDirectory: tmpdir(),
        launch: setup.launch,
        history,
        newHistoryId: () => `11111111-2222-4333-8444-55555555555${(counter += 1)}`,
        thumbnailPage: setup.thumbnailPage,
        sessionIdleMinutes: async (workspaceId) => {
          if (workspaceId === "unread") throw new Error("settings unavailable");
          return workspaceId === "keep" ? 0 : 2;
        },
      });
      const kept = await adapter.createSession({ workspaceId: "keep", taskId: "task-k" });
      const short = await adapter.createSession({ workspaceId: "short", taskId: "task-s" });
      await adapter.taskEnded?.("task-k");
      await adapter.taskEnded?.("task-s");
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await expect(adapter.observe(short.sessionId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await expect(adapter.observe(kept.sessionId)).resolves.toBeDefined();
      // A setting that cannot be read leaves the default, 30 minutes.
      const unread = await adapter.createSession({ workspaceId: "unread", taskId: "task-u" });
      await adapter.taskEnded?.("task-u");
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      await expect(adapter.observe(unread.sessionId)).resolves.toBeDefined();
      await adapter.taskEnded?.("task-u");
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      await expect(adapter.observe(unread.sessionId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses the agent's calls while a person acts in the session, and takes no thumbnail of what they do (invariants 8 and 9)", async () => {
    const state: FakePageState = { url: "about:blank", title: "Shop", password: false };
    const setup = fakeSetup(state);
    const control = { state: "agent" as "agent" | "operator", calls: 0 };
    const live = {
      ...recordingLive(),
      agentCall: () => {
        if (control.state !== "agent")
          throw new TaviError("CONFLICT", "A person is controlling this browser session", { details: { control: control.state } });
        control.calls += 1;
        return () => void (control.calls -= 1);
      },
      controlState: () => control.state,
    };
    const artifacts = fakeArtifacts();
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: setup.launch,
      artifacts,
      history: fakeHistory(),
      newHistoryId: () => "11111111-2222-4333-8444-555555555555",
      thumbnailPage: setup.thumbnailPage,
      live,
      liveTarget: () => ({
        screencast: async () => ({ stop: async () => undefined }),
        sensitivity: async () => undefined,
        onNavigated: () => () => undefined,
      }),
    });
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    // A thumbnail queued by the agent's last call is not taken once a person acts.
    await adapter.navigate(session.sessionId, "https://example.com/");
    control.state = "operator";
    await settle();
    expect(artifacts.records.size).toBe(0);
    for (const call of [
      () => adapter.navigate(session.sessionId, "https://example.com/two"),
      () => adapter.observe(session.sessionId),
      () => adapter.read(session.sessionId),
      () => adapter.capture(session.sessionId),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "CONFLICT", details: { control: "operator" } });
    }
    control.state = "agent";
    await adapter.observe(session.sessionId);
    // Every call that ran was let go.
    expect(control.calls).toBe(0);
  });

  it("outlines an action waiting for approval without touching the page, and takes the outline away when denied", async () => {
    const state: FakePageState = { url: "about:blank", title: "Shop", password: false, link: "https://example.com/next" };
    const setup = fakeSetup(state);
    const live = recordingLive();
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: setup.launch,
      history: fakeHistory(),
      newHistoryId: () => "11111111-2222-4333-8444-555555555555",
      thumbnailPage: setup.thumbnailPage,
      live,
      liveTarget: () => ({
        screencast: async () => ({ stop: async () => undefined }),
        sensitivity: async () => undefined,
        onNavigated: () => () => undefined,
      }),
    });
    const id = "11111111-2222-4333-8444-555555555555";
    const session = await adapter.createSession({ workspaceId: "w1", taskId: "task-1" });
    const page = await adapter.navigate(session.sessionId, "https://example.com/");
    const before = live.reports.length;
    await adapter.pendingAction?.({ sessionId: session.sessionId, ref: "el-0", epoch: page.epoch, kind: "submit", callId: "call-submit" });
    expect(live.reports.slice(before)).toEqual([
      { actionOn: id, phase: "pending", action: "submit", box: { x: 10, y: 20, width: 30, height: 40 }, callId: "call-submit" },
    ]);
    // Nothing was done to the page: it only read the element's box, and the page stayed where it was.
    expect(state.url).toBe("https://example.com/");
    // A ref of an older page outlines nothing.
    await adapter.pendingAction?.({ sessionId: session.sessionId, ref: "el-0", epoch: page.epoch - 1, kind: "submit", callId: "call-old" });
    expect(live.reports).toHaveLength(before + 1);
    await adapter.pendingAction?.({
      sessionId: session.sessionId,
      ref: "el-0",
      epoch: page.epoch,
      kind: "submit",
      callId: "call-submit",
      decided: "denied",
    });
    expect(live.reports.at(-1)).toEqual({ actionOn: id, phase: "ended", action: "submit", status: "rejected", callId: "call-submit" });
  });
});
