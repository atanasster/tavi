// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";

import { Confirm } from "../../src/ui/Confirm.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

/** WCAG 2.2 AA; colour contrast is checked from the tokens (`contrast.test.ts`). */
const AXE = {
  runOnly: { type: "tag" as const, values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  rules: { "color-contrast": { enabled: false } },
};

it("reads its warning with its title as it opens, focus on Cancel, and passes axe", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <Confirm
        title="Delete chat?"
        message="Its turns and files are gone for good."
        action="Delete"
        onConfirm={async () => undefined}
        onClose={() => undefined}
      />,
    ),
  );
  const dialog = host.querySelector("dialog")!;
  expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Delete chat?");
  expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("Its turns and files are gone for good.");
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect((await axe.run(host, AXE)).violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});
