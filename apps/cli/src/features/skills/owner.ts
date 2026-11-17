/**
 * The `skills` IPC command on the owner: the CLI's `tavi skills` while `tavi
 * serve` holds the directory, and the canvas's Settings → Skills. Every
 * action is the operator's: it runs as the workspace's principal, attributed
 * to the page or the CLI, as memory review is.
 */
import {
  DEFAULT_WORKSPACE_ID,
  TaviError,
  condenseSkillTrace,
  type SkillActor,
  type SkillTraceSource,
  type SkillsBodyAnswer,
  type SkillsEditAnswer,
  type SkillsListAnswer,
  type SkillsPayload,
  type SkillsShowAnswer,
  type SkillsTraceAnswer,
  type SkillServicePort,
  type SkillRepositoryPort,
  type SkillVersion,
} from "@tavi/contracts";

import { answering, operatorActor } from "../../server/config-commands.js";
import type { IpcAnswer } from "../../shared/ipc-decisions.js";
import type { DatabaseClient } from "@tavi/runtime";

import { taskHistory } from "../tasks/history.js";
import { proposedSkillBodyProblem } from "./propose.js";

/** A task's tool calls as its stored history holds them (`taskHistory`), and its workspace; `undefined` for a task the store does not hold. */
export type TaskToolsReader = (taskId: string) => Promise<
  | {
      readonly workspaceId: string;
      readonly tools: readonly SkillTraceSource[];
      readonly partial: boolean;
    }
  | undefined
>;

export interface SkillsCommandDependencies {
  readonly service: Pick<SkillServicePort, "list" | "show" | "import" | "approve" | "reject" | "activate" | "disable" | "rollback">;
  readonly skills: Pick<SkillRepositoryPort, "getVersion" | "listActivations" | "listUsage">;
  readonly readArtifactBody: (artifactId: string) => Promise<Uint8Array | undefined>;
  /** The workspace's principal: the operator the owner acts as, or `undefined` for a workspace it does not serve. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  /** A proposal's source task's tool calls, for its trace; absent: `trace` is unavailable. */
  readonly readTaskTools?: TaskToolsReader;
  readonly now?: () => string;
  readonly fromBridge?: boolean;
}

/** A store's `TaskToolsReader`: the task's checkpointed calls, read as `tavi tasks <id>` reads them. */
export function storeTaskTools(store: DatabaseClient): TaskToolsReader {
  return async (taskId) => {
    const task = await store.getTask(taskId);
    if (task === undefined) return undefined;
    const executions = await store.asPort().repositories.executions.list(taskId);
    const history = await taskHistory(store, task, executions);
    return { workspaceId: task.workspaceId, tools: history.tools, partial: history.partial };
  };
}

/** The version id an edit files: `edited-` and the time to the second, made unique among the skill's versions. */
async function editedVersionId(deps: SkillsCommandDependencies, workspaceId: string, skillId: string, now: string): Promise<string> {
  const base = `edited-${now.replace(/[^0-9]/g, "").slice(0, 14)}`;
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if ((await deps.skills.getVersion(workspaceId, skillId, candidate)) === undefined) return candidate;
  }
}

/** A version of this workspace that the agent proposed, or the refusal saying it is not one. */
async function proposalOf(deps: SkillsCommandDependencies, workspaceId: string, skillId: string, version: string): Promise<SkillVersion> {
  const stored = await deps.skills.getVersion(workspaceId, skillId, version);
  if (stored === undefined || stored.scopeKey !== workspaceId)
    throw new TaviError("NOT_FOUND", `Skill ${skillId}@${version} does not exist`);
  if (stored.manifest.proposal === undefined)
    throw new TaviError("INVALID_INPUT", `${skillId}@${version} was not proposed by the agent: it has no source task`);
  return stored;
}

/** A version's bytes as text, or `undefined` when they are gone or not UTF-8. */
async function textOf(deps: SkillsCommandDependencies, version: SkillVersion): Promise<string | undefined> {
  const bytes = await deps.readArtifactBody(version.packageArtifactId);
  if (bytes === undefined) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function skillsOwnerCommand(
  deps: SkillsCommandDependencies,
  payload: SkillsPayload,
): Promise<IpcAnswer<SkillsListAnswer | SkillsShowAnswer | SkillsBodyAnswer | SkillsTraceAnswer | SkillsEditAnswer | unknown>> {
  return answering(async () => {
    const workspaceId = payload.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const principalId = deps.principalOf(workspaceId);
    // A workspace this owner does not serve would otherwise answer an empty, plausible-looking list.
    if (principalId === undefined)
      throw new TaviError("NOT_FOUND", `workspace ${workspaceId} is not configured on this owner`, { details: { workspaceId } });
    const actor: SkillActor = { principalId, workspaceId, caller: operatorActor(deps.fromBridge) };
    switch (payload.action) {
      case "list":
        return {
          versions: [...(await deps.service.list({ actor }))],
          activations: [...(await deps.skills.listActivations(workspaceId))],
          usage: [...(await deps.skills.listUsage(workspaceId))],
        } satisfies SkillsListAnswer;
      case "show": {
        const shown = await deps.service.show({ actor, skillId: payload.skillId });
        return {
          versions: [...shown.versions],
          ...(shown.activation === undefined ? {} : { activation: shown.activation }),
          history: [...shown.history],
        } satisfies SkillsShowAnswer;
      }
      case "body": {
        const version = await deps.skills.getVersion(workspaceId, payload.skillId, payload.version);
        if (version === undefined || version.scopeKey !== workspaceId)
          throw new TaviError("NOT_FOUND", `Skill ${payload.skillId}@${payload.version} does not exist`);
        const text = await textOf(deps, version);
        const parent =
          version.parentVersion === undefined
            ? undefined
            : await deps.skills.getVersion(workspaceId, payload.skillId, version.parentVersion);
        return {
          version,
          ...(text === undefined ? {} : { text }),
          ...(parent === undefined ? {} : { parentVersion: parent.version }),
        } satisfies SkillsBodyAnswer;
      }
      case "trace": {
        const proposal = await proposalOf(deps, workspaceId, payload.skillId, payload.version);
        const taskId = proposal.manifest.proposal?.taskId ?? "";
        if (deps.readTaskTools === undefined) throw new TaviError("UNAVAILABLE", "this owner cannot read a task's tool calls");
        const read = await deps.readTaskTools(taskId);
        // The evidence named a task of this workspace when it was filed; one gone since, or elsewhere, is not shown.
        if (read === undefined || read.workspaceId !== workspaceId)
          throw new TaviError("NOT_FOUND", `the task ${taskId} this proposal came from is no longer kept here`);
        const condensed = condenseSkillTrace(read.tools);
        return { taskId, calls: [...condensed.calls], more: condensed.more, partial: read.partial } satisfies SkillsTraceAnswer;
      }
      case "edit": {
        // The operator's edit of an agent's draft, before approving it: a new proposed version, never the draft rewritten.
        const proposal = await proposalOf(deps, workspaceId, payload.skillId, payload.version);
        if (proposal.reviewState !== "proposed")
          throw new TaviError(
            "INVALID_INPUT",
            `${payload.skillId}@${payload.version} is ${proposal.reviewState}: only a waiting proposal is edited`,
          );
        if (proposal.manifest.files !== undefined)
          throw new TaviError(
            "INVALID_INPUT",
            `${payload.skillId}@${payload.version} is a bundle of files: edit it as files and import it`,
          );
        const problem = proposedSkillBodyProblem(payload.body);
        if (problem !== undefined) throw new TaviError("INVALID_INPUT", problem);
        const before = await textOf(deps, proposal);
        if (before === payload.body) throw new TaviError("INVALID_INPUT", "the text is unchanged: approve the proposal as it is");
        const version = await editedVersionId(deps, workspaceId, payload.skillId, deps.now?.() ?? new Date().toISOString());
        const stored = await deps.service.import({
          actor,
          skillId: payload.skillId,
          version,
          // Its name, description and evidence are the proposal's: an edit changes the text, not where it came from.
          manifest: proposal.manifest,
          packageBody: new TextEncoder().encode(payload.body),
          provenance: proposal.provenance,
          parentVersion: proposal.version,
          alwaysReview: true,
        });
        // The draft is set aside, so one proposal waits, not two; `skillProposalEditedInto` says it was an edit, not a no.
        await deps.service.reject({ actor, skillId: payload.skillId, version: payload.version });
        return { version: stored, replaced: proposal.version } satisfies SkillsEditAnswer;
      }
      case "import":
        // A page never imports: its provenance would be the page's word, read as the operator's own.
        if (deps.fromBridge === true)
          throw new TaviError("NOT_AUTHORIZED", "a skill is imported with `tavi skills import`, not from the canvas");
        return await deps.service.import({
          actor,
          skillId: payload.skillId,
          version: payload.version,
          manifest: {
            name: payload.name,
            ...(payload.description === undefined ? {} : { description: payload.description }),
            ...(payload.allowedTools === undefined ? {} : { allowedTools: [...payload.allowedTools] }),
            ...(payload.compatibility === undefined ? {} : { compatibility: payload.compatibility }),
            ...(payload.files === undefined ? {} : { files: [...payload.files] }),
          },
          packageBody: new Uint8Array(Buffer.from(payload.packageBase64, "base64")),
          provenance: payload.provenance,
        });
      case "approve":
        return await deps.service.approve({ actor, skillId: payload.skillId, version: payload.version });
      case "reject":
        return await deps.service.reject({ actor, skillId: payload.skillId, version: payload.version });
      case "activate":
        return await deps.service.activate({
          actor,
          skillId: payload.skillId,
          version: payload.version,
          ...(payload.expectedCurrentVersion === undefined ? {} : { expectedCurrentVersion: payload.expectedCurrentVersion }),
        });
      case "disable":
        await deps.service.disable({
          actor,
          skillId: payload.skillId,
          ...(payload.expectedCurrentVersion === undefined ? {} : { expectedCurrentVersion: payload.expectedCurrentVersion }),
        });
        return { skillId: payload.skillId, disabled: true };
      case "rollback":
        return await deps.service.rollback({
          actor,
          skillId: payload.skillId,
          version: payload.version,
          ...(payload.expectedCurrentVersion === undefined ? {} : { expectedCurrentVersion: payload.expectedCurrentVersion }),
        });
    }
  });
}
