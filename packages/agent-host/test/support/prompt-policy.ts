import type { PromptSelectionPolicy } from "@tavi/contracts";

import { DEFAULT_SYSTEM_PROMPT, SHIPPED_SYSTEM_PROMPT_VERSION } from "../../src/prompts/system-prompt.js";

/** The selection policy a fixture task is bound under: the shipped default prompt. */
export const fixturePromptPolicy: PromptSelectionPolicy = {
  builtin: { text: DEFAULT_SYSTEM_PROMPT, version: SHIPPED_SYSTEM_PROMPT_VERSION },
};
