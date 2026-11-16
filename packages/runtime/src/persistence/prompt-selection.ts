import {
  TaviError,
  type BoundTaskPromptSnapshot,
  type PromptSelectionPolicy,
  type TaskRecord,
  type WorkspaceSystemPromptRecord,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

/** Invoked inside admission/binding transactions with authoritative workspace settings. */
export function selectWorkerPrompt(
  task: TaskRecord,
  policy: PromptSelectionPolicy,
  boundAt: string,
  settings: WorkspaceSystemPromptRecord | undefined,
): BoundTaskPromptSnapshot {
  const base = { taskId: task.taskId, workspaceId: task.workspaceId, boundAt };
  if (policy.explicitPrompt !== undefined)
    return {
      ...base,
      source: "explicit",
      text: policy.explicitPrompt,
      hash: sha256Hex(policy.explicitPrompt),
      revision: null,
      templateVersion: null,
    };
  if (settings === undefined || (settings.text === null) !== (settings.hash === null)) {
    throw new TaviError("INTERNAL", "The stored workspace prompt is inconsistent");
  }
  if (settings.text !== null) {
    const digest = sha256Hex(settings.text);
    if (settings.hash !== digest) throw new TaviError("INTERNAL", "The stored workspace prompt does not hash to its text");
    return { ...base, source: "workspace", text: settings.text, hash: digest, revision: settings.revision, templateVersion: null };
  }
  const template = policy.builtin;
  return {
    ...base,
    source: "builtin",
    text: template.text,
    hash: sha256Hex(template.text),
    revision: null,
    templateVersion: template.version,
  };
}
