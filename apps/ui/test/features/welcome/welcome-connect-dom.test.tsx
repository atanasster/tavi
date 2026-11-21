// @vitest-environment jsdom
import type { ConnectableApp, OnboardingFlowStep, OnboardingStatus } from "@tavi/contracts";
import axe from "axe-core";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SettingsClient } from "../../../src/lib/ipc.js";
import { AppsStep, ChannelsStep, scopeSentence } from "../../../src/features/welcome/ConnectSteps.js";
import { PAIRING_POLL_MS } from "../../../src/features/welcome/channel-setup.js";
import { flush, settledBy, unmountAll } from "../../support/dom.js";

/**
 * Setup's apps and channels steps: the
 * featured app cards with what each may do, connected once the owner says
 * so; a channel tested before it stays, a wrong token leaving nothing behind;
 * and a channel not set up until its operator sent the code and confirmed it
 * was them.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});
/** What was asked answered: microtasks only, as tests here fake the clock. */
const { settle, mount: mountFlushed, click } = settledBy(() => flush(6));
/** `node` mounted alone: the view before it taken down first. */
async function mount(node: React.ReactNode): Promise<HTMLElement> {
  unmountAll();
  return mountFlushed(node);
}
async function type(input: Element | null, value: string): Promise<void> {
  if (!(input instanceof HTMLInputElement)) throw new Error("no field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
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
      const refusal = (value as { readonly refusal?: unknown } | undefined)?.refusal;
      if (refusal !== undefined) return { ok: false, error: refusal };
      return { ok: true, result: value ?? {} };
    }) as SettingsClient["request"],
  };
  return { client, sent, actions: () => sent.map((entry) => `${entry.command}:${String(entry.payload["action"])}`) };
}

const STATUS: OnboardingStatus = {
  workspaceId: "default",
  providerId: "tavi.onboarding",
  steps: [{ kind: "model", state: "done", detail: "" }],
  complete: true,
  firstRun: false,
  open: [],
};

const app = (appId: string, name: string, health: "ready" | "needs-sign-in"): ConnectableApp =>
  ({
    appId,
    name,
    summary: `${name} for Tavi.`,
    category: "calendar",
    source: { kind: "mcp", pluginIds: [`mcp.${appId}`], verified: "tavi-preset", isolation: "remote" },
    auth: {
      kind: "oauth",
      client: "shared-provider",
      provider: "google",
      scopes: [{ scope: "events", says: "See and change events on your calendars", access: "change", optional: false }],
      stepUp: [],
    },
    tools: [
      {
        toolId: `mcp.${appId}.list`,
        title: "List",
        access: "read",
        effect: "read-only",
        sink: "network",
        state: "offered",
        decision: "allow",
        because: ["default-read"],
        canSetHere: ["allow", "ask", "block"],
      },
    ],
    egress: { hosts: ["example.com"], lan: false, anyNetwork: false },
    credentials: [],
    settings: [],
    trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
    accounts:
      health === "ready"
        ? [
            {
              accountId: `mcp.${appId}`,
              label: "you@example.com",
              owner: { kind: "owner" },
              health: "ready",
              grantedScopes: [],
              missingScopes: [],
              expiresWeekly: false,
              workspaces: ["default"],
              people: false,
              sharing: "personal",
              readOnly: false,
            },
          ]
        : [],
    health,
    repairs: [],
    warnings: [],
  }) as ConnectableApp;

const APPS_STEP: OnboardingFlowStep = {
  id: "apps",
  kind: "apps",
  title: "Connect an app",
  body: "",
  optional: true,
  featured: ["google-calendar", "gmail"],
};
const CHANNELS_STEP: OnboardingFlowStep = {
  id: "channels",
  kind: "channels",
  title: "Message Tavi",
  body: "",
  optional: true,
  featured: ["telegram"],
};

describe("the apps step", () => {
  it("shows the featured apps in the flow's order with what each may do, and a connected one as connected", async () => {
    const { client } = owner({
      "apps:list": {
        apps: [
          app("gmail", "Gmail", "needs-sign-in"),
          app("google-calendar", "Google Calendar", "ready"),
          app("other", "Other", "needs-sign-in"),
        ],
      },
      "onboarding:status": STATUS,
    });
    const onSettings = vi.fn();
    const page = await mount(
      <AppsStep client={client} workspaceId="default" step={APPS_STEP} onStatus={() => {}} onSettings={onSettings} />,
    );
    expect([...page.querySelectorAll(".welcome-card h2")].map((heading) => heading.textContent)).toEqual(["Google Calendar", "Gmail"]);
    expect(page.textContent).toContain("See and change events on your calendars. Anything that changes or sends something asks you first.");
    expect(page.querySelector(".welcome-card")?.textContent).toContain("Connected");
    expect(button(page, "Connect")?.getAttribute("aria-label")).toBe("Connect Gmail");
    await click(button(page, "See all apps"));
    expect(onSettings).toHaveBeenCalledWith("apps");
    const results = await axe.run(page, { rules: { region: { enabled: false } } });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("opens the Apps page's connect sheet, and turns the card to connected with the status read again", async () => {
    let connected = false;
    const onStatus = vi.fn();
    const { client, actions } = owner({
      "apps:list": () => ({ apps: [app("gmail", "Gmail", connected ? "ready" : "needs-sign-in")] }),
      "onboarding:status": STATUS,
    });
    const page = await mount(
      <AppsStep
        client={client}
        workspaceId="default"
        step={{ ...APPS_STEP, featured: ["gmail"] }}
        onStatus={onStatus}
        onSettings={() => {}}
      />,
    );
    await click(button(page, "Connect"));
    expect(document.body.textContent).toContain("Connect Gmail");
    expect(document.body.textContent).toContain("See and change events on your calendars");
    connected = true;
    await click(button(document.body, "Cancel") ?? button(document.body, "Close"));
    expect(page.textContent).toContain("Connected");
    expect(actions()).toContain("onboarding:status");
    expect(onStatus).toHaveBeenCalledWith(STATUS);
  });

  it("says a read-only app cannot change anything", () => {
    const reader = { ...app("feed", "Feed", "ready"), auth: { kind: "none" } } as ConnectableApp;
    expect(scopeSentence(reader)).toBe("Read what Feed holds. It cannot change or send anything.");
  });
});

const TELEGRAM = {
  providerId: "telegram",
  label: "Telegram",
  kind: "chat",
  description: "Telegram bots.",
  settings: [],
  auth: { kind: "secrets", fields: [{ key: "botToken", label: "Bot token" }] },
  sender: { label: "User id", placeholder: "", pattern: ".*", normalize: "none", authentication: "provider" },
  target: { label: "Chat id", placeholder: "", pattern: ".*", normalize: "none" },
  setupHelp: "Create a bot with @BotFather and paste its token.",
};

function channelOwner(extra: Record<string, unknown> = {}) {
  let polls = 0;
  return owner({
    "channels:catalog": { channels: [TELEGRAM] },
    "channels:list": { connections: [], oauthClients: {} },
    "channels:people": { people: [], operator: "robin" },
    "channels:save": { connectionId: "telegram" },
    "onboarding:created": STATUS,
    "channels:probe": {
      ok: true,
      detail: "Bot @tavi_test_bot.",
      setup: { lines: [], link: { label: "@tavi_test_bot", url: "https://t.me/tavi_test_bot" } },
    },
    "workspace-settings:get": { workspaceId: "default", revision: 1, settings: { operatorName: "Robin" }, effective: { timezone: "UTC" } },
    "channels:pair": {
      pairingId: "p1",
      code: "ABCD2345",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      // The owner builds the deep link from the channel's pairing template.
      account: "tavi_test_bot",
      linkUrl: "https://t.me/tavi_test_bot?start=ABCD-2345",
      openLabel: "Open in Telegram",
    },
    "channels:pairing": () =>
      (polls += 1) < 2 ? { state: "waiting" } : { state: "claimed", sender: "99887766", senderName: "Robin (@robin)" },
    "channels:confirm-pair": {},
    "channels:cancel-pair": {},
    "channels:delete": {},
    "onboarding:status": STATUS,
    ...extra,
  });
}

describe("the channels step", () => {
  it("adds Telegram from its descriptor, tests it, and pairs the operator with a code they confirm", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { client, sent, actions } = channelOwner();
    const onStatus = vi.fn();
    const page = await mount(
      <ChannelsStep client={client} workspaceId="default" step={CHANNELS_STEP} onStatus={onStatus} onSettings={() => {}} />,
    );
    await click(button(page, "Telegram"));
    expect(page.textContent).toContain("Create a bot with @BotFather");
    // Welcome's own Back shares the screen: this one says where it goes.
    expect(button(page, "Back to channels")).toBeDefined();
    await type(page.querySelector("input[type='password']"), "123:secret-token");
    await click(button(page, "Test and add"));
    expect(sent.find((entry) => entry.payload["action"] === "save")?.payload).toMatchObject({
      providerId: "telegram",
      secrets: { botToken: "123:secret-token" },
    });
    expect(sent.find((entry) => entry.payload["action"] === "created")?.payload).toMatchObject({ step: "channels", ref: "telegram" });
    expect(page.innerHTML).not.toContain("secret-token");
    await click(button(page, "Get a code"));
    expect(sent.find((entry) => entry.payload["action"] === "pair")?.payload).toMatchObject({
      connectionId: "telegram",
      principalId: "robin",
      name: "Robin",
    });
    expect(page.querySelector("code[data-pairing-code]")?.textContent).toBe("ABCD-2345");
    expect(page.querySelector("a")?.getAttribute("href")).toBe("https://t.me/tavi_test_bot");
    expect(page.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("QR code to link on Telegram");
    expect(page.querySelector(".pairing-command code")?.textContent).toBe("/link ABCD-2345");
    expect(page.querySelector(".pairing-links a")?.getAttribute("href")).toBe("https://t.me/tavi_test_bot?start=ABCD-2345");
    expect(page.textContent).toMatch(/within (10:00|9:5\d)/u);
    // Not set up until confirmed: no binding is asked for before "Yes".
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS);
      });
      await settle();
    }
    expect(page.textContent).toContain("A message from Robin (@robin) (99887766) carried the code. Is this you?");
    expect(document.activeElement?.textContent).toContain("A message from Robin (@robin) (99887766) carried the code.");
    expect(actions()).not.toContain("channels:confirm-pair");
    await click(button(page, "Yes, it's me"));
    expect(actions()).toContain("channels:confirm-pair");
    expect(page.textContent).toContain("Paired");
    expect(onStatus).toHaveBeenCalledWith(STATUS);
  });

  it("removes a connection whose token the bot refused, saying why", async () => {
    const { client, actions } = channelOwner({ "channels:probe": { ok: false, detail: "Unauthorized" } });
    const page = await mount(
      <ChannelsStep client={client} workspaceId="default" step={CHANNELS_STEP} onStatus={() => {}} onSettings={() => {}} />,
    );
    await click(button(page, "Telegram"));
    await type(page.querySelector("input[type='password']"), "wrong");
    await click(button(page, "Test and add"));
    expect(actions()).toContain("channels:delete");
    expect(page.querySelector("[role='alert']")?.textContent).toContain("Telegram failed its check: Unauthorized");
    expect((page.querySelector("input[type='password']") as HTMLInputElement).value).toBe("");
  });

  it("pairs on a connection already there but not paired, rather than adding a second; Not me binds nobody", async () => {
    const { client, actions } = channelOwner({
      "channels:list": {
        connections: [{ connectionId: "tg-1", providerId: "telegram", label: "My bot", enabled: true }],
        oauthClients: {},
      },
      "channels:pairing": { state: "claimed", sender: "@stranger" },
    });
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const page = await mount(
      <ChannelsStep client={client} workspaceId="default" step={CHANNELS_STEP} onStatus={() => {}} onSettings={() => {}} />,
    );
    expect(page.textContent).toContain("Pair yourself on My bot");
    await click(button(page, "Get a code"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS);
    });
    await settle();
    await click(button(page, "Not me"));
    expect(actions()).toContain("channels:cancel-pair");
    expect(actions()).not.toContain("channels:confirm-pair");
    expect(actions()).not.toContain("channels:save");
    expect(page.textContent).toContain("Not paired.");
  });

  it("clears the token after a refused save, and removes a connection that could not open or be recorded", async () => {
    const refused = channelOwner({ "channels:save": new Error("the token is malformed") });
    const page = await mount(
      <ChannelsStep client={refused.client} workspaceId="default" step={CHANNELS_STEP} onStatus={() => {}} onSettings={() => {}} />,
    );
    await click(button(page, "Telegram"));
    await type(page.querySelector("input[type='password']"), "bad");
    await click(button(page, "Test and add"));
    expect(page.querySelector("[role='alert']")?.textContent).toContain("the token is malformed");
    expect((page.querySelector("input[type='password']") as HTMLInputElement).value).toBe("");
    expect(refused.actions()).not.toContain("channels:delete");

    for (const extra of [
      { "channels:save": { connectionId: "telegram", notApplied: "the bot is already polled elsewhere" } },
      { "onboarding:created": new Error("busy") },
    ]) {
      const owner = channelOwner(extra);
      unmountAll();
      const again = await mount(
        <ChannelsStep client={owner.client} workspaceId="default" step={CHANNELS_STEP} onStatus={() => {}} onSettings={() => {}} />,
      );
      await click(button(again, "Telegram"));
      await type(again.querySelector("input[type='password']"), "123:x");
      await click(button(again, "Test and add"));
      expect(owner.actions()).toContain("channels:delete");
      expect(owner.actions()).not.toContain("channels:probe");
      expect(again.querySelector("[role='alert']")).not.toBeNull();
    }
  });

  it("says a removal that failed, so a bad connection is not left unmentioned", async () => {
    const { client } = channelOwner({ "channels:probe": { ok: false, detail: "Unauthorized" }, "channels:delete": new Error("locked") });
    const page = await mount(
      <ChannelsStep client={client} workspaceId="default" step={CHANNELS_STEP} onStatus={() => {}} onSettings={() => {}} />,
    );
    await click(button(page, "Telegram"));
    await type(page.querySelector("input[type='password']"), "wrong");
    await click(button(page, "Test and add"));
    expect(page.querySelector("[role='alert']")?.textContent).toContain(
      "It could not be removed (locked): remove it in Settings → Channels.",
    );
  });

  it("says a code can't reach a bot that isn't running in the canvas's words, linking to Channels (QA 2033)", async () => {
    const { client } = channelOwner({
      "channels:list": {
        connections: [{ connectionId: "tg-1", providerId: "telegram", label: "My bot", enabled: true }],
        oauthClients: {},
      },
      "channels:pair": {
        refusal: {
          code: "NOT_CONFIGURED",
          message:
            "Telegram isn't running: Telegram getMe failed for connection tg-1: Unauthorized. Fix it in Settings → Channels (or `tavi channels list`) first: a code sent to it could not arrive.",
          details: { notListening: true, label: "Telegram" },
        },
      },
    });
    const page = await mount(
      <ChannelsStep client={client} workspaceId="default" step={CHANNELS_STEP} onStatus={() => {}} onSettings={() => {}} />,
    );
    await click(button(page, "Get a code"));
    const alert = page.querySelector("[role='alert']");
    expect(alert?.textContent).toBe(
      "Telegram isn't running, so a code sent to it could not arrive. Fix it in Settings → Channels, which says why.",
    );
    expect(alert?.querySelector('a[href="/settings/messaging"]')).not.toBeNull();
  });

  it("offers a new code once one expired, and says when a check fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let answer: unknown = new Error("the owner is restarting");
    const { client, actions } = channelOwner({
      "channels:list": {
        connections: [{ connectionId: "tg-1", providerId: "telegram", label: "My bot", enabled: true }],
        oauthClients: {},
      },
      "channels:pairing": () => answer,
    });
    const page = await mount(
      <ChannelsStep client={client} workspaceId="default" step={CHANNELS_STEP} onStatus={() => {}} onSettings={() => {}} />,
    );
    await click(button(page, "Get a code"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS);
    });
    await settle();
    expect(page.querySelector("[role='alert']")?.textContent).toContain("Could not check for your message: the owner is restarting");
    answer = { state: "expired" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS);
    });
    await settle();
    expect(page.textContent).toContain("The code is no longer valid.");
    await click(button(page, "Get a new code"));
    expect(actions().filter((action) => action === "channels:pair")).toHaveLength(2);
    expect(page.querySelector("code[data-pairing-code]")).not.toBeNull();
  });

  it("says it is paired when reopened, and offers no second bot", async () => {
    const { client, actions } = channelOwner({
      "channels:list": {
        connections: [{ connectionId: "tg-1", providerId: "telegram", label: "My bot", enabled: true }],
        oauthClients: {},
      },
      "channels:people": {
        people: [
          {
            connectionId: "tg-1",
            externalSenderId: "1",
            workspaceId: "default",
            principalId: "robin",
            approvedBy: "robin",
            createdAt: "2026-10-20T00:00:00Z",
          },
        ],
        operator: "robin",
      },
    });
    const page = await mount(
      <ChannelsStep client={client} workspaceId="default" step={CHANNELS_STEP} onStatus={() => {}} onSettings={() => {}} />,
    );
    expect(page.textContent).toContain("Paired on My bot");
    expect(button(page, "Telegram")).toBeUndefined();
    expect(actions()).not.toContain("channels:pair");
  });

  it("sends a channel Welcome cannot add to Settings, and says pairing needs an operator", async () => {
    const onSettings = vi.fn();
    const oauth = channelOwner({ "channels:catalog": { channels: [{ ...TELEGRAM, auth: { kind: "none" } }] } });
    const page = await mount(
      <ChannelsStep client={oauth.client} workspaceId="default" step={CHANNELS_STEP} onStatus={() => {}} onSettings={onSettings} />,
    );
    expect(page.textContent).toContain("Only people you pair can message Tavi there.");
    // Said once, by the step: not again under the choices.
    expect(page.textContent).not.toContain("Strangers are never answered");
    await click(button(page, "Telegram (in Settings)"));
    expect(onSettings).toHaveBeenCalledWith("messaging");
    unmountAll();
    const nobody = channelOwner({ "channels:people": { people: [] } });
    const alone = await mount(
      <ChannelsStep client={nobody.client} workspaceId="default" step={CHANNELS_STEP} onStatus={() => {}} onSettings={() => {}} />,
    );
    expect(alone.textContent).toContain("Pairing needs a workspace operator");
    expect(button(alone, "Telegram")).toBeUndefined();
  });
});
