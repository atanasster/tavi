/** The few locator calls `chooseOption` makes, so any Playwright locator fits. */
interface SelectLocator {
  click(): Promise<void>;
  page(): { locator(selector: string): { click(): Promise<void> } };
}

/**
 * Picks `value` in one of the canvas's shared Selects, which is a Radix listbox
 * rather than a native `<select>`: opens the trigger, then clicks the option
 * whose `data-value` is `value`. The open list is looked up on the whole page.
 */
export async function chooseOption(trigger: SelectLocator, value: string): Promise<void> {
  await trigger.click();
  await trigger.page().locator(`[role="option"][data-value="${value}"]`).click();
}
