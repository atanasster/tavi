// @vitest-environment jsdom
import {
  effectiveMemorySettings,
  type CenterSummaryAnswer,
  type MemoryItem,
  type MemorySettings,
  type SystemPromptAnswer,
  type SystemPromptPreview,
} from "@tavi/contracts";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { CenterPage } from "../../../src/features/center/Center.js";
import type { CenterFeed } from "../../../src/features/center/feed.js";
import { MEMORY_PROPOSALS_ANCHOR } from "../../../src/features/center/Memory.js";
import {
  otherPeopleLine,
  otherProposalsLine,
  refreshRecords,
  usageLine,
  type ListedRecords,
} from "../../../src/features/center/memory-model.js";
import { SoulAndMemory } from "../../../src/features/center/Soul.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { forgetChatTitles } from "../../../src/features/center/reminders-api.js";
import { announced, freshAnnouncer } from "../../announced.js";
import { close, offeredWords, open, pick, selected } from "../../pick.js";
import { WorkspaceProvider } from "../../../src/features/shell/Workspace.js";
import { InWorkspace } from "../../support/workspace.js";
import { clickSettled as click, mountSettled as mount, rerender, unmountAll } from "../../support/dom.js";

/**
 * Soul & memory: the prompt's layers with
 * the replaced shipped default struck through, the workspace prompt and a
 * persona saved as compare-and-set writes, proposals kept or discarded,
 * sensitive records revealed on request, Forget behind an inline confirm, and
 * Remember writing to the scope picked.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** Types into a textarea or an input as React sees it, or chooses in a select. */
async function type(element: Element | null | undefined, value: string): Promise<void> {
  if (element instanceof HTMLElement && element.classList.contains("select-trigger")) {
    await pick(element, value);
    return;
  }
  if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) throw new Error("nothing to type into");
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const buttons = (container: ParentNode, text: string): HTMLButtonElement[] =>
  [...container.querySelectorAll("button")].filter((candidate) => candidate.textContent?.trim() === text);
const button = (container: ParentNode, text: string): HTMLButtonElement | undefined => buttons(container, text)[0];
const labelled = (container: ParentNode, text: string): HTMLElement | null => {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim() === text);
  return label === undefined ? null : (container.querySelector(`#${CSS.escape(label.htmlFor)}`) as HTMLElement | null);
};

const SHIPPED = "Fixture shipped base.";

function promptAnswer(custom: { readonly text: string; readonly revision: number } | null): SystemPromptAnswer {
  return {
    workspaceId: "default",
    revision: custom === null ? 0 : custom.revision,
    custom:
      custom === null
        ? null
        : {
            text: custom.text,
            revision: custom.revision,
            updatedAt: "2026-09-26T10:00:00.000Z",
            lastOperation: "set",
            previousRevision: custom.revision - 1,
            actor: "operator:ui",
            hash: "a".repeat(64),
          },
    shipped: { text: SHIPPED, templateVersion: "tavi-default-v2" },
    effective:
      custom === null
        ? { text: SHIPPED, source: "builtin", revision: null, templateVersion: "tavi-default-v2" }
        : { text: custom.text, source: "workspace", revision: custom.revision, templateVersion: null },
    appliesTo: "next-message",
    explicitAdapterShadowing: false,
  };
}

function preview(agentId?: string): SystemPromptPreview {
  return {
    workspaceId: "default",
    ...(agentId === undefined ? {} : { agentId }),
    layers: [
      {
        kind: "base",
        source: "shipped",
        label: "Shipped default (tavi-default-v2)",
        length: 4812,
        generated: false,
        active: false,
        templateVersion: "tavi-default-v2",
        detail: "Replaced by the workspace prompt",
      },
      {
        kind: "base",
        source: "workspace",
        label: "Workspace prompt (revision 7)",
        length: 2340,
        generated: false,
        active: true,
        revision: 7,
      },
      ...(agentId === undefined
        ? []
        : [{ kind: "persona" as const, label: "Persona: Khan", length: 612, generated: false, active: true, agentId, name: "Khan" }]),
      { kind: "facts", label: "Runtime facts", generated: true, active: true, detail: "Step 1 of 40. Local time 14:02.", sample: true },
      { kind: "context", label: "Memory and skills context", generated: true, active: true, detail: "Chosen per call." },
    ],
    shippedLength: 4812,
    overridden: true,
    baseText: "Mine.",
  };
}

const record = (recordId: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  recordId,
  kind: "fact",
  scope: { kind: "personal", principalId: "operator" },
  scopeKey: "personal|p=operator",
  currentRevisionId: `${recordId}-rev1`,
  status: "approved",
  sensitivity: "normal",
  revocationGeneration: 0,
  recordedAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  target: "personal",
  title: null,
  body: `Body of ${recordId}`,
  redacted: false,
  truncated: false,
  sourceCount: 0,
  ...extra,
});

type Answer = { readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly message: string } };
const ok = (result: unknown): Answer => ({ ok: true, result });
const refused = (code: string, message: string): Answer => ({ ok: false, error: { code, message } });

interface OwnerState {
  approved: MemoryItem[];
  proposed: MemoryItem[];
  /** What `list { past: true }` answers; absent, nothing is past. */
  past?: MemoryItem[];
  otherPeople?: { principalId: string; count: number }[];
  otherProposals?: { principalId: string; count: number }[];
  agents?: { agentId: string; name: string; pinnedBy?: { routineId: string; name: string }[] }[];
  prompt?: { text: string; revision: number } | null;
  /** Answers one request by its command and action, before the defaults. */
  answer?: (command: string, payload: Record<string, unknown>) => Answer | undefined;
}

/** An owner answering Soul & memory's reads from what the test holds; it records what it was asked. */
function owner(state: OwnerState): {
  readonly client: SettingsClient;
  readonly sent: { command: string; payload: Record<string, unknown> }[];
} {
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  const agents = (state.agents ?? []).map((agent) => ({
    ...agent,
    workspaceId: "default",
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    systemPromptLength: 12,
  }));
  const client = {
    request: (command: string, payload: Record<string, unknown>) => {
      sent.push({ command, payload });
      const custom = state.answer?.(command, payload);
      if (custom !== undefined) return Promise.resolve(custom);
      const action = payload["action"];
      if (command === "agents" && action === "list") return Promise.resolve(ok({ agents, truncated: false }));
      if (command === "agents" && action === "show") {
        const agent = agents.find((candidate) => candidate.agentId === payload["agentId"]);
        return Promise.resolve(
          agent === undefined ? refused("NOT_FOUND", "no agent") : ok({ ...agent, systemPrompt: `You are ${agent.name}.` }),
        );
      }
      if (command === "system-prompt" && action === "get") return Promise.resolve(ok(promptAnswer(state.prompt ?? null)));
      if (command === "system-prompt" && action === "preview")
        return Promise.resolve(ok(preview(payload["agentId"] as string | undefined)));
      if (command === "memory" && action === "usage") {
        return Promise.resolve(
          ok({
            records: state.approved.length + 4,
            bytes: 9000,
            quota: { records: state.approved.length, bytes: 3174, maxRecords: 10_000, maxBytes: 32 * 1024 * 1024 },
          }),
        );
      }
      if (command === "memory" && action === "list" && payload["past"] === true)
        return Promise.resolve(ok({ records: state.past ?? [], otherPeople: [] }));
      if (command === "memory" && action === "list") {
        const statuses = payload["statuses"] as string[];
        const records = statuses.includes("proposed") ? state.proposed : state.approved;
        return Promise.resolve(
          ok({
            records,
            otherPeople: state.otherPeople ?? [],
            ...(state.otherProposals === undefined ? {} : { otherProposals: state.otherProposals }),
          }),
        );
      }
      return Promise.resolve(refused("NOT_FOUND", `unscripted ${command} ${String(action)}`));
    },
  } as unknown as SettingsClient;
  return { client, sent };
}

const summary = (overrides: Partial<CenterSummaryAnswer> = {}): CenterSummaryAnswer => ({
  workspaceId: "default",
  timezone: "Europe/Berlin",
  today: "2026-09-29",
  counts: { approvals: 0, reviews: 0, questions: 0, runningTasks: 0, memoryProposals: 1, activeRoutines: 0, schedules: 0 },
  perDay: [{ date: "2026-09-29", tasks: 0 }],
  next: [],
  people: {},
  cursor: "c1",
  ...overrides,
});

const page = (client: SettingsClient, revision = 0) => (
  <InWorkspace client={client} workspaceId="default">
    <SoulAndMemory summary={summary()} revision={revision} focusProposals={false} onProposalsFocused={() => undefined} />
  </InWorkspace>
);
const sentOf = (sent: { command: string; payload: Record<string, unknown> }[], command: string, action: string) =>
  sent.filter((item) => item.command === command && item.payload["action"] === action).map((item) => item.payload);

describe("chat notes across chats", () => {
  it("lists every chat's notes under their chat's name, each opening its chat, only where the owner keeps them", async () => {
    const note = (recordId: string, taskId: string, body: string, status: "approved" | "proposed" = "approved") =>
      record(recordId, {
        scope: { kind: "run_local", principalId: "operator", workspaceId: "default", runId: taskId },
        scopeKey: `run_local|p=operator|w=default|r=${taskId}`,
        target: `chat:${taskId}`,
        body,
        status,
        durable: true,
      });
    const { client, sent } = owner({
      approved: [],
      proposed: [],
      answer: (command, payload) =>
        command === "memory" && payload["chatNotes"] === true
          ? ok({
              records: [note("n1", "t1", "The client is Acme"), note("n2", "t2", "Ship Friday", "proposed")],
              otherPeople: [],
              nextCursor: "o64",
            })
          : command === "tasks" && payload["taskId"] === "t1"
            ? ok({ task: { title: "Site audit" }, admissions: [] })
            : command === "tasks" && payload["taskId"] === "t2"
              ? ok({ task: null, admissions: [{ intent: { prompt: "Plan the launch" } }] })
              : undefined,
    });
    forgetChatTitles();
    const opened: string[] = [];
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <SoulAndMemory
          summary={summary()}
          revision={0}
          focusProposals={false}
          onProposalsFocused={() => undefined}
          onOpenChatNotes={async (taskId) => void opened.push(taskId)}
        />
      </InWorkspace>,
    );
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    const section = view.querySelector('[aria-labelledby="soul-chat-notes-title"]') as HTMLElement;
    expect([...section.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "The client is AcmeSite audit →",
      "Ship Friday · proposedPlan the launch →",
    ]);
    expect(sent.find((item) => item.payload["chatNotes"] === true)?.payload).toMatchObject({
      action: "list",
      statuses: ["approved", "proposed"],
    });
    expect(section.textContent).toContain("More chats have notes than one list holds");
    await click(section.querySelector("button"));
    expect(opened).toEqual(["t1"]);
    unmountAll();
    const plain = await mount(page(client));
    expect(plain.querySelector('[aria-labelledby="soul-chat-notes-title"]')).toBeNull();
  });
});

describe("the Soul pane", () => {
  it("lists the layers with their lengths, the replaced shipped default struck through, and generated layers per response", async () => {
    const { client } = owner({ approved: [], proposed: [] });
    const view = await mount(page(client));
    const layers = [...view.querySelectorAll(".soul-layer")];
    expect(layers.map((layer) => layer.querySelector(".soul-layer-label")?.textContent)).toEqual([
      "Shipped default (tavi-default-v2)",
      "Workspace prompt (revision 7)",
      "Runtime facts",
      "Memory and skills context",
    ]);
    expect(layers[0]?.classList.contains("off")).toBe(true);
    expect(layers[0]?.textContent).toContain("(not sent)");
    expect(layers[0]?.textContent).toContain("Replaced by the workspace prompt");
    expect(layers[0]?.querySelector(".soul-layer-len")?.textContent).toBe("4,812 characters");
    expect(layers[1]?.classList.contains("off")).toBe(false);
    expect(layers[2]?.textContent).toContain("Written per response");
    expect(layers[2]?.querySelector(".soul-layer-len")?.textContent).toBe("per response");
    expect(layers[2]?.querySelector("details summary")?.textContent).toBe("Sample facts");
    expect(layers[2]?.querySelector("details pre")?.textContent).toBe("Step 1 of 40. Local time 14:02.");
    expect(view.textContent).toContain("Changes apply from the next message.");
    // No agents: no Persona tab.
    expect([...view.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["Your prompt", "Shipped default"]);
  });

  it("saves the workspace prompt with the revision it read, keeps the draft on a conflict, and refreshes the preview after a save", async () => {
    let conflict = true;
    const { client, sent } = owner({
      approved: [],
      proposed: [],
      prompt: { text: "Mine.", revision: 7 },
      answer: (command, payload) => {
        if (command !== "system-prompt" || payload["action"] !== "set") return undefined;
        if (conflict) return refused("CONFLICT", "The system prompt changed since it was read.");
        return ok(promptAnswer({ text: String(payload["text"]), revision: 8 }));
      },
    });
    const view = await mount(page(client));
    const area = view.querySelector<HTMLTextAreaElement>("#soul-prompt-text");
    expect(area?.value).toBe("Mine.");
    expect(view.textContent).toContain("5 of 20,000 characters");
    await type(area, "Mine, edited.");
    await click(button(view, "Save"));
    expect(sentOf(sent, "system-prompt", "set").at(-1)).toEqual({
      action: "set",
      workspaceId: "default",
      text: "Mine, edited.",
      expectedRevision: 7,
    });
    expect(view.textContent).toContain("changed since it was read");
    expect(view.querySelector<HTMLTextAreaElement>("#soul-prompt-text")?.value).toBe("Mine, edited.");
    expect(button(view, "Reload saved")).toBeDefined();
    expect(button(view, "Copy draft")).toBeDefined();
    expect(button(view, "Save")?.disabled).toBe(true);

    // Reload saved brings the saved text back; a save then goes through and the preview is read again.
    await click(button(view, "Reload saved"));
    expect(view.querySelector<HTMLTextAreaElement>("#soul-prompt-text")?.value).toBe("Mine.");
    conflict = false;
    const previews = sentOf(sent, "system-prompt", "preview").length;
    await type(view.querySelector("#soul-prompt-text"), "Mine, again.");
    await click(button(view, "Save"));
    expect(view.textContent).toContain("Saved. Changes apply from the next message in this workspace.");
    expect(sentOf(sent, "system-prompt", "preview").length).toBe(previews + 1);
  });

  it("stages the shipped default with Use shipped default, and Save sends a reset", async () => {
    const { client, sent } = owner({
      approved: [],
      proposed: [],
      prompt: { text: "Mine.", revision: 7 },
      answer: (command, payload) => (command === "system-prompt" && payload["action"] === "reset" ? ok(promptAnswer(null)) : undefined),
    });
    const view = await mount(page(client));
    await click(button(view, "Use shipped default"));
    expect(view.querySelector<HTMLTextAreaElement>("#soul-prompt-text")?.readOnly).toBe(true);
    await click(button(view, "Save (use the shipped default)"));
    expect(sentOf(sent, "system-prompt", "reset").at(-1)).toEqual({ action: "reset", workspaceId: "default", expectedRevision: 7 });
  });

  it("shows the shipped default read-only", async () => {
    const { client } = owner({ approved: [], proposed: [] });
    const view = await mount(page(client));
    await click(buttons(view, "Shipped default").find((candidate) => candidate.getAttribute("role") === "tab"));
    expect(view.querySelector('pre[aria-label="Shipped default system prompt"]')?.textContent).toBe(SHIPPED);
    expect(view.textContent).toContain("Read-only");
    expect(view.querySelector("#soul-prompt-text")).toBeNull();
  });

  it("saves a persona with the version it read, and offers Reload saved and Copy draft on a conflict", async () => {
    let conflict = false;
    const { client, sent } = owner({
      approved: [],
      proposed: [],
      agents: [{ agentId: "khan", name: "Khan" }],
      answer: (command, payload) => {
        if (command !== "agents" || payload["action"] !== "update") return undefined;
        if (conflict) return refused("CONFLICT", "The agent changed since it was read.");
        return ok({
          agentId: "khan",
          workspaceId: "default",
          name: "Khan",
          systemPrompt: String(payload["prompt"]),
          enabled: true,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-29T12:00:00.000Z",
        });
      },
    });
    const view = await mount(page(client));
    // The preview is read for a plain task until an agent is picked for it.
    expect(sentOf(sent, "system-prompt", "preview").at(-1)).toEqual({ action: "preview", workspaceId: "default" });
    expect(view.textContent).not.toContain("Persona: Khan");
    const previewFor = labelled(view, "Layers for");
    await open(previewFor);
    expect(offeredWords()).toEqual(["None (plain tasks)", "Khan"]);
    await close();
    await type(previewFor, "khan");
    await settle();
    expect(sentOf(sent, "system-prompt", "preview").at(-1)).toEqual({ action: "preview", workspaceId: "default", agentId: "khan" });
    expect(view.textContent).toContain("Persona: Khan");
    await click(buttons(view, "Persona").find((candidate) => candidate.getAttribute("role") === "tab"));
    const area = view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Persona of Khan"]');
    expect(area?.value).toBe("You are Khan.");
    await type(area, "You are Khan, the chief of staff.");
    await click(button(view, "Save persona"));
    expect(sentOf(sent, "agents", "update").at(-1)).toEqual({
      action: "update",
      workspaceId: "default",
      agentId: "khan",
      prompt: "You are Khan, the chief of staff.",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(view.textContent).toContain("Saved. Chats with Khan use this persona from the next message.");

    // The next save asserts the version the acknowledgement carried, and a conflict keeps the draft.
    conflict = true;
    await type(view.querySelector('textarea[aria-label="Persona of Khan"]'), "Draft two.");
    await click(button(view, "Save persona"));
    expect(sentOf(sent, "agents", "update").at(-1)?.["expectedUpdatedAt"]).toBe("2026-09-29T12:00:00.000Z");
    expect(view.textContent).toContain("The agent changed since it was read.");
    expect(view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Persona of Khan"]')?.value).toBe("Draft two.");
    expect(button(view, "Copy draft")).toBeDefined();
    const shows = sentOf(sent, "agents", "show").length;
    await click(button(view, "Reload saved"));
    expect(sentOf(sent, "agents", "show").length).toBe(shows + 1);
    expect(view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Persona of Khan"]')?.value).toBe("You are Khan.");
  });

  it("keeps a persona draft across a tab switch, and guards a reload while it is unsaved", async () => {
    const { client } = owner({ approved: [], proposed: [], agents: [{ agentId: "khan", name: "Khan" }] });
    const view = await mount(page(client));
    const tab = (label: string) => buttons(view, label).find((candidate) => candidate.getAttribute("role") === "tab");
    await click(tab("Persona"));
    await type(view.querySelector('textarea[aria-label="Persona of Khan"]'), "Unsaved persona.");
    const fire = (): boolean => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire()).toBe(true);
    await click(tab("Your prompt"));
    await click(tab("Persona"));
    expect(view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Persona of Khan"]')?.value).toBe("Unsaved persona.");
    await click(button(view, "Discard changes"));
    expect(fire()).toBe(false);
  });

  it("asks before another agent replaces an unsaved persona, and drops the first agent's notices on the switch", async () => {
    const { client, sent } = owner({
      approved: [],
      proposed: [],
      agents: [
        { agentId: "khan", name: "Khan" },
        { agentId: "ada", name: "Ada" },
      ],
      answer: (command, payload) =>
        command === "agents" && payload["action"] === "update" ? refused("CONFLICT", "The agent changed since it was read.") : undefined,
    });
    const view = await mount(page(client));
    await click(buttons(view, "Persona").find((candidate) => candidate.getAttribute("role") === "tab"));
    await type(view.querySelector('textarea[aria-label="Persona of Khan"]'), "Draft for Khan.");
    await click(button(view, "Save persona"));
    expect(view.textContent).toContain("The agent changed since it was read.");

    await type(labelled(view, "Agent"), "ada");
    expect(view.textContent).toContain("Your changes to Khan are not saved. Discard them and open Ada?");
    expect(document.activeElement?.textContent).toBe("Keep editing");
    await click(button(view, "Keep editing"));
    expect(selected(labelled(view, "Agent"))).toBe("khan");
    expect(view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Persona of Khan"]')?.value).toBe("Draft for Khan.");

    await type(labelled(view, "Agent"), "ada");
    await click(button(view, "Discard"));
    expect(sentOf(sent, "agents", "show").at(-1)).toEqual({ action: "show", workspaceId: "default", agentId: "ada" });
    expect(view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Persona of Ada"]')?.value).toBe("You are Ada.");
    expect(view.textContent).not.toContain("The agent changed since it was read.");
    expect(button(view, "Copy draft")).toBeUndefined();
  });
  it("says a routine runs its own pinned instructions, links to the routine, and says so when the persona is saved", async () => {
    const opened: string[] = [];
    const { client } = owner({
      approved: [],
      proposed: [],
      agents: [
        {
          agentId: "khan",
          name: "Khan",
          pinnedBy: [
            { routineId: "r-news", name: "Morning news" },
            { routineId: "r-digest", name: "Evening digest" },
          ],
        },
      ],
      answer: (command, payload) =>
        command === "agents" && payload["action"] === "update"
          ? ok({
              agentId: "khan",
              workspaceId: "default",
              name: "Khan",
              systemPrompt: String(payload["prompt"]),
              enabled: true,
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-29T12:00:00.000Z",
            })
          : undefined,
    });
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <SoulAndMemory
          summary={summary()}
          revision={0}
          focusProposals={false}
          onProposalsFocused={() => undefined}
          onOpenRoutine={(routineId) => void opened.push(routineId)}
        />
      </InWorkspace>,
    );
    await click(buttons(view, "Persona").find((candidate) => candidate.getAttribute("role") === "tab"));
    const notices = [...view.querySelectorAll(".soul-pinned")].map((notice) => notice.textContent);
    expect(notices).toEqual([
      "Routine Morning news runs its own pinned instructions; edit them on the routine’s page.",
      "Routine Evening digest runs its own pinned instructions; edit them on the routine’s page.",
    ]);
    const link = view.querySelector<HTMLAnchorElement>(".soul-pinned a");
    expect(link?.getAttribute("href")).toBe("/center/schedule/routines/r-news");
    await click(link);
    expect(opened).toEqual(["r-news"]);

    await type(view.querySelector('textarea[aria-label="Persona of Khan"]'), "You are Khan, briefer.");
    await click(button(view, "Save persona"));
    expect(view.textContent).toContain(
      "Saved. Chats with Khan use this persona from the next message; routines Morning news and Evening digest keep their own pinned instructions.",
    );
  });

  it("shows no pinned notice for an agent no routine pins", async () => {
    const { client } = owner({ approved: [], proposed: [], agents: [{ agentId: "khan", name: "Khan" }] });
    const view = await mount(page(client));
    await click(buttons(view, "Persona").find((candidate) => candidate.getAttribute("role") === "tab"));
    expect(view.querySelector(".soul-pinned")).toBeNull();
  });
});

describe("the Memory pane", () => {
  it("pages the proposals, says how many wait in all, and counts other people's", async () => {
    const proposal = (index: number) => record(`q${index}`, { status: "proposed", body: `Proposal ${index}` });
    const pages = [Array.from({ length: 3 }, (_, index) => proposal(index)), [proposal(3), proposal(4)]];
    const { client, sent } = owner({
      approved: [],
      proposed: [],
      otherProposals: [{ principalId: "khan", count: 2 }],
      answer: (command, payload) => {
        if (
          command !== "memory" ||
          payload["action"] !== "list" ||
          (payload["statuses"] as string[] | undefined)?.includes("proposed") !== true
        )
          return undefined;
        const second = payload["cursor"] === "p2";
        return ok({
          records: second ? pages[1] : pages[0],
          otherPeople: [],
          otherProposals: [{ principalId: "khan", count: 2 }],
          ...(second ? {} : { nextCursor: "p2" }),
        });
      },
    });
    const view = await mount(
      <InWorkspace client={client} workspaceId="default">
        <SoulAndMemory
          summary={summary({ people: { khan: "Khan" }, counts: { ...summary().counts, memoryProposals: 5 } })}
          revision={0}
          focusProposals={false}
          onProposalsFocused={() => undefined}
        />
      </InWorkspace>,
    );
    const queue = () => view.querySelector(".memory-proposals") as HTMLElement;
    expect(queue().querySelector("h3")?.textContent).toContain("5 things the agent would like to remember");
    expect(queue().querySelectorAll("li")).toHaveLength(3);
    expect(queue().querySelector(".memory-proposals-more")?.textContent).toContain("Showing 3 of 5");
    expect(view.textContent).toContain("2 proposals from 1 other person wait for review (Khan 2).");
    await click(button(queue(), "Load more"));
    expect(sentOf(sent, "memory", "list").at(-1)).toMatchObject({ statuses: ["proposed"], cursor: "p2" });
    expect(queue().querySelectorAll("li")).toHaveLength(5);
    expect(queue().querySelector(".memory-proposals-more")).toBeNull();
    expect(queue().querySelector("h3")?.textContent).toContain("5 things the agent would like to remember");
  });

  it("says nothing is remembered yet, with no proposals queue", async () => {
    const { client } = owner({ approved: [], proposed: [] });
    const view = await mount(page(client));
    expect(view.textContent).toContain(
      "Nothing remembered yet. The agent proposes things to remember as you work; you decide what it keeps.",
    );
    expect(view.querySelector(".memory-proposals")).toBeNull();
    expect(view.textContent).toContain("0 records · 3.1 KiB of 32 MiB");
  });

  it("says why nothing will be proposed while suggestions are off or memory is paused", async () => {
    const settled = (memory: MemorySettings) =>
      owner({
        approved: [],
        proposed: [],
        answer: (command, payload) =>
          command === "workspace-settings" && payload["action"] === "get"
            ? ok({
                workspaceId: "default",
                revision: 1,
                settings: { memory },
                effective: { timezone: "UTC", memory: effectiveMemorySettings(memory) },
                hostTimezone: "UTC",
              })
            : undefined,
      }).client;
    const off = await mount(page(settled({ capture: "off" })));
    expect(off.textContent).toContain("Nothing remembered yet. Suggestions are off: only what you save yourself is kept.");
    unmountAll();
    const paused = await mount(page(settled({ enabled: false })));
    expect(paused.textContent).toContain(
      "Nothing remembered yet. Memory is paused: nothing is proposed or recalled until you turn it back on.",
    );
    expect(paused.textContent).not.toContain("The agent proposes things");
  });

  it("groups records by kind with scope chips, counts other people without listing them, and leaves shared records read-only", async () => {
    const { client } = owner({
      approved: [
        record("f1", { title: "Company", body: "Nanner Tech" }),
        record("p1", {
          kind: "preference",
          target: "workspace",
          scope: { kind: "personal_workspace", principalId: "operator", workspaceId: "default" },
          body: "Telegram",
        }),
        record("s1", {
          kind: "lesson",
          target: "shared",
          scope: { kind: "shared_workspace", workspaceId: "default" },
          body: "Check the credential first",
        }),
      ],
      proposed: [],
      otherPeople: [
        { principalId: "alice", count: 3 },
        { principalId: "bob", count: 2 },
      ],
    });
    const view = await mount(page(client));
    expect([...view.querySelectorAll(".memory-group h3 span:first-child")].map((heading) => heading.textContent)).toEqual([
      "Facts",
      "Preferences",
      "Lessons",
    ]);
    expect([...view.querySelectorAll(".memory-scope")].map((chip) => chip.textContent)).toEqual(["Personal", "Workspace", "Shared"]);
    expect(view.textContent).toContain("Also stored for 2 other people: 5 records (alice 3, bob 2)");
    const shared = [...view.querySelectorAll(".memory-row")].find((row) =>
      row.textContent?.includes("Check the credential first"),
    ) as HTMLElement;
    expect(button(shared, "Correct")).toBeUndefined();
    expect(button(shared, "Forget")).toBeUndefined();
    expect(shared.textContent).toContain("Read-only");
  });

  it("keeps a proposal with approve and discards one with reject", async () => {
    const state: OwnerState = {
      approved: [],
      proposed: [
        record("q1", { status: "proposed", body: "Prefers trains", sourceCount: 2, expiresAt: "2026-10-20T10:00:00.000Z" }),
        record("q2", { status: "proposed", kind: "lesson", body: "Double-check times" }),
      ],
      answer: (command, payload) => {
        if (command !== "memory" || (payload["action"] !== "approve" && payload["action"] !== "reject")) return undefined;
        const decided = state.proposed.find((item) => item.recordId === payload["recordId"]) as MemoryItem;
        state.proposed = state.proposed.filter((item) => item !== decided);
        return ok({ ...decided, status: payload["action"] === "approve" ? "approved" : "rejected" });
      },
    };
    const { client, sent } = owner(state);
    const view = await mount(page(client));
    const queue = view.querySelector(".memory-proposals") as HTMLElement;
    expect(queue.querySelector("h3")?.textContent).toContain("2 things the agent would like to remember");
    const first = [...queue.querySelectorAll("li")].find((item) => item.textContent?.includes("Prefers trains")) as HTMLElement;
    expect(first.textContent).toContain("Fact");
    expect(first.textContent).toContain("From 2 sources");
    expect(first.textContent).toContain("Expires");
    await click(button(first, "Keep"));
    expect(sentOf(sent, "memory", "approve")).toEqual([{ action: "approve", workspaceId: "default", recordId: "q1" }]);
    const second = [...view.querySelectorAll(".memory-proposals li")].find((item) =>
      item.textContent?.includes("Double-check times"),
    ) as HTMLElement;
    await click(button(second, "Discard"));
    expect(sentOf(sent, "memory", "reject")).toEqual([{ action: "reject", workspaceId: "default", recordId: "q2" }]);
    // Nothing left to review: the queue is gone.
    expect(view.querySelector(".memory-proposals")).toBeNull();
  });

  it("names what an update replaces and what a proposal is similar to, offers Replace for an update, and Keep both only for a fact", async () => {
    const state: OwnerState = {
      approved: [],
      proposed: [
        record("u1", {
          status: "proposed",
          kind: "preference",
          body: "Reply in French",
          currentRevisionId: undefined,
          updates: { recordId: "k1", title: "Reply in Spanish", currentRevisionId: "k1-rev1" },
        }),
        record("u2", {
          status: "proposed",
          body: "Lives in Porto",
          currentRevisionId: undefined,
          mayUpdate: { recordId: "k2", title: "Lives in Lisbon", currentRevisionId: "k2-rev1" },
        }),
        record("s1", { status: "proposed", body: "Has two cats", similarTo: { recordId: "k3", title: "Has two cats and a dog" } }),
      ],
      answer: (command, payload) => {
        if (command !== "memory" || payload["action"] !== "replace") return undefined;
        state.proposed = state.proposed.filter((item) => item.recordId !== payload["recordId"]);
        return ok(record("k1", { body: "Reply in French", kind: "preference" }));
      },
    };
    const { client, sent } = owner(state);
    const view = await mount(page(client));
    const row = (text: string) =>
      [...view.querySelectorAll(".memory-proposals li")].find((item) => item.textContent?.includes(text)) as HTMLElement;
    const names = (element: HTMLElement) => [...element.querySelectorAll("button")].map((each) => each.textContent);
    expect(row("Reply in French").textContent).toContain("updates: Reply in Spanish");
    expect(names(row("Reply in French"))).toEqual(["Replace", "Discard"]);
    expect(row("Lives in Porto").textContent).toContain("may update: Lives in Lisbon");
    expect(names(row("Lives in Porto"))).toEqual(["Replace", "Keep both", "Discard"]);
    expect(row("Has two cats").textContent).toContain("similar to: Has two cats and a dog");
    expect(names(row("Has two cats"))).toEqual(["Keep", "Discard"]);
    await click(button(row("Reply in French"), "Replace"));
    expect(sentOf(sent, "memory", "replace")).toEqual([
      { action: "replace", workspaceId: "default", recordId: "u1", targetRevisionId: "k1-rev1" },
    ]);
  });

  it("masks a sensitive record until Reveal asks for it, and hides it again", async () => {
    const { client, sent } = owner({
      approved: [record("x1", { sensitivity: "sensitive", redacted: true, title: null, body: null })],
      proposed: [],
      answer: (command, payload) =>
        command === "memory" && payload["action"] === "get"
          ? ok({
              record: record("x1", { sensitivity: "sensitive", title: "Ticket email", body: "me@example.com" }),
              revisions: [],
              revisionCount: 1,
              reviews: [],
            })
          : undefined,
    });
    const view = await mount(page(client));
    const row = view.querySelector(".memory-row") as HTMLElement;
    expect(row.querySelector(".memory-masked")).not.toBeNull();
    expect(row.textContent).not.toContain("me@example.com");
    await click(button(row, "Reveal"));
    expect(sentOf(sent, "memory", "get")).toEqual([{ action: "get", workspaceId: "default", recordId: "x1", reveal: true }]);
    expect(row.textContent).toContain("me@example.com");
    expect(row.querySelector(".memory-masked")).toBeNull();
    await click(button(row, "Hide"));
    expect(row.textContent).not.toContain("me@example.com");
    expect(row.querySelector(".memory-masked")).not.toBeNull();
  });

  it("forgets a record only after the inline confirm", async () => {
    const state: OwnerState = {
      approved: [record("f1", { body: "Old fact" })],
      proposed: [],
      answer: (command, payload) => {
        if (command !== "memory" || payload["action"] !== "forget") return undefined;
        state.approved = [];
        return ok({
          deletionId: "d1",
          recordId: "f1",
          scopeKey: "personal|p=operator",
          reason: "forgotten by the operator",
          deletedAt: "2026-09-29T12:00:00.000Z",
          cleanupStatus: "complete",
        });
      },
    };
    const { client, sent } = owner(state);
    const view = await mount(page(client));
    const row = view.querySelector(".memory-row") as HTMLElement;
    await click(button(row, "Forget"));
    expect(sentOf(sent, "memory", "forget")).toHaveLength(0);
    expect(row.textContent).toContain("Forget this?");
    // The confirm opens on its safe choice.
    expect(document.activeElement?.textContent).toBe("Keep it");
    await click(button(row, "Keep it"));
    expect(sentOf(sent, "memory", "forget")).toHaveLength(0);
    await click(button(view.querySelector(".memory-row") as HTMLElement, "Forget"));
    await click(button(view, "Forget it"));
    expect(sentOf(sent, "memory", "forget")).toEqual([{ action: "forget", workspaceId: "default", recordId: "f1" }]);
    expect(view.querySelector(".memory-row")).toBeNull();
  });

  it("says which memory provider a forget's removal waits for", async () => {
    const state: OwnerState = {
      approved: [record("f1", { body: "Old fact" })],
      proposed: [],
      answer: (command, payload) => {
        if (command !== "memory" || payload["action"] !== "forget") return undefined;
        state.approved = [];
        return ok({
          deletionId: "d1",
          recordId: "f1",
          scopeKey: "personal|p=operator",
          reason: "forgotten by the operator",
          requestedAt: "2026-09-29T12:00:00.000Z",
          cleanupStatus: "pending",
          pendingProviders: ["acme.index"],
        });
      },
    };
    const { client } = owner(state);
    freshAnnouncer();
    const view = await mount(page(client));
    await click(button(view.querySelector(".memory-row") as HTMLElement, "Forget"));
    await click(button(view, "Forget it"));
    expect(view.querySelector(".memory-row")).toBeNull();
    expect(announced()).toContain("It will be removed from acme.index when it next runs.");
  });

  it("corrects a record against the revision it opened, and reloads it on a revision conflict", async () => {
    let conflict = true;
    const { client, sent } = owner({
      approved: [record("f1", { title: "Company", body: "Nanner" })],
      proposed: [],
      answer: (command, payload) => {
        if (command !== "memory") return undefined;
        if (payload["action"] === "get")
          return ok({
            record: record("f1", {
              title: "Company",
              body: conflict ? "Nanner" : "Nanner Tech",
              currentRevisionId: conflict ? "f1-rev1" : "f1-rev2",
            }),
            revisions: [],
            revisionCount: 1,
            reviews: [],
          });
        if (payload["action"] === "correct") {
          if (conflict) {
            conflict = false;
            return refused("REVISION_CONFLICT", "stale");
          }
          return ok(record("f1", { title: "Company", body: String(payload["body"]), currentRevisionId: "f1-rev3" }));
        }
        return undefined;
      },
    });
    const view = await mount(page(client));
    await click(button(view.querySelector(".memory-row") as HTMLElement, "Correct"));
    await type(labelled(view, "Text"), "Nanner Technologies");
    await click(button(view, "Save correction"));
    expect(sentOf(sent, "memory", "correct")[0]).toEqual({
      action: "correct",
      workspaceId: "default",
      recordId: "f1",
      expectedRevisionId: "f1-rev1",
      body: "Nanner Technologies",
    });
    expect(view.textContent).toContain("This record changed since you opened it.");
    // The newer version is in the form, and the next save is made against it.
    expect((labelled(view, "Text") as HTMLTextAreaElement).value).toBe("Nanner Tech");
    await type(labelled(view, "Text"), "Nanner Technologies");
    await click(button(view, "Save correction"));
    expect(sentOf(sent, "memory", "correct")[1]?.["expectedRevisionId"]).toBe("f1-rev2");
    expect(view.querySelector(".memory-form")).toBeNull();
  });

  it("remembers into the scope picked, an agent's included", async () => {
    const { client, sent } = owner({
      approved: [],
      proposed: [],
      agents: [{ agentId: "khan", name: "Khan" }],
      answer: (command, payload) =>
        command === "memory" && payload["action"] === "remember" ? ok(record("n1", { body: String(payload["body"]) })) : undefined,
    });
    const view = await mount(page(client));
    await click(button(view, "Remember"));
    const form = view.querySelector('form[aria-label="Remember"]') as HTMLElement;
    const scope = labelled(form, "Where");
    await open(scope);
    expect(offeredWords()).toEqual(["Personal", "Workspace", "Agent: Khan"]);
    await close();
    await type(scope, "agent:khan");
    await type(labelled(form, "Kind"), "lesson");
    await type(labelled(form, "What to remember"), "Check the connection the evening before");
    await act(async () => (form.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await click(button(form, "Remember"));
    expect(sentOf(sent, "memory", "remember")).toEqual([
      {
        action: "remember",
        workspaceId: "default",
        kind: "lesson",
        scope: "agent:khan",
        body: "Check the connection the evening before",
        sensitivity: "sensitive",
      },
    ]);
    expect(view.querySelector('form[aria-label="Remember"]')).toBeNull();
  });

  it("asks for a preference's key before remembering one", async () => {
    const { client, sent } = owner({
      approved: [],
      proposed: [],
      answer: (command, payload) => (command === "memory" && payload["action"] === "remember" ? ok(record("n1")) : undefined),
    });
    const view = await mount(page(client));
    await click(button(view, "Remember"));
    const form = view.querySelector('form[aria-label="Remember"]') as HTMLElement;
    await type(labelled(form, "Kind"), "preference");
    await type(labelled(form, "Value"), "Telegram");
    await click(button(form, "Remember"));
    expect(sentOf(sent, "memory", "remember")).toHaveLength(0);
    expect(form.textContent).toContain("A preference needs a key");
    await type(labelled(form, "Key"), "reply.channel");
    await click(button(form, "Remember"));
    expect(sentOf(sent, "memory", "remember")).toEqual([
      {
        action: "remember",
        workspaceId: "default",
        kind: "preference",
        scope: "personal",
        body: "Telegram",
        preferenceKey: "reply.channel",
        preferenceValue: "Telegram",
      },
    ]);
  });

  it("drops revealed text once a refresh shows the record moved on", async () => {
    const state: OwnerState = {
      approved: [record("x1", { sensitivity: "sensitive", redacted: true, title: null, body: null })],
      proposed: [],
    };
    state.answer = (command, payload) =>
      command === "memory" && payload["action"] === "get"
        ? ok({ record: record("x1", { sensitivity: "sensitive", body: "old@example.com" }), revisions: [], revisionCount: 1, reviews: [] })
        : undefined;
    const { client } = owner(state);
    const view = await mount(page(client));
    await click(button(view.querySelector(".memory-row") as HTMLElement, "Reveal"));
    expect(view.textContent).toContain("old@example.com");
    // An unrelated refresh keeps it revealed.
    await rerender(page(client, 1));
    await settle();
    expect(view.textContent).toContain("old@example.com");
    // A correction made elsewhere moves the revision: the old text goes.
    state.approved = [
      record("x1", {
        sensitivity: "sensitive",
        redacted: true,
        title: null,
        body: null,
        currentRevisionId: "x1-rev2",
        updatedAt: "2026-09-29T11:00:00.000Z",
      }),
    ];
    await rerender(page(client, 2));
    await settle();
    expect(view.textContent).not.toContain("old@example.com");
    expect(view.querySelector(".memory-row .memory-masked")).not.toBeNull();
    expect(button(view.querySelector(".memory-row") as HTMLElement, "Reveal")).toBeDefined();
  });

  it("lists what ended or expired under Past, not as memory in force, and Keep longer sends a new date", async () => {
    // Ended long ago (dates at midnight in the workspace zone, Berlin): a fact kept as history, an expired preference the sweep will erase.
    const trip = record("p1", { kind: "fact", body: "Travelling to Lisbon", validTo: "2020-01-02T23:00:00.000Z" });
    const spanish = record("p2", {
      kind: "preference",
      status: "expired",
      body: "Reply in Spanish",
      currentRevisionId: "p2-rev1",
      expiryAt: "2020-01-02T23:00:00.000Z",
      erasesAt: "2020-02-02T09:00:00.000Z",
    });
    const later = record("p3", { kind: "fact", body: "In Porto until spring", validTo: "2099-02-28T23:00:00.000Z" });
    const { client, sent } = owner({
      approved: [trip, later],
      proposed: [],
      past: [trip, spanish],
      answer: (command, payload) =>
        command === "memory" && payload["action"] === "correct"
          ? ok({ ...spanish, status: "approved", expiryAt: "2030-01-11T00:00:00.000Z" })
          : undefined,
    });
    const view = await mount(page(client));
    expect(sentOf(sent, "memory", "list").some((payload) => payload["past"] === true && payload["statuses"] === undefined)).toBe(true);
    const groups = [...view.querySelectorAll(".memory-group:not(.memory-past)")].map((group) => group.textContent ?? "").join(" ");
    // An ended fact is not memory in force; one with a date still ahead is, with its "Until".
    expect(groups).not.toContain("Travelling to Lisbon");
    expect(groups).toContain("In Porto until spring");
    expect(groups).toContain("Until Sat 28 Feb 2099");
    const past = view.querySelector(".memory-past") as HTMLElement;
    expect(past.querySelector("h3")?.textContent).toContain("Past");
    // The last day it held, in the workspace's zone: "until Friday" ends as Saturday begins.
    expect(past.textContent).toContain("Ended Thu 2 Jan 2020 · kept");
    expect(past.textContent).toContain("Expired Thu 2 Jan 2020 · erased on Sun 2 Feb 2020");

    const row = [...past.querySelectorAll(".memory-row")].find((item) => item.textContent?.includes("Reply in Spanish")) as HTMLElement;
    await click(button(row, "Keep longer"));
    await type(labelled(row, "Keep until"), "2030-01-10");
    await click(row.querySelector("button[type=submit]"));
    expect(sentOf(sent, "memory", "correct")).toEqual([
      { action: "correct", workspaceId: "default", recordId: "p2", expectedRevisionId: "p2-rev1", until: "2030-01-10" },
    ]);
  });

  it("pages Past: the count reads as more while a cursor remains, and Load more reads the next page", async () => {
    const first = record("p1", { kind: "fact", body: "Travelling to Lisbon", validTo: "2020-01-02T23:00:00.000Z" });
    const second = record("p2", { kind: "fact", body: "Staying in Porto", validTo: "2020-01-02T23:00:00.000Z" });
    const { client, sent } = owner({
      approved: [],
      proposed: [],
      answer: (command, payload) =>
        command === "memory" && payload["action"] === "list" && payload["past"] === true
          ? ok(
              payload["cursor"] === undefined
                ? { records: [first], nextCursor: "c1", otherPeople: [] }
                : { records: [second], otherPeople: [] },
            )
          : undefined,
    });
    const view = await mount(page(client));
    const past = view.querySelector(".memory-past") as HTMLElement;
    expect(past.querySelector(".soul-figure")?.textContent).toBe("1+");
    expect(past.textContent).not.toContain("Staying in Porto");
    await click(button(past, "Load more"));
    expect(sentOf(sent, "memory", "list").some((payload) => payload["past"] === true && payload["cursor"] === "c1")).toBe(true);
    expect(past.textContent).toContain("Staying in Porto");
    expect(past.querySelector(".soul-figure")?.textContent).toBe("2");
    expect(button(past, "Load more")).toBeUndefined();
  });

  it("reveals a sensitive proposal before it is kept", async () => {
    const { client, sent } = owner({
      approved: [],
      proposed: [record("q1", { status: "proposed", sensitivity: "sensitive", redacted: true, title: null, body: null })],
      answer: (command, payload) =>
        command === "memory" && payload["action"] === "get"
          ? ok({
              record: record("q1", { status: "proposed", sensitivity: "sensitive", body: "Passport expires 2031" }),
              revisions: [],
              revisionCount: 1,
              reviews: [],
            })
          : undefined,
    });
    const view = await mount(page(client));
    const proposal = view.querySelector(".memory-proposals li") as HTMLElement;
    expect(proposal.querySelector(".memory-masked")).not.toBeNull();
    await click(button(proposal, "Reveal"));
    expect(sentOf(sent, "memory", "get")).toEqual([{ action: "get", workspaceId: "default", recordId: "q1", reveal: true }]);
    expect(proposal.textContent).toContain("Passport expires 2031");
    expect(button(proposal, "Keep")).toBeDefined();
    expect(button(proposal, "Discard")).toBeDefined();
  });

  it("keeps the pages loaded through a refresh, and a row open for correction", async () => {
    const all = Array.from({ length: 51 }, (_, index) => record(`f${index}`, { body: `Fact ${index}` }));
    const state: OwnerState = {
      approved: all,
      proposed: [],
      answer: (command, payload) => {
        if (command !== "memory") return undefined;
        if (payload["action"] === "get")
          return ok({ record: record("f50", { body: "Fact 50" }), revisions: [], revisionCount: 1, reviews: [] });
        if (payload["action"] !== "list" || (payload["statuses"] as string[] | undefined)?.includes("approved") !== true) return undefined;
        const offset = payload["cursor"] === "o1e" ? 50 : 0;
        const limit = Number(payload["limit"]);
        const records = state.approved.slice(offset, offset + limit);
        return ok({
          records,
          otherPeople: [],
          ...(offset + limit < state.approved.length ? { nextCursor: `o${(offset + limit).toString(36)}` } : {}),
        });
      },
    };
    const { client, sent } = owner(state);
    const view = await mount(page(client));
    expect(view.querySelectorAll(".memory-row")).toHaveLength(50);
    await click(button(view, "Load more"));
    expect(view.textContent).toContain("Fact 50");

    // A memory change reads as deep as was loaded, and page two stays.
    await rerender(page(client, 1));
    await settle();
    expect(
      sentOf(sent, "memory", "list")
        .filter((payload) => (payload["statuses"] as string[] | undefined)?.includes("approved") === true)
        .at(-1)?.["limit"],
    ).toBe(51);
    expect(view.querySelectorAll(".memory-row")).toHaveLength(51);
    expect(button(view, "Load more")).toBeUndefined();

    // A row being corrected stays, draft and all, when a refresh no longer lists it.
    const last = [...view.querySelectorAll(".memory-row")].find((row) => row.textContent?.includes("Fact 50")) as HTMLElement;
    await click(button(last, "Correct"));
    await type(labelled(view, "Text"), "Fact 50, corrected");
    state.approved = all.slice(0, 50);
    await rerender(page(client, 2));
    await settle();
    expect((labelled(view, "Text") as HTMLTextAreaElement | null)?.value).toBe("Fact 50, corrected");
  });

  it("keeps a half-filled Remember form when its header button is pressed again", async () => {
    const { client } = owner({ approved: [], proposed: [] });
    const view = await mount(page(client));
    const header = view.querySelector(".soul-pane-head button") as HTMLButtonElement;
    await click(header);
    await type(labelled(view, "What to remember"), "Half a thought");
    expect(header.getAttribute("aria-controls")).toBe(view.querySelector('form[aria-label="Remember"]')?.id);
    await click(header);
    expect((labelled(view, "What to remember") as HTMLTextAreaElement | null)?.value).toBe("Half a thought");
    await click(button(view.querySelector('form[aria-label="Remember"]') as HTMLElement, "Cancel"));
    expect(view.querySelector('form[aria-label="Remember"]')).toBeNull();
  });

  it("reads memory again when the feed reports a memory change", async () => {
    const state: OwnerState = { approved: [], proposed: [] };
    const { client } = owner(state);
    const view = await mount(page(client));
    expect(view.querySelector(".memory-row")).toBeNull();
    state.approved = [record("f1", { body: "Arrived from a chat" })];
    await rerender(page(client, 1));
    await settle();
    expect(view.textContent).toContain("Arrived from a chat");
  });

  it("labels partial matches when no record held every word", async () => {
    const { client } = owner({
      approved: [],
      proposed: [],
      answer: (command, payload) =>
        command === "memory" && payload["action"] === "list" && payload["query"] === "Lisbon flat rent"
          ? ok({ records: [record("f1", { body: "The Lisbon flat has a balcony" })], otherPeople: [], coverage: "complete", match: "any" })
          : undefined,
    });
    const view = await mount(page(client));
    await type(view.querySelector('input[aria-label="Search memory"]'), "Lisbon flat rent");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await settle();
    expect(view.textContent).toContain("The Lisbon flat has a balcony");
    expect(view.querySelector('[role="status"].memory-status')?.textContent).toBe("No exact match; showing partial matches");
  });

  it("searches with the typed query after a pause", async () => {
    const { client, sent } = owner({ approved: [], proposed: [] });
    const view = await mount(page(client));
    await type(view.querySelector('input[aria-label="Search memory"]'), "trains");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await settle();
    expect(
      sentOf(sent, "memory", "list").some(
        (payload) => payload["query"] === "trains" && (payload["statuses"] as string[] | undefined)?.includes("approved") === true,
      ),
    ).toBe(true);
    expect(view.textContent).toContain("Nothing remembered matches “trains”.");
  });
});

describe("the rail's memory proposals", () => {
  it("open Soul & memory at its proposals", async () => {
    const { client } = owner({ approved: [], proposed: [record("q1", { status: "proposed", body: "Prefers trains" })] });
    const feed: CenterFeed = { summary: summary(), error: undefined, revisions: {} };
    let section: string | undefined;
    const view = await mount(
      <WorkspaceProvider client={client} workspaceId="default" timeZone={undefined}>
        <CenterPage
          section="activity"
          feed={feed}
          onSection={(next) => (section = next)}
          onOpenRoutine={() => undefined}
          onOpenTask={() => Promise.resolve()}
          onPermissions={() => undefined}
        />
      </WorkspaceProvider>,
    );
    const need = [...view.querySelectorAll(".center-need")].find((item) =>
      item.textContent?.includes("memory proposal"),
    ) as HTMLAnchorElement;
    expect(need.getAttribute("href")).toBe("/center/identity");
    await click(need);
    expect(section).toBe("identity");
    await rerender(
      <WorkspaceProvider client={client} workspaceId="default" timeZone={undefined}>
        <CenterPage
          section="identity"
          feed={feed}
          onSection={(next) => (section = next)}
          onOpenRoutine={() => undefined}
          onOpenTask={() => Promise.resolve()}
          onPermissions={() => undefined}
        />
      </WorkspaceProvider>,
    );
    await settle();
    expect(document.activeElement?.id).toBe(MEMORY_PROPOSALS_ANCHOR);
  });

  it("focus the proposals once: a later visit through the nav lands on the section only", async () => {
    const { client } = owner({ approved: [], proposed: [record("q1", { status: "proposed", body: "Prefers trains" })] });
    const feed: CenterFeed = { summary: summary(), error: undefined, revisions: {} };
    const at = (section: "activity" | "identity") => (
      <WorkspaceProvider client={client} workspaceId="default" timeZone={undefined}>
        <CenterPage
          section={section}
          feed={feed}
          onSection={() => undefined}
          onOpenRoutine={() => undefined}
          onOpenTask={() => Promise.resolve()}
          onPermissions={() => undefined}
        />
      </WorkspaceProvider>
    );
    const view = await mount(at("identity"));
    const need = [...view.querySelectorAll(".center-need")].find((item) =>
      item.textContent?.includes("memory proposal"),
    ) as HTMLAnchorElement;
    await click(need);
    expect(document.activeElement?.id).toBe(MEMORY_PROPOSALS_ANCHOR);
    await rerender(at("activity"));
    await settle();
    await rerender(at("identity"));
    await settle();
    expect(view.querySelector(`#${MEMORY_PROPOSALS_ANCHOR}`)).not.toBeNull();
    expect(document.activeElement?.id).not.toBe(MEMORY_PROPOSALS_ANCHOR);
  });
});

describe("memory figures", () => {
  it("refresh over the held records, keeping those past one request's bound and those being corrected", () => {
    const held: ListedRecords = { records: [record("a"), record("b"), record("c")], nextCursor: "o3" };
    // Everything held was read again: the fresh answer wins, with its cursor.
    expect(refreshRecords(held, { records: [record("b"), record("a")], nextCursor: undefined }, 3, new Set())).toEqual({
      records: [record("b"), record("a")],
      nextCursor: undefined,
    });
    // More were held than one request reads: the rest stay, with the cursor after them.
    expect(refreshRecords(held, { records: [record("a")], nextCursor: "o1" }, 2, new Set()).records.map((item) => item.recordId)).toEqual([
      "a",
      "c",
    ]);
    expect(refreshRecords(held, { records: [record("a")], nextCursor: "o1" }, 2, new Set()).nextCursor).toBe("o3");
    // A record open for correction stays although the refresh no longer lists it.
    expect(
      refreshRecords(held, { records: [record("a")], nextCursor: undefined }, 3, new Set(["b"])).records.map((item) => item.recordId),
    ).toEqual(["a", "b"]);
  });

  it("state usage against the operator's own quota, and other people by id", () => {
    const quota = { maxRecords: 10_000, maxBytes: 32 * 1024 * 1024 };
    // The quota's figures, not everything visible: the quota is charged per person.
    expect(usageLine({ records: 40, bytes: 90_000, quota: { ...quota, records: 11, bytes: 3174 } })).toBe("11 records · 3.1 KiB of 32 MiB");
    expect(usageLine({ records: 1, bytes: 1, quota: { ...quota, records: 1, bytes: 2 * 1024 * 1024 } })).toBe(
      "1 record · 2.0 MiB of 32 MiB",
    );
    // Tiny usage is said in bytes, never "0.0 KiB".
    expect(usageLine({ records: 1, bytes: 1, quota: { ...quota, records: 1, bytes: 37 } })).toBe("1 record · 37 bytes of 32 MiB");
    expect(usageLine({ records: 1, bytes: 1, quota: { ...quota, records: 1, bytes: 1 } })).toBe("1 record · 1 byte of 32 MiB");
    // An older owner names no quota, and none is claimed.
    expect(usageLine({ records: 11, bytes: 3174 })).toBe("11 records · 3.1 KiB");
    expect(otherProposalsLine(undefined, {})).toBeUndefined();
    expect(otherProposalsLine([], {})).toBeUndefined();
    expect(
      otherProposalsLine(
        [
          { principalId: "khan", count: 2 },
          { principalId: "bob", count: 1 },
        ],
        { khan: "Khan" },
      ),
    ).toBe("3 proposals from 2 other people wait for review (Khan 2, bob 1).");
    expect(otherProposalsLine([{ principalId: "khan", count: 1 }], {})).toBe("1 proposal from 1 other person waits for review (khan 1).");
    expect(otherPeopleLine([], {})).toBeUndefined();
    expect(otherPeopleLine([{ principalId: "alice", count: 1 }], { alice: "Alice" })).toBe(
      "Also stored for 1 other person: 1 record (Alice 1)",
    );
  });
});
