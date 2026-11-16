// @vitest-environment jsdom
import type { ProviderDeclaration, ProviderInstanceConfig } from "@tavi/contracts";
import { act, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/features/chat/Composer.js";
import { ProviderInstancesEditor } from "../../src/features/settings/ProviderInstancesEditor.js";
import { useResetOnChange } from "../../src/hooks/use-reset-on-change.js";
import { Select } from "../../src/ui/Select.js";
import { mount, rerender, unmountAll } from "../support/dom.js";

/** A list's rows keep their own controls when one is removed, a prop's change resets state in one render, and a timer ends with its owner. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const buttonNamed = (page: ParentNode, name: string): HTMLButtonElement | undefined =>
  [...page.querySelectorAll("button")].find((each) => each.textContent === name || each.getAttribute("aria-label") === name);

const DECLARATION = { id: "mail", kind: "channel", disclosure: "", settings: {}, credentials: [] } as unknown as ProviderDeclaration;
const instance = (id: string): ProviderInstanceConfig => ({
  id,
  factory: "mail",
  workspaceId: "default",
  accountId: "",
  settings: {},
  credentials: {},
});

function Instances() {
  const [instances, setInstances] = useState<ProviderInstanceConfig[]>([instance("first"), instance("second"), instance("third")]);
  return <ProviderInstancesEditor declarations={[DECLARATION]} instances={instances} onChange={setInstances} />;
}

describe("a removable list's keys", () => {
  it("keeps each provider instance's fieldset with its own row when an earlier one is removed or a row is edited", async () => {
    const page = await mount(<Instances />);
    const sets = () => [...page.querySelectorAll("fieldset")];
    const [, second, third] = sets();
    const idOf = (set: Element | undefined) => (set?.querySelector("input") as HTMLInputElement | null)?.value;
    // An edit carries the row's key to its copy: the same fieldset, not a new one.
    const field = second?.querySelector("input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "second-edited");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(sets()[1]).toBe(second);
    expect(idOf(sets()[1])).toBe("second-edited");
    await act(async () => buttonNamed(page, "Remove instance 1")?.click());
    // The same nodes, not equal-looking ones: `toEqual` would compare DOM nodes by their content.
    expect(sets()).toHaveLength(2);
    expect(sets()[0]).toBe(second);
    expect(sets()[1]).toBe(third);
    expect(sets().map(idOf)).toEqual(["second-edited", "third"]);
  });

  it("keeps each attachment's row with its own file when another one is removed", async () => {
    const page = await mount(
      <Composer disabled={false} placeholder="Message" onSubmit={() => undefined} onUpload={async () => "art"} onRetry={() => undefined} />,
    );
    const input = page.querySelector("input[type=file]") as HTMLInputElement;
    const pdf = (name: string) => new File([new TextEncoder().encode("%PDF-1.4\n%%EOF\n")], name, { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [pdf("a.pdf"), pdf("b.pdf")], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const rows = () => [...page.querySelectorAll(".attachment-list li")];
    const [, b] = rows();
    expect(b?.textContent).toContain("b.pdf");
    await act(async () => buttonNamed(page, "Remove a.pdf")?.click());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toBe(b);
  });
});

describe("useResetOnChange", () => {
  it("resets state in the render that sees the change, never on mount, and never commits the stale state", async () => {
    const committed: string[] = [];
    function Probe({ id }: { readonly id: string }) {
      const [picked, setPicked] = useState("kept");
      useResetOnChange([id], () => setPicked("reset"));
      useEffect(() => void committed.push(`${id}:${picked}`));
      return (
        <button type="button" onClick={() => setPicked("picked")}>
          {picked}
        </button>
      );
    }
    const page = await mount(<Probe id="one" />);
    await act(async () => page.querySelector("button")?.click());
    await rerender(<Probe id="one" />);
    await rerender(<Probe id="two" />);
    expect(committed).toEqual(["one:kept", "one:picked", "one:picked", "two:reset"]);
  });
});

describe("a timer started for an open select", () => {
  it("is cleared when the select unmounts before it fires", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
    // jsdom lays nothing out: the list's scroll is a no-op here.
    Element.prototype.scrollIntoView ??= () => undefined;
    const started = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const page = await mount(
      <Select aria-label="Pick" value="a" onChange={() => undefined}>
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    const trigger = page.querySelector<HTMLElement>('[role="combobox"]');
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const again = started.mock.results.find((_result, at) => started.mock.calls[at]?.[1] === 20)?.value;
    expect(again).toBeDefined();
    unmountAll();
    expect(cleared).toHaveBeenCalledWith(again);
  });
});
