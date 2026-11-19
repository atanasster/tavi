// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import type { ClientResponse } from "@tavi/client/browser";

import type { Outcome, SettingsClient } from "../../../src/lib/ipc.js";
import { CredentialsSettings } from "../../../src/features/settings/CredentialsSettings.js";
import { Modal } from "../../../src/ui/Modal.js";
import { PermissionsSettings } from "../../../src/features/settings/PermissionsSettings.js";
import { useLoaded } from "../../../src/hooks/use-loaded.js";
import { WebSearchFormModal } from "../../../src/features/settings/WebSearchFormModal.js";
import type { WebSearchFormValues } from "../../../src/features/settings/search-api.js";
import { close, offered, open, pick, selected } from "../../pick.js";
import { InWorkspace } from "../../support/workspace.js";
import { button, click, mount, unmountAll } from "../../support/dom.js";

/** The settings views' behaviour in a DOM: what a click, a key or a keystroke does. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Type into a React-controlled input, as a user does. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const byLabel = (container: HTMLElement, text: string): HTMLInputElement => {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.startsWith(text));
  const input =
    label?.htmlFor === undefined || label.htmlFor === "" ? undefined : container.querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`);
  if (input === null || input === undefined) throw new Error(`no field labelled ${text}`);
  return input;
};

function Loaded({ load }: { readonly load: () => Promise<Outcome<string>> }) {
  const { data, error, reload } = useLoaded(load);
  return (
    <p>
      <span id="data">{data ?? "-"}</span>
      <span id="error">{error ?? "-"}</span>
      <button type="button" onClick={reload}>
        reload
      </button>
    </p>
  );
}

describe("useLoaded", () => {
  it("keeps a refusal beside the last good data, asks again on reload, and drops an answer that arrives after unmount", async () => {
    const answers: Outcome<string>[] = [
      { ok: true, value: "first" },
      { ok: false, message: "refused" },
      { ok: true, value: "second" },
    ];
    let calls = 0;
    const view = await mount(<Loaded load={() => Promise.resolve(answers[calls++] ?? { ok: true, value: "more" })} />);
    expect(view.querySelector("#data")?.textContent).toBe("first");
    await click(button(view, "reload"));
    expect(view.querySelector("#data")?.textContent).toBe("first");
    expect(view.querySelector("#error")?.textContent).toBe("refused");
    await click(button(view, "reload"));
    expect(view.querySelector("#data")?.textContent).toBe("second");
    expect(view.querySelector("#error")?.textContent).toBe("-");

    let late: (outcome: Outcome<string>) => void = () => undefined;
    const pending = await mount(<Loaded load={() => new Promise((resolve) => (late = resolve))} />);
    unmountAll();
    // No warning, no throw: the unmounted page takes nothing.
    await act(async () => late({ ok: true, value: "too late" }));
    expect(pending.querySelector("#data")).toBeNull();
  });
});

describe("Modal", () => {
  it("closes on Escape and its close button, not on the backdrop or a click inside, and not while busy", async () => {
    let closed = 0;
    const view = await mount(
      <Modal title="Title" onClose={() => (closed += 1)}>
        <input aria-label="inside" />
      </Modal>,
    );
    const dialog = view.querySelector("dialog");
    expect(dialog?.getAttribute("aria-labelledby")).toBe(view.querySelector("h2")?.id);
    // Focus moves in, past the header's close button.
    expect(document.activeElement).toBe(view.querySelector("input"));
    await click(view.querySelector("input"));
    expect(closed).toBe(0);
    // The backdrop: a stray click beside a half-filled form does not lose it.
    await click(dialog);
    expect(closed).toBe(0);
    await act(async () => dialog?.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(closed).toBe(1);
    await click(view.querySelector("button[aria-label='Close dialog']"));
    expect(closed).toBe(2);

    unmountAll();
    let busyClosed = 0;
    const busy = await mount(
      <Modal title="Busy" busy onClose={() => (busyClosed += 1)}>
        <p>saving</p>
      </Modal>,
    );
    await act(async () => busy.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true })));
    const close = busy.querySelector<HTMLButtonElement>("button[aria-label='Close dialog']");
    // Still focusable and named while busy, but a press does nothing.
    expect(close?.getAttribute("aria-disabled")).toBe("true");
    await click(close);
    expect(busyClosed).toBe(0);
  });
});

describe("WebSearchFormModal", () => {
  it("shows errors only once a save is tried, drops a hidden key on a kind that takes none, and keeps a typed name", async () => {
    const saved: WebSearchFormValues[] = [];
    const view = await mount(
      <WebSearchFormModal taken={[]} onClose={() => undefined} onSave={(values) => Promise.resolve(void saved.push(values))} />,
    );
    // Brave needs a key: nothing said until Save.
    await click(view.querySelector('input[value="brave"]'));
    expect(byLabel(view, "Name").value).toBe("brave");
    expect(view.querySelector(".failure")).toBeNull();
    await click(button(view, "Save"));
    expect(view.textContent).toContain("Brave Search needs an API key");
    expect(saved).toEqual([]);

    await type(byLabel(view, "Brave Search API key"), "bsk-hidden");
    await type(byLabel(view, "Name"), "mine");
    // SearXNG takes no key: the one typed for Brave is dropped, the typed name kept.
    await click(view.querySelector('input[value="searxng"]'));
    expect(byLabel(view, "Name").value).toBe("mine");
    await type(byLabel(view, "Instance address"), "http://127.0.0.1:8888");
    await click(button(view, "Save"));
    expect(saved).toEqual([{ kind: "searxng", providerId: "mine", baseUrl: "http://127.0.0.1:8888", apiKey: "" }]);
  });

  it("names a default after the kind, and says a taken name is taken", async () => {
    const view = await mount(
      <WebSearchFormModal taken={["tavily", "serper"]} onClose={() => undefined} onSave={() => Promise.resolve(undefined)} />,
    );
    expect(byLabel(view, "Name").value).toBe("tavily-2");
    await click(view.querySelector('input[value="serper"]'));
    expect(byLabel(view, "Name").value).toBe("serper-2");
    await type(byLabel(view, "Name"), "serper");
    await click(button(view, "Save"));
    expect(view.textContent).toContain("A provider of this name exists");
  });
});

describe("CredentialsSettings", () => {
  it("says whether the store is encrypted and where its key is, and how to encrypt it when it is not", async () => {
    const answering = (encryption: Record<string, unknown> | undefined): SettingsClient => ({
      request: () =>
        Promise.resolve({ ok: true, result: { credentials: [], unusable: [], ...(encryption === undefined ? {} : { encryption }) } }),
    });
    const keychain = await mount(
      <InWorkspace client={answering({ kept: "keychain", keychain: "the macOS Keychain" })}>
        <CredentialsSettings />
      </InWorkspace>,
    );
    expect(keychain.querySelector(".credential-encryption")?.textContent).toBe("Encrypted; key in the macOS Keychain");
    unmountAll();
    const file = await mount(
      <InWorkspace client={answering({ kept: "file" })}>
        <CredentialsSettings />
      </InWorkspace>,
    );
    expect(file.querySelector(".credential-encryption")?.textContent).toBe("Encrypted; key in credentials.key in the data directory");
    unmountAll();
    const plain = await mount(
      <InWorkspace client={answering({ kept: "none" })}>
        <CredentialsSettings />
      </InWorkspace>,
    );
    expect(plain.querySelector(".credential-encryption")?.textContent).toBe("Not encrypted: run tavi credentials encrypt");
    expect(plain.querySelector(".credential-encryption code.command")?.textContent).toBe("tavi credentials encrypt");
    unmountAll();
    // An owner that does not say: no line, rather than a guess.
    const older = await mount(
      <InWorkspace client={answering(undefined)}>
        <CredentialsSettings />
      </InWorkspace>,
    );
    expect(older.querySelector(".credential-encryption")).toBeNull();
  });

  it("never prefills a value, keeps a replaced reference read-only, and asks before deleting", async () => {
    const sent: { command: string; payload: Record<string, unknown> }[] = [];
    const client: SettingsClient = {
      request: (command, payload) => {
        sent.push({ command, payload: payload as Record<string, unknown> });
        const action = (payload as { action: string }).action;
        const answer: ClientResponse =
          action === "list" ? { ok: true, result: { credentials: ["openai.apiKey"], unusable: [] } } : { ok: true, result: {} };
        return Promise.resolve(answer);
      },
    };
    const view = await mount(
      <InWorkspace client={client}>
        <CredentialsSettings />
      </InWorkspace>,
    );
    expect(view.textContent).toContain("openai.apiKey");

    await click(view.querySelector('[aria-label="Replace openai.apiKey"]'));
    const reference = byLabel(view, "Reference");
    expect(reference.readOnly).toBe(true);
    expect(reference.value).toBe("openai.apiKey");
    const value = byLabel(view, "Value");
    expect(value.value).toBe("");
    expect(value.className).toBe("secret");
    await type(value, " sk-new ");
    await click(button(view, "Store"));
    expect(sent.find((request) => request.payload["action"] === "set")?.payload).toEqual({
      action: "set",
      reference: "openai.apiKey",
      value: "sk-new",
    });
    expect(view.textContent).toContain("openai.apiKey stored.");

    // Delete: nothing is sent until it is confirmed.
    await click(view.querySelector('[aria-label="Delete openai.apiKey"]'));
    expect(sent.some((request) => request.payload["action"] === "delete")).toBe(false);
    expect(view.textContent).toContain("stops working until it is set again");
    await click([...view.querySelectorAll("dialog button")].find((candidate) => candidate.textContent === "Delete"));
    expect(sent.find((request) => request.payload["action"] === "delete")?.payload).toEqual({
      action: "delete",
      reference: "openai.apiKey",
    });
    expect(view.textContent).toContain("openai.apiKey deleted.");
  });

  it("says a new reference that is stored already would be replaced", async () => {
    const client: SettingsClient = {
      request: () => Promise.resolve({ ok: true, result: { credentials: ["openai.apiKey"], unusable: [] } }),
    };
    const view = await mount(
      <InWorkspace client={client}>
        <CredentialsSettings />
      </InWorkspace>,
    );
    await click(button(view, "Set a credential"));
    await type(byLabel(view, "Reference"), "openai.apiKey");
    expect(view.textContent).toContain("openai.apiKey is stored: this replaces its value.");
  });
});

it("offers Remove only for an operator allow rule, since a page may not remove a deny or ask rule", async () => {
  const rule = (ruleId: string, decision: "allow" | "deny" | "ask", source: "operator" | "shipped" = "operator") => ({
    ruleId,
    workspaceId: "default",
    toolPattern: "shell.exec",
    argMatcher: `cmd-${ruleId}`,
    decision,
    source,
    createdBy: "me",
    createdVia: "cli",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const client: SettingsClient = {
    request: (_command, payload) =>
      Promise.resolve({
        ok: true,
        result:
          (payload as { action: string }).action === "rules"
            ? { rules: [rule("a1", "allow"), rule("d1", "deny"), rule("q1", "ask"), rule("s1", "allow", "shipped")] }
            : { grants: [] },
      }),
  };
  const page = await mount(
    <InWorkspace client={client} workspaceId="default">
      <PermissionsSettings />
    </InWorkspace>,
  );
  const rows = [...page.querySelectorAll("li.row")];
  const removable = rows
    .filter((row) => [...row.querySelectorAll("button")].some((candidate) => candidate.textContent === "Remove"))
    .map((row) => row.querySelector("code:nth-of-type(2)")?.textContent);
  expect(removable).toEqual(["cmd-a1"]);
  expect(page.textContent).toContain("tavi permissions rm");
});

it("marks what a rule's matcher would hide", async () => {
  const hidden = `ls ${String.fromCodePoint(0x202e)}gpj.exe`;
  const client: SettingsClient = {
    request: (_command, payload) =>
      Promise.resolve({
        ok: true,
        result:
          (payload as { action: string }).action === "rules"
            ? {
                rules: [
                  {
                    ruleId: "r1",
                    workspaceId: "default",
                    toolPattern: "sandbox.run",
                    argMatcher: hidden,
                    decision: "allow",
                    source: "operator",
                    createdBy: "me",
                    createdVia: "cli",
                    createdAt: "2026-01-01T00:00:00Z",
                  },
                ],
              }
            : { grants: [] },
      }),
  };
  const page = await mount(
    <InWorkspace client={client} workspaceId="default">
      <PermissionsSettings />
    </InWorkspace>,
  );
  expect(page.textContent).toContain("ls ⟨U+202E⟩gpj.exe");
  expect(page.textContent?.includes(String.fromCodePoint(0x202e))).toBe(false);
});

it("says which tasks an origin-scoped rule covers: an ipc rule covers the terminal and the web", async () => {
  const rule = (ruleId: string, origin?: "ipc" | "web" | "messaging") => ({
    ruleId,
    workspaceId: "default",
    toolPattern: "sandbox.run",
    decision: "deny",
    source: "operator",
    createdBy: "me",
    createdVia: "cli",
    createdAt: "2026-01-01T00:00:00Z",
    ...(origin === undefined ? {} : { origin }),
  });
  const client: SettingsClient = {
    request: (_command, payload) =>
      Promise.resolve({
        ok: true,
        result:
          (payload as { action: string }).action === "rules"
            ? { rules: [rule("i1", "ipc"), rule("w1", "web"), rule("m1", "messaging"), rule("a1")] }
            : { grants: [] },
      }),
  };
  const page = await mount(
    <InWorkspace client={client} workspaceId="default">
      <PermissionsSettings />
    </InWorkspace>,
  );
  const origins = [...page.querySelectorAll("li.row")].map((row) => row.querySelector(".rule-origin")?.textContent ?? null);
  expect(origins).toEqual([
    // With no note before it, the scope is the line's start, not a clause after nothing.
    "Only tasks started in a terminal or on the web",
    "Only tasks started on the web",
    "Only tasks started from a chat",
    null,
  ]);
});

it("marks a rule an app's page set as holding in every workspace", async () => {
  const rule = (ruleId: string, workspaceId: string) => ({
    ruleId,
    workspaceId,
    toolPattern: "mcp.gcal.create_event",
    decision: "deny",
    source: "operator",
    createdBy: "operator:ui",
    createdVia: "bridge",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const client: SettingsClient = {
    request: (_command, payload) =>
      Promise.resolve({
        ok: true,
        result:
          (payload as { action: string }).action === "rules"
            ? { rules: [rule("apps-page-x", "*"), rule("r1", "default")] }
            : { grants: [] },
      }),
  };
  const page = await mount(
    <InWorkspace client={client} workspaceId="default">
      <PermissionsSettings />
    </InWorkspace>,
  );
  const rows = [...page.querySelectorAll("li.row")].map((row) => row.textContent?.includes("All workspaces") === true);
  expect(rows).toEqual([true, false]);
});

it("tags a rule's source only where its list does not say it, and starts its note as a sentence", async () => {
  const rule = (ruleId: string, source: "operator" | "shipped" | "flag", note: string) => ({
    ruleId,
    workspaceId: "*",
    toolPattern: "sandbox.run",
    decision: "allow",
    source,
    note,
    createdBy: "me",
    createdVia: "cli",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const client: SettingsClient = {
    request: (_command, payload) =>
      Promise.resolve({
        ok: true,
        result:
          (payload as { action: string }).action === "rules"
            ? { rules: [rule("o1", "operator", "approved always"), rule("f1", "flag", "from a flag"), rule("s1", "shipped", "reads only")] }
            : { grants: [] },
      }),
  };
  const page = await mount(
    <InWorkspace client={client} workspaceId="default">
      <PermissionsSettings />
    </InWorkspace>,
  );
  const rows = [...page.querySelectorAll("li.row")].map((row) => ({
    tags: [...row.querySelectorAll(".badge:not(.badge-ok)")].map((badge) => badge.textContent),
    note: row.querySelector(".muted")?.textContent,
  }));
  expect(rows).toEqual([
    { tags: ["All workspaces"], note: "Approved always" },
    { tags: ["All workspaces", "serve --allow"], note: "From a flag" },
    // Under "Shipped with Tavi", which holds everywhere: neither is said again.
    { tags: [], note: "Reads only" },
  ]);
  expect(page.textContent).not.toContain("yours");
});

it("leads a grant's row with the site it reaches, then its tools", async () => {
  const grant = (grantId: string, toolId: string) => ({
    grantId,
    taskId: "task-1",
    workspaceId: "default",
    toolId,
    argMatcher: "the-internet.herokuapp.com",
    approvalId: "a1",
    createdBy: "me",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const client: SettingsClient = {
    request: (_command, payload) =>
      Promise.resolve({
        ok: true,
        result:
          (payload as { action: string }).action === "rules"
            ? { rules: [] }
            : { grants: [grant("g1", "browser.act"), grant("g2", "browser.navigate")] },
      }),
  };
  const page = await mount(
    <InWorkspace client={client} workspaceId="default">
      <PermissionsSettings />
    </InWorkspace>,
  );
  const line = page.querySelector("li.row .rule-info > span");
  expect(line?.textContent).toBe("the-internet.herokuapp.com — browser.act, browser.navigate");
  // A site stays whole rather than breaking at its hyphen.
  expect(line?.querySelector("code")?.className).toBe("file-name");
});

it("shows one decision's session grants as one row with one Revoke", async () => {
  const grant = (grantId: string, toolId: string, approvalId: string) => ({
    grantId,
    taskId: "task-1",
    workspaceId: "default",
    toolId,
    approvalId,
    createdBy: "me",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const sent: unknown[] = [];
  const client: SettingsClient = {
    request: (_command, payload) => {
      sent.push(payload);
      const action = (payload as { action: string }).action;
      return Promise.resolve({
        ok: true,
        result:
          action === "rules"
            ? { rules: [] }
            : action === "grants"
              ? {
                  grants: [
                    grant("g1", "browser.create_session", "a1"),
                    grant("g2", "browser.navigate", "a1"),
                    grant("g3", "sandbox.run", "a2"),
                  ],
                }
              : { revoked: true },
      });
    },
  };
  const page = await mount(
    <InWorkspace client={client} workspaceId="default">
      <PermissionsSettings />
    </InWorkspace>,
  );
  const rows = [...page.querySelectorAll("li.row")];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("browser.create_session, browser.navigate");
  await click(rows[0]?.querySelector("button"));
  expect(sent).toContainEqual(expect.objectContaining({ action: "revoke", grantId: "g1" }));
});

it("names a grant's chat by its title, as a link to the chat, with its id beside it", async () => {
  const grant = (taskId: string, taskTitle?: string) => ({
    grantId: `g-${taskId}`,
    taskId,
    ...(taskTitle === undefined ? {} : { taskTitle }),
    workspaceId: "default",
    toolId: "fs.write",
    approvalId: `a-${taskId}`,
    createdBy: "operator",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const client: SettingsClient = {
    request: (_command, payload) => {
      const action = (payload as { action: string }).action;
      return Promise.resolve({
        ok: true,
        result: action === "rules" ? { rules: [] } : { grants: [grant("task-1", "Shopping notes"), grant("task-2")] },
      });
    },
  };
  const page = await mount(
    <InWorkspace client={client} workspaceId="default">
      <PermissionsSettings />
    </InWorkspace>,
  );
  const rows = [...page.querySelectorAll("li.row")];
  const link = rows[0]?.querySelector("a");
  expect(link?.textContent).toBe("Shopping notes");
  expect(link?.getAttribute("href")).toContain("task-1");
  expect(rows[0]?.textContent).toContain("in Shopping notes (task-1), by operator");
  // A chat with no title yet is named by its id, still as a link.
  expect(rows[1]?.querySelector("a")?.textContent).toBe("task-2");
  expect(rows[1]?.textContent).toContain("in task-2, by operator");
});

it("shows security.taint on the Permissions page, offers only a stricter mode, and names an owner's --taint-policy", async () => {
  const sent: { command: string; payload: unknown }[] = [];
  let stored: "off" | "observe" | "enforce" | undefined;
  const answer = () => ({
    workspaceId: "default",
    revision: stored === undefined ? 0 : 1,
    settings: stored === undefined ? {} : { securityTaint: stored },
    effective: { timezone: "UTC", securityTaint: "enforce" },
    hostTimezone: "UTC",
    taintPolicy: "enforce",
  });
  const client: SettingsClient = {
    request: (command, payload) => {
      sent.push({ command, payload });
      const action = (payload as { action: string }).action;
      if (command === "workspace-settings") {
        if (action === "set") stored = (payload as { value: "enforce" }).value;
        return Promise.resolve({ ok: true, result: answer() });
      }
      return Promise.resolve({ ok: true, result: action === "rules" ? { rules: [] } : { grants: [] } });
    },
  };
  const page = await mount(
    <InWorkspace client={client} workspaceId="default">
      <PermissionsSettings />
    </InWorkspace>,
  );
  expect(page.textContent).toContain("Untrusted content");
  expect(page.textContent).toContain("serve --taint-policy enforce");
  const select = page.querySelector('[aria-label="taint mode"]');
  // Unset is the shipped default, enforce: nothing lower is offered from a page.
  expect(selected(select)).toBe("enforce");
  await open(select);
  expect(offered()).toEqual([
    ["off", true],
    ["observe", true],
    ["enforce", false],
  ]);
  await close();
  page.remove();

  // An explicit observe: a page can only raise it, so off is offered disabled.
  stored = "observe";
  const raised = await mount(
    <InWorkspace client={client} workspaceId="default">
      <PermissionsSettings />
    </InWorkspace>,
  );
  const raise = raised.querySelector('[aria-label="taint mode"]');
  expect(selected(raise)).toBe("observe");
  await open(raise);
  expect(offered()).toEqual([
    ["off", true],
    ["observe", false],
    ["enforce", false],
  ]);
  await close();
  await pick(raise, "enforce");
  expect(sent).toContainEqual({
    command: "workspace-settings",
    payload: { action: "set", workspaceId: "default", key: "securityTaint", value: "enforce", expectedRevision: 1 },
  });
});
