import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SiteProfileSchema, TaviError, type EnabledSiteProfile, type ModelPort, type ModelRequest, type SiteUsage } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { createPlaywrightBrowser } from "@tavi/plugin-browser/playwright";
import { createInMemoryArtifactRepository } from "@tavi/test-support/fakes";
import { ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories, partialFake, delay } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEngine } from "../../../../packages/external/places-open/src/engine.js";
import { startPlacesSite } from "../../../../packages/external/places-open/test/fixtures/site/server.mjs";
import { registerBrowserExtractTool } from "../../src/features/browser/extract.js";
import { registerBrowserVisionTool } from "../../src/features/browser/vision.js";
import { registerBrowserTools } from "../../src/features/sandbox/tools.js";
import { createRobotsReader, createSitePolicy, keepingFindings } from "../../src/features/browser/site-policy.js";

/** The fixture sites run on this machine: exempt from the browser's private-address rule, and from nothing else. */
const FIXTURE_HOSTS = ["127.0.0.1", "localhost", "*.localhost"];

/**
 * places.open's site profiles against a real Chromium and a local places site.
 * The shipped
 * profiles are read from packages/external/places-open/sites/ and pointed at
 * loopback names (Chromium resolves `*.localhost` to 127.0.0.1): Kakao's
 * (read, made watchable with a search path here) on 127.0.0.1, Tabelog's
 * (assist-only), Doctolib's, Resy's, Treatwell's and GasBuddy's (navigate:
 * false) and TheFork's (stage) on their own names. OpenTable's is shipped but
 * left off. Without Chromium the tests skip.
 */
const sitesDir = join(import.meta.dirname, "..", "..", "..", "..", "packages", "external", "places-open", "sites");
const shipped = (file: string, host: string, overrides: Record<string, unknown> = {}): EnabledSiteProfile => {
  const raw = JSON.parse(readFileSync(join(sitesDir, `${file}.json`), "utf8")) as Record<string, unknown>;
  return {
    pluginId: "places.open",
    profile: SiteProfileSchema.parse({
      ...raw,
      hosts: [host],
      budget: { pagesPerTask: 8, pagesPerDay: 40, minIntervalMs: 1_000 },
      ...overrides,
    }),
  };
};
const NEVER_NAVIGATED = [
  ["doctolib-fr", "doctolib.localhost"],
  ["resy", "resy.localhost"],
  ["treatwell", "treatwell.localhost"],
  ["gasbuddy", "gasbuddy.localhost"],
] as const;

let site: Awaited<ReturnType<typeof startPlacesSite>>;
let skip: string | undefined;
let call: (id: string, input: unknown, taskId?: string, unattended?: boolean, extra?: Record<string, unknown>) => Promise<unknown>;
let personOpens: (sessionId: string, url: string) => Promise<unknown>;
let sites: ReturnType<typeof createSitePolicy>;
let closeBrowser: () => Promise<void> = async () => undefined;
let registry: ToolRegistry;
const extractions: ModelRequest[] = [];
const homes = temporaryDirectories();

beforeAll(async () => {
  try {
    const chromium = await launchChromium({ headless: true });
    await chromium.close();
  } catch (error) {
    // Only a host without Chromium skips; any other failure to launch fails the tests.
    if (error instanceof TaviError && error.code === "CAPABILITY_MISSING") {
      skip = error.message;
      return;
    }
    throw error;
  }
  site = await startPlacesSite();
  const counts = new Map<string, SiteUsage>();
  sites = createSitePolicy({
    profiles: async () => [
      shipped("kakao-place", "127.0.0.1", {
        access: {
          ...(JSON.parse(readFileSync(join(sitesDir, "kakao-place.json"), "utf8")) as { access: Record<string, unknown> }).access,
          watchable: true,
        },
        search: { urlTemplate: "/search?q={query}", params: ["query"] },
      }),
      shipped("tabelog", "tabelog.localhost"),
      ...NEVER_NAVIGATED.map(([file, host]) => shipped(file, host)),
      shipped("thefork", "fork.localhost"),
      shipped("doctoralia-es", "clinic.localhost"),
      // 2GIS's profile (read) stands for any read site where a human check shows.
      shipped("2gis", "checks.localhost"),
    ],
    usage: {
      take: async ({ workspaceId, profile: key, day, counter, limit }) => {
        const at = `${workspaceId}|${key}|${day}`;
        const known = counts.get(at) ?? { pages: 0, finalSteps: 0 };
        if (known[counter] >= limit) return { ok: false, usage: known };
        counts.set(at, { ...known, [counter]: known[counter] + 1 });
        return { ok: true, usage: counts.get(at) ?? known };
      },
      get: async (workspaceId, key, day) => counts.get(`${workspaceId}|${key}|${day}`) ?? { pages: 0, finalSteps: 0 },
    },
    // The fixture site is on loopback, which the owner's pinned reader refuses: read it unpinned.
    robots: createRobotsReader(fetch),
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
  });
  await sites.refresh();
  const browser = createPlaywrightBrowser({ stagingDirectory: tmpdir(), artifacts: createInMemoryArtifactRepository() });
  closeBrowser = async () => browser.dispose?.();
  registry = new ToolRegistry();
  const tools = registerBrowserTools(registry, browser, { sites, handoff: true, privateHostsAllowed: FIXTURE_HOSTS });
  // A stand-in extraction model: it answers the hours it was asked for, and the test reads what it was shown.
  const models = partialFake<ModelPort>({
    stream: async (request: ModelRequest) => {
      extractions.push(request);
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: '{"records":[{"name":"Fixture Bistro","hours":"Mo-Fr 12:00-22:00; Sa 18:00-23:00"}],"complete":true}',
        toolCalls: [],
        usage: {},
      };
    },
  });
  let ids = 0;
  const utility = {
    browser,
    models,
    target: async () => ({ connectionId: "main", model: "vision" }),
    newId: () => `id-${String((ids += 1))}`,
    now: () => nowTimestamp(),
    sites,
  };
  registerBrowserExtractTool(registry, utility);
  registerBrowserVisionTool(registry, { ...utility, urlNow: (sessionId) => tools.urlNow(sessionId) });
  call = async (id, input, taskId = "task-1", unattended = false, extra = {}) => {
    const tool = registry.get(id);
    if (tool === undefined) throw new Error(`no ${id}`);
    return tool.handler({
      input,
      context: { workspaceId: "default", principalId: "operator", runId: taskId, caller: "test" },
      signal: new AbortController().signal,
      ...(unattended ? { executionPolicy: { mode: "unattended" } } : {}),
      ...extra,
    } as never);
  };
  // What a person does in the live view: their own navigation, not a tool's.
  personOpens = (sessionId, url) => browser.navigate(sessionId, url);
}, 60_000);

afterAll(async () => {
  await closeBrowser();
  await site?.close();
  homes.cleanup();
});

const session = async (taskId: string): Promise<string> =>
  ((await call("browser.create_session", {}, taskId)) as { sessionId: string }).sessionId;
const on = (host: string): string => site.origin.replace("127.0.0.1", host);

describe("structured data first", () => {
  it("reads a restaurant's JSON-LD hours, and reconcile merges them with the place found", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("structured");
    await call("browser.navigate", { sessionId: id, url: `${site.origin}/restaurant` }, "structured");
    const read = (await call("browser.structured", { sessionId: id }, "structured")) as { url: string; items: Record<string, unknown>[] };
    expect(read.items).toEqual([expect.objectContaining({ "@type": "Restaurant", name: "Fixture Bistro" })]);
    const home = homes.create("tavi-places-site-");
    const places = createEngine({
      storePath: join(home, "places.db"),
      fetcher: async () => ({ status: 404, retryAfter: null, body: null, bytes: 0 }),
      openParquet: async () => {
        throw new Error("no network");
      },
      config: {},
      version: "test",
    });
    try {
      const merged = places.reconcile({ items: read.items.map((data) => ({ kind: "jsonld", url: read.url, data })) });
      expect(merged.read).toBe(1);
      expect(merged.places).toHaveLength(1);
      expect(merged.places[0]?.hours?.spec).toBe("Mo-Fr 12:00-22:00; Sa 18:00-23:00; Su off");
      // Compared, not kept: the store holds no place from the page.
      expect(places.compare({ placeIds: [merged.places[0]?.placeId ?? ""] }).rows).toEqual([
        { placeId: merged.places[0]?.placeId, missing: true },
      ]);
    } finally {
      places.close();
    }
  }, 60_000);

  it("finds no structured data on the DOM-only page, and extract reads its hours from the page", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("dom");
    await call("browser.navigate", { sessionId: id, url: `${site.origin}/restaurant-dom` }, "dom");
    expect(await call("browser.structured", { sessionId: id }, "dom")).toMatchObject({ items: [] });
    // The stand-in model answers the same record for any page: what matters is that the page's own hours reached it.
    const asked = extractions.length;
    await call("browser.extract", { sessionId: id, instruction: "the restaurant's name and opening hours" }, "dom");
    expect(extractions).toHaveLength(asked + 1);
    expect(
      extractions
        .at(-1)
        ?.messages.map((message) => message.text)
        .join("\n"),
    ).toContain("Monday to Friday: 12:00–22:00");
  }, 60_000);

  it("drops a hidden injection from a JSON-LD description", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("injected");
    await call("browser.navigate", { sessionId: id, url: `${site.origin}/injected` }, "injected");
    const read = await call("browser.structured", { sessionId: id }, "injected");
    expect(read).toMatchObject({ items: [expect.objectContaining({ name: "Fixture Bistro", description: "A small French bistro." })] });
    expect(JSON.stringify(read)).not.toContain("member id");
  }, 60_000);
});

describe("the places profiles' rules", () => {
  it("never navigates Doctolib, Resy, Treatwell or GasBuddy; a page the person opened is read", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    for (const [, host] of NEVER_NAVIGATED) {
      const id = await session(`never-${host}`);
      await expect(call("browser.navigate", { sessionId: id, url: `${on(host)}/restaurant` }, `never-${host}`), host).rejects.toThrow(
        /only a page the person opened is read/,
      );
      await personOpens(id, `${on(host)}/restaurant`);
      // Read, not refused: kept to the profile's own JSON-LD types, so only Resy's (Restaurant) holds the bistro.
      const read = (await call("browser.structured", { sessionId: id }, `never-${host}`)) as { url: string; items: unknown[] };
      expect(read.url, host).toBe(`${on(host)}/restaurant`);
      expect(read.items, host).toEqual(host === "resy.localhost" ? [expect.objectContaining({ name: "Fixture Bistro" })] : []);
      await expect(call("browser.extract", { sessionId: id, instruction: "the hours" }, `never-${host}`), host).rejects.toThrow(/refused/);
    }
  }, 120_000);

  it("keeps nothing from Tabelog (assist-only): a finding from its page is dropped", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("tabelog");
    await call("browser.navigate", { sessionId: id, url: `${on("tabelog.localhost")}/restaurant` }, "tabelog");
    expect(await call("browser.structured", { sessionId: id }, "tabelog")).toMatchObject({
      items: [expect.objectContaining({ name: "Fixture Bistro" })],
    });
    const kept: unknown[] = [];
    const findings = keepingFindings({ add: async (input) => (kept.push(input), []), list: async () => [] }, sites);
    await findings.add({
      taskId: "tabelog",
      workspaceId: "default",
      kind: "place",
      records: [{ name: "Fixture Bistro" }],
      sourceUrl: `${on("tabelog.localhost")}/restaurant`,
      createdAt: nowTimestamp(),
    });
    await findings.add({
      taskId: "tabelog",
      workspaceId: "default",
      kind: "place",
      records: [{ name: "Fixture Bistro" }],
      sourceUrl: `${site.origin}/restaurant`,
      createdAt: nowTimestamp(),
    });
    expect(kept).toEqual([expect.objectContaining({ sourceUrl: `${site.origin}/restaurant` })]);
    // An extract is read for the turn; it is the finding from it that is dropped.
    expect(await call("browser.extract", { sessionId: id, instruction: "the hours" }, "tabelog")).toMatchObject({
      url: `${on("tabelog.localhost")}/restaurant`,
    });
  }, 60_000);

  it("refuses the 9th page in a task at pagesPerTask 8", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("budget");
    for (const page of [1, 2, 3, 4, 5, 6, 7, 8])
      await call("browser.navigate", { sessionId: id, url: `${site.origin}/page/${String(page)}` }, "budget");
    await expect(call("browser.navigate", { sessionId: id, url: `${site.origin}/page/9` }, "budget")).rejects.toMatchObject({
      details: { budgetExhausted: true },
    });
    expect(site.asked).not.toContain("/page/9");
  }, 60_000);

  it("refuses a profile left off, as any host no profile names", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("off");
    const before = site.asked.length;
    await expect(call("browser.navigate", { sessionId: id, url: `${on("opentable.localhost")}/restaurant` }, "off")).rejects.toThrow(
      /has no allowed destinations/,
    );
    expect(site.asked).toHaveLength(before);
  }, 60_000);

  it("is not watched at all once robots.txt disallows the profile's own search path", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("sweep");
    await expect(call("browser.navigate", { sessionId: id, url: `${site.origin}/restaurant` }, "sweep", true)).rejects.toThrow(
      /disallows its search \(\/search\)/,
    );
  }, 60_000);

  it("ends a site for the task at a human check, met on a navigation or in an observation", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("captcha");
    expect(await call("browser.navigate", { sessionId: id, url: `${on("checks.localhost")}/captcha` }, "captcha")).toMatchObject({
      blocked: { kind: "captcha" },
    });
    await expect(call("browser.navigate", { sessionId: id, url: `${on("checks.localhost")}/restaurant` }, "captcha")).rejects.toThrow(
      /showed a captcha in this task/,
    );
    // A human check the person's own page shows, seen in an observation, ends the site too.
    const observed = await session("captcha-observed");
    await personOpens(observed, `${on("checks.localhost")}/captcha`);
    expect(await call("browser.observe", { sessionId: observed }, "captcha-observed")).toMatchObject({ blocked: { kind: "captcha" } });
    await expect(
      call("browser.navigate", { sessionId: observed, url: `${on("checks.localhost")}/restaurant` }, "captcha-observed"),
    ).rejects.toThrow(/showed a captcha in this task/);
    expect(site.posted).toEqual([]);
  }, 60_000);
});

describe("staging a booking on TheFork's profile", () => {
  type Page = {
    readonly epoch: number;
    readonly elements: readonly { readonly ref: string; readonly text?: string; readonly finalStep?: true }[];
  };
  const refOf = (page: Page, text: string): string => page.elements.find((element) => element.text === text)?.ref ?? `(no ${text})`;

  it("fills the booking's fields and stops before Confirm booking: nothing posted", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("book");
    const page = (await call("browser.navigate", { sessionId: id, url: `${on("fork.localhost")}/book` }, "book")) as Page;
    await call("browser.act", { sessionId: id, ref: refOf(page, "Name"), epoch: page.epoch, kind: "type", value: "Ada Lovelace" }, "book");
    await call("browser.act", { sessionId: id, ref: refOf(page, "Party size"), epoch: page.epoch, kind: "type", value: "2" }, "book");
    const observed = (await call("browser.observe", { sessionId: id }, "book")) as Page;
    expect(observed.elements.find((element) => element.text === "Confirm booking")).toMatchObject({ finalStep: true });
    await expect(
      call("browser.act", { sessionId: id, ref: refOf(observed, "Confirm booking"), epoch: observed.epoch, kind: "click" }, "book", false, {
        assessedSubjects: ["confirm"],
      }),
    ).rejects.toMatchObject({ details: { guard: "final-step" } });
    // With no confirmation observed after it, the receipt check says staged, and proposes only a hold.
    const home = homes.create("tavi-places-receipt-");
    const places = createEngine({
      storePath: join(home, "places.db"),
      fetcher: async () => ({ status: 404, retryAfter: null, body: null, bytes: 0 }),
      openParquet: async () => {
        throw new Error("no network");
      },
      config: {},
      version: "test",
      siteProfiles: [shipped("thefork", "fork.localhost").profile],
    });
    try {
      expect(
        places.bookingStatus({
          place: "Fixture Bistro",
          staged: { url: `${on("fork.localhost")}/book`, slot: "2099-10-18T20:00:00+02:00", partySize: 2 },
        }),
      ).toMatchObject({
        status: "staged",
        say: expect.stringMatching(/^Staged: you were handed the confirm step/),
        calendarHold: { title: "HOLD (not booked): Fixture Bistro" },
      });
    } finally {
      places.close();
    }
    // The refusal names a booking, not an application.
    expect(
      registry
        .get("browser.act")
        ?.assess?.({ sessionId: id, ref: refOf(observed, "Confirm booking"), epoch: observed.epoch, kind: "click" }, {
          workspaceId: "default",
          principalId: "operator",
          runId: "book",
          caller: "test",
        } as never)?.hardDeny,
    ).toMatch(/form's or booking's last step/);
    expect(site.posted).toEqual([]);
  }, 60_000);

  it("leaves a clinic's medical intake to the person: typing a medical history or checking a health declaration is refused", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("clinic");
    const page = (await call("browser.navigate", { sessionId: id, url: `${on("clinic.localhost")}/clinic` }, "clinic")) as Page;
    await call(
      "browser.act",
      { sessionId: id, ref: refOf(page, "Name"), epoch: page.epoch, kind: "type", value: "Ada Lovelace" },
      "clinic",
    );
    await expect(
      call("browser.act", { sessionId: id, ref: refOf(page, "Medical history"), epoch: page.epoch, kind: "type", value: "none" }, "clinic"),
    ).rejects.toMatchObject({ details: { protected: "medical-intake" } });
    const declaration = page.elements.find((element) => element.text?.startsWith("Health declaration") === true)?.ref ?? "(no declaration)";
    await expect(
      call("browser.act", { sessionId: id, ref: declaration, epoch: page.epoch, kind: "click" }, "clinic"),
    ).rejects.toMatchObject({ details: { protected: "medical-intake" } });
    expect(site.posted).toEqual([]);
  }, 60_000);
});
