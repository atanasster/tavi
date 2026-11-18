// @vitest-environment jsdom
import { initialRunState } from "@tavi/client/browser";
import type { MemoryItem } from "@tavi/contracts";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { Instructions } from "../../../src/features/chat-panel/Instructions.js";
import { Memory, usedWhen } from "../../../src/features/chat-panel/Memory.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import type { Session } from "../../../src/features/shell/shell.js";
import { InWorkspace } from "../../support/workspace.js";
import { button, flush, mountSettled as mount, rerender, settledBy, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { settle, click } = settledBy(() => flush(4, 0));
const type = async (element: Element | null, value: string): Promise<void> => {
  const field = element as HTMLTextAreaElement | HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const at = "2026-10-01T10:00:00.000Z";
const session: Session = {
  key: "t1",
  taskId: "t1",
  title: "t",
  status: "completed",
  runs: [{ id: "ui-1", prompt: "p", run: { ...initialRunState(), taskId: "t1" }, roundCalls: {}, deciding: undefined, aborting: false }],
};
const preview = {
  workspaceId: "default",
  layers: [{ kind: "base", source: "shipped", label: "Shipped default", length: 4, generated: false, active: true }],
  shippedLength: 4,
  overridden: false,
  baseText: "Base",
  budget: { fixedTokens: 1200, maxTokens: 8000 },
};
const revision = (n: number, text: string) => ({ taskId: "t1", revision: n, text, author: "operator:ui", recordedAt: at });

/** An owner holding one chat's instructions, answering every chat panel read and write. */
function owner(options: { readonly conflictOnce?: boolean; readonly delegatedFrom?: string } = {}) {
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  let revisions = [revision(1, "Be brief.")];
  let conflict = options.conflictOnce === true;
  const client: SettingsClient = {
    request: async (command, payload) => {
      const input = payload as Record<string, unknown>;
      sent.push({ command, payload: input });
      const current = revisions.at(-1);
      const state = () => ({
        taskId: "t1",
        revision: revisions.at(-1)?.revision ?? 0,
        current: revisions.at(-1) ?? null,
        ...(options.delegatedFrom === undefined ? {} : { delegatedFrom: options.delegatedFrom }),
      });
      if (command === "chat-context") {
        if (input["action"] === "get") return { ok: true, result: state() };
        if (input["action"] === "history") return { ok: true, result: { taskId: "t1", revisions: [...revisions].reverse() } };
        if (conflict) {
          conflict = false;
          return { ok: false, error: { code: "CONFLICT", message: "changed" } };
        }
        revisions = [...revisions, revision((current?.revision ?? 0) + 1, input["action"] === "reset" ? "" : String(input["text"]))];
        return { ok: true, result: state() };
      }
      if (command === "system-prompt") return { ok: true, result: preview };
      return { ok: false, error: { code: "UNAVAILABLE", message: `${command} unavailable` } };
    },
  };
  /** A save made elsewhere: another tab, or the CLI. */
  const elsewhere = (text: string) => {
    revisions = [...revisions, revision((revisions.at(-1)?.revision ?? 0) + 1, text)];
  };
  return { client, sent, elsewhere };
}

describe("the chat panel's instructions editor", () => {
  it("saves a new revision against the one it read, and says it applies from the next message", async () => {
    const { client, sent } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Instructions session={session} editable onSettings={() => undefined} />
      </InWorkspace>,
    );
    const field = page.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement;
    expect(field.value).toBe("Be brief.");
    expect(page.textContent).toContain("revision 1");
    await type(field, "Be thorough.");
    expect(page.textContent).toContain("Applies from your next message");
    await click(button(page, "Save"));
    expect(sent.find((entry) => entry.payload["action"] === "set")?.payload).toMatchObject({
      taskId: "t1",
      text: "Be thorough.",
      expectedRevision: 1,
    });
    expect(page.textContent).toContain("revision 2");
    expect((page.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement).value).toBe("Be thorough.");
    await click(button(page, "Clear"));
    expect(sent.find((entry) => entry.payload["action"] === "reset")?.payload).toMatchObject({ expectedRevision: 2 });
  });

  it("reads the instructions again when the chat changes: an untouched editor follows a save made elsewhere, a draft is kept", async () => {
    const { client, elsewhere } = owner();
    const view = (version: string) => (
      <InWorkspace client={client} workspaceId="default">
        <Instructions session={session} editable version={version} onSettings={() => undefined} />
      </InWorkspace>
    );
    const page = await mount(view("a"));
    const field = () => page.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement;
    elsewhere("Answer in French.");
    await rerender(view("b"));
    await settle();
    expect(field().value).toBe("Answer in French.");
    expect(page.textContent).toContain("revision 2");
    await type(field(), "My draft");
    elsewhere("Answer in German.");
    await rerender(view("c"));
    await settle();
    expect(field().value).toBe("My draft");
    expect(page.textContent).toContain("revision 3");
  });

  it("measures the fixed prompt against the budget, warns near it, and reads the preview again after a save", async () => {
    const { client, sent } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Instructions session={session} editable onSettings={() => undefined} />
      </InWorkspace>,
    );
    expect(page.querySelector(".chat-panel-budget")?.textContent).toBe("About 1,200 of 8,000 tokens before memory and skills.");
    expect(page.querySelector(".chat-panel-budget.warn")).toBeNull();
    const previews = () => sent.filter((entry) => entry.command === "system-prompt").length;
    const before = previews();
    await type(page.querySelector(".chat-panel-editor textarea"), "Longer instructions");
    await click(button(page, "Save"));
    expect(previews()).toBe(before + 1);
    unmountAll();
    const near: SettingsClient = {
      request: async (command, payload) =>
        command === "system-prompt"
          ? { ok: true, result: { ...preview, budget: { fixedTokens: 6000, maxTokens: 8000 } } }
          : client.request(command, payload),
    };
    const warned = await mount(
      <InWorkspace client={near} workspaceId="default">
        <Instructions session={session} editable onSettings={() => undefined} />
      </InWorkspace>,
    );
    expect(warned.querySelector(".chat-panel-budget.warn")?.textContent).toContain("Close to the budget");
    unmountAll();
    const over: SettingsClient = {
      request: async (command, payload) =>
        command === "system-prompt"
          ? { ok: true, result: { ...preview, budget: { fixedTokens: 9000, maxTokens: 8000 } } }
          : client.request(command, payload),
    };
    const refused = await mount(
      <InWorkspace client={over} workspaceId="default">
        <Instructions session={session} editable onSettings={() => undefined} />
      </InWorkspace>,
    );
    expect(refused.querySelector('.chat-panel-budget[role="alert"]')?.textContent).toContain("calls will be refused");
  });

  it("keeps the draft through a conflict, and takes an earlier revision back from the history", async () => {
    const { client } = owner({ conflictOnce: true });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Instructions session={session} editable onSettings={() => undefined} />
      </InWorkspace>,
    );
    await type(page.querySelector(".chat-panel-editor textarea"), "Mine");
    await click(button(page, "Save"));
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
    expect((page.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement).value).toBe("Mine");
    await click(button(page, "Reload saved"));
    expect((page.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement).value).toBe("Be brief.");
    const history = page.querySelector(".chat-panel-editor details") as HTMLDetailsElement;
    await act(async () => {
      history.open = true;
      history.dispatchEvent(new Event("toggle"));
    });
    await settle();
    await click(button(page, "Use this"));
    expect((page.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement).value).toBe("Be brief.");
  });

  it("will not save text over the bound, says a refusal that is not a conflict, and clears an unsaved draft without a revision", async () => {
    const { client, sent } = owner();
    const refusing: SettingsClient = {
      request: async (command, payload) =>
        (payload as { action?: string }).action === "set"
          ? { ok: false, error: { code: "INVALID_INPUT", message: "too long for the owner" } }
          : client.request(command, payload),
    };
    const page = await mount(
      <InWorkspace client={refusing} workspaceId="default">
        <Instructions session={session} editable onSettings={() => undefined} />
      </InWorkspace>,
    );
    const field = page.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement;
    await type(field, "x".repeat(8_001));
    expect(button(page, "Save")?.disabled).toBe(true);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    await type(field, "Short");
    await click(button(page, "Save"));
    expect(page.querySelector('[role="alert"]')?.textContent).toBe("too long for the owner");
    unmountAll();
    // A chat that never saved instructions: Clear empties the draft and writes nothing.
    const empty: SettingsClient = {
      request: async (command, payload) =>
        (payload as { action?: string }).action === "get"
          ? { ok: true, result: { taskId: "t1", revision: 0, current: null } }
          : client.request(command, payload),
    };
    const fresh = await mount(
      <InWorkspace client={empty} workspaceId="default">
        <Instructions session={session} editable onSettings={() => undefined} />
      </InWorkspace>,
    );
    // With nothing saved there is nothing to clear: only Save and, once edited, Discard.
    const names = () => [...fresh.querySelectorAll(".actions button")].map((each) => each.textContent);
    expect(names()).toEqual(["Save"]);
    await type(fresh.querySelector(".chat-panel-editor textarea"), "Draft");
    expect(names()).toEqual(["Save", "Discard"]);
    await click(button(fresh, "Discard"));
    expect((fresh.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement).value).toBe("");
    expect(sent.some((entry) => entry.payload["action"] === "reset")).toBe(false);
  });

  it("saves twice in a row against its own acknowledgement, not the read before it", async () => {
    const { client, sent } = owner();
    // Every read after the first never answers: the editor must not need it.
    let reads = 0;
    const slow: SettingsClient = {
      request: (command, payload) =>
        (payload as { action?: string }).action === "get" && (reads += 1) > 1
          ? new Promise<never>(() => undefined)
          : client.request(command, payload),
    };
    const page = await mount(
      <InWorkspace client={slow} workspaceId="default">
        <Instructions session={session} editable onSettings={() => undefined} />
      </InWorkspace>,
    );
    await type(page.querySelector(".chat-panel-editor textarea"), "One");
    await click(button(page, "Save"));
    await type(page.querySelector(".chat-panel-editor textarea"), "Two");
    await click(button(page, "Save"));
    expect(sent.filter((entry) => entry.payload["action"] === "set").map((entry) => entry.payload["expectedRevision"])).toEqual([1, 2]);
    expect(page.textContent).toContain("revision 3");
  });

  it("drafts a new chat's instructions for its first message, and sends an agent's task to its chat", async () => {
    const onDraft = vi.fn();
    const { client } = owner();
    const draft = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Instructions session={undefined} editable draft="Hi" onDraft={onDraft} onSettings={() => undefined} />
      </InWorkspace>,
    );
    expect(draft.textContent).toContain("Sent with your first message");
    await type(draft.querySelector(".chat-panel-editor textarea"), "Answer in French.");
    expect(onDraft).toHaveBeenLastCalledWith("Answer in French.");
    unmountAll();
    const onOpenTask = vi.fn();
    const agent = await mount(
      <InWorkspace client={owner({ delegatedFrom: "chat-1" }).client} workspaceId="default">
        <Instructions session={session} editable onSettings={() => undefined} onOpenTask={onOpenTask} />
      </InWorkspace>,
    );
    expect(agent.querySelector(".chat-panel-editor textarea")).toBeNull();
    await click(button(agent, "Open the chat it works for →"));
    expect(onOpenTask).toHaveBeenCalledWith("chat-1");
  });
});

const item = (recordId: string, target: string, body: string, status: "approved" | "proposed" = "approved"): MemoryItem => ({
  recordId,
  kind: "fact",
  scope: target.startsWith("chat:")
    ? { kind: "run_local", principalId: "operator", workspaceId: "default", runId: target.slice(5) }
    : { kind: "personal", principalId: "operator" },
  scopeKey: "k",
  ...(status === "approved" ? { currentRevisionId: `${recordId}-rev` } : {}),
  status,
  sensitivity: "normal",
  revocationGeneration: 0,
  recordedAt: at,
  updatedAt: at,
  target,
  title: null,
  body,
  redacted: false,
  truncated: false,
  sourceCount: 0,
  ...(target.startsWith("chat:") ? { durable: true as const } : {}),
  originTaskId: "t1",
});

describe("the chat panel's memory, editable", () => {
  function memoryOwner(delegatedFrom?: string, notYours = false) {
    const sent: Record<string, unknown>[] = [];
    const client: SettingsClient = {
      request: async (command, payload) => {
        const input = payload as Record<string, unknown>;
        sent.push({ command, ...input });
        if (command === "chat-context" && input["action"] === "compact")
          return { ok: true, result: { taskId: input["taskId"], freshContext: "next-message" } };
        if (command === "chat-context" && input["action"] === "forget") {
          if (notYours)
            return {
              ok: true,
              result: {
                taskId: input["taskId"],
                forgotten: 3,
                before: input["before"],
                checkpointsPruned: 0,
                related: [],
                archives: 0,
                memoryNotYours: true,
              },
            };
          return {
            ok: true,
            result: {
              taskId: input["taskId"],
              forgotten: 3,
              before: input["before"],
              checkpointsPruned: 0,
              related: [],
              archives: 2,
              proposals: 1,
              ...(input["withMemory"] === true ? { memories: 2 } : { memoriesKept: 2 }),
            },
          };
        }
        if (command === "chat-context")
          return {
            ok: true,
            result: { taskId: "t1", revision: 0, current: null, ...(delegatedFrom === undefined ? {} : { delegatedFrom }) },
          };
        if (command === "memory" && input["action"] === "list") {
          const records = Array.isArray(input["scopes"])
            ? [item("n1", "chat:chat-x", "The client is Acme"), item("n2", "chat:chat-x", "Proposed note", "proposed")]
            : input["originTaskId"] !== undefined
              ? [item("n1", "chat:chat-x", "The client is Acme"), item("l1", "personal", "Prefers metric")]
              : input["usedInTaskId"] !== undefined
                ? [
                    { ...item("u1", "personal", "Recalled fact"), usedAt: "2026-09-30T10:00:00.000Z" },
                    item("n1", "chat:chat-x", "The client is Acme"),
                  ]
                : [item("g1", "personal", "Global one")];
          return { ok: true, result: { records, otherPeople: [] } };
        }
        if (command === "memory") return { ok: true, result: item("new", "personal", "x") };
        return { ok: false, error: { code: "UNAVAILABLE", message: "no" } };
      },
    };
    return { client, sent };
  }
  const chatSession = { ...session, taskId: "chat-x", key: "chat-x" };

  it("reads the chat's and the workspace's memory again when the chat or the memory changes", async () => {
    const { client, sent } = memoryOwner();
    const view = (version: string) => (
      <InWorkspace client={client} workspaceId="default">
        <Memory session={chatSession} editable version={version} />
      </InWorkspace>
    );
    await mount(view("a"));
    const lists = () => sent.filter((entry) => entry["command"] === "memory" && entry["action"] === "list").length;
    const before = lists();
    await rerender(view("a"));
    await settle();
    expect(lists()).toBe(before);
    await rerender(view("b"));
    await settle();
    // The chat's notes, what it taught, what it used, and the inherited memory.
    expect(lists()).toBe(before * 2);
  });

  it("lists the chat's notes and what it taught, and moves, decides, forgets and adds", async () => {
    const { client, sent } = memoryOwner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Memory session={chatSession} editable />
      </InWorkspace>,
    );
    const notes = page.querySelector('[aria-label="this chat\'s notes"]') as HTMLElement;
    const learned = page.querySelector('[aria-label="learned in this chat"]') as HTMLElement;
    expect([...notes.querySelectorAll(".chat-panel-item-title")].map((node) => node.textContent)).toEqual([
      "The client is Acme",
      "Proposed note",
    ]);
    // A chat's notes name it as their origin too: "learned here" is the rest.
    expect([...learned.querySelectorAll(".chat-panel-item-title")].map((node) => node.textContent)).toEqual(["Prefers metric"]);
    const used = page.querySelector('[aria-label="used in this chat"]') as HTMLElement;
    // Memory used in this chat: which record, its scope, and when it was last given.
    expect([...used.querySelectorAll(".chat-panel-item-detail")].map((node) => node.textContent)).toEqual([
      `Fact · Personal · used ${usedWhen("2026-09-30T10:00:00.000Z", undefined)}`,
      "Fact · This chat",
    ]);
    expect([...used.querySelectorAll("li")].map((node) => node.getAttribute("data-record-id"))).toEqual(["u1", "n1"]);
    expect(sent.find((entry) => entry["usedInTaskId"] !== undefined)).toMatchObject({ usedInTaskId: "chat-x", statuses: ["approved"] });
    await click(button(notes, "Remember everywhere"));
    expect(sent.find((entry) => entry["action"] === "move")).toMatchObject({
      recordId: "n1",
      to: "personal",
      expectedRevisionId: "n1-rev",
    });
    await click(button(notes, "Keep"));
    expect(sent.find((entry) => entry["action"] === "approve")).toMatchObject({ recordId: "n2" });
    await click(button(learned, "Keep to this chat"));
    expect(sent.filter((entry) => entry["action"] === "move").at(-1)).toMatchObject({ recordId: "l1", to: "chat:chat-x" });
    await type(notes.querySelector("input"), "Ship on Friday");
    await act(async () => (notes.querySelector("form") as HTMLFormElement).requestSubmit());
    await settle();
    expect(sent.find((entry) => entry["action"] === "remember")).toMatchObject({
      scope: "chat:chat-x",
      body: "Ship on Friday",
      kind: "fact",
    });
  });

  it("asks for fresh context for the chat, and says the next message starts a new epoch", async () => {
    const { client, sent } = memoryOwner();
    const view = (version: string) => (
      <InWorkspace client={client} workspaceId="default">
        <Memory session={chatSession} editable version={version} />
      </InWorkspace>
    );
    const page = await mount(view("ui-1:completed:0"));
    const context = page.querySelector('[aria-label="this chat\'s history"]') as HTMLElement;
    await click(button(context, "Fresh context"));
    expect(sent.find((entry) => entry["action"] === "compact")).toMatchObject({
      command: "chat-context",
      taskId: "chat-x",
      workspaceId: "default",
    });
    expect(context.textContent).toContain("Your next message starts a new epoch.");
    // Once that message starts a run, it is no longer true, and no longer said.
    await rerender(view("ui-1:completed:0|ui-2:running:0"));
    expect(page.querySelector('[aria-label="this chat\'s history"]')?.textContent).not.toContain("Your next message starts a new epoch.");
    // An agent's task is no chat: it offers none.
    const agent = await mount(
      <InWorkspace client={memoryOwner("chat-x").client} workspaceId="default">
        <Memory session={session} editable />
      </InWorkspace>,
    );
    expect(agent.querySelector('[aria-label="this chat\'s history"]')).toBeNull();
  });

  it("forgets the chat's history, offering the memories it taught as a labelled box, and says what went", async () => {
    const { client, sent } = memoryOwner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Memory session={chatSession} editable />
      </InWorkspace>,
    );
    const history = page.querySelector('[aria-label="this chat\'s history"]') as HTMLElement;
    await click(button(history, "Forget history…"));
    const box = history.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(page.querySelector(`label[for="${box.id}"]`)?.textContent).toContain("Also forget the 2 memories this chat taught");
    expect(box.checked).toBe(false);
    await click(box);
    await click(button(history, "Forget history"));
    expect(sent.find((entry) => entry["action"] === "forget")).toMatchObject({
      command: "chat-context",
      taskId: "chat-x",
      workspaceId: "default",
      withMemory: true,
    });
    expect(history.textContent).toContain("Forgotten: 3 saved turns, 2 archives, 1 waiting proposal, 2 memories.");
    // Without the box, the memories it taught stay: nothing asks for them.
    await click(button(history, "Forget history…"));
    await click(button(history, "Forget history"));
    expect(sent.filter((entry) => entry["action"] === "forget").at(-1)?.["withMemory"]).toBeUndefined();
  });

  it("says a bound person's chat kept their memory, even with the box ticked", async () => {
    const { client } = memoryOwner(undefined, true);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Memory session={chatSession} editable />
      </InWorkspace>,
    );
    const history = page.querySelector('[aria-label="this chat\'s history"]') as HTMLElement;
    await click(button(history, "Forget history…"));
    await click(history.querySelector('input[type="checkbox"]') as HTMLInputElement);
    await click(button(history, "Forget history"));
    expect(history.textContent).toContain(
      "Forgotten: 3 saved turns. Its memory belongs to the person the chat is with and was not touched.",
    );
  });

  it("says when a record was used, in the workspace zone: the time today, else the date", () => {
    const now = new Date("2026-10-04T15:00:00.000Z");
    expect(usedWhen("2026-10-04T09:30:00.000Z", "UTC", now)).toBe("today 09:30");
    expect(usedWhen("2026-09-30T09:30:00.000Z", "UTC", now)).toBe("30 Sep");
    // 03:30 UTC on the 4th is the evening of the 3rd in Los Angeles, where it is now the 4th.
    expect(usedWhen("2026-10-04T03:30:00.000Z", "America/Los_Angeles", now)).toBe("3 Oct");
    expect(usedWhen("2026-10-04T03:30:00.000Z", "UTC", now)).toBe("today 03:30");
    expect(usedWhen(undefined, "UTC", now)).toBeUndefined();
    expect(usedWhen("not a date", "UTC", now)).toBeUndefined();
  });

  it("shows an agent's task its chat's notes, read-only", async () => {
    const { client, sent } = memoryOwner("chat-x");
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Memory session={session} editable />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("reads the notes of the chat it works for");
    expect(sent.find((entry) => entry["action"] === "list" && Array.isArray(entry["scopes"]))).toMatchObject({ scopes: ["chat:chat-x"] });
    expect(button(page, "Forget")).toBeUndefined();
    expect(page.querySelector(".chat-panel-add")).toBeNull();
  });
});
