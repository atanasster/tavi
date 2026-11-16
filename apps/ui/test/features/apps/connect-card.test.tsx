// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientResponse, ToolCard } from "@tavi/client/browser";
import { ONBOARDING_ABI, type ConnectableApp } from "@tavi/contracts";

import { ConnectCard, ConnectCardContext, continueMessage } from "../../../src/features/apps/ConnectCard.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { ONBOARDING_CHANGED_EVENT } from "../../../src/features/welcome/onboarding-api.js";
import { ToolGroup } from "../../../src/features/transcript/ToolCards.js";
import { clickSettled as click, settle } from "../../support/dom.js";

/** The connect card in a chat. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const button = (container: ParentNode, text: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);

const calendar: ConnectableApp = {
  appId: "calendar-app",
  name: "Calendar",
  summary: "",
  category: "calendar",
  source: { kind: "mcp", pluginIds: ["mcp.cal"], verified: "tavi-preset", isolation: "remote" },
  auth: { kind: "oauth", client: "shared-provider", provider: "example", scopes: [], stepUp: [] },
  tools: [],
  egress: { hosts: [], lan: false, anyNetwork: false },
  credentials: [],
  settings: [],
  trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
  accounts: [
    {
      accountId: "mcp.cal",
      label: "you@example.com",
      identity: "you@example.com",
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
  repairs: [],
  warnings: [],
};

/** The Calendar card for a task waiting on its account, mounted on its own. */
async function waitCard(client: SettingsClient, ask: Parameters<typeof ConnectCard>[0]["ask"]): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ConnectCardContext.Provider value={{ client, workspaceId: "default", onContinue: () => undefined, onDiscover: () => undefined }}>
        <ConnectCard ask={ask} />
      </ConnectCardContext.Provider>,
    ),
  );
  await settle();
  return host.querySelector('[aria-label="Connect Calendar"]') as HTMLElement;
}

function owner(apps: readonly ConnectableApp[] = [calendar]) {
  const sent: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      const body = payload as Record<string, unknown>;
      sent.push(body);
      if (command === "apps" && body["action"] === "list") return { ok: true, result: { apps } } as ClientResponse;
      if (command === "apps" && body["action"] === "show") return { ok: true, result: { app: apps[0] } } as ClientResponse;
      if (command === "apps" && body["action"] === "connect")
        return {
          ok: true,
          result: {
            connect: {
              flowId: "flow-1",
              authorizeUrl: "https://as.example/authorize",
              redirectUri: "http://localhost/oauth/callback",
              via: "here",
              accountId: "mcp.cal",
            },
          },
        } as ClientResponse;
      if (command === "apps" && body["action"] === "connect-status")
        return { ok: true, result: { status: { state: "done", accountId: "mcp.cal", identity: "you@example.com" } } } as ClientResponse;
      return { ok: true, result: {} } as ClientResponse;
    },
  };
  return { client, sent };
}

const failed = (output: unknown, toolName = "mcp.cal.list_events"): ToolCard => ({
  kind: "tool",
  key: `k-${toolName}`,
  attemptId: "a1",
  callId: "c1",
  toolName,
  status: "failed",
  errorCode: "TOOL_ERROR",
  message: JSON.stringify(output),
});

async function chat(cards: readonly ToolCard[], apps?: readonly ConnectableApp[]) {
  const { client, sent } = owner(apps);
  const continued: string[] = [];
  const discovered: string[] = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ConnectCardContext.Provider
        value={{ client, workspaceId: "default", onContinue: (text) => continued.push(text), onDiscover: (name) => discovered.push(name) }}
      >
        <ToolGroup cards={cards} failovers={[]} />
      </ConnectCardContext.Provider>,
    ),
  );
  await settle();
  return { view: host, sent, continued, discovered };
}

describe("the connect card", () => {
  it("shows Connect under a call that needs a sign-in, connects over the chat, then Continue posts the fixed message", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { view, sent, continued } = await chat([
      failed({ error: "SIGN_IN_REQUIRED", pluginId: "mcp.cal", detail: "Calendar needs the person to sign in again." }),
    ]);
    const card = view.querySelector('[aria-label="Connect Calendar"]') as HTMLElement;
    expect(card).not.toBeNull();
    // Shown with the block folded: the card is outside it.
    expect(card.closest("details")).toBeNull();
    await click(button(card, "Connect"));
    // The dialog opens once its app is read: waited for, not assumed.
    const dialog = await vi.waitFor(() => view.querySelector("dialog") ?? Promise.reject(new Error("no dialog yet")));
    await click(button(dialog, "Sign in to Calendar"));
    expect(sent.find((body) => body["action"] === "connect")).toMatchObject({ appId: "calendar-app", accountId: "mcp.cal" });
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    await settle();
    await settle();
    await click(button(dialog, "Done"));
    await settle();
    expect(card.textContent).toContain("Connected as you@example.com");
    await click(button(card, "Continue"));
    expect(continued).toEqual([continueMessage("Calendar")]);
    expect(continued[0]).toBe("Calendar is connected, please continue.");
    expect((button(card, "Continue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("draws nothing for another failure, or a call still running", async () => {
    const { view } = await chat([
      failed({ error: "TOOL_FAILED", detail: "mcp.cal needs a login" }),
      { ...failed({ error: "SIGN_IN_REQUIRED", pluginId: "mcp.cal" }), key: "k2", status: "running" },
    ]);
    expect(view.querySelector(".apps-connect-card")).toBeNull();
  });

  it("offers Add and connect for an app the agent asked for that is not added yet", async () => {
    const request: ToolCard = {
      kind: "tool",
      key: "k-req",
      attemptId: "a1",
      callId: "c2",
      toolName: "apps.request_connect",
      status: "completed",
      output: {
        connect: {
          name: "Home Assistant",
          installed: false,
          access: [],
          why: "To turn the lights off",
          entry: { kind: "preset", id: "homeassistant" },
        },
      },
    };
    const { view, discovered } = await chat([request]);
    const card = view.querySelector('[aria-label="Connect Home Assistant"]') as HTMLElement;
    // The agent's reason, quoted as its words.
    expect(card.textContent).toContain("Tavi says: “To turn the lights off”");
    await click(button(card, "Add and connect"));
    expect(discovered).toEqual(["Home Assistant"]);
  });

  it("connects an added app the agent asked for, at its account", async () => {
    const request: ToolCard = {
      kind: "tool",
      key: "k-req",
      attemptId: "a1",
      callId: "c2",
      toolName: "apps.request_connect",
      status: "completed",
      output: {
        connect: {
          appId: "calendar-app",
          name: "Calendar",
          installed: true,
          accountId: "mcp.cal",
          access: ["See your events"],
          why: "To find you a free hour",
        },
      },
    };
    vi.spyOn(window, "open").mockReturnValue(null);
    const { view, sent } = await chat([request]);
    const card = view.querySelector('[aria-label="Connect Calendar"]') as HTMLElement;
    expect(card.textContent).toContain("See your events");
    await click(button(card, "Connect"));
    await click(
      button(await vi.waitFor(() => view.querySelector("dialog") ?? Promise.reject(new Error("no dialog yet"))), "Sign in to Calendar"),
    );
    expect(sent.find((body) => body["action"] === "connect")).toMatchObject({ appId: "calendar-app", accountId: "mcp.cal" });
  });

  it("offers Not now for a task waiting on the account, settling only that wait", async () => {
    const { client, sent } = owner();
    const card = await waitCard(client, {
      kind: "wait",
      waitId: "w1",
      request: { appName: "Calendar", accountId: "mcp.cal", reason: "its sign-in expired", health: "needs-sign-in" },
      deadlineAt: "2026-10-16T09:30:00.000Z",
    });
    expect(card.textContent).toContain("needs you to sign in again before Tavi can go on: its sign-in expired.");
    // How long it waits.
    expect(card.textContent).toMatch(/Waits until .+, then goes on without it\./);
    await click(button(card, "Not now"));
    expect(sent.find((body) => body["action"] === "decline-connect")).toEqual({
      action: "decline-connect",
      workspaceId: "default",
      waitId: "w1",
    });
    expect(card.textContent).toContain("Tavi goes on without Calendar.");
    expect((button(card, "Connect") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for a first sign-in, not again, for an account never signed in (QA 2091)", async () => {
    const { client } = owner();
    const card = await waitCard(client, {
      kind: "wait",
      waitId: "w1",
      request: { appName: "Calendar", accountId: "mcp.cal", reason: "", health: "not-set-up" },
    });
    expect(card.textContent).toContain("Calendar isn't signed in yet: sign in before Tavi can go on.");
    expect(card.textContent).not.toContain("again");
  });

  it("says so when the app is gone, settles once it works, and asks once for a call retried", async () => {
    const gone = await chat([failed({ error: "SIGN_IN_REQUIRED", pluginId: "mcp.cal" })], []);
    expect(gone.view.textContent).toContain("This app is not added on this computer any more.");
    act(() => root?.unmount());
    const working = {
      ...calendar,
      health: "ready" as const,
      accounts: calendar.accounts.map((account) => ({ ...account, health: "ready" as const })),
    };
    const settled = await chat([failed({ error: "SIGN_IN_REQUIRED", pluginId: "mcp.cal" })], [working]);
    expect(settled.view.textContent).toContain("Calendar is connected");
    expect(button(settled.view, "Connect")).toBeUndefined();
    act(() => root?.unmount());
    const retried = await chat([
      failed({ error: "SIGN_IN_REQUIRED", pluginId: "mcp.cal" }),
      { ...failed({ error: "SIGN_IN_REQUIRED", pluginId: "mcp.cal" }), key: "k2", callId: "c2" },
    ]);
    expect(retried.view.querySelectorAll(".apps-connect-card")).toHaveLength(1);
  });
});

describe("the connect card and setup", () => {
  const FLOW = {
    providerId: "tavi.onboarding",
    flow: {
      abi: ONBOARDING_ABI,
      version: 1,
      title: "Welcome",
      steps: [
        { id: "model", kind: "model", title: "Model", body: "Pick one.", optional: false },
        { id: "apps", kind: "apps", title: "Connect an app", body: "Mail or calendar.", optional: true },
      ],
      done: { title: "Done", body: "Done." },
    },
  };
  const status = (apps: "todo" | "skipped" | "done") => ({
    workspaceId: "default",
    providerId: "tavi.onboarding",
    steps: [
      { kind: "model", state: "done", detail: "" },
      { kind: "apps", state: apps, detail: "" },
    ],
    complete: true,
    firstRun: false,
    open: apps === "done" ? [] : ["apps"],
  });

  it("names the setup step it finishes, opens it, says it is done once connected, and tells Home", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let connected = false;
    const base = owner();
    const client: SettingsClient = {
      request: async (command, payload, options) => {
        const action = (payload as Record<string, unknown>)["action"];
        if (command === "onboarding" && action === "flow") return { ok: true, result: FLOW } as ClientResponse;
        if (command === "onboarding" && action === "status")
          return { ok: true, result: status(connected ? "done" : "skipped") } as ClientResponse;
        if (command === "apps" && action === "connect-status") connected = true;
        return await base.client.request(command, payload, options);
      },
    };
    const opened: string[] = [];
    let announced = 0;
    const listener = () => {
      announced += 1;
    };
    window.addEventListener(ONBOARDING_CHANGED_EVENT, listener);
    try {
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      await act(async () =>
        root?.render(
          <ConnectCardContext.Provider
            value={{
              client,
              workspaceId: "default",
              onContinue: () => {},
              onDiscover: () => {},
              onSetup: (stepId) => void opened.push(stepId),
            }}
          >
            <ConnectCard ask={{ kind: "sign-in", pluginId: "mcp.cal" }} />
          </ConnectCardContext.Provider>,
        ),
      );
      await settle();
      const card = host.querySelector('[aria-label="Connect Calendar"]') as HTMLElement;
      expect(card.textContent).toContain("Connecting it also finishes setup's “Connect an app” step.");
      await click(button(card, "Open setup"));
      expect(opened).toEqual(["apps"]);
      await click(button(card, "Connect"));
      const dialog = host.querySelector("dialog") as HTMLElement;
      await click(button(dialog, "Sign in to Calendar"));
      await act(async () => {
        vi.advanceTimersByTime(2_100);
      });
      await settle();
      await settle();
      await click(button(dialog, "Done"));
      await settle();
      await settle();
      expect(card.textContent).toContain("Setup's “Connect an app” step is done.");
      expect(announced).toBeGreaterThanOrEqual(1);
    } finally {
      window.removeEventListener(ONBOARDING_CHANGED_EVENT, listener);
    }
  });

  it("reads nothing of setup for a card already connected, and says nothing when the step was done before", async () => {
    const asked: string[] = [];
    const ready = {
      ...calendar,
      health: "ready" as const,
      accounts: calendar.accounts.map((account) => ({ ...account, health: "ready" as const })),
    };
    for (const [apps, state] of [
      [[ready], "todo"],
      [[calendar], "done"],
    ] as const) {
      const base = owner(apps);
      const client: SettingsClient = {
        request: async (command, payload, options) => {
          const action = (payload as Record<string, unknown>)["action"];
          if (command === "onboarding") asked.push(`${String(action)}:${state}`);
          if (command === "onboarding" && action === "flow") return { ok: true, result: FLOW } as ClientResponse;
          if (command === "onboarding" && action === "status") return { ok: true, result: status(state) } as ClientResponse;
          return await base.client.request(command, payload, options);
        },
      };
      act(() => root?.unmount());
      host?.remove();
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      await act(async () =>
        root?.render(
          <ConnectCardContext.Provider
            value={{ client, workspaceId: "default", onContinue: () => {}, onDiscover: () => {}, onSetup: () => {} }}
          >
            <ConnectCard ask={{ kind: "sign-in", pluginId: "mcp.cal" }} />
          </ConnectCardContext.Provider>,
        ),
      );
      await settle();
      expect(host.textContent).not.toContain("setup");
    }
    // The connected card asked nothing; the open one read the status alone, the step being done.
    expect(asked).toEqual(["status:done"]);
  });

  it("says nothing of setup where the owner offers none", async () => {
    const { view } = await chat([failed({ error: "SIGN_IN_REQUIRED", pluginId: "mcp.cal" })]);
    expect(view.textContent).not.toContain("setup");
  });
});
