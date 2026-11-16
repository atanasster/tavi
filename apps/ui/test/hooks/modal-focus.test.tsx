// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";

import { say, ANNOUNCER_ID } from "../../src/hooks/use-announce.js";
import { useModalFocus } from "../../src/hooks/use-modal-focus.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  document.body.replaceChildren();
});

function Modal({ active, name }: { readonly active: boolean; readonly name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(active, ref);
  return (
    <div ref={ref} role="dialog" tabIndex={-1} aria-modal={active ? "true" : undefined} data-name={name}>
      <button type="button">{name}</button>
    </div>
  );
}

function Page({ view, takeover }: { readonly view: boolean; readonly takeover: boolean }) {
  return (
    <>
      <header>
        <button type="button">Bar</button>
      </header>
      <div className="body">
        <div data-modal-backdrop="" />
        <Modal active={view} name="view" />
      </div>
      {takeover ? (
        <section>
          <Modal active name="takeover" />
        </section>
      ) : null}
    </>
  );
}

async function render(element: React.ReactNode): Promise<HTMLElement> {
  if (host === undefined || !host.isConnected) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root?.render(element));
  return host;
}

it("keeps a modal's backdrop and the live region out of the inert page", async () => {
  const region = document.body.appendChild(document.createElement("p"));
  region.id = ANNOUNCER_ID;
  const page = await render(<Page view takeover={false} />);
  expect(page.querySelector("header")?.hasAttribute("inert")).toBe(true);
  expect(page.querySelector("[data-modal-backdrop]")?.hasAttribute("inert")).toBe(false);
  expect(region.hasAttribute("inert")).toBe(false);
});

it("counts a modal opened over another: closing the top one leaves the page behind the first still inert", async () => {
  const page = await render(<Page view takeover={false} />);
  const header = page.querySelector("header")!;
  await render(<Page view takeover />);
  // The takeover, mounted while the view was modal, is not put behind it.
  const takeover = page.querySelector("section")!;
  expect(takeover.hasAttribute("inert")).toBe(false);
  expect(page.querySelector(".body")?.hasAttribute("inert")).toBe(true);
  expect(header.hasAttribute("inert")).toBe(true);
  await render(<Page view takeover={false} />);
  expect(header.hasAttribute("inert")).toBe(true);
  expect(page.querySelector(".body")?.hasAttribute("inert")).toBe(false);
  await render(<Page view={false} takeover={false} />);
  expect(header.hasAttribute("inert")).toBe(false);
});

it("puts what mounts beside it while it is open behind it too, and lets it go on close", async () => {
  const page = await render(<Page view takeover={false} />);
  const toast = document.body.appendChild(document.createElement("aside"));
  await act(async () => {
    await Promise.resolve();
  });
  expect(toast.hasAttribute("inert")).toBe(true);
  await render(<Page view={false} takeover={false} />);
  expect(toast.hasAttribute("inert")).toBe(false);
  expect(page.isConnected).toBe(true);
});

it("says two things written in one go together, and a repeat again after clearing it", async () => {
  const region = document.body.appendChild(document.createElement("p"));
  region.id = ANNOUNCER_ID;
  say("Saved.");
  say("Complete.");
  expect(region.textContent).toBe("Saved. Complete.");
  await Promise.resolve();
  say("Saved.");
  expect(region.textContent).toBe("Saved.");
  await Promise.resolve();
  say("Saved.");
  // Cleared now, written on the next frame: a screen reader hears it again.
  expect(region.textContent).toBe("");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(region.textContent).toBe("Saved.");
});
