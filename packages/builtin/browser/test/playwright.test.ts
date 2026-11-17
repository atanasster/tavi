import {
  BROWSER_OBSERVATION_MAX_ELEMENTS,
  TaviError,
  type ArtifactRecord,
  type ArtifactRepositoryPort,
  type BrowserAction,
  type BrowserHistoryRepositoryPort,
} from "@tavi/contracts";
import type { Browser, BrowserContext, Download, Locator, Page } from "playwright";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VERIFY_TARGET_IN_PAGE } from "../src/guard.js";
import { createPlaywrightBrowser, type ScannedElement } from "../src/playwright.js";
import { fakeMatches } from "./fake-matches.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

/**
 * Real `BrowserPort` adapter over Playwright.
 * Every test injects a fake `launch` returning fake `Browser`/
 * `BrowserContext`/`Page`/`Locator` objects — no real Chromium is ever
 * launched. See playwright.ts's own header comment for what this leaves
 * unverified.
 */

function fixtureArtifacts(): ArtifactRepositoryPort & {
  patchRecord(artifactId: string, patch: Partial<ArtifactRecord>): void;
} {
  const records = new Map<string, ArtifactRecord>();
  const bodies = new Map<string, Uint8Array>();
  let counter = 0;
  return {
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
        ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
        ...(input.folderCopy === undefined ? {} : { folderCopy: input.folderCopy }),
        ...(input.label === undefined ? {} : { label: input.label }),
      };
      records.set(artifactId, record);
      bodies.set(artifactId, bytes);
      return record;
    },
    getArtifact: async (artifactId) => records.get(artifactId),
    readArtifactBody: async (artifactId) => bodies.get(artifactId),
    // No video previews in these fixtures (video retention's check).
    derivedPreviewExists: async () => false,
    listPendingReview: async (workspaceId, limit) =>
      [...records.values()].filter((record) => record.workspaceId === workspaceId && record.reviewState === "pending").slice(0, limit),
    async setReviewState(input) {
      const record = records.get(input.artifactId);
      if (record === undefined) {
        throw new TaviError("NOT_FOUND", `No artifact ${input.artifactId}`);
      }
      if (record.reviewState !== "pending") {
        throw new TaviError("CONFLICT", `Artifact ${input.artifactId} already has a terminal review state (${record.reviewState})`);
      }
      records.set(input.artifactId, {
        ...record,
        reviewState: input.reviewState,
        reviewedBy: input.reviewedBy,
        reviewedAt: input.reviewedAt,
      });
    },
    /** Test-only: patch a stored record to simulate a store whose row disagrees with its bytes. */
    patchRecord: (artifactId, patch) => {
      const record = records.get(artifactId);
      if (record === undefined) throw new TaviError("NOT_FOUND", `No artifact ${artifactId}`);
      records.set(artifactId, { ...record, ...patch });
    },
  };
}

/** A locator's reads for the sensitive-field check (`factsOfLocator`): an ordinary text field, shown, with nothing around it. */
function ordinaryField(): Partial<Locator> {
  const none = { count: async () => 0 } as unknown as Locator;
  return {
    ariaSnapshot: vi.fn(async () => '- textbox "Name"'),
    getAttribute: vi.fn(async () => null),
    locator: vi.fn(() => none),
    boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 100, height: 20 })),
    isVisible: vi.fn(async () => true),
  } as Partial<Locator>;
}

function fakeLocator(overrides: Partial<Locator> = {}): Locator {
  return {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    setInputFiles: vi.fn(async () => {}),
    // What a field says of itself, as Playwright's utility world reads it: an ordinary, shown field.
    ...ordinaryField(),
    ...overrides,
  } as unknown as Locator;
}

function fakePage(
  options: {
    readonly locators?: readonly Locator[];
    /** What the scan reports of each locator: see `fakeMatches`. */
    readonly elements?: readonly Omit<ScannedElement, "index">[];
    readonly url?: string;
    readonly screenshot?: () => Promise<Buffer>;
    readonly waitForDownload?: () => Promise<Download>;
    /** What a frame's query for a field answers: by default none is found; `"stall"` never answers. */
    readonly field?: (selector: string) => Promise<unknown> | "stall";
  } = {},
): Page {
  const locators = options.locators ?? [];
  let url = options.url ?? "about:blank";
  return {
    goto: vi.fn(async (target: string) => {
      url = target;
      return null;
    }),
    url: vi.fn(() => url),
    // One frame with no password, payment or one-time-code field: not sensitive.
    frames: vi.fn(() => [
      {
        url: () => url,
        $: (selector: string) => {
          const found = options.field?.(selector) ?? Promise.resolve(null);
          return found === "stall" ? new Promise(() => {}) : found;
        },
      },
    ]),
    locator: vi.fn(() => fakeMatches(locators, options.elements)),
    screenshot: vi.fn(options.screenshot ?? (async () => Buffer.from("png-bytes"))),
    waitForLoadState: vi.fn(async () => undefined),
    close: vi.fn(async () => {}),
    once: vi.fn(),
    on: vi.fn(),
    opener: vi.fn(async () => null),
    waitForEvent: vi.fn(async (event: string) => {
      if (event !== "download") throw new Error(`unexpected waitForEvent: ${event}`);
      if (options.waitForDownload === undefined) throw new Error("no download configured");
      return options.waitForDownload();
    }),
  } as unknown as Page;
}

/** `popup`: the page a click opens in a new tab; without one, the wait for a tab gives up at once. */
function fakeContext(page: Page, popup?: () => Page | undefined): BrowserContext {
  return {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
    waitForEvent: vi.fn(async (event: string) => {
      if (event !== "page") throw new Error(`unexpected waitForEvent: ${event}`);
      // Resolved after the click has landed, as a real new tab is.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const opened = popup?.();
      if (opened === undefined) throw new Error('Timeout 1000ms exceeded while waiting for event "page"');
      return opened;
    }),
  } as unknown as BrowserContext;
}

function fakeBrowser(context: BrowserContext): Browser {
  return {
    newContext: vi.fn(async () => context),
  } as unknown as Browser;
}

const command: BrowserAction = { sessionId: "s", ref: "el-0", epoch: 1, kind: "click" };

describe("createPlaywrightBrowser — session lifecycle", () => {
  it("creates a session, navigates, and observes bounded interactive elements", async () => {
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator], elements: [{ role: "button", text: "Submit" }], url: "https://example.com" });
    const context = fakeContext(page);
    const browser = fakeBrowser(context);
    const launch = vi.fn(async () => browser);

    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch });
    const session = await adapter.createSession({ workspaceId: "w1" });
    expect(session.state).toBe("open");

    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    expect(observation.url).toBe("https://example.com");
    expect(observation.epoch).toBe(1);
    // The document, then a bounded wait for its subresources.
    expect(page.goto).toHaveBeenCalledWith("https://example.com", { waitUntil: "domcontentloaded" });
    expect(page.waitForLoadState).toHaveBeenCalledWith("load");
    expect(observation.elements).toEqual([{ ref: "el-0", role: "button", text: "Submit" }]);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("opens only an absolute URL, never one Playwright would complete on its own terms", async () => {
    const page = fakePage({ url: "https://example.com" });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: vi.fn(async () => fakeBrowser(fakeContext(page))) });
    const { sessionId } = await adapter.createSession({ workspaceId: "w1" });
    for (const url of ["127.0.0.1.attacker.example/leak", "localhost:8080/x", "localhostattacker.example/x", "/next"])
      await expect(adapter.navigate(sessionId, url)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("re-reads the page's host the moment before acting, and lets a new document make the old refs stale", async () => {
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator], elements: [{ role: "button", text: "Next" }], url: "https://example.com" });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: vi.fn(async () => fakeBrowser(fakeContext(page))) });
    const { sessionId } = await adapter.createSession({ workspaceId: "w1" });
    const observed = await adapter.navigate(sessionId, "https://example.com");
    const click: BrowserAction = {
      sessionId,
      ref: "el-0",
      epoch: observed.epoch,
      kind: "click",
      guard: { commitApproved: false, hosts: ["example.com"] },
    };
    // A timer moved the page to another site after the call was decided.
    await page.goto("https://other.example/");
    await expect(adapter.act(click)).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
      message: expect.stringContaining("the page moved to other.example"),
    });
    expect(locator.click).not.toHaveBeenCalled();
    // The new document's load makes every ref the agent holds stale.
    await page.goto("https://example.com/next");
    const loaded = (page.on as ReturnType<typeof vi.fn>).mock.calls.find(([event]) => event === "domcontentloaded")?.[1] as
      | (() => void)
      | undefined;
    loaded?.();
    await expect(adapter.act(click)).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("stale") });
  });

  it("lets a frame's element be acted on only on that frame's decided host, the page's covering a same-origin frame alone, and holds a drag's drop target too", async () => {
    const mainButton = fakeLocator();
    const page = fakePage({ locators: [mainButton], elements: [{ role: "button", text: "Main" }], url: "https://example.com/" });
    const frameButton = (name: string) => {
      const locator = fakeLocator();
      return { locator, matches: fakeMatches([locator], [{ role: "button", text: name }]) };
    };
    const same = frameButton("Same");
    const cross = frameButton("Pay");
    const main = { url: () => page.url(), $: async () => null, parentFrame: () => null };
    const child = (url: string, matches: ReturnType<typeof fakeMatches>) => ({
      url: () => url,
      $: async () => null,
      parentFrame: () => main,
      locator: () => matches,
    });
    const frames = [main, child("https://example.com/widget", same.matches), child("https://pay.example/checkout", cross.matches)];
    Object.assign(page, { frames: () => frames, mainFrame: () => main });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: vi.fn(async () => fakeBrowser(fakeContext(page))) });
    const { sessionId } = await adapter.createSession({ workspaceId: "w1" });
    const observed = await adapter.navigate(sessionId, "https://example.com/");
    const refOf = (frame: string) => observed.elements.find((element) => element.frame === frame)?.ref ?? "";
    const sameRef = refOf("https://example.com");
    const crossRef = refOf("https://pay.example");
    expect([sameRef, crossRef]).toEqual(["f1:el-0", "f2:el-0"]);
    const click = (ref: string, hosts: readonly string[]): BrowserAction => ({
      sessionId,
      ref,
      epoch: observed.epoch,
      kind: "click",
      guard: { commitApproved: false, hosts: [...hosts] },
    });
    // Decided on the page's host alone: a cross-origin frame's button is not pressed.
    await expect(adapter.act(click(crossRef, ["example.com"]))).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
      message: expect.stringContaining("pay.example"),
    });
    expect(cross.locator.click).not.toHaveBeenCalled();
    // Past the host check, each goes on to the press check (which this fake page cannot answer, so it fails closed).
    const pastHosts = { code: "NOT_AUTHORIZED", message: expect.stringContaining("could not be checked") };
    await expect(adapter.act(click(sameRef, ["example.com"]))).rejects.toMatchObject(pastHosts);
    await expect(adapter.act(click(crossRef, ["example.com", "pay.example"]))).rejects.toMatchObject(pastHosts);
    // A drag from the page into the cross-origin frame, decided on the page's host alone.
    await expect(
      adapter.act({
        sessionId,
        ref: "el-0",
        epoch: observed.epoch,
        kind: "drag",
        toRef: crossRef,
        guard: { commitApproved: false, hosts: ["example.com"] },
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED", message: expect.stringContaining("pay.example") });
  });

  it("sends a key with no element only when the frame that has focus is on a decided host", async () => {
    const page = fakePage({ url: "https://example.com/" });
    const keyboard = { press: vi.fn(async () => undefined), type: vi.fn(async () => undefined) };
    let focus: "page" | "pay" = "page";
    const main = { url: () => page.url(), $: async () => null, parentFrame: () => null, childFrames: () => [pay] };
    // The frame's element as its parent sees it: focused when focus was tabbed into the frame.
    const element: { readonly ownerDocument: { readonly activeElement: unknown } } = {
      ownerDocument: {
        get activeElement() {
          return focus === "pay" ? element : null;
        },
      },
    };
    const pay = {
      url: () => "https://pay.example/checkout",
      $: async () => null,
      parentFrame: () => main,
      childFrames: () => [],
      frameElement: async () => ({
        evaluate: async (fn: (el: typeof element) => boolean) => fn(element),
        dispose: async () => undefined,
      }),
    };
    Object.assign(page, { frames: () => [main, pay], mainFrame: () => main, keyboard });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: vi.fn(async () => fakeBrowser(fakeContext(page))) });
    const { sessionId } = await adapter.createSession({ workspaceId: "w1" });
    await adapter.navigate(sessionId, "https://example.com/");
    const press = (hosts: readonly string[]): BrowserAction => ({
      sessionId,
      kind: "press",
      value: "a",
      guard: { commitApproved: false, hosts: [...hosts] },
    });
    const intoFrame = { code: "NOT_AUTHORIZED", message: expect.stringMatching(/focus is in a frame on pay\.example.*by its ref/) };
    // Past the focus check, the press goes on to the field check (which this fake page cannot answer, so it fails closed).
    const pastFocus = { code: "NOT_AUTHORIZED", message: expect.stringContaining("could not be checked") };
    await expect(adapter.act(press(["example.com"]))).rejects.toMatchObject(pastFocus);
    // A Tab moved focus into the checkout frame: keys meant for the page's host do not reach it, pressed or typed by sight.
    focus = "pay";
    await expect(adapter.act(press(["example.com"]))).rejects.toMatchObject(intoFrame);
    const decided = { guard: { commitApproved: false, hosts: ["example.com"] } };
    await expect(adapter.pointer!(sessionId, { kind: "type", text: "4111" }, decided)).rejects.toMatchObject(intoFrame);
    await expect(adapter.pointer!(sessionId, { kind: "press", key: "Enter" }, decided)).rejects.toMatchObject(intoFrame);
    expect(keyboard.press).not.toHaveBeenCalled();
    expect(keyboard.type).not.toHaveBeenCalled();
    // Decided on the frame's host too, the key goes on.
    await expect(adapter.act(press(["example.com", "pay.example"]))).rejects.toMatchObject(pastFocus);
  });

  it("launches the browser only once across multiple sessions", async () => {
    const page = fakePage();
    const context = fakeContext(page);
    const browser = fakeBrowser(context);
    const launch = vi.fn(async () => browser);
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch });
    await adapter.createSession({ workspaceId: "w1" });
    await adapter.createSession({ workspaceId: "w1" });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("marks an observation from a page with a password field as sensitive, and one whose check stalls too", async () => {
    const password = fakePage({
      url: "https://bank.example/login",
      field: async (selector) => (selector.includes("password") ? {} : null),
    });
    const marked = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(password)) });
    expect((await marked.observe((await marked.createSession({ workspaceId: "w1" })).sessionId)).sensitive).toBe("password-field");
    // A check that does not finish in time fails closed.
    const stalled = fakePage({ url: "https://slow.example", field: () => "stall" });
    const slow = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(stalled)) });
    expect((await slow.observe((await slow.createSession({ workspaceId: "w1" })).sessionId)).sensitive).toBe("password-field");
    const plain = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => fakeBrowser(fakeContext(fakePage({ url: "https://news.example" }))),
    });
    expect((await plain.observe((await plain.createSession({ workspaceId: "w1" })).sessionId)).sensitive).toBeUndefined();
  });

  it("observe() re-scans and bumps the epoch without navigating", async () => {
    const page = fakePage({ url: "https://example.com" });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const first = await adapter.observe(session.sessionId);
    const second = await adapter.observe(session.sessionId);
    expect(second.epoch).toBe(first.epoch + 1);
  });

  it("act on a stale epoch is rejected, never dispatched to the locator", async () => {
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await adapter.navigate(session.sessionId, "https://example.com"); // bumps epoch again

    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" })).rejects.toThrow(
      /stale/,
    );
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("names an element by the same ref when the page re-orders, and says a stale ref still names it", async () => {
    const first = fakeLocator();
    const second = fakeLocator();
    let order: { locators: Locator[]; elements: Omit<ScannedElement, "index">[] } = {
      locators: [first, second],
      elements: [
        { role: "button", text: "Search", key: "search" },
        { role: "link", text: "Help", key: "help" },
      ],
    };
    const page = fakePage();
    (page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => fakeMatches(order.locators, order.elements));
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const before = await adapter.observe(session.sessionId);
    expect(before.elements.map((element) => [element.ref, element.text])).toEqual([
      ["el-0", "Search"],
      ["el-1", "Help"],
    ]);
    // A banner arrives above them: the scan's places shift, the refs do not.
    const banner = fakeLocator();
    order = {
      locators: [banner, first, second],
      elements: [
        { role: "button", text: "Accept", key: "accept" },
        { role: "button", text: "Search", key: "search" },
        { role: "link", text: "Help", key: "help" },
      ],
    };
    const after = await adapter.observe(session.sessionId);
    expect(after.elements.map((element) => [element.ref, element.text])).toEqual([
      ["el-2", "Accept"],
      ["el-0", "Search"],
      ["el-1", "Help"],
    ]);
    await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: after.epoch, kind: "click" });
    expect(first.click).toHaveBeenCalledTimes(1);
    // The same document observed again keeps the earlier epoch valid: its ref still reaches the element, checked where it is now.
    await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: before.epoch, kind: "click" });
    expect(first.click).toHaveBeenCalledTimes(2);
    // A new document makes both stale; the hint names the epoch that still lists the ref.
    const reloaded = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: after.epoch, kind: "click" })).rejects.toThrow(
      `el-0 is listed in the latest observation (epoch ${reloaded.epoch}): check there that it is still the element you meant, then act again with that epoch.`,
    );
  });

  it("acts on a ref sent without its epoch at the latest observation, only where that observation saw it", async () => {
    const first = fakeLocator();
    const second = fakeLocator();
    let order: { locators: Locator[]; elements: Omit<ScannedElement, "index">[] } = {
      locators: [first, second],
      elements: [
        { role: "button", text: "Search", key: "search", occurrence: 0 },
        { role: "link", text: "Help", key: "help", occurrence: 0 },
      ],
    };
    const page = fakePage();
    (page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => fakeMatches(order.locators, order.elements));
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observed = await adapter.observe(session.sessionId);
    const outcome = await adapter.act({ sessionId: session.sessionId, ref: "el-0", kind: "click" });
    expect(first.click).toHaveBeenCalledTimes(1);
    expect(outcome.note).toBe(`acted with epoch ${observed.epoch}`);
    // A banner shifts it: with its epoch it would be recovered by its label; without, it is refused.
    order = {
      locators: [fakeLocator(), first, second],
      elements: [
        { role: "button", text: "Accept", key: "accept", occurrence: 0 },
        { role: "button", text: "Search", key: "search", occurrence: 0 },
        { role: "link", text: "Help", key: "help", occurrence: 0 },
      ],
    };
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", kind: "click" })).rejects.toThrow(/changed or disappeared/);
    expect(first.click).toHaveBeenCalledTimes(1);
    // A ref the latest observation does not list still needs its epoch.
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-9", kind: "click" })).rejects.toThrow(/stale/);
  });

  it("keeps a bounded number of a document's epochs valid", async () => {
    const page = fakePage({ locators: [fakeLocator()] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const oldest = await adapter.observe(session.sessionId);
    for (let index = 0; index < 16; index += 1) await adapter.observe(session.sessionId);
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: oldest.epoch, kind: "click" })).rejects.toThrow(/stale/);
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: oldest.epoch + 1, kind: "click" })).resolves.toBeDefined();
  });

  it("lists every element when asked for all, past an observation's bounds, and gives no hint for a ref gone from the page", async () => {
    const locators = Array.from({ length: 100 }, () => fakeLocator());
    const elements = locators.map((_, index) => ({ role: "button", text: `Button ${index}`, key: `b${index}` }));
    const page = fakePage();
    let shown = { locators, elements };
    (page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => fakeMatches(shown.locators, shown.elements));
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    expect((await adapter.observe(session.sessionId)).elements.length).toBeLessThan(100);
    const all = await adapter.observe(session.sessionId, { all: true });
    expect(all.elements).toHaveLength(100);
    expect(all.elementsOmitted).toBeUndefined();
    shown = { locators: [], elements: [] };
    await adapter.observe(session.sessionId);
    // The same document observed again keeps `all`'s epoch valid; the element it named is gone, and the refusal says only that.
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-5", epoch: all.epoch, kind: "click" })).rejects.toThrow(
      /^el-5 \(button "Button 5"\) changed or disappeared: observe again$/,
    );
  });

  it("act on an unknown ref is rejected", async () => {
    const page = fakePage({ locators: [] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(
      adapter.act({ sessionId: session.sessionId, ref: "no-such-ref", epoch: observation.epoch, kind: "click" }),
    ).rejects.toThrow(/Unknown element reference/);
  });

  it("close() closes the context and a subsequent act() reports the session unavailable", async () => {
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const context = fakeContext(page);
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(context) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await adapter.close(session.sessionId);
    expect(context.close).toHaveBeenCalledTimes(1);
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" })).rejects.toThrow(
      /closed/,
    );
  });

  it("close() on an unknown session throws NOT_FOUND; navigate/act/observe on an unknown session too", async () => {
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(fakePage())) });
    await expect(adapter.close("no-such-session")).rejects.toThrow(/No browser session/);
    await expect(adapter.navigate("no-such-session", "https://example.com")).rejects.toThrow(/No browser session/);
    await expect(adapter.observe("no-such-session")).rejects.toThrow(/No browser session/);
    await expect(adapter.act({ ...command, sessionId: "no-such-session" })).rejects.toThrow(/No browser session/);
  });

  it("cancel is a safe no-op on an open session, and errors on an unknown one", async () => {
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(fakePage())) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    await expect(adapter.cancel(session.sessionId)).resolves.toBeUndefined();
    await expect(adapter.cancel("no-such-session")).rejects.toThrow(/No browser session/);
  });

  it("cancel rejects an in-flight action with CANCELLED and leaves the session open", async () => {
    const locator = fakeLocator({
      click: vi.fn(() => new Promise<void>(() => {})),
    });
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    const pending = adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" });
    await adapter.cancel(session.sessionId);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    // Session remains open for subsequent observations.
    const after = await adapter.observe(session.sessionId);
    expect(after.epoch).toBe(observation.epoch + 1);
  });

  it("waits for an action a cancel abandoned before it runs the next one, so the two never interleave", async () => {
    let release = (): void => undefined;
    const clicked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fill = vi.fn(async () => {});
    const locator = fakeLocator({ click: vi.fn(() => clicked), fill });
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    const pending = adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" });
    await adapter.cancel(session.sessionId);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", message: expect.stringMatching(/may still land/) });
    const typed = adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "type", value: "x" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fill).not.toHaveBeenCalled();
    release();
    await typed;
    expect(fill).toHaveBeenCalled();
  });

  it("maps Playwright action errors to one-line reasons without Call log", async () => {
    let failure =
      'locator.click: Timeout 8000ms exceeded.\nCall log:\n  - <div role="dialog" aria-label="Sign in"> intercepts pointer events';
    const locator = fakeLocator({
      click: vi.fn(async () => {
        throw new Error(failure);
      }),
    });
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");

    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" })).rejects.toMatchObject(
      {
        message: 'covered by <dialog "Sign in">',
      },
    );

    failure = "locator.click: element is not visible\nCall log:\n  - waiting for element";
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" })).rejects.toMatchObject(
      {
        message: "not visible",
      },
    );

    failure = "locator.click: element is not enabled\nCall log:\n  - waiting for element";
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" })).rejects.toMatchObject(
      {
        message: "disabled",
      },
    );

    failure = "locator.click: Element is not attached to the DOM\nCall log:\n  - waiting";
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" })).rejects.toMatchObject(
      {
        message: "detached: observe again",
      },
    );

    failure = "locator.click: Timeout 8000ms exceeded.\nCall log:\n  - waiting";
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" })).rejects.toMatchObject(
      {
        message: "timed out after 8 s",
      },
    );
  });

  it("verifies ref identity at act time: recovers moved elements and rejects gone or ambiguous ones", async () => {
    const alpha = fakeLocator();
    const beta = fakeLocator();
    const inserted = fakeLocator();
    const duplicateBeta = fakeLocator();
    let order: { locators: Locator[]; elements: Omit<ScannedElement, "index">[] } = {
      locators: [alpha, beta],
      elements: [
        { role: "button", text: "Alpha", key: "alpha", occurrence: 0 },
        { role: "button", text: "Beta", key: "beta", occurrence: 0 },
      ],
    };
    const page = fakePage();
    (page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => fakeMatches(order.locators, order.elements));
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observed = await adapter.observe(session.sessionId);

    // 1. Moved element: a node is prepended above Beta, shifting Beta from index 1 to index 2.
    order = {
      locators: [inserted, alpha, beta],
      elements: [
        { role: "button", text: "Inserted", key: "inserted", occurrence: 0 },
        { role: "button", text: "Alpha", key: "alpha", occurrence: 0 },
        { role: "button", text: "Beta", key: "beta", occurrence: 0 },
      ],
    };
    const movedOutcome = await adapter.act({ sessionId: session.sessionId, ref: "el-1", epoch: observed.epoch, kind: "click" });
    expect(beta.click).toHaveBeenCalledTimes(1);
    expect(alpha.click).not.toHaveBeenCalled();
    expect(movedOutcome.changes).toEqual(["el-1 moved; acted on it by its label"]);

    // 2. Gone element: Beta disappears from the page.
    order = {
      locators: [inserted, alpha],
      elements: [
        { role: "button", text: "Inserted", key: "inserted", occurrence: 0 },
        { role: "button", text: "Alpha", key: "alpha", occurrence: 0 },
      ],
    };
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-1", epoch: observed.epoch, kind: "click" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: 'el-1 (button "Beta") changed or disappeared: observe again',
    });

    // 3. Ambiguous element: Beta moved and two visible elements now share its key.
    order = {
      locators: [inserted, alpha, beta, duplicateBeta],
      elements: [
        { role: "button", text: "Inserted", key: "inserted", occurrence: 0 },
        { role: "button", text: "Alpha", key: "alpha", occurrence: 0 },
        { role: "button", text: "Beta", key: "beta", occurrence: 0 },
        { role: "button", text: "Beta", key: "beta", occurrence: 1 },
      ],
    };
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-1", epoch: observed.epoch, kind: "click" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: 'el-1 (button "Beta") changed or disappeared: observe again',
    });
  });

  it("refuses a ref whose place holds its alike neighbour after a shift, never acting on the other one", async () => {
    const first = fakeLocator();
    const second = fakeLocator();
    const inserted = fakeLocator();
    let order: { locators: Locator[]; elements: Omit<ScannedElement, "index">[] } = {
      locators: [first, second],
      elements: [
        { role: "button", text: "Delete", key: "delete", occurrence: 0 },
        { role: "button", text: "Delete", key: "delete", occurrence: 1 },
      ],
    };
    const page = fakePage();
    (page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => fakeMatches(order.locators, order.elements));
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observed = await adapter.observe(session.sessionId, { all: true });
    const secondRef = observed.elements[1]?.ref ?? "";
    // A row is inserted above: the second Delete's old place now holds the first.
    order = {
      locators: [inserted, first, second],
      elements: [
        { role: "button", text: "Inserted", key: "inserted", occurrence: 0 },
        { role: "button", text: "Delete", key: "delete", occurrence: 0 },
        { role: "button", text: "Delete", key: "delete", occurrence: 1 },
      ],
    };
    await expect(adapter.act({ sessionId: session.sessionId, ref: secondRef, epoch: observed.epoch, kind: "click" })).rejects.toMatchObject(
      {
        code: "INVALID_INPUT",
        message: expect.stringMatching(/changed or disappeared: observe again/),
      },
    );
    expect(first.click).not.toHaveBeenCalled();
    expect(second.click).not.toHaveBeenCalled();
  });

  it("signs a page's own documents with the operator's key, and leaves its other requests alone", async () => {
    const page = fakePage();
    const context = fakeContext(page);
    let handler: ((route: unknown, request: unknown) => Promise<void>) | undefined;
    Object.assign(context, {
      route: vi.fn(async (_pattern: string, next: typeof handler) => {
        handler = next;
      }),
    });
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => fakeBrowser(context),
      identity: { signature: { keyId: "k1", privateKey: "11".repeat(32) } },
    });
    await adapter.createSession({ workspaceId: "w1" });
    const request = (type: string) => ({ url: () => "https://shop.example/x", resourceType: () => type, headers: () => ({ a: "1" }) });
    const sent: unknown[] = [];
    const route = { continue: vi.fn(async (options?: unknown) => void sent.push(options)) };
    await handler?.(route, request("image"));
    await handler?.(route, request("document"));
    expect(sent[0]).toBeUndefined();
    expect(sent[1]).toMatchObject({ headers: { a: "1", "Signature-Input": expect.stringContaining('keyid="k1"') } });
  });

  it("does not act on a ref whose identity could not be checked", async () => {
    const hover = vi.fn(async () => {});
    const scrollIntoViewIfNeeded = vi.fn(async () => {});
    const evaluate = vi.fn(async () => {});
    const target = fakeLocator({ hover, scrollIntoViewIfNeeded, evaluate } as Partial<Locator>);
    const page = fakePage();
    (page.locator as ReturnType<typeof vi.fn>).mockImplementation(() =>
      fakeMatches([target], [{ role: "button", text: "Beta", key: "beta", occurrence: 0 }]),
    );
    const context = fakeContext(page);
    // The isolated-world read fails: the page's session cannot answer.
    const unreadable = { send: vi.fn(async () => Promise.reject(new Error("target closed"))), detach: vi.fn(async () => undefined) };
    Object.assign(context, { newCDPSession: vi.fn(async () => unreadable) });
    Object.assign(page, { context: () => context });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(context) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observed = await adapter.observe(session.sessionId);
    for (const action of [{ kind: "hover" as const }, { kind: "scroll" as const, value: "down" }]) {
      await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observed.epoch, ...action })).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringMatching(/could not be checked before acting/),
      });
    }
    expect(hover).not.toHaveBeenCalled();
    expect(scrollIntoViewIfNeeded).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("preserves hidden file inputs for upload while treating hidden non-file inputs as missing", () => {
    const makeInput = (type: string, width: number, height: number) => ({
      tagName: "INPUT",
      type,
      value: "",
      innerText: "",
      labels: [{ innerText: "Resume" }],
      matches: () => true,
      getAttribute: (name: string) => (name === "id" ? "resume" : null),
      getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }),
      checkVisibility: () => width > 0 && height > 0,
    });
    const runVerify = (node: ReturnType<typeof makeInput>, key: string) => {
      const fn = new Function("document", "target", `return (${VERIFY_TARGET_IN_PAGE})(target);`) as (
        doc: { querySelectorAll: () => (typeof node)[] },
        target: { index: number; key: string; occurrence: number; textChars: number },
      ) => { status: string; index: number };
      return fn({ querySelectorAll: () => [node] }, { index: 0, key, occurrence: 0, textChars: 240 });
    };

    expect(runVerify(makeInput("file", 0, 0), "INPUT\u0001\u0001resume\u0001\u0001file\u0001Resume\u0001")).toEqual({
      status: "ok",
      index: 0,
    });
    expect(runVerify(makeInput("hidden", 100, 20), "INPUT\u0001\u0001resume\u0001\u0001hidden\u0001Resume\u0001")).toEqual({
      status: "missing",
      index: 0,
    });
    expect(runVerify(makeInput("text", 0, 0), "INPUT\u0001\u0001resume\u0001\u0001text\u0001Resume\u0001")).toEqual({
      status: "missing",
      index: 0,
    });
  });

  it("bumps the epoch and clears refs on a main-frame framenavigated (pushState / replaceState), ignoring subframes", async () => {
    const locator = fakeLocator();
    const mainFrame = {};
    const subFrame = {};
    const page = Object.assign(fakePage({ locators: [locator], elements: [{ role: "button", text: "Go" }] }), {
      mainFrame: () => mainFrame,
    });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const { sessionId } = await adapter.createSession({ workspaceId: "w1" });
    const observed = await adapter.navigate(sessionId, "https://example.com/app");
    const navigated = (page.on as ReturnType<typeof vi.fn>).mock.calls.find(([event]) => event === "framenavigated")?.[1] as
      | ((frame: unknown) => void)
      | undefined;
    expect(navigated).toBeDefined();

    // A subframe navigation does not invalidate main-frame refs.
    navigated?.(subFrame);
    await expect(adapter.act({ sessionId, ref: "el-0", epoch: observed.epoch, kind: "click" })).resolves.toMatchObject({
      status: "accepted",
    });

    // Main-frame pushState / replaceState invalidates the epoch and clears refs.
    navigated?.(mainFrame);
    await expect(adapter.act({ sessionId, ref: "el-0", epoch: observed.epoch, kind: "click" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("stale"),
    });
  });
});

describe("createPlaywrightBrowser — act dispatch", () => {
  it("click dispatches to locator.click", async () => {
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    const outcome = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" });
    expect(outcome).toEqual({ status: "accepted" });
    expect(locator.click).toHaveBeenCalledTimes(1);
  });

  it("follows a click that opens a new tab: the tab becomes the session's active page while the opener stays open", async () => {
    const link = fakeLocator();
    const results = fakePage({ locators: [link], url: "https://www.bing.com/news/search?q=Meta+Muse" });
    const article = fakePage({
      locators: [fakeLocator()],
      elements: [{ role: "heading", text: "A Permission Bug in Meta's Muse AI" }],
      url: "https://www.androidheadlines.com/muse-permission-bug",
    });
    let clicked = false;
    (link.click as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      clicked = true;
    });
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => fakeBrowser(fakeContext(results, () => (clicked ? article : undefined))),
    });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://www.bing.com/news/search?q=Meta+Muse");
    const outcome = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" });
    expect(outcome).toEqual({
      status: "accepted",
      detail: "opened https://www.androidheadlines.com/muse-permission-bug in a new tab, which this session now shows",
      page: {
        sessionId: session.sessionId,
        // Adopting the tab retires the opener's epoch (2), so its refs cannot act on the article.
        epoch: 3,
        url: "https://www.androidheadlines.com/muse-permission-bug",
        elements: [{ ref: "el-0", role: "heading", text: "A Permission Bug in Meta's Muse AI" }],
        tabs: [
          { index: 0, url: "https://www.bing.com/news/search?q=Meta+Muse" },
          { index: 1, url: "https://www.androidheadlines.com/muse-permission-bug", active: true },
        ],
      },
    });
    expect(article.waitForLoadState).toHaveBeenCalledWith("domcontentloaded");
    expect(results.close).not.toHaveBeenCalled();
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" })).rejects.toThrow(
      /stale/,
    );
    // The next observe reads the article, not the results page.
    const next = await adapter.observe(session.sessionId);
    expect(next.url).toBe("https://www.androidheadlines.com/muse-permission-bug");
    expect(next.elements).toEqual([{ ref: "el-0", role: "heading", text: "A Permission Bug in Meta's Muse AI" }]);
    // Closing the session closes all of its pages.
    await adapter.close(session.sessionId);
    expect(results.close).toHaveBeenCalledTimes(1);
    expect(article.close).toHaveBeenCalledTimes(1);
  });

  it("opens a link in a new tab beside the list, switches back to it, and closes a tab but never the last", async () => {
    const list = fakePage({
      locators: [fakeLocator()],
      elements: [{ role: "link", text: "First result", href: "https://news.example/a" }],
      url: "https://search.example/results",
    });
    const article = fakePage({ locators: [fakeLocator()], elements: [{ role: "heading", text: "Story A" }] });
    const context = fakeContext(list);
    (context.newPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(list).mockResolvedValueOnce(article);
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(context) });
    const { sessionId } = await adapter.createSession({ workspaceId: "w1" });
    const results = await adapter.navigate(sessionId, "https://search.example/results");

    const opened = await adapter.act({ sessionId, kind: "open_in_tab", value: "https://news.example/a" });
    expect(article.goto).toHaveBeenCalledWith("https://news.example/a", { waitUntil: "domcontentloaded" });
    expect(list.close).not.toHaveBeenCalled();
    expect(opened.status).toBe("accepted");
    expect(opened.detail).toBe(
      "opened https://news.example/a in tab 1; tab 0 (https://search.example/results) stays open, switch back with tab",
    );
    expect(opened.page).toMatchObject({
      url: "https://news.example/a",
      elements: [{ ref: "el-0", role: "heading", text: "Story A" }],
      tabs: [
        { index: 0, url: "https://search.example/results" },
        { index: 1, url: "https://news.example/a", active: true },
      ],
    });
    // The list's refs were the other tab's: acting on one in the article's tab is stale, never a click on the article.
    await expect(adapter.act({ sessionId, ref: "el-0", epoch: results.epoch, kind: "click" })).rejects.toThrow(/stale/);

    const back = await adapter.act({ sessionId, kind: "tab", tab: 0 });
    expect(back.page?.url).toBe("https://search.example/results");
    expect(back.page?.elements).toEqual([{ ref: "el-0", role: "link", text: "First result", href: "https://news.example/a" }]);

    // Closing the article's tab from the list keeps the list shown, and its refs good.
    const closed = await adapter.act({ sessionId, kind: "close_tab", tab: 1 });
    expect(closed).toMatchObject({
      status: "accepted",
      detail: "closed tab 1 (https://news.example/a); the session shows tab 0 (https://search.example/results)",
    });
    expect(article.close).toHaveBeenCalledTimes(1);
    expect(closed.page?.tabs).toBeUndefined();
    await expect(adapter.act({ sessionId, ref: "el-0", epoch: closed.page?.epoch ?? -1, kind: "click" })).resolves.toMatchObject({
      status: "accepted",
    });

    // The last tab is the session: refused, and said so.
    const last = await adapter.act({ sessionId, kind: "close_tab" });
    expect(last).toMatchObject({ status: "rejected", detail: expect.stringMatching(/\bbrowser\.close(?![\w.])/) });
    expect(list.close).not.toHaveBeenCalled();
    await expect(adapter.act({ sessionId, kind: "open_in_tab", value: "file:///etc/passwd" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("closes the active tab onto the page that opened it, its refs stale", async () => {
    const list = fakePage({ locators: [fakeLocator()], elements: [{ role: "link", text: "A" }], url: "https://search.example/results" });
    const article = fakePage({ locators: [fakeLocator()], elements: [{ role: "button", text: "Share" }] });
    const context = fakeContext(list);
    (context.newPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(list).mockResolvedValueOnce(article);
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(context) });
    const { sessionId } = await adapter.createSession({ workspaceId: "w1" });
    await adapter.navigate(sessionId, "https://search.example/results");
    const opened = await adapter.act({ sessionId, kind: "open_in_tab", value: "https://news.example/a" });
    const closed = await adapter.act({ sessionId, kind: "close_tab" });
    expect(closed).toMatchObject({
      status: "accepted",
      detail: "closed tab 1 (https://news.example/a); the session shows tab 0 (https://search.example/results)",
      page: { url: "https://search.example/results", elements: [{ ref: "el-0", role: "link", text: "A" }] },
    });
    expect(article.close).toHaveBeenCalledTimes(1);
    await expect(adapter.act({ sessionId, ref: "el-0", epoch: opened.page?.epoch ?? -1, kind: "click" })).rejects.toThrow(/stale/);
  });

  it("closes a tab that would not open, and goes back to the page it was opened from", async () => {
    const list = fakePage({ locators: [fakeLocator()], elements: [{ role: "link", text: "A" }], url: "https://search.example/results" });
    const broken = fakePage();
    (broken.goto as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("net::ERR_NAME_NOT_RESOLVED at https://gone.example/"));
    const context = fakeContext(list);
    (context.newPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(list).mockResolvedValueOnce(broken);
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(context) });
    const { sessionId } = await adapter.createSession({ workspaceId: "w1" });
    await adapter.navigate(sessionId, "https://search.example/results");
    await expect(adapter.act({ sessionId, kind: "open_in_tab", value: "https://gone.example/" })).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
    expect(broken.close).toHaveBeenCalledTimes(1);
    const now = await adapter.observe(sessionId);
    expect(now.url).toBe("https://search.example/results");
    expect(now.tabs).toBeUndefined();
  });

  it("caps session pages at 5, evicting the oldest inactive tab when a 6th popup opens", async () => {
    const pages = Array.from({ length: 6 }, (_, i) =>
      fakePage({
        locators: [fakeLocator()],
        elements: [{ role: "link", text: `Open ${i + 1}`, key: `open-${i + 1}`, occurrence: 0 }],
        url: `https://example.com/tab-${i}`,
      }),
    );
    let nextPopupIdx = 1;
    const context = fakeContext(pages[0] as Page, () => pages[nextPopupIdx++]);
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => fakeBrowser(context),
    });
    const session = await adapter.createSession({ workspaceId: "w1" });
    let obs = await adapter.navigate(session.sessionId, "https://example.com/tab-0");
    for (let i = 1; i <= 5; i++) {
      const ref = obs.elements[0]?.ref ?? "el-0";
      const outcome = await adapter.act({ sessionId: session.sessionId, ref, epoch: obs.epoch, kind: "click" });
      expect(outcome.page).toBeDefined();
      obs = outcome.page ?? obs;
    }
    expect(obs.tabs).toHaveLength(5);
    expect(obs.tabs?.map((t) => t.url)).toEqual([
      "https://example.com/tab-1",
      "https://example.com/tab-2",
      "https://example.com/tab-3",
      "https://example.com/tab-4",
      "https://example.com/tab-5",
    ]);
    expect(pages[0]?.close).toHaveBeenCalledTimes(1);
    expect(pages[1]?.close).not.toHaveBeenCalled();
  });

  it("never evicts the opener of popups still open, when one page opens a popup after another", async () => {
    const pages = Array.from({ length: 6 }, (_, i) =>
      fakePage({
        locators: [fakeLocator()],
        elements: [{ role: "link", text: `Open ${i}`, key: `open-${i}`, occurrence: 0 }],
        url: `https://example.com/page-${i}`,
      }),
    );
    let nextPopupIdx = 1;
    const context = fakeContext(pages[0] as Page, () => pages[nextPopupIdx++]);
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(context) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    let obs = await adapter.navigate(session.sessionId, "https://example.com/page-0");
    for (let i = 1; i <= 5; i++) {
      // Back on the opener each time, as a checkout returns to its page between payment windows.
      if (i > 1) obs = (await adapter.act({ sessionId: session.sessionId, kind: "tab", tab: 0 })).page ?? obs;
      const outcome = await adapter.act({
        sessionId: session.sessionId,
        ref: obs.elements[0]?.ref ?? "el-0",
        epoch: obs.epoch,
        kind: "click",
      });
      obs = outcome.page ?? obs;
    }
    expect(pages[0]?.close).not.toHaveBeenCalled();
    expect(pages[1]?.close).toHaveBeenCalledTimes(1);
  });

  it("says where a click that navigates in place went", async () => {
    let url = "https://www.bing.com/news/search?q=Meta+Muse";
    const link = fakeLocator({
      click: vi.fn(async () => {
        url = "https://mashable.com/muse";
      }),
    });
    const page = fakePage({ locators: [link] });
    (page.url as ReturnType<typeof vi.fn>).mockImplementation(() => url);
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.observe(session.sessionId);
    const outcome = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" });
    expect(outcome).toEqual({
      status: "accepted",
      detail: "the page is now https://mashable.com/muse",
      page: {
        sessionId: session.sessionId,
        epoch: 2,
        url: "https://mashable.com/muse",
        elements: [{ ref: "el-0", role: "button" }],
      },
    });
    expect(page.waitForLoadState).toHaveBeenCalledWith("domcontentloaded");
    expect(page.close).not.toHaveBeenCalled();
  });

  it("offers only the elements the scan kept, each ref resolving to its own match", async () => {
    const links = [fakeLocator(), fakeLocator(), fakeLocator()];
    const page = fakePage({
      locators: links,
      elements: [
        { text: "Did Muse read private texts?", href: "https://mashable.com/muse" },
        { href: "https://mashable.com/muse" },
        { text: "Next", href: "https://mashable.com/page/2", chrome: true },
      ],
    });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.observe(session.sessionId);
    // The image link to the same story is not offered, and `chrome` is not part of a summary.
    expect(observation.elements).toEqual([
      { ref: "el-0", text: "Did Muse read private texts?", href: "https://mashable.com/muse" },
      { ref: "el-2", text: "Next", href: "https://mashable.com/page/2" },
    ]);
    expect(observation.elementsOmitted).toBeUndefined();
    await adapter.act({ sessionId: session.sessionId, ref: "el-2", epoch: observation.epoch, kind: "click" });
    expect(links[2]?.click).toHaveBeenCalledTimes(1);
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-1", epoch: observation.epoch, kind: "click" })).rejects.toThrow(
      /Unknown element reference el-1/,
    );
  });

  it("says how many elements past the observation's bounds it left out", async () => {
    const locators = Array.from({ length: BROWSER_OBSERVATION_MAX_ELEMENTS + 5 }, () => fakeLocator());
    const page = fakePage({ locators, elements: locators.map((_, index) => ({ role: "button", text: `btn-${index}` })) });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.observe(session.sessionId);
    expect(observation.elements).toHaveLength(BROWSER_OBSERVATION_MAX_ELEMENTS);
    expect(observation.elementsOmitted).toBe(5);
  });

  it("type dispatches to locator.fill with the action's value", async () => {
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "type", value: "hello" });
    expect(locator.fill).toHaveBeenCalledWith("hello");
  });

  it("submit dispatches to locator.press('Enter')", async () => {
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "submit" });
    expect(locator.press).toHaveBeenCalledWith("Enter");
  });

  it("upload without an artifactId is rejected with INVALID_INPUT before touching the locator", async () => {
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => fakeBrowser(fakeContext(page)),
      artifacts: fixtureArtifacts(),
    });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "upload" })).rejects.toThrow(
      /artifactId/,
    );
    expect(locator.setInputFiles).not.toHaveBeenCalled();
  });

  it("upload without a configured artifact store throws NOT_CONFIGURED", async () => {
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(
      adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "upload", artifactId: "art-1" }),
    ).rejects.toThrow(/artifact store/);
  });

  it.each(["pending", "rejected"] as const)("refuses a %s artifact and never reads its bytes", async (reviewState) => {
    // `navigate` takes a model-authored URL with no host
    // allowlist, so an upload is an egress point to an attacker-chosen page. A
    // `pending` artifact is exactly the content the review gate exists to
    // withhold; a `rejected` one is the strongest signal an operator can give.
    const artifacts = fixtureArtifacts();
    const artifact = await artifacts.putArtifact({
      workspaceId: "w1",
      contentType: "text/plain",
      body: "unreviewed secret",
      extension: "txt",
      reviewState,
    });
    const readSpy = vi.spyOn(artifacts, "readArtifactBody");
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(
      adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "upload", artifactId: artifact.artifactId }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED", message: expect.stringContaining("not approved") });
    // "Refused" must mean before any byte is read, not merely before the page
    // sees it: the temp write is what a later refactor could move earlier.
    expect(readSpy).not.toHaveBeenCalled();
    expect(locator.setInputFiles).not.toHaveBeenCalled();
  });

  it("refuses another workspace's artifact even when it is approved", async () => {
    const artifacts = fixtureArtifacts();
    const artifact = await artifacts.putArtifact({
      workspaceId: "ws-victim",
      contentType: "text/plain",
      body: "victim secret",
      extension: "txt",
      reviewState: "approved",
    });
    const readSpy = vi.spyOn(artifacts, "readArtifactBody");
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    // The session belongs to a different workspace than the artifact.
    const session = await adapter.createSession({ workspaceId: "ws-attacker" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(
      adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "upload", artifactId: artifact.artifactId }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED", message: expect.stringContaining("another workspace") });
    expect(readSpy).not.toHaveBeenCalled();
    expect(locator.setInputFiles).not.toHaveBeenCalled();
  });

  it("reports an authorization refusal as a failure, never as an uncertain write", async () => {
    // `dispatchBrowserAction` softens a mid-write Playwright failure into
    // `"uncertain"` because the write may have half-happened. A refusal has not
    // happened at all, so it must stay a plain rejection — the one line between
    // "refused" and "maybe it uploaded".
    const { dispatchBrowserAction } = await import("@tavi/contracts");
    const artifacts = fixtureArtifacts();
    const artifact = await artifacts.putArtifact({
      workspaceId: "w1",
      contentType: "text/plain",
      body: "unreviewed secret",
      extension: "txt",
      reviewState: "pending",
    });
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(
      dispatchBrowserAction(adapter, {
        sessionId: session.sessionId,
        ref: "el-0",
        epoch: observation.epoch,
        kind: "upload",
        artifactId: artifact.artifactId,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(locator.setInputFiles).not.toHaveBeenCalled();
  });

  it("refuses an artifact larger than the upload bound before reading it", async () => {
    const artifacts = fixtureArtifacts();
    const artifact = await artifacts.putArtifact({
      workspaceId: "w1",
      contentType: "application/octet-stream",
      body: "small",
      extension: "bin",
      reviewState: "approved",
    });
    // The record is what is bounded, so a store that reports an enormous size is
    // refused without the body ever being materialized.
    artifacts.patchRecord(artifact.artifactId, { byteSize: 65 * 1024 * 1024 });
    const readSpy = vi.spyOn(artifacts, "readArtifactBody");
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(
      adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "upload", artifactId: artifact.artifactId }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("too large") });
    expect(readSpy).not.toHaveBeenCalled();
    expect(locator.setInputFiles).not.toHaveBeenCalled();
  });

  it("upload hands the artifact's bytes to setInputFiles in memory, so the file outlives the call until the form is sent", async () => {
    const artifacts = fixtureArtifacts();
    // `approved` is stated rather than defaulted, so this doubles as the
    // success-path assertion that an authorized upload still goes through.
    const artifact = await artifacts.putArtifact({
      workspaceId: "w1",
      contentType: "text/plain",
      body: "upload me",
      extension: "txt",
      reviewState: "approved",
    });
    let captured: unknown;
    const locator = fakeLocator({
      setInputFiles: vi.fn(async (files: unknown) => {
        captured = files;
      }),
    });
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    const outcome = await adapter.act({
      sessionId: session.sessionId,
      ref: "el-0",
      epoch: observation.epoch,
      kind: "upload",
      artifactId: artifact.artifactId,
    });
    expect(outcome).toEqual({ status: "accepted" });
    // Not a path: Chromium reads a path only when the form is sent, by when a temp file was gone (ERR_FILE_NOT_FOUND).
    expect(captured).toMatchObject({ name: "art-1" });
    expect(Buffer.from((captured as { buffer: Buffer }).buffer).toString("utf8")).toBe("upload me");
  });

  it("stages an upload past Playwright's in-memory bound privately until the session closes, and drops it when the page refuses it", async () => {
    const staging = temp.create("tavi-browser-upload-staging-");
    const artifacts = fixtureArtifacts();
    const big = await artifacts.putArtifact({
      workspaceId: "w1",
      contentType: "application/octet-stream",
      body: new Uint8Array(50 * 1024 * 1024),
      extension: "bin",
      reviewState: "approved",
    });
    const paths: string[] = [];
    let refuse = false;
    const locator = fakeLocator({
      setInputFiles: vi.fn(async (files: unknown) => {
        paths.push(files as string);
        if (refuse) throw new Error("not a file input");
      }),
    });
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: staging, launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    const upload = {
      sessionId: session.sessionId,
      ref: "el-0",
      epoch: observation.epoch,
      kind: "upload",
      artifactId: big.artifactId,
    } as const;
    expect(await adapter.act(upload)).toEqual({ status: "accepted" });
    const kept = paths[0] ?? "";
    expect(kept.startsWith(join(staging, "tavi-browser-upload-"))).toBe(true);
    // Kept for the form that reads it later, in a directory only the owner reads.
    expect((await stat(kept)).size).toBe(50 * 1024 * 1024);
    expect((await stat(dirname(kept))).mode & 0o077).toBe(0);
    refuse = true;
    await expect(adapter.act(upload)).rejects.toThrow();
    const refused = paths[1] ?? "";
    expect(refused).not.toBe("");
    await expect(stat(dirname(refused))).rejects.toMatchObject({ code: "ENOENT" });
    await adapter.close(session.sessionId);
    await expect(stat(dirname(kept))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a confined browser refuses an upload past the in-memory bound before reading it", async () => {
    const artifacts = fixtureArtifacts();
    const artifact = await artifacts.putArtifact({
      workspaceId: "w1",
      contentType: "application/octet-stream",
      body: "small",
      extension: "bin",
      reviewState: "approved",
    });
    artifacts.patchRecord(artifact.artifactId, { byteSize: 50 * 1024 * 1024 });
    const readSpy = vi.spyOn(artifacts, "readArtifactBody");
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      confinement: {
        confinement: { wrap: () => ({ command: "/bin/false", args: [], env: {} }) },
        denyRead: [],
        scratchDirectory: tmpdir(),
      },
      launch: async () => fakeBrowser(fakeContext(page)),
      artifacts,
    });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(
      adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "upload", artifactId: artifact.artifactId }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("confined browser") });
    expect(readSpy).not.toHaveBeenCalled();
    expect(locator.setInputFiles).not.toHaveBeenCalled();
  });

  it("download without a configured artifact store throws NOT_CONFIGURED before clicking", async () => {
    const locator = fakeLocator();
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "download" })).rejects.toThrow(
      /artifact store/,
    );
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("download saves the downloaded file as an artifact and reports its id in artifactId and detail", async () => {
    const artifacts = fixtureArtifacts();
    const { writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = temp.create("tavi-browser-download-test-");
    const downloadedPath = join(directory, "report.csv");
    await writeFile(downloadedPath, "a,b,c\n1,2,3\n");

    const locator = fakeLocator();
    const download = { path: vi.fn(async () => downloadedPath), suggestedFilename: vi.fn(() => "report.csv") } as unknown as Download;
    const page = fakePage({ locators: [locator], waitForDownload: async () => download });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    const outcome = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "download" });
    expect(outcome.status).toBe("accepted");
    expect(outcome.detail).toMatch(/saved as artifact/);
    expect(locator.click).toHaveBeenCalledTimes(1);
    // Genuinely untrusted external content, same
    // reasoning as `capture()` — never approved by default.
    const artifactId = outcome.detail?.match(/saved as artifact (\S+)/)?.[1] ?? "";
    // Named as a field too: the turn's review gate finds a pending artifact by `artifactId`.
    expect(outcome.artifactId).toBe(artifactId);
    expect((await artifacts.getArtifact(artifactId))?.reviewState).toBe("pending");
    // Labelled as a download from the page's host, personal.
    expect((await artifacts.getArtifact(artifactId))?.label).toMatchObject({
      integrity: "untrusted",
      sources: ["download"],
      principals: ["host:example.com"],
      confidentiality: "personal",
    });
  });

  it("plain click that triggers a download keeps nothing and says to fetch it as a download", async () => {
    const artifacts = fixtureArtifacts();
    const cancel = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const download = { cancel, delete: remove } as unknown as Download;
    const page = fakePage({ locators: [fakeLocator()], waitForDownload: async () => download });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    const outcome = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "click" });
    expect(outcome).toMatchObject({ status: "rejected", detail: expect.stringMatching(/kind: "download"/) });
    expect(cancel).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    expect(await artifacts.listPendingReview("w1", 10)).toEqual([]);
  });

  it("reads PDF text when navigating to an application/pdf response", async () => {
    const page = fakePage();
    const pdfBytes = Buffer.from("%PDF-1.4\n(Statement Total: $99.00) Tj\n%%EOF\n", "latin1");
    (page.goto as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (target: string) => {
      (page.url as unknown as ReturnType<typeof vi.fn>).mockReturnValue(target);
      return {
        status: () => 200,
        headers: () => ({ "content-type": "application/pdf" }),
        body: async () => pdfBytes,
      };
    });
    const pdfEngine = {
      run: vi.fn(async () => ({
        ok: true as const,
        answer: {
          ok: true as const,
          facts: {
            sha256: "0".repeat(64),
            pageCount: 1,
            encryption: "none" as const,
            fillPermitted: false,
            modifyPermitted: false,
            form: "none" as const,
            fieldCount: 0,
            signatures: 0,
            activeContent: [],
            comments: 0,
            imageOnlyPages: [],
          },
          pages: [{ page: 1, text: "Statement Total: $99.00 (from pdf engine)", hidden: [] }],
          maxRssKb: 1024,
        },
        pngs: [],
        document: new Uint8Array(0),
        peakKb: 1024,
        wallMs: 10,
      })),
    };
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => fakeBrowser(fakeContext(page)),
      pdf: pdfEngine,
    });
    const session = await adapter.createSession({ workspaceId: "w1" });
    await adapter.navigate(session.sessionId, "https://example.com/statement.pdf");
    const pageRead = await adapter.read(session.sessionId);
    expect(pageRead.text).toBe("Statement Total: $99.00 (from pdf engine)");
    expect(pdfEngine.run).toHaveBeenCalledTimes(1);
  });

  it("reads no text from a PDF the wired engine cannot read, never the raw stream's", async () => {
    const failed = { ok: false as const, failure: "crashed" as const };
    const engines = [
      { run: vi.fn(async () => failed) },
      {
        run: vi.fn(async () => {
          throw new Error("engine gone");
        }),
      },
      {
        run: vi.fn(async () => failed),
        readWithOcr: vi.fn(async () => ({
          read: failed,
          pages: [],
          ocr: { read: [], checked: [], unconfirmed: [], unchecked: [], skipped: [], images: [] },
        })),
      },
    ];
    for (const pdfEngine of engines) {
      const page = fakePage();
      const pdfBytes = Buffer.from("%PDF-1.4\n(Hidden stream text) Tj\n%%EOF\n", "latin1");
      (page.goto as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (target: string) => {
        (page.url as unknown as ReturnType<typeof vi.fn>).mockReturnValue(target);
        return {
          status: () => 200,
          headers: () => ({ "content-type": "application/pdf" }),
          body: async () => pdfBytes,
        };
      });
      const adapter = createPlaywrightBrowser({
        stagingDirectory: tmpdir(),
        launch: async () => fakeBrowser(fakeContext(page)),
        pdf: pdfEngine,
      });
      const session = await adapter.createSession({ workspaceId: "w1" });
      await adapter.navigate(session.sessionId, "https://example.com/statement.pdf");
      const pageRead = await adapter.read(session.sessionId);
      expect(pageRead.text).not.toContain("Hidden stream text");
    }
  });

  it("download is refused with the store's reason when the store refuses it under the free-space floor, and nothing is kept", async () => {
    const artifacts = fixtureArtifacts();
    const floor = new TaviError(
      "QUOTA_EXCEEDED",
      "Only 10 MB is free on the disk that holds the tavi data directory, under its 1.0 GB floor (tavi serve --free-space-floor): file writes, stored files (downloads, reports, screenshots) and new sandbox.run calls are refused until space is freed.",
    );
    const refusing = {
      ...artifacts,
      putArtifact: async () => {
        throw floor;
      },
    };
    const directory = temp.create("tavi-browser-download-floor-");
    const downloadedPath = join(directory, "report.csv");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(downloadedPath, "a,b\n");
    const download = { path: vi.fn(async () => downloadedPath), suggestedFilename: vi.fn(() => "report.csv") } as unknown as Download;
    const page = fakePage({ locators: [fakeLocator()], waitForDownload: async () => download });
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => fakeBrowser(fakeContext(page)),
      artifacts: refusing,
    });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    await expect(
      adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "download" }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", message: expect.stringMatching(/free-space-floor/) });
    expect(await artifacts.listPendingReview("w1", 10)).toEqual([]);
  });

  it.each([
    ["report.csv", "report.csv"],
    ["../../x.sh", "x.sh"],
    [".bashrc", "bashrc"],
    ["invoice\u202Efdp.exe", "invoicefdp.exe"],
    ["a\u0000b\nc.txt", "abc.txt"],
    ["..", "download"],
  ])("a download records the page's suggested name %j made safe (%j), for downloads/ once approved", async (suggested, safe) => {
    const artifacts = fixtureArtifacts();
    const { writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = temp.create("tavi-browser-download-name-");
    const downloadedPath = join(directory, "body");
    await writeFile(downloadedPath, "bytes");
    const download = { path: vi.fn(async () => downloadedPath), suggestedFilename: vi.fn(() => suggested) } as unknown as Download;
    const page = fakePage({ locators: [fakeLocator()], waitForDownload: async () => download });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    const outcome = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "download" });
    const record = await artifacts.getArtifact(outcome.detail?.match(/saved as artifact (\S+)/)?.[1] ?? "");
    expect(record).toMatchObject({ reviewState: "pending", fileName: safe, folderCopy: "downloads" });
  });

  it("download reports rejected (not thrown) when Playwright's Download.path() rejects — the real failure shape, per the installed types", async () => {
    // Real `Download.path()` is typed `Promise<string>` and throws for a
    // failed/canceled download — it never resolves `null`. This fake
    // reflects that real shape, not a made-up one.
    const artifacts = fixtureArtifacts();
    const locator = fakeLocator();
    const download = {
      path: vi.fn(async () => {
        throw new Error("download failed");
      }),
      suggestedFilename: vi.fn(() => "x"),
      failure: vi.fn(async () => "net::ERR_FAILED"),
    } as unknown as Download;
    const page = fakePage({ locators: [locator], waitForDownload: async () => download });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    const outcome = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "download" });
    expect(outcome.status).toBe("rejected");
    expect(outcome.detail).toBe("net::ERR_FAILED");
  });

  it("download sniffs the media type from magic bytes and text content, and cancels files exceeding downloadMaxMiB", async () => {
    const artifacts = fixtureArtifacts();
    const { writeFile } = await import("node:fs/promises");
    const directory = temp.create("tavi-browser-download-bounded-");
    const pdfPath = join(directory, "statement.bin");
    await writeFile(pdfPath, Buffer.from("%PDF-1.7\nhello\n", "utf8"));
    const cancel = vi.fn(async () => undefined);
    const del = vi.fn(async () => undefined);
    let currentDownload: Download = {
      path: vi.fn(async () => pdfPath),
      suggestedFilename: vi.fn(() => "statement.bin"),
      cancel,
      delete: del,
    } as unknown as Download;

    const page = fakePage({ locators: [fakeLocator()], waitForDownload: async () => currentDownload });
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => fakeBrowser(fakeContext(page)),
      artifacts,
      downloadMaxMiB: 1,
    });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");

    const okOutcome = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "download" });
    const artifactId = okOutcome.detail?.match(/saved as artifact (\S+)/)?.[1] ?? "";
    expect((await artifacts.getArtifact(artifactId))?.contentType).toBe("application/pdf");

    const hugePath = join(directory, "huge.bin");
    await writeFile(hugePath, Buffer.alloc(1024 * 1024 + 512, 0x41));
    currentDownload = {
      path: vi.fn(async () => hugePath),
      suggestedFilename: vi.fn(() => "huge.bin"),
      cancel,
      delete: del,
    } as unknown as Download;

    await expect(adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observation.epoch, kind: "download" })).rejects.toThrow(
      /1 MiB size limit/,
    );
    expect(cancel).toHaveBeenCalled();
    expect(del).toHaveBeenCalled();
  });

  it("submit/upload/download translate a mid-action closed-target error into an UNAVAILABLE-driven uncertain outcome via dispatchBrowserAction", async () => {
    const { dispatchBrowserAction } = await import("@tavi/contracts");
    const locator = fakeLocator({
      press: vi.fn(async () => {
        throw new Error("Target page, context or browser has been closed");
      }),
    });
    const page = fakePage({ locators: [locator] });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observation = await adapter.navigate(session.sessionId, "https://example.com");
    const outcome = await dispatchBrowserAction(adapter, {
      sessionId: session.sessionId,
      ref: "el-0",
      epoch: observation.epoch,
      kind: "submit",
    });
    expect(outcome.status).toBe("uncertain");
  });
});

describe("createPlaywrightBrowser — read", () => {
  it("reads the page's text, with layout whitespace squeezed out", async () => {
    const page = fakePage({ url: "https://example.com/article" });
    Object.assign(page, {
      // The page's content is read by a function; the other samples are scripts, which this page does not answer.
      evaluate: vi.fn(async (script: unknown) =>
        typeof script === "function"
          ? { text: "  Headline  \n\n\n\n  First   paragraph.\u00a0 \nSecond.  ", links: [], truncated: false }
          : undefined,
      ),
      title: vi.fn(async () => "An article"),
    });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    expect(await adapter.read(session.sessionId)).toEqual({
      sessionId: session.sessionId,
      url: "https://example.com/article",
      title: "An article",
      text: "Headline\n\nFirst paragraph.\nSecond.",
      offset: 0,
      totalLength: 34,
    });
  });

  it("says so when the page's text cannot be read in time, rather than answering it empty", async () => {
    vi.useFakeTimers();
    try {
      const page = fakePage({ url: "https://slow.example.com/" });
      Object.assign(page, { evaluate: vi.fn(() => new Promise(() => {})), title: vi.fn(async () => "Slow") });
      const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
      const session = await adapter.createSession({ workspaceId: "w1" });
      const reading = adapter.read(session.sessionId);
      const refused = expect(reading).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("could not be read within 5s"),
      });
      // One unanswered activity sample (1s) ends the settle wait, then the read's own 5s.
      await vi.advanceTimersByTimeAsync(6_000);
      await refused;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to read a closed session", async () => {
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(fakePage())) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    await adapter.close(session.sessionId);
    await expect(adapter.read(session.sessionId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("createPlaywrightBrowser — launch resilience", () => {
  it("retries launch on the next createSession after a failed launch, rather than wedging permanently", async () => {
    const page = fakePage();
    const context = fakeContext(page);
    const browser = fakeBrowser(context);
    const launch = vi.fn().mockRejectedValueOnce(new Error("launch failed")).mockResolvedValueOnce(browser);
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch });
    await expect(adapter.createSession({ workspaceId: "w1" })).rejects.toThrow(/launch failed/);
    await expect(adapter.createSession({ workspaceId: "w1" })).resolves.toMatchObject({ state: "open" });
  });
});

describe("createPlaywrightBrowser — capture", () => {
  it("publishes a screenshot as a bounded artifact reference", async () => {
    const artifacts = fixtureArtifacts();
    const page = fakePage({ screenshot: async () => Buffer.from("fake-png") });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const result = await adapter.capture(session.sessionId);
    expect(result.artifactId).toBeDefined();
    expect(await artifacts.getArtifact(result.artifactId)).toBeDefined();
  });

  it("creates the screenshot artifact pending review, not approved by default — genuinely untrusted external content", async () => {
    const artifacts = fixtureArtifacts();
    const page = fakePage({ screenshot: async () => Buffer.from("fake-png") });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const result = await adapter.capture(session.sessionId);
    expect((await artifacts.getArtifact(result.artifactId))?.reviewState).toBe("pending");
  });

  it("labels a capture as the page's, untrusted web and personal with its host, joined with the calling conversation's", async () => {
    const artifacts = fixtureArtifacts();
    const page = fakePage({ url: "https://Shop.example/cart", screenshot: async () => Buffer.from("fake-png") });
    // No secret typed into the page, so it may be pictured for the model.
    Object.assign(page, { evaluate: vi.fn(async () => false) });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const forReview = await adapter.capture(session.sessionId);
    expect((await artifacts.getArtifact(forReview.artifactId))?.label).toMatchObject({
      integrity: "untrusted",
      sources: ["web"],
      principals: ["host:shop.example"],
      confidentiality: "personal",
    });
    const secret = { integrity: "trusted" as const, sources: [], principals: [], confidentiality: "secret" as const, refs: [] };
    const forModel = await adapter.capture(session.sessionId, { forModel: true, contextLabel: secret });
    const label = (await artifacts.getArtifact(forModel.artifactId))?.label;
    expect(label).toMatchObject({ integrity: "untrusted", sources: ["web"], principals: ["host:shop.example"], confidentiality: "secret" });
    expect(label?.refs).toEqual([expect.objectContaining({ source: "web", host: "shop.example" })]);
  });

  it("capture without a configured artifact store throws NOT_CONFIGURED", async () => {
    const page = fakePage();
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    await expect(adapter.capture(session.sessionId)).rejects.toThrow(/artifact store/);
  });

  it("draws Set-of-Marks in an isolated world, never the page's, and keeps the plain screenshot when that fails", async () => {
    for (const drawing of ["works", "fails"] as const) {
      const artifacts = fixtureArtifacts();
      const loc = fakeLocator({ boundingBox: vi.fn(async () => ({ x: 12, y: 34, width: 120, height: 40 })) });
      const page = fakePage({
        url: "https://example.com/map",
        locators: [loc],
        elements: [{ role: "button", text: "Zoom In" }],
        screenshot: async () => Buffer.from("fake-jpeg"),
      });
      const evaluate = vi.fn(async () => false);
      const context = fakeContext(page);
      const send = vi.fn(async (method: string, params?: { readonly expression?: string }) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (params?.expression?.includes("OffscreenCanvas") === true) {
          if (drawing === "fails") throw new Error("Execution context was destroyed");
          return { result: { value: Buffer.from("marked-jpeg").toString("base64") } };
        }
        return { result: { value: false } };
      });
      Object.assign(context, { newCDPSession: vi.fn(async () => ({ send, detach: vi.fn(async () => undefined) })) });
      Object.assign(page, { evaluate, context: () => context, frames: () => [], mainFrame: () => ({}) });
      const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(context), artifacts });
      const session = await adapter.createSession({ workspaceId: "w1" });
      await adapter.observe(session.sessionId);
      const marked = await adapter.capture(session.sessionId, { forModel: true, marks: true });
      const body = Buffer.from((await artifacts.readArtifactBody(marked.artifactId)) ?? []).toString();
      expect(body, drawing).toBe(drawing === "works" ? "marked-jpeg" : "fake-jpeg");
      expect(send).toHaveBeenCalledWith("Runtime.evaluate", expect.objectContaining({ contextId: 7, awaitPromise: true }));
      for (const call of evaluate.mock.calls as unknown[][]) expect(String(call[0])).not.toContain("OffscreenCanvas");
    }
  });

  it("supports Set-of-Marks boxes on forModel captures and full-resolution zoom crops by ref or region", async () => {
    const artifacts = fixtureArtifacts();
    const loc = fakeLocator({
      boundingBox: vi.fn(async () => ({ x: 12, y: 34, width: 120, height: 40 })),
    });
    const page = fakePage({
      url: "https://example.com/map",
      locators: [loc],
      elements: [{ role: "button", text: "Zoom In" }],
      screenshot: async () => Buffer.from("fake-jpeg"),
    });
    Object.assign(page, { evaluate: vi.fn(async () => false) });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)), artifacts });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const obs = await adapter.observe(session.sessionId);

    const marked = await adapter.capture(session.sessionId, { forModel: true, marks: true });
    expect(marked.marks).toEqual([{ ref: "el-0", x: 12, y: 34, width: 120, height: 40 }]);
    expect(marked.scale).toEqual({ logicalWidth: 1280, logicalHeight: 720, imageWidth: 1280, imageHeight: 720 });

    const zoomedByRef = await adapter.capture(session.sessionId, { forModel: true, ref: "el-0", epoch: obs.epoch });
    expect(zoomedByRef.scale).toEqual({ logicalWidth: 120, logicalHeight: 40, imageWidth: 120, imageHeight: 40 });
    expect(page.screenshot).toHaveBeenLastCalledWith({
      type: "jpeg",
      quality: 70,
      scale: "device",
      clip: { x: 12, y: 34, width: 120, height: 40 },
    });

    await adapter.capture(session.sessionId, { region: { x: 5, y: 10, width: 200, height: 150 } });
    expect(page.screenshot).toHaveBeenLastCalledWith({
      clip: { x: 5, y: 10, width: 200, height: 150 },
      scale: "device",
    });
  });
});

describe("createPlaywrightBrowser — dispose", () => {
  it("closes open sessions and the shared browser, once, and refuses new sessions after", async () => {
    const context = fakeContext(fakePage());
    const close = vi.fn(async () => {});
    const browser = { newContext: vi.fn(async () => context), close } as unknown as Browser;
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => browser });
    const open = await adapter.createSession({ workspaceId: "w1" });
    const closed = await adapter.createSession({ workspaceId: "w1" });
    await adapter.close(closed.sessionId);

    await adapter.dispose?.();
    await adapter.dispose?.();

    // The closed session's context once, by close(); the open one's once, by dispose().
    expect(context.close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(adapter.observe(open.sessionId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(adapter.createSession({ workspaceId: "w1" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("does not launch a browser it never needed", async () => {
    const launch = vi.fn(async () => fakeBrowser(fakeContext(fakePage())));
    await createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch }).dispose?.();
    expect(launch).not.toHaveBeenCalled();
  });
});

/** A page whose canary request goes through the launch's proxy, as Chromium would send it — or, `reaches` false, nowhere. */
function pageThroughProxy(
  launched: () => { proxy?: { server: string; username?: string; password?: string } } | undefined,
  reaches: boolean,
): Page {
  const page = fakePage();
  // The canary page: through the launch's proxy, as Chromium would send it — or, overridden, nowhere.
  (page as unknown as { goto: (url: string) => Promise<null> }).goto = async (url: string) => {
    const proxy = launched()?.proxy;
    if (!reaches || proxy === undefined) return null;
    const target = new URL(proxy.server);
    await new Promise<void>((resolve) => {
      const sent = httpRequest(
        {
          host: target.hostname,
          port: Number(target.port),
          path: url,
          headers: {
            Host: new URL(url).host,
            "Proxy-Authorization": `Basic ${Buffer.from(`${proxy.username ?? ""}:${proxy.password ?? ""}`).toString("base64")}`,
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve());
        },
      );
      sent.once("error", () => resolve());
      sent.end();
    });
    return null;
  };
  return page;
}

describe("createPlaywrightBrowser — identity and profiles", () => {
  /** A persistent profile: a context with pages, one blank page to start, closable. */
  function fakeProfile(): BrowserContext & { readonly opened: Page[] } {
    const blank = fakePage();
    const opened: Page[] = [blank];
    const handlers: (() => void)[] = [];
    return {
      opened,
      pages: vi.fn(() => opened),
      newPage: vi.fn(async () => {
        const page = fakePage();
        opened.push(page);
        return page;
      }),
      close: vi.fn(async () => {
        for (const handler of handlers) handler();
      }),
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "close") handlers.push(handler);
      }),
      waitForEvent: vi.fn(async () => {
        throw new Error("Timeout");
      }),
    } as unknown as BrowserContext & { readonly opened: Page[] };
  }

  it("sends every connection of the browser it launches through its own egress proxy, with its credentials, and runs it only once its traffic is seen there", async () => {
    const pageVia = pageThroughProxy;
    for (const reaches of [true, false]) {
      let options: { proxy?: { server: string; username?: string; password?: string }; args?: string[] } | undefined;
      const context = fakeContext(pageVia(() => options, reaches));
      const browser = {
        newContext: vi.fn(async () => context),
        version: () => "153.0.8010.12",
        close: vi.fn(async () => {}),
      } as unknown as Browser;
      const launch = vi.fn(async (given: typeof options) => {
        options = given;
        return browser;
      });
      const adapter = createPlaywrightBrowser({
        stagingDirectory: tmpdir(),
        launch: launch as never,
        egress: async () => ({ refused: "test" }),
      });
      if (reaches) {
        await adapter.createSession({ workspaceId: "w1" });
        expect(options?.proxy?.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(options?.proxy?.username).toMatch(/^tavi-/);
        expect(options?.args).toEqual(
          expect.arrayContaining(["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"]),
        );
      } else {
        // A managed policy's own proxy, say: the canary never reaches Tavi's, and the browser is not run.
        await expect(adapter.createSession({ workspaceId: "w1" })).rejects.toMatchObject({
          code: "UNAVAILABLE",
          message: expect.stringContaining("egress proxy"),
        });
        expect(browser.close).toHaveBeenCalled();
      }
      await adapter.dispose?.();
      // Disposed, it launches nothing more.
      await expect(adapter.createSession({ workspaceId: "w1" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
  });

  it("routes every request behind its egress proxy, so one Chromium restarts for a site's client hints is let through", async () => {
    // Playwright pauses every request to answer the proxy's credentials, and never resumes one Chromium restarts with the
    // hints a `Critical-CH` header asks for (every Google page): only a route of its own takes the path that does.
    let options: { proxy?: { server: string; username?: string; password?: string } } | undefined;
    const context = fakeContext(pageThroughProxy(() => options, true));
    let pattern: string | undefined;
    let handler: ((route: unknown, request: unknown) => Promise<void>) | undefined;
    Object.assign(context, {
      route: vi.fn(async (given: string, next: typeof handler) => {
        pattern = given;
        handler = next;
      }),
    });
    const browser = { newContext: vi.fn(async () => context), version: () => "153.0.8010.12", close: vi.fn(async () => {}) };
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: (async (given: typeof options) => {
        options = given;
        return browser;
      }) as never,
      egress: async () => ({ refused: "test" }),
    });
    await adapter.createSession({ workspaceId: "w1" });
    expect(pattern).toBe("**/*");
    const sent: unknown[] = [];
    const route = { continue: vi.fn(async (given?: unknown) => void sent.push(given)) };
    for (const type of ["document", "image"])
      await handler?.(route, { url: () => "https://www.google.com/maps", resourceType: () => type, headers: () => ({}) });
    // Passed on as they are: nothing signed, nothing changed.
    expect(sent).toEqual([undefined, undefined]);
    await adapter.dispose?.();
  });

  it("presents a desktop Chrome's agent and the operator's locale in a fresh context", async () => {
    const context = fakeContext(fakePage());
    const browser = { newContext: vi.fn(async () => context), version: () => "153.0.8010.12" } as unknown as Browser;
    const launch = vi.fn(async () => browser);
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch,
      identity: { locale: "en-US", timezoneId: "Europe/Sofia" },
    });
    await adapter.createSession({ workspaceId: "w1" });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, channel: "chromium", ignoreDefaultArgs: ["--enable-automation"] }),
    );
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "en-US", timezoneId: "Europe/Sofia", userAgent: expect.stringMatching(/ Chrome\/153\.0\.0\.0 /) }),
    );
  });

  it("opens a workspace's sessions as pages of its profile, and closing one closes only its page", async () => {
    const profile = fakeProfile();
    const probe = { version: () => "153.0.1.2", close: vi.fn(async () => {}) } as unknown as Browser;
    const launchPersistent = vi.fn(async () => profile);
    const directory = temp.create("tavi-profile-test-");
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => probe,
      launchPersistent,
      profileDirectory: (workspaceId) => join(directory, workspaceId),
    });
    const first = await adapter.createSession({ workspaceId: "w1" });
    const second = await adapter.createSession({ workspaceId: "w1" });
    expect(launchPersistent).toHaveBeenCalledTimes(1);
    expect(launchPersistent).toHaveBeenCalledWith(
      join(directory, "w1"),
      expect.objectContaining({ headless: true, userAgent: expect.stringContaining("Chrome/153.0.0.0") }),
    );
    // The version came from a browser launched only for it, then closed.
    expect(probe.close).toHaveBeenCalledTimes(1);
    // The first session took the profile's blank page; the second got its own.
    expect(profile.newPage).toHaveBeenCalledTimes(1);
    await adapter.close(first.sessionId);
    expect(profile.opened[0]?.close).toHaveBeenCalledTimes(1);
    expect(profile.close).not.toHaveBeenCalled();
    await adapter.observe(second.sessionId);

    expect(await adapter.clearProfile?.("w1")).toEqual({ closed: 1 });
    expect(profile.close).toHaveBeenCalledTimes(1);
    await expect(stat(join(directory, "w1"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.observe(second.sessionId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    // A cleared profile is opened again for the next session.
    await adapter.createSession({ workspaceId: "w1" });
    expect(launchPersistent).toHaveBeenCalledTimes(2);
    // A session asked for while the profile is being cleared waits, and opens on the profile opened anew.
    const clearing = adapter.clearProfile?.("w1");
    const during = adapter.createSession({ workspaceId: "w1" });
    await clearing;
    const launches = launchPersistent.mock.calls.length;
    await during;
    expect(launchPersistent.mock.calls.length).toBe(launches + 1);
  });

  it("gives two sessions opening at once their own pages", async () => {
    const profile = fakeProfile();
    const waiting: (() => void)[] = [];
    const release = (): void => {
      for (const resolve of waiting) resolve();
    };
    const history = {
      open: vi.fn(() => new Promise<void>((resolve) => waiting.push(resolve))),
    } as unknown as BrowserHistoryRepositoryPort;
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => ({ version: () => "153.0.1.2", close: vi.fn(async () => {}) }) as unknown as Browser,
      launchPersistent: async () => profile,
      profileDirectory: () => join(tmpdir(), "tavi-profile-unused"),
      history,
    });
    const first = adapter.createSession({ workspaceId: "w1", taskId: "t1" });
    await vi.waitFor(() => expect(history.open).toHaveBeenCalledTimes(1));
    const second = adapter.createSession({ workspaceId: "w1", taskId: "t1" });
    await vi.waitFor(() => expect(profile.newPage).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(profile.opened).toHaveLength(2);
  });

  it("follows only a tab its own page opened in a shared profile", async () => {
    const profile = fakeProfile();
    const page = profile.opened[0] as Page;
    const theirs = fakePage({ url: "https://other.example" });
    const ours = fakePage({ url: "https://opened.example" });
    (ours.opener as ReturnType<typeof vi.fn>).mockResolvedValue(page);
    let predicate: ((popup: Page) => Promise<boolean>) | undefined;
    (profile.waitForEvent as ReturnType<typeof vi.fn>).mockImplementation(
      async (_event: string, options: { predicate: (popup: Page) => Promise<boolean> }) => {
        predicate = options.predicate;
        for (const candidate of [theirs, ours]) if (await options.predicate(candidate)) return candidate;
        throw new Error("Timeout");
      },
    );
    const link = fakeLocator();
    (page.locator as ReturnType<typeof vi.fn>).mockReturnValue(fakeMatches([link], [{ role: "link", text: "Open" }]));
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => ({ version: () => "153.0.1.2", close: vi.fn(async () => {}) }) as unknown as Browser,
      launchPersistent: async () => profile,
      profileDirectory: () => join(tmpdir(), "tavi-profile-unused"),
    });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const observed = await adapter.observe(session.sessionId);
    const outcome = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: observed.epoch, kind: "click" });
    expect(await predicate?.(theirs)).toBe(false);
    expect(outcome.detail).toContain("https://opened.example");
  });

  it("falls back to a fresh context, saying why, when the profile will not open", async () => {
    const context = fakeContext(fakePage());
    const onWarning = vi.fn();
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => ({ ...fakeBrowser(context), close: vi.fn(async () => {}) }) as unknown as Browser,
      launchPersistent: async () => {
        throw new Error("profile in use");
      },
      profileDirectory: () => join(tmpdir(), "tavi-profile-unused"),
      onWarning,
    });
    await adapter.createSession({ workspaceId: "w1" });
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("profile in use"));
  });

  it("does not fall back when the browser is not installed", async () => {
    const missing = new TaviError("CAPABILITY_MISSING", "no chromium");
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => {
        throw missing;
      },
      profileDirectory: () => join(tmpdir(), "tavi-profile-unused"),
    });
    await expect(adapter.createSession({ workspaceId: "w1" })).rejects.toBe(missing);
  });

  it("returns page from act on submit, select, overlay changes, and >= 30% element changes", async () => {
    let currentElements = [
      { role: "button", text: "First", key: "first", occurrence: 0 },
      { role: "button", text: "Second", key: "second", occurrence: 0 },
      { role: "button", text: "Third", key: "third", occurrence: 0 },
    ];
    const loc1 = fakeLocator({
      click: vi.fn(async () => {
        currentElements = [
          { role: "button", text: "First", key: "first", occurrence: 0 },
          { role: "button", text: "Replaced", key: "replaced", occurrence: 0 },
          { role: "button", text: "Third", key: "third", occurrence: 0 },
        ];
      }),
    });
    const loc2 = fakeLocator();
    const loc3 = fakeLocator();
    const page = fakePage();
    (page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => fakeMatches([loc1, loc2, loc3], currentElements));
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const obs = await adapter.navigate(session.sessionId, "https://example.com");

    // 1/3 (~33.3% >= 30%) elements changed on click -> returns page
    const clicked = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: obs.epoch, kind: "click" });
    expect(clicked.page?.elements.map((e) => e.text)).toEqual(["First", "Replaced", "Third"]);

    // submit always returns page
    const submitted = await adapter.act({
      sessionId: session.sessionId,
      ref: "el-0",
      epoch: clicked.page?.epoch ?? obs.epoch,
      kind: "submit",
    });
    expect(submitted.page).toBeDefined();
  });

  it("keeps a ring buffer of the last 10 fetch/xhr/document >= 400 responses (with scrubbed URLs) and pageerror messages, surfacing networkErrors when an action changes nothing", async () => {
    const listeners = new Map<string, ((arg: unknown) => void)[]>();
    // The click is when the page's requests fail: what the action ran into, not what came before it.
    let duringClick = (): void => undefined;
    const loc = fakeLocator({ click: vi.fn(async () => duringClick()) });
    const page = fakePage({ locators: [loc], elements: [{ role: "button", text: "Save" }] });
    (page.on as unknown as ReturnType<typeof vi.fn>).mockImplementation((event: string, cb: (arg: unknown) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    });
    const emit = (event: string, arg: unknown): void => {
      for (const cb of listeners.get(event) ?? []) cb(arg);
    };

    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const obs = await adapter.navigate(session.sessionId, "https://example.com/checkout");

    // Ignored: status < 400 or non-fetch/xhr/document resourceType
    emit("response", {
      status: () => 200,
      url: () => "https://example.com/api/ok?token=secret",
      request: () => ({ resourceType: () => "fetch", method: () => "GET", isNavigationRequest: () => false }),
    });
    emit("response", {
      status: () => 404,
      url: () => "https://example.com/img/missing.png?sig=123",
      request: () => ({ resourceType: () => "image", method: () => "GET", isNavigationRequest: () => false }),
    });

    // Before the action: an error of the page's load, which the click does not report.
    emit("response", {
      status: () => 503,
      url: () => "https://example.com/api/earlier",
      request: () => ({ resourceType: () => "fetch", method: () => "GET", isNavigationRequest: () => false }),
    });
    const earlier = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: obs.epoch, kind: "click" });
    expect(earlier.networkErrors).toBeUndefined();

    // Push 11 errors to verify ring buffer caps at 10
    duringClick = () => {
      for (let i = 1; i <= 10; i += 1) {
        emit("response", {
          status: () => 500 + (i % 3),
          url: () => `https://user:pass@example.com/api/step-${i}?token=secret-${i}#frag`,
          request: () => ({
            resourceType: () => (i % 2 === 0 ? "xhr" : "fetch"),
            method: () => "post",
            isNavigationRequest: () => false,
          }),
        });
      }
      emit("pageerror", new Error("Uncaught TypeError: Cannot read properties of null\n    at submit (app.js:10:5)"));
    };

    const noopClick = await adapter.act({ sessionId: session.sessionId, ref: "el-0", epoch: obs.epoch, kind: "click" });
    expect(noopClick.status).toBe("accepted");
    expect(noopClick.networkErrors).toHaveLength(10);
    // First entry (step-1) was evicted; step-2 is now first, with userinfo, query, and hash scrubbed
    expect(noopClick.networkErrors?.[0]).toEqual({
      status: 502,
      method: "POST",
      url: "https://example.com/api/step-2",
    });
    expect(noopClick.networkErrors?.[9]).toEqual({
      pageError: "Uncaught TypeError: Cannot read properties of null at submit (app.js:10:5)",
    });
  });

  it("opens an ephemeral session in a fresh context without using the workspace profile directory", async () => {
    const persistentPage = fakePage({ locators: [fakeLocator()] });
    const ephemeralPage = fakePage({ locators: [fakeLocator()] });
    const launchPersistent = vi.fn(async () => fakeContext(persistentPage));
    const launch = vi.fn(async () => fakeBrowser(fakeContext(ephemeralPage)));
    const profileDir = temp.create("tavi-browser-ephemeral-");
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      profileDirectory: (ws) => join(profileDir, ws),
      launchPersistent,
      launch,
    });
    const ephem = await adapter.createSession({ workspaceId: "w1", profile: "ephemeral" });
    expect(ephem.state).toBe("open");
    expect(launchPersistent).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);

    const persist = await adapter.createSession({ workspaceId: "w1" });
    expect(persist.state).toBe("open");
    expect(launchPersistent).toHaveBeenCalledTimes(1);
  });
});

describe("createPlaywrightBrowser — navigation downloads and inline PDFs", () => {
  const MiB = 1024 * 1024;

  /** A PDF engine that reads `text` from whatever it is handed. */
  function pdfEngineReading(text: string) {
    return {
      run: vi.fn(async () => ({
        ok: true as const,
        answer: {
          ok: true as const,
          facts: {
            sha256: "0".repeat(64),
            pageCount: 1,
            encryption: "none" as const,
            fillPermitted: false,
            modifyPermitted: false,
            form: "none" as const,
            fieldCount: 0,
            signatures: 0,
            activeContent: [],
            comments: 0,
            imageOnlyPages: [],
          },
          pages: [{ page: 1, text, hidden: [] }],
          maxRssKb: 1024,
        },
        pngs: [],
        document: new Uint8Array(0),
        peakKb: 1024,
        wallMs: 10,
      })),
    };
  }

  /** A page whose `on`/`off` really register listeners, and a context whose DevTools session answers `answer`. */
  function wiredPage(answer: (method: string, params?: Record<string, unknown>) => unknown = () => ({})) {
    const page = fakePage();
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const emit = (event: string, payload: unknown): void => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    };
    Object.assign(page, {
      on: vi.fn((event: string, listener: (payload: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)?.add(listener);
      }),
      off: vi.fn((event: string, listener: (payload: unknown) => void) => listeners.get(event)?.delete(listener)),
    });
    const progress: ((payload: unknown) => void)[] = [];
    const send = vi.fn(async (method: string, params?: Record<string, unknown>) => answer(method, params));
    const detach = vi.fn(async () => undefined);
    const context = fakeContext(page);
    Object.assign(context, {
      newCDPSession: vi.fn(async () => ({
        on: (event: string, listener: (payload: unknown) => void) => {
          if (event === "Page.downloadProgress") progress.push(listener);
        },
        send,
        detach,
      })),
    });
    const count = (event: string): number => listeners.get(event)?.size ?? 0;
    const downloadProgress = (payload: unknown): void => {
      for (const listener of progress) listener(payload);
    };
    return { page, context, emit, count, send, detach, downloadProgress };
  }

  const response = (url: string, length: number) => ({
    url: () => url,
    status: () => 200,
    headers: () => ({ "content-length": String(length) }),
    request: () => ({ resourceType: () => "media", method: () => "GET", isNavigationRequest: () => false }),
  });

  it("a large subresource does not fail an ordinary navigation, and the size watch is let go after it", async () => {
    const wired = wiredPage();
    (wired.page.goto as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (target: string) => {
      (wired.page.url as unknown as ReturnType<typeof vi.fn>).mockReturnValue(target);
      wired.emit("response", response("https://example.com/intro.mp4", 50 * MiB));
      return null;
    });
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => fakeBrowser(wired.context),
      downloadMaxMiB: 1,
    });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const before = { response: wired.count("response"), download: wired.count("download") };
    const observation = await adapter.navigate(session.sessionId, "https://example.com/");
    expect(observation.url).toBe("https://example.com/");
    // Watched from before the page loaded, and let go after.
    expect(wired.send).toHaveBeenCalledWith("Page.enable");
    expect(wired.detach).toHaveBeenCalled();
    expect({ response: wired.count("response"), download: wired.count("download") }).toEqual(before);
  });

  it("a navigation that downloads a file over the cap is cancelled, deleted and refused, by its response or the browser's progress", async () => {
    for (const via of ["response", "progress"] as const) {
      const wired = wiredPage();
      const cancel = vi.fn(async () => undefined);
      const remove = vi.fn(async () => undefined);
      const fileUrl = "https://example.com/huge.zip";
      const download = {
        url: () => fileUrl,
        // The browser is still downloading it.
        path: vi.fn(() => new Promise<string>(() => {})),
        suggestedFilename: () => "huge.zip",
        cancel,
        delete: remove,
      } as unknown as Download;
      (wired.page.goto as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // An ordinary-sized subresource first, then the file itself.
        wired.emit("response", response("https://example.com/logo.png", 1024));
        if (via === "response") wired.emit("response", response(fileUrl, 2 * MiB));
        else wired.downloadProgress({ totalBytes: 2 * MiB, receivedBytes: 1024 });
        wired.emit("download", download);
        throw new Error("Download is starting");
      });
      const adapter = createPlaywrightBrowser({
        stagingDirectory: tmpdir(),
        launch: async () => fakeBrowser(wired.context),
        downloadMaxMiB: 1,
      });
      const session = await adapter.createSession({ workspaceId: "w1" });
      await expect(adapter.navigate(session.sessionId, fileUrl), via).rejects.toThrow(/1 MiB size limit/);
      expect(cancel, via).toHaveBeenCalled();
      expect(remove, via).toHaveBeenCalled();
      expect(wired.detach, via).toHaveBeenCalled();
    }
  });

  it("cancelling the call cancels a download its navigation started", async () => {
    const wired = wiredPage();
    const cancel = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    let waited: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      waited = resolve;
    });
    const download = {
      url: () => "https://example.com/slow.pdf",
      path: vi.fn(() => {
        waited();
        return new Promise<string>(() => {});
      }),
      suggestedFilename: () => "slow.pdf",
      cancel,
      delete: remove,
    } as unknown as Download;
    (wired.page.goto as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      wired.emit("download", download);
      throw new Error("Download is starting");
    });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(wired.context) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    const navigating = adapter.navigate(session.sessionId, "https://example.com/slow.pdf");
    await waiting;
    await adapter.cancel(session.sessionId);
    await expect(navigating).rejects.toMatchObject({ code: "CANCELLED" });
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalled();
      expect(remove).toHaveBeenCalled();
    });
  });

  it("a PDF a navigation downloads within the cap is read, and the browser's copy deleted", async () => {
    const wired = wiredPage();
    const directory = temp.create("tavi-browser-nav-download-");
    const pdfPath = join(directory, "statement.pdf");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(pdfPath, Buffer.from("%PDF-1.7\nhello\n%%EOF\n", "latin1"));
    const cancel = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const download = {
      url: () => "https://example.com/statement.pdf",
      path: vi.fn(async () => pdfPath),
      suggestedFilename: () => "statement.pdf",
      cancel,
      delete: remove,
    } as unknown as Download;
    (wired.page.goto as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      wired.emit("response", response("https://example.com/statement.pdf", 21));
      wired.emit("download", download);
      throw new Error("Download is starting");
    });
    const adapter = createPlaywrightBrowser({
      stagingDirectory: tmpdir(),
      launch: async () => fakeBrowser(wired.context),
      pdf: pdfEngineReading("Statement read"),
    });
    const session = await adapter.createSession({ workspaceId: "w1" });
    await adapter.navigate(session.sessionId, "https://example.com/statement.pdf");
    expect((await adapter.read(session.sessionId)).text).toBe("Statement read");
    expect(cancel).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });

  it("an inline PDF over the cap by its Content-Length is neither buffered nor fetched again", async () => {
    const wired = wiredPage();
    const body = vi.fn(async () => Buffer.from("%PDF-1.4\n%%EOF\n", "latin1"));
    (wired.page.goto as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (target: string) => {
      (wired.page.url as unknown as ReturnType<typeof vi.fn>).mockReturnValue(target);
      return {
        status: () => 200,
        headers: () => ({ "content-type": "application/pdf", "content-length": String(64 * MiB + 1) }),
        body,
      };
    });
    const pdf = pdfEngineReading("never read");
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(wired.context), pdf });
    const session = await adapter.createSession({ workspaceId: "w1" });
    await adapter.navigate(session.sessionId, "https://example.com/huge.pdf");
    expect(body).not.toHaveBeenCalled();
    expect(wired.send).not.toHaveBeenCalledWith("Network.loadNetworkResource", expect.anything());
    expect(pdf.run).not.toHaveBeenCalled();
  });

  it("an inline PDF whose body Playwright cannot give is fetched again as a stream, stopped past the cap", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4\n(Chunked statement) Tj\n%%EOF\n", "latin1");
    const megabyte = Buffer.alloc(MiB, 0x41).toString("base64");
    for (const size of ["within", "over"] as const) {
      const wired = wiredPage((method) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        if (method === "Network.loadNetworkResource") return { resource: { success: true, stream: "stream-1", headers: {} } };
        if (method === "IO.read") {
          // Chunked: no length declared, and the over-cap one never ends.
          return size === "within"
            ? { data: pdfBytes.toString("base64"), base64Encoded: true, eof: true }
            : { data: megabyte, base64Encoded: true, eof: false };
        }
        return {};
      });
      (wired.page.goto as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (target: string) => {
        (wired.page.url as unknown as ReturnType<typeof vi.fn>).mockReturnValue(target);
        return {
          status: () => 200,
          headers: () => ({ "content-type": "application/pdf" }),
          body: async () => {
            throw new Error("Response body is unavailable for navigation requests");
          },
        };
      });
      const pdf = pdfEngineReading("Chunked statement");
      const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(wired.context), pdf });
      const session = await adapter.createSession({ workspaceId: "w1" });
      await adapter.navigate(session.sessionId, "https://example.com/statement.pdf");
      expect(wired.send, size).toHaveBeenCalledWith(
        "Network.loadNetworkResource",
        expect.objectContaining({ frameId: "main", url: "https://example.com/statement.pdf" }),
      );
      expect(wired.send, size).toHaveBeenCalledWith("IO.close", { handle: "stream-1" });
      const reads = wired.send.mock.calls.filter(([method]) => method === "IO.read").length;
      if (size === "within") {
        expect(reads).toBe(1);
        expect(pdf.run).toHaveBeenCalledTimes(1);
      } else {
        // 64 MiB is the cap: the 65th MiB is the last one read.
        expect(reads).toBe(65);
        expect(pdf.run).not.toHaveBeenCalled();
      }
    }
  });
});

describe("createPlaywrightBrowser — a page that never answers", () => {
  it("fails a navigation that timed out with its own error, though the page's DevTools session never lets go", async () => {
    const page = fakePage();
    Object.assign(page, {
      goto: vi.fn(async () => {
        throw new Error("page.goto: Timeout 15000ms exceeded.");
      }),
    });
    const context = fakeContext(page);
    // A renderer stuck on its document: the download watch's session attaches, and its detach never answers.
    const stuck = { on: vi.fn(), send: vi.fn(async () => undefined), detach: vi.fn(() => new Promise(() => {})) };
    Object.assign(context, { newCDPSession: vi.fn(async () => stuck) });
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(context) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    vi.useFakeTimers();
    try {
      const navigating = adapter.navigate(session.sessionId, "https://www.google.com/maps/search/electrician+Sofia");
      const failed = expect(navigating).rejects.toThrow("Timeout 15000ms exceeded");
      await vi.advanceTimersByTimeAsync(5_000);
      await failed;
      expect(stuck.detach).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails an observation fast, saying why, when the page never answers its scan", async () => {
    const page = fakePage({ url: "https://www.google.com/maps" });
    (page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      evaluateAll: vi.fn(() => new Promise(() => {})),
      nth: () => undefined,
    }));
    const adapter = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch: async () => fakeBrowser(fakeContext(page)) });
    const session = await adapter.createSession({ workspaceId: "w1" });
    vi.useFakeTimers();
    try {
      const observing = adapter.observe(session.sessionId);
      const refused = expect(observing).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("did not answer within 10s"),
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await refused;
    } finally {
      vi.useRealTimers();
    }
  });
});
