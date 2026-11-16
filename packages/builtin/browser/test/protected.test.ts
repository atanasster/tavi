import { describe, expect, it, vi } from "vitest";

import type { Frame, Page } from "playwright";

import { type CdpFrameNode, frameCdpSession, nextCdpChildFrame, resolveCdpFrameNode } from "../src/cdp-world.js";
import { snapshotEntries } from "../src/protected.js";

describe("reading a field's aria snapshot for S-9", () => {
  it("reads a line YAML quotes whole, as it does a name holding a colon, the same as a plain one", () => {
    expect(snapshotEntries('- checkbox "I agree"')).toEqual([{ role: "checkbox", name: "I agree" }]);
    // Playwright's own output for a label with ": " (a clinic's health declaration).
    expect(snapshotEntries(`- 'checkbox "Health declaration: I have no symptoms of illness"'`)).toEqual([
      { role: "checkbox", name: "Health declaration: I have no symptoms of illness" },
    ]);
    expect(snapshotEntries(`- 'textbox "Patient''s history: medical"'`)).toEqual([{ role: "textbox", name: "Patient's history: medical" }]);
    expect(snapshotEntries(`- group:\n  - 'checkbox "Consent: treatment"'`)).toEqual([
      { role: "group", name: "" },
      { role: "checkbox", name: "Consent: treatment" },
    ]);
  });
});

describe("finding a frame's CDP node", () => {
  const tree: CdpFrameNode = {
    frame: { id: "main", url: "https://shop.example/" },
    childFrames: [{ frame: { id: "pay", url: "https://pay.example/widget", name: "pay" } }],
  };
  const frameAt = (url: string, name = ""): Frame => ({ url: () => url, name: () => name }) as unknown as Frame;
  const main = frameAt("https://shop.example/");
  const pageWith = (...frames: Frame[]): Page => ({ mainFrame: () => main, frames: () => [main, ...frames] }) as unknown as Page;

  it("finds a child frame by its place, name or address", () => {
    const pay = frameAt("https://pay.example/widget", "pay");
    expect(resolveCdpFrameNode(tree, pageWith(pay), pay)?.frame.id).toBe("pay");
    expect(resolveCdpFrameNode(tree, pageWith(pay), main)?.frame.id).toBe("main");
    // Listed in another place (a frame before it on the page): found by name, then by address.
    const other = frameAt("https://ads.example/");
    expect(resolveCdpFrameNode(tree, pageWith(other, pay), pay)?.frame.id).toBe("pay");
    const unnamed = frameAt("https://pay.example/widget");
    expect(resolveCdpFrameNode(tree, pageWith(other, unnamed), unnamed)?.frame.id).toBe("pay");
  });

  it("finds nothing, rather than the main frame, for a frame it cannot match", () => {
    const moved = frameAt("https://elsewhere.example/");
    expect(resolveCdpFrameNode(tree, pageWith(moved), moved)).toBeUndefined();
  });

  it("finds nothing for a frame whose name or address two frames share, when its place does not settle it", () => {
    const twins: CdpFrameNode = {
      frame: { id: "main", url: "https://shop.example/" },
      childFrames: [
        { frame: { id: "a", url: "https://pay.example/widget", name: "pay" } },
        { frame: { id: "b", url: "https://pay.example/widget", name: "pay" } },
      ],
    };
    const other = frameAt("https://ads.example/");
    const pay = frameAt("https://pay.example/widget", "pay");
    expect(resolveCdpFrameNode(twins, pageWith(other, other, pay), pay)).toBeUndefined();
    expect(resolveCdpFrameNode(twins, pageWith(pay), pay)?.frame.id).toBe("a");
  });
});

describe("opening a CDP session for a frame", () => {
  const sessionOf = (frameTree: CdpFrameNode, send?: () => Promise<unknown>) => ({
    send: send ?? (async () => ({ frameTree })),
    detach: vi.fn(async () => undefined),
  });
  const pageTree: CdpFrameNode = {
    frame: { id: "main", url: "https://shop.example/" },
    childFrames: [{ frame: { id: "same", url: "https://shop.example/inner" } }],
  };

  it("uses an out-of-process frame's own session, rooted at that frame", async () => {
    const main = { url: () => "https://shop.example/", name: () => "", parentFrame: () => null };
    const pay = { url: () => "https://pay.example/widget", name: () => "", parentFrame: () => main };
    const own = sessionOf({ frame: { id: "oopif", url: "https://pay.example/widget" } });
    const page = {
      mainFrame: () => main,
      frames: () => [main, pay],
      context: () => ({ newCDPSession: async (target: unknown) => (target === pay ? own : sessionOf(pageTree)) }),
    } as unknown as Page;
    const { cdp, node } = await frameCdpSession(page, pay as unknown as Frame);
    expect(cdp).toBe(own);
    expect(node?.frame.id).toBe("oopif");
  });

  it("finds an in-process frame in the page's tree, and detaches a session whose tree cannot be read", async () => {
    const main = { url: () => "https://shop.example/", name: () => "", parentFrame: () => null };
    const same = { url: () => "https://shop.example/inner", name: () => "", parentFrame: () => main };
    const pageSession = sessionOf(pageTree);
    const page = {
      mainFrame: () => main,
      frames: () => [main, same],
      context: () => ({
        newCDPSession: async (target: unknown) => {
          if (target !== page) throw new Error("not an out-of-process frame");
          return pageSession;
        },
      }),
    } as unknown as Page;
    expect((await frameCdpSession(page, same as unknown as Frame)).node?.frame.id).toBe("same");
    const broken = sessionOf(pageTree, async () => {
      throw new Error("target closed");
    });
    const failing = { ...page, context: () => ({ newCDPSession: async () => broken }) } as unknown as Page;
    await expect(frameCdpSession(failing)).rejects.toThrow("target closed");
    expect(broken.detach).toHaveBeenCalled();
  });
});

describe("following a hop into a cross-origin frame", () => {
  const node = (id: string, url: string, name = ""): CdpFrameNode => ({ frame: { id, url, name } });
  const root: CdpFrameNode = {
    frame: { id: "main", url: "https://shop.example/" },
    childFrames: [
      node("ad", "https://ads.example/slot", "slot"),
      node("pay", "https://pay.example/card", "card"),
      node("pay2", "https://pay.example/card2", "card"),
    ],
  };
  const hop = (iframeIndex: number, src: string, name = "") => ({
    __crossOriginFrame: true as const,
    iframeIndex,
    src,
    name,
    x: 0,
    y: 0,
    focused: false,
  });

  it("follows the frame at its address, wherever it sits among the children", () => {
    expect(nextCdpChildFrame(root, hop(1, "https://pay.example/card"))?.frame.id).toBe("pay");
    expect(nextCdpChildFrame(root, hop(0, "https://pay.example/card"))?.frame.id).toBe("pay");
    expect(nextCdpChildFrame(root, hop(5, "", "slot"))?.frame.id).toBe("ad");
  });

  it("refuses a frame matched only by its place, a partial address or a name two frames share", () => {
    expect(nextCdpChildFrame(root, hop(1, "https://pay.example/moved"))).toBeUndefined();
    expect(nextCdpChildFrame(root, hop(0, ""))).toBeUndefined();
    expect(nextCdpChildFrame(root, hop(1, "https://pay.example/"))).toBeUndefined();
    expect(nextCdpChildFrame(root, hop(1, "", "card"))).toBeUndefined();
  });
});
