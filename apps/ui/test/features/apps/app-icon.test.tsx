// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import { AppIcon } from "../../../src/features/apps/AppIcon.js";
import { mount, rerender, unmountAll } from "../../support/dom.js";

/** An app's icon: the bridge's, else two letters. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppIcon", () => {
  it("loads an icon only from the bridge's plugin route", async () => {
    const served = await mount(<AppIcon name="Notes" icon={`/plugin-ui/acme.notes/${"a".repeat(64)}/assets/notes.svg`} />);
    expect(served.querySelector("img")?.getAttribute("src")).toBe(`/plugin-ui/acme.notes/${"a".repeat(64)}/assets/notes.svg`);
    unmountAll();
    for (const icon of ["https://tracker.example/icon.svg", "//tracker.example/icon.svg", undefined]) {
      const view = await mount(<AppIcon name="Home Assistant" icon={icon} />);
      expect(view.querySelector("img")).toBeNull();
      expect(view.textContent).toBe("HA");
      unmountAll();
    }
  });

  it("shows the letters when the icon fails to load", async () => {
    const view = await mount(<AppIcon name="Notes" icon="/plugin-ui/acme.notes/x/notes.svg" />);
    await act(async () => view.querySelector("img")?.dispatchEvent(new Event("error")));
    expect(view.querySelector("img")).toBeNull();
    expect(view.textContent).toBe("NO");
    // Another version's icon is tried again.
    await rerender(<AppIcon name="Notes" icon="/plugin-ui/acme.notes/y/notes.svg" />);
    expect(view.querySelector("img")?.getAttribute("src")).toBe("/plugin-ui/acme.notes/y/notes.svg");
  });
});
