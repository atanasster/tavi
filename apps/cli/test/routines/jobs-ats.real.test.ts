import { tmpdir } from "node:os";
import { SiteProfileSchema, TaviError, type EnabledSiteProfile, type SiteUsage } from "@tavi/contracts";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { createPlaywrightBrowser } from "@tavi/plugin-browser/playwright";
import { createInMemoryArtifactRepository } from "@tavi/test-support/fakes";
import { ToolRegistry } from "@tavi/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startJobsSite } from "../../../../packages/external/jobs/test/fixtures/site/server.mjs";
import { registerBrowserTools } from "../../src/features/sandbox/tools.js";
import { createRobotsReader, createSitePolicy } from "../../src/features/browser/site-policy.js";
import { delay } from "@tavi/test-support";

/** The fixture sites run on this machine: exempt from the browser's private-address rule, and from nothing else. */
const FIXTURE_HOSTS = ["127.0.0.1", "localhost", "*.localhost"];

/**
 * Staging against the fixture ATS in a real Chromium: the agent's steps through the browser tools and the site
 * policy, and the DOM oracle — the server logs every POST, and staging ends on
 * the review page with none. `ats.localhost` is a stage profile whose final
 * step is "Submit application"; `sf.localhost` is SuccessFactors-shaped, its
 * final step "Apply"; 127.0.0.1 has no profile. Without Chromium the tests skip.
 */
const stage = (id: string, host: string, labels: string[]): EnabledSiteProfile => ({
  pluginId: "jobs.finder",
  profile: SiteProfileSchema.parse({
    abi: "tavi.sites/1",
    id,
    name: id,
    countries: ["*"],
    hosts: [host],
    kind: "ats",
    access: { mode: "stage", reason: "fixture", termsUrl: "https://example.com/terms", reviewedAt: "2026-10-17" },
    budget: { pagesPerTask: 20, pagesPerDay: 100, minIntervalMs: 1_000 },
    stage: { fillable: ["first_name", "last_name", "email", "work_history", "custom_answer"], finalStep: { labels }, perDay: 2 },
    notes: "",
  }),
});

let site: Awaited<ReturnType<typeof startJobsSite>>;
let skip: string | undefined;
let registry: ToolRegistry;
let closeBrowser: () => Promise<void> = async () => undefined;
const context = (taskId: string) => ({ workspaceId: "default", principalId: "operator", runId: taskId, caller: "test" });

beforeAll(async () => {
  try {
    const chromium = await launchChromium({ headless: true });
    await chromium.close();
  } catch (error) {
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
      stage("ats", "ats.localhost", ["Submit application"]),
      stage("successfactors", "sf.localhost", ["Apply"]),
      stage("day", "day.localhost", ["Submit application"]),
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
  registerBrowserTools(registry, browser, { sites, privateHostsAllowed: FIXTURE_HOSTS });
}, 60_000);

afterAll(async () => {
  await closeBrowser();
  await site?.close();
});

const tool = (id: string) => {
  const found = registry.get(id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};
const call = (id: string, input: unknown, taskId: string, extra: Record<string, unknown> = {}) =>
  tool(id).handler({ input, context: context(taskId), signal: new AbortController().signal, ...extra } as never);
type Page = {
  readonly epoch: number;
  readonly elements: readonly {
    readonly ref: string;
    readonly text?: string;
    readonly role?: string;
    readonly finalStep?: true;
    readonly submitsForm?: true;
  }[];
};
const refOf = (page: Page, text: string): string => page.elements.find((element) => element.text === text)?.ref ?? `(no ${text})`;
const observe = async (sessionId: string, taskId: string): Promise<Page> => (await call("browser.observe", { sessionId }, taskId)) as Page;

describe("staging an application on the fixture ATS", () => {
  it("fills what it may, leaves the protected fields, and stops before the final control: zero POSTs", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const ats = site.origin.replace("127.0.0.1", "ats.localhost");
    const task = "stage-1";
    const { sessionId } = (await call("browser.create_session", {}, task)) as { sessionId: string };
    const type = async (page: Page, label: string, value: string) =>
      call("browser.act", { sessionId, ref: refOf(page, label), epoch: page.epoch, kind: "type", value }, task);
    const press = async (page: Page, label: string, extra: Record<string, unknown> = {}) =>
      call("browser.act", { sessionId, ref: refOf(page, label), epoch: page.epoch, kind: "click" }, task, extra);
    let page = (await call("browser.navigate", { sessionId, url: `${ats}/ats/apply` }, task)) as Page;
    await type(page, "First name", "Ada");
    await type(page, "Last name", "Lovelace");
    await type(page, "Email", "ada@example.com");
    await press(page, "Next");
    page = await observe(sessionId, task);
    await type(page, "Current company", "Analytical Engines");
    await type(page, "Why do you want to work here?", "Because of the engines.");
    await press(page, "Next");
    // The EEO select (generic options), the terms box and the AI attestation are the person's.
    page = await observe(sessionId, task);
    // A honeypot field (display:none) is never offered to be filled: the page shows no text field at all.
    expect(page.elements.filter((element) => element.role === "textbox")).toEqual([]);
    await expect(
      call("browser.act", { sessionId, ref: refOf(page, "Choose one"), epoch: page.epoch, kind: "select", value: "A" }, task),
    ).rejects.toMatchObject({ details: { protected: "demographic" } });
    for (const label of ["Geschlecht", "Sexe", "Género"])
      await expect(
        call("browser.act", { sessionId, ref: refOf(page, label), epoch: page.epoch, kind: "select", value: "X" }, task),
        label,
      ).rejects.toMatchObject({ details: { protected: "demographic" } });
    await expect(press(page, "I agree")).rejects.toMatchObject({ details: { protected: "attestation" } });
    await expect(press(page, "I personally completed this application without AI")).rejects.toMatchObject({
      details: { protected: "attestation" },
    });
    await press(page, "Next");
    // The review page: its final control is tagged, refused on the card, and refused in the browser, alone or as a batch's last step.
    page = await observe(sessionId, task);
    const submit = page.elements.find((element) => element.text === "Submit application");
    expect(submit).toMatchObject({ finalStep: true, submitsForm: true });
    expect(
      tool("browser.act").assess?.({ sessionId, ref: submit?.ref, epoch: page.epoch, kind: "click" }, context(task) as never)?.hardDeny,
    ).toMatch(/last step/);
    await expect(press(page, "Submit application", { assessedSubjects: ["submit"] })).rejects.toMatchObject({
      details: { guard: "final-step" },
    });
    const batch = (await call(
      "browser.batch",
      {
        sessionId,
        actions: [
          { kind: "scroll", value: "down" },
          { ref: submit?.ref, epoch: page.epoch, kind: "click" },
        ],
      },
      task,
    )) as { steps: { error?: string }[]; stopped?: string };
    expect(batch.steps[0]).not.toHaveProperty("error");
    expect(batch.steps[1]?.error).toMatch(/last step/);
    expect(batch.stopped).toMatch(/step 2 failed/);
    // The oracle: nothing was submitted.
    expect(site.posted).toEqual([]);
  }, 120_000);

  it("reads a final Apply in its form's context: asked on a host with no profile, and refused as a SuccessFactors-shaped final step; Apply filters is no commit", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const task = "apply-1";
    const { sessionId } = (await call("browser.create_session", {}, task)) as { sessionId: string };
    const page = (await call("browser.navigate", { sessionId, url: `${site.origin}/ats/apply-variant` }, task, {
      operatorApproved: true,
    })) as Page;
    // The form's own "Apply", and a type=button "Apply" outside it that scrolls, under the page's Review heading: both observed, only the first commits.
    const applies = page.elements.filter((element) => element.text === "Apply");
    expect(applies.map((element) => element.submitsForm === true)).toEqual([false, true]);
    const [scroll, apply] = applies;
    expect(scroll?.ref).toBeDefined();
    // The scroll, and an "Apply for this job" link: clicks.
    for (const ref of [scroll?.ref, refOf(page, "Apply for this job")])
      expect(tool("browser.act").assess?.({ sessionId, ref, epoch: page.epoch, kind: "click" }, context(task) as never)?.subjects).toEqual([
        "click",
      ]);
    expect(
      tool("browser.act").assess?.({ sessionId, ref: apply?.ref, epoch: page.epoch, kind: "click" }, context(task) as never),
    ).toMatchObject({ risk: "high", subjects: ["submit"] });
    expect(
      tool("browser.act").assess?.(
        { sessionId, ref: refOf(page, "Apply filters"), epoch: page.epoch, kind: "click" },
        context(task) as never,
      )?.subjects,
    ).toEqual(["click"]);
    // Pressed without the person approving a commit: refused in the browser.
    await expect(call("browser.act", { sessionId, ref: apply?.ref, epoch: page.epoch, kind: "click" }, task)).rejects.toMatchObject({
      details: { guard: "commit" },
    });
    const sf = site.origin.replace("127.0.0.1", "sf.localhost");
    const shaped = (await call("browser.navigate", { sessionId, url: `${sf}/ats/apply-variant` }, task)) as Page;
    const finalApply = shaped.elements.find((element) => element.text === "Apply" && element.submitsForm === true)?.ref ?? "";
    await expect(
      call("browser.act", { sessionId, ref: finalApply, epoch: shaped.epoch, kind: "click" }, task, { assessedSubjects: ["submit"] }),
    ).rejects.toMatchObject({ details: { guard: "final-step" } });
    expect(site.posted).toEqual([]);
  }, 120_000);

  it("shows an ATS's sign-in as the person's to take over", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const ats = site.origin.replace("127.0.0.1", "ats.localhost");
    const { sessionId } = (await call("browser.create_session", {}, "login-1")) as { sessionId: string };
    expect(await call("browser.navigate", { sessionId, url: `${ats}/ats/login` }, "login-1")).toMatchObject({ blocked: { kind: "login" } });
  }, 60_000);

  it("stages at most perDay applications on a profile in a day", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const ats = site.origin.replace("127.0.0.1", "day.localhost");
    // Two sessions reach the review page: the day's two.
    for (const task of ["day-1", "day-2"]) {
      const reached = (await call("browser.create_session", {}, task)) as { sessionId: string };
      await call("browser.navigate", { sessionId: reached.sessionId, url: `${ats}/ats/review` }, task);
    }
    const third = (await call("browser.create_session", {}, "stage-3")) as { sessionId: string };
    const page = (await call("browser.navigate", { sessionId: third.sessionId, url: `${ats}/ats/apply` }, "stage-3")) as Page;
    await expect(
      call(
        "browser.act",
        { sessionId: third.sessionId, ref: refOf(page, "First name"), epoch: page.epoch, kind: "type", value: "Ada" },
        "stage-3",
      ),
    ).rejects.toMatchObject({ details: { budgetExhausted: true } });
    expect(site.posted).toEqual([]);
  }, 120_000);
});
