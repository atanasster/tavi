import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import type { createOwnerBrowser } from "../../src/features/browser/host.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

type PlaywrightBrowserOptions = Parameters<typeof createOwnerBrowser>[0];

/**
 * The wiring production composes and tests' browser override skips: the
 * options the owner's browser is built with, and the signer `web_fetch` is
 * given. A guard each piece keeps on its own fails open if it is never
 * handed what it decides by.
 */
const built = vi.hoisted(() => ({
  browser: undefined as PlaywrightBrowserOptions | undefined,
  fetch: undefined as { readonly signRequest?: unknown } | undefined,
}));
const signer = vi.hoisted(() => (url: URL) => ({ "signature-input": `sig=("@authority");keyid="test";url="${url.host}"` }));

vi.mock("../../src/features/browser/host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/features/browser/host.js")>();
  return {
    ...actual,
    createOwnerBrowser: (options: PlaywrightBrowserOptions) => {
      built.browser = options;
      return createFixtureBrowser();
    },
    ownerRequestSigner: () => signer,
  };
});
vi.mock("@tavi/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tavi/runtime")>();
  return {
    ...actual,
    registerFetchTool: (
      registry: Parameters<typeof actual.registerFetchTool>[0],
      options: Parameters<typeof actual.registerFetchTool>[1],
    ) => {
      built.fetch = options;
      return actual.registerFetchTool(registry, options);
    },
  };
});

const directories = temporaryDirectories({ prefix: "tavi-browser-wiring-" });
const runtimes: TaviRuntime[] = [];
beforeEach(() => {
  built.browser = undefined;
  built.fetch = undefined;
});
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

async function compose(): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directories.create(), { approvalRequiredFor: [], browserAllowedHosts: ["shop.example"] }),
    { requireModelTransport: false },
  );
  runtimes.push(runtime);
  return runtime;
}

describe("the browser's production wiring", () => {
  it("asks the browser tools which frames a session may read: its page's own host, never another", async () => {
    await compose();
    const allowed = built.browser?.isFrameHostAllowed;
    expect(allowed).toBeDefined();
    expect(allowed?.("https://shop.example", "https://shop.example/cart", "default", "s1")).toBe(true);
    expect(allowed?.("https://evil.example", "https://shop.example/cart", "default", "s1")).toBe(false);
  });

  it("signs web_fetch with the operator's key, as the browser's documents are", async () => {
    await compose();
    expect(built.fetch?.signRequest).toBe(signer);
  });
});
