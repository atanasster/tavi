// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { CanvasRun } from "../../../src/features/chat/store/types.js";
import type { PanelPlace } from "../../../src/features/shell/use-panel-layout.js";
import type { TakeoverTarget } from "../../../src/features/takeover/context.js";
import { useTakeoverState } from "../../../src/features/takeover/use-takeover-state.js";
import { mount, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A handoff opens the chat panel beside the transcript, where its live view helps. On a phone the
 * panel is a sheet over the transcript's lower half, and would cover the hand-over card's
 * **Take control** (QA 1801): there it stays as the person left it.
 */

const original = window.matchMedia;
afterEach(() => {
  unmountAll();
  window.matchMedia = original;
});

const asking = {
  waitId: "w1",
  deadlineAt: "2026-11-10T10:00:00.000Z",
  handoff: { sessionId: "s1", reason: "sign-in", instructions: "Sign in to the archive." },
} as unknown as CanvasRun["run"]["waiting"];

function Shell() {
  const [panel, setPanel] = useState<PanelPlace>({ open: false, tab: "activity" } as PanelPlace);
  useTakeoverState({
    liveClient: undefined,
    workspaceId: "default",
    current: { taskId: "t1" } as never,
    asking,
    openSession: undefined,
    setPanel,
    handoffs: undefined,
  });
  return <output data-open={panel.open} />;
}

async function panelOpenAt(width: number): Promise<boolean> {
  window.matchMedia = ((media: string) => ({
    media,
    matches: width <= Number(/max-width: (\d+)px/.exec(media)?.[1]),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  const page = await mount(<Shell />);
  return page.querySelector("output")?.dataset["open"] === "true";
}

describe("the chat panel when the open chat asks for the person in its browser", () => {
  it("opens beside the transcript on a wide window", async () => {
    expect(await panelOpenAt(1280)).toBe(true);
  });

  it("stays closed at phone width, leaving the hand-over card's Take control in reach", async () => {
    expect(await panelOpenAt(390)).toBe(false);
    unmountAll();
    expect(await panelOpenAt(320)).toBe(false);
  });
});

describe("Take control after the chat's turn has finished", () => {
  /** The chat panel's Take control for a chat `status`, its browser session `s1` kept or open. */
  async function takeHere(status: string): Promise<TakeoverTarget | undefined> {
    let opened: TakeoverTarget | undefined;
    function Probe() {
      const state = useTakeoverState({
        liveClient: { liveWatch: async () => ({ response: { ok: true } }) } as never,
        workspaceId: "default",
        current: { taskId: "t1", status } as never,
        asking: undefined,
        openSession: "s1",
        setPanel: () => undefined,
        handoffs: undefined,
      });
      opened = state.takeover;
      return <button type="button" onClick={state.takeOverHere} />;
    }
    const page = await mount(<Probe />);
    await act(async () => page.querySelector("button")?.click());
    return opened;
  }

  it("takes the page the finished turn kept, as a kept session with no turn to stop", async () => {
    expect(await takeHere("completed")).toEqual({ taskId: "t1", sessionId: "s1", kept: true });
  });

  it("takes a running chat's page as before", async () => {
    expect(await takeHere("working")).toEqual({ taskId: "t1", sessionId: "s1" });
  });
});
