import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";

import { isolatedSecretValue } from "../src/secrets.js";

/** A CDP session whose page shows one frame, answering `value` to the secret check. */
const sessionAnswering = (value: unknown) => ({
  send: vi.fn(async (method: string) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    return { result: { value } };
  }),
  detach: vi.fn(async () => undefined),
});

const pageWith = (child: object, attach: (target: unknown) => Promise<unknown>): Page => {
  const main = {};
  const page = { mainFrame: () => main, frames: () => [main, child] } as Record<string, unknown>;
  page["context"] = () => ({ newCDPSession: attach });
  return page as unknown as Page;
};

describe("checking every frame for a secret with a value", () => {
  it("reads an in-process frame with its page, and finds a secret in an out-of-process one", async () => {
    const inProcess = {};
    const clean = pageWith(inProcess, async (target) => {
      if (target === inProcess)
        throw new Error("This frame does not have a separate CDP session, it is a part of the parent frame's session");
      return sessionAnswering(false);
    });
    await expect(isolatedSecretValue(clean)).resolves.toBe(false);
    const widget = {};
    const filled = pageWith(widget, async (target) => sessionAnswering(target === widget));
    await expect(isolatedSecretValue(filled)).resolves.toBe(true);
  });

  it("answers unknown for a frame whose session cannot be opened or read", async () => {
    const closing = {};
    const unopened = pageWith(closing, async (target) => {
      if (target === closing) throw new Error("Target closed");
      return sessionAnswering(false);
    });
    await expect(isolatedSecretValue(unopened)).resolves.toBe("unknown");
    const unreadable = pageWith({}, async () => sessionAnswering(undefined));
    await expect(isolatedSecretValue(unreadable)).resolves.toBe("unknown");
  });
});
