// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { withParts } from "../../../src/features/welcome/WelcomeStepParts.js";
import { translateNow } from "../../../src/lib/i18n.js";
import { mount, unmountAll } from "../../support/dom.js";

/**
 * `withParts`: a translated sentence whose `{name}`s are elements, each put
 * where the template places it, the words around it kept as they are.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => unmountAll());

const tags = (root: HTMLElement): string[] => [...root.querySelectorAll("p > *")].map((element) => element.tagName);

describe("withParts", () => {
  it("puts each element in its place, with the words around it", async () => {
    const root = await mount(
      <p>
        {withParts("A {x} b {y}.", {
          x: <code>1</code>,
          y: <a href="https://example.com/">2</a>,
        })}
      </p>,
    );
    expect(root.querySelector("p")?.textContent).toBe("A 1 b 2.");
    expect(tags(root)).toEqual(["CODE", "A"]);
  });

  it("follows the template's order when a language reorders the parts", async () => {
    const root = await mount(
      <p>
        {withParts("{y} then {x}", {
          x: <code>1</code>,
          y: <a href="https://example.com/">2</a>,
        })}
      </p>,
    );
    expect(root.querySelector("p")?.textContent).toBe("2 then 1");
    expect(tags(root)).toEqual(["A", "CODE"]);
  });

  it("leaves a name with no part as written", async () => {
    const root = await mount(<p>{withParts("Run {cmd}", {})}</p>);
    expect(root.querySelector("p")?.textContent).toBe("Run {cmd}");
  });

  it("keeps the element names that text params leave in place", async () => {
    const message = translateNow("welcome.pairing.send", { time: "04:59" });
    expect(message).toContain("{code}");
    const root = await mount(
      <p>
        {withParts(message, {
          code: <code>ABC123</code>,
          target: "the bot",
        })}
      </p>,
    );
    expect(root.querySelector("p")?.textContent).toBe("Send ABC123 to the bot within 04:59.");
    expect(root.querySelector("code")?.textContent).toBe("ABC123");
  });
});
