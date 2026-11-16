// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Field } from "../../src/ui/Field.js";
import { click, mount } from "../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const control = (page: HTMLElement): HTMLInputElement => {
  const input = page.querySelector("input");
  if (input === null) throw new Error("no control");
  return input;
};
const described = (input: HTMLElement): string[] =>
  (input.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? `missing ${id}`);

describe("Field", () => {
  it("names its control by a generated id, and describes nothing it was not given", async () => {
    const page = await mount(
      <Field label="Name">
        <input />
      </Field>,
    );
    const input = control(page);
    const label = page.querySelector("label");
    expect(input.id).not.toBe("");
    expect(label?.htmlFor).toBe(input.id);
    expect(input.labels?.[0]?.textContent).toBe("Name");
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("keeps an id it is given, and the label's class", async () => {
    const page = await mount(
      <Field id="given" label="Name" labelClassName="visually-hidden">
        <input />
      </Field>,
    );
    expect(control(page).id).toBe("given");
    expect(page.querySelector("label.visually-hidden")?.getAttribute("for")).toBe("given");
  });

  it("describes the control by its hint, after any description it carries", async () => {
    const page = await mount(
      <>
        <p id="own">Own</p>
        <Field id="f" label="Name" hint="A hint" hintAs="span" hintClassName="meta-sm">
          <input aria-describedby="own" />
        </Field>
      </>,
    );
    const input = control(page);
    expect(described(input)).toEqual(["Own", "A hint"]);
    expect(page.querySelector("span.meta-sm")?.id).toBe("f-hint");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("marks the control invalid, described by its error, only while there is one", async () => {
    function Toggle() {
      const [wrong, setWrong] = useState(true);
      return (
        <>
          <Field label="Name" hint="A hint" error={wrong ? "Enter a name" : undefined}>
            <input />
          </Field>
          <button type="button" onClick={() => setWrong(false)}>
            Fix
          </button>
        </>
      );
    }
    const page = await mount(<Toggle />);
    const input = control(page);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(described(input)).toEqual(["A hint", "Enter a name"]);
    const error = page.querySelector(".failure");
    expect(error?.id).toBe(`${input.id}-error`);
    expect(error?.getAttribute("role")).toBeNull();

    await click(page.querySelector("button"));
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(described(input)).toEqual(["A hint"]);
    expect(page.querySelector(".failure")).toBeNull();
  });

  it("hands the wiring to a control written as a function", async () => {
    const page = await mount(
      <Field label="Secret" error="Paste the secret">
        {(wiring) => <input id={wiring.id} aria-describedby={wiring["aria-describedby"]} aria-invalid={wiring["aria-invalid"]} />}
      </Field>,
    );
    const input = control(page);
    expect(input.labels?.[0]?.textContent).toBe("Secret");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(described(input)).toEqual(["Paste the secret"]);
  });

  it("writes a space between its parts inline, and none otherwise", async () => {
    const inline = await mount(
      <p>
        <Field label="Quality" hint="Words" hintAs="span" inline>
          <input />
        </Field>
      </p>,
    );
    expect(inline.textContent).toBe("Quality  Words");
    const block = await mount(
      <Field label="Quality" hint="Words">
        <input />
      </Field>,
    );
    expect(block.textContent).toBe("QualityWords");
  });
});
