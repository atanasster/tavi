// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copyDraft, copyText } from "../../src/lib/clipboard.js";
import { artifactMeta } from "../../src/lib/format.js";
import { useCopied } from "../../src/hooks/page.js";

/**
 * Copying: the one clipboard write, the note a refused save's draft gets, and
 * the copy button's check mark that clears itself.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const writes: string[] = [];
const clipboard = (allowed: boolean) =>
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => (allowed ? (writes.push(text), Promise.resolve()) : Promise.reject(new Error("denied"))) },
  });
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  writes.length = 0;
  Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
});

describe("copying", () => {
  it("says whether the browser took the text, never throwing", async () => {
    clipboard(true);
    expect(await copyText("a")).toBe(true);
    expect(writes).toEqual(["a"]);
    clipboard(false);
    expect(await copyText("b")).toBe(false);
  });

  it("tells the writer where a refused draft went", async () => {
    clipboard(true);
    expect(await copyDraft("draft")).toBe("The draft is on your clipboard.");
    clipboard(false);
    expect(await copyDraft("draft")).toBe("Could not copy the draft; select the text and copy it manually.");
  });

  it("shows a copy as done, then clears it after two seconds (or the failure delay)", async () => {
    vi.useFakeTimers();
    clipboard(true);
    let copier: ReturnType<typeof useCopied> | undefined;
    const onReset = vi.fn();
    function Copier() {
      copier = useCopied({ onReset, failedMs: 6000 });
      return null;
    }
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(<Copier />));
    const said = vi.fn();
    await act(async () => copier?.copy("text", said));
    expect(said).toHaveBeenCalledWith(true);
    expect(copier?.copied).toBe(true);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(copier?.copied).toBe(false);
    expect(onReset).toHaveBeenCalledTimes(1);

    clipboard(false);
    await act(async () => copier?.copy("text", said));
    expect(said).toHaveBeenLastCalledWith(false);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(onReset).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(4000));
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it("describes an artifact by type, size and review state", () => {
    expect(artifactMeta({ contentType: "text/plain", byteSize: 12, reviewState: "pending" })).toBe("text/plain, 12 bytes, pending");
  });
});
