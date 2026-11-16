// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { Command } from "../../src/ui/Command.js";
import { mountSettled as mount, unmountAll } from "../support/dom.js";
import { stylesheet } from "../css.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(unmountAll);

describe("a command shown inline", () => {
  it("reads and copies as typed, and breaks only between its words", async () => {
    const page = await mount(<Command>tavi reset --yes</Command>);
    const code = page.querySelector("code.command");
    expect(code?.textContent).toBe("tavi reset --yes");
    expect([...(code?.querySelectorAll(".command-word") ?? [])].map((word) => word.textContent)).toEqual(["tavi", "reset", "--yes"]);
    expect(stylesheet("layout.css")).toMatch(/\.command-word\s*\{\s*white-space:\s*nowrap;/);
  });
});
