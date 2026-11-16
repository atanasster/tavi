// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentTreeNode, AgentTreeResult } from "@tavi/contracts";
import { AGENT_TREE_FALLBACK_POLL_MS, AgentTree, foldableChildren, orderedTree } from "../../../src/features/workers/AgentTree.js";
import { WATCH_SETTLE_MS } from "../../../src/features/workers/WorkerView.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { button, click, mount, rerender, unmountAll } from "../../support/dom.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const at = "2026-09-20T00:00:00.000Z";
const node = (taskId: string, status = "completed", parentTaskId = "root"): AgentTreeNode => ({
  taskId,
  parentTaskId,
  status,
  depth: 1,
  createdAt: at,
  updatedAt: at,
});
const result = (nodes: AgentTreeNode[]): AgentTreeResult => ({
  workspaceId: "default",
  taskId: "root",
  nodes: [{ ...node("root", "running"), depth: 0 }, ...nodes],
  ancestors: ["ancestor"],
  truncated: false,
  ancestryUnknown: false,
});
/** The tree under `root`, read through `client`. */
const tree = (
  client: SettingsClient,
  onOpen = async (_id: string) => {},
  options: { readonly watch?: number; readonly onOpenWorker?: (node: AgentTreeNode) => void } = {},
) => (
  <InWorkspace timeZone="UTC" workspaceId="default" client={client}>
    <AgentTree taskId="root" version="1" watch={options.watch} onOpen={onOpen} onOpenWorker={options.onOpenWorker ?? (() => undefined)} />
  </InWorkspace>
);
const open = (...args: Parameters<typeof tree>): Promise<HTMLElement> => mount(tree(...args));
/** A press of the button in the tree reading `text`. */
const press = (text: string): Promise<void> => click(button(document.body, text));
it("folds only old successful children without unresolved descendants", () => {
  const nodes = [
    node("done"),
    node("parent"),
    node("running", "running", "parent"),
    node("failed", "failed"),
    { ...node("review"), needs: ["review" as const] },
  ];
  expect(foldableChildren(nodes, "root", Date.parse(at) + 29_999)).toEqual([]);
  expect(foldableChildren(nodes, "root", Date.parse(at) + 30_000)).toEqual(["done"]);
});
it("bounds folding to twenty per tick and retains failures until dismissed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(at) + 40_000);
  const page = await open({
    request: async () => ({
      ok: true,
      result: result([...Array.from({ length: 45 }, (_, i) => node(`done${i}`)), node("failed", "failed")]),
    }),
  });
  expect(page.textContent).toContain("Completed (20)");
  await act(async () => vi.advanceTimersByTime(1000));
  expect(page.textContent).toContain("Completed (40)");
  expect(page.textContent).toContain("Dismiss failed");
  await press("Dismiss failed");
  expect(page.textContent).not.toContain("Dismiss failed");
  await press("Completed (40)");
  expect(page.textContent).toContain("done0 — done0");
});
it("polls only a mounted visible tree, navigates ancestry, and routes child cancellation", async () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const request = vi.fn(async (_command: string, _payload?: unknown) => ({ ok: true, result: result([node("child", "running")]) }));
  const opened: string[] = [];
  const workers: string[] = [];
  await open(
    { request },
    async (id) => {
      opened.push(id);
    },
    { onOpenWorker: (worker) => workers.push(worker.taskId) },
  );
  // An ancestor is a chat; a worker opens its view-only transcript, never as a chat.
  await press("ancestor /");
  await press("child — child");
  expect(opened).toEqual(["ancestor"]);
  expect(workers).toEqual(["child"]);
  await press("Cancel child");
  expect(request).toHaveBeenCalledWith("cancel", { taskId: "child", reason: "Cancelled from canvas agent tree" });
  const before = request.mock.calls.length;
  hidden = true;
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(request).toHaveBeenCalledTimes(before);
  hidden = false;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(request).toHaveBeenCalledTimes(before + 1);
  // With no change feed, the slow fallback poll reads again.
  await act(async () => vi.advanceTimersByTime(AGENT_TREE_FALLBACK_POLL_MS));
  expect(request).toHaveBeenCalledTimes(before + 2);
  unmountAll();
  await act(async () => vi.advanceTimersByTime(AGENT_TREE_FALLBACK_POLL_MS));
  expect(request).toHaveBeenCalledTimes(before + 2);
});
it("rejects cross-workspace responses and recovers on the next poll", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => ({ ok: true, result: { ...result([node("child", "running")]), workspaceId: "other" } }));
  const page = await open({ request });
  expect(page.textContent).toContain("another task or workspace");
  expect(page.textContent).not.toContain("Cancel child");
  request.mockResolvedValue({ ok: true, result: result([node("child", "running")]) });
  await act(async () => vi.advanceTimersByTime(AGENT_TREE_FALLBACK_POLL_MS));
  expect(page.textContent).toContain("Cancel child");
});

it("keeps a truncated tree expanded because unseen descendants may still be active", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(at) + 40_000);
  const page = await open({ request: async () => ({ ok: true, result: { ...result([node("parent")]), truncated: true } }) });
  expect(page.textContent).toContain("parent — parent");
  expect(page.textContent).not.toContain("Completed (");
});

it("groups breadth-first results into contiguous subtrees", () => {
  const nodes = [
    node("root", "running", ""),
    node("a", "running"),
    node("b", "running"),
    node("a1", "running", "a"),
    node("b1", "running", "b"),
  ];
  expect(orderedTree(nodes).map((row) => row.taskId)).toEqual(["root", "a", "a1", "b", "b1"]);
  expect(orderedTree([node("a", "running", "b"), node("b", "running", "a")])).toHaveLength(2);
});
it("keeps parents visible during descendant grace periods and folds children first", () => {
  const parent = node("parent");
  const recent = { ...node("recent", "completed", "parent"), updatedAt: "2026-09-20T00:00:35.000Z" };
  expect(foldableChildren([parent, recent], "root", Date.parse(at) + 40_000)).toEqual([]);
  const children = Array.from({ length: 25 }, (_, i) => node(`child${i}`, "completed", "parent"));
  const folded = foldableChildren([parent, ...children], "root", Date.parse(at) + 40_000);
  expect(folded.slice(0, 20)).not.toContain("parent");
  expect(folded.at(-1)).toBe("parent");
});

it("follows the change feed instead of polling: it reads again only when the watch moves", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (_command: string, _payload?: unknown) => ({ ok: true, result: result([node("child", "running")]) }));
  const client = { request };
  await open(client, undefined, { watch: 0 });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(AGENT_TREE_FALLBACK_POLL_MS * 3));
  expect(request).toHaveBeenCalledTimes(1);
  // The feed's moves within a second are one read, a second after the first.
  const render = (watch: number) => rerender(tree(client, undefined, { watch }));
  await render(1);
  await render(2);
  await render(3);
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(WATCH_SETTLE_MS));
  expect(request).toHaveBeenCalledTimes(2);
});

it("keeps one tree read in flight, and runs one asked for meanwhile once it is answered", async () => {
  vi.useFakeTimers();
  const answers: ((value: unknown) => void)[] = [];
  const request = vi.fn((_command: string, _payload?: unknown) => new Promise((resolve) => answers.push(resolve)));
  await open({ request: request as never }, undefined, { watch: 0 });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => answers[0]!({ ok: true, result: result([]) }));
  expect(request).toHaveBeenCalledTimes(2);
});

it("shows a running worker's latest activity and an ended worker's final text, clipped with Show all", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(at) + 10_000);
  const long = `${"Found three flights. ".repeat(20)}The end.`;
  const page = await open(
    {
      request: async () => ({
        ok: true,
        result: result([
          { ...node("searcher", "running"), agentDefinitionId: "researcher", activity: { kind: "tool", text: "web.search" } },
          { ...node("writer", "running"), activity: { kind: "text", text: "Drafting the summary" } },
          { ...node("done", "completed"), agentDefinitionId: "booker", finalText: long, activity: { kind: "tool", text: "stale" } },
        ]),
      }),
    },
    undefined,
    { watch: 0 },
  );
  expect(page.textContent).toContain("researcher — searcher");
  expect(page.textContent).toContain("Using web.search");
  expect(page.textContent).toContain("Drafting the summary");
  expect(page.textContent).not.toContain("Using stale");
  expect(page.querySelector("li time")?.getAttribute("dateTime")).toBe(at);
  const final = page.querySelector(".worker-final p")?.textContent ?? "";
  expect(final.length).toBeLessThan(long.length);
  expect(final.endsWith("…")).toBe(true);
  await press("Show all");
  expect(page.querySelector(".worker-final p")?.textContent).toBe(long);
});
