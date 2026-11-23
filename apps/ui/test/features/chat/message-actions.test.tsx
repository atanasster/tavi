// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageActions } from "../../../src/features/chat/MessageActions.js";
import { initialRunState } from "@tavi/client/browser";
import { Canvas } from "../../../src/features/chat/Canvas.js";
import type { CanvasRun } from "../../../src/features/chat/store/types.js";
import { mount, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it("copies exact response text and reports clipboard failures", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const host = await mount(<MessageActions text={"Hello\nworld"} kind="response" />);
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(writeText).toHaveBeenCalledWith("Hello\nworld");
  expect(host.textContent).toContain("Copied");
  writeText.mockRejectedValue(new Error("denied"));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.textContent).toContain("Copy unavailable");
});

it("reads a response, stops it, and cancels speech on unmount", async () => {
  class Utterance {
    readonly text: string;
    constructor(text: string) {
      this.text = text;
    }
  }
  const speech = { speak: vi.fn(), cancel: vi.fn() };
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("speechSynthesis", speech);
  const host = await mount(<MessageActions text="A response" kind="response" readAloud />);
  const button = host.querySelectorAll<HTMLButtonElement>("button")[1]!;
  await act(async () => button.click());
  expect(speech.speak.mock.calls[0]?.[0].text).toBe("A response");
  expect(button.getAttribute("aria-label")).toBe("Stop reading");
  await act(async () => button.click());
  expect(button.getAttribute("aria-label")).toBe("Read aloud");
  await act(async () => button.click());
  const before = speech.cancel.mock.calls.length;
  unmountAll();
  expect(speech.cancel.mock.calls.length).toBe(before + 1);
});

it("submits attachment contents and clears the file chip after sending", async () => {
  const submit = vi.fn();
  const noop = () => {};
  const host = await mount(
    <Canvas
      state={{ connection: "ready", runs: [] }}
      session={undefined}
      onSubmit={submit}
      onDecide={noop}
      onAbort={noop}
      onExpand={noop}
    />,
  );
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = { name: "notes.txt", size: 11, type: "text/plain", arrayBuffer: async () => new TextEncoder().encode("hello world").buffer };
  Object.defineProperty(input, "files", { value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.querySelector(".attachment-list")?.textContent).toContain("notes.txt");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(submit).toHaveBeenCalledWith(expect.stringContaining("hello world"));
  expect(host.querySelector(".attachment-list")).toBeNull();
});

it("rewinds from a person's message after asking, and puts the message back in the box", async () => {
  const turn = (id: string, prompt: string): CanvasRun => ({
    id,
    prompt,
    run: { ...initialRunState({ taskId: "task-1" }), status: "completed" },
    roundCalls: {},
    deciding: undefined,
    aborting: false,
  });
  const runs = [turn("r1", "first message"), turn("r2", "second message")];
  const onRewind = vi.fn(async () => ({ ok: true as const, prompt: "first message" }));
  const noop = () => {};
  const host = await mount(
    <Canvas
      state={{ connection: "ready", runs }}
      session={{ key: "task-1", taskId: "task-1", title: "first message", status: "completed", runs }}
      onSubmit={noop}
      onDecide={noop}
      onAbort={noop}
      onExpand={noop}
      onRewind={onRewind}
    />,
  );
  const rewinds = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Rewind to here"]');
  expect(rewinds).toHaveLength(2);
  await act(async () => rewinds[0]!.click());
  // Nothing is taken back until it is confirmed, and the confirmation says how much goes.
  expect(onRewind).not.toHaveBeenCalled();
  expect(host.querySelector(".rewind-confirm")?.textContent).toContain("1 later turn");
  const confirm = [...host.querySelectorAll<HTMLButtonElement>(".rewind-confirm button")].find(
    (button) => button.textContent === "Rewind",
  )!;
  // Keyboard focus follows the question, and comes back to the button that asked it on Cancel.
  expect(document.activeElement).toBe(confirm);
  const cancel = [...host.querySelectorAll<HTMLButtonElement>(".rewind-confirm button")].find((button) => button.textContent === "Cancel")!;
  await act(async () => cancel.click());
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Rewind to here");
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(onRewind).not.toHaveBeenCalled();
  const reopened = [...host.querySelectorAll<HTMLButtonElement>(".rewind-confirm button")].find(
    (button) => button.textContent === "Rewind",
  )!;
  await act(async () => reopened.click());
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(onRewind).toHaveBeenCalledWith("r1");
  const box = host.querySelector<HTMLTextAreaElement>(".composer-box textarea")!;
  expect(box.value).toBe("first message");
  expect(document.activeElement).toBe(box);
});

it("offers no rewind while the chat's turn is still going", async () => {
  const running: CanvasRun = {
    id: "r1",
    prompt: "go",
    run: { ...initialRunState({ taskId: "task-1" }), status: "running" },
    roundCalls: {},
    deciding: undefined,
    aborting: false,
  };
  const noop = () => {};
  const host = await mount(
    <Canvas
      state={{ connection: "ready", runs: [running] }}
      session={{ key: "task-1", taskId: "task-1", title: "go", status: "working", runs: [running] }}
      onSubmit={noop}
      onDecide={noop}
      onAbort={noop}
      onExpand={noop}
      onRewind={vi.fn()}
    />,
  );
  expect(host.querySelector('button[aria-label="Rewind to here"]')).toBeNull();
});
