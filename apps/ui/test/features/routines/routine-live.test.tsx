// @vitest-environment jsdom
import { routineDefaults } from "@tavi/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoutineOverview } from "../../../src/features/routines/RoutineOverview.js";
import { RunInspector } from "../../../src/features/routines/RunInspector.js";
import { settingsPath } from "../../../src/features/shell/route.js";
import { LIVE_POLL_MS } from "../../../src/hooks/use-poll.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { button, click, mountSettled, rerender, settle, unmountAll } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

/**
 * A routine's page and a run's page stay current: a feed change reads the
 * routine again, a live run is read again until it settles, Run now opens the
 * run it started, and a status notice carries the one action that fixes it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.useRealTimers());

const now = "2026-10-28T06:00:00.000Z";
const snapshot = {
  ...routineDefaults("Europe/Sofia"),
  objective: "Find news",
  agent: { agentId: "news", name: "Researcher", revision: 1, instructions: "Pinned", hash: "a".repeat(64) },
  skills: [],
};

/** A routine as `get` reports it, its status and stored state varied per case. */
function detail(status: string, state: unknown = {}, evaluation: Record<string, unknown> = { status: "passed", detail: "" }) {
  return {
    routine: {
      routineId: "routine",
      workspaceId: "default",
      principalId: "operator",
      name: "LLM news",
      status,
      version: 3,
      activeRevision: 1,
      latestRevision: 1,
    },
    revision: { revision: 1, snapshot },
    evaluation,
    schedules: [],
    state,
    hostStatus: "Local owner must remain running",
  };
}

/** An owner answering the routine's page, recording every request; `answers` overrides an action's answer. */
function owner(routine: unknown, answers: Record<string, unknown> = {}) {
  const sent: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (_command, raw) => {
      const input = raw as Record<string, unknown>;
      sent.push(input);
      const action = String(input["action"]);
      if (action in answers) return { ok: true, result: answers[action] } as never;
      const result =
        action === "get"
          ? routine
          : action === "history"
            ? { runs: [] }
            : action === "revisions"
              ? { items: [], nextBeforeRevision: null }
              : action === "readiness"
                ? {
                    routineId: "routine",
                    revision: { active: 1, latest: 1, candidate: null },
                    research: { ready: false, blockedBy: "credential", tools: [], hosts: [], networkMode: "allowlist" },
                    delivery: { authorized: true, blockedBy: null, targets: [] },
                    owner: { heartbeatAt: now, state: "live", heartbeatAgeMs: 5 },
                    renderer: null,
                    schedule: null,
                  }
                : {};
      return { ok: true, result } as never;
    },
  };
  const count = (action: string) => sent.filter((input) => input["action"] === action).length;
  return { client, sent, count };
}

function Overview({
  client,
  revision = 0,
  onOpenRun = () => {},
}: {
  client: SettingsClient;
  revision?: number;
  onOpenRun?: (runId: string | undefined) => void;
}) {
  return (
    <InWorkspace client={client} workspaceId="default">
      <RoutineOverview
        routineId="routine"
        revision={revision}
        runId={undefined}
        onOpenRun={onOpenRun}
        onClose={() => {}}
        onFollow={async () => {}}
        changed={() => {}}
        timeZone="UTC"
      />
    </InWorkspace>
  );
}

describe("a routine's page", () => {
  it("reads the routine and its runs again when the feed moves", async () => {
    const fake = owner(detail("active"));
    await mountSettled(<Overview client={fake.client} />);
    expect([fake.count("get"), fake.count("history")]).toEqual([1, 1]);
    await rerender(<Overview client={fake.client} revision={1} />);
    await settle();
    expect([fake.count("get"), fake.count("history")]).toEqual([2, 2]);
  });

  it("opens the run Run now started", async () => {
    const opened: (string | undefined)[] = [];
    const fake = owner(detail("active"), { run: { runId: "run-new", routineId: "routine", status: "queued" } });
    const page = await mountSettled(<Overview client={fake.client} onOpenRun={(runId) => opened.push(runId)} />);
    await click(button(page, "Run now"));
    await settle();
    expect(fake.sent.find((input) => input["action"] === "run")).toMatchObject({ action: "run", routineId: "routine" });
    expect(opened).toEqual(["run-new"]);
  });

  it("says the run started, with the way to it, when the owner's answer names no run", async () => {
    const opened: (string | undefined)[] = [];
    const fake = owner(detail("active"), { run: {} });
    const page = await mountSettled(<Overview client={fake.client} onOpenRun={(runId) => opened.push(runId)} />);
    await click(button(page, "Run now"));
    await settle();
    expect(opened).toEqual([]);
    expect(page.textContent).toContain("Run started.");
    expect(button(page, "See it under Runs")).toBeDefined();
    expect(page.textContent).not.toContain("Refresh to see");
  });

  it("opens the preview run it started", async () => {
    const opened: (string | undefined)[] = [];
    const fake = owner(detail("active"), { preview: { runId: "run-preview" } });
    const page = await mountSettled(<Overview client={fake.client} onOpenRun={(runId) => opened.push(runId)} />);
    await click(button(page, "Preview latest revision"));
    await settle();
    expect(opened).toEqual(["run-preview"]);
  });

  it("links a credential-blocked routine's notice to Credentials, and checks its readiness on its own", async () => {
    const fake = owner(detail("credential-blocked"));
    const page = await mountSettled(<Overview client={fake.client} />);
    const link = [...page.querySelectorAll<HTMLAnchorElement>(".status-notice a")].find((item) => item.textContent === "Open credentials");
    expect(link?.getAttribute("href")).toBe(settingsPath("credentials"));
    expect(fake.count("readiness")).toBe(1);
    expect(page.textContent).toContain("blocked by credential");
  });

  it("checks readiness from the notice of a routine paused after failures, as well as on its own", async () => {
    const fake = owner(detail("paused-failures"));
    const page = await mountSettled(<Overview client={fake.client} />);
    expect(fake.count("readiness")).toBe(1);
    const notice = page.querySelector(".status-notice");
    await click(button(notice!, "Check readiness"));
    await settle();
    expect(fake.count("readiness")).toBe(2);
  });

  it("does not check the readiness of a routine nothing blocks", async () => {
    const fake = owner(detail("active"));
    await mountSettled(<Overview client={fake.client} />);
    expect(fake.count("readiness")).toBe(0);
  });

  it("resumes a paused delivery target from the routine's own page", async () => {
    const paused = { data: { deliveryHealth: { "target-1": { failures: 3, blockedSince: null, notified: true } } } };
    const fake = owner(detail("active", paused), { resume_delivery: { resumed: true } });
    const page = await mountSettled(<Overview client={fake.client} />);
    expect(page.querySelector(".status-notice")?.textContent).toContain("Delivery is paused");
    await click(button(page, "Resume delivery"));
    await settle();
    expect(fake.sent.find((input) => input["action"] === "resume_delivery")).toEqual({
      action: "resume_delivery",
      routineId: "routine",
      targetId: "target-1",
      workspaceId: "default",
    });
    expect(page.textContent).toContain("LLM news's delivery resumed");
  });

  it("says an active routine has not been tried on its own topic, and previews it from the notice", async () => {
    const fake = owner({ ...detail("active"), topicNotice: "Not yet tried on its own topic." }, { preview: { runId: "run-preview" } });
    const opened: (string | undefined)[] = [];
    const page = await mountSettled(<Overview client={fake.client} onOpenRun={(runId) => opened.push(runId)} />);
    expect(page.querySelector(".status-notice")?.textContent).toContain("Not yet tried on its topic");
    await click(button(page, "Preview"));
    await settle();
    expect(fake.sent.find((input) => input["action"] === "preview")).toMatchObject({
      action: "preview",
      routineId: "routine",
      revision: 1,
      workspaceId: "default",
    });
    expect(opened).toEqual(["run-preview"]);
  });

  it("says nothing about its topic once a run of it has published a report", async () => {
    const page = await mountSettled(<Overview client={owner(detail("active")).client} />);
    expect(page.querySelector(".status-notice")).toBeNull();
  });

  it("does not open the run it started once the person has left the page", async () => {
    const opened: (string | undefined)[] = [];
    let answer = (): void => {};
    const fake = owner(detail("active"), { run: { runId: "run-new" } });
    const client: SettingsClient = {
      request: (command, raw) => {
        const reply = fake.client.request(command, raw);
        if ((raw as Record<string, unknown>)["action"] !== "run") return reply;
        return new Promise((done) => {
          answer = () => done(reply);
        });
      },
    };
    const page = await mountSettled(<Overview client={client} onOpenRun={(runId) => opened.push(runId)} />);
    await click(button(page, "Run now"));
    unmountAll();
    answer();
    await settle();
    expect(opened).toEqual([]);
  });

  it("says delivery is paused by the active revision's threshold, not a newer revision's", async () => {
    const paused = { data: { deliveryHealth: { "target-1": { failures: 3, blockedSince: null, notified: true } } } };
    const latest = {
      ...detail("active", paused),
      routine: { ...detail("active").routine, latestRevision: 2 },
      revision: { revision: 2, snapshot: { ...snapshot, execution: { ...snapshot.execution, failureThreshold: 5 } } },
    };
    const fake = owner(latest);
    const client: SettingsClient = {
      request: async (command, raw) => {
        const input = raw as Record<string, unknown>;
        if (input["action"] === "get" && input["revision"] === 1) return { ok: true, result: detail("active", paused) } as never;
        return fake.client.request(command, raw);
      },
    };
    const page = await mountSettled(<Overview client={client} />);
    await settle();
    expect(page.querySelector(".status-notice")?.textContent).toContain("Delivery is paused");
  });

  it("shows a code span in a status as code, never with its backticks", async () => {
    const fake = owner(detail("setup-needed", {}, { status: "pending", detail: "" }));
    const page = await mountSettled(<Overview client={fake.client} />);
    const notice = page.querySelector(".status-notice");
    expect(notice?.textContent).not.toContain("`");
    expect(notice?.querySelector("code")?.textContent).toBe("tavi serve");
  });
});

describe("a run's page", () => {
  const run = (status: string) => ({
    runId: "run",
    routineId: "routine",
    revision: 1,
    mode: "production",
    status,
    claimedAt: now,
    startedAt: now,
    endedAt: status === "running" ? null : now,
    snapshot: {},
    data: { modelCalls: 1, tokensKnown: 1, usageComplete: true },
  });
  /** An owner whose run is `status()` at each read. */
  function runOwner(status: () => string) {
    const sent: string[] = [];
    const client: SettingsClient = {
      request: async (_command, raw) => {
        const input = raw as Record<string, unknown>;
        const action = String(input["action"]);
        sent.push(action);
        const result =
          action === "inspect"
            ? { run: run(status()), publication: null, deliveries: [], attempts: [] }
            : action === "ledger"
              ? { events: [] }
              : action === "sources"
                ? { sources: [], nextAfterSourceId: null }
                : {};
        return { ok: true, result } as never;
      },
    };
    return { client, count: (action: string) => sent.filter((item) => item === action).length };
  }
  const inspector = (client: SettingsClient) => (
    <InWorkspace client={client} workspaceId="default">
      <RunInspector timeZone="UTC" routineId="routine" routineName="LLM news" runId="run" onBack={() => {}} onFollow={async () => {}} />
    </InWorkspace>
  );
  const beat = async () => {
    await act(async () => vi.advanceTimersByTime(LIVE_POLL_MS));
    await settle();
  };

  it("reads a live run and its records again until it settles, then once more, then stops", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let status = "running";
    const fake = runOwner(() => status);
    await mountSettled(inspector(fake.client));
    expect([fake.count("inspect"), fake.count("ledger"), fake.count("sources")]).toEqual([1, 1, 1]);
    await beat();
    expect([fake.count("inspect"), fake.count("ledger"), fake.count("sources")]).toEqual([2, 2, 2]);
    status = "succeeded";
    await beat();
    // The read that saw it settle, and its records once more after it.
    expect(fake.count("inspect")).toBe(3);
    expect(fake.count("ledger")).toBe(4);
    await beat();
    await beat();
    expect([fake.count("inspect"), fake.count("ledger")]).toEqual([3, 4]);
  });

  it("never polls a settled run, and stops when the page is left", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const settled = runOwner(() => "succeeded");
    await mountSettled(inspector(settled.client));
    await beat();
    expect(settled.count("inspect")).toBe(1);
    unmountAll();

    const live = runOwner(() => "running");
    await mountSettled(inspector(live.client));
    await beat();
    expect(live.count("inspect")).toBe(2);
    unmountAll();
    await beat();
    expect(live.count("inspect")).toBe(2);
  });

  it("skips a beat while the page is hidden, and reads again as it shows", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    try {
      const fake = runOwner(() => "running");
      await mountSettled(inspector(fake.client));
      hidden = true;
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      await beat();
      await beat();
      expect(fake.count("inspect")).toBe(1);
      hidden = false;
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      await settle();
      expect([fake.count("inspect"), fake.count("ledger")]).toEqual([2, 2]);
    } finally {
      Reflect.deleteProperty(document, "hidden");
    }
  });

  it("does not start a read while the last one is still out", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = runOwner(() => "running");
    const held: (() => void)[] = [];
    let reads = 0;
    const client: SettingsClient = {
      request: (command, raw) => {
        const reply = fake.client.request(command, raw);
        if ((raw as Record<string, unknown>)["action"] !== "inspect" || ++reads === 1) return reply;
        return new Promise((done) => held.push(() => done(reply)));
      },
    };
    await mountSettled(inspector(client));
    await beat();
    await beat();
    await beat();
    expect(fake.count("inspect")).toBe(2);
    await act(async () => held.shift()?.());
    await settle();
    await beat();
    expect(fake.count("inspect")).toBe(3);
  });

  it("keeps an open retained detail open while a live run is read again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const client: SettingsClient = {
      request: async (_command, raw) => {
        const action = (raw as Record<string, unknown>)["action"];
        const result =
          action === "inspect"
            ? { run: run("running"), publication: null, deliveries: [], attempts: [] }
            : action === "ledger"
              ? { events: [{ sequence: 1, at: now, envelope: { code: "model", step: "research" }, detailId: "d1" }] }
              : action === "sources"
                ? { sources: [], nextAfterSourceId: null }
                : action === "detail"
                  ? { payload: "the prompt", hash: "b".repeat(64), prunedAt: null }
                  : {};
        return { ok: true, result } as never;
      },
    };
    const page = await mountSettled(inspector(client));
    await click(button(page, "Inspect retained detail 1"));
    await settle();
    expect(page.querySelector("dialog")?.textContent).toContain("the prompt");
    await beat();
    expect(page.querySelector("dialog")?.textContent).toContain("the prompt");
  });
});
