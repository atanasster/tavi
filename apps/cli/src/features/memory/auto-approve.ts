import { effectiveMemorySettings, type MemoryServicePort, type PersistencePort, type TaskOrigin } from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { autoApproveProposal, type AutoApproveDraftVector, type AutoApproveSource } from "@tavi/agent-host/workflow";

/**
 * Auto-approve on the owner: after a turn's `memory.propose` calls, and after an idle review,
 * each new proposal of a kind the operator ticked under *Keep without
 * asking* is kept at once — with the operator's authority and the review note
 * `auto-approve (settings revision N)` — when the host finds the rule holds
 * (`autoApproveProposal`): the chat and the proposal are the workspace
 * operator's own; the chat is attended (a Home, side or ordinary chat, never
 * a worker, a `run`, a routine's fire, a reminder, an agent's message or a
 * heartbeat tick); the turn is untainted — the chat had read no untrusted
 * data by then, in it or any turn before —
 * and not held to a messaging channel
 * (the operator's linked DM included); the words are ones the person typed
 * in one message of that turn or span; and it is no sensitive, reserved-key,
 * update, near-match or tidy-up proposal, nor one `memory.propose` stamped
 * with untrusted provenance (the call-time stamp is a
 * lower bound, so the turn's end state is read too). Anything else stays proposed. The
 * flush and consolidation never come here. The card that follows shows a
 * kept one as *Saved* with *Undo*.
 *
 * Decided after the turn is saved (its card's moment, `features/memory/cards.ts`), so
 * the turn's taint and channel are as the saved turn records them, and a
 * proposal made before a later tool read untrusted data in the same turn is
 * not kept either. Each proposal is judged by the admission that made it —
 * its saved turn's words, taint and channel — and waits when that turn
 * cannot be read, or when any later admission of the task up to the one
 * that ended it (a reply after the chat waited) was tainted or held to a
 * messaging channel.
 *
 * The kinds ticked are as they were when each proposal was filed
 * (`settingsNow`, which `features/memory/cards.ts` reads as `noteProposed` notes it)
 * and as they are at the turn's end, whichever is stricter: a kind
 * unticked meanwhile waits, as does one ticked only after the proposal was
 * made; the review note names the revision read when it was filed.
 *
 * Under hybrid recall (`draftVector`), a proposal that would otherwise be
 * kept is compared by meaning with the kept records of its kind too
 * (`related`'s kin, cosine ≥ 0.8), its words embedded under hybrid
 * recall's own rules; by words, always (Jaccard ≥ 0.5).
 */

/** Origins whose chats are not attended by the person (the automatic-capture exclusions). */
const UNATTENDED_ORIGINS: ReadonlySet<TaskOrigin> = new Set<TaskOrigin>([
  "messaging",
  "heartbeat",
  "ideas",
  "schedule",
  "reminder",
  "agent",
]);

export interface MemoryAutoApproveDependencies {
  readonly memory: Pick<MemoryServicePort, "get" | "history" | "related" | "approve">;
  readonly repositories: {
    readonly tasks: Pick<PersistencePort["repositories"]["tasks"], "get">;
    readonly transcripts: Pick<PersistencePort["repositories"]["transcripts"], "page">;
    readonly workspaceSettings: Pick<PersistencePort["repositories"]["workspaceSettings"], "get">;
  };
  /** The workspace's operator: the only person whose proposals are ever kept without asking. */
  readonly operatorOf: (workspaceId: string) => string | undefined;
  /** Under hybrid recall, a draft's vector by its rules (`hybridDraftVector`); absent, kin by words alone. */
  readonly draftVector?: (
    draft: Parameters<MemoryServicePort["propose"]>[0],
  ) => Promise<{ readonly modelKey: string; readonly vector: readonly number[] } | undefined>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

/** A turn's proposals, as `memory.propose` filed them. */
export interface MemoryAutoApproveTurn {
  readonly workspaceId: string;
  readonly principalId: string;
  /** The task whose turn ended: the chat itself, or a worker. */
  readonly runId: string;
  /** The admission that ended the turn, completed or failed. */
  readonly admissionId?: string | undefined;
  /** A worker's (a delegated task's) turn. */
  readonly worker: boolean;
  /** The turn was asked from a channel conversation. */
  readonly messaging: boolean;
  /**
   * Each proposal with the admission that made it — its saved turn holds the
   * person's words, its taint and its channel — and the settings when it was
   * filed (`settingsNow`): `null` when nothing was ticked then, or they could
   * not be read, so it waits; absent, the turn end's alone.
   */
  readonly proposals: readonly {
    readonly recordId: string;
    readonly admissionId?: string | undefined;
    readonly settings?: MemoryAutoApproveSettings | null | undefined;
  }[];
}

/** The kinds ticked under *Keep without asking*, and the settings revision that ticked them. */
export interface MemoryAutoApproveSettings {
  readonly kinds: readonly string[];
  readonly revision: number;
}

/** An idle review's proposals, each with its draft's `from`, and the person's words of its span. */
interface MemoryAutoApproveReview {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly taskId: string;
  readonly filed: readonly { readonly recordId: string; readonly from?: "person" | "assistant" | undefined }[];
  readonly personMessages: readonly string[];
}

export interface MemoryAutoApprove {
  /** The kinds ticked now, for a proposal being filed; undefined when none is or memory is paused. */
  settingsNow(workspaceId: string): Promise<MemoryAutoApproveSettings | undefined>;
  /** Keeps what the turn proposed that the rule allows; answers the ids kept. Never throws. */
  afterTurn(turn: MemoryAutoApproveTurn): Promise<readonly string[]>;
  /** Keeps what the review proposed that the rule allows; answers the ids kept. Never throws. */
  afterReview(review: MemoryAutoApproveReview): Promise<readonly string[]>;
}

const reasonOf = (error: unknown): string => errorMessage(error).slice(0, 200);

export function createMemoryAutoApprove(deps: MemoryAutoApproveDependencies): MemoryAutoApprove {
  /** The kinds ticked and the settings revision that ticked them; none when nothing is ticked or memory is paused. */
  const settingsOf = async (workspaceId: string): Promise<MemoryAutoApproveSettings | undefined> => {
    const record = await deps.repositories.workspaceSettings.get(workspaceId);
    const effective = effectiveMemorySettings(record.settings.memory);
    if (!effective.enabled || effective.autoApprove.length === 0) return undefined;
    return { kinds: effective.autoApprove, revision: record.revision };
  };

  /** Whether the chat is the operator's own and attended. */
  const chatOf = async (
    workspaceId: string,
    taskId: string,
    principalId: string,
  ): Promise<{ readonly operatorOwn: boolean; readonly attended: boolean; readonly operator?: string }> => {
    const operator = deps.operatorOf(workspaceId);
    const task = await deps.repositories.tasks.get(taskId);
    if (task === undefined) return { operatorOwn: false, attended: false };
    const operatorOwn =
      operator !== undefined && principalId === operator && task.principalId === operator && task.workspaceId === workspaceId;
    const attended =
      task.chatKind !== "worker" && task.chatKind !== "run" && (task.origin === null || !UNATTENDED_ORIGINS.has(task.origin));
    return { operatorOwn, attended, ...(operator === undefined ? {} : { operator }) };
  };

  /** A draft's vector for kin by meaning, charged to the chat it was proposed in. */
  const draftVectorIn = (taskId: string): AutoApproveDraftVector | undefined => {
    const draftVector = deps.draftVector;
    if (draftVector === undefined) return undefined;
    return async ({ actor, record, revision }) =>
      await draftVector({
        actor: { ...actor, runId: taskId, authority: "model" },
        scope: record.scope,
        kind: record.kind,
        ...definedOnly({
          title: revision.title,
          body: revision.body,
          preferenceKey: record.preferenceKey,
          preference: revision.preference,
        }),
      });
  };

  const keep = async (
    workspaceId: string,
    operator: string | undefined,
    recordIds: readonly { readonly recordId: string; readonly source: AutoApproveSource; readonly settings: MemoryAutoApproveSettings }[],
    taskId: string,
  ): Promise<readonly string[]> => {
    const kept: string[] = [];
    const refused: Record<string, number> = {};
    const draftVector = draftVectorIn(taskId);
    for (const { recordId, source, settings } of recordIds) {
      const outcome = await autoApproveProposal(deps.memory, {
        operator: { principalId: operator ?? "", workspaceId, caller: "auto-approve" },
        recordId,
        kinds: settings.kinds,
        settingsRevision: settings.revision,
        source,
        ...(draftVector === undefined ? {} : { draftVector }),
      });
      if (outcome.approved) kept.push(recordId);
      else refused[outcome.refusal] = (refused[outcome.refusal] ?? 0) + 1;
    }
    // Counts only, never memory text.
    deps.log("memory auto-approve ran", {
      workspaceId,
      taskId,
      kept: kept.length,
      ...Object.fromEntries(Object.entries(refused).map(([reason, count]) => [`waiting_${reason}`, count])),
    });
    return kept;
  };

  /**
   * The stricter of the settings when a proposal was filed and now: the kinds
   * ticked at both, under the revision read when it was filed. `null` then
   * (nothing ticked, or unreadable) leaves no kind.
   */
  const stricter = (now: MemoryAutoApproveSettings, filed: MemoryAutoApproveSettings | null | undefined): MemoryAutoApproveSettings => {
    if (filed === undefined) return now;
    if (filed === null) return { kinds: [], revision: now.revision };
    return { kinds: filed.kinds.filter((kind) => now.kinds.includes(kind)), revision: filed.revision };
  };

  return {
    async settingsNow(workspaceId) {
      return await settingsOf(workspaceId);
    },

    async afterTurn(turn) {
      if (turn.proposals.length === 0) return [];
      try {
        const settings = await settingsOf(turn.workspaceId);
        if (settings === undefined) return [];
        const chat = await chatOf(turn.workspaceId, turn.runId, turn.principalId);
        const { entries } = await deps.repositories.transcripts.page(turn.runId, { limit: 20 });
        const ended = turn.admissionId === undefined ? -1 : entries.findIndex((each) => each.admissionId === turn.admissionId);
        /** The proposing admission's saved turn, and whether it or any later one through the turn's end was tainted or held to messaging. Not found, it waits. */
        const sourceOf = (admissionId: string | undefined): AutoApproveSource => {
          const made = admissionId === undefined ? -1 : entries.findIndex((each) => each.admissionId === admissionId);
          const entry = entries[made];
          const span = made < 0 || ended < made ? [] : entries.slice(made, ended + 1);
          return {
            path: "tool",
            operatorOwn: chat.operatorOwn,
            attended: chat.attended,
            worker: turn.worker,
            tainted: span.length === 0 || span.some((each) => each.turn.tainted === true),
            messaging: turn.messaging || span.some((each) => each.turn.channel === "messaging"),
            personMessages:
              entry === undefined
                ? []
                : [
                    ...(entry.turn.prompt === undefined ? [] : [entry.turn.prompt]),
                    ...entry.turn.items.flatMap((item) => (item.kind === "steer" ? [item.text] : [])),
                  ],
          };
        };
        return await keep(
          turn.workspaceId,
          chat.operator,
          turn.proposals.map(({ recordId, admissionId, settings: filed }) => ({
            recordId,
            source: sourceOf(admissionId),
            settings: stricter(settings, filed),
          })),
          turn.runId,
        );
      } catch (error) {
        deps.log("memory auto-approve could not run; the proposals wait for the person", {
          workspaceId: turn.workspaceId,
          taskId: turn.runId,
          reason: reasonOf(error),
        });
        return [];
      }
    },

    async afterReview(review) {
      if (review.filed.length === 0) return [];
      try {
        const settings = await settingsOf(review.workspaceId);
        if (settings === undefined) return [];
        const chat = await chatOf(review.workspaceId, review.taskId, review.principalId);
        // The span the review read left out tainted and messaging turns already (`memoryReviewSpan`).
        const base = {
          path: "review" as const,
          operatorOwn: chat.operatorOwn,
          attended: chat.attended,
          worker: false,
          tainted: false,
          messaging: false,
          personMessages: review.personMessages,
        };
        return await keep(
          review.workspaceId,
          chat.operator,
          review.filed.map(({ recordId, from }) => ({ recordId, source: { ...base, ...(from === undefined ? {} : { from }) }, settings })),
          review.taskId,
        );
      } catch (error) {
        deps.log("memory auto-approve could not run; the proposals wait for the person", {
          workspaceId: review.workspaceId,
          taskId: review.taskId,
          reason: reasonOf(error),
        });
        return [];
      }
    },
  };
}
