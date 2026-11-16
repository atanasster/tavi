// @vitest-environment jsdom
import axe from "axe-core";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientResponse } from "@tavi/client/browser";
import type { AppsCatalogAnswer, ConnectableApp } from "@tavi/contracts";

import { ConnectedApps, type AppsWhere } from "../../../src/features/apps/ConnectedApps.js";
import { delay } from "../../../src/lib/delay.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { clickSettled as click, mountSettled as mount, rerender, settle, unmountAll } from "../../support/dom.js";

/** Settings → Connected apps: what the page shows, and what each control asks the owner. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalMatchMedia = window.matchMedia;
const phone = (on: boolean): void => {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes("720px"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
};
beforeEach(() => phone(false));
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

async function type(input: Element | null | undefined, value: string): Promise<void> {
  if (!(input instanceof HTMLInputElement)) throw new Error("no input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (container: ParentNode, text: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
const labelled = (container: ParentNode, text: string) => {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim() === text);
  return label?.htmlFor === undefined || label.htmlFor === ""
    ? label?.querySelector("input")
    : container.querySelector(`#${CSS.escape(label.htmlFor)}`);
};

async function axeClean(element: HTMLElement): Promise<void> {
  const result = await axe.run(element, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.html).join(" | ")}`)).toEqual([]);
}

const NOW = "2026-10-16T09:00:00.000Z";

const app = (extra: Partial<ConnectableApp> = {}): ConnectableApp => ({
  appId: "calendar-app",
  name: "Calendar",
  summary: "Read your schedule and add events, asking first.",
  category: "calendar",
  publisher: "Example",
  source: { kind: "mcp", pluginIds: ["mcp.cal"], preset: "calendar-preset", verified: "tavi-preset", isolation: "remote" },
  auth: {
    kind: "oauth",
    client: "shared-provider",
    provider: "example",
    scopes: [{ scope: "events", says: "See and change events on your calendars", access: "change", optional: false }],
    stepUp: [],
  },
  tools: [
    {
      toolId: "mcp.cal.list_events",
      title: "List events",
      access: "read",
      effect: "read-only",
      sink: "network",
      state: "offered",
      decision: "allow",
      because: ["default-read"],
      canSetHere: ["allow", "ask", "block"],
    },
    {
      toolId: "mcp.cal.create_event",
      title: "Create an event",
      says: "Can invite attendees",
      saysSource: "tavi",
      access: "send",
      effect: "external",
      sink: "network",
      state: "offered",
      decision: "ask",
      because: ["default-write", "never-always"],
      canSetHere: ["ask", "block"],
    },
  ],
  egress: { hosts: ["calendar.example.com"], lan: false, anyNetwork: false },
  credentials: [{ name: "sign-in", raw: false }],
  settings: [],
  trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
  accounts: [
    {
      accountId: "mcp.cal",
      label: "you@example.com",
      identity: "you@example.com",
      owner: { kind: "owner" },
      health: "ready",
      grantedScopes: [],
      missingScopes: [],
      signedInAt: NOW,
      expiresWeekly: false,
      workspaces: ["default"],
      people: false,
      sharing: "personal",
      readOnly: false,
    },
  ],
  health: "ready",
  repairs: [],
  warnings: [],
  clientSetup: {
    provider: "example",
    title: "Your client",
    steps: [
      { text: "Create a client in your own project.", link: { label: "Create a client", url: "https://console.example/clients" } },
      { text: "Add its home page.", values: [{ label: "Home page", value: "https://example.com" }] },
      { text: "Download its JSON and drop it here." },
    ],
    ready: false,
  },
  ...extra,
});

const CATALOG: AppsCatalogAnswer = {
  sections: [
    {
      section: "presets",
      entries: [
        {
          ref: { kind: "preset", id: "todoist" },
          name: "Todoist",
          summary: "Your tasks.",
          category: "tasks",
          auth: "oauth",
          badges: ["tavi-preset", "own-client", "remote"],
          installed: false,
          options: [],
        },
      ],
    },
    { section: "installed", entries: [] },
    {
      section: "channels",
      entries: [
        {
          ref: { kind: "channel", providerId: "mail" },
          name: "Mail",
          summary: "Reach Tavi by email.",
          category: "email",
          auth: "oauth",
          badges: ["built-in"],
          installed: false,
          options: [],
        },
        {
          ref: { kind: "channel", providerId: "chat" },
          name: "Chat",
          summary: "Reach Tavi from a chat app.",
          category: "chat",
          auth: "api-key",
          badges: ["built-in"],
          installed: false,
          options: [],
        },
        {
          ref: { kind: "channel", providerId: "rooms" },
          name: "Rooms",
          summary: "Reach Tavi in rooms.",
          category: "chat",
          auth: "api-key",
          badges: [],
          installed: false,
          options: [],
        },
        {
          ref: { kind: "channel", providerId: "post" },
          name: "Post",
          summary: "Reach Tavi by post.",
          category: "email",
          auth: "api-key",
          badges: [],
          installed: false,
          options: [],
        },
      ],
    },
  ],
};

/** A channel set up with a token, whose operator pairs with a code: its setup pages on hosts it declares. */
const CHAT = {
  providerId: "chat",
  label: "Chat",
  kind: "chat",
  description: "A chat app.",
  settings: [],
  auth: { kind: "secrets", fields: [{ key: "token", label: "Bot token", secret: true, required: true }] },
  sender: { label: "User", placeholder: "", pattern: ".+", normalize: "none", authentication: "provider" },
  target: { label: "Chat", placeholder: "", pattern: ".+", normalize: "none" },
  hosts: ["api.chat.example"],
  pairing: { deepLinkTemplate: "https://chat.example/{account}?start={code}", openLabel: "Open in Chat" },
  setupHelp: "Make a bot with the bot maker and paste its token.",
  setupLinks: [
    { label: "Open the bot maker", url: "https://chat.example/botmaker" },
    { label: "Somewhere else", url: "https://elsewhere.example/" },
  ],
};

/** A channel that does not pair, on hosts under a wildcard. */
const ROOMS = {
  ...CHAT,
  providerId: "rooms",
  label: "Rooms",
  hosts: ["*.rooms.example"],
  pairing: undefined,
  setupHelp: "Make an app in the portal.",
  setupLinks: [{ label: "Open the portal", url: "https://portal.rooms.example/apps" }],
};

/** A channel whose required setting has no default: more than this sheet asks for. */
const POST = {
  ...CHAT,
  providerId: "post",
  label: "Post",
  settings: [{ key: "domain", label: "Domain", required: true }],
};

function owner(
  apps: readonly ConnectableApp[],
  options: {
    readonly status?: "pending" | "done";
    readonly device?: boolean;
    readonly needsClient?: boolean;
    /** The server refuses the key at its test. */
    readonly testFails?: boolean;
    /** The server lists its tools without checking the key. */
    readonly keyUnchecked?: boolean;
    /** Where the credential store's at-rest key is, as Settings → Credentials reads it; absent, an owner that says nothing. */
    readonly encryption?: "none" | "file" | "keychain";
    /** A Todoist added already by its other way in: an add without `switch` is refused with the offer. */
    readonly otherWayIn?: boolean;
  } = {},
) {
  const sent: { readonly command: string; readonly payload: Record<string, unknown> }[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      const body = payload as Record<string, unknown>;
      sent.push({ command, payload: body });
      if (command === "apps" && body["action"] === "list") return { ok: true, result: { apps } } as ClientResponse;
      if (command === "credentials" && body["action"] === "list" && options.encryption !== undefined)
        return { ok: true, result: { credentials: [], unusable: [], encryption: { kept: options.encryption } } } as ClientResponse;
      if (command === "apps" && body["action"] === "show")
        return { ok: true, result: { app: apps.find((candidate) => candidate.appId === body["appId"]) } } as ClientResponse;
      if (command === "apps" && body["action"] === "add" && options.otherWayIn === true && body["switch"] !== true)
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: "mcp.todoist is already added as Todoist (API token)",
            details: {
              switch: {
                appId: "todoist-token",
                name: "Todoist (API token)",
                pluginIds: ["mcp.todoist"],
                to: "todoist",
                toName: "Todoist",
              },
            },
          },
        } as ClientResponse;
      if (command === "apps" && body["action"] === "add")
        return { ok: true, result: { added: { appId: "calendar-app", pluginId: "mcp.cal" } } } as ClientResponse;
      if (command === "apps" && body["action"] === "catalog") return { ok: true, result: { catalog: CATALOG } } as ClientResponse;
      if (command === "channels" && body["action"] === "catalog")
        return { ok: true, result: { channels: [CHAT, ROOMS, POST] } } as ClientResponse;
      if (command === "channels" && body["action"] === "list") return { ok: true, result: { connections: [] } } as ClientResponse;
      if (command === "channels" && body["action"] === "people")
        return { ok: true, result: { operator: "operator", people: [] } } as ClientResponse;
      if (command === "channels" && body["action"] === "save") return { ok: true, result: { connectionId: "chat-1" } } as ClientResponse;
      if (command === "channels" && body["action"] === "probe") return { ok: true, result: { ok: true } } as ClientResponse;
      if (command === "apps" && body["action"] === "test" && options.keyUnchecked === true)
        return { ok: true, result: { tested: { accountId: body["accountId"], ok: true, keyChecked: false } } } as ClientResponse;
      if (command === "apps" && body["action"] === "test" && options.testFails === true)
        return { ok: false, error: { code: "NOT_AUTHORIZED", message: "the server refused its key (HTTP 403)" } } as ClientResponse;
      // A server that registers no clients: refused until a client of the person's own is set.
      if (
        command === "apps" &&
        body["action"] === "connect" &&
        options.needsClient === true &&
        !sent.some((entry) => entry.payload["action"] === "configure")
      )
        return {
          ok: false,
          error: {
            code: "NOT_CONFIGURED",
            message: "mcp.cal's authorization server registers no clients",
            details: { needsClient: true, redirect: `${window.location.origin}/oauth/callback` },
          },
        } as ClientResponse;
      if (command === "apps" && body["action"] === "connect" && options.device === true)
        return {
          ok: true,
          result: {
            connect: {
              flowId: "flow-1",
              authorizeUrl: "https://as.example/activate?code=WDJB-MJHT",
              redirectUri: "",
              via: body["via"],
              accountId: "mcp.cal",
              device: { userCode: "WDJB-MJHT", verificationUri: "https://as.example/activate", expiresAt: "2026-10-16T09:15:00.000Z" },
            },
          },
        } as ClientResponse;
      if (command === "apps" && body["action"] === "connect")
        return {
          ok: true,
          result: {
            connect: {
              flowId: "flow-1",
              authorizeUrl: "https://as.example/authorize?x=1",
              redirectUri: `${window.location.origin}/oauth/callback`,
              via: body["via"],
              accountId: "mcp.cal",
            },
          },
        } as ClientResponse;
      if (command === "apps" && body["action"] === "connect-status")
        return {
          ok: true,
          result: { status: { state: options.status ?? "done", accountId: "mcp.cal", identity: "you@example.com" } },
        } as ClientResponse;
      if (command === "apps" && body["action"] === "activity") {
        const row = (minutes: number, kind: "effect" | "approval" | "read", state: string) => ({
          id: `${kind}-${String(minutes)}`,
          at: new Date(Date.parse(NOW) - minutes * 60_000).toISOString(),
          taskId: `task-${String(minutes)}`,
          toolId: "mcp.cal.create_event",
          accountId: "mcp.cal",
          kind,
          state,
          title: `Create an event · Chat ${String(minutes)}`,
        });
        return {
          ok: true,
          result: {
            activity:
              body["cursor"] === undefined
                ? { rows: [row(1, "effect", "accepted"), row(2, "approval", "granted")], cursor: "page-2", readsListed: true }
                : { rows: [row(3, "effect", "uncertain"), row(4, "read", "called")], readsListed: true },
          },
        } as ClientResponse;
      }
      if (command === "mcp" && body["action"] === "show")
        return { ok: false, error: { code: "NOT_FOUND", message: "No such review." } } as ClientResponse;
      if (command === "mcp" && body["action"] === "search")
        return { ok: true, result: { discover: { registry: "https://registry.example", entries: [] } } } as ClientResponse;
      return { ok: true, result: {} } as ClientResponse;
    },
  };
  return { client, sent };
}

/** The page as the shell holds it: where it is lives in state, as the route does. */
function Harness({
  client,
  start,
  moves,
  opened,
}: {
  readonly client: SettingsClient;
  readonly start: AppsWhere;
  readonly moves: AppsWhere[];
  readonly opened: string[];
}) {
  const [where, setWhere] = useState(start);
  return (
    <InWorkspace client={client} workspaceId="default">
      <ConnectedApps
        where={where}
        onOpenTask={(taskId) => opened.push(taskId)}
        onWhere={(next) => {
          moves.push(next);
          setWhere(next);
        }}
      />
    </InWorkspace>
  );
}

async function page(apps: readonly ConnectableApp[], where: AppsWhere = { tab: "connected" }, options: Parameters<typeof owner>[1] = {}) {
  const { client, sent } = owner(apps, options);
  const moves: AppsWhere[] = [];
  const opened: string[] = [];
  const view = await mount(<Harness client={client} start={where} moves={moves} opened={opened} />);
  return { view, sent, moves, opened };
}

describe("the Connected list", () => {
  it("groups apps by health, filters to those that need you, and offers each one's fix", async () => {
    const broken = app({
      appId: "mail-app",
      name: "Mail",
      health: "needs-sign-in",
      accounts: [{ ...app().accounts[0]!, accountId: "mcp.mail", health: "needs-sign-in", identity: "work@example.com" }],
      repairs: [
        {
          kind: "sign-in",
          accountId: "mcp.mail",
          title: "Sign in to Mail again",
          detail: "Its sign-in expired.",
          cli: "tavi mcp login mcp.mail",
        },
      ],
    });
    const paused = app({ appId: "home-app", name: "Home", health: "paused", accounts: [] });
    const { view, moves } = await page([broken, app(), paused]);
    const headings = [...view.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(headings).toEqual(["Needs you", "Connected", "Paused"]);
    expect(view.textContent).toContain("work@example.com");
    expect(view.textContent).toContain("Needs sign-in");
    await click(button(view, "Needs you only"));
    expect([...view.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["Needs you", "Paused"]);
    await click(button(view, "Sign in to Mail again"));
    expect(moves.at(-1)).toEqual({ tab: "connected", appId: "mail-app", connect: true });
  });

  it("takes a keyed app left before its key back to its sheet's key step", async () => {
    const { clientSetup: _setup, ...base } = app();
    const maps: ConnectableApp = {
      ...base,
      appId: "maps-app",
      name: "Maps",
      health: "not-set-up",
      auth: { kind: "api-key", fields: [{ key: "apiKey", label: "API key", type: "credential", required: true, advanced: false }] },
      accounts: [{ ...app().accounts[0]!, accountId: "mcp.maps", health: "not-set-up" }],
      repairs: [
        {
          kind: "finish-setup",
          accountId: "mcp.maps",
          title: "Finish setting up Maps",
          detail: "It needs apiKey.",
          cli: "tavi plugins config mcp.maps --set apiKey=…",
        },
      ],
    };
    const { view, moves } = await page([maps]);
    await click(button(view, "Finish setting up Maps"));
    expect(moves.at(-1)).toEqual({ tab: "connected", appId: "maps-app", connect: true });
    expect(view.querySelector("dialog li[aria-current='step']")?.textContent).toContain("Your key");
  });

  it("takes a keyed app whose key was refused back to its key step, saying it was refused", async () => {
    const { clientSetup: _setup, ...base } = app();
    const refused = "Its server refused your Todoist API token: check it and paste it again.";
    const todoist: ConnectableApp = {
      ...base,
      appId: "todoist-token",
      name: "Todoist (API token)",
      health: "not-set-up",
      auth: {
        kind: "api-key",
        fields: [{ key: "apiToken", label: "Your Todoist API token", type: "credential", required: true, advanced: false }],
      },
      accounts: [{ ...app().accounts[0]!, accountId: "mcp.todoist", health: "not-set-up" }],
      repairs: [
        {
          kind: "finish-setup",
          accountId: "mcp.todoist",
          title: "Finish setting up Todoist (API token)",
          detail: refused,
          cli: "tavi credentials set plugins.mcp.todoist.apiToken --file … && tavi mcp probe mcp.todoist",
        },
      ],
    };
    const { view } = await page([todoist]);
    await click(button(view, "Finish setting up Todoist (API token)"));
    const dialog = view.querySelector("dialog");
    expect(dialog?.querySelector("li[aria-current='step']")?.textContent).toContain("Your key");
    expect(dialog?.querySelector(".apps-step")?.textContent).toContain(refused);
    // Its page's account row finishes its setup, and has no test until a key is given again.
    const detail = (await page([todoist], { tab: "connected", appId: "todoist-token" })).view;
    const labels = [...detail.querySelectorAll(".apps-account button")].map((each) => each.textContent);
    expect(labels).toContain("Finish setting up");
    expect(labels).not.toContain("Sign in");
    expect(labels).not.toContain("Test");
  });

  it("says what to do when nothing is connected", async () => {
    const { view, moves } = await page([]);
    expect(view.textContent).toContain("No apps yet. Connect your calendar, to-dos and home so Tavi can plan around your day.");
    await click(button(view, "Discover apps"));
    expect(moves.at(-1)).toEqual({ tab: "discover" });
  });

  it("features Tavi's presets when nothing is connected, each opening Discover on it", async () => {
    const { view, moves } = await page([]);
    await click(button(view, "Add Todoist"));
    expect(moves.at(-1)).toEqual({ tab: "discover", query: "Todoist" });
  });

  it("filters by category when it lists more than one, and says when each must sign in again", async () => {
    const weekly = app({ accounts: [{ ...app().accounts[0]!, nextSignInBy: "2026-10-20T09:00:00.000Z" }] });
    const home = app({ appId: "home-app", name: "Home", category: "home", accounts: [] });
    const { view } = await page([weekly, home]);
    expect(view.textContent).toMatch(/Sign in again by /);
    await click(button(view, "Home"));
    expect([...view.querySelectorAll(".apps-row")].map((row) => row.querySelector("button")?.textContent)).toEqual(["Home"]);
  });

  it("has no WCAG A/AA violations axe can find", async () => {
    const { view } = await page([
      app(),
      app({
        appId: "x",
        name: "Other",
        health: "error",
        repairs: [{ kind: "retry", title: "Other stopped working", detail: "It failed.", cli: "tavi mcp probe x" }],
      }),
    ]);
    await axeClean(view);
  });
});

describe("Discover", () => {
  it("shows Tavi's entries with their badges in words, and adds a preset", async () => {
    const { view, sent } = await page([], { tab: "discover" });
    expect(view.textContent).toContain("Tavi presets");
    expect(view.textContent).toContain("Your own client");
    expect(view.textContent).toContain("Built in");
    expect(view.textContent).toContain("Tavi does not review registry listings");
    await click(
      [...view.querySelectorAll("article")].find((card) => card.getAttribute("aria-label") === "Todoist")?.querySelector("button"),
    );
    expect(sent.find((entry) => entry.payload["action"] === "add")?.payload).toEqual({
      action: "add",
      workspaceId: "default",
      entry: { kind: "preset", id: "todoist" },
    });
    await axeClean(view);
  });

  it("offers to switch Todoist's way in when the other one is added, and adds nothing until you choose it", async () => {
    const { view, sent, moves } = await page([], { tab: "discover" }, { otherWayIn: true });
    const todoist = () => [...view.querySelectorAll("article")].find((card) => card.getAttribute("aria-label") === "Todoist");
    await click(todoist()?.querySelector("button"));
    const dialog = view.querySelector("dialog") as HTMLElement;
    expect(dialog.textContent).toContain("Switch Todoist (API token) to Todoist?");
    expect(dialog.textContent).toContain(
      "Tavi keeps one Todoist. Switching removes mcp.todoist with what it keeps: its token or sign-in, the choices on its page, and who may use it. Todoist is added in its place, and you review its tools again.",
    );
    await click(button(dialog, "Cancel"));
    expect(sent.filter((entry) => entry.payload["action"] === "add")).toHaveLength(1);
    await click(todoist()?.querySelector("button"));
    await click(button(view.querySelector("dialog") as HTMLElement, "Switch to Todoist"));
    expect(sent.filter((entry) => entry.payload["action"] === "add").at(-1)?.payload).toEqual({
      action: "add",
      workspaceId: "default",
      entry: { kind: "preset", id: "todoist" },
      switch: true,
    });
    expect(moves.at(-1)).toMatchObject({ appId: "calendar-app" });
    await axeClean(view);
  });

  it("adds a channel set up with keys in one sheet: its pages, its token tested, then pairing with a code", async () => {
    const { view, sent } = await page([], { tab: "discover" });
    const chat = [...view.querySelectorAll("article")].find((card) => card.getAttribute("aria-label") === "Chat");
    await click(chat?.querySelector("button"));
    const dialog = view.querySelector("dialog") as HTMLElement;
    expect(dialog.textContent).toContain("Make a bot with the bot maker and paste its token.");
    // A page on a host the channel declares is linked; one elsewhere is left out.
    const links = [...dialog.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toContain("https://chat.example/botmaker");
    expect(links).not.toContain("https://elsewhere.example/");
    await type(labelled(dialog, "Bot token"), "123:abc");
    await click(button(dialog, "Test and add"));
    expect(sent.find((entry) => entry.command === "channels" && entry.payload["action"] === "save")?.payload).toMatchObject({
      action: "save",
      providerId: "chat",
      enabled: true,
      secrets: { token: "123:abc" },
    });
    expect(sent.some((entry) => entry.command === "onboarding")).toBe(false);
    expect(dialog.textContent).toContain("Pair yourself on Chat");
    expect(button(dialog, "Get a code")).toBeDefined();
  });

  it("adds a channel that does not pair: its page on a wildcard host, then Done", async () => {
    const { view, sent } = await page([], { tab: "discover" });
    const rooms = [...view.querySelectorAll("article")].find((card) => card.getAttribute("aria-label") === "Rooms");
    await click(rooms?.querySelector("button"));
    const dialog = view.querySelector("dialog") as HTMLElement;
    expect([...dialog.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toContain("https://portal.rooms.example/apps");
    await type(labelled(dialog, "Bot token"), "t");
    await click(button(dialog, "Test and add"));
    expect(dialog.textContent).toContain("Rooms is added and answers.");
    const catalogs = sent.filter((entry) => entry.command === "apps" && entry.payload["action"] === "catalog").length;
    await click(button(dialog, "Done"));
    expect(view.querySelector("dialog")).toBeNull();
    expect(sent.filter((entry) => entry.command === "apps" && entry.payload["action"] === "catalog").length).toBeGreaterThan(catalogs);
  });

  it("sends a channel whose settings the sheet does not ask for to Settings → Channels", async () => {
    const { view, sent } = await page([], { tab: "discover" });
    const post = [...view.querySelectorAll("article")].find((card) => card.getAttribute("aria-label") === "Post");
    await click(post?.querySelector("button"));
    const dialog = view.querySelector("dialog") as HTMLElement;
    expect(dialog.textContent).toContain("Post needs settings this sheet does not ask for: add it in Settings → Channels.");
    expect(dialog.querySelector("input")).toBeNull();
    expect(sent.some((entry) => entry.command === "channels" && entry.payload["action"] === "save")).toBe(false);
  });

  it("adds an account of a channel that signs in right here, to connect from its sheet", async () => {
    const { view, sent } = await page([], { tab: "discover" });
    const mail = [...view.querySelectorAll("article")].find((card) => card.getAttribute("aria-label") === "Mail");
    await click(mail?.querySelector("button"));
    expect(sent.find((entry) => entry.payload["action"] === "add")?.payload).toEqual({
      action: "add",
      workspaceId: "default",
      entry: { kind: "channel", providerId: "mail" },
    });
  });
});

describe("Discover opened at an entry", () => {
  it("fills its search with the app a chat asked to add", async () => {
    const { view } = await page([], { tab: "discover", query: "Calendar" });
    expect((view.querySelector('input[aria-label="Search apps"]') as HTMLInputElement).value).toBe("Calendar");
  });
});

describe("an app's page", () => {
  it("shows its accounts, what it can do, and its data, and sends a target the person picks", async () => {
    const { view, sent } = await page([app()], { tab: "connected", appId: "calendar-app" });
    for (const title of ["Accounts", "What it can do", "Data and privacy", "Advanced"])
      expect([...view.querySelectorAll("h3")].map((heading) => heading.textContent)).toContain(title);
    expect(view.textContent).toContain("calendar.example.com");
    expect(view.textContent).toContain("personal data");
    // An MCP write cannot be allowed here, and the page says why.
    const create = [...view.querySelectorAll("fieldset")].find((fieldset) => fieldset.textContent?.includes("Create an event"));
    const allow = create?.querySelector('input[value="allow"]') as HTMLInputElement;
    expect(allow.disabled).toBe(true);
    expect(create?.textContent).toContain("allow one chat at a time from the approval card");
    await click(create?.querySelector('input[value="block"]'));
    expect(sent.find((entry) => entry.payload["action"] === "permission")?.payload).toEqual({
      action: "permission",
      workspaceId: "default",
      appId: "calendar-app",
      toolId: "mcp.cal.create_event",
      target: "block",
    });
    await axeClean(view);
  });

  it("asks before lending a Shared account to the people allowed, naming it", async () => {
    const shared = app({ accounts: [{ ...app().accounts[0]!, sharing: "shared" }] });
    const { view, sent } = await page([shared], { tab: "connected", appId: "calendar-app" });
    await click(
      [...view.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("People you allowed may use it"))
        ?.querySelector("input"),
    );
    expect(sent.some((entry) => entry.payload["action"] === "people")).toBe(false);
    const dialog = view.ownerDocument.querySelector("dialog") as HTMLElement;
    expect(dialog.textContent).toContain("read, change and send through your Calendar (you@example.com), with your sign-in.");
    await click(button(dialog, "Let them use it"));
    expect(sent.find((entry) => entry.payload["action"] === "people")?.payload).toMatchObject({
      action: "people",
      pluginId: "mcp.cal",
      on: true,
    });
  });

  it("words a read-only keyed app's lending from what it does, and its sheet's Shared says lending is a tick on its page", async () => {
    const { clientSetup: _setup, ...base } = app();
    const maps: ConnectableApp = {
      ...base,
      name: "Maps",
      auth: { kind: "api-key", fields: [{ key: "apiKey", label: "API key", type: "credential", required: true, advanced: false }] },
      tools: [app().tools[0]!],
      accounts: [{ ...app().accounts[0]!, identity: undefined, sharing: "shared" }],
    };
    const { view } = await page([maps], { tab: "connected", appId: "calendar-app", connect: true });
    const sheet = view.ownerDocument.querySelector("dialog") as HTMLElement;
    expect(sheet.textContent).toContain("Shared: people you allowed may use it too, once you let them on its page");
    await click(button(sheet, "Cancel"));
    await click(
      [...view.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("People you allowed may use it"))
        ?.querySelector("input"),
    );
    const dialog = view.ownerDocument.querySelector("dialog") as HTMLElement;
    expect(dialog.textContent).toContain("will be able to ask Tavi to read your Maps, with your key.");
  });

  it("saves settings to the account whose setup is unfinished, not the first", async () => {
    const first = app().accounts[0]!;
    const unfinished = app({
      clientSetup: undefined,
      settings: [{ key: "url", label: "Address", type: "url", required: true, advanced: false }],
      accounts: [first, { ...first, accountId: "mcp.cal2", label: "work", health: "not-set-up" }],
      health: "not-set-up",
      repairs: [
        {
          kind: "finish-setup",
          accountId: "mcp.cal2",
          title: "Finish setting up Calendar",
          detail: "It needs url.",
          cli: "tavi plugins config mcp.cal2 --set url=…",
        },
      ],
    });
    const { view, sent } = await page([unfinished], { tab: "connected", appId: "calendar-app" });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
    try {
      await click(button(view, "Finish setting up Calendar"));
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
    await type(labelled(view, "Address (required)"), "https://home.example");
    await click(button(view, "Save"));
    expect(sent.find((entry) => entry.payload["action"] === "configure")?.payload).toMatchObject({
      action: "configure",
      accountId: "mcp.cal2",
      values: { url: "https://home.example" },
    });
  });

  it("sets nothing on a tool waiting for its review, and opens that review from it", async () => {
    const waiting = app({ tools: [{ ...app().tools[0]!, state: "pending-review" }] });
    const { view, sent } = await page([waiting], { tab: "connected", appId: "calendar-app" });
    const choice = [...view.querySelectorAll("fieldset")].find((fieldset) => fieldset.textContent?.includes("List events")) as HTMLElement;
    expect([...choice.querySelectorAll('input[type="radio"]')].every((radio) => (radio as HTMLInputElement).disabled)).toBe(true);
    await click([...choice.querySelectorAll("button")].find((candidate) => candidate.textContent === "Review it"));
    expect(
      sent.some((entry) => entry.command === "mcp" && entry.payload["action"] === "show" && entry.payload["pluginId"] === "mcp.cal"),
    ).toBe(true);
  });

  it("asks before a second account goes with its disconnect, and never offers the first one's removal", async () => {
    const first = app().accounts[0]!;
    const two = app({ accounts: [first, { ...first, accountId: "mcp.cal2", label: "work@example.com", identity: "work@example.com" }] });
    const { view, sent } = await page([two], { tab: "connected", appId: "calendar-app" });
    const disconnects = () => [...view.querySelectorAll("button")].filter((candidate) => candidate.textContent === "Disconnect");
    // The first account: no choice to remove it.
    await click(disconnects()[0]);
    let dialog = view.ownerDocument.querySelector("dialog") as HTMLElement;
    expect(dialog.textContent).not.toContain("Also remove this account");
    await click([...dialog.querySelectorAll("button")].find((candidate) => candidate.textContent === "Disconnect"));
    expect(sent.filter((entry) => entry.payload["action"] === "disconnect").at(-1)?.payload).toMatchObject({
      accountId: "mcp.cal",
      remove: false,
    });
    // The second: removed only when asked.
    await click(disconnects()[1]);
    dialog = view.ownerDocument.querySelector("dialog") as HTMLElement;
    await click(
      [...dialog.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("Also remove this account"))
        ?.querySelector("input"),
    );
    await click([...dialog.querySelectorAll("button")].find((candidate) => candidate.textContent === "Disconnect"));
    expect(sent.filter((entry) => entry.payload["action"] === "disconnect").at(-1)?.payload).toMatchObject({
      accountId: "mcp.cal2",
      remove: true,
    });
  });

  it("turns an account that is on off from its page, and offers no off for one that is off, whatever else it needs", async () => {
    const on = app({ accounts: [{ ...app().accounts[0]!, on: true }] });
    const { view, sent } = await page([on], { tab: "connected", appId: "calendar-app" });
    await click(button(view, "Turn Calendar off"));
    expect(sent.find((entry) => entry.command === "plugins" && entry.payload["action"] === "disable")?.payload).toEqual({
      action: "disable",
      pluginId: "mcp.cal",
    });
    unmountAll();
    // Off, and needing its review too: still no off.
    const off = await page([app({ health: "needs-review", accounts: [{ ...app().accounts[0]!, on: false }] })], {
      tab: "connected",
      appId: "calendar-app",
    });
    expect([...off.view.querySelectorAll("button")].some((candidate) => candidate.textContent === "Turn Calendar off")).toBe(false);
  });

  it("lists its recent activity, each opening its chat, with more on request", async () => {
    const { view, sent, opened } = await page([app()], { tab: "connected", appId: "calendar-app" });
    const section = [...view.querySelectorAll("section")].find(
      (candidate) => candidate.querySelector("h3")?.textContent === "Recent activity",
    ) as HTMLElement;
    expect([...section.querySelectorAll("li a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Create an event · Chat 1", "/tasks/task-1"],
      ["Create an event · Chat 2", "/tasks/task-2"],
    ]);
    expect(section.textContent).toContain("You allowed it");
    // A chat opens in place, as every other chat link does.
    await click(section.querySelector("li a"));
    expect(opened).toEqual(["task-1"]);
    expect(section.textContent).toContain("Calls that only read are listed from when Tavi began recording them; older ones are not.");
    await click(button(section, "Show more"));
    expect(sent.filter((entry) => entry.payload["action"] === "activity").at(-1)?.payload).toEqual({
      action: "activity",
      workspaceId: "default",
      appId: "calendar-app",
      cursor: "page-2",
    });
    expect(section.querySelectorAll("li")).toHaveLength(4);
    // A read is listed as one.
    expect(section.querySelectorAll("li")[3]?.textContent).toContain("Called");
    expect(section.textContent).toContain("Outcome unknown");
    expect(button(section, "Show more")).toBeUndefined();
    await axeClean(section);
  });

  it("turns taking messages in off from an account's row", async () => {
    const receiving = app({ accounts: [{ ...app().accounts[0]!, receives: true }] });
    const { view, sent } = await page([receiving], { tab: "connected", appId: "calendar-app" });
    await click(
      [...view.querySelectorAll(".apps-account label")]
        .find((label) => label.textContent?.includes("Reach Tavi through this account"))
        ?.querySelector("input"),
    );
    expect(sent.find((entry) => entry.payload["action"] === "receive")?.payload).toEqual({
      action: "receive",
      workspaceId: "default",
      appId: "calendar-app",
      accountId: "mcp.cal",
      on: false,
    });
  });

  it("says it is also a channel only while an account takes messages in, and re-reads its connections when the sheet closes", async () => {
    const { clientSetup: _setup, ...base } = app();
    const mail = (receives: boolean): ConnectableApp => ({
      ...base,
      appId: "mail",
      name: "Mail",
      source: { kind: "channel", pluginIds: [], verified: "built-in", isolation: "in-process" },
      channel: { kinds: ["email"], receives: true, sends: true },
      accounts: [{ ...app().accounts[0]!, accountId: "mail-1", receives }],
    });
    const off = await page([mail(false)], { tab: "connected", appId: "mail", connect: true });
    const lists = () => off.sent.filter((entry) => entry.command === "channels" && entry.payload["action"] === "list").length;
    expect(off.view.textContent).not.toContain("Also a channel");
    const before = lists();
    await click(button(off.view.querySelector("dialog") as HTMLElement, "Cancel"));
    expect(lists()).toBeGreaterThan(before);
    const on = await page([mail(true)], { tab: "connected", appId: "mail" });
    expect(on.view.textContent).toContain("Also a channel: people can reach Tavi through it.");
  });

  it("turns an account's calendar on from its row, and shows no such box for an account with no calendar", async () => {
    const withCalendar = app({ accounts: [{ ...app().accounts[0]!, calendar: false }] });
    const { view, sent } = await page([withCalendar], { tab: "connected", appId: "calendar-app" });
    const box = () =>
      [...view.querySelectorAll(".apps-account label")]
        .find((label) => label.textContent?.includes("Let the agent use this calendar"))
        ?.querySelector("input");
    await click(box());
    expect(sent.find((entry) => entry.payload["action"] === "calendar")?.payload).toEqual({
      action: "calendar",
      workspaceId: "default",
      appId: "calendar-app",
      accountId: "mcp.cal",
      on: true,
    });
    const without = await page([app()], { tab: "connected", appId: "calendar-app" });
    expect(
      [...without.view.querySelectorAll(".apps-account label")].some((label) =>
        label.textContent?.includes("Let the agent use this calendar"),
      ),
    ).toBe(false);
  });

  it("turns a mailbox's opt-ins on in order: reading first, then sending what you approve", async () => {
    const mailbox = app({ accounts: [{ ...app().accounts[0]!, mailbox: "off" }] });
    const { view, sent } = await page([mailbox], { tab: "connected", appId: "calendar-app" });
    const send = [...view.querySelectorAll(".apps-account label")]
      .find((label) => label.textContent?.includes("Send drafts I approve"))
      ?.querySelector("input") as HTMLInputElement;
    expect(send.disabled).toBe(true);
    await click(
      [...view.querySelectorAll(".apps-account label")]
        .find((label) => label.textContent?.includes("Let the agent read and draft"))
        ?.querySelector("input"),
    );
    expect(sent.find((entry) => entry.payload["action"] === "mailbox")?.payload).toEqual({
      action: "mailbox",
      workspaceId: "default",
      appId: "calendar-app",
      accountId: "mcp.cal",
      mailbox: "read",
    });
  });

  it("shows a choice per tool as a select on a phone", async () => {
    phone(true);
    const { view } = await page([app()], { tab: "connected", appId: "calendar-app" });
    expect(view.querySelector('[aria-label="List events: what Tavi does"]')).not.toBeNull();
    expect(view.querySelector('input[type="radio"][value="allow"]')).toBeNull();
  });

  it("opens an old link's review once, and going back reaches the list", async () => {
    window.history.replaceState(null, "", "/settings/apps?review=mcp.cal");
    try {
      const other = app({ appId: "other-app", name: "Other", source: { ...app().source, pluginIds: ["mcp.other"] }, accounts: [] });
      const { view, sent, moves } = await page([app(), other]);
      expect(moves.at(-1)).toEqual({ tab: "connected", appId: "calendar-app" });
      expect(window.location.search).toBe("");
      expect(
        sent.some((entry) => entry.command === "mcp" && entry.payload["action"] === "show" && entry.payload["pluginId"] === "mcp.cal"),
      ).toBe(true);
      await click(button(view, "← Connected apps"));
      expect(moves.at(-1)).toEqual({ tab: "connected" });
      expect([...view.querySelectorAll("h2")].map((heading) => heading.textContent)).toContain("Connected");
      const reviews = sent.filter((entry) => entry.command === "mcp" && entry.payload["action"] === "show").length;
      await click(button(view, "Other"));
      expect(moves.at(-1)).toMatchObject({ tab: "connected", appId: "other-app" });
      expect(sent.filter((entry) => entry.command === "mcp" && entry.payload["action"] === "show").length).toBe(reviews);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("marks an account Personal or Shared", async () => {
    const { view, sent } = await page([app()], { tab: "connected", appId: "calendar-app" });
    const shared = [...view.querySelectorAll(".apps-account label")]
      .find((label) => label.textContent?.trim() === "Shared")
      ?.querySelector("input");
    await click(shared);
    expect(sent.find((entry) => entry.payload["action"] === "sharing")?.payload).toEqual({
      action: "sharing",
      workspaceId: "default",
      appId: "calendar-app",
      accountId: "mcp.cal",
      sharing: "shared",
    });
  });
});

describe("the connect sheet", () => {
  it("goes straight to the sign-in from the client step when a client is set up and nothing new is given", async () => {
    const ready = app({
      auth: { kind: "oauth", client: "shared-provider", provider: "example", scopes: [], stepUp: [] },
      clientSetup: { provider: "example", title: "Your client", steps: [{ text: "Make a client." }], ready: true },
    });
    const { view, sent } = await page([ready], { tab: "connected", appId: "calendar-app", connect: true }, { status: "pending" });
    const dialog = view.querySelector("dialog") as HTMLElement;
    await click(button(dialog, "Next"));
    await click(button(dialog, "Next"));
    expect(sent.some((entry) => entry.payload["action"] === "configure")).toBe(false);
    expect(button(dialog, "Sign in to Calendar")).toBeDefined();
    // A provider's shared client comes back to this computer only: no https address is offered.
    expect(dialog.textContent).not.toContain("This server's https address");
  });

  it("writes what the account turns on before it signs in, and says to tick every box the provider lists", async () => {
    const google = app({
      auth: {
        kind: "oauth",
        client: "shared-provider",
        provider: "example",
        scopes: [{ scope: "mail", says: "Read your mail", access: "read", optional: true }],
        stepUp: [],
      },
      clientSetup: { provider: "example", title: "Your client", steps: [{ text: "Make a client." }], ready: true },
      accounts: [{ ...app().accounts[0]!, calendar: false, mailbox: "off", receives: true }],
    });
    const { view, sent } = await page([google], { tab: "connected", appId: "calendar-app", connect: true }, { status: "pending" });
    const dialog = view.querySelector("dialog") as HTMLElement;
    const box = (words: string) =>
      [...dialog.querySelectorAll(".apps-options label")].find((label) => label.textContent?.includes(words))?.querySelector("input");
    await click(box("use your calendar"));
    await click(box("read and draft in your mailbox"));
    await click(box("Reach Tavi through this account"));
    await click(button(dialog, "Next"));
    expect(
      sent.filter((entry) => ["receive", "mailbox", "calendar"].includes(String(entry.payload["action"]))).map((entry) => entry.payload),
    ).toEqual([
      { action: "receive", workspaceId: "default", appId: "calendar-app", accountId: "mcp.cal", on: false },
      { action: "mailbox", workspaceId: "default", appId: "calendar-app", accountId: "mcp.cal", mailbox: "read" },
      { action: "calendar", workspaceId: "default", appId: "calendar-app", accountId: "mcp.cal", on: true },
    ]);
    await click(button(dialog, "Next"));
    expect(dialog.textContent).toContain("tick every one (or Select all)");
  });

  it("sends a client file picked on the client step whole, for the owner to read", async () => {
    const { view, sent } = await page([app()], { tab: "connected", appId: "calendar-app", connect: true }, { status: "pending" });
    const dialog = view.querySelector("dialog") as HTMLElement;
    await click(button(dialog, "Next"));
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    const text = JSON.stringify({ installed: { client_id: "1-desk.apps.googleusercontent.com", client_secret: "GOCSPX-x" } });
    Object.defineProperty(input, "files", { value: [new File([text], "client_secret.json", { type: "application/json" })] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await delay(0);
    });
    expect(dialog.textContent).toContain("Client file: client_secret.json");
    await click(button(dialog, "Save and next"));
    expect(sent.find((entry) => entry.payload["action"] === "configure")?.payload).toEqual({
      action: "configure",
      workspaceId: "default",
      appId: "calendar-app",
      values: {},
      clientFile: text,
    });
  });

  it("walks what it can do, the client's console steps, and the sign-in, with the paste warning and a link for a blocked pop-up", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const { view, sent } = await page([app()], { tab: "connected", appId: "calendar-app", connect: true }, { status: "pending" });
    const dialog = view.querySelector("dialog") as HTMLElement;
    expect(dialog.textContent).toContain("See and change events on your calendars");
    expect(dialog.textContent).toContain("Is this your own account, or one your household or team shares?");
    await click(button(dialog, "Next"));
    expect(dialog.textContent).toContain("Create a client in your own project.");
    // Each step opens its console page in a tab of its own, and a value to type has a copy button.
    const link = [...dialog.querySelectorAll("a")].find((anchor) => anchor.textContent === "Create a client");
    expect(link?.getAttribute("href")).toBe("https://console.example/clients");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(dialog.querySelector(".apps-values code")?.textContent).toBe("https://example.com");
    // No redirect to register, no port to keep, no publishing to say.
    expect(dialog.textContent).not.toContain("Redirect address");
    expect(dialog.querySelector(".apps-publishing")).toBeNull();
    await type(labelled(dialog, "Client id"), "client-1");
    await click(button(dialog, "Save and next"));
    const configured = sent.find((entry) => entry.payload["action"] === "configure")?.payload;
    expect(configured).toEqual({ action: "configure", workspaceId: "default", appId: "calendar-app", values: { clientId: "client-1" } });
    await click(button(dialog, "Sign in to Calendar"));
    expect(sent.find((entry) => entry.payload["action"] === "connect")?.payload).toMatchObject({
      action: "connect",
      via: "here",
      origin: window.location.origin,
      appId: "calendar-app",
    });
    expect(opened).toHaveBeenCalledWith("https://as.example/authorize?x=1", "_blank", expect.stringContaining("noopener"));
    // A blocked pop-up still has a way in.
    expect([...dialog.querySelectorAll("a")].find((link) => link.textContent === "Open the sign-in page")?.getAttribute("href")).toBe(
      "https://as.example/authorize?x=1",
    );
    expect(dialog.textContent).toContain(
      "Paste it only here, in Tavi. Never paste a sign-in address into a chat, an email or another site.",
    );
    await axeClean(view);
  });

  it("shows a code to enter on any device, with a copy button, and opens nothing", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });
    const byCode = app({ auth: { kind: "device", scopes: [] }, clientSetup: undefined });
    const { view, sent } = await page(
      [byCode],
      { tab: "connected", appId: "calendar-app", connect: true },
      { status: "pending", device: true },
    );
    const dialog = view.querySelector("dialog") as HTMLElement;
    await click(button(dialog, "Next"));
    await click(button(dialog, "Get a code to sign in to Calendar"));
    expect(sent.find((entry) => entry.payload["action"] === "connect")?.payload).toMatchObject({
      action: "connect",
      via: "here",
      appId: "calendar-app",
    });
    expect(opened).not.toHaveBeenCalled();
    expect(dialog.querySelector(".apps-user-code")?.textContent).toBe("WDJB-MJHT");
    expect([...dialog.querySelectorAll("a")].find((link) => link.textContent === "https://as.example/activate")?.getAttribute("href")).toBe(
      "https://as.example/activate?code=WDJB-MJHT",
    );
    await click(dialog.querySelector('button[aria-label="Copy the sign-in code"]'));
    expect(written).toEqual(["WDJB-MJHT"]);
    // No redirect, so none of the ways to come back from another computer.
    expect(dialog.textContent).not.toContain("Signing in from another computer?");
    expect(dialog.textContent).toContain("Waiting for the code to be entered");
    await axeClean(view);
  });

  it("finishes from a pasted address, never echoing it, and keeps the sharing choice once connected", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const ready = app({ clientSetup: { provider: "example", title: "Your client", steps: [], ready: true } });
      const { view, sent } = await page([ready], { tab: "connected", appId: "calendar-app", connect: true });
      const dialog = view.querySelector("dialog") as HTMLElement;
      await click([...dialog.querySelectorAll("label")].find((label) => label.textContent?.includes("Shared:"))?.querySelector("input"));
      await click(button(dialog, "Next"));
      await click(button(dialog, "Next"));
      await click(button(dialog, "Start"));
      expect(sent.find((entry) => entry.payload["action"] === "connect")?.payload).toMatchObject({ via: "paste" });
      const field = labelled(dialog, "Address you landed on after signing in");
      await type(field, "http://127.0.0.1:8765/oauth/callback?state=s&code=c");
      await click(button(dialog, "Finish"));
      expect(sent.find((entry) => entry.payload["action"] === "connect-finish")?.payload).toEqual({
        action: "connect-finish",
        flowId: "flow-1",
        address: "http://127.0.0.1:8765/oauth/callback?state=s&code=c",
        workspaceId: "default",
      });
      expect((field as HTMLInputElement).value).toBe("");
      await act(async () => {
        vi.advanceTimersByTime(2_100);
      });
      await settle();
      await settle();
      expect(sent.find((entry) => entry.payload["action"] === "sharing")?.payload).toMatchObject({
        accountId: "mcp.cal",
        sharing: "shared",
      });
      expect(dialog.textContent).toContain("Connected Calendar as you@example.com.");
      // Signed in, its tools are listed at once, so the review opens on them.
      expect(sent.find((entry) => entry.payload["action"] === "test")?.payload).toMatchObject({
        appId: "calendar-app",
        accountId: "mcp.cal",
      });
      // Step 4 is its tools' review: it opens that account's review.
      expect(dialog.textContent).toContain("4. Review tools");
      await click(button(dialog, "Review its tools"));
      expect(
        sent.some((entry) => entry.command === "mcp" && entry.payload["action"] === "show" && entry.payload["pluginId"] === "mcp.cal"),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a code and state typed separately, says what Finish grants, and marks a refused paste", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const ready = app({ clientSetup: { provider: "example", title: "Your client", steps: [], ready: true } });
    const { client, sent } = owner([ready]);
    const refusing: SettingsClient = {
      request: async (command, payload) =>
        (payload as Record<string, unknown>)["action"] === "connect-finish"
          ? (sent.push({ command, payload: payload as Record<string, unknown> }),
            { ok: false, error: { code: "INVALID_INPUT", message: "That address belongs to another sign-in." } } as ClientResponse)
          : client.request(command, payload),
    };
    const view = await mount(
      <Harness client={refusing} start={{ tab: "connected", appId: "calendar-app", connect: true }} moves={[]} opened={[]} />,
    );
    const dialog = view.querySelector("dialog") as HTMLElement;
    await click(button(dialog, "Next"));
    await click(button(dialog, "Next"));
    await click(button(dialog, "Start"));
    expect(dialog.textContent).toContain("Finishing signs in you@example.com, allowing: See and change events on your calendars.");
    expect(button(dialog, "Finish")?.disabled).toBe(true);
    await type(labelled(dialog, "code"), "c 1");
    await type(labelled(dialog, "state"), "s");
    await click(button(dialog, "Finish"));
    expect(sent.find((entry) => entry.payload["action"] === "connect-finish")?.payload["address"]).toBe(
      `${window.location.origin}/oauth/callback?code=c+1&state=s`,
    );
    const field = labelled(dialog, "Address you landed on after signing in") as HTMLInputElement;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const said = field
      .getAttribute("aria-describedby")
      ?.split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(said).toContain("That address belongs to another sign-in.");
    expect((labelled(dialog, "code") as HTMLInputElement).value).toBe("");
    expect(labelled(dialog, "code")?.getAttribute("aria-describedby")).toBe(`${field.id}-error`);
    // A new attempt starts clean.
    await type(labelled(dialog, "code"), "c2");
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });

  it("asks for a client of the person's own when the server registers none, with the redirect to give it", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    // A server whose client registers itself: no client step of its own before the sign-in.
    const { clientSetup: _setup, ...base } = app();
    const server: ConnectableApp = { ...base, auth: { kind: "oauth", client: "registration", scopes: [], stepUp: [] } };
    const { view, sent } = await page([server], { tab: "connected", appId: "calendar-app" }, { needsClient: true, status: "pending" });
    await click(button(view, "Reconnect"));
    const dialog = view.querySelector("dialog") as HTMLElement;
    await click(button(dialog, "Sign in to Calendar"));
    expect(dialog.textContent).toContain("Calendar does not register Tavi by itself.");
    expect(dialog.textContent).toContain(`${window.location.origin}/oauth/callback`);
    expect(dialog.querySelector('[role="alert"]')?.textContent ?? "").not.toContain("registers no clients");
    await type(labelled(dialog, "Client id"), " my-client ");
    await click(button(dialog, "Save and sign in"));
    expect(sent.find((entry) => entry.payload["action"] === "configure")?.payload).toMatchObject({
      action: "configure",
      appId: "calendar-app",
      accountId: "mcp.cal",
      values: { clientId: "my-client" },
    });
    await click(button(dialog, "Sign in to Calendar"));
    expect(sent.filter((entry) => entry.payload["action"] === "connect")).toHaveLength(2);
    expect(dialog.textContent).not.toContain("does not register Tavi by itself");
    await axeClean(view);
  });

  it("takes a keyed app's key in its sheet: the steps to get one, the key saved and tested, then its review", async () => {
    const { clientSetup: _setup, ...base } = app();
    const maps: ConnectableApp = {
      ...base,
      auth: {
        kind: "api-key",
        fields: [{ key: "apiKey", label: "API key", type: "credential", required: true, advanced: false }],
        keySteps: [{ text: "Create a key.", link: { label: "Create a key", url: "https://console.example/keys" } }],
      },
    };
    const { view, sent } = await page([maps], { tab: "connected", appId: "calendar-app" });
    await click(button(view, "Reconnect"));
    const dialog = view.querySelector("dialog") as HTMLElement;
    expect(dialog.textContent).toContain("Your key");
    expect([...dialog.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toContain("https://console.example/keys");
    expect(button(dialog, "Save and test")?.disabled).toBe(true);
    await type(labelled(dialog, "API key"), "AIza-key");
    await click(button(dialog, "Save and test"));
    expect(sent.find((entry) => entry.payload["action"] === "configure")?.payload).toMatchObject({
      action: "configure",
      appId: "calendar-app",
      accountId: "mcp.cal",
      values: { apiKey: "AIza-key" },
    });
    expect(sent.find((entry) => entry.payload["action"] === "test")?.payload).toMatchObject({ action: "test", accountId: "mcp.cal" });
    expect(sent.some((entry) => entry.payload["action"] === "connect")).toBe(false);
    expect(dialog.textContent).toContain("Connected Calendar");
    await axeClean(view);
  });

  it("says a key is stored encrypted only when the credential store is, and plainly otherwise", async () => {
    const { clientSetup: _setup, ...base } = app();
    const maps: ConnectableApp = {
      ...base,
      auth: { kind: "api-key", fields: [{ key: "apiKey", label: "API key", type: "credential", required: true, advanced: false }] },
    };
    for (const [encryption, words] of [
      ["file", "Stored encrypted, never shown again"],
      ["keychain", "Stored encrypted, never shown again"],
      ["none", "Stored by Tavi, not encrypted, never shown again"],
      [undefined, "Stored by Tavi, never shown again"],
    ] as const) {
      const { view } = await page([maps], { tab: "connected", appId: "calendar-app" }, encryption === undefined ? {} : { encryption });
      await click(button(view, "Reconnect"));
      const dialog = view.querySelector("dialog") as HTMLElement;
      expect(labelled(dialog, "API key")?.getAttribute("placeholder")).toBe(words);
      unmountAll();
    }
  });

  it("says a key the server refused at its test was saved but failed, and stays on the key", async () => {
    const { clientSetup: _setup, ...base } = app();
    const maps: ConnectableApp = {
      ...base,
      auth: { kind: "api-key", fields: [{ key: "apiKey", label: "API key", type: "credential", required: true, advanced: false }] },
    };
    const { view } = await page([maps], { tab: "connected", appId: "calendar-app" }, { testFails: true });
    await click(button(view, "Reconnect"));
    const dialog = view.querySelector("dialog") as HTMLElement;
    await type(labelled(dialog, "API key"), "wrong");
    await click(button(dialog, "Save and test"));
    expect(dialog.textContent).toContain("The key is saved, but the test failed: the server refused its key (HTTP 403)");
    expect(button(dialog, "Save and test")).toBeDefined();
    expect(dialog.textContent).not.toContain("Connected Calendar");
  });

  it("says a key its server lists the tools without is checked only when a tool is first used, in the sheet and on Test", async () => {
    const { clientSetup: _setup, ...base } = app();
    const maps: ConnectableApp = {
      ...base,
      name: "Maps",
      auth: { kind: "api-key", fields: [{ key: "apiKey", label: "API key", type: "credential", required: true, advanced: false }] },
    };
    const { view } = await page([maps], { tab: "connected", appId: "calendar-app" }, { keyUnchecked: true });
    await click(button(view, "Reconnect"));
    const dialog = view.querySelector("dialog") as HTMLElement;
    await type(labelled(dialog, "API key"), "any-key");
    await click(button(dialog, "Save and test"));
    expect(dialog.querySelector("[role='status']")?.textContent).toBe("Saved the key; Maps listed its tools.");
    expect(dialog.textContent).toContain(
      "Maps lists its tools without checking the key, so a wrong key shows only when Tavi first uses a tool.",
    );
    await click(button(dialog, "Later"));
    await click(button(view, "Test"));
    expect(view.textContent).toContain("you@example.com listed its tools; the key is checked when a tool is first used.");
    expect(view.textContent).not.toContain("answered.");
  });

  it("keeps focus in the sheet as its steps change, on each step's first item", async () => {
    const { view } = await page([app()], { tab: "connected", appId: "calendar-app" });
    await click(button(view, "Reconnect"));
    const dialog = view.querySelector("dialog") as HTMLElement;
    // Set up your client opens on its first console step's link, not on a Copy button below it.
    expect(document.activeElement?.textContent).toBe("Create a client");
    await click(button(dialog, "Back"));
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.querySelector("li[aria-current='step']")?.textContent).toContain("What it can do");
    await click(button(dialog, "Next"));
    expect(document.activeElement?.textContent).toBe("Create a client");
  });

  it("reconnects an account without changing who may use it", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const own = app({
        trust: { output: "untrusted", source: "mcp", confidentiality: "public" },
        clientSetup: { provider: "example", title: "Your client", steps: [], ready: true },
      });
      const { view, sent } = await page([own], { tab: "connected", appId: "calendar-app" });
      await click(button(view, "Reconnect"));
      const dialog = view.querySelector("dialog") as HTMLElement;
      await click(button(dialog, "Sign in to Calendar"));
      expect(sent.find((entry) => entry.payload["action"] === "connect")?.payload).toMatchObject({ accountId: "mcp.cal" });
      await act(async () => {
        vi.advanceTimersByTime(2_100);
      });
      await settle();
      await settle();
      expect(dialog.textContent).toContain("Connected Calendar as you@example.com.");
      expect(sent.some((entry) => entry.payload["action"] === "sharing")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what the page keeps current and says", () => {
  it("re-reads the list when a plugin is installed elsewhere, and says once that an app stopped working", async () => {
    const region = document.createElement("div");
    region.id = "announcer";
    document.body.append(region);
    try {
      const apps: ConnectableApp[] = [app()];
      const { client, sent } = owner(apps);
      const at = (revision: number) => (
        <InWorkspace client={client} workspaceId="default">
          <ConnectedApps where={{ tab: "connected" }} onWhere={() => undefined} revision={revision} />
        </InWorkspace>
      );
      const view = await mount(at(1));
      const lists = () => sent.filter((entry) => entry.payload["action"] === "list").length;
      expect(lists()).toBe(1);
      expect(region.textContent).toBe("");
      apps.splice(0, 1, app({ health: "error" }), app({ appId: "notes-app", name: "Notes" }));
      await rerender(at(2));
      await settle();
      expect(lists()).toBe(2);
      expect(view.textContent).toContain("Notes");
      expect(region.textContent).toBe("Calendar stopped working.");
    } finally {
      region.remove();
    }
  });

  it("shows a channel account's setup notes and its link, opening apart from the canvas", async () => {
    const withSetup = app({
      accounts: [
        {
          ...app().accounts[0]!,
          setup: {
            lines: ["Public Bot is on: turn it off."],
            link: { label: "Invite the bot to a server", url: "https://discord.com/oauth2/authorize?client_id=1" },
          },
        },
      ],
    });
    const { view } = await page([withSetup], { tab: "connected", appId: "calendar-app" });
    expect(view.textContent).toContain("Public Bot is on: turn it off.");
    const link = view.querySelector<HTMLAnchorElement>(".apps-account-setup a");
    expect(link?.textContent).toBe("Invite the bot to a server");
    expect(link?.getAttribute("href")).toBe("https://discord.com/oauth2/authorize?client_id=1");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    unmountAll();
  });

  it("marks an author's summary and access as theirs, and names the apps one sign-in also connects", async () => {
    const theirs = app({
      source: { kind: "plugin", pluginIds: ["acme.cal"], verified: "reviewed", isolation: "sandboxed" },
      accounts: [{ ...app().accounts[0]!, keptBy: ["Mail"] }],
    });
    const { view } = await page([theirs], { tab: "connected", appId: "calendar-app" });
    expect(view.querySelector("[data-source=author]")?.textContent).toBe(
      "Its author says: “Read your schedule and add events, asking first.”",
    );
    expect(view.textContent).toContain("Access it asks for, in its author's words");
    expect(view.textContent).toContain("The same sign-in also connects Mail.");
    unmountAll();
    const ours = await page([app()], { tab: "connected", appId: "calendar-app" });
    expect(ours.view.querySelector("[data-source=author]")).toBeNull();
  });

  it("quotes no author for a line Tavi wrote, and offers no Reconnect for a server with nothing to sign in to", async () => {
    const notes = app({
      appId: "notes",
      name: "notes",
      summary: "A local MCP server (notes)",
      summaryByTavi: true,
      source: { kind: "mcp", pluginIds: ["mcp.notes"], verified: "reviewed", isolation: "sandboxed" },
      auth: { kind: "none" },
    });
    const { view } = await page([notes], { tab: "connected", appId: "notes" });
    expect(view.querySelector("[data-source=author]")).toBeNull();
    expect(view.textContent).toContain("A local MCP server (notes)");
    expect(view.textContent).not.toContain("Its author says");
    expect([...view.querySelectorAll("button")].map((each) => each.textContent)).not.toContain("Reconnect");
    expect([...view.querySelectorAll("button")].map((each) => each.textContent)).toContain("Test");
  });
});
