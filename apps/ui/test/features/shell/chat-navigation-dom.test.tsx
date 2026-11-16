// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { CanvasStore } from "../../../src/features/chat/store/types.js";
import type { Session } from "../../../src/features/shell/shell.js";
import { useChatNavigation } from "../../../src/features/shell/use-chat-navigation.js";
import { mountSettled as mount, unmountAll } from "../../support/dom.js";

afterEach(() => unmountAll());

/** The hook on a chat on screen, recording what each new chat is started from. */
async function navigation() {
  const started: { parent: string | undefined; options: unknown }[] = [];
  const store = {
    newTask: (parent?: string, options?: unknown) => started.push({ parent, options }),
  } as unknown as CanvasStore;
  let nav: ReturnType<typeof useChatNavigation> | undefined;
  const Probe = () => {
    nav = useChatNavigation({
      store,
      runs: [],
      route: "chat",
      view: "models",
      current: { taskId: "chat-1" } as Session,
      homeChat: false,
      navigate: () => undefined,
      setDraft: () => undefined,
      setPane: () => undefined,
      setPanel: () => undefined,
      setSeededIdea: () => undefined,
    });
    return null;
  };
  await mount(<Probe />);
  if (nav === undefined) throw new Error("the hook did not run");
  return { nav, started };
}

describe("useChatNavigation", () => {
  it("starts a side chat of the chat on screen, and a fresh chat from no parent at all", async () => {
    const { nav, started } = await navigation();
    await act(async () => nav.newSession());
    await act(async () => nav.newFreshSession());
    expect(started).toEqual([
      { parent: "chat-1", options: undefined },
      { parent: undefined, options: undefined },
    ]);
  });
});
