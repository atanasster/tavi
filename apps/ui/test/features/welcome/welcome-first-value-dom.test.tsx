// @vitest-environment jsdom
import {
  defaultHeartbeatConfig,
  HEARTBEAT_PRODUCTION_OPTIONS,
  ONBOARDING_ABI,
  type OnboardingFlowAnswer,
  type OnboardingFlowStep,
  type OnboardingStatus,
} from "@tavi/contracts";
import axe from "axe-core";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OnboardingChecklist, promiseWords } from "../../../src/features/center/OnboardingChecklist.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { CHIPS_REREAD_MS, CHIPS_WATCH_MS, connectedApps, IdeasStep, newCapabilities } from "../../../src/features/welcome/IdeasStep.js";
import { announceOnboardingChanged } from "../../../src/features/welcome/onboarding-api.js";
import { InWorkspace } from "../../support/workspace.js";
import { flush, settledBy, unmountAll } from "../../support/dom.js";

/**
 * Setup's first value and its checklist: the ideas step's chips at once, upgraded in place when the
 * background refresh brings new ones, never sending a message; and the Home
 * card that lists what is open, shares its slot with the heartbeat offer,
 * and stays gone once dismissed unless a newer flow adds a step — then
 * continuing at the first of those — and says why a flow plugin was not used.
 * "New with <app>" is only for an app connected during this setup.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});
/** What was asked answered: microtasks only, as tests here fake the clock. */
const { settle, mount: mountFlushed, click } = settledBy(() => flush(8));
/** `node` mounted alone: the view before it taken down first. */
async function mount(node: React.ReactNode): Promise<HTMLElement> {
  unmountAll();
  return mountFlushed(node);
}
const button = (container: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text)) as HTMLButtonElement | undefined;

function owner(answers: Record<string, unknown | ((payload: Record<string, unknown>) => unknown)>) {
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  const client: SettingsClient = {
    request: (async (command: string, payload: Record<string, unknown>) => {
      sent.push({ command, payload });
      const answer = answers[`${command}:${String(payload["action"])}`];
      const value: unknown = await (typeof answer === "function"
        ? (answer as (payload: Record<string, unknown>) => unknown)(payload)
        : answer);
      if (value === undefined || value instanceof Error)
        return { ok: false, error: { code: "UNAVAILABLE", message: value instanceof Error ? value.message : "not here" } };
      return { ok: true, result: value };
    }) as SettingsClient["request"],
  };
  return { client, sent, actions: () => sent.map((entry) => `${entry.command}:${String(entry.payload["action"])}`) };
}

const AT = "2026-10-20T10:00:00.000Z";
/** The idea `try` answers with, marked tried. */
const TRIED = {
  id: "i1",
  workspaceId: "default",
  runId: "run-1",
  providerId: "tavi.ideasagent",
  key: "people.reply-dana",
  category: "people",
  icon: "💡",
  title: "Answer Dana",
  pitch: "Dana wrote yesterday.",
  label: "Answer Dana",
  prompt: "Draft a reply to Dana.",
  basis: [{ kind: "general", ref: "general" }],
  uses: [{ capability: "mailbox", approval: true }],
  score: 0.5,
  status: "tried",
  pinned: false,
  shownRuns: 0,
  createdAt: AT,
  updatedAt: AT,
  expiresAt: "2026-11-19T10:00:00.000Z",
};
const IDEAS_ON = {
  settings: {
    enabled: true,
    provider: "tavi.ideasagent",
    chips: true,
    sources: { memory: true, tasks: true, brief: true },
    dailyTokens: 20_000,
    hours: { start: "08:00", end: "22:00" },
  },
};
/** No app was connected when setup opened: every connected one is new in it. */
const NONE_BEFORE: ReadonlySet<string> = new Set();
const IDEAS_STEP: OnboardingFlowStep = {
  id: "ideas",
  kind: "ideas",
  title: "Here's what I can do now",
  body: "A step.",
  optional: true,
  prompts: [{ label: "Plan my week", prompt: "Help me plan my week." }],
};

function status(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    workspaceId: "default",
    providerId: "tavi.onboarding",
    steps: [
      { kind: "model", state: "done", detail: "OpenRouter · verified" },
      { kind: "about", state: "todo", detail: "Your name and time zone" },
      { kind: "apps", state: "done", detail: "Gmail", items: [{ id: "gmail", label: "Gmail", state: "connected" }] },
      { kind: "search", state: "todo", detail: "Web search is not set up" },
      { kind: "ideas", state: "todo", detail: "Try a first idea" },
    ],
    complete: true,
    firstRun: false,
    open: ["about", "search", "ideas"],
    ...overrides,
  };
}

describe("the ideas step", () => {
  it("shows chips at once with their uses, then upgrades them in place when the refresh brings new ones", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let round = 0;
    const { client, actions, sent } = owner({
      "ideas:settings": IDEAS_ON,
      "ideas:chips": () =>
        (round += 1) === 1
          ? { chips: [{ label: "Look something up", prompt: "Search the web for [topic]." }] }
          : {
              chips: [
                { ideaId: "i1", label: "Answer Dana", prompt: "Draft a reply to Dana.", uses: [{ capability: "mailbox", approval: true }] },
              ],
            },
      "ideas:refresh": { status: "started" },
      "ideas:try": { prompt: "Draft a reply to Dana.", idea: TRIED },
    });
    const onTry = vi.fn();
    const page = await mount(
      <IdeasStep connectedBefore={NONE_BEFORE} client={client} workspaceId="default" step={IDEAS_STEP} status={status()} onTry={onTry} />,
    );
    expect(page.textContent).toContain("Look something up");
    expect(actions()).toContain("ideas:refresh");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHIPS_REREAD_MS);
    });
    await settle();
    expect(page.textContent).toContain("Answer Dana");
    expect(page.textContent).toContain("New with Gmail");
    expect(page.textContent).toContain("Uses: Mail — asks before acting");
    expect(page.querySelector("[aria-live='polite']")?.textContent).toBe("New ideas");
    expect(document.activeElement).toBe(document.body);
    await click(button(page, "Try it"));
    expect(onTry).toHaveBeenCalledWith("Draft a reply to Dana.", "i1");
    // Nothing here is a chat turn: only Ideas' own reads, its refresh and the try mark.
    expect(sent.every((entry) => entry.command === "ideas")).toBe(true);
    vi.useRealTimers();
    const results = await axe.run(page, { rules: { region: { enabled: false } } });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("shows the flow's prompts and refreshes nothing with Ideas off, and refreshes nothing when the fast model failed", async () => {
    const off = owner({ "ideas:settings": { settings: { ...IDEAS_ON.settings, enabled: false } } });
    const page = await mount(
      <IdeasStep
        connectedBefore={NONE_BEFORE}
        client={off.client}
        workspaceId="default"
        step={IDEAS_STEP}
        status={status()}
        onTry={() => {}}
      />,
    );
    expect(page.textContent).toContain("Plan my week");
    expect(off.actions()).not.toContain("ideas:refresh");

    const slow = owner({
      "ideas:settings": IDEAS_ON,
      "ideas:chips": { chips: [{ label: "Look something up", prompt: "Search." }] },
      "ideas:refresh": { status: "started" },
    });
    const failedFast = status({
      steps: [{ kind: "model", state: "done", detail: "OpenRouter · verified · Fast model failed: the key was refused" }],
    });
    await mount(
      <IdeasStep
        connectedBefore={NONE_BEFORE}
        client={slow.client}
        workspaceId="default"
        step={IDEAS_STEP}
        status={failedFast}
        onTry={() => {}}
      />,
    );
    expect(slow.actions()).not.toContain("ideas:refresh");
  });

  it("stops reading once left, and stops by itself after two minutes without new ideas", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const same = { chips: [{ label: "Look something up", prompt: "Search." }] };
    const left = owner({ "ideas:settings": IDEAS_ON, "ideas:chips": same, "ideas:refresh": { status: "started" } });
    await mount(
      <IdeasStep
        connectedBefore={NONE_BEFORE}
        client={left.client}
        workspaceId="default"
        step={IDEAS_STEP}
        status={status()}
        onTry={() => {}}
      />,
    );
    unmountAll();
    const before = left.actions().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHIPS_REREAD_MS * 3);
    });
    expect(left.actions().length).toBe(before);
    expect(left.actions().filter((action) => action === "ideas:refresh")).toHaveLength(1);

    const stays = owner({ "ideas:settings": IDEAS_ON, "ideas:chips": same, "ideas:refresh": { status: "started" } });
    await mount(
      <IdeasStep
        connectedBefore={NONE_BEFORE}
        client={stays.client}
        workspaceId="default"
        step={IDEAS_STEP}
        status={status()}
        onTry={() => {}}
      />,
    );
    for (let i = 0; i < 50; i += 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHIPS_REREAD_MS);
      });
    const reads = stays.actions().filter((action) => action === "ideas:chips").length;
    expect(reads).toBeLessThanOrEqual(Math.ceil(CHIPS_WATCH_MS / CHIPS_REREAD_MS) + 2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHIPS_REREAD_MS * 5);
    });
    expect(stays.actions().filter((action) => action === "ideas:chips").length).toBe(reads);
  });

  it("names as new only an app connected since setup opened, and none while that is unknown", () => {
    const before = connectedApps(status());
    expect([...before]).toEqual(["gmail"]);
    expect(newCapabilities(status(), before).size).toBe(0);
    expect(newCapabilities(status(), undefined).size).toBe(0);
    const later = status({
      steps: [
        {
          kind: "apps",
          state: "done",
          detail: "",
          items: [
            { id: "gmail", label: "Gmail", state: "connected" },
            { id: "homeassistant", label: "Home Assistant", state: "connected" },
          ],
        },
      ],
    });
    expect([...newCapabilities(later, before)]).toEqual([["home", "Home Assistant"]]);
  });

  it("shows no New with badge for an app that was connected before setup opened", async () => {
    const { client } = owner({
      "ideas:settings": IDEAS_ON,
      "ideas:chips": {
        chips: [
          { ideaId: "i1", label: "Answer Dana", prompt: "Draft a reply to Dana.", uses: [{ capability: "mailbox", approval: true }] },
        ],
      },
      "ideas:refresh": new Error("not now"),
    });
    const page = await mount(
      <IdeasStep
        connectedBefore={new Set(["gmail"])}
        client={client}
        workspaceId="default"
        step={IDEAS_STEP}
        status={status()}
        onTry={() => {}}
      />,
    );
    expect(page.textContent).toContain("Answer Dana");
    expect(page.textContent).not.toContain("New with");
  });

  it("falls back to the flow's prompts where Ideas is not offered, and fills the composer with one", async () => {
    const { client } = owner({});
    const onTry = vi.fn();
    const page = await mount(
      <IdeasStep connectedBefore={NONE_BEFORE} client={client} workspaceId="default" step={IDEAS_STEP} status={status()} onTry={onTry} />,
    );
    await click(button(page, "Try it"));
    expect(onTry).toHaveBeenCalledWith("Help me plan my week.", undefined);
  });
});

const FLOW: OnboardingFlowAnswer = {
  providerId: "tavi.onboarding",
  flow: {
    abi: ONBOARDING_ABI,
    version: 2,
    title: "Welcome",
    steps: [
      { id: "model", kind: "model", title: "Choose a model", body: "A step.", optional: false },
      { id: "about", kind: "about", title: "About you", body: "A step.", optional: true },
      { id: "search", kind: "search", title: "Web search", body: "A step.", optional: true },
      { id: "service", kind: "service", title: "Keep Tavi running", body: "A step.", optional: true, surfaces: ["cli"] },
      { id: "ideas", kind: "ideas", title: "First ideas", body: "A step.", optional: true },
    ],
    done: { title: "Done", body: "All set." },
  },
};
const HEARTBEAT_OFFER = () => (
  <section aria-label="Heartbeat offer">
    <h2>Want a heartbeat?</h2>
  </section>
);

describe("the setup checklist on Home", () => {
  it("lists the open steps, each opening its Welcome step, and says where a terminal's step is done", async () => {
    const withService = status();
    const { client } = owner({
      "onboarding:flow": FLOW,
      "onboarding:status": () =>
        status({
          steps: [
            ...withService.steps,
            { kind: "service", state: "todo", detail: "Channels and schedules stop when tavi serve stops", elsewhere: "cli" },
          ],
          open: ["about", "search", "ideas", "service"],
        }),
    });
    const onOpenStep = vi.fn();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist onOpenStep={onOpenStep} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Setup checklist");
    expect(page.textContent).toContain("2 of 6");
    expect([...page.querySelectorAll(".onboarding-checklist-rows button")].map((row) => row.textContent)).toEqual([
      "About you",
      "Web search",
      "First ideas",
      "Keep Tavi running",
    ]);
    await click(button(page, "Web search"));
    expect(onOpenStep).toHaveBeenCalledWith("search");
    await click(button(page, "Continue setup"));
    expect(onOpenStep).toHaveBeenLastCalledWith(undefined);
    expect(page.textContent).toContain("Channels and schedules stop when tavi serve stops · in a terminal: tavi setup service");
  });

  it("offers one row to verify a model that is set up but not checked yet", async () => {
    const base = status();
    const { client } = owner({
      "onboarding:flow": FLOW,
      "onboarding:status": status({
        steps: [{ kind: "model", state: "done", detail: "OpenRouter · gemini · not verified yet · Verify" }, ...base.steps.slice(1)],
      }),
    });
    const onOpenStep = vi.fn();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist onOpenStep={onOpenStep} />
      </InWorkspace>,
    );
    expect([...page.querySelectorAll(".onboarding-checklist-rows button")].map((row) => row.textContent)[0]).toBe("Verify the model");
    expect(page.textContent).toContain("Verify the model — OpenRouter · gemini");
    await click(button(page, "Verify the model"));
    expect(onOpenStep).toHaveBeenCalledWith("model");
  });

  it("goes once dismissed and stays gone on the next load; nothing open shows nothing", async () => {
    let dismissed = false;
    const { client } = owner({
      "onboarding:flow": FLOW,
      "onboarding:status": () => status(dismissed ? { dismissedAt: "2026-10-20T00:00:00.000Z" } : {}),
      "onboarding:dismiss": () => {
        dismissed = true;
        return status({ dismissedAt: "2026-10-20T00:00:00.000Z" });
      },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist onOpenStep={() => {}} />
      </InWorkspace>,
    );
    await click(button(page, "Dismiss"));
    expect(page.textContent).toBe("");
    const again = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist onOpenStep={() => {}} />
      </InWorkspace>,
    );
    expect(again.textContent).toBe("");
    const done = owner({ "onboarding:flow": FLOW, "onboarding:status": status({ open: [] }) });
    expect(
      (
        await mount(
          <InWorkspace client={done.client} workspaceId="default">
            <OnboardingChecklist onOpenStep={() => {}} />
          </InWorkspace>,
        )
      ).textContent,
    ).toBe("");
  });

  it("reads the status again on focus, the flow only once, and a read from before a dismissal does not bring it back", async () => {
    let dismissed = false;
    let release: () => void = () => undefined;
    let slow = false;
    const { client, actions } = owner({
      "onboarding:flow": FLOW,
      "onboarding:status": (payload: Record<string, unknown>) => {
        const answer = status(dismissed ? { dismissedAt: "2026-10-20T00:00:00.000Z" } : {});
        // A focus read under way, answering from before the dismissal.
        if (slow && payload["surface"] !== "cli")
          return new Promise((resolve) => {
            release = () => resolve(status());
          });
        return answer;
      },
      "onboarding:dismiss": () => {
        dismissed = true;
        return status({ dismissedAt: "2026-10-20T00:00:00.000Z" });
      },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist onOpenStep={() => {}} />
      </InWorkspace>,
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(actions().filter((action) => action === "onboarding:flow")).toHaveLength(1);
    // Once as it opens and once on focus: the canvas's own status names the terminal's steps too.
    expect(actions().filter((action) => action === "onboarding:status").length).toBeGreaterThanOrEqual(2);
    slow = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    slow = false;
    await click(button(page, "Dismiss"));
    await act(async () => release());
    await settle();
    expect(page.textContent).toBe("");
  });

  it("reads its status again when an app is connected anywhere on the page", async () => {
    let connected = false;
    const { client } = owner({ "onboarding:flow": FLOW, "onboarding:status": () => status(connected ? { open: ["about"] } : {}) });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist onOpenStep={() => {}} />
      </InWorkspace>,
    );
    expect([...page.querySelectorAll(".onboarding-checklist-rows button")].map((row) => row.textContent)).toEqual([
      "About you",
      "Web search",
      "First ideas",
    ]);
    connected = true;
    await act(async () => announceOnboardingChanged());
    await settle();
    expect([...page.querySelectorAll(".onboarding-checklist-rows button")].map((row) => row.textContent)).toEqual(["About you"]);
  });

  it("still gives a due heartbeat offer the slot when setup cannot be read", async () => {
    const base = {
      workspaceId: "default",
      principalId: "operator",
      config: defaultHeartbeatConfig(),
      revision: 0,
      options: HEARTBEAT_PRODUCTION_OPTIONS,
      timezone: "UTC",
      hostRunning: true,
      providers: ["tavi.heartbeatagent"],
    };
    const { client } = owner({ "heartbeat:get": { ...base, offer: { instructions: "Watch my inbox" } } });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist offer={() => <HEARTBEAT_OFFER />} onOpenStep={() => {}} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Want a heartbeat?");
  });

  it("comes back for a newer flow with only the steps it adds, and Continue setup opens the first of them", async () => {
    // About you is open too, and comes first in the flow, but the card is back only for what is new.
    const { client } = owner({ "onboarding:flow": FLOW, "onboarding:status": status({ returning: ["search", "ideas"] }) });
    const onOpenStep = vi.fn();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist onOpenStep={onOpenStep} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("New in this version of setup");
    expect([...page.querySelectorAll(".onboarding-checklist-rows button")].map((row) => row.textContent)).toEqual([
      "Web search",
      "First ideas",
    ]);
    await click(button(page, "Continue setup"));
    expect(onOpenStep).toHaveBeenLastCalledWith("search");
  });

  it("says to run tavi onboard when no flow is installed", async () => {
    const { client } = owner({ "onboarding:flow": FLOW, "onboarding:status": status({ providerId: null }) });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist onOpenStep={() => {}} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Guided setup is turned off here: run tavi onboard");
    const installed = owner({ "onboarding:flow": FLOW, "onboarding:status": status() });
    expect(
      (
        await mount(
          <InWorkspace client={installed.client} workspaceId="default">
            <OnboardingChecklist onOpenStep={() => {}} />
          </InWorkspace>,
        )
      ).textContent,
    ).not.toContain("Guided setup is turned off");
  });

  it("lists Fix the fast model first while the model step is done but its fast model failed", async () => {
    const steps = [
      { kind: "model" as const, state: "done" as const, detail: "OpenRouter · verified · Fast model failed: The model is not available" },
      { kind: "about" as const, state: "todo" as const, detail: "" },
    ];
    const { client } = owner({ "onboarding:flow": FLOW, "onboarding:status": status({ open: ["about"], steps }) });
    const onOpenStep = vi.fn();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist onOpenStep={onOpenStep} />
      </InWorkspace>,
    );
    expect([...page.querySelectorAll(".onboarding-checklist-rows button")].map((row) => row.textContent)).toEqual([
      "Fix the fast model",
      "About you",
    ]);
    expect(page.textContent).toContain("Fix the fast model — The model is not available");
    await click(button(page, "Fix the fast model"));
    expect(onOpenStep).toHaveBeenCalledWith("model");
    const healthy = owner({
      "onboarding:flow": FLOW,
      "onboarding:status": status({ open: ["about"], steps: [{ ...steps[0]!, detail: "OpenRouter · verified" }, steps[1]!] }),
    });
    expect(
      (
        await mount(
          <InWorkspace client={healthy.client} workspaceId="default">
            <OnboardingChecklist onOpenStep={() => {}} />
          </InWorkspace>,
        )
      ).textContent,
    ).not.toContain("Fix the fast model");
  });

  it("says politely why the selected flow plugin's steps are not the ones shown", async () => {
    const reason = "acme.onboarding's flow was not used: it is not installed";
    const { client } = owner({ "onboarding:flow": { ...FLOW, fallback: reason }, "onboarding:status": status() });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <OnboardingChecklist onOpenStep={() => {}} />
      </InWorkspace>,
    );
    const notice = page.querySelector(".onboarding-fallback");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toBe(`Setup is showing Tavi's own steps: ${reason}`);
    const fromStatus = owner({ "onboarding:flow": FLOW, "onboarding:status": status({ flowFallback: reason }) });
    expect(
      (
        await mount(
          <InWorkspace client={fromStatus.client} workspaceId="default">
            <OnboardingChecklist onOpenStep={() => {}} />
          </InWorkspace>,
        )
      ).querySelector(".onboarding-fallback")?.textContent,
    ).toContain(reason);
    const plain = owner({ "onboarding:flow": FLOW, "onboarding:status": status() });
    expect(
      (
        await mount(
          <InWorkspace client={plain.client} workspaceId="default">
            <OnboardingChecklist onOpenStep={() => {}} />
          </InWorkspace>,
        )
      ).querySelector(".onboarding-fallback"),
    ).toBeNull();
  });

  it("gives a due heartbeat offer the slot only once no required step is open, and returns after it is answered", async () => {
    let offerDue = true;
    const base = {
      workspaceId: "default",
      principalId: "operator",
      config: defaultHeartbeatConfig(),
      revision: 0,
      options: HEARTBEAT_PRODUCTION_OPTIONS,
      timezone: "UTC",
      hostRunning: true,
      providers: ["tavi.heartbeatagent"],
    };
    const heartbeat = () => (offerDue ? { ...base, offer: { instructions: "Watch my inbox" } } : base);
    const optional = owner({ "onboarding:flow": FLOW, "onboarding:status": status(), "heartbeat:get": heartbeat });
    let answered: () => void = () => undefined;
    const page = await mount(
      <InWorkspace client={optional.client} workspaceId="default">
        <OnboardingChecklist
          offer={(onDone) => {
            answered = onDone;
            return <HEARTBEAT_OFFER />;
          }}
          onOpenStep={() => {}}
        />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Want a heartbeat?");
    expect(page.textContent).not.toContain("Setup checklist");
    offerDue = false;
    await act(async () => answered());
    await settle();
    expect(page.textContent).toContain("Setup checklist");

    offerDue = true;
    const required = owner({
      "onboarding:flow": FLOW,
      "onboarding:status": status({
        open: ["model", "about"],
        steps: [
          { kind: "model", state: "todo", detail: "No model" },
          { kind: "about", state: "todo", detail: "" },
        ],
      }),
      "heartbeat:get": heartbeat,
    });
    const first = await mount(
      <InWorkspace client={required.client} workspaceId="default">
        <OnboardingChecklist offer={() => <HEARTBEAT_OFFER />} onOpenStep={() => {}} />
      </InWorkspace>,
    );
    expect(first.textContent).toContain("Setup checklist");
    expect(first.textContent).not.toContain("Want a heartbeat?");
  });
});

describe("the morning after setup", () => {
  const COMPLETED = "2026-10-20T15:00:00.000Z";
  const NOW = new Date("2026-10-20T16:00:00.000Z");
  const list = (lastRun?: { startedAt: string }) => ({
    ideas: [],
    mutedCategories: [],
    excludedBasis: [],
    enabled: true,
    nextAt: "2026-10-21T06:00:00.000Z",
    provider: "tavi.ideasagent",
    providers: [],
    ...(lastRun === undefined
      ? {}
      : {
          lastRun: {
            id: "run-1",
            workspaceId: "default",
            trigger: "schedule",
            providerId: "tavi.ideasagent",
            outcome: "generated",
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.startedAt,
          },
        }),
  });

  it("says when the first ideas come once setup is finished, on its own card when nothing is left open", async () => {
    const { client } = owner({
      "onboarding:flow": FLOW,
      "onboarding:status": status({ open: [], completedAt: COMPLETED }),
      "ideas:list": list(),
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <OnboardingChecklist ideas now={() => NOW} onOpenStep={() => {}} />
      </InWorkspace>,
    );
    expect(page.textContent).toBe("Tomorrow morning I'll have ideas for you.");
  });

  it("stops saying it once a run after setup has looked, and never says it without Ideas", async () => {
    const looked = owner({
      "onboarding:flow": FLOW,
      "onboarding:status": status({ open: [], completedAt: COMPLETED }),
      "ideas:list": list({ startedAt: "2026-10-21T06:00:00.000Z" }),
    });
    expect(
      (
        await mount(
          <InWorkspace client={looked.client} workspaceId="default">
            <OnboardingChecklist ideas now={() => NOW} onOpenStep={() => {}} />
          </InWorkspace>,
        )
      ).textContent,
    ).toBe("");
    const without = owner({
      "onboarding:flow": FLOW,
      "onboarding:status": status({ open: [], completedAt: COMPLETED }),
      "ideas:list": list(),
    });
    expect(
      (
        await mount(
          <InWorkspace client={without.client} workspaceId="default">
            <OnboardingChecklist now={() => NOW} onOpenStep={() => {}} />
          </InWorkspace>,
        )
      ).textContent,
    ).toBe("");
    expect(without.actions()).not.toContain("ideas:list");
  });

  it("words the promise by when the run is due", () => {
    expect(promiseWords("2026-10-20T18:00:00.000Z", NOW, "UTC")).toBe("Later today I'll have new ideas for you.");
    expect(promiseWords("2026-10-21T06:00:00.000Z", NOW, "UTC")).toBe("Tomorrow morning I'll have ideas for you.");
    expect(promiseWords("2026-10-23T06:00:00.000Z", NOW, "UTC")).toBe("Soon I'll have ideas for you.");
    expect(promiseWords("2026-10-21T14:00:00.000Z", NOW, "UTC")).toBe("Tomorrow I'll have ideas for you.");
    // Days are the workspace's: 23:00 in Auckland is already its tomorrow.
    expect(promiseWords("2026-10-21T19:00:00.000Z", new Date("2026-10-20T23:00:00.000Z"), "Pacific/Auckland")).toBe(
      "Tomorrow morning I'll have ideas for you.",
    );
    // Across a spring-forward night (New York, 8 March 2026), tomorrow is still tomorrow.
    expect(promiseWords("2026-03-08T12:00:00.000Z", new Date("2026-03-08T03:30:00.000Z"), "America/New_York")).toBe(
      "Tomorrow morning I'll have ideas for you.",
    );
  });
});
