import {
  SkillsBodyAnswerSchema,
  SkillsEditAnswerSchema,
  SkillsListAnswerSchema,
  SkillsShowAnswerSchema,
  SkillsTraceAnswerSchema,
  skillProposalChatOf,
  skillRegenerateMessage,
  type SkillActivation,
  type SkillsBodyAnswer,
  type SkillsEditAnswer,
  type SkillsListAnswer,
  type SkillsShowAnswer,
  type SkillsTraceAnswer,
  type SkillVersion,
  skillProvenanceForeign,
  skillUsageOf,
} from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { ask, read, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { operationKey } from "../routines/api.js";

/** Every version in the workspace, and what each skill has active. */
export function listSkills(client: SettingsClient, workspaceId: string): Promise<Outcome<SkillsListAnswer>> {
  return read(client, "skills", { action: "list", workspaceId }, SkillsListAnswerSchema);
}

/** One skill's versions, its active one, and its activation history. */
export function showSkill(client: SettingsClient, workspaceId: string, skillId: string): Promise<Outcome<SkillsShowAnswer>> {
  return read(client, "skills", { action: "show", workspaceId, skillId }, SkillsShowAnswerSchema);
}

/** A version's text, with its parent version's for a diff. */
export function skillBody(
  client: SettingsClient,
  workspaceId: string,
  skillId: string,
  version: string,
): Promise<Outcome<SkillsBodyAnswer>> {
  return read(client, "skills", { action: "body", workspaceId, skillId, version }, SkillsBodyAnswerSchema);
}

/** An agent's proposal's source task, its tool calls condensed. */
export function skillTrace(
  client: SettingsClient,
  workspaceId: string,
  skillId: string,
  version: string,
): Promise<Outcome<SkillsTraceAnswer>> {
  return read(client, "skills", { action: "trace", workspaceId, skillId, version }, SkillsTraceAnswerSchema);
}

/** An agent's proposal, edited: a new proposed version that follows it, the proposal set aside. */
export function editSkill(
  client: SettingsClient,
  workspaceId: string,
  skillId: string,
  version: string,
  body: string,
): Promise<Outcome<SkillsEditAnswer>> {
  return read(client, "skills", { action: "edit", workspaceId, skillId, version, body }, SkillsEditAnswerSchema);
}

/**
 * Regenerate-with-feedback: the person's feedback, sent as their own message
 * to the chat the proposal came from (`reply`, the chat's own admission), so
 * the agent proposes again there. Answers the chat it went to.
 */
export async function sendSkillFeedback(
  client: SettingsClient,
  workspaceId: string,
  proposal: SkillVersion,
  feedback: string,
): Promise<Outcome<{ readonly taskId: string }>> {
  const taskId = skillProposalChatOf(proposal);
  if (taskId === undefined || proposal.manifest.proposal === undefined)
    return { ok: false, message: translateNow("center.skillsApi.noChat") };
  const sent = await ask(client, "reply", {
    workspaceId,
    taskId,
    text: skillRegenerateMessage(proposal, feedback),
    clientMessageId: `skill-feedback-${operationKey()}`,
  });
  return sent.ok ? { ok: true, value: { taskId } } : sent;
}

/** A proposal a chat's card asked the Skills page to open; taken once by the page that opens. */
let focusRequested: { readonly skillId: string; readonly version: string } | undefined;

/** Ask the Skills page to open this version when it next shows (a chat card's *Review*). */
export function requestSkillFocus(target: { readonly skillId: string; readonly version: string }): void {
  focusRequested = target;
}

/** The version a card asked to open, once: taking it clears it. */
export function takeSkillFocus(): { readonly skillId: string; readonly version: string } | undefined {
  const taken = focusRequested;
  focusRequested = undefined;
  return taken;
}

/** A decision on one version, or on a skill's activation. */
export type SkillDecision =
  | { readonly action: "approve" | "reject" | "activate" | "rollback"; readonly skillId: string; readonly version: string }
  | { readonly action: "disable"; readonly skillId: string };

/** Sends a decision, asserting the active version the page saw, so a change made meanwhile is refused rather than overwritten. */
export function decideSkill(
  client: SettingsClient,
  workspaceId: string,
  decision: SkillDecision,
  activeVersion: string | undefined,
): Promise<Outcome<unknown>> {
  const asserted =
    (decision.action === "activate" || decision.action === "disable" || decision.action === "rollback") && activeVersion !== undefined
      ? { expectedCurrentVersion: activeVersion }
      : {};
  return ask(client, "skills", { ...decision, workspaceId, ...asserted });
}

/**
 * A skill as the page lists it: its versions newest first, what it has active,
 * how often it was used (kept uses, the latest), and whether it is active yet
 * unused for `SKILL_UNUSED_DAYS`.
 */
export interface SkillEntry {
  readonly skillId: string;
  readonly name: string;
  readonly versions: readonly SkillVersion[];
  readonly active?: string;
  readonly uses: number;
  readonly lastUsedAt?: string;
  readonly unused: boolean;
}

/** The workspace's skills, by id, each with its versions newest first and its usage. */
export function skillEntries(answer: SkillsListAnswer, now: number = Date.now()): readonly SkillEntry[] {
  const activations = new Map(answer.activations.map((activation: SkillActivation) => [activation.skillId, activation]));
  const usageOf = skillUsageOf(answer, now);
  const byId = new Map<string, SkillVersion[]>();
  for (const version of answer.versions) byId.set(version.skillId, [...(byId.get(version.skillId) ?? []), version]);
  return [...byId.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([skillId, versions]) => {
      const ordered = [...versions].sort((a, b) => (a.importedAt < b.importedAt ? 1 : a.importedAt > b.importedAt ? -1 : 0));
      const current = activations.get(skillId)?.activeVersion;
      return {
        skillId,
        name: (ordered.find((version) => version.version === current) ?? ordered[0])?.manifest.name ?? skillId,
        versions: ordered,
        ...(current === undefined ? {} : { active: current }),
        ...usageOf(skillId),
      };
    });
}

/** Whether a version's provenance names another author than the operator (`skillProvenanceForeign`). */
export const foreignProvenance = skillProvenanceForeign;

/** One line of a diff: kept, added in the new version, or removed from its parent. */
export interface DiffLine {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
}

/** The most lines a diff compares; a longer pair is shown as the new text whole. */
const DIFF_MAX_LINES = 2_000;

/** A line diff of `before` → `after` by longest common subsequence, or `undefined` when either is too long to compare. */
export function lineDiff(before: string, after: string): readonly DiffLine[] | undefined {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return undefined;
  // The lines both share at the start and the end are kept as they are; only the middle is compared.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const left = a.slice(head, a.length - tail);
  const right = b.slice(head, b.length - tail);
  const width = right.length + 1;
  // One flat table: `table[i * width + j]` is the common length of `left[i..]` and `right[j..]`.
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1)
    for (let j = right.length - 1; j >= 0; j -= 1)
      table[i * width + j] =
        left[i] === right[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const lines: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same" as const, text }));
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push({ kind: "same", text: left[i]! });
      i += 1;
      j += 1;
    } else if (i < left.length && (j >= right.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
      lines.push({ kind: "removed", text: left[i]! });
      i += 1;
    } else {
      lines.push({ kind: "added", text: right[j]! });
      j += 1;
    }
  }
  for (const text of a.slice(a.length - tail)) lines.push({ kind: "same", text });
  return lines;
}
