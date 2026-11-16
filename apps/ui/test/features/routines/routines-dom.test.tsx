// @vitest-environment jsdom
import { act } from "react";
import { useState } from "react";
import { expect, it } from "vitest";
import { pick } from "../../pick.js";
import { routineDefaults, type RoutineGrantView, type RoutineLedgerVerdict, type RoutineReadiness } from "@tavi/contracts";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { Schedule } from "../../../src/features/center/Schedule.js";
import { checkpointLine } from "../../../src/features/routines/RunRecords.js";
import { InWorkspace } from "../../support/workspace.js";
import { mount } from "../../support/dom.js";
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
/** The owner's `schedules` answers beside a routines fixture: nothing coming up, no plain schedules. */
const withSchedules = (client: SettingsClient): SettingsClient => ({
  request: async (command, payload, options) => {
    const action = (payload as Record<string, unknown>)["action"];
    if (command === "schedules")
      return {
        ok: true,
        result: action === "agenda" ? { timezone: "UTC", items: [], truncated: false, skipped: [] } : { schedules: [], truncated: false },
      } as never;
    return client.request(command, payload, options);
  },
});
/** The schedule page in the team workspace, read through `client`. */
const schedule = (client: SettingsClient): Promise<HTMLElement> =>
  mount(
    <InWorkspace client={withSchedules(client)} workspaceId="team">
      <Routed onFollow={async () => {}} />
    </InWorkspace>,
  );
/** The routine page lists runs; a run opens as its own page. */
async function openRun(page: HTMLElement) {
  await click(page, "Inspect");
}
/** A summary row's value, by its label. */
const fact = (page: HTMLElement, label: string) =>
  [...page.querySelectorAll(".summary-grid > div")].find((row) => row.querySelector("dt")?.textContent === label)?.querySelector("dd")
    ?.textContent;
async function click(page: HTMLElement, text: string) {
  const button = [...page.querySelectorAll<HTMLElement>("button, a")].find((item) => item.textContent === text)!;
  await act(async () => {
    button.focus();
    button.click();
  });
}
function fixture(triggers: readonly Record<string, unknown>[] = [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }]) {
  const sent: Record<string, unknown>[] = [];
  const now = "2026-09-20T06:00:00Z";
  const record = {
    routineId: "routine",
    workspaceId: "team",
    principalId: "owner",
    name: "LLM news",
    status: "active",
    version: 3,
    activeRevision: 1,
    latestRevision: 2,
  };
  const snapshot = {
    ...routineDefaults("Europe/Sofia"),
    objective: "Find news",
    agent: { agentId: "news", name: "Researcher", revision: 1, instructions: "Pinned researcher instructions", hash: "a".repeat(64) },
    skills: [],
    triggers,
  };
  const detail = {
    routine: record,
    revision: { revision: 2, snapshot },
    evaluation: { status: "failed", detail: "Prior revision remains active" },
    schedules: [],
    state: {},
    hostStatus: "Local owner must remain running",
    lastSevenDays: { since: "2026-09-13T06:00:00Z", runs: 2, durationMs: 185_000, modelCalls: 4, toolCalls: 7, tokensKnown: 12_545 },
  };
  const run = {
    runId: "run",
    routineId: "routine",
    taskId: "task",
    revision: 1,
    mode: "production",
    status: "succeeded",
    claimedAt: now,
    startedAt: now,
    endedAt: "2026-09-20T06:02:05Z",
    snapshot: { ...snapshot, objective: "Original objective" },
    data: { modelCalls: 3, toolCalls: 7, tokensKnown: 12_345, usageComplete: false },
    durationMs: 125_000,
    modelCalls: 3,
    toolCalls: 7,
    tokensKnown: 12_345,
    headline: "GPT-9 ships with a longer context",
  };
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const input = payload as Record<string, unknown>;
      sent.push(input);
      const action = input["action"];
      const result =
        action === "readiness"
          ? ({
              routineId: "routine",
              revision: { active: 1, latest: 2, candidate: { revision: 2, evaluation: "failed", detail: "Candidate failed novelty" } },
              research: {
                ready: true,
                blockedBy: null,
                retryable: null,
                tools: ["web_search"],
                hosts: ["example.com"],
                networkMode: "allowlist",
                grant: { grantId: "grant-1", revokedAt: null, policyRevision: 4 },
              },
              delivery: {
                authorized: false,
                blockedBy: "unauthorized",
                targets: [{ targetId: "chat", revision: 1, enabled: true, authorized: false, problem: "unauthorized" }],
              },
              owner: { heartbeatAt: now, state: "live", heartbeatAgeMs: 5 },
              storage: { freeBytes: 1000, belowFloor: false },
              schedule: { nextRunAt: now, timezone: "Europe/Sofia", triggerId: "morning", enabled: true },
              renderer: { available: true, provider: "fixture" },
            } satisfies RoutineReadiness)
          : action === "verify"
            ? ({
                valid: true,
                scope: { workspaceId: "team", principalId: "owner", routineId: "routine" },
                events: 12,
                headHash: "a".repeat(64),
                prunedDetails: 2,
                chain: "local",
                anchored: false,
                limitation:
                  "Local chain only. A rewrite of the whole ledger is not detectable without an anchor stored outside this database.",
              } satisfies RoutineLedgerVerdict)
            : action === "list"
              ? { routines: [{ ...record, lastRun: run }] }
              : action === "get"
                ? detail
                : action === "history"
                  ? { runs: input["beforeRunId"] ? [] : [run] }
                  : action === "revisions"
                    ? { items: [{ revision: 1, changeSummary: "Created", createdAt: now }], nextBeforeRevision: null }
                    : action === "inspect"
                      ? {
                          run,
                          publication: null,
                          deliveries: [],
                          attempts: [],
                          effectivePolicy: {
                            grantId: "grant-1",
                            policyRevision: 4,
                            revision: 1,
                            mode: "production",
                            networkMode: "open_web",
                            researchTools: ["web_search", "http.request"],
                            allowedHosts: ["example.com", "news.example.org"],
                            destinationIds: [],
                            createdAt: now,
                            revokedAt: null,
                            revokedReason: null,
                            narrowedTools: ["messaging.send_to"],
                          } satisfies RoutineGrantView,
                        }
                      : action === "ledger"
                        ? {
                            events: [
                              { sequence: 1, at: now, envelope: { code: "model", step: "research" }, detailId: "prompt" },
                              {
                                sequence: 2,
                                at: now,
                                envelope: { code: "asked", step: "synthesis", checkpoint: { question: "Ship the report today?" } },
                              },
                              {
                                sequence: 3,
                                at: now,
                                envelope: { code: "answered", step: "synthesis", checkpoint: { outcome: "defaulted", answers: ["Hold"] } },
                              },
                            ],
                          }
                        : action === "sources"
                          ? { sources: [], nextAfterSourceId: null }
                          : action === "detail"
                            ? { payload: null, hash: "b".repeat(64), prunedAt: now }
                            : action === "checkpoints"
                              ? {
                                  checkpoints: [
                                    {
                                      waitId: "w-1",
                                      question: "Ship the report today?",
                                      header: "Ship",
                                      options: ["Ship", "Hold"],
                                      multiSelect: false,
                                      state: "answered",
                                      answers: ["Ship"],
                                      by: "owner",
                                      via: "telegram-main",
                                      at: now,
                                      deadlineAt: now,
                                    },
                                    {
                                      waitId: "w-2",
                                      question: "Include the appendix?",
                                      options: ["Yes", "No"],
                                      multiSelect: false,
                                      state: "defaulted",
                                      answers: ["No"],
                                      via: "policy",
                                      at: now,
                                      deadlineAt: now,
                                    },
                                  ],
                                }
                              : action === "answers"
                                ? {
                                    answers: [
                                      {
                                        questionKey: "ship",
                                        question: "Ship the report today?",
                                        answers: ["Ship"],
                                        createdBy: "owner",
                                        createdAt: now,
                                      },
                                    ],
                                  }
                                : action === "forget_answer"
                                  ? { removed: true }
                                  : {};
      return { ok: true, result };
    },
  };
  return { client, sent };
}
it("opens instructions, last run and receipts together and preserves historical configuration", async () => {
  const f = fixture();
  const page = await schedule(f.client);
  await click(page, "LLM news");
  expect(page.textContent).toContain("Pinned researcher instructions");
  expect(fact(page, "Configuration")).toContain("Active revision: 1; latest configuration: 2");
  await click(page, "Pause");
  expect(f.sent).toContainEqual({ action: "pause", routineId: "routine", expectedVersion: 3, workspaceId: "team" });
  // The run keeps the configuration it ran with, not the routine's current one.
  await openRun(page);
  expect(page.textContent).toContain("Original objective");
  expect(page.textContent).toContain("No delivery requested");
  await click(page, "Inspect retained detail 1");
  // When it expired is said in the workspace zone, and its hash is not shown.
  expect(page.textContent).toContain("Detail expired Sun 20 Sep");
  expect(page.textContent).not.toContain("2026-09-20T06:00:00Z");
  expect(page.textContent).not.toContain("b".repeat(64));
  expect(f.sent.every((input) => input["workspaceId"] === "team" && input["principalId"] === undefined)).toBe(true);
  // Back to the routine, then to the list.
  await click(page, "← LLM news");
  expect(page.querySelector("h2")?.textContent).toContain("LLM news");
  await click(page, "← Schedule");
  expect(page.querySelector("h1")?.textContent).toBe("Schedule");
});
it("says what each run took and its report's headline, sums the last seven days, and shows no cost", async () => {
  const f = fixture();
  const page = await schedule(f.client);
  await click(page, "LLM news");
  const runs = [...page.querySelectorAll(".item-row")].find((item) => item.textContent?.includes("GPT-9"));
  expect(runs?.textContent).toContain("production · revision 1 · 2m 05s · 12,345 tokens");
  expect(runs?.textContent).toContain("GPT-9 ships with a longer context");
  expect(fact(page, "Last 7 days")).toBe("2 runs · 3m 05s · 4 model calls · 7 tool calls · 12,545 tokens");
  expect(fact(page, "Cost")).toBeUndefined();
  await openRun(page);
  expect(fact(page, "Duration")).toBe("2m 05s");
  expect(fact(page, "Model calls")).toBe("3");
  expect(fact(page, "Tool calls")).toBe("7");
  expect(fact(page, "Known tokens")).toBe("12,345 (incomplete provider usage)");
  expect(fact(page, "Cost")).toBeUndefined();
});
it("requires explicit archive and gives the labelled form keyboard focus", async () => {
  const f = fixture();
  const page = await schedule(f.client);
  await click(page, "LLM news");
  await click(page, "Archive routine");
  expect(f.sent.some((input) => input["action"] === "archive")).toBe(false);
  await click(page, "Confirm archive");
  expect(f.sent.some((input) => input["action"] === "archive")).toBe(true);
  await click(page, "← Schedule");
  await click(page, "New routine");
  const dialog = page.querySelector("dialog")!;
  expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  for (const control of dialog.querySelectorAll("input,textarea,select")) expect(control.closest("label")).not.toBeNull();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(page.querySelector("dialog")).toBeNull();
  expect(document.activeElement?.textContent).toBe("New routine");
});
it("refreshes evidence and timeline together and pages older revisions", async () => {
  const f = fixture();
  let refreshed = false;
  const client: SettingsClient = {
    request: async (command, payload, options) => {
      const input = payload as Record<string, unknown>;
      if (input["action"] === "revisions")
        return {
          ok: true,
          result: {
            items: [
              {
                revision: input["beforeRevision"] ? 1 : 21,
                changeSummary: input["beforeRevision"] ? "Original version" : "Latest",
                createdAt: "now",
              },
            ],
            nextBeforeRevision: input["beforeRevision"] ? null : 21,
          },
        };
      if (refreshed && input["action"] === "ledger")
        return { ok: true, result: { events: [{ sequence: 2, at: "now", envelope: { code: "completed", step: "synthesis" } }] } };
      if (refreshed && input["action"] === "sources")
        return {
          ok: true,
          result: {
            sources: [
              {
                sourceId: "source",
                canonicalUrl: "https://example.com",
                publisher: "Fresh evidence",
                state: "fetched",
                retrievedAt: "now",
                publishedAt: "now",
                excerpt: "Verified release",
              },
            ],
            nextAfterSourceId: null,
          },
        };
      return f.client.request(command, payload, options);
    },
  };
  const page = await schedule(client);
  await click(page, "LLM news");
  await click(page, "Load older revisions");
  expect(page.textContent).toContain("Original version");
  await click(page, "Revision 1: Original version");
  expect(page.textContent).toContain("Restore as a new revision");
  await click(page, "Close");
  await openRun(page);
  refreshed = true;
  await click(page, "Refresh run");
  expect(page.textContent).toContain("Fresh evidence");
  expect(page.textContent).toContain("synthesis · completed");
});
it("shows a revision as the settings it changes before Restore, its raw configuration behind a disclosure", async () => {
  const f = fixture();
  const client: SettingsClient = {
    request: async (command, payload, options) => {
      const input = payload as Record<string, unknown>;
      if (input["action"] === "revisions")
        return {
          ok: true,
          result: {
            items: [
              { revision: 2, changeSummary: "Latest", createdAt: "now" },
              { revision: 1, changeSummary: "Original version", createdAt: "now" },
            ],
            nextBeforeRevision: null,
          },
        };
      const answer = await f.client.request(command, payload, options);
      if (input["action"] !== "get" || input["revision"] !== 1) return answer;
      const detail = answer.result as { readonly revision: { readonly snapshot: Record<string, unknown> } };
      return {
        ok: true,
        result: {
          ...detail,
          revision: {
            revision: 1,
            snapshot: {
              ...detail.revision.snapshot,
              objective: "Original objective",
              triggers: [{ id: "morning", kind: "daily", at: "07:00", timezone: "Europe/Sofia" }],
            },
          },
        },
      };
    },
  };
  const page = await schedule(client);
  await click(page, "LLM news");
  // The current settings read as settings; the JSON is there only on asking.
  const settings = [...page.querySelectorAll("details")].find((item) =>
    item.querySelector("summary")?.textContent?.startsWith("Current models"),
  )!;
  expect(settings.querySelector(".summary-grid")).not.toBeNull();
  expect(settings.querySelector(":scope > pre")).toBeNull();
  expect(settings.querySelector(":scope details > summary")?.textContent).toBe("Raw configuration (JSON)");

  await click(page, "Revision 1: Original version");
  const dialog = page.querySelector("dialog")!;
  expect(dialog.textContent).toContain("Restoring it changes 2 settings from the current revision (2):");
  const changes = [...dialog.querySelectorAll(".revision-diff > div")].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector(".revision-diff-now")?.textContent,
    row.querySelector(".revision-diff-then")?.textContent,
  ]);
  expect(changes).toEqual([
    ["Objective", "Now Find news", "Revision 1 Original objective"],
    ["Triggers › morning › at", "Now 09:00", "Revision 1 07:00"],
  ]);
  const raw = dialog.querySelector("details")!;
  expect(raw.open).toBe(false);
  expect(raw.querySelector("summary")?.textContent).toBe("Raw configuration (JSON)");
  expect(raw.querySelector("pre")?.textContent).toContain('"objective": "Original objective"');
  await click(page, "Restore as a new revision");
  expect(f.sent.find((input) => input["action"] === "undo")).toMatchObject({ action: "undo", revision: 1, expectedVersion: 3 });

  // The newest revision is what is current: nothing to restore.
  await click(page, "Revision 2: Latest");
  expect(page.querySelector("dialog")?.textContent).toContain("This is the current revision.");
  expect(
    [...page.querySelectorAll<HTMLButtonElement>("dialog button")].find((item) => item.textContent === "Restore as a new revision")
      ?.disabled,
  ).toBe(true);
});
it("names an item in a revision's changes by its id as written, and a setting unset either way is no change", async () => {
  const f = fixture([{ id: "morningRun", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }]);
  const client: SettingsClient = {
    request: async (command, payload, options) => {
      const input = payload as Record<string, unknown>;
      if (input["action"] === "revisions")
        return {
          ok: true,
          result: {
            items: [
              { revision: 2, changeSummary: "Latest", createdAt: "now" },
              { revision: 1, changeSummary: "Original version", createdAt: "now" },
            ],
            nextBeforeRevision: null,
          },
        };
      const answer = await f.client.request(command, payload, options);
      if (input["action"] !== "get") return answer;
      const detail = answer.result as { readonly revision: { readonly snapshot: Record<string, unknown> } };
      const { window: _window, ...delivery } = detail.revision.snapshot["delivery"] as Record<string, unknown>;
      const revision =
        input["revision"] === 1
          ? {
              revision: 1,
              snapshot: {
                ...detail.revision.snapshot,
                delivery: { ...delivery, window: null },
                triggers: [{ id: "morningRun", kind: "daily", at: "07:00", timezone: "Europe/Sofia" }],
              },
            }
          : { ...detail.revision, snapshot: { ...detail.revision.snapshot, delivery } };
      return { ok: true, result: { ...detail, revision } };
    },
  };
  const page = await schedule(client);
  await click(page, "LLM news");
  await click(page, "Revision 1: Original version");
  const dialog = page.querySelector("dialog")!;
  expect(dialog.textContent).toContain("Restoring it changes one setting from the current revision (2):");
  const changes = [...dialog.querySelectorAll(".revision-diff > div")].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector(".revision-diff-now")?.textContent,
    row.querySelector(".revision-diff-then")?.textContent,
  ]);
  expect(changes).toEqual([["Triggers › morningRun › at", "Now 09:00", "Revision 1 07:00"]]);
});
it("resumes a delivery target separately from an acknowledged resend", async () => {
  const f = fixture();
  const client: SettingsClient = {
    request: async (command, payload, options) => {
      const answer = await f.client.request(command, payload, options);
      if ((payload as Record<string, unknown>)["action"] !== "inspect") return answer;
      return {
        ok: true,
        result: {
          ...(answer.result as Record<string, unknown>),
          deliveries: [
            {
              jobId: "job",
              status: "deferred",
              updatedAt: "now",
              data: { targetId: "target", target: { label: "Private chat" }, error: "Delivery paused" },
            },
          ],
        },
      };
    },
  };
  const page = await schedule(client);
  await click(page, "LLM news");
  await openRun(page);
  expect([...page.querySelectorAll("button")].find((button) => button.textContent === "Resend original PDF")!.disabled).toBe(true);
  await click(page, "Resume this delivery target");
  expect(f.sent).toContainEqual({ action: "resume_delivery", routineId: "routine", targetId: "target", workspaceId: "team" });
});
it("allows removing a revoked selected destination but prevents selecting it again", async () => {
  const f = fixture();
  const client: SettingsClient = {
    request: async (command, payload, options) => {
      const action = (payload as Record<string, unknown>)["action"];
      if (action === "targets") return { ok: true, result: { targets: [{ targetId: "revoked", label: "Old chat", authorized: false }] } };
      const answer = await f.client.request(command, payload, options);
      if (action !== "get") return answer;
      const detail = answer.result as { revision: { snapshot: Record<string, unknown> } };
      return {
        ok: true,
        result: {
          ...detail,
          revision: {
            ...detail.revision,
            snapshot: { ...detail.revision.snapshot, delivery: { ...routineDefaults("Europe/Sofia").delivery, targetIds: ["revoked"] } },
          },
        },
      };
    },
  };
  const page = await schedule(client);
  await click(page, "LLM news");
  await click(page, "Edit routine");
  const checkbox = [...page.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
    input.closest("label")?.textContent?.includes("Old chat"),
  )!;
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(false);
  await act(async () => checkbox.click());
  expect(checkbox.checked).toBe(false);
  expect(checkbox.disabled).toBe(true);
  await act(async () => page.querySelector("dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const edit = f.sent.find((input) => input["action"] === "edit")!;
  // Only the fields the form changes, against the revision it read: an evaluation finishing meanwhile is no conflict.
  expect(edit).toMatchObject({ expectedRevision: expect.any(Number), edit: { delivery: { targetIds: [] } } });
  expect(edit).not.toHaveProperty("expectedVersion");
  expect((edit["edit"] as Record<string, unknown>)["delivery"]).toEqual({ targetIds: [] });
  expect(Object.keys((edit["edit"] as Record<string, Record<string, unknown>>)["report"]!).sort()).toEqual([
    "formats",
    "maxItems",
    "style",
  ]);
});

it("lets a run ask its destination, with a default, only once there is a destination", async () => {
  const f = fixture();
  const client: SettingsClient = {
    request: async (command, payload, options) => {
      const action = (payload as Record<string, unknown>)["action"];
      if (action === "targets") return { ok: true, result: { targets: [{ targetId: "chat", label: "Team chat", authorized: true }] } };
      return f.client.request(command, payload, options);
    },
  };
  const page = await schedule(client);
  await click(page, "LLM news");
  await click(page, "Edit routine");
  const select = page.querySelector<HTMLButtonElement>('[aria-label="Questions while it runs"]')!;
  // No destination yet: nowhere to ask, so it stays off.
  expect(select.disabled).toBe(true);
  expect(select.textContent).toContain("Never ask");
  expect(page.textContent).toContain("Choose a destination above to let a run ask you something.");
  const checkbox = [...page.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
    input.closest("label")?.textContent?.includes("Team chat"),
  )!;
  await act(async () => checkbox.click());
  expect(select.disabled).toBe(false);
  // jsdom has no layout: the open list scrolls its choice into view through a stand-in.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  try {
    await act(async () => select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const option = [...page.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
      item.textContent?.includes("Ask the destination"),
    )!;
    await act(async () => {
      option.focus();
      option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    // The list's own scroll runs a frame and a moment after it opened.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  expect(page.textContent).toContain("always with the option it takes if you don't answer in time");
  await act(async () => page.querySelector("dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(f.sent.find((input) => input["action"] === "edit")).toMatchObject({
    edit: { delivery: { targetIds: ["chat"] }, humanCheckpoints: "ask-with-default" },
  });
});

it("shows a run's questions with how each was settled, and keeps an answer for the next time", async () => {
  const f = fixture();
  const page = await schedule(f.client);
  await click(page, "LLM news");
  await openRun(page);
  const questions = [...page.querySelectorAll(".routine-checkpoints li")];
  expect(questions.map((item) => item.querySelector(".muted:not(span)")?.textContent?.split(" · ")[0])).toEqual([
    "Ship, answered via telegram-main",
    "nobody answered; the default No was taken",
  ]);
  // Only a person's answer can stand for next time; a default cannot.
  expect(questions[1]?.querySelector("button")).toBeNull();
  await click(page, "Always answer Ship for this routine");
  expect(f.sent).toContainEqual({ action: "always_answer", routineId: "routine", waitId: "w-1", answers: ["Ship"], workspaceId: "team" });
  expect(page.textContent).toContain("Kept: questions like this are answered Ship from now on.");
  // The timeline says them as receipts too.
  const timeline = [...page.querySelectorAll(".item-title-text")].map((item) => item.textContent);
  expect(timeline).toContain("synthesis · asked: Ship the report today?");
  expect(timeline).toContain("synthesis · nobody answered; the default Hold was taken");
});

it("lists the answers a routine gives without asking, and forgets one at once", async () => {
  const f = fixture();
  const page = await schedule(f.client);
  await click(page, "LLM news");
  await click(page, "Edit routine");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(page.querySelector(".standing-answers")?.textContent).toContain("Ship the report today? → Ship");
  await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="Forget the answer to Ship the report today?"]')!.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(f.sent).toContainEqual({ action: "forget_answer", routineId: "routine", questionKey: "ship", workspaceId: "team" });
  expect(page.querySelector(".standing-answers")).toBeNull();
});

it("shows a run's resolved research authority and lets the operator revoke it", async () => {
  const f = fixture();
  const client: SettingsClient = {
    request: async (command, payload, options) => {
      const answer = await f.client.request(command, payload, options);
      if ((payload as Record<string, unknown>)["action"] !== "inspect") return answer;
      // Revocation is offered only while the run can still resolve an effect.
      return {
        ok: true,
        result: {
          ...(answer.result as Record<string, unknown>),
          run: { ...(answer.result as { run: Record<string, unknown> }).run, status: "running" },
        },
      };
    },
  };
  const page = await schedule(client);
  await click(page, "LLM news");
  await openRun(page);
  expect(page.textContent).toContain("Research authority");
  expect(page.textContent).toContain("Grant grant-1 · policy revision 4 · pinned from revision 1 · production · egress open_web. Live.");
  expect(page.textContent).toContain("Fetch hosts: example.com, news.example.org");
  // The effective set is what the adapter would grant; the revision's unusable
  // tool is reported as narrowed rather than shown as authorized.
  expect(page.textContent).toContain("Research tools: web_search, http.request");
  expect(page.textContent).toContain("Tools the revision declared that no research path exposes: messaging.send_to");
  await click(page, "Revoke this run's grant");
  expect(f.sent).toContainEqual({ action: "revoke_grant", runId: "run", reason: "Revoked from the run inspector", workspaceId: "team" });
});

it("shows what a ledger verification establishes, and what it does not", async () => {
  const f = fixture();
  const page = await schedule(f.client);
  await click(page, "LLM news");
  await click(page, "Verify this routine's ledger");
  expect(page.textContent).toContain("The ledger's local chain is intact over 12 events; head aaaaaaaaaaaaaaaa…; 2 pruned details.");
  expect(f.sent).toContainEqual({ action: "verify", routineId: "routine", workspaceId: "team" });
  // The limitation is rendered with the verdict, so the page never claims more
  // than a local chain can support.
  expect(page.textContent).toContain("not detectable without an anchor");
});

it("shows research health separately from delivery health, and never calls a stale heartbeat offline", async () => {
  const f = fixture();
  const page = await schedule(f.client);
  await click(page, "LLM news");
  await click(page, "Check readiness");
  expect(f.sent).toContainEqual({ action: "readiness", routineId: "routine", workspaceId: "team" });
  expect(fact(page, "Research")).toMatch(/^ready ·/);
  expect(fact(page, "Delivery")).toBe("blocked (unauthorized)");
  expect(page.textContent).toContain("renderer available (fixture)");
  expect(page.textContent).toContain("heartbeat is current");

  // A stale heartbeat is reported as unknown, not as an offline diagnosis.
  const stale: SettingsClient = {
    request: async (command, payload, options) => {
      const answer = await f.client.request(command, payload, options);
      if ((payload as Record<string, unknown>)["action"] !== "readiness") return answer;
      const view = answer.result as { owner: Record<string, unknown> };
      return {
        ok: true,
        result: { ...(answer.result as Record<string, unknown>), owner: { ...view, state: "stale", heartbeatAgeMs: 600_000 } },
      };
    },
  };
  const other = await schedule(stale);
  await click(other, "LLM news");
  await click(other, "Check readiness");
  expect(other.textContent).toContain("the owner's state is unknown");
  expect(other.textContent).not.toContain("offline");
});

it("says each checkpoint in the timeline as its receipt", () => {
  const line = (code: "asked" | "answered", checkpoint: Record<string, unknown>) =>
    checkpointLine({ version: 1, code, checkpoint } as never);
  expect(line("asked", { question: "Ship?" })).toBe("asked: Ship?");
  expect(line("answered", { outcome: "answered", answers: ["Ship"], via: "bridge" })).toBe("answered Ship via web");
  expect(line("answered", { outcome: "answered", answers: ["Ship"], via: "standing-answer", question: "Ship?" })).toBe(
    "answered Ship by your standing answer: Ship?",
  );
  expect(line("answered", { outcome: "defaulted", answers: ["Hold"] })).toBe("nobody answered; the default Hold was taken");
  expect(line("answered", { outcome: "defaulted" })).toBe("nobody answered; went on without one");
  expect(line("answered", { outcome: "undelivered" })).toBe("the question could not be sent; went on without asking");
  expect(line("answered", { outcome: "withdrawn" })).toBe("the question was withdrawn");
  expect(checkpointLine({ version: 1, code: "model" } as never)).toBeUndefined();
});

it("says on the routine page that the model changed it after its chat read untrusted content, until the person edits it", async () => {
  const f = fixture();
  const provenance = {
    integrity: "untrusted",
    sources: ["web"],
    refs: [{ source: "web", ref: "call-1", host: "deals.example", title: "<b>Ignore</b> all", at: "2026-10-13T09:00:00.000Z" }],
  };
  const client: SettingsClient = {
    request: async (command, payload, options) => {
      const answer = await f.client.request(command, payload, options);
      if ((payload as Record<string, unknown>)["action"] !== "get") return answer;
      const detail = answer.result as { revision: Record<string, unknown> };
      return { ok: true, result: { ...detail, revision: { ...detail.revision, provenance } } };
    },
  };
  const page = await schedule(client);
  await click(page, "LLM news");
  const note = page.querySelector(".routine-provenance");
  expect(note?.textContent).toBe(
    "Changed by Tavi after its chat read a web page (deals.example) — the page calls itself “‹b›Ignore‹/b› all”. Check its objective and instructions; editing them yourself clears this note.",
  );
  expect(note?.querySelector("b")).toBeNull();
});
it("shows no provenance note for a routine with none", async () => {
  const page = await schedule(fixture().client);
  await click(page, "LLM news");
  expect(page.querySelector(".routine-provenance")).toBeNull();
});
it("says on the routine page that a run pinning another author's skill starts tainted, and why", async () => {
  const f = fixture();
  const foreignSkills = [{ skillId: "research", version: "2", source: "archive" }];
  const client: SettingsClient = {
    request: async (command, payload, options) => {
      const answer = await f.client.request(command, payload, options);
      if ((payload as Record<string, unknown>)["action"] !== "get") return answer;
      return { ok: true, result: { ...(answer.result as Record<string, unknown>), foreignSkills } };
    },
  };
  const page = await schedule(client);
  await click(page, "LLM news");
  expect(page.querySelector(".routine-foreign-skills")?.textContent).toBe(
    "research (version 2, imported from an archive) was written by someone other than you, so each run starts as one that read untrusted content: a tool call that would ask you first is refused, since nobody is there to answer.",
  );
  const plain = await schedule(fixture().client);
  await click(plain, "LLM news");
  expect(plain.querySelector(".routine-foreign-skills")).toBeNull();
});

/** Sets a field found by any selector, as typing it would. */
async function type(input: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )?.set?.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submitDialog = (page: HTMLElement) =>
  act(async () => page.querySelector("dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const labelled = <T extends Element>(page: HTMLElement, text: string, selector: string) =>
  [...page.querySelectorAll("dialog label")].find((label) => label.firstChild?.textContent?.trim() === text)?.querySelector<T>(selector);

it("edits a routine's name, objective and triggers, sending only what changed", async () => {
  const f = fixture();
  const page = await schedule(f.client);
  await click(page, "LLM news");
  await click(page, "Edit routine");
  await submitDialog(page);
  const untouched = f.sent.filter((input) => input["action"] === "edit").at(-1)!["edit"] as Record<string, unknown>;
  expect(untouched).not.toHaveProperty("name");
  expect(untouched).not.toHaveProperty("objective");
  expect(untouched).not.toHaveProperty("triggers");
  await click(page, "Edit routine");
  await type(labelled<HTMLInputElement>(page, "Name", "input"), "Model news");
  await type(labelled<HTMLTextAreaElement>(page, "Objective", "textarea"), "Find model releases");
  const cadence = page.querySelector<HTMLElement>("dialog .cadence")!;
  expect(cadence.querySelector("legend")?.textContent).toBe("When");
  expect(cadence.querySelector<HTMLInputElement>('input[aria-label="Time zone"]')?.value).toBe("Europe/Sofia");
  await type(cadence.querySelector<HTMLInputElement>('input[type="time"]'), "07:00");
  await click(cadence, "Weekdays");
  await click(page, "Add a trigger");
  const second = page.querySelectorAll<HTMLElement>("dialog .cadence")[1]!;
  expect(second.querySelector("legend")?.textContent).toBe("Trigger 2");
  await act(async () => second.querySelector<HTMLInputElement>('input[type="radio"][value="once"]')!.click());
  // A one-off trigger runs once, at one time.
  expect([...second.querySelectorAll("button")].some((button) => button.textContent === "Add a time")).toBe(false);
  expect(second.querySelector('[aria-label="Times of day"]')).toBeNull();
  await type(second.querySelector<HTMLInputElement>('input[type="date"]'), "2026-12-01");
  await type(second.querySelector<HTMLInputElement>('input[type="time"]'), "10:30");
  await submitDialog(page);
  expect(f.sent.filter((input) => input["action"] === "edit").at(-1)).toMatchObject({
    edit: {
      name: "Model news",
      objective: "Find model releases",
      triggers: [
        { id: "morning", kind: "daily", at: "07:00", timezone: "Europe/Sofia", daysOfWeek: [1, 2, 3, 4, 5] },
        // 10:30 in Sofia on 1 December (winter time, UTC+2).
        { id: "trigger-2", kind: "once", runAt: "2026-12-01T08:30:00.000Z" },
      ],
    },
  });
});

it("sends a one-off trigger left as it was exactly as stored, and lets a passed one stand", async () => {
  const fired = { id: "a", kind: "once", runAt: "2025-03-01T08:30:45Z" };
  const f = fixture([fired, { id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }]);
  const page = await schedule(f.client);
  await click(page, "LLM news");
  await click(page, "Edit routine");
  const [first, second] = page.querySelectorAll<HTMLElement>("dialog .cadence");
  const on = first!.querySelector<HTMLInputElement>('input[type="date"]')!;
  expect(on.value).toBe("2025-03-01");
  expect(on.hasAttribute("min")).toBe(false);
  await type(second!.querySelector<HTMLInputElement>('input[type="time"]'), "07:00");
  await submitDialog(page);
  const edit = f.sent.filter((input) => input["action"] === "edit").at(-1)!["edit"] as Record<string, unknown>;
  expect(edit["triggers"]).toEqual([fired, { id: "morning", kind: "daily", at: "07:00", timezone: "Europe/Sofia" }]);
});

it("creates a routine at a daily time as before, and on chosen days as its one trigger", async () => {
  const f = fixture();
  const client: SettingsClient = {
    request: async (command, payload, options) => {
      const action = (payload as Record<string, unknown>)["action"];
      if (action === "create") {
        f.sent.push(payload as Record<string, unknown>);
        const detail = (await f.client.request(command, { ...(payload as object), action: "get" }, options)).result;
        return { ok: true, result: detail };
      }
      return f.client.request(command, payload, options);
    },
  };
  const page = await schedule(client);
  await click(page, "New routine");
  // It starts empty, its examples only placeholders: saving it as it opens creates nothing.
  const name = page.querySelector<HTMLInputElement>("dialog input:not([type])")!;
  const objective = page.querySelector<HTMLTextAreaElement>("dialog textarea")!;
  expect([name.value, name.placeholder]).toEqual(["", "News watch"]);
  expect([objective.value, objective.placeholder]).toEqual(["", "Find the latest news and material updates on a topic"]);
  await submitDialog(page);
  expect(f.sent.some((input) => input["action"] === "create")).toBe(false);
  expect(page.querySelector("dialog")?.textContent).toContain("Enter a name and an objective.");
  const fillIn = async () => {
    await type(page.querySelector<HTMLInputElement>("dialog input:not([type])"), "News watch");
    await type(page.querySelector<HTMLTextAreaElement>("dialog textarea"), "Find the latest news and material updates on a topic");
  };
  await fillIn();
  await submitDialog(page);
  const plain = f.sent.filter((input) => input["action"] === "create").at(-1)!;
  expect(plain["setup"]).toEqual({
    name: "News watch",
    objective: "Find the latest news and material updates on a topic",
    at: "09:00",
    timezone: "UTC",
  });
  await click(page, "← Schedule");
  await click(page, "New routine");
  await fillIn();
  const cadence = page.querySelector<HTMLElement>("dialog .cadence")!;
  await type(cadence.querySelector<HTMLInputElement>('input[aria-label="Time zone"]'), "Europe/Sofia");
  await act(async () => cadence.querySelector<HTMLInputElement>('input[type="radio"][value="monthly"]')!.click());
  await pick(cadence.querySelector('[aria-label="Monthly on"]'), "weekday");
  await pick(cadence.querySelector('[aria-label="Which week"]'), "-1");
  await pick(cadence.querySelector('[aria-label="Weekday"]'), "5");
  await submitDialog(page);
  expect(f.sent.filter((input) => input["action"] === "create").at(-1)!["setup"]).toEqual({
    name: "News watch",
    objective: "Find the latest news and material updates on a topic",
    triggers: [{ id: "cadence", kind: "daily", at: "09:00", timezone: "Europe/Sofia", monthly: { nth: -1, weekday: 5 } }],
    timezone: "Europe/Sofia",
  });
});

it("asks before cancelling a live run, and Keep running sends nothing", async () => {
  const f = fixture();
  const live: SettingsClient = {
    request: async (command, payload, options) => {
      const answer = await f.client.request(command, payload, options);
      if ((payload as Record<string, unknown>)["action"] !== "inspect") return answer;
      const result = (answer as { result: { run: Record<string, unknown> } }).result;
      return { ok: true, result: { ...result, run: { ...result.run, status: "running", endedAt: null } } } as never;
    },
  };
  const page = await schedule(live);
  await click(page, "LLM news");
  await openRun(page);
  const cancels = () => f.sent.filter((input) => input["action"] === "cancel");
  await click(page, "Cancel run");
  expect(cancels()).toHaveLength(0);
  expect(page.textContent).toContain("Stop this run now?");
  await click(page, "Keep running");
  expect(cancels()).toHaveLength(0);
  expect(page.textContent).not.toContain("Stop this run now?");
  await click(page, "Cancel run");
  await click(page, "Cancel run");
  expect(cancels()).toEqual([{ action: "cancel", runId: "run", workspaceId: "team" }]);
});

it("duplicates a routine from its row in Recurring: the create form filled from its setup, its instructions shown, every trigger copied", async () => {
  const f = fixture([
    { id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" },
    { id: "evening", kind: "daily", at: "19:00", timezone: "Europe/Sofia", daysOfWeek: [1] },
  ]);
  const provenance = {
    integrity: "untrusted",
    sources: ["web"],
    refs: [{ source: "web", ref: "call-1", host: "deals.example", at: "2026-10-13T09:00:00.000Z" }],
  };
  const opened: (string | undefined)[] = [];
  const creating: SettingsClient = {
    request: async (command, payload, options) => {
      const answer = await f.client.request(command, payload, options);
      if ((payload as Record<string, unknown>)["action"] === "get") {
        const detail = answer.result as { revision: Record<string, unknown> };
        return { ok: true, result: { ...detail, revision: { ...detail.revision, provenance } } };
      }
      if ((payload as Record<string, unknown>)["action"] !== "create") return answer;
      opened.push("copy");
      return { ok: true, result: { routine: { routineId: "copy" } } } as never;
    },
  };
  const page = await schedule(creating);
  const row = page.querySelector('[data-row-key="routine:routine"]')!;
  // One order of controls for every kind: Run now, the switch, More.
  expect([...row.querySelectorAll(".schedule-recurring-controls > *")].map((item) => item.getAttribute("aria-label") ?? "")).toEqual([
    "Run now: LLM news",
    "Pause LLM news",
    "",
  ]);
  const more = row.querySelector<HTMLButtonElement>('[aria-label="More actions for LLM news"]')!;
  await act(async () => more.click());
  expect([...page.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["Edit", "Duplicate", "Archive"]);
  await click(page, "Duplicate");
  const dialog = page.querySelector("dialog")!;
  expect(dialog.querySelector(".modal-title, h2")?.textContent).toContain("Create routine");
  expect([...dialog.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === "LLM news (copy)")).toBeDefined();
  expect(dialog.querySelector("textarea")?.value).toBe("Find news");
  expect(dialog.textContent).toContain("Its other trigger is copied as it is.");
  // The words copied are shown before they are saved, with where they came from.
  expect(dialog.querySelector(".routine-provenance")?.textContent).toContain(
    "Changed by Tavi after its chat read a web page (deals.example)",
  );
  expect(dialog.querySelectorAll("textarea")[1]?.value).toBe("Pinned researcher instructions");
  expect(dialog.textContent).toContain("Its report style, skills, models and first destination are copied too.");
  await act(async () => dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const created = f.sent.find((input) => input["action"] === "create");
  expect(created?.["copyOf"]).toBe("routine");
  expect(created?.["setup"]).toMatchObject({
    name: "LLM news (copy)",
    objective: "Find news",
    instructions: "Pinned researcher instructions",
    skills: [],
    timezone: "Europe/Sofia",
    triggers: [
      { id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" },
      { id: "evening", kind: "daily", at: "19:00", timezone: "Europe/Sofia", daysOfWeek: [1] },
    ],
  });
  expect(opened).toEqual(["copy"]);
});

it("archives a routine from its row only once confirmed", async () => {
  const f = fixture();
  const page = await schedule(f.client);
  await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="More actions for LLM news"]')!.click());
  await click(page, "Archive");
  expect(f.sent.some((input) => input["action"] === "archive")).toBe(false);
  const dialog = page.querySelector("dialog")!;
  await click(dialog, "Archive");
  expect(f.sent).toContainEqual({ action: "archive", routineId: "routine", expectedVersion: 3, workspaceId: "team" });
});
