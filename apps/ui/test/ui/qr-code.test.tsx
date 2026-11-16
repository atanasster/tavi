// @vitest-environment jsdom
import axe from "axe-core";
import { act, useRef } from "react";
import { encode } from "uqr";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyCommand, QrCode, claimedSenderLabel, pairingDeepLink, qrCodePath, shownPairingCode } from "../../src/ui/QrCode.js";
import { mount } from "../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis.navigator, "clipboard");
  window.getSelection()?.removeAllRanges();
});

/** WCAG 2.2 AA; colour contrast is checked from the tokens (`contrast.test.ts`). */
const AXE = {
  runOnly: { type: "tag" as const, values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  rules: { "color-contrast": { enabled: false } },
};

const link = "https://t.me/tavi_test_bot?start=4KX9-QM2P";

describe("QrCode and pairing helpers", () => {
  it("draws the encoder's dark modules, each a unit square at its own place", () => {
    const { data, size } = encode(link, { ecc: "M", border: 2 });
    const { path, size: drawn } = qrCodePath(link);
    expect(drawn).toBe(size);
    const squares = [...path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(([, x, y]) => `${x},${y}`);
    const dark = data.flatMap((row, y) => row.flatMap((on, x) => (on ? [`${String(x)},${String(y)}`] : [])));
    expect(squares).toEqual(dark);
    // Finder pattern corner inside the two-module quiet zone.
    expect(squares).toContain("2,2");
    expect(squares).not.toContain("0,0");
  });

  it("renders an accessible SVG image with dark modules on paper and passes axe", async () => {
    const container = await mount(<QrCode value={link} label="Scan to open the bot in Telegram" />);
    const code = container.querySelector('svg[role="img"]')!;
    expect(code.getAttribute("aria-label")).toBe("Scan to open the bot in Telegram");
    const expectedSize = qrCodePath(link).size;
    expect(code.getAttribute("viewBox")).toBe(`0 0 ${String(expectedSize)} ${String(expectedSize)}`);
    expect(code.classList.contains("qr-code")).toBe(true);
    expect(code.querySelector("path")?.classList.contains("qr-code-ink")).toBe(true);
    expect((await axe.run(container, AXE)).violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });

  it("changes with what it encodes and formats pairing codes, deep links, and sender labels", () => {
    expect(qrCodePath(link).path).not.toBe(qrCodePath(`${link}x`).path);
    expect(shownPairingCode("4KX9QM2P")).toBe("4KX9-QM2P");
    expect(shownPairingCode("4KX9-QM2P")).toBe("4KX9-QM2P");
    expect(claimedSenderLabel({ sender: "99887766", senderName: "Alice (@alice)" })).toBe("Alice (@alice) (99887766)");
    expect(claimedSenderLabel({ sender: "99887766" })).toBe("99887766");
    expect(claimedSenderLabel({})).toBe("");
    expect(pairingDeepLink({ linkUrl: link })).toBe(link);
    // Only an https address: the owner built it from the channel's reviewed template.
    expect(pairingDeepLink({ linkUrl: "javascript:alert(1)" })).toBeUndefined();
    expect(pairingDeepLink({ linkUrl: "http://t.me/tavi_test_bot" })).toBeUndefined();
    expect(pairingDeepLink({ linkUrl: "not a url" })).toBeUndefined();
    expect(pairingDeepLink({})).toBeUndefined();
  });

  it("copies the /link command and resets the 2-second timeout on re-click, or selects on clipboard refusal", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    function Harness() {
      const target = useRef<HTMLElement>(null);
      return (
        <div>
          <code ref={target}>/link 4KX9-QM2P</code>
          <CopyCommand text="/link 4KX9-QM2P" target={target} />
        </div>
      );
    }

    const container = await mount(<Harness />);

    const btn = container.querySelector("button")!;
    expect(btn.textContent).toBe("Copy /link command");

    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("/link 4KX9-QM2P");
    expect(btn.textContent).toBe("Copied");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Copied to clipboard");

    // Advance 1.5s and click again; the 2s window resets so after another 1s it is still "Copied".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
      btn.click();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(btn.textContent).toBe("Copied");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(btn.textContent).toBe("Copy /link command");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");

    // Clipboard failure selects the command and announces the fallback message.
    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(window.getSelection()?.toString()).toBe("/link 4KX9-QM2P");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Clipboard access was refused; the command is selected so you can copy it.",
    );
    expect(container.textContent).toContain("Clipboard access was refused; the command is selected so you can copy it.");
  });
});
