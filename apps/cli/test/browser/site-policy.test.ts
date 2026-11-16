import { SiteProfileSchema, type BrowserPort, type EnabledSiteProfile, type SiteUsage } from "@tavi/contracts";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { ToolRegistry, pinnedFetch } from "@tavi/runtime";
import { describe, expect, it } from "vitest";

import { browserWorkerUses } from "../../src/features/agents/builtin.js";
import { registerBrowserTools } from "../../src/features/sandbox/tools.js";
import { createRobotsReader, createSitePolicy, enabledSiteProfiles, keepingFindings } from "../../src/features/browser/site-policy.js";

/** The site profiles' rules, in the policy and in the browser tools. */
const profile = (
  id: string,
  hosts: string[],
  access: Record<string, unknown>,
  budget: Record<string, unknown> = {},
  extract?: { jsonLdTypes: string[] },
): EnabledSiteProfile => ({
  pluginId: "acme.jobs",
  profile: SiteProfileSchema.parse({
    abi: "tavi.sites/1",
    id,
    name: id,
    countries: ["*"],
    hosts,
    kind: "jobs-board",
    access: { reason: "fixture", termsUrl: "https://example.com/terms", reviewedAt: "2026-10-17", ...access },
    budget,
    notes: "",
    ...(extract === undefined ? {} : { extract }),
  }),
});
const BOARD = profile(
  "board",
  ["board.example"],
  { mode: "read", watchable: true },
  { pagesPerTask: 2, pagesPerDay: 3, minIntervalMs: 2_000 },
  { jsonLdTypes: ["JobPosting"] },
);
const LINKED = profile("linked", ["linked.example"], { mode: "assist-only", navigate: false });
const ASSIST = profile("assist", ["assist.example"], { mode: "assist-only" });
const STAGE: EnabledSiteProfile = {
  pluginId: "acme.jobs",
  profile: SiteProfileSchema.parse({
    abi: "tavi.sites/1",
    id: "ats",
    name: "ATS",
    countries: ["*"],
    hosts: ["ats.example"],
    kind: "ats",
    access: { mode: "stage", reason: "fixture", termsUrl: "https://example.com/terms", reviewedAt: "2026-10-17" },
    stage: { fillable: ["email"], finalStep: { labels: ["Submit application"] }, perDay: 2 },
    notes: "",
  }),
};

function policy(options: { readonly robots?: string; readonly profiles?: readonly EnabledSiteProfile[] } = {}) {
  const clock = { ms: Date.parse("2026-10-17T10:00:00.000Z") };
  const counts = new Map<string, SiteUsage>();
  const slept: number[] = [];
  const sites = createSitePolicy({
    profiles: async () => options.profiles ?? [BOARD, LINKED, ASSIST],
    usage: {
      take: async ({ workspaceId, profile: key, day, counter, limit }) => {
        const at = `${workspaceId}|${key}|${day}`;
        const known = counts.get(at) ?? { pages: 0, finalSteps: 0 };
        if (known[counter] >= limit) return { ok: false, usage: known };
        const next = { ...known, [counter]: known[counter] + 1 };
        counts.set(at, next);
        return { ok: true, usage: next };
      },
      get: async (workspaceId, key, day) => counts.get(`${workspaceId}|${key}|${day}`) ?? { pages: 0, finalSteps: 0 },
    },
    robots: async () => (options.robots === undefined ? { none: true } : { text: options.robots }),
    now: () => clock.ms,
    sleep: async (ms) => {
      slept.push(ms);
      clock.ms += ms;
    },
  });
  return { sites, clock, slept };
}
const signal = new AbortController().signal;
const open = (url: string, taskId = "t1", unattended = false) => ({ workspaceId: "w1", taskId, url, unattended, signal });

describe("the site policy", () => {
  it("keeps a profile's pages per task and per day, a courtesy interval apart", async () => {
    const { sites, slept } = policy();
    expect(await sites.beforeNavigate(open("https://board.example/a"))).toBeUndefined();
    expect(await sites.beforeNavigate(open("https://board.example/b"))).toBeUndefined();
    expect(slept).toEqual([2_000]);
    expect(await sites.beforeNavigate(open("https://board.example/c"))).toMatchObject({
      budgetExhausted: true,
      refused: expect.stringMatching(/2 pages for this task/),
    });
    // Another task: the day's third page, then the day is spent.
    expect(await sites.beforeNavigate(open("https://board.example/d", "t2"))).toBeUndefined();
    expect(await sites.beforeNavigate(open("https://board.example/e", "t2"))).toMatchObject({
      budgetExhausted: true,
      resetsAt: "2026-10-18T00:00:00.000Z",
    });
    // A host no profile names keeps today's rules.
    expect(await sites.beforeNavigate(open("https://other.example/"))).toBeUndefined();
  });

  it("never navigates to a navigate: false host, nor acts, extracts or acts by sight on its pages", async () => {
    const { sites } = policy();
    expect((await sites.beforeNavigate(open("https://linked.example/jobs")))?.refused).toMatch(/only a page the person opened is read/);
    for (const tool of ["act", "extract", "vision_act"] as const)
      expect((await sites.refuseOnPage({ taskId: "t1", url: "https://linked.example/jobs/1", tool }))?.refused).toMatch(
        new RegExp(`browser.${tool} is refused`),
      );
    expect(await sites.readOnlyForTurn("https://linked.example/jobs/1")).toBe(true);
    expect(await sites.readOnlyForTurn("https://assist.example/x")).toBe(true);
    expect(await sites.readOnlyForTurn("https://board.example/x")).toBe(false);
  });

  it("reads unattended only a watchable profile, on a path its robots.txt allows", async () => {
    expect((await policy().sites.beforeNavigate(open("https://assist.example/x", "t1", true)))?.refused).toMatch(
      /only while the person attends/,
    );
    const robots = "User-agent: *\nDisallow: /private-search\n";
    const { sites } = policy({ robots });
    expect((await sites.beforeNavigate(open("https://board.example/private-search?q=x", "t1", true)))?.refused).toMatch(
      /robots.txt disallows \/private-search/,
    );
    expect(await sites.beforeNavigate(open("https://board.example/jobs/1", "t1", true))).toBeUndefined();
    // Attended, the person's own read is not a crawl.
    expect(await sites.beforeNavigate(open("https://board.example/private-search", "t3"))).toBeUndefined();
  });

  it("does not watch a board whose robots.txt disallows the profile's own search path (rule 9)", async () => {
    const searching: EnabledSiteProfile = {
      ...BOARD,
      profile: { ...BOARD.profile, search: { urlTemplate: "/private-search?q={keywords}", params: ["keywords"] } },
    };
    const { sites } = policy({ robots: "User-agent: *\nDisallow: /private-search\n", profiles: [searching] });
    expect((await sites.beforeNavigate(open("https://board.example/jobs/1", "t1", true)))?.refused).toMatch(
      /disallows its search \(\/private-search\)/,
    );
    // Attended, it is read as before.
    expect(await sites.beforeNavigate(open("https://board.example/jobs/1", "t2"))).toBeUndefined();
  });

  it("ends a site for the task at a captcha, bot wall or rate limit, and not at a sign-in", async () => {
    const { sites } = policy();
    await sites.blocked({ taskId: "t1", url: "https://board.example/a", kind: "login" });
    expect(await sites.beforeNavigate(open("https://board.example/a"))).toBeUndefined();
    await sites.blocked({ taskId: "t1", url: "https://board.example/a", kind: "captcha" });
    expect((await sites.beforeNavigate(open("https://board.example/b")))?.refused).toMatch(
      /showed a captcha in this task.*request_handoff/,
    );
    expect((await sites.refuseOnPage({ taskId: "t1", url: "https://board.example/b", tool: "act" }))?.refused).toMatch(/captcha/);
    // Another task starts afresh.
    expect(await sites.beforeNavigate(open("https://board.example/b", "t2"))).toBeUndefined();
  });

  it("opens a profile's own hosts without the operator's allowlist, and nothing wider", async () => {
    const { sites } = policy();
    await sites.refresh();
    expect(sites.allowsDestinationNow("https://board.example/x")).toBe(true);
    expect(sites.allowsDestinationNow("https://linked.example/x")).toBe(false);
    expect(sites.allowsDestinationNow("https://other.example/x")).toBe(false);
  });
});

describe("the policy's helpers", () => {
  it("reads robots.txt as RFC 9309 asks, following a redirect only within the site, and only so much of it", async () => {
    const answers: Record<string, Response> = {
      "https://a.example/robots.txt": new Response("", { status: 301, headers: { location: "/real-robots.txt" } }),
      "https://a.example/real-robots.txt": new Response("User-agent: *\nDisallow: /x\n"),
      "https://b.example/robots.txt": new Response("", { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } }),
      "https://c.example/robots.txt": new Response("gone", { status: 404 }),
      "https://d.example/robots.txt": new Response("down", { status: 503 }),
      "https://e.example/robots.txt": new Response("a".repeat(600 * 1024)),
    };
    const asked: string[] = [];
    const read = createRobotsReader((async (url: string) => {
      asked.push(url);
      return answers[url] ?? new Response("", { status: 500 });
    }) as typeof fetch);
    expect(await read("https://a.example", signal)).toEqual({ text: "User-agent: *\nDisallow: /x\n" });
    expect(await read("https://b.example", signal)).toEqual({ unreadable: true });
    expect(asked).not.toContain("http://127.0.0.1:8080/admin");
    expect(await read("https://c.example", signal)).toEqual({ none: true });
    expect(await read("https://d.example", signal)).toEqual({ unreadable: true });
    const long = await read("https://e.example", signal);
    expect("text" in long ? long.text.length : 0).toBe(512 * 1024);
  });

  it("reads robots.txt through the pinned fetch, so a site's name resolved to a private address is unreadable", async () => {
    const asked: string[] = [];
    const read = createRobotsReader(
      pinnedFetch({
        resolve: async (hostname) => {
          asked.push(hostname);
          return ["10.0.0.5"];
        },
      }),
    );
    expect(await read("https://board.example", signal)).toEqual({ unreadable: true });
    expect(asked).toEqual(["board.example"]);
  });

  it("disallows a robots.txt it could not read, and tries again after an hour", async () => {
    let answer: { readonly text: string } | { readonly unreadable: true } = { unreadable: true };
    let asked = 0;
    const clock = { ms: 0 };
    const sites = createSitePolicy({
      profiles: async () => [BOARD],
      usage: { take: async () => ({ ok: true, usage: { pages: 1, finalSteps: 0 } }), get: async () => ({ pages: 0, finalSteps: 0 }) },
      robots: async () => (asked++, answer),
      now: () => clock.ms,
      sleep: async () => undefined,
    });
    expect((await sites.beforeNavigate(open("https://board.example/jobs", "t1", true)))?.refused).toMatch(/robots.txt disallows/);
    answer = { text: "User-agent: *\nAllow: /\n" };
    clock.ms += 30 * 60_000;
    expect((await sites.beforeNavigate(open("https://board.example/jobs", "t2", true)))?.refused).toMatch(/robots.txt disallows/);
    clock.ms += 31 * 60_000;
    expect(await sites.beforeNavigate(open("https://board.example/jobs", "t3", true))).toBeUndefined();
    expect(asked).toBe(2);
  });

  it("reads the profiles the operator turned on, of plugins still running, once a version", async () => {
    let reads = 0;
    const withdrawn = new Set<string>();
    const on = { "acme.jobs": ["board"] };
    const manifest = {} as never;
    const plugins = [
      { pluginId: "acme.jobs", version: "1.0.0", directory: "/d", manifest },
      { pluginId: "other.app", version: "1.0.0", directory: "/o", manifest },
    ];
    const profiles = enabledSiteProfiles({
      plugins: () => plugins,
      withdrawn: () => withdrawn,
      sitesOn: async () => on,
      read: () => (reads++, [BOARD.profile, LINKED.profile]),
    });
    expect((await profiles()).map((entry) => `${entry.pluginId}/${entry.profile.id}`)).toEqual(["acme.jobs/board"]);
    await profiles();
    expect(reads).toBe(1);
    withdrawn.add("acme.jobs");
    expect(await profiles()).toEqual([]);
  });

  it("keeps no finding from a site read for the chat only", async () => {
    const added: unknown[] = [];
    const findings = keepingFindings({ add: async (input) => (added.push(input), []), list: async () => [] }, policy().sites);
    await findings.add({
      taskId: "t",
      workspaceId: "w",
      kind: "job",
      records: [{}],
      sourceUrl: "https://assist.example/x",
      createdAt: "now",
    });
    await findings.add({
      taskId: "t",
      workspaceId: "w",
      kind: "job",
      records: [{}],
      sourceUrl: "https://board.example/x",
      createdAt: "now",
    });
    expect(added).toHaveLength(1);
  });

  it("holds a page a click reached to the profile's rules, counted with no wait", async () => {
    const { sites, slept } = policy();
    const reached = (from: string | undefined, url: string | undefined, taskId = "t1") =>
      sites.pageReached({ workspaceId: "w1", taskId, from, url, unattended: false, signal });
    expect(await reached("https://board.example/a", "https://board.example/a")).toBeUndefined();
    expect(await reached("https://other.example/", "https://linked.example/jobs")).toMatchObject({
      refused: expect.stringMatching(/only a page the person opened/),
    });
    expect(await reached("https://board.example/a", "https://board.example/b")).toBeUndefined();
    expect(await reached("https://board.example/b", "https://board.example/c")).toBeUndefined();
    expect(await reached("https://board.example/c", "https://board.example/d")).toMatchObject({ budgetExhausted: true });
    expect(slept).toEqual([]);
  });
});

describe("stop before confirm", () => {
  it("counts a final step reached once per session and page, and refuses the stage site once its day's are used", async () => {
    const { sites } = policy({ profiles: [STAGE] });
    expect(sites.finalStepRuleNow("https://ats.example/apply")).toBeUndefined();
    await sites.refresh();
    expect(sites.finalStepRuleNow("https://ats.example/apply")).toEqual({ labels: ["Submit application"], urlPatterns: [] });
    const reached = (sessionId: string, url: string) => sites.finalStepReached({ workspaceId: "w1", sessionId, url });
    await reached("s1", "https://ats.example/apply/1/review");
    await reached("s1", "https://ats.example/apply/1/review");
    expect(await sites.stageRefusal({ workspaceId: "w1", url: "https://ats.example/apply/2" })).toBeUndefined();
    await reached("s2", "https://ats.example/apply/2/review");
    expect(await sites.stageRefusal({ workspaceId: "w1", url: "https://ats.example/apply/3" })).toMatchObject({
      budgetExhausted: true,
      refused: expect.stringMatching(/2 staged forms or bookings for today/),
    });
    expect(await sites.stageRefusal({ workspaceId: "w1", url: "https://other.example/" })).toBeUndefined();
  });
});

describe("the site rules in the browser tools", () => {
  const context = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };
  async function tools(extra: Partial<BrowserPort> | ((base: BrowserPort) => Partial<BrowserPort>) = {}) {
    const registry = new ToolRegistry();
    const { sites } = policy();
    await sites.refresh();
    const base = createFixtureBrowser({
      pages: {
        "https://assist.example/s": [
          { ref: "q", role: "searchbox" },
          { ref: "f", role: "textbox" },
          { ref: "send", role: "button", text: "Send application" },
          { ref: "more", role: "button", text: "Show more jobs" },
          { ref: "icon", role: "button", submitsForm: true },
          { ref: "weiter", role: "button", text: "Weiter", submitsForm: true },
          { ref: "go", role: "button", text: "Search", submitsForm: true, searchForm: true },
          { ref: "country", role: "combobox", text: "Country", inForm: true },
        ],
      },
    });
    const browser = { ...base, ...(typeof extra === "function" ? extra(base) : extra) };
    registerBrowserTools(registry, browser, { sites });
    const call = async (id: string, input: unknown, executionPolicy?: { readonly mode: "unattended" }) => {
      const tool = registry.get(id);
      if (tool === undefined) throw new Error(`no ${id}`);
      return tool.handler({ input, context, signal, ...(executionPolicy === undefined ? {} : { executionPolicy }) } as never);
    };
    const session = (await call("browser.create_session", {})) as { sessionId: string };
    return { call, sessionId: session.sessionId, registry };
  }

  it("navigates to an enabled profile's host though the allowlist is empty, and refuses a navigate: false one", async () => {
    const { call, sessionId } = await tools();
    await expect(call("browser.navigate", { sessionId, url: "https://board.example/jobs" })).resolves.toMatchObject({
      url: "https://board.example/jobs",
    });
    await expect(call("browser.navigate", { sessionId, url: "https://linked.example/jobs" })).rejects.toThrow(
      /only a page the person opened is read/,
    );
    await expect(call("browser.navigate", { sessionId, url: "https://other.example/" })).rejects.toThrow(/no allowed destinations/);
    await expect(call("browser.navigate", { sessionId, url: "https://assist.example/" }, { mode: "unattended" })).rejects.toThrow(
      /only while the person attends/,
    );
  });

  it("ends the site for the task at a block an observation or a read sees (rule 11)", async () => {
    for (const tool of ["browser.observe", "browser.read"] as const) {
      const blockedAs = <T extends object>(page: T) => ({ ...page, url: "https://board.example/jobs", blocked: { kind: "captcha" } });
      const { call, sessionId } = await tools((fixture) =>
        tool === "browser.observe"
          ? { observe: async (id, options) => blockedAs(await fixture.observe(id, options)) }
          : { read: async (id, offset) => blockedAs(await fixture.read(id, offset)) },
      );
      await call("browser.navigate", { sessionId, url: "https://board.example/jobs" });
      await call(tool, { sessionId });
      await expect(call("browser.navigate", { sessionId, url: "https://board.example/jobs" }), tool).rejects.toThrow(
        /captcha in this task/,
      );
    }
  });

  it("only searches and reads on an assist-only site", async () => {
    const { call, sessionId } = await tools();
    const page = (await call("browser.navigate", { sessionId, url: "https://assist.example/s" })) as { epoch: number };
    await expect(call("browser.act", { sessionId, ref: "q", epoch: page.epoch, kind: "type", value: "cook" })).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(call("browser.act", { sessionId, ref: "f", epoch: page.epoch, kind: "type", value: "me@example.com" })).rejects.toThrow(
      /never fills, sends or signs in/,
    );
    await expect(call("browser.act", { sessionId, ref: "f", epoch: page.epoch, kind: "press", value: "Enter" })).rejects.toThrow(
      /never fills, sends or signs in/,
    );
    await expect(call("browser.act", { sessionId, ref: "send", epoch: page.epoch, kind: "click" })).rejects.toThrow(
      /never fills, sends or signs in/,
    );
    await expect(call("browser.act", { sessionId, ref: "f", epoch: page.epoch, kind: "submit" })).rejects.toThrow(
      /never fills, sends or signs in/,
    );
    await expect(call("browser.act", { sessionId, ref: "more", epoch: page.epoch, kind: "click" })).resolves.toMatchObject({
      status: "accepted",
    });
    // A combobox of another form (a checkout's) is filled, not searched.
    for (const kind of ["type", "press"]) {
      await expect(
        call("browser.act", { sessionId, ref: "country", epoch: page.epoch, kind, value: kind === "press" ? "Enter" : "Portugal" }),
        kind,
      ).rejects.toThrow(/never fills, sends or signs in/);
    }
    // A form's submit sends it whatever its label: an icon, another language's "Next".
    for (const ref of ["icon", "weiter"]) {
      await expect(call("browser.act", { sessionId, ref, epoch: page.epoch, kind: "click" }), ref).rejects.toThrow(
        /never fills, sends or signs in/,
      );
    }
    await expect(call("browser.act", { sessionId, ref: "go", epoch: page.epoch, kind: "click" })).resolves.toMatchObject({
      status: "accepted",
    });
  });

  it("holds a replayed recipe to the site's rules, as browser.act is: an assist-only site's field is never filled", async () => {
    const { sites } = policy();
    await sites.refresh();
    const acted: string[] = [];
    const recipes = {
      observed: () => undefined,
      acted: () => undefined,
      extracted: async () => undefined,
      recipeFor: async () => ({
        workspaceId: context.workspaceId,
        host: "assist.example",
        steps: [
          { kind: "type" as const, role: "searchbox", value: "cook" },
          { kind: "type" as const, role: "textbox", value: "me@example.com" },
        ],
        results: 1,
        uses: 1,
        updatedAt: "2026-10-17T10:00:00.000Z",
        replay: true,
      }),
    };
    const registry = new ToolRegistry();
    const fixture = createFixtureBrowser({
      pages: {
        "https://assist.example/s": [
          { ref: "q", role: "searchbox" },
          { ref: "f", role: "textbox" },
        ],
      },
    });
    registerBrowserTools(
      registry,
      {
        ...fixture,
        currentUrl: async () => "https://assist.example/s",
        act: async (action) => (acted.push(`${action.kind} ${action.ref}`), { status: "accepted" as const }),
      },
      { sites, recipes },
    );
    const opened = await registry
      .get("browser.create_session")!
      .handler({ input: { url: "https://assist.example/s" }, context, signal, operatorApproved: true } as never);
    // The search is replayed; the field the site never lets Tavi fill stops it, unrun.
    expect(acted).toEqual(["type q"]);
    expect(opened).toMatchObject({
      page: {
        recipe: { replayedSteps: 1, stoppedReason: "failed", stoppedDetail: expect.stringMatching(/never fills, sends or signs in/) },
      },
    });
  });

  it("passes each press its guard: a commit only when the gate decided a submit, never within a batch, and the stage site's final step", async () => {
    const registry = new ToolRegistry();
    const { sites } = policy({ profiles: [STAGE] });
    await sites.refresh();
    const fixture = createFixtureBrowser({ pages: { "https://ats.example/apply": [{ ref: "go", role: "button", text: "Next" }] } });
    const guards: unknown[] = [];
    const browser: BrowserPort = { ...fixture, act: async (action) => (guards.push(action.guard), fixture.act(action)) };
    registerBrowserTools(registry, browser, { sites });
    const call = async (id: string, input: unknown, extra: Record<string, unknown> = {}) => {
      const tool = registry.get(id);
      if (tool === undefined) throw new Error(`no ${id}`);
      return tool.handler({ input, context, signal, ...extra } as never);
    };
    const { sessionId } = (await call("browser.create_session", {})) as { sessionId: string };
    const page = (await call("browser.navigate", { sessionId, url: "https://ats.example/apply" })) as { epoch: number };
    await call("browser.act", { sessionId, ref: "go", epoch: page.epoch, kind: "click" });
    await call("browser.act", { sessionId, ref: "go", epoch: page.epoch, kind: "click" }, { assessedSubjects: ["submit"] });
    await call(
      "browser.batch",
      { sessionId, actions: [{ ref: "go", epoch: page.epoch, kind: "click" }] },
      { assessedSubjects: ["submit"] },
    );
    const rule = { labels: ["Submit application"], urlPatterns: [] };
    expect(guards).toEqual([
      { commitApproved: false, finalStep: rule },
      { commitApproved: true, finalStep: rule },
      { commitApproved: false, finalStep: rule },
    ]);
  });

  it("tags the final step on observation, and counts toward the day's only a final control that submits a form", async () => {
    const registry = new ToolRegistry();
    const { sites } = policy({ profiles: [STAGE] });
    await sites.refresh();
    const fixture = createFixtureBrowser({
      pages: {
        "https://ats.example/listing": [{ ref: "a", role: "link", text: "Submit application" }],
        "https://ats.example/review": [{ ref: "s", role: "button", text: "Submit application", submitsForm: true }],
      } as never,
    });
    registerBrowserTools(registry, fixture, { sites });
    const call = async (id: string, input: unknown) => registry.get(id)?.handler({ input, context, signal } as never);
    for (const index of [1, 2, 3]) {
      const { sessionId } = (await call("browser.create_session", {})) as { sessionId: string };
      const page = (await call("browser.navigate", { sessionId, url: "https://ats.example/listing" })) as {
        elements: { finalStep?: boolean }[];
      };
      expect(page.elements[0]?.finalStep, String(index)).toBe(true);
    }
    expect(await sites.stageRefusal({ workspaceId: "default", url: "https://ats.example/apply" })).toBeUndefined();
    // Two review pages, each with its form's final control: the day's two.
    for (let reached = 0; reached < 2; reached += 1) {
      const { sessionId } = (await call("browser.create_session", {})) as { sessionId: string };
      await call("browser.navigate", { sessionId, url: "https://ats.example/review" });
    }
    expect(await sites.stageRefusal({ workspaceId: "default", url: "https://ats.example/apply" })).toMatchObject({ budgetExhausted: true });
  });

  it("does nothing but look and leave on a final step's own address", async () => {
    const registry = new ToolRegistry();
    const reviewing: EnabledSiteProfile = {
      ...STAGE,
      profile: {
        ...STAGE.profile,
        stage: { ...STAGE.profile.stage!, finalStep: { ...STAGE.profile.stage!.finalStep, urlPatterns: ["/apply/review"] } },
      },
    };
    const { sites } = policy({ profiles: [reviewing] });
    await sites.refresh();
    registerBrowserTools(
      registry,
      createFixtureBrowser({ pages: { "https://ats.example/apply/review": [{ ref: "n", role: "textbox", text: "Notes" }] } }),
      { sites },
    );
    const call = async (id: string, input: unknown) => registry.get(id)?.handler({ input, context, signal } as never);
    const { sessionId } = (await call("browser.create_session", {})) as { sessionId: string };
    const page = (await call("browser.navigate", { sessionId, url: "https://ats.example/apply/review" })) as { epoch: number };
    await expect(call("browser.act", { sessionId, ref: "n", epoch: page.epoch, kind: "type", value: "x" })).rejects.toThrow(/last step/);
    await expect(
      call("browser.batch", {
        sessionId,
        actions: [
          { kind: "scroll", value: "down" },
          { ref: "n", epoch: page.epoch, kind: "type", value: "x" },
        ],
      }),
    ).rejects.toThrow(/last step/);
    await expect(call("browser.act", { sessionId, kind: "scroll", value: "down" })).resolves.toMatchObject({ status: "accepted" });
  });

  it("reads a page's structured data through the profile's types", async () => {
    const structured = async () => ({
      url: "https://board.example/jobs/1",
      blocks: {
        jsonLd: [
          JSON.stringify([
            { "@type": "JobPosting", title: "Cook" },
            { "@type": "Restaurant", name: "Cabo" },
          ]),
        ],
        microdata: [],
      },
    });
    const { call, sessionId, registry } = await tools({ structured });
    expect(registry.get("browser.structured")).toMatchObject({
      effect: "read-only",
      sink: "none",
      untrustedOutput: true,
      outputSource: "web",
    });
    await call("browser.navigate", { sessionId, url: "https://board.example/jobs/1" });
    // The board's profile names JobPosting only.
    expect(await call("browser.structured", { sessionId })).toMatchObject({
      url: "https://board.example/jobs/1",
      items: [{ "@type": "JobPosting", title: "Cook" }],
    });
  });
});

describe("the browser worker", () => {
  it("is offered a plugin tool that declares browserWorker, and no other", () => {
    const plugins = new Set(["jobs.finder.ingest"]);
    expect(browserWorkerUses("jobs.finder.ingest", plugins)).toBe(true);
    expect(browserWorkerUses("jobs.finder.track", plugins)).toBe(false);
    expect(browserWorkerUses("browser.structured")).toBe(true);
  });
});
