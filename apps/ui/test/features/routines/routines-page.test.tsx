// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { act } from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Schedule } from "../../../src/features/center/Schedule.js";
import { mergeBy } from "../../../src/lib/paging.js";
import { listRoutines, webUrl } from "../../../src/features/routines/api.js";
import { RunInspector } from "../../../src/features/routines/RunInspector.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { ViewBoundary } from "../../../src/ui/ViewBoundary.js";
import { InWorkspace } from "../../support/workspace.js";
import { mount, settle, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** Schedule, where the routines live, with its address held in state, as the router holds it. */
function Routed(props: Omit<Parameters<typeof Schedule>[0], "onOpenRoutine" | "routineId" | "runId" | "summary" | "revision">) {
  const [at, setAt] = useState<{ routineId?: string | undefined; runId?: string | undefined }>({});
  return (
    <Schedule
      {...props}
      summary={undefined}
      revision={0}
      routineId={at.routineId}
      runId={at.runId}
      onOpenRoutine={(routineId, runId) => setAt({ routineId, runId })}
    />
  );
}

const answering = (result: unknown): SettingsClient => ({ request: async () => ({ ok: true, result }) as never });

describe("the routines in Schedule", () => {
  it("reads an answer without a routines list as a failure, not a list", async () => {
    // `{}` is what a serialized pending promise looks like: the owner once sent exactly that.
    expect(await listRoutines(answering({}), "default")).toMatchObject({
      ok: false,
      message: expect.stringContaining("could not be read"),
    });
    expect(await listRoutines(answering({ routines: [] }), "default")).toEqual({ ok: true, value: { routines: [] } });
  });

  it("shows the failure with a retry instead of blanking the canvas", async () => {
    const page = await mount(
      <InWorkspace client={answering({})} workspaceId="default">
        <Routed onFollow={async () => {}} />
      </InWorkspace>,
    );
    expect(page.querySelector("h1")?.textContent).toBe("Schedule");
    expect(
      [...page.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent?.includes("The owner's routines could not be read")),
    ).toBe(true);
  });

  it("contains a page that throws, and lets it try again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    function Page() {
      if (broken) throw new Error("boom");
      return <p>fine</p>;
    }
    const page = await mount(
      <ViewBoundary resetKey="routines">
        <Page />
      </ViewBoundary>,
    );
    expect(page.textContent).toContain("This page could not be shown (boom).");
    broken = false;
    await act(async () => page.querySelector("button")?.click());
    expect(page.textContent).toBe("fine");
    error.mockRestore();
  });
});

describe("the run inspector", () => {
  const run = {
    runId: "run",
    routineId: "routine",
    revision: 1,
    mode: "production",
    status: "succeeded",
    claimedAt: "now",
    startedAt: "now",
    endedAt: "now",
    snapshot: {},
    data: { modelCalls: 1, tokensKnown: 1, usageComplete: true },
  };
  const event = (sequence: number) => ({ sequence, at: `t${sequence}`, envelope: { code: "step", step: "research" } });
  function owner(firstPage: number, sources: unknown[], publication: unknown = null) {
    const sent: Record<string, unknown>[] = [];
    const client: SettingsClient = {
      request: async (_command, raw) => {
        const input = raw as Record<string, unknown>;
        sent.push(input);
        const result =
          input["action"] === "inspect"
            ? { run, publication, deliveries: [], attempts: [] }
            : input["action"] === "ledger"
              ? {
                  events:
                    input["afterSequence"] === undefined
                      ? Array.from({ length: firstPage }, (_, index) => event(index + 1))
                      : [event(firstPage + 1)],
                }
              : input["action"] === "sources"
                ? { sources, nextAfterSourceId: null }
                : {};
        return { ok: true, result } as never;
      },
    };
    return { client, sent };
  }
  const button = (page: HTMLElement, text: string) => [...page.querySelectorAll("button")].find((item) => item.textContent === text);

  it("merges pages once each, a later copy replacing the earlier in place", () => {
    expect(
      mergeBy(
        [
          [
            { id: 1, v: "a" },
            { id: 2, v: "b" },
          ],
          [
            { id: 1, v: "c" },
            { id: 3, v: "d" },
          ],
        ],
        (item) => item.id,
      ),
    ).toEqual([
      { id: 1, v: "c" },
      { id: 2, v: "b" },
      { id: 3, v: "d" },
    ]);
  });

  it("heads its summary with the published report's headline, and shows no cost", async () => {
    const fake = owner(1, [], {
      reportArtifactId: "art",
      pdfArtifactId: null,
      pdfError: null,
      headline: "GPT-9 ships with a longer context",
    });
    const page = await mount(
      <InWorkspace client={fake.client} workspaceId="default">
        <RunInspector timeZone="UTC" routineId="routine" routineName="LLM news" runId="run" onBack={() => {}} onFollow={async () => {}} />
      </InWorkspace>,
    );
    const fact = (label: string) =>
      [...page.querySelectorAll(".summary-grid > div")].find((row) => row.querySelector("dt")?.textContent === label)?.querySelector("dd")
        ?.textContent;
    expect(fact("Headline")).toBe("GPT-9 ships with a longer context");
    expect(fact("Cost")).toBeUndefined();
  });

  it("says a report's coverage in the workspace zone, and lets the keyboard reach each scrolling excerpt", async () => {
    const report = {
      title: "LLM news",
      quiet: true,
      coverage: { from: "2026-10-01T02:39:07.477Z", to: "2026-10-02T02:39:07.477Z", gaps: [] },
    };
    const json = btoa(JSON.stringify(report));
    const fake = owner(
      1,
      [
        {
          sourceId: "s1",
          canonicalUrl: "https://example.com/news",
          publisher: "Example News",
          state: "fetched",
          retrievedAt: "now",
          publishedAt: null,
          excerpt: "A long excerpt",
        },
      ],
      { reportArtifactId: "art", pdfArtifactId: null, pdfError: null },
    );
    const client: SettingsClient = {
      request: async (command, raw) =>
        (raw as Record<string, unknown>)["action"] === "artifact"
          ? ({
              ok: true,
              result: {
                artifactId: "art",
                contentType: "application/json",
                hash: createHash("sha256").update(atob(json), "latin1").digest("hex"),
                offset: 0,
                totalBytes: atob(json).length,
                base64: json,
                nextOffset: null,
              },
            } as never)
          : fake.client.request(command, raw),
    };
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <RunInspector
          timeZone="Europe/London"
          routineId="routine"
          routineName="LLM news"
          runId="run"
          onBack={() => {}}
          onFollow={async () => {}}
        />
      </InWorkspace>,
    );
    // The report is checked against its hash by WebCrypto, which answers off the main thread,
    // so a busy machine can take longer than one settle: wait for the report itself.
    const coverage = await vi.waitFor(async () => {
      await settle();
      const line = [...page.querySelectorAll(".routine-report p")].find((each) => each.textContent?.startsWith("Coverage"));
      return line ?? Promise.reject(new Error("no report yet"));
    });
    expect(coverage.textContent).toBe("Coverage: Thu 1 Oct 03:39 — Fri 2 Oct 03:39");
    const excerpt = page.querySelector<HTMLElement>(".evidence-row pre");
    expect(excerpt?.tabIndex).toBe(0);
    expect(excerpt?.getAttribute("role")).toBe("region");
    expect(excerpt?.getAttribute("aria-label")).toBe("Excerpt from Example News");
  });

  it("says why a failed run failed, and that an older one's reason was not kept", async () => {
    const shown = async (data: Record<string, unknown>, status = "failed") => {
      const client: SettingsClient = {
        request: async (_command, raw) => {
          const action = (raw as Record<string, unknown>)["action"];
          const result =
            action === "inspect"
              ? { run: { ...run, status, data: { ...run.data, ...data } }, publication: null, deliveries: [], attempts: [] }
              : action === "ledger"
                ? { events: [] }
                : action === "sources"
                  ? { sources: [], nextAfterSourceId: null }
                  : {};
          return { ok: true, result } as never;
        },
      };
      const page = await mount(
        <InWorkspace client={client} workspaceId="default">
          <RunInspector timeZone="UTC" routineId="routine" routineName="LLM news" runId="run" onBack={() => {}} onFollow={async () => {}} />
        </InWorkspace>,
      );
      return page.querySelector(".run-failure")?.textContent;
    };
    expect(await shown({ failureDetail: "Required research did not complete: Routine model budget exhausted" })).toBe(
      "Why it failed: Required research did not complete: Routine model budget exhausted",
    );
    expect(await shown({})).toBe("This run failed before Tavi kept the reason.");
    expect(await shown({}, "succeeded")).toBeUndefined();
  });

  it("links a fetched source only when its URL is a web address", async () => {
    expect(webUrl("javascript:alert(1)")).toBeUndefined();
    expect(webUrl("https://example.com/a")).toBe("https://example.com/a");
    const fake = owner(1, [
      {
        sourceId: "bad",
        canonicalUrl: "javascript:alert(1)",
        publisher: "Hostile page",
        state: "fetched",
        retrievedAt: "now",
        publishedAt: null,
        excerpt: "x",
      },
      {
        sourceId: "good",
        canonicalUrl: "https://example.com/news",
        publisher: "Good page",
        state: "fetched",
        retrievedAt: "now",
        publishedAt: null,
        excerpt: "y",
      },
    ]);
    const page = await mount(
      <InWorkspace client={fake.client} workspaceId="default">
        <RunInspector timeZone="UTC" routineId="routine" routineName="LLM news" runId="run" onBack={() => {}} onFollow={async () => {}} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Hostile page");
    expect([...page.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["https://example.com/news"]);
  });

  it("answers, above a live run's record, the question its task asked", async () => {
    const sent: { command: string; input: Record<string, unknown> }[] = [];
    const live = { ...run, status: "running", taskId: "task-run", endedAt: null };
    const question = {
      taskId: "task-run",
      workspaceId: "default",
      principalId: "operator",
      waitId: "w1",
      question: "Publish today's report?",
      choices: { options: [{ label: "Publish" }, { label: "Hold" }], multiSelect: false, allowOther: false, defaultOption: 2 },
      deadlineAt: "2099-01-01T09:00:00.000Z",
      askedAt: "2026-10-02T08:00:00.000Z",
      deliveries: [],
    };
    const client: SettingsClient = {
      request: async (command, raw) => {
        const input = raw as Record<string, unknown>;
        sent.push({ command, input });
        const result =
          command === "approvals" && input["action"] === "needs"
            ? {
                needs: [
                  {
                    kind: "question",
                    needId: "question:w1",
                    taskId: "task-run",
                    askedAt: question.askedAt,
                    deadlineAt: question.deadlineAt,
                    question,
                  },
                ],
                truncated: false,
              }
            : command === "approvals" && input["action"] === "answer"
              ? { taskId: "task-run", waitId: "w1", answers: ["Hold"] }
              : input["action"] === "inspect"
                ? { run: live, publication: null, deliveries: [], attempts: [] }
                : input["action"] === "ledger"
                  ? { events: [] }
                  : input["action"] === "sources"
                    ? { sources: [], nextAfterSourceId: null }
                    : {};
        return { ok: true, result } as never;
      },
    };
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <RunInspector timeZone="UTC" routineId="routine" routineName="LLM news" runId="run" onBack={() => {}} onFollow={async () => {}} />
      </InWorkspace>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const band = page.querySelector('[aria-label="waiting on you"]');
    expect(band?.textContent).toContain("Publish today's report?");
    expect(band?.textContent).toContain("If nobody answers: Hold");
    const hold = [...(band?.querySelectorAll<HTMLButtonElement>("button.need-option") ?? [])].find((option) =>
      option.textContent?.includes("Hold"),
    );
    await act(async () => hold?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sent.find((item) => item.input["action"] === "answer")?.input).toEqual({
      action: "answer",
      workspaceId: "default",
      taskId: "task-run",
      waitId: "w1",
      answer: "Hold",
    });
    expect(band?.textContent).toContain("You answered Hold");
  });

  it("names other decisions a live run waits on with the way to its task, and asks nothing for a finished run", async () => {
    const followed: string[] = [];
    const asked: string[] = [];
    const live = { ...run, status: "running", taskId: "task-run", endedAt: null };
    const approvalNeed = {
      kind: "approval",
      needId: "approval:a1",
      taskId: "task-run",
      askedAt: "now",
      approval: {
        approvalId: "a1",
        taskId: "task-run",
        toolId: "http.request",
        callId: "c1",
        steps: 1,
        createdAt: "now",
        workspaceId: "default",
        principalId: "operator",
        taskStatus: "waiting",
        allowedScopes: ["once"],
      },
    };
    const client = (current: typeof live | typeof run): SettingsClient => ({
      request: async (command, raw) => {
        const input = raw as Record<string, unknown>;
        if (command === "approvals") asked.push(String(input["action"]));
        const result =
          command === "approvals" && input["action"] === "needs"
            ? { needs: [approvalNeed], truncated: false }
            : input["action"] === "inspect"
              ? { run: current, publication: null, deliveries: [], attempts: [] }
              : input["action"] === "ledger"
                ? { events: [] }
                : input["action"] === "sources"
                  ? { sources: [], nextAfterSourceId: null }
                  : {};
        return { ok: true, result } as never;
      },
    });
    const page = await mount(
      <InWorkspace client={client(live)} workspaceId="default">
        <RunInspector
          timeZone="UTC"
          routineId="routine"
          routineName="LLM news"
          runId="run"
          onBack={() => {}}
          onFollow={async (taskId) => void followed.push(taskId)}
        />
      </InWorkspace>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const band = page.querySelector('[aria-label="waiting on you"]');
    expect(band?.textContent).toContain("A decision waits in the run's task.");
    await act(async () => button(page, "Open it")?.click());
    expect(followed).toEqual(["task-run"]);
    unmountAll();

    asked.length = 0;
    const done = await mount(
      <InWorkspace client={client(run)} workspaceId="default">
        <RunInspector timeZone="UTC" routineId="routine" routineName="LLM news" runId="run" onBack={() => {}} onFollow={async () => {}} />
      </InWorkspace>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(done.querySelector('[aria-label="waiting on you"]')).toBeNull();
    expect(asked).not.toContain("needs");
  });

  it("offers more timeline only after a full page", async () => {
    const short = await mount(
      <InWorkspace client={owner(3, []).client} workspaceId="default">
        <RunInspector timeZone="UTC" routineId="routine" routineName="LLM news" runId="run" onBack={() => {}} onFollow={async () => {}} />
      </InWorkspace>,
    );
    expect(button(short, "Load more timeline")).toBeUndefined();
    unmountAll();

    const fake = owner(100, []);
    const full = await mount(
      <InWorkspace client={fake.client} workspaceId="default">
        <RunInspector timeZone="UTC" routineId="routine" routineName="LLM news" runId="run" onBack={() => {}} onFollow={async () => {}} />
      </InWorkspace>,
    );
    await act(async () => button(full, "Load more timeline")?.click());
    expect(fake.sent.at(-1)).toMatchObject({ action: "ledger", afterSequence: 100 });
    expect(full.textContent).toContain("t101");
    // The second page came back short: there is no third.
    expect(button(full, "Load more timeline")).toBeUndefined();
  });
});
