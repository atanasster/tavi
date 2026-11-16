import type { CatalogEntry, ConnectableApp } from "@tavi/contracts";
import { ATTENDED_TASK_POLICY, WorkflowWaitSuspend } from "@tavi/contracts";
import { ToolRegistry } from "@tavi/runtime";
import { describe, expect, it } from "vitest";

import { registerAppsTools, requestConnect, type AppsToolOptions } from "../../src/features/apps/tool.js";

/** `apps.request_connect`: the agent asks; the person connects. */

const calendar: ConnectableApp = {
  appId: "google-calendar",
  name: "Google Calendar",
  summary: "",
  category: "calendar",
  source: { kind: "mcp", pluginIds: ["mcp.gcal"], preset: "google-calendar", verified: "tavi-preset", isolation: "remote" },
  auth: {
    kind: "oauth",
    client: "shared-provider",
    provider: "google",
    scopes: [{ scope: "calendar.events", says: "See and change events on your calendars", access: "change", optional: false }],
    stepUp: [],
  },
  tools: [],
  egress: { hosts: [], lan: false, anyNetwork: false },
  credentials: [],
  settings: [],
  trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
  accounts: [
    {
      accountId: "mcp.gcal",
      label: "me@example.com",
      identity: "me@example.com",
      owner: { kind: "owner" },
      health: "needs-sign-in",
      grantedScopes: [],
      missingScopes: [],
      expiresWeekly: false,
      workspaces: ["default"],
      people: false,
      sharing: "personal",
      readOnly: false,
    },
  ],
  health: "needs-sign-in",
  repairs: [
    {
      kind: "sign-in",
      accountId: "mcp.gcal",
      title: "Sign in to Google Calendar again",
      detail: "Its sign-in expired.",
      cli: "tavi mcp login mcp.gcal",
    },
  ],
  warnings: [],
};
const homeAssistant: CatalogEntry = {
  ref: { kind: "preset", id: "homeassistant" },
  name: "Home Assistant",
  summary: "Your home.",
  category: "home",
  auth: "api-key",
  badges: ["tavi-preset"],
  installed: false,
  options: [],
};

const options = (apps: readonly ConnectableApp[] = [calendar]): AppsToolOptions & { readonly reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    operatorOf: () => "operator",
    apps: async (workspaceId) => {
      reads.push(`apps:${workspaceId}`);
      return apps;
    },
    catalog: async (workspaceId) => {
      reads.push(`catalog:${workspaceId}`);
      return [homeAssistant];
    },
  };
};

describe("apps.request_connect", () => {
  it("names an added app, its account needing sign-in, and what signing in lets it do, by id or name", async () => {
    const answer = {
      appId: "google-calendar",
      name: "Google Calendar",
      installed: true,
      health: "needs-sign-in",
      accountId: "mcp.gcal",
      access: ["See and change events on your calendars"],
      why: "To find you a free hour",
    };
    expect(await requestConnect(options(), "default", { appId: "google-calendar", why: "To find you a free hour" })).toEqual(answer);
    expect(await requestConnect(options(), "default", { appId: "google calendar", why: "To find you a free hour" })).toEqual(answer);
  });

  it("offers Add and connect for an app not added yet, by its catalog entry", async () => {
    expect(await requestConnect(options(), "default", { appId: "homeassistant", why: "To turn the lights off" })).toEqual({
      name: "Home Assistant",
      installed: false,
      access: [],
      why: "To turn the lights off",
      entry: { kind: "preset", id: "homeassistant" },
    });
  });

  it("refuses an app it does not know, naming the ones it does", async () => {
    await expect(requestConnect(options(), "default", { appId: "notion", why: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "no app notion; the apps are: google-calendar, homeassistant",
    });
  });

  it("is a read-only tool with no sink, that only reads the apps: it cannot start a sign-in", async () => {
    const registry = new ToolRegistry();
    const reading = options();
    registerAppsTools(registry, reading);
    const tool = registry.get("apps.request_connect");
    expect(tool).toMatchObject({ effect: "read-only", sink: "none" });
    expect(
      await tool?.handler({
        input: { appId: "google-calendar", why: "To plan" },
        context: { workspaceId: "default", principalId: "operator", runId: "t", caller: "test" },
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ connect: { appId: "google-calendar", installed: true } });
    expect(reading.reads).toEqual(["apps:default"]);
  });

  it("is the operator's: offered to them alone, and refused to anyone else", async () => {
    const registry = new ToolRegistry();
    registerAppsTools(registry, options());
    expect(
      (await registry.listOffered({ workspaceId: "default", principalId: "operator", operator: true })).some(
        (tool) => tool.id === "apps.request_connect",
      ),
    ).toBe(true);
    expect(
      (await registry.listOffered({ workspaceId: "default", principalId: "ana", operator: false })).some(
        (tool) => tool.id === "apps.request_connect",
      ),
    ).toBe(false);
    await expect(
      registry.get("apps.request_connect")?.handler({
        input: { appId: "google-calendar", why: "To plan" },
        context: { workspaceId: "default", principalId: "ana", runId: "t", caller: "test" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("waits for the app's sign-in where its person may be asked, then answers from the app as it is", async () => {
    const tool = (apps: readonly ConnectableApp[]) => {
      const registry = new ToolRegistry();
      registerAppsTools(registry, options(apps));
      return registry.get("apps.request_connect");
    };
    const context = { workspaceId: "default", principalId: "operator", runId: "t", caller: "test" };
    const asked: unknown[] = [];
    // The workflow's ask suspends the task the first time; once settled, the call runs again from the top.
    const suspending = async (question: unknown): Promise<never> => {
      asked.push(question);
      throw new WorkflowWaitSuspend({ waitId: "w1", deadlineAt: "2026-10-16T09:30:00.000Z" });
    };
    const call = (apps: readonly ConnectableApp[], ask: (question: unknown) => Promise<unknown>) =>
      tool(apps)?.handler({
        input: { appId: "google-calendar", why: "To find you a free hour" },
        context,
        signal: new AbortController().signal,
        executionPolicy: ATTENDED_TASK_POLICY,
        ask,
      } as never);
    await expect(call([calendar], suspending)).rejects.toBeInstanceOf(WorkflowWaitSuspend);
    expect(asked).toEqual([
      expect.objectContaining({
        key: "connect",
        connect: expect.objectContaining({
          appId: "google-calendar",
          accountId: "mcp.gcal",
          reason: "To find you a free hour",
          health: "needs-sign-in",
        }),
      }),
    ]);
    // Run again after the person signed in: the app is ready, and the call says so.
    const ready = {
      ...calendar,
      health: "ready" as const,
      repairs: [],
      accounts: calendar.accounts.map((account) => ({ ...account, health: "ready" as const })),
    };
    expect(await call([ready], suspending)).toEqual({ connected: { appId: "google-calendar", name: "Google Calendar" } });
    // Run again and still not signed in: the call fails, never claims it connected.
    await expect(call([calendar], async () => ({ kind: "answered", connect: { outcome: "connected" } }))).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
  });
});
