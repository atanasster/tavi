import { tmpdir } from "node:os";
import { SiteProfileSchema, TaviError, type EnabledSiteProfile, type ModelPort, type ModelRequest, type SiteUsage } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { createPlaywrightBrowser } from "@tavi/plugin-browser/playwright";
import { createInMemoryArtifactRepository } from "@tavi/test-support/fakes";
import { ToolRegistry } from "@tavi/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { partialFake, delay } from "@tavi/test-support";

import { startJobsSite } from "../../../../packages/external/jobs/test/fixtures/site/server.mjs";
import { registerBrowserExtractTool } from "../../src/features/browser/extract.js";
import { registerBrowserVisionTool } from "../../src/features/browser/vision.js";
import { registerBrowserTools } from "../../src/features/sandbox/tools.js";
import { createRobotsReader, createSitePolicy } from "../../src/features/browser/site-policy.js";

/** The fixture sites run on this machine: exempt from the browser's private-address rule, and from nothing else. */
const FIXTURE_HOSTS = ["127.0.0.1", "localhost", "*.localhost"];

/**
 * The job board's browser rules against a real Chromium and the local job
 * board. The board is two profiles: `127.0.0.1` is read
 * and watchable, `person.localhost` (Chromium resolves it to the same loopback) is never browsed by Tavi. Without Chromium the
 * tests skip.
 */
const profile = (id: string, host: string, access: Record<string, unknown>): EnabledSiteProfile => ({
  pluginId: "jobs.finder",
  profile: SiteProfileSchema.parse({
    abi: "tavi.sites/1",
    id,
    name: id,
    countries: ["*"],
    hosts: [host],
    kind: "jobs-board",
    access: { reason: "fixture", termsUrl: "https://example.com/terms", reviewedAt: "2026-10-17", ...access },
    budget: { pagesPerTask: 3, pagesPerDay: 4, minIntervalMs: 1_000 },
    extract: { jsonLdTypes: ["JobPosting"] },
    notes: "",
  }),
});

let site: Awaited<ReturnType<typeof startJobsSite>>;
let skip: string | undefined;
let call: (id: string, input: unknown, taskId?: string, unattended?: boolean) => Promise<unknown>;
let personOpens: (sessionId: string, url: string) => Promise<unknown>;
let closeBrowser: () => Promise<void> = async () => undefined;
/** What the extraction model was asked: the page's text, when it ran. */
const extractions: ModelRequest[] = [];

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
  site = await startJobsSite();
  const counts = new Map<string, SiteUsage>();
  const sites = createSitePolicy({
    profiles: async () => [
      profile("board", "127.0.0.1", { mode: "read", watchable: true }),
      profile("person-only", "person.localhost", { mode: "assist-only", navigate: false }),
      profile("blocks", "blocks.localhost", { mode: "read" }),
      profile("checks", "checks.localhost", { mode: "read" }),
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
  const registry = new ToolRegistry();
  const tools = registerBrowserTools(registry, browser, { sites, handoff: true, privateHostsAllowed: FIXTURE_HOSTS });
  // A stand-in extraction model: it answers one record, and the test reads what it was shown.
  const models = partialFake<ModelPort>({
    stream: async (request: ModelRequest) => {
      extractions.push(request);
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: '{"records":[{"title":"Prep Cook","company":"Fixture Kitchen"}],"complete":true}',
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
  // What a person does in the live view: their own navigation, not a tool's.
  personOpens = (sessionId, url) => browser.navigate(sessionId, url);
}, 60_000);

afterAll(async () => {
  await closeBrowser();
  await site?.close();
});

const session = async (taskId = "task-1"): Promise<string> =>
  ((await call("browser.create_session", {}, taskId)) as { sessionId: string }).sessionId;

describe("a profiled job board in a real browser", () => {
  it("reads at most pagesPerTask pages a task and pagesPerDay across tasks, at least minIntervalMs apart", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const first = await session("budget-a");
    const started = Date.now();
    for (const page of [1, 2, 3])
      await call("browser.navigate", { sessionId: first, url: `${site.origin}/search?page=${page}` }, "budget-a");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    await expect(call("browser.navigate", { sessionId: first, url: `${site.origin}/search?page=4` }, "budget-a")).rejects.toMatchObject({
      details: { budgetExhausted: true },
    });
    const second = await session("budget-b");
    await call("browser.navigate", { sessionId: second, url: `${site.origin}/search?page=5` }, "budget-b");
    await expect(call("browser.navigate", { sessionId: second, url: `${site.origin}/search?page=6` }, "budget-b")).rejects.toThrow(
      /4 pages for today are used/,
    );
    expect(site.asked.filter((path) => path.startsWith("/search"))).toEqual([
      "/search?page=1",
      "/search?page=2",
      "/search?page=3",
      "/search?page=5",
    ]);
  }, 60_000);
});

describe("structured data and the person's pages", () => {
  // The day's four pages on 127.0.0.1 are spent above: these read pages a person opened, or the other host.
  it("reads a posting's JSON-LD with its hidden injected line dropped, and finds none on a page with only its DOM", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("structured");
    await personOpens(id, `${site.origin}/injected`);
    const injected = (await call("browser.structured", { sessionId: id }, "structured")) as {
      items: { title: string; description: string }[];
    };
    expect(injected.items).toEqual([
      expect.objectContaining({ "@type": "JobPosting", title: "Line Cook injected", description: "Prep and cook on the line." }),
    ]);
    expect(JSON.stringify(injected)).not.toContain("passport");
    await personOpens(id, `${site.origin}/dom-job`);
    // Nothing structured: the agent goes on to browser.extract on a site it may browse.
    expect(await call("browser.structured", { sessionId: id }, "structured")).toMatchObject({
      items: [],
      notes: expect.stringMatching(/no structured data/),
    });
    expect(
      await call("browser.extract", { sessionId: id, instruction: "the posting: title, company", kind: "job" }, "structured"),
    ).toMatchObject({ records: [{ title: "Prep Cook", company: "Fixture Kitchen" }] });
    expect(
      extractions
        .at(-1)
        ?.messages.map((message) => message.text)
        .join("\n"),
    ).toContain("Prep vegetables and sauces");
  }, 60_000);

  it("never navigates a navigate: false host, nor acts there; a page the person opened is read with browser.structured", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const id = await session("person");
    const elsewhere = site.origin.replace("127.0.0.1", "person.localhost");
    await expect(call("browser.navigate", { sessionId: id, url: `${elsewhere}/jobs/2` }, "person")).rejects.toThrow(
      /only a page the person opened is read/,
    );
    expect(site.asked).not.toContain("/jobs/2");
    await personOpens(id, `${elsewhere}/jobs/2`);
    expect(await call("browser.structured", { sessionId: id }, "person")).toMatchObject({
      items: [expect.objectContaining({ title: "Line Cook 2" })],
    });
    await expect(call("browser.act", { sessionId: id, kind: "scroll" }, "person")).rejects.toThrow(/browser.act is refused/);
    // Nor extracts or acts by sight there: neither reaches its model.
    const asked = extractions.length;
    await expect(call("browser.extract", { sessionId: id, instruction: "the posting" }, "person")).rejects.toThrow(/refused/);
    await expect(call("browser.vision_act", { sessionId: id, instruction: "scroll down" }, "person")).rejects.toThrow(/refused/);
    expect(extractions).toHaveLength(asked);
  }, 60_000);
});

describe("unattended reads and blocks", () => {
  it("reads a watchable board unattended only where robots.txt allows", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    // A fresh day's budget is not needed: each refusal here comes before a page is counted.
    const id = await session("sweep");
    await expect(call("browser.navigate", { sessionId: id, url: `${site.origin}/private-search?page=1` }, "sweep", true)).rejects.toThrow(
      /robots.txt disallows \/private-search/,
    );
    expect(site.asked).toContain("/robots.txt");
    expect(site.asked).not.toContain("/private-search?page=1");
  }, 60_000);

  it("ends a site for the task at a robot check or a 429, and not at a sign-in page", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const blocks = site.origin.replace("127.0.0.1", "blocks.localhost");
    const robot = await session("blocks-a");
    expect(await call("browser.navigate", { sessionId: robot, url: `${blocks}/robot` }, "blocks-a")).toMatchObject({
      blocked: { kind: "bot-wall" },
    });
    await expect(call("browser.navigate", { sessionId: robot, url: `${blocks}/jobs/3` }, "blocks-a")).rejects.toThrow(
      /showed a bot-wall in this task.*request_handoff/,
    );
    const signIn = await session("blocks-b");
    expect(await call("browser.navigate", { sessionId: signIn, url: `${blocks}/login` }, "blocks-b")).toMatchObject({
      blocked: { kind: "login" },
    });
    await expect(call("browser.navigate", { sessionId: signIn, url: `${blocks}/jobs/3` }, "blocks-b")).resolves.toMatchObject({
      url: `${blocks}/jobs/3`,
    });
    const limited = await session("blocks-c");
    expect(await call("browser.navigate", { sessionId: limited, url: `${blocks}/limited` }, "blocks-c")).toMatchObject({
      blocked: { kind: "rate-limit" },
    });
    await expect(call("browser.navigate", { sessionId: limited, url: `${blocks}/jobs/4` }, "blocks-c")).rejects.toThrow(
      /showed a rate-limit/,
    );
  }, 60_000);

  it("ends a site for the task at a human check, raising a handoff, with nothing typed into it", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const checks = site.origin.replace("127.0.0.1", "checks.localhost");
    const checked = await session("blocks-d");
    expect(await call("browser.navigate", { sessionId: checked, url: `${checks}/captcha` }, "blocks-d")).toMatchObject({
      blocked: { kind: "captcha", hint: expect.stringMatching(/browser.request_handoff/) },
    });
    const challenge = (await call("browser.observe", { sessionId: checked }, "blocks-d")) as {
      epoch: number;
      elements: { ref: string; text?: string }[];
    };
    const answer = challenge.elements.find((element) => element.text === "Answer")?.ref ?? "(no answer field)";
    await expect(
      call("browser.act", { sessionId: checked, ref: answer, epoch: challenge.epoch, kind: "type", value: "x" }, "blocks-d"),
    ).rejects.toThrow(/showed a captcha in this task/);
    expect(site.posted).toEqual([]);
  }, 60_000);
});
