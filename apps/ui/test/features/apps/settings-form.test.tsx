// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import type { AppSettingField } from "@tavi/contracts";

import { SettingsForm } from "../../../src/features/apps/SettingsForm.js";
import { mount } from "../../support/dom.js";
import { close, offeredWords, open, pick } from "../../pick.js";

/** An app's settings, drawn by one renderer whatever the app. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIELDS: AppSettingField[] = [
  { key: "city", label: "City", type: "string", required: true, advanced: false, help: "Where to forecast" },
  { key: "endpoint", label: "Endpoint", type: "url", required: false, advanced: false },
  { key: "days", label: "Days", type: "number", required: false, default: 3, advanced: false },
  { key: "metric", label: "Metric", type: "boolean", required: false, default: true, advanced: false },
  {
    key: "mode",
    label: "Mode",
    type: "choice",
    required: false,
    choices: [
      { value: "poll", label: "Poll" },
      { value: "push", label: "Push" },
    ],
    advanced: false,
  },
  { key: "apiKey", label: "API key", type: "credential", required: true, advanced: false },
  { key: "hosts", label: "Hosts", type: "strings", required: false, advanced: false },
  { key: "debug", label: "Debug", type: "boolean", required: false, advanced: true },
];

const control = (view: HTMLElement, label: string) => {
  const id = [...view.querySelectorAll("label")].find((each) => each.textContent?.startsWith(label))?.getAttribute("for");
  return id === null || id === undefined ? null : view.ownerDocument.getElementById(id);
};

async function change(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SettingsForm", () => {
  it("draws each field by its type, with an advanced one under More settings", async () => {
    const view = await mount(<SettingsForm fields={FIELDS} busy={false} onSave={() => undefined} />);
    expect(control(view, "City")?.getAttribute("type")).toBe("text");
    expect(view.textContent).toContain("City (required)");
    expect(view.textContent).toContain("Where to forecast");
    expect(control(view, "Endpoint")?.getAttribute("type")).toBe("url");
    expect(control(view, "Days")?.getAttribute("placeholder")).toBe("Default: 3");
    expect((control(view, "Metric") as HTMLInputElement).checked).toBe(true);
    await open(control(view, "Mode"));
    expect(offeredWords()).toEqual(["Choose…", "Poll", "Push"]);
    await close();
    expect(control(view, "API key")?.getAttribute("placeholder")).toBe("Stored as a credential; leave empty to keep it");
    expect(view.textContent).toContain("A list: set it in Settings → Plugins.");
    expect(view.querySelector("details summary")?.textContent).toBe("More settings");
    expect(view.querySelector("details")?.contains(control(view, "Debug"))).toBe(true);
  });

  it("saves only what was changed, each as its type", async () => {
    const saved: Record<string, unknown>[] = [];
    const view = await mount(<SettingsForm fields={FIELDS} busy={false} onSave={(values) => saved.push({ ...values })} />);
    const save = [...view.querySelectorAll("button")].find((button) => button.textContent === "Save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await change(control(view, "City") as HTMLInputElement, "Sofia");
    await pick(control(view, "Mode"), "push");
    await act(async () => (control(view, "Metric") as HTMLInputElement).click());
    await act(async () => save.click());
    expect(saved).toEqual([{ city: "Sofia", mode: "push", metric: false }]);
  });

  it("leaves a field emptied again unsaved, and links each field to its help", async () => {
    const saved: Record<string, unknown>[] = [];
    const view = await mount(<SettingsForm fields={FIELDS} busy={false} onSave={(values) => saved.push({ ...values })} />);
    const days = control(view, "Days") as HTMLInputElement;
    await change(days, "5");
    await change(days, "");
    await change(control(view, "City") as HTMLInputElement, "Sofia");
    await change(control(view, "City") as HTMLInputElement, "");
    const save = [...view.querySelectorAll("button")].find((button) => button.textContent === "Save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const city = control(view, "City");
    expect(view.ownerDocument.getElementById(city?.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Where to forecast");
    // A list has no control: its name is not a label pointing at nothing.
    expect([...view.querySelectorAll("label")].some((label) => label.textContent?.startsWith("Hosts"))).toBe(false);
  });
});
