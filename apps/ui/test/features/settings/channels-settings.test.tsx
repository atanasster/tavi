// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { ChannelDescriptor, ChannelsListAnswer } from "@tavi/contracts";
import { ChannelAppConnections, ChannelsSettings } from "../../../src/features/settings/ChannelsSettings.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { close, offeredWords, open, pick, selected } from "../../pick.js";
import { InWorkspace } from "../../support/workspace.js";
import { mount as mountView, unmountAll } from "../../support/dom.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** The page the test last mounted: what `field` reads. */
let host: HTMLElement;

/** A channel no page was written for: its form comes from this descriptor alone. */
const pager: ChannelDescriptor = {
  providerId: "pager",
  label: "Pager",
  kind: "sms",
  description: "Pages people.",
  settings: [
    { key: "region", label: "Region", type: "choice", choices: ["eu", "us"], required: true, default: "eu" },
    { key: "from", label: "Sender number", type: "string" },
  ],
  auth: { kind: "secrets", fields: [{ key: "apiKey", label: "API key" }] },
  sender: { label: "Phone number", placeholder: "+15550100", pattern: "\\+\\d+", normalize: "e164", authentication: "provider" },
  target: { label: "Phone number", placeholder: "+15550100", pattern: "\\+\\d+", normalize: "e164" },
};
const letters: ChannelDescriptor = {
  ...pager,
  providerId: "letters",
  label: "Letters",
  kind: "email",
  sender: { ...pager.sender, label: "Address", authentication: "per-message" },
};
const list: ChannelsListAnswer = {
  connections: [
    {
      connectionId: "pager-1",
      providerId: "pager",
      label: "Pager",
      workspaceId: "default",
      accountIdentity: "Pager",
      settings: { region: "us" },
      secretsStored: { apiKey: true },
      enabled: true,
      authState: "none",
      status: { state: "running", lastInboundAt: "2026-10-09T10:00:00.000Z", lastError: "chat not found" },
    },
    {
      connectionId: "letters-1",
      providerId: "letters",
      label: "Letters",
      workspaceId: "default",
      accountIdentity: "Letters",
      settings: {},
      secretsStored: { apiKey: true },
      enabled: true,
      authState: "none",
      status: { state: "running" },
    },
  ],
  oauthClients: {},
  credentialsEncrypted: true,
  ingress: { host: "127.0.0.1", port: 8025 },
};

async function mount(
  people = false,
  connections = list.connections,
  peopleRows: readonly Record<string, unknown>[] = [],
  operator?: string,
  extra: Record<string, unknown> = {},
) {
  const writes: Record<string, unknown>[] = [];
  const answers: Record<string, unknown> = {
    catalog: { channels: [pager, letters] },
    list: { ...list, connections },
    people: { people: peopleRows, ...(operator === undefined ? {} : { operator }) },
    save: { connectionId: "pager-1" },
    test: { status: "accepted" },
    ingress: { applied: false, notApplied: "port in use" },
    pair: { pairingId: "00000000-0000-4000-8000-000000000001", code: "ABCDEFGH", expiresAt: "2026-10-09T10:10:00.000Z" },
    pairing: { state: "claimed", sender: "+15550123", connectionId: "pager-1", principalId: "bo" },
    ...extra,
  };
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const input = payload as Record<string, unknown>;
      writes.push(input);
      const answer = answers[input["action"] as string] as { readonly refusal?: unknown } | undefined;
      if (answer?.refusal !== undefined) return { ok: false, error: answer.refusal } as never;
      return { ok: true, result: answer ?? { ok: true } };
    },
  };
  host = await mountView(
    <InWorkspace client={client} workspaceId="default">
      <ChannelsSettings people={people} />
    </InWorkspace>,
  );
  return writes;
}
const field = <T extends Element = HTMLInputElement>(label: string) => host.querySelector<T>(`[aria-label="${label}"]`)!;
async function fill(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => field<HTMLButtonElement>(label).click());
}
async function submit(form: Element) {
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

it("edits a connection from its descriptor: saved settings shown, secrets masked and sent only when entered", async () => {
  const writes = await mount();
  // When it last took a message in, and why its last send failed.
  expect(host.textContent).toContain("last message received");
  expect(host.textContent).toContain("last send failed: chat not found");
  await click("Edit Pager");
  expect(field("Region").textContent).toContain("us");
  expect(field("API key").className).toBe("secret");
  expect(field("API key").placeholder).toBe("Saved");
  await fill("Sender number", "+15550199");
  await submit(host.querySelector("dialog form")!);
  expect(writes.find((write) => write["action"] === "save")).toEqual({
    action: "save",
    workspaceId: "default",
    connectionId: "pager-1",
    providerId: "pager",
    label: "Pager",
    enabled: true,
    settings: { region: "us", from: "+15550199" },
  });
  expect(host.textContent).toContain("Pager saved and applied.");
});

it("adds a connection of any installed channel, with its defaults and the secret entered", async () => {
  const writes = await mount();
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Add connection")!.click());
  await fill("API key", "  fake-key ");
  await submit(host.querySelector("dialog form")!);
  expect(writes.find((write) => write["action"] === "save")).toEqual({
    action: "save",
    workspaceId: "default",
    providerId: "pager",
    enabled: true,
    settings: { region: "eu" },
    secrets: { apiKey: "fake-key" },
  });
});

it("names each person and webhook field by the words its label shows, for screen readers and voice control", async () => {
  const namesOf = () =>
    [...host.querySelectorAll("label")].flatMap((label) => {
      const input = label.querySelector("input:not([type=checkbox])");
      const shown = label.firstChild?.textContent?.trim() ?? "";
      return input === null || !input.hasAttribute("aria-label") ? [] : [[shown, input.getAttribute("aria-label")]];
    });
  await mount(true);
  const named = namesOf();
  unmountAll();
  await mount();
  named.push(...namesOf());
  expect(named).toContainEqual(["Phone number", "Phone number"]);
  expect(named).toContainEqual(["Local webhook port", "Local webhook port"]);
  for (const [shown, name] of named) expect(name?.toLowerCase().startsWith(shown!.replace(/ \(optional\)$/, "").toLowerCase())).toBe(true);
});

it("allows a person on a connection, labelled by its channel, and offers trust only where messages are checked one by one", async () => {
  const writes = await mount(true);
  expect(host.textContent).toContain("Phone number");
  expect(host.querySelector('[aria-label="Trust this person\'s unverified messages"]')).toBeNull();
  await fill("Phone number", "+15550100");
  await fill("Person ID", "alice");
  await fill("Display name", "  Alice Smith ");
  await submit(host.querySelector("form")!);
  expect(writes).toContainEqual({
    action: "allow",
    workspaceId: "default",
    connectionId: "pager-1",
    sender: "+15550100",
    principalId: "alice",
    name: "Alice Smith",
  });
  expect(field("Phone number").value).toBe("");
  unmountAll();
  await mount(true, [...list.connections].reverse());
  expect(host.textContent).toContain("Address");
  // Named by its visible words, so voice control and getByLabel reach it (QA 2030).
  expect(host.querySelector('[aria-label="Trust this person\'s unverified messages"]')).not.toBeNull();
});

it("allows the operator's own sender as them with This is me, and marks their rows as you", async () => {
  const writes = await mount(
    true,
    list.connections,
    [
      {
        connectionId: "pager-1",
        externalSenderId: "+15550111",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "local settings operator",
        createdAt: "2026-10-09T10:00:00.000Z",
      },
    ],
    "operator",
  );
  expect(host.querySelector(".rows .badge")?.textContent).toBe("you");
  // The channel's own label, as written.
  expect(host.textContent).toContain("Don't know what to enter as Phone number? Pair with a code");
  // The greyed button says what it waits on, until it has it.
  expect(host.textContent).toContain("Tick This is me, or fill in Person ID, to get a code.");
  await act(async () => field("This is me").click());
  expect(host.textContent).not.toContain("to get a code.");
  // Their own principal stands in for a person ID: none is asked.
  expect(host.querySelector('[aria-label="Person ID"]')).toBeNull();
  await fill("Phone number", "+15550100");
  await submit(host.querySelector("form")!);
  expect(writes).toContainEqual({
    action: "allow",
    workspaceId: "default",
    connectionId: "pager-1",
    sender: "+15550100",
    principalId: "operator",
  });
  // The form starts over unticked: someone else's ID is asked again.
  expect(field("This is me").checked).toBe(false);
  expect(field("Person ID").value).toBe("");
  // An ID typed as the operator's is still someone else's: only the box makes it yours.
  await fill("Person ID", "operator");
  expect(field("This is me").checked).toBe(false);
  expect(field("Person ID").value).toBe("operator");
  unmountAll();
  // Without the operator's principal there is nothing to offer.
  await mount(true);
  expect(host.querySelector('[aria-label="This is me"]')).toBeNull();
});

it("saves the webhook listener's settings, saying when it could not move, and removes a connection once confirmed", async () => {
  const writes = await mount();
  const saveWebhooks = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Save webhooks")!;
  // Off until something is changed (Mac mini tests).
  expect(saveWebhooks().disabled).toBe(true);
  await fill("Public address", "https://hooks.example.com/tavi");
  expect(saveWebhooks().disabled).toBe(false);
  await submit(field("Public address").closest("form")!);
  expect(writes).toContainEqual({ action: "ingress", port: 8025, publicUrl: "https://hooks.example.com/tavi" });
  expect(host.textContent).toContain("the listener could not move: port in use");
  await click("Remove Pager");
  await act(async () =>
    [...host.querySelectorAll("dialog button")]
      .find((button) => button.textContent === "Remove connection")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(writes).toContainEqual({ action: "delete", workspaceId: "default", connectionId: "pager-1" });
});

it("pairs a person with a code: shown to send, then who sent it, allowed on confirmation", async () => {
  const writes = await mount(true);
  await fill("Person ID", "bo");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pair with a code")!.click());
  expect(writes).toContainEqual({ action: "pair", workspaceId: "default", connectionId: "pager-1", principalId: "bo" });
  expect(host.querySelector("code[data-pairing-code]")?.textContent).toBe("ABCD-EFGH");
  expect(host.textContent).toContain("/link ABCD-EFGH");
  expect(host.querySelector('svg[role="img"]')).toBeNull();
  expect(host.querySelector(".pairing-links")).toBeNull();
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Check now")!.click());
  expect(host.textContent).toContain("A message from +15550123");
  expect(document.activeElement?.textContent).toContain("A message from +15550123");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Allow them")!.click());
  expect(writes).toContainEqual({ action: "confirm-pair", workspaceId: "default", pairingId: "00000000-0000-4000-8000-000000000001" });
  expect(host.textContent).toContain("bo is paired: their messages on this channel now reach Tavi.");
  expect(field("Person ID").value).toBe("");
});

it("closes a pairing in a browser whose scrollIntoView returns a promise, without taking the page down", async () => {
  // Newer Chrome returns a promise from the scroll methods; an effect that returned it handed React a cleanup that is
  // not a function, and cancelling a pairing showed "This page could not be shown".
  const before = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = (() => Promise.resolve()) as unknown as typeof before;
  try {
    await mount(true);
    await fill("Person ID", "bo");
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pair with a code")!.click());
    expect(host.querySelector("code[data-pairing-code]")).not.toBeNull();
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click());
    expect(host.querySelector("code[data-pairing-code]")).toBeNull();
    expect(host.textContent).not.toContain("could not be shown");
  } finally {
    Element.prototype.scrollIntoView = before;
  }
});

it("says a code can't reach a connection that isn't running in the canvas's words, linking to Channels (QA 2033)", async () => {
  const message =
    "Pager isn't running: Pager getMe failed for connection pager-1: Unauthorized. Fix it in Settings → Channels (or `tavi channels list`) first: a code sent to it could not arrive.";
  await mount(true, list.connections, [], undefined, {
    pair: { refusal: { code: "NOT_CONFIGURED", message, details: { notListening: true, label: "Pager" } } },
  });
  await fill("Person ID", "bo");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pair with a code")!.click());
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe(
    "Pager isn't running, so a code sent to it could not arrive. Fix it in Settings → Channels, which says why.",
  );
  expect(alert?.querySelector('a[href="/settings/messaging"]')?.textContent).toBe("Settings → Channels");
  expect(host.textContent).not.toContain("tavi channels list");
  expect(host.textContent).not.toContain("getMe");
});

it("speaks to you when you pair yourself, warns of a linked account only when one is, and keeps the check time out of the live region", async () => {
  const waiting = { pairing: { state: "waiting", connectionId: "pager-1", principalId: "operator" } };
  await mount(true, list.connections, [], "operator", waiting);
  await act(async () => field("This is me").click());
  await fill("Display name", "Sam");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pair with a code")!.click());
  const panel = host.querySelector('section[aria-label="Pairing"]')!;
  expect(panel.querySelector("h2")?.textContent).toBe("Pair yourself (Sam)");
  expect(panel.textContent).toContain("Send this code to the agent on Pager from your own account");
  expect(panel.textContent).not.toContain("already linked");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Check now")!.click());
  expect(panel.querySelector('p[role="status"]')?.textContent).toBe("No message with the code yet.");
  // On the 24-hour clock the code's expiry is on.
  expect(panel.textContent).toMatch(/Last checked \d{2}:\d{2}:\d{2}\./);

  // Someone already allowed on the connection: their own messages are never read as a code, so the panel says so.
  unmountAll();
  const allowed = { connectionId: "pager-1", externalSenderId: "+15550111", workspaceId: "default", principalId: "alice" };
  await mount(true, list.connections, [{ ...allowed, approvedBy: "x", createdAt: "2026-10-09T10:00:00.000Z" }], "operator", waiting);
  await fill("Person ID", "bo");
  await fill("Display name", "Bo");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pair with a code")!.click());
  const other = host.querySelector('section[aria-label="Pairing"]')!;
  expect(other.querySelector("h2")?.textContent).toBe("Pair Bo");
  expect(other.textContent).toContain("Ask Bo to send this code to the agent on Pager");
  expect(other.textContent).toContain("Someone already allowed on Pager is already linked");
});

it("asks whether it was you when you pair yourself, as Welcome does (QA 1832)", async () => {
  const claimed = { pairing: { state: "claimed", sender: "+15550123", connectionId: "pager-1", principalId: "operator" } };
  const writes = await mount(true, list.connections, [], "operator", claimed);
  await act(async () => field("This is me").click());
  await fill("Display name", "Sam");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pair with a code")!.click());
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Check now")!.click());
  const panel = host.querySelector('section[aria-label="Pairing"]')!;
  expect(panel.textContent).toContain("A message from +15550123 on Pager carried the code. Is this you?");
  expect(panel.textContent).not.toContain("Allow them");
  expect([...panel.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Not me", "Yes, it's me"]);
  await act(async () => [...panel.querySelectorAll("button")].find((button) => button.textContent === "Yes, it's me")!.click());
  expect(writes).toContainEqual({ action: "confirm-pair", workspaceId: "default", pairingId: "00000000-0000-4000-8000-000000000001" });
  expect(host.textContent).toContain("You're paired: your messages on this channel now reach Tavi.");
});

it("shows the Telegram QR code and deep link when pairing, names the sender who claimed it, and confirms before revoking access", async () => {
  const writes = await mount(
    true,
    list.connections,
    [
      {
        connectionId: "pager-1",
        externalSenderId: "+15550111",
        displayName: "Alice",
        workspaceId: "default",
        principalId: "alice",
        approvedBy: "local settings operator",
        createdAt: "2026-10-09T10:00:00.000Z",
      },
    ],
    "operator",
    {
      pair: {
        pairingId: "00000000-0000-4000-8000-000000000002",
        code: "4KX9QM2P",
        expiresAt: "2026-10-09T10:10:00.000Z",
        account: "tavi_test_bot",
        linkUrl: "https://t.me/tavi_test_bot?start=4KX9-QM2P",
        openLabel: "Open in Telegram",
      },
      pairing: {
        state: "claimed",
        sender: "99887766",
        senderName: "Alice (@alice)",
        connectionId: "pager-1",
        principalId: "alice",
      },
    },
  );

  await fill("Person ID", "alice");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pair with a code")!.click());
  expect(host.querySelector("code[data-pairing-code]")?.textContent).toBe("4KX9-QM2P");
  expect(host.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toContain("QR code to link");
  expect(host.querySelector(".pairing-links a")?.getAttribute("href")).toBe("https://t.me/tavi_test_bot?start=4KX9-QM2P");
  expect(host.querySelector(".pairing-command code")?.textContent).toBe("/link 4KX9-QM2P");

  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Check now")!.click());
  expect(host.textContent).toContain("A message from Alice (@alice) (99887766)");

  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Revoke access")!.click());
  const dialog = host.querySelector("dialog")!;
  // A connection named after its channel is named once.
  expect(dialog.textContent).toContain("Block new incoming messages from Alice (+15550111) on Pager.");
  expect(writes.some((write) => write["action"] === "revoke")).toBe(false);
  await act(async () =>
    [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Revoke access")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(writes).toContainEqual({
    action: "revoke",
    workspaceId: "default",
    connectionId: "pager-1",
    sender: "+15550111",
  });

  // When a pairing code expires, "Get a new code" starts a fresh pairing right from the panel.
  unmountAll();
  const expiredWrites = await mount(true, list.connections, [], "operator", {
    pair: {
      pairingId: "00000000-0000-4000-8000-000000000003",
      code: "WXYZ2345",
      expiresAt: "2026-10-09T10:10:00.000Z",
    },
    pairing: {
      state: "expired",
      connectionId: "pager-1",
      principalId: "alice",
    },
  });
  await fill("Person ID", "alice");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pair with a code")!.click());
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Check now")!.click());
  expect(host.textContent).toContain("The code expired before anyone sent it. Pair again for a new one.");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Get a new code")!.click());
  expect(expiredWrites.filter((write) => write["action"] === "pair")).toHaveLength(2);
});

it("saves an app its provider's apps share with no redirect port to keep", async () => {
  const shared: ChannelDescriptor = {
    ...pager,
    providerId: "inbox-shared",
    label: "Inbox",
    settings: [],
    auth: {
      kind: "oauth2",
      oauth: {
        authorizeUrl: "https://a.example.com/a",
        tokenUrl: "https://a.example.com/t",
        scopes: [],
        pkce: true,
        client: { source: "operator" },
        redirect: "loopback-any-port",
        tokenAuthMethod: "none",
      },
    },
  };
  const writes: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const input = payload as Record<string, unknown>;
      writes.push(input);
      if (input["action"] === "catalog") return { ok: true, result: { channels: [shared] } };
      if (input["action"] === "list")
        return {
          ok: true,
          result: {
            ...list,
            connections: [],
            oauthClients: { "inbox-shared": { source: "operator", own: false, ready: false } },
          },
        };
      return { ok: true, result: { ok: true } };
    },
  };
  host = await mountView(
    <InWorkspace client={client} workspaceId="default">
      <ChannelsSettings />
    </InWorkspace>,
  );
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Add connection")!.click());
  expect(host.querySelector('[aria-label="OAuth redirect port"]')).toBeNull();
  await fill("OAuth client ID", "my-client");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Save OAuth app")!.click());
  const saved = writes.filter((write) => write["action"] === "oauth-client");
  expect(saved).toEqual([{ action: "oauth-client", providerId: "inbox-shared", clientId: "my-client" }]);
});

it("asks for the operator's own OAuth app where the channel needs one, and offers another where it ships one", async () => {
  const oauth = (source: "operator" | "plugin"): ChannelDescriptor => ({
    ...pager,
    providerId: `inbox-${source}`,
    label: "Inbox",
    settings: [],
    auth: {
      kind: "oauth2",
      oauth: {
        authorizeUrl: "https://a.example.com/a",
        tokenUrl: "https://a.example.com/t",
        scopes: [],
        pkce: true,
        client: source === "operator" ? { source } : { source, clientId: "shipped" },
        redirect: "loopback-any-port",
        tokenAuthMethod: "none",
      },
    },
  });
  const writes: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const input = payload as Record<string, unknown>;
      writes.push(input);
      if (input["action"] === "catalog") return { ok: true, result: { channels: [oauth("operator"), oauth("plugin")] } };
      if (input["action"] === "list")
        return {
          ok: true,
          result: {
            ...list,
            connections: [],
            oauthClients: {
              "inbox-operator": { source: "operator", own: false, ready: false },
              "inbox-plugin": { source: "plugin", own: false, ready: true },
            },
          },
        };
      return { ok: true, result: { ok: true } };
    },
  };
  host = await mountView(
    <InWorkspace client={client} workspaceId="default">
      <ChannelsSettings />
    </InWorkspace>,
  );
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Add connection")!.click());
  // The operator's channel needs their app before anything connects.
  await fill("OAuth client ID", "my-client");
  await fill("OAuth client secret", "my-secret");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Save OAuth app")!.click());
  expect(writes).toContainEqual({ action: "oauth-client", providerId: "inbox-operator", clientId: "my-client", clientSecret: "my-secret" });
  expect(field("OAuth client secret").className).toBe("secret");
  // Enter in the app's fields saves the app, not the connection.
  await submit(field("OAuth client ID").closest("form")!);
  expect(writes.filter((write) => write["action"] === "save")).toEqual([]);
  // A channel that ships its app offers your own in its place, and to forget it again.
  unmountAll();
  const own: SettingsClient = {
    request: async (_command, payload) => {
      const input = payload as Record<string, unknown>;
      writes.push(input);
      if (input["action"] === "catalog") return { ok: true, result: { channels: [oauth("plugin")] } };
      if (input["action"] === "list")
        return {
          ok: true,
          result: { ...list, connections: [], oauthClients: { "inbox-plugin": { source: "plugin", own: true, ready: true } } },
        };
      return { ok: true, result: { ok: true } };
    },
  };
  host = await mountView(
    <InWorkspace client={own} workspaceId="default">
      <ChannelsSettings />
    </InWorkspace>,
  );
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Add connection")!.click());
  expect(host.textContent).toContain("Connects through your own OAuth app.");
  expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Use a different OAuth app")).toBe(true);
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Forget my OAuth app")!.click());
  expect(writes).toContainEqual({ action: "oauth-client-clear", providerId: "inbox-plugin" });
});

it("signs a saved OAuth connection in through a window of its own, and says who it connected as once the owner does", async () => {
  vi.useFakeTimers();
  try {
    const inbox: ChannelDescriptor = {
      ...pager,
      providerId: "inbox",
      label: "Inbox",
      settings: [],
      auth: {
        kind: "oauth2",
        oauth: {
          authorizeUrl: "https://a.example.com/a",
          tokenUrl: "https://a.example.com/t",
          scopes: [],
          pkce: true,
          client: { source: "plugin", clientId: "shipped" },
          redirect: "loopback-any-port",
          tokenAuthMethod: "none",
        },
      },
    };
    const connection = {
      ...list.connections[0]!,
      connectionId: "inbox-1",
      providerId: "inbox",
      label: "Inbox",
      accountIdentity: "Inbox",
      settings: {},
      secretsStored: {},
      authState: "none" as const,
    };
    const writes: Record<string, unknown>[] = [];
    const opened: unknown[] = [];
    vi.spyOn(window, "open").mockImplementation((...args: unknown[]) => {
      opened.push(args);
      return null;
    });
    const client: SettingsClient = {
      request: async (_command, payload) => {
        const input = payload as Record<string, unknown>;
        writes.push(input);
        if (input["action"] === "catalog") return { ok: true, result: { channels: [inbox] } };
        if (input["action"] === "people") return { ok: true, result: { people: [] } };
        if (input["action"] === "list")
          return {
            ok: true,
            result: { ...list, connections: [connection], oauthClients: { inbox: { source: "plugin", own: false, ready: true } } },
          };
        if (input["action"] === "oauth-start")
          return { ok: true, result: { flowId: "00000000-0000-4000-8000-000000000002", authorizeUrl: "https://a.example.com/a?state=s" } };
        if (input["action"] === "oauth-status") return { ok: true, result: { state: "connected", accountIdentity: "bo@example.com" } };
        return { ok: true, result: { ok: true } };
      },
    };
    host = await mountView(
      <InWorkspace client={client} workspaceId="default">
        <ChannelsSettings />
      </InWorkspace>,
    );
    await click("Edit Inbox");
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Connect with Inbox")!.click());
    expect(writes).toContainEqual({
      action: "oauth-start",
      workspaceId: "default",
      connectionId: "inbox-1",
      origin: window.location.origin,
    });
    expect(opened[0]).toEqual(["https://a.example.com/a?state=s", "_blank", "popup,noopener,noreferrer,width=560,height=720"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(host.textContent).toContain("Connected as bo@example.com.");
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it("asks for credential encryption before an OAuth connection can be signed in, and turns it on in place", async () => {
  const inbox: ChannelDescriptor = {
    ...pager,
    providerId: "inbox",
    label: "Inbox",
    settings: [],
    auth: {
      kind: "oauth2",
      oauth: {
        authorizeUrl: "https://a.example.com/a",
        tokenUrl: "https://a.example.com/t",
        scopes: [],
        pkce: true,
        client: { source: "plugin", clientId: "shipped" },
        redirect: "loopback-any-port",
        tokenAuthMethod: "none",
      },
    },
  };
  const connection = {
    ...list.connections[0]!,
    connectionId: "inbox-1",
    providerId: "inbox",
    label: "Inbox",
    settings: {},
    secretsStored: {},
    authState: "none" as const,
  };
  const asked: { command: string; payload: Record<string, unknown> }[] = [];
  let encrypted = false;
  const client: SettingsClient = {
    request: async (command, payload) => {
      const input = payload as Record<string, unknown>;
      asked.push({ command, payload: input });
      if (input["action"] === "catalog") return { ok: true, result: { channels: [inbox] } };
      if (input["action"] === "people") return { ok: true, result: { people: [] } };
      if (input["action"] === "list")
        return {
          ok: true,
          result: {
            ...list,
            connections: [connection],
            oauthClients: { inbox: { source: "plugin", own: false, ready: true } },
            credentialsEncrypted: encrypted,
          },
        };
      if (command === "credentials") {
        encrypted = true;
        return { ok: true, result: { undecryptable: ["old.key"], unencrypted: [] } };
      }
      return { ok: true, result: {} };
    },
  };
  host = await mountView(
    <InWorkspace client={client} workspaceId="default">
      <ChannelsSettings />
    </InWorkspace>,
  );
  await click("Edit Inbox");
  expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Connect with Inbox")).toBe(false);
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Encrypt credentials")!.click());
  expect(asked).toContainEqual({ command: "credentials", payload: { action: "encrypt" } });
  expect(host.textContent).toContain("Credentials are encrypted at rest.");
  expect(host.textContent).toContain("do not decrypt with this data directory's key: old.key");
  // Encrypted now, the dialog offers the sign-in.
  expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Connect with Inbox")).toBe(true);
});

it("removes a connection whose channel is no longer installed, offering no edit of it", async () => {
  const gone = {
    ...list.connections[0]!,
    connectionId: "fax-1",
    providerId: "fax",
    label: "Fax",
    status: { state: "failed" as const, detail: "provider missing" },
  };
  const writes = await mount(false, [gone]);
  expect(host.querySelector('[aria-label="Edit Fax"]')).toBeNull();
  expect(field<HTMLButtonElement>("Remove Fax")).not.toBeNull();
  await click("Remove Fax");
  const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent === "Remove connection");
  await act(async () => confirm?.click());
  expect(writes).toContainEqual(expect.objectContaining({ action: "delete", connectionId: "fax-1" }));
});

it("stops trusting a person's unverified messages from their row", async () => {
  const writes = await mount(true, list.connections, [
    {
      connectionId: "letters-1",
      externalSenderId: "ana@example.com",
      workspaceId: "default",
      principalId: "ana",
      approvedBy: "operator",
      createdAt: "2026-10-09T00:00:00.000Z",
      trustUnverified: { setBy: "local settings operator", setAt: "2026-10-09T00:00:00.000Z" },
    },
  ]);
  expect(host.textContent).toContain("trusts unverified messages");
  const stop = [...host.querySelectorAll("button")].find((button) => button.textContent === "Stop trusting unverified");
  await act(async () => stop?.click());
  expect(writes).toContainEqual({
    action: "allow",
    workspaceId: "default",
    connectionId: "letters-1",
    sender: "ana@example.com",
    principalId: "ana",
    trustUnverified: false,
  });
});

it("asks before a sign-out, naming the app that keeps the sign-in, and says so once done", async () => {
  const gmail: ChannelDescriptor = {
    ...pager,
    providerId: "gmail",
    label: "Gmail",
    settings: [],
    auth: {
      kind: "oauth2",
      oauth: {
        authorizeUrl: "https://a.example.com/a",
        tokenUrl: "https://a.example.com/t",
        scopes: [],
        pkce: true,
        client: { source: "operator" },
        redirect: "loopback-any-port",
        tokenAuthMethod: "none",
      },
    },
  };
  const connection = {
    ...list.connections[0]!,
    connectionId: "gmail-1",
    providerId: "gmail",
    label: "Gmail",
    accountIdentity: "me@gmail.com",
    settings: {},
    secretsStored: {},
    authState: "connected" as const,
    keptBy: ["Google Calendar"],
  };
  const writes: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const input = payload as Record<string, unknown>;
      writes.push(input);
      if (input["action"] === "catalog") return { ok: true, result: { channels: [gmail] } };
      if (input["action"] === "people") return { ok: true, result: { people: [] } };
      if (input["action"] === "list")
        return {
          ok: true,
          result: { ...list, connections: [connection], oauthClients: { gmail: { source: "operator", own: true, ready: true } } },
        };
      if (input["action"] === "oauth-disconnect") return { ok: true, result: { ok: true, keptBy: ["Google Calendar"] } };
      return { ok: true, result: { ok: true } };
    },
  };
  host = await mountView(
    <InWorkspace client={client} workspaceId="default">
      <ChannelsSettings />
    </InWorkspace>,
  );
  await click("Edit Gmail");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Disconnect")!.click());
  // Nothing is signed out until it is confirmed.
  expect(writes.some((write) => write["action"] === "oauth-disconnect")).toBe(false);
  expect(host.textContent).toContain(
    "Google Calendar stays connected; the provider will still list Tavi under your account until you disconnect it too.",
  );
  const dialogs = [...host.querySelectorAll("dialog")];
  await act(async () => [...dialogs.at(-1)!.querySelectorAll("button")].find((button) => button.textContent === "Disconnect")!.click());
  expect(writes).toContainEqual({ action: "oauth-disconnect", workspaceId: "default", connectionId: "gmail-1" });
  expect(host.textContent).toContain("Google Calendar keeps its sign-in.");
});

it("shows a group channel's rooms and grants: turns a room's context on, saves a contact's grant and revokes one", async () => {
  const grouped: ChannelDescriptor = {
    ...pager,
    providerId: "huddle",
    label: "Huddle",
    kind: "chat",
    groups: { unboundSenders: "drop", unlistedRooms: "drop", defaultTrigger: ["mention"] },
  };
  const writes: Record<string, unknown>[] = [];
  const grant = {
    grantId: "grant-1",
    workspaceId: "default",
    connectionId: "huddle-1",
    scopeKind: "room",
    scopeId: "room-7",
    toolId: "web_search",
    mode: "deny",
    createdBy: "operator",
    createdAt: "2026-10-18T09:00:00.000Z",
    inForce: true,
  };
  const answers: Record<string, unknown> = {
    catalog: { channels: [grouped] },
    list: { ...list, connections: [{ ...list.connections[0]!, connectionId: "huddle-1", providerId: "huddle", label: "Huddle" }] },
    people: { people: [] },
    rooms: {
      rooms: [
        {
          connectionId: "huddle-1",
          conversationId: "room-7",
          workspaceId: "default",
          label: "Game night",
          trigger: ["mention"],
          members: "bound",
          context: "off",
          introState: "sent",
          createdAt: "2026-10-18T09:00:00.000Z",
          updatedAt: "2026-10-18T09:00:00.000Z",
        },
      ],
      candidates: [],
      waiting: [],
      drops: {},
    },
    grants: { grants: [grant] },
  };
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const input = payload as Record<string, unknown>;
      writes.push(input);
      const answer = answers[input["action"] as string] as { readonly refusal?: unknown } | undefined;
      if (answer?.refusal !== undefined) return { ok: false, error: answer.refusal } as never;
      return { ok: true, result: answer ?? { ok: true } };
    },
  };
  host = await mountView(
    <InWorkspace client={client} workspaceId="default">
      <ChannelsSettings people={false} />
    </InWorkspace>,
  );
  await click("Rooms of Huddle");
  expect(host.textContent).toContain("Game night");
  expect(host.textContent).toContain("reads only the message that addresses Tavi");
  expect(host.textContent).toContain("Deny web_search");
  await click("Read recent messages in Game night");
  expect(writes.find((write) => write["action"] === "rooms" && write["op"] === "set")).toEqual({
    action: "rooms",
    workspaceId: "default",
    connectionId: "huddle-1",
    op: "set",
    conversationId: "room-7",
    context: "recent",
  });
  await fill("Grant scope id", "u-bob");
  await fill("Grant tool", "fs.write");
  await submit(host.querySelector("dialog form")!);
  expect(writes.find((write) => write["action"] === "grants" && write["op"] === "add")).toEqual({
    action: "grants",
    workspaceId: "default",
    connectionId: "huddle-1",
    op: "add",
    scopeKind: "contact",
    scopeId: "u-bob",
    toolId: "fs.write",
    mode: "deny",
  });
  await click("Revoke grant-1");
  expect(writes.find((write) => write["action"] === "grants" && write["op"] === "revoke")).toEqual({
    action: "grants",
    workspaceId: "default",
    connectionId: "huddle-1",
    op: "revoke",
    grantId: "grant-1",
  });
  expect(host.textContent).toContain("Revoked, from the chat's next turn.");
});

it("lists a group channel's rooms with their trigger and health, adds one from the platform's list or those waiting, and removes one", async () => {
  const grouped: ChannelDescriptor = {
    ...pager,
    providerId: "huddle",
    label: "Huddle",
    kind: "chat",
    groups: { unboundSenders: "drop", unlistedRooms: "drop", defaultTrigger: ["mention"] },
  };
  const writes: Record<string, unknown>[] = [];
  const room = (conversationId: string, label: string, trigger: readonly string[], introState = "sent") => ({
    connectionId: "huddle-1",
    conversationId,
    workspaceId: "default",
    label,
    trigger,
    members: "bound",
    context: "off",
    introState,
    createdAt: "2026-10-18T09:00:00.000Z",
    updatedAt: "2026-10-18T09:00:00.000Z",
  });
  const answers: Record<string, unknown> = {
    catalog: { channels: [grouped] },
    list: { ...list, connections: [{ ...list.connections[0]!, connectionId: "huddle-1", providerId: "huddle", label: "Huddle" }] },
    people: { people: [] },
    rooms: {
      rooms: [room("room-7", "Game night", ["mention", "reply"]), room("room-8", "Old room", ["mention"], "pending")],
      candidates: [
        { id: "room-7", name: "game-night" },
        { id: "room-9", name: "carpool", place: "School" },
      ],
      waiting: [{ conversationId: "room-10", by: "mark", how: "added", at: "2026-10-18T09:00:00.000Z", roomName: "lobby" }],
      drops: { "not-addressed": 3, bot: 1 },
      details: { "room-7": "the bot lacks a permission it needs in this room" },
    },
    grants: { grants: [] },
  };
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const input = payload as Record<string, unknown>;
      writes.push(input);
      const answer = answers[input["action"] as string] as { readonly refusal?: unknown } | undefined;
      if (answer?.refusal !== undefined) return { ok: false, error: answer.refusal } as never;
      return { ok: true, result: answer ?? { ok: true } };
    },
  };
  host = await mountView(
    <InWorkspace client={client} workspaceId="default">
      <ChannelsSettings people={false} />
    </InWorkspace>,
  );
  await click("Rooms of Huddle");
  expect(host.textContent).toContain("answers when they mention me or reply to one of my messages");
  expect(host.textContent).toContain("answers when they mention me");
  expect(host.textContent).toContain("Its last message was refused: the bot lacks a permission it needs in this room");
  expect(host.textContent).toContain("Not taken in since Tavi started: 3 not-addressed, 1 bot.");
  expect(host.textContent).toContain(
    "Its introduction was not sent: Tavi tries again the next time the room is listed with the connection open.",
  );
  // The picker offers only the platform's rooms not listed yet.
  // jsdom has no layout: the open list scrolls its choice into view through a stand-in.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  try {
    await act(async () => field("Room to add").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(["Choose a room…", "carpool (School)"]);
    const carpool = options[1]!;
    await act(async () => {
      carpool.focus();
      carpool.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  await submit(field("Room to add").closest("form")!);
  expect(writes).toContainEqual({ action: "rooms", workspaceId: "default", connectionId: "huddle-1", op: "add", conversationId: "room-9" });
  await click("Add lobby as a room");
  expect(writes).toContainEqual({
    action: "rooms",
    workspaceId: "default",
    connectionId: "huddle-1",
    op: "add",
    conversationId: "room-10",
  });
  await click("Leave lobby");
  expect(writes).toContainEqual({
    action: "rooms",
    workspaceId: "default",
    connectionId: "huddle-1",
    op: "leave",
    conversationId: "room-10",
  });
  await click("Remove room Old room");
  expect(writes).toContainEqual({
    action: "rooms",
    workspaceId: "default",
    connectionId: "huddle-1",
    op: "remove",
    conversationId: "room-8",
  });
});

it("removing a purging channel's connection says what goes in 24 hours, how to export first, and the targets that go too", async () => {
  const writes: Record<string, unknown>[] = [];
  const answers: Record<string, unknown> = {
    catalog: { channels: [pager] },
    list,
    people: { people: [] },
    "remove-preview": {
      retention: "purge-on-remove",
      conversations: 2,
      messages: 9,
      files: 1,
      notes: 4,
      tasks: ["task-1"],
      moreTasks: 0,
      routineTargets: ["t-1"],
      heartbeats: 1,
    },
  };
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const input = payload as Record<string, unknown>;
      writes.push(input);
      const answer = answers[input["action"] as string] as { readonly refusal?: unknown } | undefined;
      if (answer?.refusal !== undefined) return { ok: false, error: answer.refusal } as never;
      return { ok: true, result: answer ?? { ok: true } };
    },
  };
  host = await mountView(
    <InWorkspace client={client} workspaceId="default">
      <ChannelsSettings people={false} />
    </InWorkspace>,
  );
  await click("Remove Pager");
  expect(host.textContent).toContain(
    "In 24 hours Tavi erases what it brought in, as its channel's terms require: 2 conversations, 9 messages, 1 file and 4 chat notes its chats taught.",
  );
  expect(host.textContent).toContain("tavi tasks history task-1 export");
  expect(host.textContent).toContain("Delivery targets on it go too: routine target t-1 and 1 heartbeat target.");
  expect(writes.some((write) => write["action"] === "delete")).toBe(false);
  await act(async () =>
    [...host.querySelectorAll("dialog button")]
      .find((button) => button.textContent === "Remove and erase")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(writes).toContainEqual({ action: "delete", workspaceId: "default", connectionId: "pager-1" });
  expect(host.textContent).toContain("What it brought in is erased in 24 hours");
});

it("tests to a person allowed on the connection, remembers the last recipient, and offers to allow a sender id it reached", async () => {
  window.localStorage.clear();
  const ana = {
    connectionId: "pager-1",
    externalSenderId: "+15550100",
    workspaceId: "default",
    principalId: "ana",
    displayName: "Ana",
    approvedBy: "local settings operator",
    createdAt: "2026-10-09T10:00:00.000Z",
  };
  const elsewhere = { ...ana, connectionId: "letters-1", externalSenderId: "+15550111", principalId: "bo", displayName: "Bo" };
  let writes = await mount(false, list.connections, [ana, elsewhere]);
  await click("Test Pager");
  // Only the people allowed on this connection, the first chosen; the typed target is hidden until asked for.
  await open(field("Test person"));
  expect(offeredWords()).toEqual(["Ana · +15550100", "Another phone number…"]);
  await close();
  expect(field("Test recipient")).toBeNull();
  await submit(host.querySelector("dialog form")!);
  expect(writes).toContainEqual({ action: "test", workspaceId: "default", connectionId: "pager-1", to: "+15550100", direct: true });
  // A sender id typed in and reached: offered to be allowed, and remembered for the next test.
  await pick(field("Test person"), "");
  await fill("Test recipient", "+15550123");
  await submit(host.querySelector("dialog form")!);
  expect(writes).toContainEqual({ action: "test", workspaceId: "default", connectionId: "pager-1", to: "+15550123" });
  expect(host.textContent).toContain("+15550123 is a Phone number too");
  await fill("Person ID", "cy");
  await submit(host.querySelectorAll("dialog form")[1]!);
  expect(writes).toContainEqual({
    action: "allow",
    workspaceId: "default",
    connectionId: "pager-1",
    sender: "+15550123",
    principalId: "cy",
  });
  expect(host.textContent).toContain("cy is allowed");
  unmountAll();
  writes = await mount(false, list.connections, [ana]);
  await click("Test Pager");
  expect(selected(field("Test person"))).toBe("");
  expect(field("Test recipient").value).toBe("+15550123");
});

it("says a refused test and a failed people load, offering no one to allow", async () => {
  window.localStorage.clear();
  const writes: Record<string, unknown>[] = [];
  const answers: Record<string, unknown> = {
    catalog: { channels: [pager, letters] },
    list,
    test: { status: "refused", detail: "chat not found" },
  };
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const input = payload as Record<string, unknown>;
      writes.push(input);
      if (input["action"] === "people") return { ok: false, error: { code: "UNAVAILABLE", message: "the store is busy" } };
      return { ok: true, result: answers[input["action"] as string] ?? { ok: true } };
    },
  };
  host = await mountView(
    <InWorkspace client={client} workspaceId="default">
      <ChannelsSettings />
    </InWorkspace>,
  );
  await click("Test Pager");
  expect(host.textContent).toContain("the store is busy");
  expect(field("Test person")).toBeNull();
  await fill("Test recipient", "+15550123");
  await submit(host.querySelector("dialog form")!);
  expect(host.textContent).toContain("The test was refused: chat not found");
  expect(host.textContent).not.toContain("is a Phone number too");
});

it("says who may reach each connection, and allows a person on it from its row", async () => {
  const ana = { connectionId: "pager-1", externalSenderId: "+15550100", principalId: "ana", displayName: "Ana", workspaceId: "default" };
  const writes = await mount(false, list.connections, [ana]);
  const rows = [...host.querySelectorAll("li.row")];
  expect(rows[0]!.textContent).toContain("Allowed: Ana (+15550100)");
  // A connection no one is allowed on answers no one, and says so.
  expect(rows[1]!.textContent).toContain("No one allowed");
  await click("People on Letters");
  const dialog = host.querySelector("dialog")!;
  // The connection is the row's: not picked again, and only its people are listed.
  expect(dialog.querySelector('[aria-label="Person connection"]')).toBeNull();
  expect(dialog.textContent).toContain("No one is allowed on Letters yet");
  await fill("Address", "ana@example.com");
  await fill("Person ID", "ana");
  await submit(dialog.querySelector("form")!);
  expect(writes).toContainEqual({
    action: "allow",
    workspaceId: "default",
    connectionId: "letters-1",
    sender: "ana@example.com",
    principalId: "ana",
  });
  // Allowing was what the dialog was opened for: it closes, and its word stays on the page.
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.textContent).toContain("Person allowed: their messages on this channel now reach Tavi.");
});

it("asks who may reach a connection just added", async () => {
  await mount(false, list.connections);
  const add = [...host.querySelectorAll("button")].find((button) => button.textContent === "Add connection")!;
  await act(async () => add.click());
  await fill("API key", "secret");
  await submit(host.querySelector("dialog form")!);
  // The saved connection (the answer's pager-1) is the one people are asked for.
  expect(host.textContent).toContain("People on Pager");
  expect(host.querySelector("dialog")?.textContent).toContain("Allow a person");
});

it("shows a channel's connections on its app page: settings, saved secrets and the people allowed", async () => {
  const ana = { connectionId: "pager-1", externalSenderId: "+15550100", principalId: "ana", workspaceId: "default" };
  const answers: Record<string, unknown> = { catalog: { channels: [pager, letters] }, list, people: { people: [ana] } };
  const client: SettingsClient = {
    request: async (_command, payload) => ({
      ok: true,
      result: answers[(payload as Record<string, unknown>)["action"] as string] ?? { ok: true },
    }),
  };
  host = await mountView(
    <InWorkspace client={client} workspaceId="default">
      <ChannelAppConnections providerId="pager" />
    </InWorkspace>,
  );
  expect(host.textContent).toContain("Region: us · API key: saved");
  expect(host.textContent).toContain("Allowed: ana (+15550100)");
  // Only this channel's connections.
  expect(host.textContent).not.toContain("Letters");
  await click("People on Pager");
  expect(host.querySelector("dialog")?.textContent).toContain("Allow a person");
});

it("reads the connections again while the page is open, so a connection's last message stays current (Mac mini tests)", async () => {
  vi.useFakeTimers();
  try {
    const writes = await mount();
    const lists = () => writes.filter((write) => write["action"] === "list").length;
    const before = lists();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(lists()).toBeGreaterThan(before);
    // Quietly: the page does not flash a loading line over what it shows.
    expect(host.textContent).not.toContain("Loading…");
  } finally {
    vi.useRealTimers();
  }
});

it("on Allowed people, says an allowed person as the page's note, the display name's use under its field, and a revoke by the person's ID", async () => {
  const bo = { connectionId: "pager-1", externalSenderId: "+15550199", principalId: "bo", workspaceId: "default" };
  await mount(true, list.connections, [bo]);
  // A placeholder a phone cut short is now an example, its meaning said under the field.
  expect(field("Display name").getAttribute("placeholder")).toBe("e.g. Sam");
  expect(field("Display name").closest("label")?.textContent).toContain("Shown in Center; the person ID otherwise.");
  await fill("Phone number", "+15550123");
  await fill("Person ID", "cy");
  await submit(host.querySelector("form")!);
  expect(host.querySelector(".page-note")?.textContent).toBe("Person allowed: their messages on this channel now reach Tavi.");
  // A person with no display name is named by their person ID, as their row is.
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Revoke access")!.click());
  expect(host.querySelector("dialog")?.textContent).toContain("Block new incoming messages from bo (+15550199) on Pager.");
});
