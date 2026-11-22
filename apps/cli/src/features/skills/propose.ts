/**
 * `skills.propose`: the agent offers a procedure it just carried out as a
 * skill, for the person to review. It always lands `proposed` — never
 * approved, whatever else is set — with the task it came from and how its
 * outcome was checked, so the review weighs evidence, not the agent's word.
 *
 * At most five wait for review in a workspace, asked for or not: the person
 * reviews those first. A proposal waiting past 30 days is expired: it stays
 * the person's to approve or reject — nothing rejects it for them — but no
 * longer counts toward the five. Below that, one the person asked for is
 * always taken. On the agent's own initiative it is held to these limits:
 * never in a turn that read untrusted content, at most one per
 * conversation, none on a topic the person turned down in the last 30 days
 * (the same skill id, or a name that differs only in case, spacing or
 * punctuation), and none at all when the workspace says never suggest skills.
 * Either way its evidence names a task this workspace holds.
 */
import { sha256Hex } from "@tavi/node-kit";
import { z } from "zod";

import {
  MAX_PROPOSED_SKILL_BODY_CHARS,
  SKILL_DISMISSED_TOPIC_DAYS,
  SKILLS_PROPOSE_TOOL_ID,
  TaviError,
  UNTRUSTED_UNKNOWN_SOURCE,
  memoryProvenanceOf,
  skillProposalEditedInto,
  skillProposalExpired,
  skillReviewCommand,
  type InvocationContext,
  type SkillRepositoryPort,
  type SkillServicePort,
  type SkillVersion,
  type TaskRepositoryPort,
  englishOf,
  navPath,
} from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

export const SKILLS_PROPOSE_ID = SKILLS_PROPOSE_TOOL_ID;
/** The most proposals that wait for review in a workspace. */
const SKILL_PROPOSALS_PENDING_MAX = 5;
/** How long a turned-down proposal keeps its topic from being offered again. */
const SKILL_PROPOSAL_DISMISSED_DAYS = SKILL_DISMISSED_TOPIC_DAYS;
/** The longest proposed skill, in lines: one procedure, its pitfalls and how to check it. */
const SKILL_PROPOSAL_MAX_LINES = 500;

const SkillsProposeInputSchema = z.strictObject({
  skillId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .describe("A short id, lower case with hyphens; an existing skill's id proposes a new version of it"),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(500).describe("When the skill applies, in one sentence"),
  body: z
    .string()
    .min(1)
    .max(MAX_PROPOSED_SKILL_BODY_CHARS)
    .describe("The procedure as Markdown: its steps, its pitfalls, and how to check the result. Instructions only: no scripts"),
  evidence: z
    .strictObject({
      taskId: z.string().min(1).max(128).describe("The task whose outcome this encodes: this chat's id"),
      note: z.string().min(1).max(500).describe("How the outcome was checked: the person confirmed it, or a check passed"),
    })
    .describe("What shows the procedure worked"),
  requested: z.boolean().describe("true only when the person asked to save this as a skill"),
});

export interface SkillProposeOptions {
  readonly service: Pick<SkillServicePort, "import">;
  readonly skills: Pick<SkillRepositoryPort, "listVersions" | "getActivation">;
  /** The tasks the store knows: a proposal's evidence names one in the caller's workspace. */
  readonly tasks: Pick<TaskRepositoryPort, "get">;
  readonly now: () => string;
  /** The workspace's "Never suggest skills": unrequested proposals are refused. Absent: suggestions are on. */
  readonly suggestionsOff?: (workspaceId: string) => Promise<boolean>;
}

const isProposal = (version: SkillVersion): boolean => version.manifest.proposal !== undefined;

/**
 * Why a proposed skill's text is refused, or `undefined`: instructions only,
 * one procedure — at most `SKILL_PROPOSAL_MAX_LINES` lines, and no
 * `allowed-tools` it would claim. The agent's draft and the operator's edit of it alike.
 */
export function proposedSkillBodyProblem(body: string): string | undefined {
  if (body.split("\n").length > SKILL_PROPOSAL_MAX_LINES)
    return `a proposed skill is at most ${SKILL_PROPOSAL_MAX_LINES} lines: one procedure`;
  if (/^\s*allowed-tools\s*:/im.test(body)) return "a proposed skill cannot set allowed-tools; the person decides what a skill may call";
  return undefined;
}

/** A topic as a turned-down proposal is matched by: letters and digits only, lower case — `Weekly Report!` and `weekly-report` are both `weeklyreport`. */
function skillTopicKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function registerSkillProposeTool(registry: ToolRegistry, options: SkillProposeOptions): void {
  registry.register({
    id: SKILLS_PROPOSE_ID,
    sink: "persist",
    version: "1.0.0",
    description:
      "Offer a multi-step procedure you just carried out, and that worked, as a skill the person reviews before it is ever used. Use when the person asks to save how you did something, or after a task that took several steps (or a correction) and ended in clear success that no existing skill covers. Not for a short preference or rule (three lines or fewer): that is memory.propose. It always waits for review.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: SkillsProposeInputSchema,
    // Suggestions turned off: an unasked offer is refused before any card (the handler checks again).
    ...(options.suggestionsOff === undefined
      ? {}
      : {
          checkSources: async (input: unknown, context: InvocationContext) => {
            const parsed = SkillsProposeInputSchema.safeParse(input);
            if (parsed.success && !parsed.data.requested && (await options.suggestionsOff?.(context.workspaceId)) === true)
              return { refused: "The person turned skill suggestions off: offer a skill only when they ask for one." };
            // The gate takes a SHA-256 hex only: this binds the call to the proposal it was checked on.
            return { statuses: [], contentHash: sha256Hex(JSON.stringify([SKILLS_PROPOSE_ID, input])) };
          },
        }),
    handler: async ({ input, context, operationEnvelope, contextLabel }) => {
      const parsed = SkillsProposeInputSchema.parse(input);
      const workspaceId = context.workspaceId;
      const conversation = context.chatTaskId ?? context.runId;
      const refuse = (why: string): never => {
        throw new TaviError("NOT_AUTHORIZED", why);
      };
      // Instructions only, one procedure: no scripts, no tools it would claim.
      const problem = proposedSkillBodyProblem(parsed.body);
      if (problem !== undefined) throw new TaviError("INVALID_INPUT", problem);
      // The evidence is a task this workspace holds, not a name the model made up.
      const evidenceTask = await options.tasks.get(parsed.evidence.taskId);
      if (evidenceTask === undefined || evidenceTask.workspaceId !== workspaceId)
        throw new TaviError(
          "INVALID_INPUT",
          `evidence.taskId ${parsed.evidence.taskId} names no task in this workspace: give this chat's id`,
        );
      if (!parsed.requested) {
        if (operationEnvelope?.tainted === true)
          refuse("This turn read untrusted content: offer a skill only when the person asks for one.");
        if ((await options.suggestionsOff?.(workspaceId)) === true) refuse("The person turned skill suggestions off.");
      }
      const versions = await options.skills.listVersions({ scopeKey: workspaceId });
      const now = options.now();
      // An expired proposal still waits for the person, but no longer holds a place among the five.
      const pending = versions.filter(
        (version) => version.reviewState === "proposed" && isProposal(version) && !skillProposalExpired(version, now),
      );
      if (pending.length >= SKILL_PROPOSALS_PENDING_MAX)
        refuse(`${SKILL_PROPOSALS_PENDING_MAX} skills already wait for review: let the person review them first.`);
      if (!parsed.requested) {
        const offeredHere = versions.filter(
          (version) => version.provenance === `chat:${conversation}` && version.manifest.proposal?.requested === false,
        );
        if (offeredHere.length > 0) refuse("A skill was already offered in this conversation without being asked for.");
        const cutoff = Date.parse(now) - SKILL_PROPOSAL_DISMISSED_DAYS * 86_400_000;
        const topic = new Set([skillTopicKey(parsed.skillId), skillTopicKey(parsed.name)].filter((key) => key !== ""));
        const dismissed = versions.find(
          (version) =>
            (version.skillId === parsed.skillId ||
              topic.has(skillTopicKey(version.skillId)) ||
              topic.has(skillTopicKey(version.manifest.name))) &&
            version.reviewState === "rejected" &&
            isProposal(version) &&
            // Set aside by the person's edit of it, not turned down.
            skillProposalEditedInto(version, versions) === undefined &&
            Date.parse(version.reviewedAt ?? version.importedAt) >= cutoff,
        );
        if (dismissed !== undefined)
          refuse(`The person turned down ${dismissed.skillId} in the last ${SKILL_PROPOSAL_DISMISSED_DAYS} days.`);
      }
      // A new version of an existing skill follows its active one; the active one is never touched until approved and activated.
      const parentVersion = (await options.skills.getActivation(workspaceId, parsed.skillId))?.activeVersion;
      const version = `proposed-${now.replace(/[^0-9]/g, "").slice(0, 14)}`;
      // Asked for in a turn that read untrusted content: what it read goes with it, for the review to name.
      const untrusted = memoryProvenanceOf(contextLabel ?? (operationEnvelope?.tainted === true ? UNTRUSTED_UNKNOWN_SOURCE : undefined));
      const stored = await options.service.import({
        actor: { principalId: context.principalId, workspaceId, caller: "agent" },
        skillId: parsed.skillId,
        version,
        manifest: {
          name: parsed.name,
          description: parsed.description,
          proposal: {
            taskId: parsed.evidence.taskId,
            note: parsed.evidence.note,
            requested: parsed.requested,
            ...(untrusted === undefined ? {} : { untrusted }),
          },
        },
        packageBody: new TextEncoder().encode(parsed.body),
        provenance: `chat:${conversation}`,
        ...(parentVersion === undefined ? {} : { parentVersion }),
        alwaysReview: true,
      });
      return {
        skillId: stored.skillId,
        version: stored.version,
        reviewState: stored.reviewState,
        ...(parentVersion === undefined ? {} : { follows: parentVersion }),
        note: `It waits for the person's review (${englishOf(navPath("nav.route.commandCenter", "nav.center.identity"))}, or \`${skillReviewCommand(stored.skillId, stored.version)}\`). Tell them it is there, with that command; it is not used until they approve and activate it.`,
      };
    },
  });
}
