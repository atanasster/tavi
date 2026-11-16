// @vitest-environment jsdom
import {
  HEARTBEAT_PRODUCTION_OPTIONS,
  defaultHeartbeatConfig,
  type CenterSummaryAnswer,
  type HeartbeatConfig,
  type HeartbeatGetAnswer,
  type HeartbeatTickRecord,
  type PluginUiEntry,
} from "@tavi/contracts";
import axe from "axe-core";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CenterPage } from "../../../src/features/center/Center.js";
import { offeredSections } from "../../../src/features/center/CenterNav.js";
import { Heartbeat } from "../../../src/features/center/Heartbeat.js";
import { HeartbeatPill } from "../../../src/features/center/HeartbeatPill.js";
import { HEARTBEAT_SUGGESTIONS } from "../../../src/features/center/heartbeat-options.js";
import { heartbeatEstimate, logLine } from "../../../src/features/center/heartbeat-api.js";
import { HeartbeatItemCard, itemReceipt, type HeartbeatItemView } from "../../../src/features/center/HeartbeatItem.js";
import { NoticeCards } from "../../../src/features/chat/Notices.js";
import { HeartbeatOffer } from "../../../src/features/center/HeartbeatOffer.js";
import { CenterHeartbeatSlotContext } from "../../../src/features/plugin-host/CenterHeartbeatSlot.js";
import type { PluginFrameClient } from "../../../src/features/plugin-host/PluginFrame.js";
import { contributionsForSlot, resolveContributions } from "../../../src/features/plugin-host/slots.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { close, offeredWords, open, pick, selected } from "../../pick.js";
import { WorkspaceProvider } from "../../../src/features/shell/Workspace.js";
import { InWorkspace } from "../../support/workspace.js";
import { clickSettled as click, flush, mountSettled as mount, rerender, unmountAll } from "../../support/dom.js";

/**
 * Center → Heartbeat: the header's on/off,
 * Check now and Pause; the instructions edited in place with history and
 * suggestions; the settings fed by the owner's choices; the estimate; More;
 * the log and its filter; the rail pill; and no WCAG 2.1 A/AA violation axe
 * can find.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
});

/** What was asked answered: microtasks only, as some tests here fake the clock. */
const settle = (): Promise<void> => flush();

const choose = pick;

async function type(field: Element | null | undefined, value: string): Promise<void> {
  if (!(field instanceof HTMLTextAreaElement) && !(field instanceof HTMLInputElement)) throw new Error("no text field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** The heartbeat's on/off switch, by its role and name. */
const heartbeatSwitch = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Heartbeat"]');
const button = (container: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().startsWith(text));

const AT = "2026-10-11T09:00:00.000Z";

const tick = (tickId: string, extra: Partial<HeartbeatTickRecord> = {}): HeartbeatTickRecord => ({
  tickId,
  workspaceId: "default",
  principalId: "operator",
  kind: "signal",
  wakeReason: "interval",
  outcome: "quiet",
  reason: null,
  pauseReason: null,
  providerId: "tavi.heartbeatagent",
  taskId: null,
  itemsNow: 0,
  itemsLater: 0,
  itemsRetracted: 0,
  inputs: null,
  hookDecisions: null,
  tokens: 0,
  cacheReadTokens: 0,
  costUsd: null,
  durationMs: 10,
  error: null,
  providerDev: false,
  createdAt: AT,
  ...extra,
});

/** An owner holding one heartbeat, answering every `heartbeat` action as the real one does, recording what it was sent. */
function owner(
  initial: {
    config?: Partial<HeartbeatConfig>;
    saved?: boolean;
    ticks?: HeartbeatTickRecord[];
    hostRunning?: boolean;
    refuse?: { action: string; message: string };
    items?: HeartbeatItemView[];
    providerState?: Record<string, unknown>;
    channels?: { connectionId: string; label: string; enabled: boolean }[] | "refused";
    toolChoices?: { id: string; description: string }[];
    sources?: { id: string; kind: "builtin" | "plugin"; label?: string }[];
  } = {},
) {
  let config: HeartbeatConfig = { ...defaultHeartbeatConfig(), ...initial.config };
  let revision = initial.saved === false ? 0 : config.revision;
  /** One write refused once, as a change made elsewhere meanwhile would be. */
  let once: { action: string; message: string } | undefined;
  const sent: Record<string, unknown>[] = [];
  const answer = (): HeartbeatGetAnswer => ({
    workspaceId: "default",
    principalId: "operator",
    config,
    revision,
    options: HEARTBEAT_PRODUCTION_OPTIONS,
    timezone: "UTC",
    hostRunning: initial.hostRunning ?? true,
    providers: ["tavi.heartbeatagent", "acme.heartbeat"],
    providerDetails: [
      { id: "tavi.heartbeatagent", kind: "builtin", receives: ["instructions", "signals", "ledger", "memory"] },
      {
        id: "acme.heartbeat",
        kind: "plugin",
        receives: ["instructions", "signals"],
        disclosure: "Heartbeat provider: decides what the heartbeat tells you. It may receive your heartbeat instructions, new signals.",
      },
    ],
    ...(revision === 0
      ? {}
      : {
          state: {
            workspaceId: "default",
            principalId: "operator",
            config,
            nextTickAt: "2026-10-11T09:30:00.000Z",
            createdAt: AT,
            updatedAt: AT,
          },
        }),
    ...(initial.providerState === undefined || config.providerId !== "acme.heartbeat" ? {} : { providerState: initial.providerState }),
    toolChoices: initial.toolChoices ?? [],
    sources: initial.sources ?? [],
  });
  const write = (next: HeartbeatConfig) => {
    revision += 1;
    config = { ...next, revision };
    return { ok: true, result: answer() };
  };
  const client = {
    request: (command: string, payload: Record<string, unknown>) => {
      if (command === "models") {
        if (payload["action"] === "list") return Promise.resolve({ ok: true, result: [{ connectionId: "main", label: "Main" }] });
        if (payload["action"] === "roles") return Promise.resolve({ ok: true, result: {} });
        return Promise.resolve({ ok: true, result: { catalog: [{ connectionId: "main", modelId: "small", displayName: "Small" }] } });
      }
      if (command === "agents")
        return Promise.resolve({
          ok: true,
          result: {
            agents: [
              { agentId: "writer", name: "Writer", enabled: true, updatedAt: AT, systemPromptLength: 0 },
              { agentId: "off", name: "Off", enabled: false, updatedAt: AT, systemPromptLength: 0 },
            ],
            truncated: false,
          },
        });
      if (command === "channels") {
        if (initial.channels === "refused")
          return Promise.resolve({ ok: false, error: { code: "UNAVAILABLE", message: "the owner is busy" } });
        return Promise.resolve({
          ok: true,
          result: {
            connections: initial.channels ?? [
              { connectionId: "tg-1", label: "Telegram", enabled: true },
              { connectionId: "old", label: "Old mail", enabled: false },
            ],
          },
        });
      }
      sent.push(payload);
      if (command !== "heartbeat") return Promise.resolve({ ok: false, error: { code: "UNSUPPORTED", message: "no" } });
      const refusal = initial.refuse ?? (once?.action === payload["action"] ? once : undefined);
      if (refusal !== undefined && refusal.action === payload["action"]) {
        once = undefined;
        return Promise.resolve({ ok: false, error: { code: "CONFLICT", message: refusal.message } });
      }
      switch (payload["action"]) {
        case "get":
          return Promise.resolve({ ok: true, result: answer() });
        case "log":
          return Promise.resolve({ ok: true, result: { ticks: initial.ticks ?? [] } });
        case "history":
          return Promise.resolve({
            ok: true,
            result: { history: [{ revision: 2, text: "Tell me if a payment fails", author: "cli", createdAt: AT }] },
          });
        case "set": {
          // As the owner does: `null` clears a setting.
          const changes = payload["changes"] as Record<string, unknown>;
          const kept = Object.fromEntries(Object.entries(config).filter(([key]) => changes[key] !== null));
          const named = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null));
          return Promise.resolve(write({ ...kept, ...named } as HeartbeatConfig));
        }
        case "unmute":
          return Promise.resolve(write({ ...config, mutes: config.mutes.filter((prefix) => prefix !== payload["prefix"]) }));
        case "set-instructions":
          return Promise.resolve(write({ ...config, instructions: String(payload["text"]) }));
        case "set-provider":
          return Promise.resolve(write({ ...config, providerId: String(payload["providerId"]) }));
        case "egress":
          return Promise.resolve(
            write({ ...config, providerEgress: { ...config.providerEgress, [String(payload["field"])]: payload["on"] === true } }),
          );
        case "pause":
          config = {
            ...config,
            paused: { reason: "user", ...(payload["forMs"] === undefined ? {} : { until: "2026-10-11T10:00:00.000Z" }) },
          };
          return Promise.resolve({ ok: true, result: answer() });
        case "resume": {
          const { paused: _paused, ...rest } = config;
          config = rest;
          return Promise.resolve({ ok: true, result: answer() });
        }
        case "run-now":
          return Promise.resolve({ ok: true, result: { status: "started" } });
        case "forget":
          return Promise.resolve({ ok: true, result: { removed: { ticks: 1, items: 0, signals: 0, tasks: 0 } } });
        case "recent":
          return initial.items === undefined
            ? Promise.resolve({ ok: false, error: { code: "UNSUPPORTED", message: "no items here" } })
            : Promise.resolve({ ok: true, result: { items: initial.items } });
        default:
          return Promise.resolve({ ok: false, error: { code: "INVALID_INPUT", message: `unknown ${String(payload["action"])}` } });
      }
    },
  } as unknown as SettingsClient;
  return {
    client,
    sent,
    config: () => config,
    refuseNext: (action: string, message: string) => {
      once = { action, message };
    },
  };
}

describe("Center → Heartbeat", () => {
  it("starts off with the defaults, offers suggestions, and turns on held to revision 0, so a first save elsewhere is refused", async () => {
    const run = owner({ saved: false });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    expect(page.querySelector("h1")?.textContent).toBe("Heartbeat");
    expect(heartbeatSwitch(page)?.getAttribute("aria-checked")).toBe("false");
    expect(button(page, "Check now")?.disabled).toBe(true);
    expect(page.textContent).toContain("Last check never");
    expect(page.textContent).toContain("Nothing yet");
    for (const suggestion of HEARTBEAT_SUGGESTIONS) expect(page.textContent).toContain(suggestion);
    await click(heartbeatSwitch(page));
    expect(run.sent.at(-1)).toEqual({ action: "set", workspaceId: "default", revision: 0, changes: { enabled: true } });
    expect(heartbeatSwitch(page)?.getAttribute("aria-checked")).toBe("true");
    expect(page.textContent).toContain("Turned on.");
  });

  it("adds a suggestion, edits the instructions in place under the page's revision, and shows their history", async () => {
    const run = owner({ config: { enabled: true, instructions: "Tell me if a payment fails\n", revision: 3 } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    expect(page.querySelector(".heartbeat-lines")?.textContent).toContain("Tell me if a payment fails");
    await click(button(page, `+ ${HEARTBEAT_SUGGESTIONS[0]}`));
    expect(run.sent.at(-1)).toMatchObject({
      action: "set-instructions",
      revision: 3,
      text: `Tell me if a payment fails\n${HEARTBEAT_SUGGESTIONS[0]}\n`,
    });
    await click(button(page, "Edit"));
    await type(page.querySelector("textarea"), "Watch the Globex renewal");
    await click(button(page, "Save"));
    expect(run.sent.at(-1)).toMatchObject({ action: "set-instructions", revision: 4, text: "Watch the Globex renewal" });
    expect(page.querySelector("textarea")).toBeNull();
    await click(button(page, "History"));
    expect(page.querySelector("[aria-label='Instructions history']")?.textContent).toContain("Revision 2");
  });

  it("shows the owner's refusal in its words, and reads the heartbeat again after a conflict", async () => {
    const run = owner({
      config: { enabled: true },
      refuse: { action: "set", message: "The heartbeat changed since revision 1 (it is at 2); read it again and retry" },
    });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const reads = run.sent.filter((payload) => payload["action"] === "get").length;
    await click(heartbeatSwitch(page));
    expect(page.querySelector("[role='alert']")?.textContent).toContain("changed since revision 1");
    expect(run.sent.filter((payload) => payload["action"] === "get").length).toBe(reads + 1);
  });

  it("sends two quick changes one after the other, each naming the revision the one before it left", async () => {
    const run = owner({ config: { enabled: true, revision: 5 } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const days = [...page.querySelectorAll('[aria-label="Days of the week"] button')];
    await act(async () => {
      (days.at(-1) as HTMLElement).click();
      (days.at(-2) as HTMLElement).click();
    });
    await settle();
    const writes = run.sent.filter((payload) => payload["action"] === "set");
    expect(writes.map((payload) => payload["revision"])).toEqual([5, 6]);
    // The second is worked out from what the first left: both days are off.
    expect((writes[1]?.["changes"] as { daysOfWeek?: number[] }).daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("saves an edit over the revision it opened at: a toggle here moves it on, a change to the instructions elsewhere is refused, and a second Save then writes", async () => {
    const run = owner({ config: { enabled: true, instructions: "Tell me if a payment fails\n", revision: 3 } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    await click(button(page, "Edit"));
    // The page's own toggle leaves the instructions as they were: Save follows its revision.
    await click(heartbeatSwitch(page));
    await type(page.querySelector("textarea"), "Watch the Globex renewal");
    await click(button(page, "Save"));
    expect(run.sent.at(-1)).toMatchObject({ action: "set-instructions", revision: 4 });
    // Chat changes the instructions while the editor is open: Save names the revision it opened at, which the owner refuses.
    await click(button(page, "Edit"));
    await run.client.request("heartbeat", { action: "set-instructions", text: "From chat\n" });
    await type(page.querySelector("textarea"), "Mine");
    run.refuseNext("set-instructions", "The heartbeat changed since revision 5 (it is at 6); read it again and retry");
    await click(button(page, "Save"));
    expect(run.sent.filter((payload) => payload["action"] === "set-instructions").at(-1)).toMatchObject({ revision: 5 });
    expect(page.querySelector("[role='alert']")?.textContent).toContain("changed since revision 5");
    expect(page.querySelector("textarea")).not.toBeNull();
    await click(button(page, "Save"));
    expect(run.sent.at(-1)).toMatchObject({ action: "set-instructions", revision: 6, text: "Mine" });
  });

  it("turns on and off from the latest answer, so two quick taps end where they started", async () => {
    const run = owner({ config: { enabled: true } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const on = heartbeatSwitch(page);
    await act(async () => {
      on?.click();
      on?.click();
    });
    await settle();
    expect(
      run.sent.filter((payload) => payload["action"] === "set").map((payload) => (payload["changes"] as { enabled?: boolean }).enabled),
    ).toEqual([false, true]);
  });

  it("shows only the switches already on for a provider not loaded here, saying so", async () => {
    const run = owner({
      config: {
        enabled: true,
        providerId: "gone.heartbeat",
        providerEgress: { instructions: true, signals: false, ledger: false, memory: false },
      },
    });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    // Rendered inside the closed More section all the same.
    expect(page.textContent).toContain("gone.heartbeat is not loaded here");
    const fieldset = [...page.querySelectorAll("fieldset")].find(
      (element) => element.querySelector("legend")?.textContent === "What gone.heartbeat may receive",
    );
    expect([...(fieldset?.querySelectorAll("label") ?? [])].map((label) => label.textContent)).toEqual(["instructions"]);
  });

  it("says when a refresh failed, rather than showing the last read as live", async () => {
    const run = owner({ config: { enabled: true } });
    let down = false;
    const client = {
      request: (command: Parameters<SettingsClient["request"]>[0], payload: Record<string, unknown>) =>
        down && payload["action"] === "get"
          ? Promise.resolve({ ok: false, error: { code: "UNAVAILABLE", message: "the owner stopped" } })
          : run.client.request(command, payload),
    } as unknown as SettingsClient;
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Heartbeat refreshMs={20} />
      </InWorkspace>,
    );
    down = true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    await settle();
    expect(page.textContent).toContain("Could not refresh: the owner stopped");
    expect(heartbeatSwitch(page)?.getAttribute("aria-checked")).toBe("true");
  });

  it("says when the log could not be read, rather than that there were no checks", async () => {
    const run = owner({ config: { enabled: true }, refuse: { action: "log", message: "The owner is busy" } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("The log could not be read: The owner is busy");
    expect(page.textContent).not.toContain("No checks yet.");
    expect(page.textContent).toContain("Last check unknown");
  });

  it("changes how often from the owner's choices, the days, and how it tells you", async () => {
    const run = owner({ config: { enabled: true } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const often = page.querySelector('[aria-label="How often"]');
    await open(often);
    expect(offeredWords()).toEqual(
      HEARTBEAT_PRODUCTION_OPTIONS.every.map((ms) => `Every ${ms >= 3_600_000 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`}`),
    );
    await close();
    await choose(often, String(60 * 60_000));
    expect(run.sent.at(-1)).toMatchObject({ action: "set", changes: { everyMs: 3_600_000 } });
    const sunday = page.querySelector('[aria-label="Days of the week"] button:has(abbr[title="Sunday"])');
    expect(sunday?.getAttribute("aria-pressed")).toBe("true");
    await click(sunday);
    expect(run.sent.at(-1)).toMatchObject({ action: "set", changes: { daysOfWeek: [1, 2, 3, 4, 5, 6] } });
    // A preset sets the days whole; every day is kept as the heartbeat stores it, each day named.
    await click(button(page, "Weekends"));
    expect(run.sent.at(-1)).toMatchObject({ action: "set", changes: { daysOfWeek: [0, 6] } });
    await click(button(page, "Every day"));
    expect(run.sent.at(-1)).toMatchObject({ action: "set", changes: { daysOfWeek: [0, 1, 2, 3, 4, 5, 6] } });
    const digest = page.querySelector("input[type='radio'][value='digest-only']");
    await click(digest);
    expect(run.sent.at(-1)).toMatchObject({ action: "set", changes: { tellMe: "digest-only" } });
    // Its active hours are one range: from and to in one group, its zone after them; Tell me's choices one a line.
    const hours = page.querySelector('[role="group"][aria-label="Active hours"]');
    expect([...(hours?.querySelectorAll("label") ?? [])].map((label) => label.textContent?.trim())).toEqual(["Active from", "to"]);
    expect(hours?.querySelectorAll("input[type='time']")).toHaveLength(2);
    expect(digest?.closest("fieldset")?.classList.contains("heartbeat-tell")).toBe(true);
  });

  it("checks now, pauses for an hour, resumes, and forgets only after confirming, clearing an earlier refusal", async () => {
    // The owner's pause ends at 10:00 on the test's day: the page reads it as today's.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(AT) });
    const run = owner({ config: { enabled: true } });
    const changed: string[] = [];
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat onChanged={() => changed.push("changed")} />
      </InWorkspace>,
    );
    run.refuseNext("run-now", "A check is not possible right now");
    await click(button(page, "Check now"));
    expect(page.querySelector("[role='alert']")?.textContent).toContain("not possible right now");
    await click(button(page, "Check now"));
    expect(page.textContent).toContain("Checking now.");
    expect(page.querySelector("[role='alert']")).toBeNull();
    await choose(page.querySelector('[aria-label="Pause"]'), "1h");
    expect(run.sent.at(-1)).toEqual({ action: "pause", workspaceId: "default", forMs: 3_600_000 });
    expect(page.textContent).toContain("Paused (by you) until 10:00");
    expect(button(page, "Check now")?.disabled).toBe(true);
    await click(button(page, "Resume"));
    expect(run.sent.at(-1)).toEqual({ action: "resume", workspaceId: "default" });
    await click(button(page, "Forget heartbeat history"));
    expect(run.sent.some((payload) => payload["action"] === "forget")).toBe(false);
    await click(button(page, "Forget everything"));
    expect(run.sent.some((payload) => payload["action"] === "forget")).toBe(true);
    expect(page.textContent).toContain("Forgotten.");
    expect(changed.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("lists the log with its filter, today's figures, and estimates from the person's own checks", async () => {
    const ticks = [
      tick("t3", { outcome: "failed", reason: "transport", createdAt: "2026-10-11T08:30:00.000Z" }),
      tick("t2", { kind: "deep", outcome: "reported", itemsNow: 1, tokens: 2_000, createdAt: "2026-10-11T08:00:00.000Z" }),
      tick("t1", { kind: null, outcome: "skipped", reason: "nothing-new", createdAt: "2026-10-11T07:30:00.000Z" }),
    ];
    // "Today" is the workspace's: the clock is set to the morning these checks ran.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-11T09:00:00.000Z") });
    const run = owner({ config: { enabled: true }, ticks });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    expect(page.querySelectorAll(".heartbeat-log li")).toHaveLength(3);
    expect(page.querySelector(".heartbeat-status")?.textContent).toContain(
      "today 2 checks · 1 looked deeper · 2,000 tokens · cost unknown",
    );
    const filter = page.querySelector('[aria-label="Show"]');
    await choose(filter, "failed");
    expect(page.querySelector(".heartbeat-log")?.textContent).toContain("Failed — transport");
    expect(page.querySelectorAll(".heartbeat-log li")).toHaveLength(1);
    expect(page.textContent).toContain("~48,000 tokens");
  });

  it("asks what an external provider may receive, and nothing of the built-in one", async () => {
    const run = owner({ config: { enabled: true } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    expect(page.textContent).not.toContain("may receive");
    const provider = page.querySelector('[aria-label="Provider"]');
    await choose(provider, "acme.heartbeat");
    expect(run.sent.at(-1)).toMatchObject({ action: "set-provider", providerId: "acme.heartbeat" });
    expect(page.textContent).toContain("What acme.heartbeat may receive");
    // The disclosure its approval showed, and a switch only for what its manifest asks for.
    expect(page.querySelector(".heartbeat-disclosure")?.textContent).toContain("It may receive your heartbeat instructions, new signals.");
    expect([...page.querySelectorAll(".heartbeat-more fieldset label")].map((label) => label.textContent)).toEqual([
      "instructions",
      "signals",
    ]);
    await click(page.querySelector(".heartbeat-more fieldset input"));
    expect(run.sent.at(-1)).toMatchObject({ action: "egress", field: "instructions", on: true });
  });

  it("shows the selected provider's own panel under More with what it published, and removes it when another is chosen", async () => {
    const entry: PluginUiEntry = {
      pluginId: "acme.heartbeat",
      kind: "external",
      contentHash: "b".repeat(64),
      ui: {
        abi: "tavi.ui/1",
        contributions: [
          { id: "panel", title: "ACME rules", document: "panel.html", channels: [], placements: [{ slot: "center.heartbeat" }] },
        ],
      },
    };
    const slot = {
      items: contributionsForSlot(resolveContributions([entry], {}).contributions, "center.heartbeat"),
      client: { liveWatch: async () => ({ response: { ok: true } }) } as PluginFrameClient,
    };
    const run = owner({ config: { enabled: true, providerId: "acme.heartbeat" }, providerState: { rules: 3 } });
    const page = await mount(
      <CenterHeartbeatSlotContext.Provider value={slot}>
        <InWorkspace client={run.client} workspaceId="default">
          <Heartbeat />
        </InWorkspace>
      </CenterHeartbeatSlotContext.Provider>,
    );
    expect(page.querySelector(".heartbeat-more .heartbeat-provider-panel")).not.toBeNull();
    const provider = page.querySelector('[aria-label="Provider"]');
    await choose(provider, "tavi.heartbeatagent");
    expect(page.querySelector(".heartbeat-provider-panel")).toBeNull();
  });

  it("adds a channel target after confirming who it will message, offers only enabled channels, and removes one", async () => {
    const run = owner({ config: { enabled: true, targets: [{ connectionId: "tg-1", to: "100" }] } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const where = page.querySelector(".heartbeat-targets");
    expect(where?.textContent).toContain("Telegram · 100");
    expect([...(where?.querySelectorAll("option") ?? [])].map((option) => option.textContent)).toEqual(["Telegram"]);
    await type(where?.querySelector("input") ?? null, "200");
    await click(where?.querySelector('button[type="submit"]') ?? null);
    // Nothing is saved until it is confirmed.
    expect(run.sent.filter((payload) => payload["action"] === "set")).toEqual([]);
    expect(where?.querySelector('[role="alert"]')?.textContent).toContain("The heartbeat will also message 200 on Telegram");
    await click([...(where?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Confirm") ?? null);
    expect(run.sent.at(-1)).toMatchObject({
      action: "set",
      changes: {
        targets: [
          { connectionId: "tg-1", to: "100" },
          { connectionId: "tg-1", to: "200" },
        ],
      },
    });
    await click(page.querySelector('[aria-label="Stop messaging 100 on Telegram"]'));
    expect(run.sent.at(-1)).toMatchObject({ action: "set", changes: { targets: [{ connectionId: "tg-1", to: "200" }] } });
  });

  it("says why a target cannot be added: the channels unreadable, none enabled, or the limit reached", async () => {
    const refused = await mount(
      <InWorkspace client={owner({ config: { enabled: true }, channels: "refused" }).client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    expect(refused.querySelector(".heartbeat-targets")?.textContent).toContain("The channels could not be read: the owner is busy");
    unmountAll();
    const none = await mount(
      <InWorkspace
        client={owner({ config: { enabled: true }, channels: [{ connectionId: "old", label: "Old mail", enabled: false }] }).client}
        workspaceId="default"
      >
        <Heartbeat />
      </InWorkspace>,
    );
    expect(none.querySelector(".heartbeat-targets")?.textContent).toContain("Connect a channel in Settings → Channels");
    unmountAll();
    const targets = Array.from({ length: 8 }, (_, index) => ({ connectionId: "tg-1", to: String(index) }));
    const full = await mount(
      <InWorkspace client={owner({ config: { enabled: true, targets } }).client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    expect(full.querySelector(".heartbeat-targets")?.textContent).toContain("At most 8 channel targets");
    expect(full.querySelector(".heartbeat-targets form")).toBeNull();
  });

  it("disables Add for a recipient already there, cancels without saving, and keeps two quick removes from undoing each other", async () => {
    const run = owner({
      config: {
        enabled: true,
        targets: [
          { connectionId: "tg-1", to: "100" },
          { connectionId: "tg-1", to: "200" },
          { connectionId: "tg-1", to: "300" },
        ],
      },
    });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const where = page.querySelector(".heartbeat-targets");
    await type(where?.querySelector("input") ?? null, "100");
    expect(where?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await type(where?.querySelector("input") ?? null, "400");
    await click(where?.querySelector('button[type="submit"]') ?? null);
    await click([...(where?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Cancel") ?? null);
    expect(run.sent.filter((payload) => payload["action"] === "set")).toEqual([]);
    // Both clicked before either is answered: each applies to the list the other left.
    const first = page.querySelector('[aria-label="Stop messaging 100 on Telegram"]');
    const second = page.querySelector('[aria-label="Stop messaging 200 on Telegram"]');
    await act(async () => {
      first?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      second?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(run.config().targets).toEqual([{ connectionId: "tg-1", to: "300" }]);
  });

  it("chooses the model and persona its checks run on under More, and sets each back to its default", async () => {
    const run = owner({ config: { enabled: true } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const select = (name: string) => page.querySelector(`.heartbeat-more [aria-label="${name}"]`);
    await open(select("Model"));
    expect(offeredWords()).toEqual(["Workspace fast model", "Small (Main)"]);
    await close();
    await open(select("Persona"));
    expect(offeredWords()).toEqual(["None", "Writer"]);
    await close();
    await choose(select("Model"), "main/small");
    expect(run.sent.at(-1)).toMatchObject({ action: "set", changes: { model: { connectionId: "main", model: "small" } } });
    await choose(select("Model"), "");
    expect(run.sent.at(-1)).toMatchObject({ action: "set", changes: { model: null } });
    expect(run.config().model).toBeUndefined();
    await choose(select("Persona"), "writer");
    expect(run.config().agentId).toBe("writer");
    await choose(select("Persona"), "");
    expect(run.config().agentId).toBeUndefined();
  });

  it("keeps showing a chosen model or persona that is no longer listed, by its id", async () => {
    const page = await mount(
      <InWorkspace
        client={owner({ config: { enabled: true, model: { connectionId: "gone", model: "x" }, agentId: "off" } }).client}
        workspaceId="default"
      >
        <Heartbeat />
      </InWorkspace>,
    );
    const select = (name: string) => page.querySelector(`.heartbeat-more [aria-label="${name}"]`);
    expect(selected(select("Model"))).toBe("gone/x");
    expect(selected(select("Persona"))).toBe("off");
  });

  it("saves the hourly and dollar limits with the daily ones, a blank dollar limit as none", async () => {
    const run = owner({ config: { enabled: true, budget: { modelTicksPerDay: 48, tokensPerDay: 500_000, usdPerDay: 1 } } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const field = (name: string) => page.querySelector<HTMLInputElement>(`.heartbeat-limits input[name="${name}"]`);
    expect(field("usd")?.value).toBe("1");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field("hourly"), "5");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field("usd"), "");
    });
    await click(page.querySelector('.heartbeat-limits button[type="submit"]'));
    expect(run.sent.at(-1)).toMatchObject({
      action: "set",
      changes: { maxNowPerHour: 5, budget: { modelTicksPerDay: 48, tokensPerDay: 500_000 } },
    });
    expect(run.config().budget).not.toHaveProperty("usdPerDay");
    expect(run.config().maxNowPerHour).toBe(5);
    // A dollar limit typed is saved; the owner's bounds are the fields' own.
    await act(async () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field("usd"), "2.5"));
    await click(page.querySelector('.heartbeat-limits button[type="submit"]'));
    expect(run.config().budget.usdPerDay).toBe(2.5);
    expect(field("hourly")?.required).toBe(true);
    expect(field("usd")?.max).toBe("10000");
  });

  it("lists what it is told not to mention, and unmutes one", async () => {
    const run = owner({ config: { enabled: true, mutes: ["stripe:test:*", "billing:1"] } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    expect([...page.querySelectorAll(".heartbeat-mutes li")].map((item) => item.textContent?.replace("Unmute", "").trim())).toEqual([
      "stripe:test:*",
      "billing:1",
    ]);
    await click(page.querySelector('[aria-label="Tell me about stripe:test:* again"]'));
    expect(run.sent.at(-1)).toMatchObject({ action: "unmute", prefix: "stripe:test:*" });
    expect(run.config().mutes).toEqual(["billing:1"]);
  });

  it("adds and removes the read-only plugin tools its checks may use, keeping one no longer offered so it can be taken off", async () => {
    const run = owner({
      config: { enabled: true, extraTools: ["old.lookup"] },
      toolChoices: [{ id: "acme.units.convert", description: "Convert units" }],
    });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const box = (id: string) =>
      [...page.querySelectorAll(".heartbeat-tools label")].find((label) => label.textContent?.startsWith(id))?.querySelector("input") ??
      null;
    expect([...page.querySelectorAll(".heartbeat-tools label")].map((label) => label.textContent)).toEqual([
      "acme.units.convert Convert units",
      "old.lookup No longer offered by a loaded plugin or MCP server",
    ]);
    await click(box("acme.units.convert"));
    expect(run.config().extraTools).toEqual(["old.lookup", "acme.units.convert"]);
    await click(box("old.lookup"));
    expect(run.config().extraTools).toEqual(["acme.units.convert"]);
  });

  it("turns a signal source off and on again, naming the built-in ones by what they watch and a plugin's by its label", async () => {
    const run = owner({
      config: { enabled: true },
      sources: [
        { id: "needs", kind: "builtin" },
        { id: "apps", kind: "builtin" },
        { id: "rooms", kind: "builtin" },
        { id: "acme.queue.queue", kind: "plugin", label: "Queue from Acme" },
      ],
    });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const labels = [...page.querySelectorAll(".heartbeat-sources label")];
    expect(labels.map((label) => label.textContent)).toEqual([
      "Approvals, questions and reviews waiting",
      "Apps that need signing in again",
      "Rooms waiting to be added or left",
      "Queue from Acme (plugin)",
    ]);
    await click(labels[3]?.querySelector("input") ?? null);
    expect(run.config().disabledSources).toEqual(["acme.queue.queue"]);
    await click(page.querySelectorAll(".heartbeat-sources input")[3] ?? null);
    expect(run.config().disabledSources).toEqual([]);
  });

  it("shows a source turned off and since uninstalled, so it can be cleared", async () => {
    const run = owner({ config: { enabled: true, disabledSources: ["old.feed.items"] }, sources: [{ id: "needs", kind: "builtin" }] });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    const labels = [...page.querySelectorAll(".heartbeat-sources label")];
    expect(labels.map((label) => label.textContent)).toEqual([
      "Approvals, questions and reviews waiting",
      "old.feed.items (not installed)",
    ]);
    await click(labels[1]?.querySelector("input") ?? null);
    expect(run.config().disabledSources).toEqual([]);
  });

  it("lists the sites it may read under More, and removes one", async () => {
    const run = owner({ config: { enabled: true, fetchHosts: ["example.com", "news.example.org"] } });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    expect([...page.querySelectorAll(".heartbeat-sites li")].map((item) => item.textContent?.replace("Remove", "").trim())).toEqual([
      "example.com",
      "news.example.org",
    ]);
    await click(page.querySelector('[aria-label="Stop reading example.com"]'));
    expect(run.sent.at(-1)).toMatchObject({ action: "set", changes: { fetchHosts: ["news.example.org"] } });
  });

  it("has no WCAG 2.1 A/AA violations axe can find, off or on with a log and More open", async () => {
    for (const run of [
      owner({ saved: false }),
      owner({ config: { enabled: true, providerId: "acme.heartbeat", instructions: "Tell me if a payment fails" }, ticks: [tick("t1")] }),
    ]) {
      const page = await mount(
        <InWorkspace client={run.client} workspaceId="default">
          <Heartbeat />
        </InWorkspace>,
      );
      page.querySelector("details")?.setAttribute("open", "");
      const result = await axe.run(page, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
        rules: { "color-contrast": { enabled: false } },
      });
      expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.html).join(" | ")}`)).toEqual([]);
      unmountAll();
    }
  });
});

describe("the heartbeat's place in the Center", () => {
  it("is offered where the owner has the heartbeat command", () => {
    expect(offeredSections(["heartbeat"])).toContain("heartbeat");
    expect(offeredSections([])).not.toContain("heartbeat");
  });

  it("reads the pill again on its own, so its next check does not go stale", async () => {
    const run = owner({ config: { enabled: true } });
    const pill = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <HeartbeatPill refreshMs={20} onOpen={() => undefined} />
      </InWorkspace>,
    );
    const reads = run.sent.filter((payload) => payload["action"] === "get").length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
    });
    expect(run.sent.filter((payload) => payload["action"] === "get").length).toBeGreaterThan(reads);
    expect(pill.textContent).toMatch(/^Heartbeat on/);
  });

  it("puts a pill in the rail: on and its next check, off, or paused, read again when the section changes it", async () => {
    let opened = false;
    const page = await mount(
      <InWorkspace client={owner({ config: { enabled: true } }).client} workspaceId="default">
        <HeartbeatPill
          onOpen={() => {
            opened = true;
          }}
        />
      </InWorkspace>,
    );
    expect(page.textContent).toBe("Heartbeat on · next 09:30");
    await click(page.querySelector("button"));
    expect(opened).toBe(true);
    unmountAll();
    expect(
      (
        await mount(
          <InWorkspace client={owner({ config: { enabled: false } }).client} workspaceId="default">
            <HeartbeatPill onOpen={() => undefined} />
          </InWorkspace>,
        )
      ).textContent,
    ).toBe("Heartbeat off");
    unmountAll();
    const paused = owner({ config: { enabled: true } });
    const pill = await mount(
      <InWorkspace client={paused.client} workspaceId="default">
        <HeartbeatPill revision={0} onOpen={() => undefined} />
      </InWorkspace>,
    );
    await paused.client.request("heartbeat", { action: "pause" });
    await rerender(
      <InWorkspace client={paused.client} workspaceId="default">
        <HeartbeatPill revision={1} onOpen={() => undefined} />
      </InWorkspace>,
    );
    await settle();
    expect(pill.textContent).toBe("Heartbeat paused");
  });

  it("estimates from the hours and the limits, and words the log", () => {
    expect(heartbeatEstimate({ ...defaultHeartbeatConfig() }, undefined)).toEqual({ checks: 24 });
    expect(heartbeatEstimate({ ...defaultHeartbeatConfig() }, 20_000)).toEqual({ checks: 24, tokens: 300_000 });
    expect(logLine(tick("x", { kind: "deep" }))).toBe("Looked deeper — all quiet");
    expect(logLine(tick("x", { kind: null, outcome: "skipped", reason: "nothing-new" }))).toBe("Skipped — nothing new");
    expect(
      logLine(
        tick("x", {
          kind: "signal",
          outcome: "quiet",
          hookDecisions: [{ key: "billing:1", by: "acme.guard", action: "held back", reason: "Not today" }],
        }),
      ),
    ).toBe("Checked what changed — all quiet · acme.guard held back (Not today)");
    // A record whose decisions do not parse shows none.
    expect(logLine(tick("x", { kind: "deep", hookDecisions: "nonsense" }))).toBe("Looked deeper — all quiet");
    // Why it ran, and the memories it used.
    expect(
      logLine(
        tick("x", {
          kind: "deep",
          wakeReason: "manual",
          inputs: {
            memory: [
              { recordId: "m1", revisionId: "r1" },
              { recordId: "m2", revisionId: "r1" },
            ],
          },
        }),
      ),
    ).toBe("Looked deeper — all quiet · you asked · used 2 memories");
    expect(logLine(tick("x", { wakeReason: "event", inputs: { memory: "nonsense" } }))).toBe(
      "Checked what changed — all quiet · woken by an event",
    );
  });
});

describe("a heartbeat item's card", () => {
  const view = (extra: Partial<HeartbeatItemView> = {}): HeartbeatItemView => ({
    itemId: "hbi-1",
    workspaceId: "default",
    principalId: "operator",
    key: "billing:1",
    hash: "h",
    signalKeys: [],
    urgency: "now",
    heldBack: false,
    title: "A payment failed",
    body: "ACME invoice 1042 bounced\nThe card was declined twice.",
    sources: [{ label: "Billing" }],
    instructionLine: 2,
    state: "told",
    firstToldAt: AT,
    lastToldAt: AT,
    updatedAt: AT,
    ...extra,
  });

  function itemOwner(initial: HeartbeatItemView) {
    let item = initial;
    const sent: Record<string, unknown>[] = [];
    const client = {
      request: (_command: string, payload: Record<string, unknown>) => {
        sent.push(payload);
        if (payload["action"] === "item") return Promise.resolve({ ok: true, result: { item } });
        if (payload["action"] === "items") {
          const op = payload["op"];
          if (op === "feedback")
            item = { ...item, ...(payload["feedback"] === null ? {} : { feedback: payload["feedback"] as "up" | "down" }) };
          if (op === "mute") item = { ...item, state: "muted" };
          if (op === "snooze") item = { ...item, state: "snoozed", snoozedUntil: "2026-10-12T09:00:00.000Z" };
          if (op === "unsnooze" || op === "unmute") item = { ...item, state: "told" };
          return Promise.resolve({ ok: true, result: { item } });
        }
        return Promise.resolve({ ok: false, error: { code: "INVALID_INPUT", message: "no" } });
      },
    } as unknown as SettingsClient;
    return { client, sent };
  }

  it("shows the title, the body's first line with the rest behind More, where it came from and which line it answers", async () => {
    const run = itemOwner(view());
    const card = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <HeartbeatItemCard itemId="hbi-1" timeZone="UTC" />
      </InWorkspace>,
    );
    expect(card.querySelector(".heartbeat-item-title")?.textContent).toBe("A payment failed");
    expect(card.textContent).toContain("ACME invoice 1042 bounced");
    expect(card.textContent).not.toContain("declined twice");
    await click(button(card, "More"));
    expect(card.textContent).toContain("declined twice");
    expect(card.querySelector(".heartbeat-item-source")?.textContent).toBe("Billing · 09:00 · from your line 2");
    expect(button(card, "Do it")).toBeUndefined();
  });

  it("offers Do it only with a proposal, and hands Do it and Chat about this to the page", async () => {
    const proposal = view({
      proposedAction: { toolId: "reminders.create", input: { text: "Pay ACME" }, summary: "Remind you to pay ACME" },
    });
    const done: string[] = [];
    const card = await mount(
      <InWorkspace client={itemOwner(proposal).client} workspaceId="default">
        <HeartbeatItemCard
          itemId="hbi-1"
          initial={proposal}
          timeZone="UTC"
          onDoIt={(item) => done.push(`do ${item.itemId}`)}
          onChat={(item) => done.push(`chat ${item.itemId}`)}
        />
      </InWorkspace>,
    );
    await click(button(card, "Do it"));
    await click(button(card, "Chat about this"));
    expect(done).toEqual(["do hbi-1", "chat hbi-1"]);
  });

  it("gives 👍/👎, snoozes until tomorrow and mutes, collapsing to a one-line receipt", async () => {
    // The fixture's snooze runs to a fixed time, so the card is read at AT, not whenever the suite runs.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(AT) });
    const run = itemOwner(view());
    const card = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <HeartbeatItemCard itemId="hbi-1" timeZone="UTC" />
      </InWorkspace>,
    );
    await click(button(card, "Not useful"));
    expect(run.sent.at(-1)).toMatchObject({ action: "items", itemId: "hbi-1", op: "feedback", feedback: "down" });
    expect(button(card, "Not useful")?.getAttribute("aria-pressed")).toBe("true");
    await click(button(card, "Snooze for a day"));
    expect(run.sent.at(-1)).toMatchObject({ op: "snooze", minutes: 1440 });
    await click(button(card, "Undo"));
    expect(run.sent.at(-1)).toMatchObject({ op: "unsnooze" });
    await click(button(card, "Don't tell me about this"));
    expect(card.querySelector(".heartbeat-item-receipt")?.textContent).toBe("Muted: you won't hear about this again Undo");
    await click(button(card, "Undo"));
    expect(run.sent.at(-1)).toMatchObject({ op: "unmute" });
    expect(button(card, "Don't tell me about this")).toBeDefined();
    expect(itemReceipt(view({ state: "resolved", updatedAt: "2026-10-11T14:20:00.000Z" }), "UTC")).toBe("Resolved · 14:20");
    // A snooze into another day names the day, so it never reads as later today.
    expect(
      itemReceipt(view({ state: "snoozed", snoozedUntil: "2026-10-12T09:00:00.000Z" }), "UTC", Date.parse("2026-10-11T09:00:00.000Z")),
    ).toBe("Snoozed until Mon 12 Oct 09:00");
  });

  it("stands in Home for a heartbeat notice, in place of its title and summary", async () => {
    const run = itemOwner(view());
    const notice = {
      noticeId: "n1",
      taskId: "home-1",
      sourceKey: "heartbeat:item:hbi-1",
      kind: "heartbeat" as const,
      heartbeatItemId: "hbi-1",
      title: "A payment failed",
      summary: "Billing",
      afterSeq: 0,
      createdAt: AT,
    };
    const page = await mount(
      <NoticeCards
        notices={[notice]}
        connected
        heartbeatCard={(card) => (
          <InWorkspace client={run.client} workspaceId="default">
            <HeartbeatItemCard itemId={card.heartbeatItemId} timeZone="UTC" />
          </InWorkspace>
        )}
      />,
    );
    expect(page.querySelector("[data-notice-kind='heartbeat'] .heartbeat-item")).not.toBeNull();
    expect(page.textContent).not.toContain("Reply in a side chat");
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe("Center → Heartbeat's items", () => {
  const item = (itemId: string, title: string): HeartbeatItemView => ({
    itemId,
    workspaceId: "default",
    principalId: "operator",
    key: itemId,
    hash: "h",
    signalKeys: [],
    urgency: "now",
    heldBack: false,
    title,
    sources: [{ label: "Billing" }],
    state: "told",
    firstToldAt: AT,
    lastToldAt: AT,
    updatedAt: AT,
  });

  it("lists what it told, each as its card with Do it and Chat about this handed to the page", async () => {
    const run = owner({
      config: { enabled: true },
      items: [
        { ...item("hbi-1", "A payment failed"), proposedAction: { toolId: "reminders.create", input: {}, summary: "Remind you" } },
        item("hbi-2", "Globex renews Friday"),
      ],
    });
    const asked: string[] = [];
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat onDoIt={(entry) => asked.push(`do ${entry.itemId}`)} onChat={(entry) => asked.push(`chat ${entry.itemId}`)} />
      </InWorkspace>,
    );
    const cards = page.querySelectorAll(".heartbeat-items .heartbeat-item");
    expect([...cards].map((card) => card.querySelector(".heartbeat-item-title")?.textContent)).toEqual([
      "A payment failed",
      "Globex renews Friday",
    ]);
    await click(button(cards[0] as HTMLElement, "Do it"));
    await click(button(cards[1] as HTMLElement, "Chat about this"));
    expect(asked).toEqual(["do hbi-1", "chat hbi-2"]);
  });

  it("says when what it told could not be read", async () => {
    const page = await mount(
      <InWorkspace client={owner({ config: { enabled: true } }).client} workspaceId="default">
        <Heartbeat />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("What it told you could not be read: no items here");
  });
});

describe("the first-run offer", () => {
  function offering(offer: string | undefined, startRefusal?: string) {
    const sent: Record<string, unknown>[] = [];
    const client = {
      request: (_command: string, payload: Record<string, unknown>) => {
        sent.push(payload);
        if (payload["action"] === "get") {
          const config = { ...defaultHeartbeatConfig() };
          return Promise.resolve({
            ok: true,
            result: {
              workspaceId: "default",
              principalId: "operator",
              config,
              revision: 0,
              options: HEARTBEAT_PRODUCTION_OPTIONS,
              timezone: "UTC",
              hostRunning: true,
              providers: [],
              providerDetails: [],
              ...(offer === undefined ? {} : { offer: { instructions: offer } }),
            },
          });
        }
        if (payload["action"] === "start" && startRefusal !== undefined)
          return Promise.resolve({ ok: false, error: { code: "CONFLICT", message: startRefusal } });
        if (payload["action"] === "start")
          return Promise.resolve({
            ok: true,
            result: {
              workspaceId: "default",
              principalId: "operator",
              config: { ...defaultHeartbeatConfig(), enabled: true, instructions: String(payload["instructions"]) },
              revision: 1,
              options: HEARTBEAT_PRODUCTION_OPTIONS,
              timezone: "UTC",
              hostRunning: true,
              providers: [],
              providerDetails: [],
            },
          });
        if (payload["action"] === "offer") return Promise.resolve({ ok: true, result: { dismissed: true } });
        return Promise.resolve({ ok: false, error: { code: "INVALID_INPUT", message: "no" } });
      },
    } as unknown as SettingsClient;
    return { client, sent };
  }

  it("is shown only when the owner offers it", async () => {
    const page = await mount(
      <InWorkspace client={offering(undefined).client} workspaceId="default">
        <HeartbeatOffer />
      </InWorkspace>,
    );
    expect(page.textContent).toBe("");
  });

  it("asks once, with its estimate and the instructions it prefilled, and turns on with them as edited", async () => {
    const run = offering("Scheduled runs that fail\n");
    let done = 0;
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <HeartbeatOffer
          onDone={() => {
            done += 1;
          }}
        />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Want me to check on things every 30m between 08:00 and 22:00");
    expect(page.textContent).toContain("Up to 24 checks a day");
    expect(page.querySelector("textarea")?.value).toBe("Scheduled runs that fail\n");
    await type(page.querySelector("textarea"), "Scheduled runs that fail\nMessages held for my review\n");
    await click(button(page, "Turn on"));
    expect(run.sent[0]).toEqual({ action: "get", workspaceId: "default", offer: true });
    expect(run.sent.at(-1)).toEqual({
      action: "start",
      workspaceId: "default",
      revision: 0,
      instructions: "Scheduled runs that fail\nMessages held for my review\n",
    });
    expect(page.textContent).toBe("");
    expect(done).toBe(1);
  });

  it("has the Center's rail with Home off, and not with Home on (where it heads Home instead)", async () => {
    const run = offering("Scheduled runs that fail\n");
    const summary: CenterSummaryAnswer = {
      workspaceId: "default",
      timezone: "UTC",
      today: "2026-10-11",
      counts: { approvals: 0, reviews: 0, questions: 0, runningTasks: 0, memoryProposals: 0, activeRoutines: 0, schedules: 0 },
      perDay: [{ date: "2026-10-11", tasks: 0 }],
      next: [],
      people: {},
      cursor: "c1",
    };
    const at = (homeChat: boolean) => (
      <WorkspaceProvider client={run.client} workspaceId="default" timeZone={undefined}>
        <CenterPage
          section="activity"
          sections={["activity", "heartbeat"]}
          feed={{ summary, error: undefined, revisions: {} }}
          homeChat={homeChat}
          onSection={() => undefined}
          onOpenRoutine={() => undefined}
          onOpenTask={() => Promise.resolve()}
          onPermissions={() => undefined}
        />
      </WorkspaceProvider>
    );
    const off = await mount(at(false));
    expect(off.querySelector(".center-rail .heartbeat-offer")).not.toBeNull();
    unmountAll();
    const on = await mount(at(true));
    expect(on.querySelector(".center-rail .heartbeat-offer")).toBeNull();
  });

  it("stays, saying why, when Turn on is refused", async () => {
    const page = await mount(
      <InWorkspace
        client={
          offering("Scheduled runs that fail\n", "The heartbeat changed since revision 0 (it is at 1); read it again and retry").client
        }
        workspaceId="default"
      >
        <HeartbeatOffer />
      </InWorkspace>,
    );
    await click(button(page, "Turn on"));
    expect(page.querySelector("[role='alert']")?.textContent).toContain("changed since revision 0");
    expect(button(page, "Turn on")?.disabled).toBe(false);
  });

  it("goes for good with Not now, and has no WCAG 2.1 A/AA violations axe can find", async () => {
    const run = offering("Scheduled runs that fail\n");
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <HeartbeatOffer />
      </InWorkspace>,
    );
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
    await click(button(page, "Not now"));
    expect(run.sent.at(-1)).toEqual({ action: "offer", workspaceId: "default" });
    expect(page.textContent).toBe("");
  });
});

describe("Center → Heartbeat while it is open", () => {
  it("reads the heartbeat again on its own, so a new check shows without a reload", async () => {
    const shown: HeartbeatTickRecord[] = [];
    const run = owner({ config: { enabled: true }, ticks: shown });
    const page = await mount(
      <InWorkspace client={run.client} workspaceId="default">
        <Heartbeat refreshMs={30} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("No checks yet.");
    shown.push(tick("fresh", { kind: "deep", outcome: "quiet" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await settle();
    expect(page.querySelector(".heartbeat-log")?.textContent).toContain("Looked deeper — all quiet");
  });
});
