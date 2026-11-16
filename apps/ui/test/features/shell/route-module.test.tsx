// @vitest-environment jsdom
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lazyModule } from "../../../src/ui/lazy-module.js";
import { ViewBoundary } from "../../../src/ui/ViewBoundary.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

function Page({ name }: { readonly name: string }) {
  return <p>page {name}</p>;
}

async function mount(element: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

describe("lazyModule", () => {
  it("fetches its chunk the first time it is drawn, never before, and draws it without suspending from then on", async () => {
    let settle: ((component: typeof Page) => void) | undefined;
    const load = vi.fn(() => new Promise<typeof Page>((resolve) => (settle = resolve)));
    const page = lazyModule(load);
    expect(load).not.toHaveBeenCalled();

    const shown = await mount(
      <Suspense fallback={<p>loading</p>}>
        <page.Route name="a" />
      </Suspense>,
    );
    expect(shown.textContent).toBe("loading");
    await act(async () => settle?.(Page));
    expect(shown.textContent).toBe("page a");

    // A later draw of the same route reads the cached page in the same pass: no fallback.
    await act(async () => root?.unmount());
    root = createRoot(shown);
    act(() =>
      root?.render(
        <Suspense fallback={<p>loading</p>}>
          <page.Route name="b" />
        </Suspense>,
      ),
    );
    expect(shown.textContent).toBe("page b");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("throws a failed fetch to the page's boundary without fetching again on its own, and Try again fetches it again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = { left: 1 };
    const load = vi.fn(async () => {
      if (failing.left-- > 0) throw new Error("chunk unreachable");
      return Page;
    });
    const page = lazyModule(load);

    const shown = await mount(
      <ViewBoundary resetKey="route" onRetry={page.retry}>
        <Suspense fallback={<p>loading</p>}>
          <page.Route name="a" />
        </Suspense>
      </ViewBoundary>,
    );
    await act(async () => undefined);
    expect(shown.textContent).toContain("chunk unreachable");
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => shown.querySelector("button")?.click());
    await act(async () => undefined);
    expect(shown.textContent).toBe("page a");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ready() shares one fetch between callers and lets a test draw the page synchronously", async () => {
    const load = vi.fn(async () => Page);
    const page = lazyModule(load);
    await Promise.all([page.ready(), page.ready()]);
    expect(load).toHaveBeenCalledTimes(1);

    host = document.createElement("div");
    root = createRoot(host);
    act(() =>
      root?.render(
        <Suspense fallback={<p>loading</p>}>
          <page.Route name="now" />
        </Suspense>,
      ),
    );
    expect(host.textContent).toBe("page now");
  });
});
