import { act } from "react";

/** The value a `Select` shows (its trigger carries it). */
export const selected = (trigger: Element | null | undefined): string | undefined => trigger?.getAttribute("data-value") ?? undefined;

/** The options an open `Select` offers: each value, and whether it is disabled. */
export const offered = (): [string | null, boolean][] =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => [
    option.getAttribute("data-value"),
    option.getAttribute("aria-disabled") === "true",
  ]);

/** The words of each option an open `Select` offers. */
export const offeredWords = (): (string | null)[] =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent);

/** Closes an open `Select` without choosing. */
export async function close(): Promise<void> {
  const option = document.querySelector<HTMLElement>('[role="option"]');
  if (option === null) return;
  await act(async () => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
}

/** Opens a `Select` from the keyboard, as a person does. */
export async function open(trigger: Element | null | undefined): Promise<void> {
  if (!(trigger instanceof HTMLElement)) throw new Error("no select");
  // jsdom has no scrollIntoView; a test that stubs its own keeps it.
  Element.prototype.scrollIntoView ??= () => {};
  trigger.focus();
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
}

/** Chooses `value` in a `Select`: opens it and presses Enter on that option. */
export async function pick(trigger: Element | null | undefined, value: string): Promise<void> {
  await open(trigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.getAttribute("data-value") === value,
  );
  if (option === undefined) throw new Error(`no option ${value}`);
  await act(async () => {
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
