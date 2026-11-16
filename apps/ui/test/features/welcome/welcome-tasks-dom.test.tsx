// @vitest-environment jsdom
import type { ConnectableApp, OnboardingFlowStep, OnboardingStatus } from "@tavi/contracts";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";

import type { SettingsClient } from "../../../src/lib/ipc.js";
import { homeOfAccount, TasksStep } from "../../../src/features/welcome/WelcomeTasksStep.js";
import { flush, settledBy } from "../../support/dom.js";

/**
 * Setup's "Where do you keep tasks?" on the canvas: Tavi's own list marks
 * the step done with nothing saved (clearing a task app saved before), a
 * connected task app is saved as `tasks.home: mcp:<server>`, and Todoist is
 * added from its preset and signed in with the Apps page's connect sheet.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What was asked answered: six turns of the microtask queue. */
const { mount: mountFlushed, click } = settledBy(() => flush(6));
const button = (container: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text)) as HTMLButtonElement | undefined;

function owner(answers: Record<string, unknown | ((payload: Record<string, unknown>) => unknown)>) {
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  const client: SettingsClient = {
    request: (async (command: string, payload: Record<string, unknown>) => {
      sent.push({ command, payload });
      const answer = answers[`${command}:${String(payload["action"])}`];
      const value = typeof answer === "function" ? (answer as (payload: Record<string, unknown>) => unknown)(payload) : answer;
      if (value instanceof Error) return { ok: false, error: { code: "INVALID_INPUT", message: value.message } };
      return { ok: true, result: value ?? {} };
    }) as SettingsClient["request"],
  };
  const writes = () => sent.filter((entry) => entry.command === "workspace-settings" && entry.payload["action"] !== "get");
  return { client, sent, writes, actions: () => sent.map((entry) => `${entry.command}:${String(entry.payload["action"])}`) };
}

const STEP: OnboardingFlowStep = { id: "tasks", kind: "tasks", title: "Where do you keep tasks?", body: "", optional: true };
const status = (
  items: NonNullable<OnboardingStatus["steps"][number]["items"]> = [],
  state: "todo" | "done" = "todo",
): OnboardingStatus => ({
  workspaceId: "default",
  providerId: "tavi.onboarding",
  steps: [
    { kind: "model", state: "done", detail: "" },
    { kind: "tasks", state, detail: state === "done" ? "Tavi's own list" : "", ...(items.length === 0 ? {} : { items }) },
  ],
  complete: true,
  firstRun: false,
  open: state === "done" ? [] : ["tasks"],
});
const settings = (tasksHome?: string) => ({
  workspaceId: "default",
  revision: 7,
  settings: tasksHome === undefined ? {} : { tasksHome },
  effective: { timezone: "UTC", tasksHome: tasksHome ?? "tavi" },
  hostTimezone: "UTC",
});

const TODOIST = {
  appId: "todoist",
  name: "Todoist",
  summary: "Add, find, change and complete your Todoist tasks.",
  category: "tasks",
  source: { kind: "mcp", pluginIds: ["mcp.todoist"], verified: "tavi-preset", isolation: "remote" },
  auth: { kind: "oauth", client: "registration", scopes: [], stepUp: [] },
  tools: [],
  egress: { hosts: ["ai.todoist.net"], lan: false, anyNetwork: false },
  credentials: [],
  settings: [],
  trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
  accounts: [],
  health: "needs-sign-in",
  repairs: [],
  warnings: [],
} as unknown as ConnectableApp;

async function mount(client: SettingsClient, current: OnboardingStatus, handlers: { onDone?: () => void; onStatus?: () => void } = {}) {
  return mountFlushed(
    <TasksStep
      client={client}
      workspaceId="default"
      step={STEP}
      status={current}
      providerId="tavi.onboarding"
      appsBefore={new Set()}
      onStep={() => {}}
      onLeave={() => {}}
      onSettings={() => {}}
      onDone={handlers.onDone ?? (() => {})}
      onStatus={handlers.onStatus ?? (() => {})}
    />,
  );
}

describe("the tasks step", () => {
  it("keeps Tavi's own list with nothing saved, marks the step done and moves on", async () => {
    const done = status([], "done");
    const { client, writes, sent } = owner({
      "apps:list": { apps: [] },
      "workspace-settings:get": settings(),
      "onboarding:complete-step": done,
    });
    const onDone = vi.fn();
    const onStatus = vi.fn();
    const page = await mount(client, status(), { onDone, onStatus });
    expect(page.textContent).toContain("Tavi’s own list");
    expect(button(page, "Connect")?.getAttribute("aria-label")).toBe("Connect Todoist");
    const results = await axe.run(page, { rules: { region: { enabled: false } } });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
    await click(button(page, "Use Tavi’s list"));
    expect(writes()).toEqual([]);
    expect(sent.find((entry) => entry.payload["action"] === "complete-step")?.payload).toMatchObject({ step: "tasks", surface: "web" });
    expect(onStatus).toHaveBeenCalledWith(done);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("clears a task app saved before when Tavi's own list is chosen, at the revision it read", async () => {
    const { client, writes } = owner({
      "apps:list": { apps: [] },
      "workspace-settings:get": settings("mcp:todoist"),
      "workspace-settings:unset": settings(),
      "onboarding:complete-step": status([], "done"),
    });
    const page = await mount(client, status());
    await click(button(page, "Use Tavi’s list"));
    expect(writes().map((entry) => entry.payload)).toEqual([
      { action: "unset", workspaceId: "default", key: "tasksHome", expectedRevision: 7 },
    ]);
  });

  it("saves a connected task app as the home, and offers no second Todoist", async () => {
    const { client, writes, actions } = owner({
      "apps:list": { apps: [TODOIST] },
      "workspace-settings:get": settings(),
      "workspace-settings:set": settings("mcp:todoist"),
      "onboarding:status": status([{ id: "mcp:todoist", label: "Todoist", state: "connected" }], "done"),
    });
    const onDone = vi.fn();
    const page = await mount(client, status([{ id: "mcp:todoist", label: "Todoist", state: "connected" }]), { onDone });
    expect(button(page, "Connect")).toBeUndefined();
    await click(button(page, "Use Todoist"));
    expect(writes().map((entry) => entry.payload)).toEqual([
      { action: "set", workspaceId: "default", key: "tasksHome", value: "mcp:todoist", expectedRevision: 7 },
    ]);
    expect(actions()).not.toContain("onboarding:complete-step");
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("adds Todoist from its preset when it is not yet, then opens the Apps page's connect sheet", async () => {
    let added = false;
    const { client, sent } = owner({
      "apps:list": () => ({ apps: added ? [TODOIST] : [] }),
      "apps:add": () => {
        added = true;
        return { added: { appId: "todoist", pluginId: "mcp.todoist" } };
      },
      "onboarding:status": status(),
    });
    const page = await mount(client, status());
    await click(button(page, "Connect"));
    expect(sent.find((entry) => entry.payload["action"] === "add")?.payload).toMatchObject({ entry: { kind: "preset", id: "todoist" } });
    expect(document.body.textContent).toContain("Connect Todoist");
  });

  it("names the task home an MCP account is, and none for another", () => {
    expect(homeOfAccount("mcp.todoist")).toBe("mcp:todoist");
    expect(homeOfAccount("acme.tasks")).toBeUndefined();
  });
});
