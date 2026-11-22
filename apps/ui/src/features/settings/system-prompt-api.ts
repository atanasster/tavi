import type { SystemPromptAnswer } from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { ask, type SettingsClient } from "../../lib/ipc.js";
import { SETTINGS_BOUNDS } from "./common.js";

/**
 * The editable default system prompt.
 *
 * Two states, and the distinction is the whole point: `custom` is an override
 * the workspace saved, `default` is the shipped template. They can display the
 * *same string* — an override equal to the shipped text is still an override,
 * and clearing it is still a write — so the mode is tracked beside the text and
 * never inferred from it.
 */
export type SystemPromptMode = "custom" | "default";

/** The editor's saved state: what the workspace has now, as the draft is compared against. */
export interface SystemPromptState {
  readonly workspaceId: string;
  /** The revision a write must assert. */
  readonly revision: number;
  readonly mode: SystemPromptMode;
  /** The custom override's text, or the shipped text when the mode is `default`. */
  readonly text: string;
  readonly shipped: { readonly text: string; readonly templateVersion: string };
  /** True when this owner's adapter has an explicit prompt that outranks the setting. */
  readonly explicitAdapterShadowing: boolean;
}

/** The saved state an owner's answer describes. */
export function systemPromptState(answer: SystemPromptAnswer): SystemPromptState {
  return {
    workspaceId: answer.workspaceId,
    revision: answer.revision,
    mode: answer.custom === null ? "default" : "custom",
    text: answer.custom === null ? answer.shipped.text : answer.custom.text,
    shipped: answer.shipped,
    explicitAdapterShadowing: answer.explicitAdapterShadowing,
  };
}

/** Why a draft's text is not saveable, or `undefined` when it is. */
export function systemPromptProblem(mode: SystemPromptMode, text: string): string | undefined {
  // The shipped default is not the operator's to mistype: a `default` draft is a
  // staged reset and its text is shown read-only.
  if (mode === "default") return undefined;
  if (text.length === 0) return translateNow("settings.systemPrompt.empty");
  if (text.trim().length === 0) return translateNow("settings.systemPrompt.whitespace");
  return systemPromptLengthProblem(text);
}

/** Why instructions are too long to save — a system prompt's or a persona's, bounded alike — or `undefined`. */
export function systemPromptLengthProblem(text: string): string | undefined {
  return text.length > SETTINGS_BOUNDS.systemPrompt
    ? translateNow("settings.systemPrompt.tooLong", { max: SETTINGS_BOUNDS.systemPrompt, length: text.length })
    : undefined;
}

/** Whether the draft differs from what is saved, comparing mode *and* text. */
export function systemPromptDirty(
  saved: Pick<SystemPromptState, "mode" | "text">,
  draft: { readonly mode: SystemPromptMode; readonly text: string },
): boolean {
  if (draft.mode !== saved.mode) return true;
  return draft.mode === "custom" && draft.text !== saved.text;
}

export const systemPromptActions = {
  /** The saved override, the shipped default, and what a new task would select. */
  load: (client: SettingsClient, workspaceId: string) => ask<SystemPromptAnswer>(client, "system-prompt", { action: "get", workspaceId }),
  /**
   * Save the draft, asserting the revision it was based on.
   *
   * `expectedRevision` is passed explicitly rather than read here: a read
   * immediately before the write would only narrow the race, and the owner's
   * compare-and-set is what actually refuses a stale write.
   */
  save: (client: SettingsClient, workspaceId: string, text: string, expectedRevision: number) =>
    ask<SystemPromptAnswer>(client, "system-prompt", { action: "set", workspaceId, text, expectedRevision }),
  reset: (client: SettingsClient, workspaceId: string, expectedRevision: number) =>
    ask<SystemPromptAnswer>(client, "system-prompt", { action: "reset", workspaceId, expectedRevision }),
};
