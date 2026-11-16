// @vitest-environment jsdom
import { initialRunState } from "@tavi/client/browser";
import type { ChatNotice } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { Canvas } from "../../../src/features/chat/Canvas.js";
import type { CanvasRun, CanvasState } from "../../../src/features/chat/store/types.js";
import { sessionsOf } from "../../../src/features/shell/shell.js";
import { TURN_GAP } from "../../../src/hooks/scroll.js";
import { button, click, mount, rerender } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

/**
 * A card posted into the chat — a `/remember`'s **Saved**, a side chat's result — is something new to read, as a
 * turn's answer is: a reader following the chat is taken to it rather than left above the fold.
 */

const noop = () => undefined;
const run = (id: string, prompt: string): CanvasRun => ({
  id,
  prompt,
  run: { ...initialRunState({ taskId: "task-1" }), status: "completed" },
  roundCalls: {},
  deciding: undefined,
  aborting: false,
  seq: 1,
});
const notice = (noticeId: string): ChatNotice => ({
  noticeId,
  taskId: "task-1",
  kind: "side-chat-settled",
  title: `Side chat ${noticeId} finished`,
  summary: "",
  afterSeq: 1,
  createdAt: "2026-11-03T08:00:00.000Z",
});

describe("the chat follows a card posted into it", () => {
  it("scrolls to a new notice card while the reader follows the chat", async () => {
    const state: CanvasState = { connection: "ready", runs: [run("saved-task-1-1", "first")] };
    const session = sessionsOf(state.runs).at(-1);
    const view = (notices: readonly ChatNotice[]) => (
      <InWorkspace>
        <Canvas state={state} session={session} notices={notices} onSubmit={noop} onDecide={noop} onAbort={noop} onExpand={noop} />
      </InWorkspace>
    );
    const host = await mount(view([]));
    const runs = host.querySelector<HTMLDivElement>(".runs");
    if (runs === null) throw new Error("no scroller");
    Object.defineProperty(runs, "scrollHeight", { value: 900, configurable: true });
    Object.defineProperty(runs, "clientHeight", { value: 400, configurable: true });
    await rerender(view([notice("n-1")]));
    expect(host.textContent).toContain("Side chat n-1 finished");
    expect(runs.scrollTop).toBe(900);
  });

  it("brings the message just sent into view, and offers the latest once the answer runs past the fold", async () => {
    const earlier = run("saved-task-1-1", "first");
    const { seq: _saved, ...unsaved } = run("op-2", "second");
    const sent: CanvasRun = { ...unsaved, run: { ...initialRunState({ taskId: "task-1" }), status: "running" } };
    const view = (runs: readonly CanvasRun[]) => {
      const state: CanvasState = { connection: "ready", runs: [...runs] };
      return (
        <InWorkspace>
          <Canvas state={state} session={sessionsOf(state.runs).at(-1)} onSubmit={noop} onDecide={noop} onAbort={noop} onExpand={noop} />
        </InWorkspace>
      );
    };
    const host = await mount(view([earlier]));
    const runs = host.querySelector<HTMLDivElement>(".runs");
    if (runs === null) throw new Error("no scroller");
    Object.defineProperty(runs, "scrollHeight", { value: 3000, configurable: true });
    Object.defineProperty(runs, "clientHeight", { value: 400, configurable: true });
    await rerender(view([earlier, sent]));
    const message = host.querySelector<HTMLElement>('[data-run="op-2"]');
    if (message === null) throw new Error("no message");
    message.getBoundingClientRect = () => ({ top: 1000 - runs.scrollTop }) as DOMRect;
    expect(button(host, "Jump to latest")).toBeUndefined();
    const answered: CanvasRun = {
      ...sent,
      run: { ...sent.run, transcript: [{ kind: "text", key: "t", attemptId: "a", blockId: "b", text: "a long answer" }] },
    };
    await rerender(view([earlier, answered]));
    expect(runs.scrollTop).toBe(1000 - TURN_GAP);
    const jump = button(host, "Jump to latest");
    await click(jump);
    expect(runs.scrollTop).toBe(3000);
    expect(button(host, "Jump to latest")).toBeUndefined();
  });
});
