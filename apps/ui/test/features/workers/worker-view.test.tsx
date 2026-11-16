// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientEvent, TranscriptEntry } from "@tavi/contracts";
import type { SubscribeOptions } from "@tavi/client/browser";
import { markdownReady } from "../../../src/ui/Markdown.js";
import {
  FinalText,
  WATCH_SETTLE_MS,
  WorkerTranscript,
  clipText,
  mergeNewest,
  workerLabel,
  type WorkerViewClient,
} from "../../../src/features/workers/WorkerView.js";
import { InWorkspace } from "../../support/workspace.js";
import { mount, rerender, unmountAll } from "../../support/dom.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});
const worker = { taskId: "w1", label: "researcher", chatTaskId: "root" };
const saved = (seq: number, text: string, prompt?: string): TranscriptEntry => ({
  taskId: "w1",
  seq,
  turn: {
    admissionKind: seq === 1 ? "start" : "reply",
    ...(prompt === undefined ? {} : { prompt }),
    items: [
      { kind: "text", text },
      { kind: "tool", callId: `c${seq}`, toolName: "web.search", status: "completed" },
    ],
    outcome: { status: "completed", finalText: text },
  },
  createdAt: "2026-10-04T00:00:00.000Z",
});
/** The worker's transcript, read through `client`. */
const transcript = (client: WorkerViewClient, onClose = () => undefined, revision?: number) => (
  <InWorkspace workspaceId="default">
    <WorkerTranscript client={client} worker={worker} revision={revision} onClose={onClose} />
  </InWorkspace>
);
const show = (client: WorkerViewClient, onClose = () => undefined, revision?: number): Promise<HTMLElement> =>
  mount(transcript(client, onClose, revision));

it("names a worker by its agent and clips long text", () => {
  expect(workerLabel({ taskId: "t", agentDefinitionId: "def", workerAgentId: "agent" })).toBe("def");
  expect(workerLabel({ taskId: "t", workerAgentId: "agent" })).toBe("agent");
  expect(workerLabel({ taskId: "t" })).toBe("t");
  expect(clipText("abcdef", 4)).toBe("abc…");
  expect(clipText("abc", 4)).toBe("abc");
});

it("shows a worker's saved turns view only — no composer — pages back, and closes", async () => {
  const asked: unknown[] = [];
  const request = vi.fn(async (command: string, payload?: unknown) => {
    asked.push({ command, payload });
    const before = (payload as { before?: number }).before;
    return {
      ok: true,
      result:
        before === undefined
          ? { entries: [saved(2, "Second answer")], nextBefore: 2 }
          : { entries: [saved(1, "First answer", "Find flights")] },
    };
  });
  const closed = vi.fn();
  const page = await show({ request }, closed);
  expect(asked).toEqual([{ command: "tasks", payload: { action: "transcript", taskId: "w1", workspaceId: "default" } }]);
  expect(page.querySelector("aside")?.getAttribute("aria-label")).toBe("Worker researcher — view only");
  expect(page.querySelector("h2")?.textContent).toBe("Worker researcher — view only");
  expect(page.textContent).toContain("Second answer");
  // Seen, not chatted with: nothing to type into, nothing to send.
  expect(page.querySelector("textarea, input, form")).toBeNull();
  expect([...page.querySelectorAll("button")].some((button) => /send|reply|continue/i.test(button.textContent ?? ""))).toBe(false);
  await act(async () => [...page.querySelectorAll("button")].find((button) => button.textContent === "Load earlier turns")!.click());
  expect(asked.at(-1)).toEqual({ command: "tasks", payload: { action: "transcript", taskId: "w1", workspaceId: "default", before: 2 } });
  const text = page.textContent ?? "";
  expect(text.indexOf("Find flights")).toBeLessThan(text.indexOf("Second answer"));
  expect(page.textContent).not.toContain("Load earlier turns");
  // Only the owner's read commands are asked: no run, reply or answer.
  expect(request.mock.calls.every(([command]) => command === "tasks")).toBe(true);
  await act(async () => [...page.querySelectorAll("button")].find((button) => button.textContent === "Close")!.click());
  expect(closed).toHaveBeenCalledTimes(1);
});

it("reads the newest page again a second after the feed moves", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => ({ ok: true, result: { entries: [saved(1, "Only answer")] } }));
  const client = { request };
  await show(client, undefined, 0);
  expect(request).toHaveBeenCalledTimes(1);
  await rerender(transcript(client, undefined, 1));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(WATCH_SETTLE_MS));
  expect(request).toHaveBeenCalledTimes(2);
});

it("keeps every turn read after paging back when the newest page moves on, and pages back once per click", async () => {
  vi.useFakeTimers();
  let newest = [saved(3, "Third"), saved(4, "Fourth")];
  const earlier: ((value: unknown) => void)[] = [];
  const request = vi.fn((_command: string, payload?: unknown) => {
    const before = (payload as { before?: number }).before;
    if (before === undefined) return Promise.resolve({ ok: true, result: { entries: newest, nextBefore: newest[0]!.seq } });
    return new Promise((resolve) => earlier.push(resolve));
  });
  const client = { request: request as never };
  const page = await show(client, undefined, 0);
  const loadEarlier = () =>
    act(async () => [...page.querySelectorAll("button")].find((button) => button.textContent === "Load earlier turns")!.click());
  await loadEarlier();
  await loadEarlier();
  expect(request.mock.calls.filter(([, payload]) => (payload as { before?: number }).before !== undefined)).toHaveLength(1);
  await act(async () => earlier[0]!({ ok: true, result: { entries: [saved(1, "First"), saved(2, "Second")] } }));
  // Two more turns saved: the newest page is now 5–6, and 3–4 must stay.
  newest = [saved(5, "Fifth"), saved(6, "Sixth")];
  await rerender(transcript(client, undefined, 1));
  await act(async () => vi.advanceTimersByTime(WATCH_SETTLE_MS));
  expect([...page.querySelectorAll(".worker-turn")].map((turn) => turn.querySelector(".text")?.textContent)).toEqual([
    "assistant: First",
    "assistant: Second",
    "assistant: Third",
    "assistant: Fourth",
    "assistant: Fifth",
    "assistant: Sixth",
  ]);
  expect(page.textContent).not.toContain("Load earlier turns");
});

it("starts the newest page over when more turns were saved than it joins", () => {
  const paged = { turns: [saved(1, "a"), saved(2, "b")], pagedBack: true, more: false };
  expect(mergeNewest(paged, [saved(3, "c")], 3).turns.map((turn) => turn.seq)).toEqual([1, 2, 3]);
  expect(mergeNewest(paged, [saved(9, "i")], 9)).toEqual({ turns: [saved(9, "i")], pagedBack: false, more: true });
  expect(mergeNewest({ ...paged, pagedBack: false }, [saved(2, "b"), saved(3, "c")], 2).turns.map((turn) => turn.seq)).toEqual([2, 3]);
});

it("takes Esc for itself: it closes the view and goes no further", async () => {
  const closed = vi.fn();
  const outer = vi.fn();
  window.addEventListener("keydown", outer);
  try {
    const page = await show({ request: async () => ({ ok: true, result: { entries: [] } }) }, closed);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => page.querySelector("h2")!.dispatchEvent(event));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", outer);
  }
});

it("closes a stream that opens only after the view is gone", async () => {
  let open: ((value: unknown) => void) | undefined;
  const close = vi.fn(async () => undefined);
  const subscribe = vi.fn(
    () =>
      new Promise((resolve) => {
        open = resolve;
      }),
  );
  await show({ request: async () => ({ ok: true, result: { entries: [] } }), subscribe: subscribe as never });
  unmountAll();
  await act(async () => open!({ response: { ok: true, result: {} }, subscription: { close } }));
  expect(close).toHaveBeenCalledTimes(1);
});

it("does not show a turn twice when the worker waits on a person and goes on", async () => {
  vi.useFakeTimers();
  let deliver: ((event: ClientEvent) => void) | undefined;
  const subscribe = vi.fn(async (_taskId: string, options: SubscribeOptions) => {
    deliver = options.onEvent;
    return { response: { ok: true, result: {} }, subscription: { close: async () => undefined } } as never;
  });
  const page = await show({ request: async () => ({ ok: true, result: { entries: [] } }), subscribe });
  const envelope = { epoch: "e1", runId: "w1", attemptId: "a1", at: "2026-10-04T00:00:00.000Z" };
  await act(async () => {
    deliver!({ ...envelope, sequence: 0, kind: "run.started", threadId: "th", workspaceId: "default" } as ClientEvent);
    deliver!({ ...envelope, sequence: 1, kind: "text.delta", blockId: "b1", text: "Before the wait" } as ClientEvent);
    deliver!({ ...envelope, sequence: 2, kind: "task.waiting", on: "a reply", deadlineAt: "2026-10-05T00:00:00.000Z" } as ClientEvent);
  });
  // Waiting is a saved turn's end: nothing live.
  expect(page.querySelector(".worker-live")).toBeNull();
  await act(async () => {
    deliver!({ ...envelope, attemptId: "a2", sequence: 3, kind: "run.started", threadId: "th", workspaceId: "default" } as ClientEvent);
    deliver!({ ...envelope, attemptId: "a2", sequence: 4, kind: "text.delta", blockId: "b2", text: "After the wait" } as ClientEvent);
  });
  const live = page.querySelector(".worker-live")?.textContent ?? "";
  expect(live).toContain("After the wait");
  expect(live).not.toContain("Before the wait");
});

it("follows a running worker's stream live, and reads its history again once the turn ends", async () => {
  vi.useFakeTimers();
  let deliver: ((event: ClientEvent) => void) | undefined;
  const close = vi.fn(async () => undefined);
  const subscribe = vi.fn(async (_taskId: string, options: SubscribeOptions) => {
    deliver = options.onEvent;
    return { response: { ok: true, result: {} }, subscription: { close } } as never;
  });
  const request = vi.fn(async () => ({ ok: true, result: { entries: [] } }));
  const page = await show({ request, subscribe });
  expect(subscribe).toHaveBeenCalledWith("w1", expect.objectContaining({ from: "beginning" }));
  expect(page.textContent).toContain("Nothing saved yet");
  const envelope = { epoch: "e1", runId: "w1", attemptId: "a1", at: "2026-10-04T00:00:00.000Z" };
  await act(async () => {
    deliver!({ ...envelope, sequence: 0, kind: "run.started", threadId: "th", workspaceId: "default" } as ClientEvent);
    deliver!({ ...envelope, sequence: 1, kind: "text.delta", blockId: "b1", text: "Looking into it" } as ClientEvent);
  });
  expect(page.querySelector(".worker-live")?.textContent).toContain("Looking into it");
  expect(page.querySelector(".worker-live")?.textContent).toContain("Working…");
  // A worker has no chat panel: its plan shows in its own view while it works.
  await act(async () => {
    deliver!({
      ...envelope,
      sequence: 2,
      kind: "tool.started",
      callId: "p1",
      toolName: "plan.update",
      input: { items: [{ content: "Read the sources", status: "in_progress" }] },
    } as ClientEvent);
    deliver!({ ...envelope, sequence: 3, kind: "tool.completed", callId: "p1", toolName: "plan.update", output: "ok" } as ClientEvent);
  });
  expect(page.querySelector('[aria-label="plan"]')?.textContent).toContain("◐ Read the sources");
  await act(async () => deliver!({ ...envelope, sequence: 4, kind: "task.completed", finalText: "Looking into it" } as ClientEvent));
  expect(page.querySelector(".worker-live")).toBeNull();
  await act(async () => vi.advanceTimersByTime(500));
  expect(request).toHaveBeenCalledTimes(2);
  unmountAll();
  expect(close).toHaveBeenCalled();
});

it("reads an agent's final answer as Markdown, never its raw marks", async () => {
  await markdownReady;
  const page = await mount(<FinalText text={"- **Comfortable walking shoes**\n- A light jacket"} label="Packer" />);
  expect(page.querySelector(".worker-final li strong")?.textContent).toBe("Comfortable walking shoes");
  expect(page.textContent).not.toContain("**");
});
