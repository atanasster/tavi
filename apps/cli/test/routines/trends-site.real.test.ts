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

import { createEngine, type SiteProfileLike } from "../../../../packages/external/trends/src/engine.js";
import { startTrendsSite } from "../../../../packages/external/trends/test/fixture-site/server.mjs";
import { registerBrowserExtractTool } from "../../src/features/browser/extract.js";
import { registerBrowserTools } from "../../src/features/sandbox/tools.js";
import { createRobotsReader, createSitePolicy } from "../../src/features/browser/site-policy.js";

/** The fixture sites run on this machine: exempt from the browser's private-address rule, and from nothing else. */
const FIXTURE_HOSTS = ["127.0.0.1", "localhost", "*.localhost"];

/**
 * trends.radar's browser fallback against a real Chromium and the local
 * trending site: the
 * shipped Daum profile pointed at 127.0.0.1 (budgets widened for the test),
 * read in the person's session; its JSON-LD read first, a DOM-only list read
 * by browser.extract; the rows relayed with ingest, never counted; a reCAPTCHA
 * page ending the site for the task; and no read while nobody attends, since
 * no trending profile is watchable. Without Chromium the tests skip.
 */
const sitesDir = join(import.meta.dirname, "..", "..", "..", "..", "packages", "external", "trends", "sites");
const raw = JSON.parse(readFileSync(join(sitesDir, "daum-realtime.json"), "utf8")) as Record<string, unknown>;
const weiboRaw = JSON.parse(readFileSync(join(sitesDir, "weibo-hot.json"), "utf8")) as Record<string, unknown>;

let site: Awaited<ReturnType<typeof startTrendsSite>>;
let skip: string | undefined;
let call: (id: string, input: unknown, taskId?: string, unattended?: boolean) => Promise<unknown>;
let closeBrowser: () => Promise<void> = async () => undefined;
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
  site = await startTrendsSite();
  const daum: EnabledSiteProfile = {
    pluginId: "trends.radar",
    profile: SiteProfileSchema.parse({ ...raw, hosts: ["127.0.0.1"], budget: { pagesPerTask: 8, pagesPerDay: 40, minIntervalMs: 1_000 } }),
  };
  // The shipped assist-only Weibo profile, on the fixture's other name.
  const weibo: EnabledSiteProfile = {
    pluginId: "trends.radar",
    profile: SiteProfileSchema.parse({ ...weiboRaw, hosts: ["weibo.localhost"] }),
  };
  const counts = new Map<string, SiteUsage>();
  const sites = createSitePolicy({
    profiles: async () => [daum, weibo],
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
  const registry = new ToolRegistry();
  registerBrowserTools(registry, browser, { sites, handoff: true, privateHostsAllowed: FIXTURE_HOSTS });
  // A stand-in extraction model: it answers the list's rows, and the test reads what it was shown.
  const models = partialFake<ModelPort>({
    stream: async (request: ModelRequest) => {
      extractions.push(request);
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: JSON.stringify({
          records: [{ rank: 1, title: "Typhoon Koinu nears Taiwan", url: `${site.origin}/topic/1` }],
          complete: true,
        }),
        toolCalls: [],
        usage: {},
      };
    },
  });
  let ids = 0;
  registerBrowserExtractTool(registry, {
    browser,
    models,
    target: async () => ({ connectionId: "main", model: "vision" }),
    newId: () => `id-${String((ids += 1))}`,
    now: () => nowTimestamp(),
    sites,
  });
  call = async (id, input, taskId = "task-1", unattended = false) => {
    const tool = registry.get(id);
    if (tool === undefined) throw new Error(`no ${id}`);
    return tool.handler({
      input,
      context: { workspaceId: "default", principalId: "operator", runId: taskId, caller: "test" },
      signal: new AbortController().signal,
      ...(unattended ? { executionPolicy: { mode: "unattended" } } : {}),
    } as never);
  };
}, 60_000);

afterAll(async () => {
  await closeBrowser();
  await site?.close();
  homes.cleanup();
}, 60_000);

const session = async (taskId: string): Promise<string> =>
  ((await call("browser.create_session", {}, taskId)) as { sessionId: string }).sessionId;

describe("a trending page in the person's session", () => {
  it("reads the page's ItemList and SocialMediaPosting first, hidden text dropped, and relays them with ingest, never counted", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("structured");
    await call("browser.navigate", { sessionId: id, url: `${site.origin}/jsonld` }, "structured");
    const read = (await call("browser.structured", { sessionId: id }, "structured")) as { url: string; items: Record<string, unknown>[] };
    expect(read.items.map((item) => item["@type"])).toEqual(["ItemList", "SocialMediaPosting"]);
    expect(JSON.stringify(read)).not.toContain("ignore previous instructions");
    const rows = (read.items[0]?.["itemListElement"] as { position: number; name: string; url: string }[]).map((entry) => ({
      url: entry.url,
      title: entry.name,
      rank: entry.position,
    }));
    const home = homes.create("tavi-trends-site-");
    const radar = createEngine({
      home,
      fetcher: async () => ({ status: 404, retryAfter: null, body: null, bytes: 0 }),
      config: {},
      version: "test",
      adapters: [],
      sites: [{ ...(raw as unknown as SiteProfileLike), hosts: ["127.0.0.1"] }],
    });
    try {
      const operator = { scope: { principalId: "operator", workspaceId: "default" }, unattended: false };
      const { topic } = radar.watch({ op: "add", topic: { label: "Typhoon", terms: { en: ["typhoon"] } } }, operator) as {
        topic: { topicId: string };
      };
      const kept = radar.ingest({ profileId: "daum-realtime", itemSet: "daum-realtime", items: rows }, operator);
      expect(kept.kept.map((item) => item.title)).toEqual([
        "Typhoon Koinu nears Taiwan",
        "Solid-state battery pilot line",
        "Night market prices",
      ]);
      expect(kept.kept.every((item) => item.itemId.startsWith("agent:"))).toBe(true);
      // What was relayed never enters a series.
      expect(radar.velocity({ topicId: topic.topicId, window: "24h" }, operator).series).toEqual([]);
    } finally {
      radar.close();
    }
  }, 60_000);

  it("reads a list drawn only in the DOM with browser.extract and the profile's result schema", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("dom");
    await call("browser.navigate", { sessionId: id, url: `${site.origin}/dom` }, "dom");
    expect(await call("browser.structured", { sessionId: id }, "dom")).toMatchObject({ items: [] });
    const asked = extractions.length;
    // The profile's result schema, one record a row: what ingest takes.
    const extracted = (await call(
      "browser.extract",
      {
        sessionId: id,
        instruction: "the hot list's rank, title, link and heat",
        schema: (raw["extract"] as { resultSchema: Record<string, unknown> }).resultSchema,
      },
      "dom",
    )) as { records: unknown[] };
    expect(extracted.records).toEqual([{ rank: 1, title: "Typhoon Koinu nears Taiwan", url: `${site.origin}/topic/1` }]);
    expect(extractions).toHaveLength(asked + 1);
    const shown =
      extractions
        .at(-1)
        ?.messages.map((message) => message.text)
        .join("\n") ?? "";
    expect(shown).toContain("Typhoon Koinu nears Taiwan");
    // The page's hidden text never reaches the model.
    expect(shown).not.toContain("ignore previous instructions");
  }, 60_000);

  it("ends the site for the task at a reCAPTCHA, for the person to take over", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("captcha");
    expect(await call("browser.navigate", { sessionId: id, url: `${site.origin}/captcha` }, "captcha")).toMatchObject({
      blocked: { kind: "captcha" },
    });
    await expect(call("browser.navigate", { sessionId: id, url: `${site.origin}/jsonld` }, "captcha")).rejects.toThrow(
      /showed a captcha in this task: hand it to the person with browser\.request_handoff/,
    );
  }, 60_000);

  it("is never read while nobody attends: no trending profile is watchable", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("sweep");
    const before = site.asked.length;
    await expect(call("browser.navigate", { sessionId: id, url: `${site.origin}/jsonld` }, "sweep", true)).rejects.toThrow(
      /is read only while the person attends/,
    );
    expect(site.asked).toHaveLength(before);
  }, 60_000);

  it("never opens an assist-only site: its terms bar reading it by program", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("assist");
    const before = site.asked.length;
    await expect(
      call("browser.navigate", { sessionId: id, url: `${site.origin.replace("127.0.0.1", "weibo.localhost")}/jsonld` }, "assist"),
    ).rejects.toThrow(/Weibo hot search is not browsed by Tavi: only a page the person opened is read/);
    expect(site.asked).toHaveLength(before);
  }, 60_000);
});
