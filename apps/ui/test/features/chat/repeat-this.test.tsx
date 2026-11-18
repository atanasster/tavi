// @vitest-environment jsdom
import { initialRunState, type ToolCard } from "@tavi/client/browser";
import { labelSummary, type TranscriptMemoryUsed } from "@tavi/contracts";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { Schedule } from "../../../src/features/chat-panel/Schedule.js";
import { Canvas } from "../../../src/features/chat/Canvas.js";
import { MessageActions } from "../../../src/features/chat/MessageActions.js";
import { openingPrompt, repeatName, repeatPrompt, repeatTools, researchChat, toolsUsed } from "../../../src/features/chat/repeat.js";
import type { CanvasRun } from "../../../src/features/chat/store/types.js";
import type { Session } from "../../../src/features/shell/shell.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { button, click, clickSettled, mount, mountSettled, settle } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tool = (toolName: string, status: ToolCard["status"] = "completed"): ToolCard => ({
  kind: "tool",
  key: `key-${toolName}-${status}`,
  attemptId: "a1",
  callId: `call-${toolName}-${status}`,
  toolName,
  status,
});
const turn = (id: string, prompt: string, tools: readonly ToolCard[] = [], memoryUsed?: TranscriptMemoryUsed): CanvasRun => ({
  id,
  prompt,
  run: { ...initialRunState({ taskId: "task-1" }), status: "completed", transcript: [...tools] },
  roundCalls: {},
  deciding: undefined,
  aborting: false,
  ...(memoryUsed === undefined ? {} : { memoryUsed }),
});
/** What a saved turn says it used: `records` memory records, one of them named. */
const used = (records: number): TranscriptMemoryUsed => ({
  records: records === 0 ? [] : [{ recordId: "record-1", revisionId: "revision-1" }],
  preferences: 0,
  more: Math.max(0, records - 1),
});
const chat = (runs: readonly CanvasRun[]): Session => ({
  key: "task-1",
  taskId: "task-1",
  title: "t",
  status: "completed",
  runs: [...runs],
});

/** What the owner offers a schedule: scheduling writes, MCP writes and form fills are never among them. */
const LISTABLE = {
  tools: ["files.read", "reports.write", "web_fetch", "web_search"],
  families: ["files.*"],
  readOnly: ["files.read", "web_fetch", "web_search"],
};
const AT = "2026-10-13T10:00:00.000Z";
const TAINTED = labelSummary({
  integrity: "untrusted",
  sources: ["web"],
  principals: [],
  confidentiality: "public",
  refs: [{ source: "web", ref: "call-1", host: "news.example", at: AT }],
});

const REFUSED = { ok: false, error: { code: "UNAVAILABLE", message: "refused" } } as const;

/**
 * An owner that answers the forms' reads, records every other request, and
 * creates nothing unless asked to; `refuse` makes it refuse one of the reads.
 */
function owner(contextLabel: unknown = null, refuse?: "label" | "tools") {
  const sent: [string, Record<string, unknown>][] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      const input = payload as Record<string, unknown>;
      const action = input["action"];
      if (input["action"] === "preview") return { ok: true, result: { timezone: "UTC", text: "", runs: [] } };
      if (command === "schedules" && action === "tools") return refuse === "tools" ? REFUSED : { ok: true, result: LISTABLE };
      if (command === "tasks" && action === "label")
        return refuse === "label" ? REFUSED : { ok: true, result: { taskId: "task-1", contextLabel } };
      if (command === "tasks") return { ok: true, result: { task: { origin: "ipc", originScheduleId: null }, admissions: [] } };
      if (command === "routines" && action === "targets") return { ok: true, result: { targets: [] } };
      if (command === "agents") return { ok: true, result: { agents: [], truncated: false } };
      sent.push([command, input]);
      if (command === "schedules" && action === "add") return { ok: true, result: {} };
      if (command === "routines" && action === "create") return { ok: false, error: { code: "UNAVAILABLE", message: "not in this test" } };
      return { ok: false, error: { code: "UNAVAILABLE", message: `${command} is unavailable` } };
    },
  };
  return { client, sent };
}

const chips = (page: HTMLElement) =>
  [...page.querySelectorAll('[aria-label^="Remove tool "]')].map((node) => node.getAttribute("aria-label")?.slice("Remove tool ".length));
const promptField = (page: HTMLElement) => page.querySelector<HTMLTextAreaElement>('[aria-label="Schedule prompt"]');
const offeredTools = (page: HTMLElement) =>
  [...page.querySelectorAll('[aria-label^="Add tool "]')].map((node) => node.getAttribute("aria-label")?.slice("Add tool ".length));
const addTool = (page: HTMLElement, id: string) => clickSettled(page.querySelector(`[aria-label="Add tool ${id}"]`));
const objectiveField = (page: HTMLElement) => page.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Find the latest news"]');

describe("what Repeat this fills in from a chat", () => {
  it("takes the opening message and the finished tools, streamed or saved, each once", () => {
    const saved: CanvasRun = {
      ...turn("r0", ""),
      recordedPrompts: ["  Check the release notes  "],
      recordedHistory: {
        tools: [tool("web_search"), tool("mail.send", "failed")],
        partial: false,
      } as unknown as CanvasRun["recordedHistory"],
    };
    const runs = [saved, turn("r1", "then summarise", [tool("web_search"), tool("files.read"), tool("files.write", "running")])];
    expect(openingPrompt(runs)).toBe("Check the release notes");
    expect(toolsUsed(runs)).toEqual(["web_search", "files.read"]);
  });

  it("keeps only the tools the owner lets a schedule list: scheduling and MCP writes and form fills are left out", () => {
    const used = ["web_search", "schedules.add", "routines.create", "mcp.github.create_issue", "pdf.fill", "reports.write"];
    expect(repeatTools(used, LISTABLE, true)).toEqual({
      allowed: ["web_search"],
      offered: ["reports.write"],
      leftOut: ["schedules.add", "routines.create", "mcp.github.create_issue", "pdf.fill"],
    });
  });

  it("allows nothing ahead from a chat that may have read content Tavi does not trust, and offers what it used", () => {
    expect(repeatTools(["web_search", "reports.write", "pdf.fill"], LISTABLE, false)).toEqual({
      allowed: [],
      offered: ["web_search", "reports.write"],
      leftOut: ["pdf.fill"],
    });
  });

  it("keeps a prompt within the field's bound, never splitting a character", () => {
    expect(repeatPrompt("abc", 2)).toBe("ab");
    expect(repeatPrompt("a😀b", 2)).toBe("a");
    expect(repeatPrompt("a😀b", 3)).toBe("a😀");
  });

  it("reads a chat as research only when it used the web and nothing outside a read-only family", () => {
    expect(researchChat(["web_search", "web_fetch", "files.read"], LISTABLE)).toBe(true);
    expect(researchChat(["web_search", "reports.write"], LISTABLE)).toBe(false);
    expect(researchChat(["files.read"], LISTABLE)).toBe(false);
  });

  it("counts reading memory as research, and nothing else memory does", () => {
    expect(researchChat(["memory.search", "web_search", "memory.get"], LISTABLE)).toBe(true);
    expect(researchChat(["memory.search"], LISTABLE)).toBe(false);
    expect(researchChat(["web_search", "memory.propose"], LISTABLE)).toBe(false);
    expect(researchChat(["web_search", "memory.forget"], LISTABLE)).toBe(false);
  });

  it("names it by the prompt's first line, shortened", () => {
    expect(repeatName("\n  Morning   digest\nmore")).toBe("Morning digest");
    expect(repeatName("x".repeat(80))).toHaveLength(60);
  });
});

describe("Set up a schedule in the chat panel", () => {
  const panel = (client: SettingsClient, session: Session, repeat = true) => (
    <InWorkspace client={client} workspaceId="default" timeZone="UTC">
      <Schedule session={session} reminders={false} repeat={repeat} onOpenReminder={() => undefined} onOpenRoutine={() => undefined} />
    </InWorkspace>
  );

  it("is offered only where the owner offers schedules", async () => {
    const { client } = owner();
    const page = await mountSettled(panel(client, chat([turn("r1", "Summarise my inbox")]), false));
    expect(button(page, "Set up a schedule…")).toBeUndefined();
  });

  it("opens the schedule form with the opening prompt and the listable tools, and creates nothing until Save", async () => {
    const { client, sent } = owner();
    const session = chat([
      turn("r1", "Summarise the reports", [
        tool("files.read"),
        tool("reports.write"),
        tool("schedules.add"),
        tool("mcp.github.create_issue"),
      ]),
      turn("r2", "and again", [tool("pdf.fill")]),
    ]);
    const page = await mountSettled(panel(client, session));
    await clickSettled(button(page, "Set up a schedule…"));
    expect(page.querySelector("dialog")?.textContent).toContain("Create schedule");
    expect(promptField(page)?.value).toBe("Summarise the reports");
    expect(page.querySelector<HTMLInputElement>('[aria-label="Schedule name"]')?.value).toBe("Summarise the reports");
    // Only a read-only tool is allowed ahead; one that writes is offered, one click away.
    expect(chips(page)).toEqual(["files.read"]);
    expect(offeredTools(page)).toEqual(["reports.write"]);
    // Its result goes into Home by default, as a chat-made schedule's does.
    expect(page.querySelector('[aria-label="Deliver result to"]')?.textContent).toContain("Home");
    expect(page.textContent).not.toContain("can change or send things");
    expect(page.textContent).toContain(
      "Not allowed, since a schedule may not list them: schedules.add, mcp.github.create_issue, pdf.fill.",
    );
    expect(page.textContent).not.toContain("does not trust");
    expect(sent).toEqual([]);
    // Closed unsaved: still nothing created.
    await click(button(page, "Cancel"));
    expect(page.querySelector("dialog")).toBeNull();
    expect(sent).toEqual([]);
    await clickSettled(button(page, "Set up a schedule…"));
    await addTool(page, "reports.write");
    expect(chips(page)).toEqual(["files.read", "reports.write"]);
    expect(offeredTools(page)).toEqual([]);
    expect(page.textContent).toContain("reports.write can change or send things without asking.");
    await clickSettled(button(page, "Save schedule"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([
      "schedules",
      expect.objectContaining({
        action: "add",
        name: "Summarise the reports",
        prompt: "Summarise the reports",
        allow: ["files.read", "reports.write"],
        deliverTo: "home",
      }),
    ]);
    expect(page.querySelector('[aria-label="repeat on a schedule"]')?.textContent).toContain("Summarise the reports created.");
  });

  it("says the form is on its way while the chat is read, rather than showing nothing", async () => {
    const { client } = owner();
    let release: (() => void) | undefined;
    const slow: SettingsClient = {
      request: async (command, payload) => {
        if (command === "tasks" && (payload as Record<string, unknown>)["action"] === "label")
          await new Promise<void>((done) => {
            release = done;
          });
        return client.request(command, payload);
      },
    };
    const page = await mountSettled(panel(slow, chat([turn("r1", "Summarise my inbox")])));
    await clickSettled(button(page, "Set up a schedule…"));
    const dialog = () => page.querySelector("dialog");
    expect(dialog()?.textContent).toContain("Reading this chat…");
    expect(button(page, "Cancel")).toBeDefined();
    await act(async () => release?.());
    await settle();
    expect(dialog()?.textContent).toContain("Create schedule");
  });

  it("says so in the form when the chat read content Tavi does not trust", async () => {
    const { client } = owner(TAINTED);
    const page = await mountSettled(panel(client, chat([turn("r1", "Watch the news", [tool("reports.write")])])));
    await clickSettled(button(page, "Set up a schedule…"));
    const dialog = page.querySelector("dialog");
    expect(dialog?.textContent).toContain("This chat read content Tavi does not trust (news.example).");
    expect(dialog?.textContent).toContain("the schedule runs unattended with those tools");
  });

  it("allows no tool ahead from a chat that read content Tavi does not trust, even one it used, and names one that writes once added", async () => {
    const { client, sent } = owner(TAINTED);
    const page = await mountSettled(panel(client, chat([turn("r1", "Watch the news", [tool("web_search"), tool("reports.write")])])));
    await clickSettled(button(page, "Set up a schedule…"));
    expect(chips(page)).toEqual([]);
    expect(offeredTools(page)).toEqual(["web_search", "reports.write"]);
    await clickSettled(button(page, "Save schedule"));
    expect(sent[0]).toEqual(["schedules", expect.objectContaining({ action: "add", allow: [] })]);
    await clickSettled(button(page, "Set up a schedule…"));
    await addTool(page, "reports.write");
    expect(chips(page)).toEqual(["reports.write"]);
    expect(page.querySelector("dialog")?.textContent).toContain("reports.write can change or send things without asking.");
  });

  it("allows no tool ahead when it could not read what the chat read, and says so", async () => {
    const { client } = owner(null, "label");
    const page = await mountSettled(panel(client, chat([turn("r1", "Watch the news", [tool("files.read")])])));
    await clickSettled(button(page, "Set up a schedule…"));
    expect(page.querySelector("dialog")?.textContent).toContain("Tavi could not read whether this chat read content it does not trust.");
    expect(chips(page)).toEqual([]);
    expect(offeredTools(page)).toEqual(["files.read"]);
  });

  it("says it could not check the tools, rather than that they are not allowed, when the owner cannot list them", async () => {
    const { client } = owner(null, "tools");
    const page = await mountSettled(panel(client, chat([turn("r1", "Summarise the reports", [tool("reports.write")])])));
    await clickSettled(button(page, "Set up a schedule…"));
    const text = page.querySelector("dialog")?.textContent;
    expect(text).not.toContain("Not allowed");
    expect(text).toContain("Tavi could not check which tools a schedule may list; add them yourself.");
    expect(chips(page)).toEqual([]);
    expect(offeredTools(page)).toEqual([]);
  });

  it("offers a research chat as a routine with its objective, and as a schedule instead", async () => {
    const { client, sent } = owner();
    const page = await mountSettled(
      panel(client, chat([turn("r1", "Find this week's AI papers", [tool("web_search"), tool("web_fetch")])])),
    );
    await clickSettled(button(page, "Set up a schedule…"));
    expect(page.querySelector("dialog")?.textContent).toContain("Create routine");
    expect(objectiveField(page)?.value).toBe("Find this week's AI papers");
    await clickSettled(button(page, "Repeat it as a schedule instead"));
    expect(promptField(page)?.value).toBe("Find this week's AI papers");
    expect(chips(page)).toEqual(["web_search", "web_fetch"]);
    expect(sent).toEqual([]);
  });

  it("opens a chat that searched the web and read memory as a routine, and says the routine has no memory", async () => {
    const { client } = owner();
    const page = await mountSettled(
      panel(client, chat([turn("r1", "Check recalls on my car", [tool("memory.search"), tool("web_search")], used(1))])),
    );
    await clickSettled(button(page, "Set up a schedule…"));
    const dialog = page.querySelector("dialog");
    expect(dialog?.textContent).toContain("Create routine");
    expect(dialog?.textContent).toContain("A routine has no memory, and this chat read yours");
    await clickSettled(button(page, "Repeat it as a schedule instead"));
    expect(page.querySelector("dialog")?.textContent).toContain("A schedule has no memory, and this chat read yours");
  });

  it("says nothing of memory when its search found no record", async () => {
    const { client } = owner();
    const page = await mountSettled(
      panel(client, chat([turn("r1", "Check recalls on my car", [tool("memory.search"), tool("web_search")], used(0))])),
    );
    await clickSettled(button(page, "Set up a schedule…"));
    expect(page.querySelector("dialog")?.textContent).toContain("Create routine");
    expect(page.querySelector("dialog")?.textContent).not.toContain("memory");
  });

  it("counts every turn: one found nothing, a later one read a record past the named ones", async () => {
    const { client } = owner();
    const later: TranscriptMemoryUsed = { records: [], preferences: 0, more: 2 };
    const page = await mountSettled(
      panel(
        client,
        chat([
          turn("r1", "Check recalls on my car", [tool("memory.search"), tool("web_search")], used(0)),
          turn("r2", "And my van?", [tool("memory.get")], later),
        ]),
      ),
    );
    await clickSettled(button(page, "Set up a schedule…"));
    expect(page.querySelector("dialog")?.textContent).toContain("and this chat read yours");
  });

  it("a chat that only listed what is kept did read it", async () => {
    const { client } = owner();
    const listed: TranscriptMemoryUsed = { records: [], preferences: 0, more: 0, listed: { records: [], more: 3 } };
    const page = await mountSettled(
      panel(client, chat([turn("r1", "Check recalls on my car", [tool("memory.list"), tool("web_search")], listed)])),
    );
    await clickSettled(button(page, "Set up a schedule…"));
    expect(page.querySelector("dialog")?.textContent).toContain("and this chat read yours");
  });

  it("claims no read it cannot know: a memory search on a turn with nothing recorded of what it used", async () => {
    const { client } = owner();
    const page = await mountSettled(
      panel(client, chat([turn("r1", "Check recalls on my car", [tool("memory.search"), tool("web_search")])])),
    );
    await clickSettled(button(page, "Set up a schedule…"));
    const dialog = page.querySelector("dialog");
    expect(dialog?.textContent).toContain("A routine has no memory: put what it needs in the objective.");
    expect(dialog?.textContent).not.toContain("read yours");
  });

  it("counts only records: preferences are always in context, and a chat told one read none", async () => {
    const { client } = owner();
    const page = await mountSettled(
      panel(client, chat([turn("r1", "Find this week's AI papers", [tool("web_search")], { records: [], preferences: 3, more: 0 })])),
    );
    await clickSettled(button(page, "Set up a schedule…"));
    expect(page.querySelector("dialog")?.textContent).not.toContain("has no memory");
  });

  it("keeps what was typed when it switches between the routine and the schedule", async () => {
    const { client } = owner();
    const page = await mountSettled(panel(client, chat([turn("r1", "Find this week's AI papers", [tool("web_search")])])));
    await clickSettled(button(page, "Set up a schedule…"));
    const objective = objectiveField(page);
    await act(async () => {
      if (objective) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(objective, "Find this week's robotics papers");
        objective.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await clickSettled(button(page, "Repeat it as a schedule instead"));
    expect(promptField(page)?.value).toBe("Find this week's robotics papers");
    await clickSettled(button(page, "Make it a research routine instead"));
    expect(objectiveField(page)?.value).toBe("Find this week's robotics papers");
  });

  it("fits a long research prompt to the routine's objective, and keeps it whole for a schedule", async () => {
    const { client } = owner();
    const long = `Find${" papers".repeat(5_000)}`;
    const page = await mountSettled(panel(client, chat([turn("r1", long, [tool("web_search")])])));
    await clickSettled(button(page, "Set up a schedule…"));
    expect(objectiveField(page)?.value).toBe(long.slice(0, 20_000));
    expect(page.querySelector("dialog")?.textContent).toContain("shortened");
    await clickSettled(button(page, "Repeat it as a schedule instead"));
    expect(promptField(page)?.value).toBe(long);
  });

  it("names the chat a routine is made from, so the owner can carry what it read", async () => {
    const { client, sent } = owner();
    const page = await mountSettled(panel(client, chat([turn("r1", "Find this week's AI papers", [tool("web_search")])])));
    await clickSettled(button(page, "Set up a schedule…"));
    await clickSettled(button(page, "Save routine"));
    expect(sent).toEqual([["routines", expect.objectContaining({ action: "create", fromTaskId: "task-1" })]]);
  });
});

describe("Repeat this on a message", () => {
  it("is offered only when asked for, and says what was created", async () => {
    const plain = await mount(<MessageActions text="hi" label="prompt" />);
    expect(plain.querySelector('[aria-label="Repeat this…"]')).toBeNull();
    const onRepeat = vi.fn((report: (note: string) => void) => report("Daily brief created."));
    const page = await mount(<MessageActions text="hi" label="prompt" onRepeat={onRepeat} />);
    await click(page.querySelector('[aria-label="Repeat this…"]'));
    expect(onRepeat).toHaveBeenCalledTimes(1);
    expect(page.querySelector(".action-notice")?.textContent).toBe("Daily brief created.");
  });

  it("is on each sent message of the chat, with that message's prompt", async () => {
    const runs = [turn("r1", "first message"), turn("r2", "second message"), { ...turn("r3", "queued one"), queued: true }];
    const onRepeat = vi.fn();
    const noop = () => {};
    const page = await mount(
      <Canvas
        state={{ connection: "ready", runs }}
        session={chat(runs)}
        onSubmit={noop}
        onDecide={noop}
        onAbort={noop}
        onExpand={noop}
        onRepeat={onRepeat}
      />,
    );
    const offered = page.querySelectorAll<HTMLButtonElement>('button[aria-label="Repeat this…"]');
    expect(offered).toHaveLength(2);
    await act(async () => offered[1]!.click());
    expect(onRepeat).toHaveBeenCalledWith("second message", expect.any(Function));
  });
});
