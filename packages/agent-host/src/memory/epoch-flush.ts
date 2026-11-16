import {
  MEMORY_PROVIDER_LIMITS,
  isQuotedDataMessage,
  memoryDraftsFrom,
  memoryEndDate,
  renderCaptureSpan,
  resolveMemoryValidUntil,
  selectCaptureSpan,
  type InvocationContext,
  type MemoryActor,
  type MemoryCaptureMessage,
  type MemoryDraft,
  type MemoryProvider,
  type MemoryRecord,
  type MemorySensitiveMode,
  type MemoryServicePort,
  type ModelPort,
  type ModelTarget,
  type WorkflowMessage,
} from "@tavi/contracts";

import { NO_CAPTURE_DROPS, fileCapturedDraft, type CaptureDropCounts } from "./memory-capture.js";
import { knownTitles, meteredMemoryHost, withinSignal } from "./provider-host.js";

/**
 * The pre-compaction flush: before a chat
 * rolls over into a new epoch, the workspace's memory provider reads the span
 * about to be folded (`capture`, `occasion: "rollover"`, with at most one
 * private model call) and proposes what in it is worth remembering — as
 * **proposed** memory records and chat notes, which wait in the Command
 * Center's review queue like any `memory.propose` (a model can propose, never
 * approve). It is not counted as a turn; what it proposed is shown in the
 * chat as one memory card per epoch.
 *
 * Bounded: one call, the span's words cut to `EPOCH_FLUSH_INPUT_CHARS`, its
 * answer to `EPOCH_FLUSH_MAX_OUTPUT_TOKENS`, at most `maxProposals` proposals.
 * Only the person's and the assistant's own words are read — never a tool's
 * result, which may quote a page or an email — and the proposals are only
 * proposals: a person decides each.
 *
 * Whether a rollover flushes at all is the workflow's (`flushBeforeRollover`
 * in `workflow/scope/core.ts`): not while memory is paused or capture is off, not in a
 * chat whose memory is off or that is private, a worker's, a messaging
 * conversation's or a background run's; it leaves out a turn that carried
 * untrusted data, a turn that came in from a messaging channel, and what was
 * said while the chat's memory was off; and it
 * claims the epoch's durable `flush` mark first, so an epoch is flushed at
 * most once across restarts (invariant 17). Its model is the
 * `extraction` role when bound and allowed.
 */

/** The most proposals one flush makes. */
export const EPOCH_FLUSH_MAX_PROPOSALS = 5;
/** How much of the folded span the flush reads, newest first. */
export const EPOCH_FLUSH_INPUT_CHARS = 24_000;
/** The flush's own answer, at most: a provider's call is capped here whatever it asks for. */
export const EPOCH_FLUSH_MAX_OUTPUT_TOKENS = 800;
/** How long the flush may hold the rollover up; past it, the rollover goes on without it. */
export const EPOCH_FLUSH_TIMEOUT_MS = 30_000;
/**
 * Transport metadata only, distinct from a run's step-indexed attempts and
 * from stage 2's summary call (`1_000_000`), so a scripted test model can
 * tell the flush apart.
 */
export const EPOCH_FLUSH_ATTEMPT_NUMBER = 1_000_001;
/**
 * Every flush call's attempt id starts with this, whatever `newId` makes: it
 * shares `purpose: "summary"` with the fold summary and the task summarizer,
 * so doctor's spend line and chat measurement tell it apart by it.
 */
export const EPOCH_FLUSH_ATTEMPT_PREFIX = "epoch-flush-attempt-";

export type EpochFlushProposal = {
  readonly kind: "fact" | "preference" | "lesson";
  readonly title?: string;
  readonly body: string;
  readonly scope: "everywhere" | "chat";
  /** A preference's key and value; always both on a preference, never on another kind. */
  readonly preference?: { readonly key: string; readonly value: string };
  /** A fact's topic key, when the draft gave one. */
  readonly topicKey?: string;
  /** A kept fact this draft updates (`MemoryDraft.updatesRecordId`), when the draft gave one. */
  readonly updatesRecordId?: string;
  /** Write-time search terms for the word index. */
  readonly keywords?: readonly string[];
  /** The end date the model gave, as written; resolved, and a past one dropped, when it is filed. */
  readonly validUntil?: string;
  readonly sensitive?: true;
  /** Whose words the draft says it rests on (a provider's hint): auto-approve refuses `assistant`, and never trusts `person` alone. */
  readonly from?: "person" | "assistant";
};

/**
 * The folded span as the flush reads it: the person's and the assistant's
 * words only, each cut to its share, the newest kept while the budget lasts
 * and shown in order. Earlier epoch summaries are left out: what they carry
 * was flushed when they were made. So are the runtime's quoted-data messages
 * in the person's role (`isQuotedDataMessage`): a notices block or a side
 * chat's background is untrusted, and never the person's to remember.
 */
function epochFlushSpan(
  folded: readonly WorkflowMessage[],
  maxChars = EPOCH_FLUSH_INPUT_CHARS,
): readonly Pick<MemoryCaptureMessage, "role" | "text">[] {
  const words = folded.flatMap((message) =>
    // A notices block, a side chat's background or a summary written as data is no one's word here.
    (message.role !== "user" && message.role !== "assistant") || isQuotedDataMessage(message)
      ? []
      : [{ role: message.role === "user" ? ("person" as const) : ("assistant" as const), text: message.text }],
  );
  return selectCaptureSpan(words, maxChars);
}

/** The flush's span as a provider renders it (`renderCaptureSpan`): what its call reads. */
export function renderEpochFlushInput(folded: readonly WorkflowMessage[], maxChars = EPOCH_FLUSH_INPUT_CHARS): string {
  return renderCaptureSpan(epochFlushSpan(folded, maxChars));
}

/** A validated draft (`MemoryDraft`) as the capture pipeline files it. */
export function proposalOf(draft: MemoryDraft): EpochFlushProposal {
  return {
    kind: draft.kind,
    body: draft.body,
    scope: draft.scope,
    ...(draft.title === undefined ? {} : { title: draft.title }),
    ...(draft.kind === "preference" && draft.preferenceKey !== undefined && draft.preferenceValue !== undefined
      ? { preference: { key: draft.preferenceKey, value: draft.preferenceValue } }
      : {}),
    ...(draft.kind === "fact" && draft.topicKey !== undefined ? { topicKey: draft.topicKey } : {}),
    ...(draft.kind === "fact" && draft.updatesRecordId !== undefined ? { updatesRecordId: draft.updatesRecordId } : {}),
    ...(draft.keywords === undefined || draft.keywords.length === 0 ? {} : { keywords: draft.keywords }),
    ...(draft.validUntil === undefined ? {} : { validUntil: draft.validUntil }),
    ...(draft.sensitive === true ? { sensitive: true as const } : {}),
    ...(draft.from === undefined ? {} : { from: draft.from }),
  };
}

/**
 * The provider that drafts a workspace's flush: an external one only with the `conversation` egress switch on (a
 * span is the person's words), else the built-in, told only the titles its switches let it receive (`knows`).
 */
export interface EpochFlushProvider {
  readonly provider: Pick<MemoryProvider, "capture">;
  readonly knows?: { readonly personal: boolean; readonly chat: boolean };
}

export interface EpochFlushInput {
  readonly models: ModelPort;
  readonly memory: MemoryServicePort;
  /** Who drafts from the span; one without `capture` proposes nothing. */
  readonly provider: EpochFlushProvider;
  /** The model the flush calls: the `extraction` role when bound and allowed, else the chat's route. */
  readonly target: ModelTarget;
  readonly invocation: InvocationContext;
  /** The epoch the rollover begins: the proposals' author names it. */
  readonly epoch: number;
  readonly folded: readonly WorkflowMessage[];
  readonly signal?: AbortSignal | undefined;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
  readonly maxProposals?: number;
  readonly timeoutMs?: number;
  /** The workspace's zone: a date-only `validUntil` holds through that day there. Absent: UTC. */
  readonly timeZone?: string;
  /** The workspace's `sensitive` setting: `"skip"` drops a sensitive draft, `"suggest"` files it marked. Absent: `"skip"`. */
  readonly sensitive?: MemorySensitiveMode;
}

/** `now`'s calendar date (YYYY-MM-DD) in `timeZone`; UTC when none is given or the platform does not know it. */
export function localCaptureDate(now: string, timeZone: string | undefined): string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return now.slice(0, 10);
  }
  return formatter.format(new Date(now));
}

/**
 * Run the flush: one bounded call, then each proposal through the memory
 * service's propose path, as the chat's (`chatTaskId`, else `runId`): the
 * workflow never calls it for a worker's fold, so a chat's own notes come
 * only from the chat's own turns. Throws when the call fails; a refused proposal is skipped. Each draft goes
 * through the capture pipeline (`memory-capture.ts`): one
 * carrying a secret, a sensitive one under `"skip"`, one already known, or a
 * near match of a record in force, is dropped and counted. Answers
 * how many were proposed, and their ids, for the chat's memory card,
 * and how many were dropped, for the log.
 */
export async function runEpochMemoryFlush(
  input: EpochFlushInput,
): Promise<{ readonly proposed: number; readonly recordIds: readonly string[]; readonly dropped: CaptureDropCounts }> {
  const { invocation } = input;
  const span = epochFlushSpan(input.folded);
  const capture = input.provider.provider.capture?.bind(input.provider.provider);
  if (span.length === 0 || capture === undefined) return { proposed: 0, recordIds: [], dropped: NO_CAPTURE_DROPS };
  const timeout = AbortSignal.timeout(input.timeoutMs ?? EPOCH_FLUSH_TIMEOUT_MS);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  const host = meteredMemoryHost({
    models: input.models,
    target: input.target,
    context: invocation,
    newId: input.newId,
    now: input.now,
    signal,
    attemptPrefix: EPOCH_FLUSH_ATTEMPT_PREFIX,
    attemptNumber: EPOCH_FLUSH_ATTEMPT_NUMBER,
    maxOutputTokens: EPOCH_FLUSH_MAX_OUTPUT_TOKENS,
    what: "the flush call",
    site: "epoch-flush",
    // The flush shares the fold's purpose: doctor and chat measurement tell it apart by its attempt prefix.
    purpose: "summary",
  });
  const maxProposals = Math.min(input.maxProposals ?? EPOCH_FLUSH_MAX_PROPOSALS, MEMORY_PROVIDER_LIMITS.draftsPerCapture);
  // The proposals' author: which epoch's flush wrote them.
  const actor: MemoryActor & { readonly runId: string } = {
    principalId: invocation.principalId,
    workspaceId: invocation.workspaceId,
    runId: invocation.runId,
    ...(invocation.agentDefinitionId === undefined ? {} : { agentId: invocation.agentDefinitionId }),
    caller: `epoch-flush:e${input.epoch}`,
    authority: "model",
  };
  // Read within the flush's deadline: a slow store never holds the rollover past it.
  const known = await withinSignal(
    knownTitles(input.memory, actor, input.provider.knows ?? { personal: true, chat: true }, input.provider.knows !== undefined, span),
    signal,
  );
  const answer = await withinSignal(
    capture(
      Object.freeze({
        // The span is folded as one: its words are dated by the flush, not one by one.
        span: Object.freeze(span.map((message) => Object.freeze({ ...message, at: input.now() }))),
        // Today's date in the workspace's zone, so a time-bound entry can be given its end date.
        today: localCaptureDate(input.now(), input.timeZone),
        known: Object.freeze(known),
        limits: Object.freeze({ maxProposals, bodyChars: MEMORY_PROVIDER_LIMITS.body }),
        policy: Object.freeze({ sensitive: input.sensitive ?? "skip" }),
        occasion: "rollover" as const,
        host,
        signal,
      }),
    ),
    signal,
  );
  const proposals = memoryDraftsFrom(answer, maxProposals).map(proposalOf);
  const { recordIds, dropped } = await fileCaptureProposals({
    memory: input.memory,
    proposals,
    knownRecordIds: known.map((entry) => entry.recordId),
    actor,
    chatTaskId: invocation.chatTaskId ?? invocation.runId,
    now: input.now,
    ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
  });
  return { proposed: recordIds.length, recordIds, dropped };
}

/**
 * File parsed drafts through the capture pipeline (`memory-capture.ts`):
 * each end date resolved by kind (a past one, or one that is no date, drops
 * the draft), then the secret, sensitive-topic and dedup rules. A chat-scoped draft becomes a durable note of
 * `actor.runId`'s chat; the rest are personal. A proposal the service
 * refuses (a bound, a quota) is skipped. A draft's `updatesRecordId` is
 * honoured only for a record among `knownRecordIds` (the `known` the capture
 * was shown) that is not sensitive; any other is filed as an ordinary draft.
 * Shared by the flush and the idle review.
 */
export async function fileCaptureProposals(input: {
  readonly memory: Pick<MemoryServicePort, "propose"> & Partial<Pick<MemoryServicePort, "get">>;
  readonly proposals: readonly EpochFlushProposal[];
  /** The records the capture was shown as `known`: the only ones a draft may update. */
  readonly knownRecordIds: readonly string[];
  readonly actor: MemoryActor & { readonly runId: string };
  /** The chat they came from, so the chat lists what it taught. */
  readonly chatTaskId: string;
  readonly now: () => string;
  readonly timeZone?: string;
  readonly sensitive?: MemorySensitiveMode;
}): Promise<{
  readonly recordIds: readonly string[];
  readonly dropped: CaptureDropCounts;
  readonly filed: readonly { readonly recordId: string; readonly from?: "person" | "assistant" }[];
}> {
  const { actor } = input;
  const recordIds: string[] = [];
  const filed: { recordId: string; from?: "person" | "assistant" }[] = [];
  const dropped = { ...NO_CAPTURE_DROPS };
  const updatable = new Set(input.knownRecordIds);
  for (const proposal of input.proposals) {
    const now = input.now();
    // An end date goes where its kind keeps it (a fact's `validTo`, a preference's or lesson's
    // `expiryAt`); one already past, or not a date, drops the draft.
    let endDate: { readonly validTo: string } | { readonly expiryAt: string } | undefined;
    if (proposal.validUntil !== undefined) {
      const resolved = resolveMemoryValidUntil(proposal.validUntil, now, input.timeZone);
      if (!resolved.ok) continue;
      endDate = memoryEndDate(proposal.kind, resolved.at);
    }
    let updateTarget: MemoryRecord | undefined;
    if (
      proposal.kind === "fact" &&
      proposal.updatesRecordId !== undefined &&
      updatable.has(proposal.updatesRecordId) &&
      input.memory.get !== undefined
    ) {
      try {
        const candidate = await input.memory.get({ actor, recordId: proposal.updatesRecordId });
        if (
          candidate.kind === "fact" &&
          candidate.status === "approved" &&
          candidate.sensitivity !== "sensitive" &&
          candidate.scope.kind !== "shared_workspace" &&
          (candidate.validFrom === undefined || candidate.validFrom <= now) &&
          (candidate.validTo === undefined || candidate.validTo > now) &&
          (candidate.expiryAt === undefined || candidate.expiryAt > now)
        ) {
          updateTarget = candidate;
        }
      } catch {
        // An unknown or unreadable target falls back to ordinary filing.
      }
    }
    const targetScope =
      updateTarget !== undefined
        ? {
            scope: updateTarget.scope,
            ...(updateTarget.scope.kind === "run_local" && updateTarget.durable === true ? { durable: true as const } : {}),
          }
        : proposal.scope === "chat"
          ? {
              scope: { kind: "run_local" as const, principalId: actor.principalId, workspaceId: actor.workspaceId, runId: actor.runId },
              durable: true as const,
            }
          : { scope: { kind: "personal" as const, principalId: actor.principalId } };
    const topicKey = proposal.kind === "fact" ? (proposal.topicKey ?? updateTarget?.topicKey) : undefined;
    try {
      const outcome = await fileCapturedDraft(
        input.memory,
        {
          actor,
          ...targetScope,
          originTaskId: input.chatTaskId,
          kind: proposal.kind,
          body: proposal.body,
          ...(proposal.title === undefined ? {} : { title: proposal.title }),
          ...(proposal.preference === undefined
            ? {}
            : { preferenceKey: proposal.preference.key, preference: { valueType: "string" as const, value: proposal.preference.value } }),
          ...(topicKey === undefined ? {} : { topicKey }),
          ...(updateTarget === undefined ? {} : { supersedesRecordId: updateTarget.recordId }),
          ...(proposal.keywords === undefined || proposal.keywords.length === 0 ? {} : { keywords: proposal.keywords }),
          ...(endDate ?? {}),
          ...(proposal.sensitive === true ? { sensitivity: "sensitive" as const } : {}),
        },
        input.sensitive,
      );
      if (outcome.filed) {
        recordIds.push(outcome.record.recordId);
        filed.push({ recordId: outcome.record.recordId, ...(proposal.from === undefined ? {} : { from: proposal.from }) });
      } else dropped[outcome.dropped] += 1;
    } catch {
      // A proposal the service refuses (a bound, a quota) is skipped; the rest still go.
    }
  }
  return { recordIds, dropped, filed };
}
