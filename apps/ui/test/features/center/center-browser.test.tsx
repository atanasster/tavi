// @vitest-environment jsdom
import type { BrowserSessionView, CenterSummaryAnswer } from "@tavi/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Browser,
  BROWSER_REFRESH_MS,
  BROWSER_TICK_MS,
  clearThumbnailCache,
  hostLetter,
  hostPath,
} from "../../../src/features/center/Browser.js";
import { refreshFirstPage } from "../../../src/lib/paging.js";
import { readThumbnail } from "../../../src/features/center/browser-api.js";
import { sectionCount } from "../../../src/features/center/CenterNav.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { TakeoverContext, type TakeoverTarget } from "../../../src/features/takeover/context.js";
import { InWorkspace } from "../../support/workspace.js";
import { flush, settledBy, unmountAll } from "../../support/dom.js";

/**
 * Browser: live sessions under "Open now"
 * and the rest under "Earlier", each card with its thumbnail (read through
 * `artifacts read`, once per artifact) or the host's letter, a Live pill and a
 * ticking duration, visits on demand, the task on a click; feed changes read
 * the lists again at most every five seconds; an empty state; the nav count.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => clearThumbnailCache());
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

/** What was asked answered: microtasks only, as tests here fake the clock. */
const { settle, mount, click, rerender } = settledBy(() => flush());

type Answer = { readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly message: string } };
const ok = (result: unknown): Answer => ({ ok: true, result });

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const JPEG_BASE64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0));

const session = (sessionId: string, extra: Partial<BrowserSessionView> = {}): BrowserSessionView => ({
  sessionId,
  taskId: `task-${sessionId}`,
  taskTitle: `Task for ${sessionId}`,
  principalId: "operator",
  openedAt: "2026-09-29T11:42:00.000Z",
  closedAt: null,
  closeReason: null,
  live: true,
  lastUrl: "https://www.facebananas.com/pricing",
  host: "www.facebananas.com",
  lastTitle: "Pricing · FaceBananas",
  pages: 12,
  durationMs: 18 * 60_000,
  ...extra,
});

interface OwnerState {
  open: BrowserSessionView[];
  closed: BrowserSessionView[][];
}

function owner(state: OwnerState): {
  readonly client: SettingsClient;
  readonly sent: { command: string; payload: Record<string, unknown> }[];
} {
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  const client = {
    request: (command: string, payload: Record<string, unknown>) => {
      sent.push({ command, payload });
      if (command === "browser" && payload["action"] === "list") {
        if (payload["open"] === true) return Promise.resolve(ok({ items: state.open }));
        const index = payload["cursor"] === undefined ? 0 : Number(payload["cursor"]);
        const page = state.closed[index] ?? [];
        return Promise.resolve(ok({ items: page, ...(index + 1 < state.closed.length ? { nextCursor: String(index + 1) } : {}) }));
      }
      if (command === "browser" && payload["action"] === "visits") {
        return Promise.resolve(
          ok({
            sessionId: payload["sessionId"],
            items: [
              { seq: 1, url: "https://www.facebananas.com/gallery/professional", title: "Gallery", at: "2026-09-29T11:41:00.000Z" },
              { seq: 2, url: "https://www.facebananas.com/pricing", title: null, at: "2026-09-29T11:52:00.000Z" },
            ],
          }),
        );
      }
      if (command === "artifacts" && payload["action"] === "read") {
        return Promise.resolve(
          ok({
            artifactId: payload["artifactId"],
            contentType: "image/jpeg",
            hash: "a".repeat(64),
            totalBytes: 4,
            offset: 0,
            base64: JPEG_BASE64,
            nextOffset: null,
          }),
        );
      }
      return Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: `unscripted ${command}` } });
    },
  } as unknown as SettingsClient;
  return { client, sent };
}

const summary = (overrides: Partial<CenterSummaryAnswer> = {}): CenterSummaryAnswer => ({
  workspaceId: "default",
  timezone: "UTC",
  today: "2026-09-29",
  counts: {
    approvals: 0,
    reviews: 0,
    questions: 0,
    runningTasks: 0,
    memoryProposals: 0,
    activeRoutines: 0,
    schedules: 0,
    liveBrowserSessions: 1,
  },
  perDay: [{ date: "2026-09-29", tasks: 0 }],
  next: [],
  people: {},
  cursor: "c1",
  ...overrides,
});

const cards = (view: ParentNode): HTMLElement[] => [...view.querySelectorAll<HTMLElement>(".browser-card")];
const sentOf = (sent: { command: string; payload: Record<string, unknown> }[], command: string, action: string) =>
  sent.filter((item) => item.command === command && item.payload["action"] === action);

describe("helpers", () => {
  it("say host paths and letters", () => {
    expect(hostPath("https://bahn.de:8443/buchung/fahrplan")).toBe("bahn.de:8443/buchung/fahrplan");
    expect(hostPath("about:blank")).toBe("about:blank");
    expect(hostLetter("www.bahn.de")).toBe("B");
    expect(hostLetter(null)).toBe("?");
  });

  it("lays a fresh first page over older pages held", () => {
    const held = { items: [session("c"), session("b", { openedAt: "2026-09-28T00:00:00.000Z" })], nextCursor: "2", pages: 2 };
    const mergeFirstPage = (listed: typeof held, page: { readonly items: typeof held.items }) =>
      refreshFirstPage(
        listed,
        page,
        (item) => item.sessionId,
        (item) => item.openedAt,
      );
    const merged = mergeFirstPage(held, { items: [session("d"), session("c")] });
    expect(merged.items.map((item) => item.sessionId)).toEqual(["d", "c", "b"]);
    expect(merged.nextCursor).toBe("2");
    expect(mergeFirstPage({ ...held, pages: 1 }, { items: [session("d")] }).items.map((item) => item.sessionId)).toEqual(["d"]);
  });
});

describe("the Browser section", () => {
  it("shows live cards with a thumbnail and a Live pill, closed ones with the host's letter, and ticks the live duration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    const { client, sent } = owner({
      open: [session("live", { thumbnail: { artifactId: "art-thumb" } })],
      closed: [
        [
          session("done", {
            live: false,
            closedAt: "2026-09-28T21:40:00.000Z",
            openedAt: "2026-09-28T21:14:00.000Z",
            durationMs: 26 * 60_000,
            pages: 23,
            host: "bahn.de",
            lastUrl: "https://bahn.de/buchung",
            lastTitle: "Your booking",
            taskTitle: undefined,
          }),
        ],
      ],
    });
    const onOpenTask = vi.fn(() => Promise.resolve());
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Browser summary={summary()} revision={0} onOpenTask={onOpenTask} />
      </InWorkspace>,
    );

    expect([...view.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["Open now1 live", "Earlier"]);
    const [live, done] = cards(view);
    expect(live?.querySelector(".browser-live")?.textContent).toBe("Live");
    expect(live?.querySelector("img")?.getAttribute("src")).toBe(`data:image/jpeg;base64,${JPEG_BASE64}`);
    expect(live?.querySelector(".browser-card-title")?.textContent).toBe("Task for live");
    expect(live?.querySelector(".browser-card-page")?.textContent).toBe("www.facebananas.com · Pricing · FaceBananas");
    expect(live?.querySelector(".browser-card-meta")?.textContent).toBe("12 pages · 18 min");
    expect(done?.querySelector(".browser-live")).toBeNull();
    expect(done?.querySelector("img")).toBeNull();
    expect(done?.querySelector(".browser-letter")?.textContent).toBe("B");
    expect(done?.querySelector(".browser-card-title")?.textContent).toBe("Task task-done");
    expect(done?.querySelector(".browser-card-meta")?.textContent).toBe("23 pages · yesterday · 26 min");
    expect(sentOf(sent, "artifacts", "read").map((item) => item.payload)).toEqual([
      { action: "read", workspaceId: "default", artifactId: "art-thumb", offset: 0 },
    ]);

    // A minute later the live duration has moved; the closed one has not.
    await act(async () => {
      vi.advanceTimersByTime(BROWSER_TICK_MS);
    });
    expect(live?.querySelector(".browser-card-meta")?.textContent).toBe("12 pages · 19 min");
    expect(done?.querySelector(".browser-card-meta")?.textContent).toBe("23 pages · yesterday · 26 min");

    // The card's body opens the task.
    const link = live?.querySelector<HTMLAnchorElement>("a.browser-card-open");
    expect(link?.getAttribute("href")).toBe("/tasks/task-live");
    await click(link);
    // No call recorded for this session: the task alone.
    expect(onOpenTask).toHaveBeenCalledWith("task-live", undefined);
  });

  it("shows a session whose task ended as Ended, not counted live, and closes it with Close browser", async () => {
    const { client, sent } = owner({ open: [session("ended", { live: false, inactive: true })], closed: [[]] });
    const base = client.request.bind(client);
    (client as { request: SettingsClient["request"] }).request = ((
      command: Parameters<SettingsClient["request"]>[0],
      payload: Record<string, unknown>,
    ) =>
      command === "browser" && payload["action"] === "close"
        ? (sent.push({ command, payload }), Promise.resolve(ok({ closed: [payload["sessionId"]] })))
        : base(command, payload)) as SettingsClient["request"];
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Browser
          summary={summary({ counts: { ...summary().counts, liveBrowserSessions: 0 } })}
          revision={0}
          onOpenTask={() => Promise.resolve()}
        />
      </InWorkspace>,
    );
    expect(view.querySelector("h2")?.textContent).toBe("Open now0 live");
    const [ended] = cards(view);
    expect(ended?.querySelector(".browser-ended")?.textContent).toBe("Ended");
    const button = [...(ended?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent === "Close browser");
    await click(button);
    expect(sentOf(sent, "browser", "close").map((item) => item.payload)).toEqual([
      { action: "close", workspaceId: "default", sessionId: "ended" },
    ]);
    expect(ended?.querySelector(".browser-ended")).toBeNull();
    expect([...(ended?.querySelectorAll("button") ?? [])].some((candidate) => candidate.textContent === "Close browser")).toBe(false);
  });

  it("offers Take control on a session whose task ended: the page is kept, and still the person's to take", async () => {
    const { client } = owner({ open: [session("ended", { live: false, inactive: true })], closed: [[]] });
    const opened: TakeoverTarget[] = [];
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <TakeoverContext.Provider value={{ open: (target) => void opened.push(target), decline: async () => undefined }}>
          <Browser summary={summary()} revision={0} onOpenTask={() => Promise.resolve()} />
        </TakeoverContext.Provider>
      </InWorkspace>,
    );
    const [ended] = cards(view);
    await click([...(ended?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent === "Take control"));
    expect(opened).toEqual([{ taskId: "task-ended", sessionId: "ended", kept: true }]);
  });

  it("loads the visits when a card is expanded, host and path per line", async () => {
    const { client, sent } = owner({ open: [session("live")], closed: [[]] });
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Browser summary={summary()} revision={0} onOpenTask={() => Promise.resolve()} />
      </InWorkspace>,
    );
    expect(sentOf(sent, "browser", "visits")).toEqual([]);
    const toggle = [...view.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Show visits"));
    await click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(sentOf(sent, "browser", "visits").map((item) => item.payload)).toEqual([
      { action: "visits", workspaceId: "default", sessionId: "live", limit: 200 },
    ]);
    const lines = [...view.querySelectorAll(".browser-visits-list li")].map((line) => [
      line.querySelector("time")?.textContent,
      line.querySelector("span")?.textContent,
    ]);
    expect(lines).toEqual([
      ["11:41", "www.facebananas.com/gallery/professional"],
      ["11:52", "www.facebananas.com/pricing"],
    ]);
  });

  it("names the person when the workspace has more than one", async () => {
    const { client } = owner({ open: [session("live", { principalId: "anna" })], closed: [[]] });
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Browser summary={summary({ people: { operator: "Me", anna: "Anna" } })} revision={0} onOpenTask={() => Promise.resolve()} />
      </InWorkspace>,
    );
    expect(cards(view)[0]?.querySelector(".browser-card-meta")?.textContent).toBe("12 pages · 18 minAnna");
  });

  it("pages Earlier with Load older", async () => {
    const { client } = owner({
      open: [],
      closed: [
        [session("b", { live: false, closedAt: "2026-09-29T11:00:00.000Z" })],
        [session("a", { live: false, closedAt: "2026-09-28T11:00:00.000Z", openedAt: "2026-09-28T10:00:00.000Z" })],
      ],
    });
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Browser summary={summary()} revision={0} onOpenTask={() => Promise.resolve()} />
      </InWorkspace>,
    );
    expect(cards(view)).toHaveLength(1);
    await click([...view.querySelectorAll("button")].find((candidate) => candidate.textContent === "Load older"));
    expect(cards(view).map((card) => card.querySelector(".browser-card-title")?.textContent)).toEqual(["Task for b", "Task for a"]);
    expect([...view.querySelectorAll("button")].some((candidate) => candidate.textContent === "Load older")).toBe(false);
  });

  it("reads the lists again on a browser change, at most every five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    const { client, sent } = owner({ open: [session("live")], closed: [[]] });
    const element = (revision: number) => (
      <InWorkspace client={client} workspaceId="default">
        <Browser summary={summary()} revision={revision} onOpenTask={() => Promise.resolve()} />
      </InWorkspace>
    );
    await mount(element(0));
    const lists = () => sentOf(sent, "browser", "list").length;
    expect(lists()).toBe(2);
    // Changes right after the first read wait for the spell to pass, and fold into one read.
    await rerender(element(1));
    await rerender(element(2));
    await rerender(element(3));
    expect(lists()).toBe(2);
    await act(async () => {
      vi.advanceTimersByTime(BROWSER_REFRESH_MS - 1);
    });
    expect(lists()).toBe(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await settle();
    expect(lists()).toBe(4);
    // After a quiet spell, a change reads at once.
    await act(async () => {
      vi.advanceTimersByTime(BROWSER_REFRESH_MS);
    });
    await rerender(element(4));
    expect(lists()).toBe(6);
  });

  it("caches a thumbnail by artifact across re-renders and refreshes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    const { client, sent } = owner({ open: [session("live", { thumbnail: { artifactId: "art-thumb" } })], closed: [[]] });
    const element = (revision: number) => (
      <InWorkspace client={client} workspaceId="default">
        <Browser summary={summary()} revision={revision} onOpenTask={() => Promise.resolve()} />
      </InWorkspace>
    );
    await mount(element(0));
    await act(async () => {
      vi.advanceTimersByTime(BROWSER_REFRESH_MS);
    });
    await rerender(element(1));
    expect(sentOf(sent, "browser", "list")).toHaveLength(4);
    expect(sentOf(sent, "artifacts", "read")).toHaveLength(1);
  });

  it("says nothing was browsed when there is nothing", async () => {
    const { client } = owner({ open: [], closed: [[]] });
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Browser summary={summary()} revision={0} onOpenTask={() => Promise.resolve()} />
      </InWorkspace>,
    );
    expect(view.querySelector(".empty-state")?.textContent).toBe("Nothing browsed in the last 30 days.");
    expect(cards(view)).toHaveLength(0);
  });

  it("says how many more are live than one read lists, a shown ended session not taken off the live count", async () => {
    const open = [...Array.from({ length: 3 }, (_, index) => session(`live-${index}`)), session("ended", { live: false, inactive: true })];
    const { client } = owner({ open, closed: [[]] });
    const truncated: SettingsClient = {
      request: async (command, payload, options) => {
        const answer = await client.request(command, payload, options);
        const body = payload as Record<string, unknown>;
        return command === "browser" && body["action"] === "list" && body["open"] === true
          ? ({ ...answer, result: { items: open, nextCursor: "more" } } as never)
          : answer;
      },
    };
    const view = await mount(
      <InWorkspace client={truncated} workspaceId="default">
        <Browser
          summary={summary({ counts: { ...summary().counts, liveBrowserSessions: 57 } })}
          revision={0}
          onOpenTask={() => Promise.resolve()}
        />
      </InWorkspace>,
    );
    expect(cards(view)).toHaveLength(4);
    expect(view.querySelector(".browser-more")?.textContent).toBe("And 54 more live; the newest 4 are shown.");

    // A list that holds every live session says nothing more.
    unmountAll();
    const whole = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Browser
          summary={summary({ counts: { ...summary().counts, liveBrowserSessions: 3 } })}
          revision={0}
          onOpenTask={() => Promise.resolve()}
        />
      </InWorkspace>,
    );
    expect(whole.querySelector(".browser-more")).toBeNull();
  });

  it("opens a card's task at the tool call that opened its session", async () => {
    const { client } = owner({ open: [session("live", { openedByCallId: "call-open-7" })], closed: [[]] });
    const onOpenTask = vi.fn(() => Promise.resolve());
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Browser summary={summary()} revision={0} onOpenTask={onOpenTask} />
      </InWorkspace>,
    );
    await click(cards(view)[0]?.querySelector("a.browser-card-open"));
    expect(onOpenTask).toHaveBeenLastCalledWith("task-live", "call-open-7");
  });

  it("counts live sessions in the nav", () => {
    expect(sectionCount("browser", summary())).toEqual({ value: 1, spoken: "1 open now", waiting: false });
    expect(sectionCount("browser", summary({ counts: { ...summary().counts, liveBrowserSessions: 0 } }))).toBeUndefined();
    expect(sectionCount("browser", summary({ counts: { ...summary().counts, liveBrowserSessions: undefined } }))).toBeUndefined();
  });
});

describe("readThumbnail", () => {
  const BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x10, 0x4a, 0x46];
  const base64 = (bytes: readonly number[]) => btoa(String.fromCharCode(...bytes));
  /** An owner answering `artifacts read` chunk by chunk from `chunk(offset)`; it records the offsets asked. */
  const chunked = (chunk: (offset: number) => Record<string, unknown>) => {
    const offsets: unknown[] = [];
    const client = {
      request: (_command: string, payload: Record<string, unknown>) => {
        offsets.push(payload["offset"]);
        return Promise.resolve(
          ok({
            artifactId: "art-1",
            contentType: "image/jpeg",
            hash: "a".repeat(64),
            totalBytes: BYTES.length,
            ...chunk(Number(payload["offset"])),
          }),
        );
      },
    } as unknown as SettingsClient;
    return { client, offsets };
  };

  it("joins chunks cut at a byte offset that is not a multiple of three", async () => {
    // The first chunk's base64 ends in padding, so the chunks cannot be joined as text.
    const { client, offsets } = chunked((offset) =>
      offset === 0
        ? { offset: 0, base64: base64(BYTES.slice(0, 4)), nextOffset: 4 }
        : { offset: 4, base64: base64(BYTES.slice(4)), nextOffset: null },
    );
    const outcome = await readThumbnail(client, "default", "art-1");
    expect(offsets).toEqual([0, 4]);
    expect(outcome.ok).toBe(true);
    const url = outcome.ok ? outcome.value : "";
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect([...atob(url.slice("data:image/jpeg;base64,".length))].map((character) => character.charCodeAt(0))).toEqual(BYTES);
  });

  it("fails when the body changes between chunks", async () => {
    const { client } = chunked((offset) =>
      offset === 0
        ? { offset: 0, base64: base64(BYTES.slice(0, 4)), nextOffset: 4 }
        : { offset: 4, hash: "b".repeat(64), base64: base64(BYTES.slice(4)), nextOffset: null },
    );
    expect(await readThumbnail(client, "default", "art-1")).toEqual({ ok: false, message: "The thumbnail changed while it was read" });
  });

  it("fails for a body that is not an image", async () => {
    const { client } = chunked(() => ({ contentType: "text/html", offset: 0, base64: base64(BYTES), nextOffset: null }));
    expect(await readThumbnail(client, "default", "art-1")).toEqual({ ok: false, message: "The thumbnail is not an image" });
  });

  it("gives up after too many chunks", async () => {
    const { client, offsets } = chunked((offset) => ({ offset, base64: base64([1]), nextOffset: offset + 1 }));
    expect(await readThumbnail(client, "default", "art-1")).toEqual({ ok: false, message: "The thumbnail is too large to show" });
    expect(offsets).toHaveLength(16);
  });
});

describe("the center.browser slot", () => {
  it("shows the newest two live sessions live, in the browser view's frame, and the rest as their thumbnails", async () => {
    const { contributionsForSlot, resolveContributions } = await import("../../../src/features/plugin-host/slots.js");
    const { CenterBrowserSlotContext } = await import("../../../src/features/plugin-host/CenterBrowserSlot.js");
    const contributions = resolveContributions(
      [
        {
          pluginId: "tavi.browserview",
          kind: "builtin",
          contentHash: "a".repeat(64),
          ui: {
            abi: "tavi.ui/1",
            contributions: [
              {
                id: "live",
                role: "browser-view",
                title: "Browser",
                document: "live.html",
                channels: ["browser.live"],
                disclosure: "Images.",
                placements: [{ slot: "center.browser" }],
              },
            ],
          },
        },
      ],
      {},
    ).contributions;
    const slot = {
      items: contributionsForSlot(contributions, "center.browser"),
      client: { liveWatch: async () => ({ response: { ok: true } }) } as never,
    };
    const { client } = owner({ open: [session("one"), session("two"), session("three")], closed: [[]] });
    const view = await mount(
      <CenterBrowserSlotContext.Provider value={slot}>
        <InWorkspace client={client} workspaceId="default">
          <Browser
            summary={summary({ counts: { ...summary().counts, liveBrowserSessions: 3 } })}
            revision={0}
            onOpenTask={() => Promise.resolve()}
          />
        </InWorkspace>
      </CenterBrowserSlotContext.Provider>,
    );
    const [one, two, three] = cards(view);
    for (const card of [one, two]) {
      const frame = card?.querySelector(".browser-thumb-live iframe");
      expect(frame?.getAttribute("data-plugin")).toBe("tavi.browserview");
      // Outside the card's link: a live page is not part of a link.
      expect(frame?.closest("a")).toBeNull();
    }
    expect(three?.querySelector("iframe")).toBeNull();
    expect(three?.querySelector(".browser-letter, img")).not.toBeNull();
  });
});
