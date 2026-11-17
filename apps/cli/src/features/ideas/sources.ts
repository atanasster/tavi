import {
  IDEA_CAPABILITIES,
  IDEA_PREPARE_RUN_RESERVE_TOKENS,
  IDEA_PRESET_CAPABILITIES,
  isUntrusted,
  MEMORY_SEARCH_MAX,
  memoryExcerptHead,
  memoryRecordIsPast,
  TaviError,
  untrustedLabel,
  type ContentLabel,
  type WorkflowPort,
  type IdeaCapability,
  type IdeaTaskExcerpt,
  type MemoryExcerpt,
  type MemoryServicePort,
  type ModelPort,
  type MessagingConnectionRecord,
  type ModelTarget,
} from "@tavi/contracts";
import type { IdeasHostDependencies } from "@tavi/agent-host/ideas-host";
import { admitUnattended } from "@tavi/agent-host/unattended-admission";

import { mailboxToolPrefix } from "../apps/mailbox-catalog.js";
import { channelGrantsOf } from "../channels/catalog.js";

/**
 * What the ideas host gives a provider: the
 * capability census, the person's memory and their recent chats. Each read is
 * the narrowest that serves: own scopes, approved and normal-sensitivity
 * records that recall would use, never a run's own memory, and
 * only the chats the person had themself.
 */

/**
 * Each capability the host's own tools prove, and the tools that prove it: an
 * idea is never offered on a guess. `web` needs only `web_fetch`, which runs
 * without a search provider. What plugins bring (places, trends, travel, …) is
 * proven by what their tools and channels declare (`proves`); a mailbox by its
 * account's search tool. Tools registered for every workspace but answering
 * only in some — a mailbox account's, an MCP server's, one a workspace turned
 * off — and the channels are read per workspace (`IdeasCensusSettings`).
 */
const PROVEN_BY: Readonly<Partial<Record<IdeaCapability, (toolId: string) => boolean>>> = {
  web: (id) => id === "web_fetch",
  browser: (id) => id === "browser.navigate",
  memory: (id) => id === "memory.search",
  reminders: (id) => id.startsWith("reminders."),
  routines: (id) => id.startsWith("routines."),
  files: (id) => id === "fs.read",
  sandbox: (id) => id === "sandbox.run",
  pdf: (id) => id === "pdf.read",
  image: (id) => id === "artifacts.view_image",
  video: (id) => id === "video.view",
};

/** The MCP presets that prove a capability, once their server's tools are registered. */
const PRESET_CAPABILITY = IDEA_PRESET_CAPABILITIES;

/** A registered tool as the census reads it: its id, and what its plugin declared it proves. */
export interface IdeasCensusTool {
  readonly id: string;
  readonly proves?: readonly IdeaCapability[];
}

/** What the census reads beyond the tools: a workspace's settings and what is connected. */
export interface IdeasCensusSettings {
  /** Tools registered everywhere that answer nothing in this workspace (a domain tool it turned off): they prove nothing here. */
  readonly silentTools?: ReadonlySet<string>;
  /** The preset of each MCP server enabled and allowed in the workspace, by its slug (`mcp.<slug>`): proven only while its tools are registered. */
  readonly presets?: ReadonlyMap<string, string>;
  /** The search tool of each mailbox account enabled in the workspace (`mailboxToolPrefix(…) + "search"`): proven while one is registered. */
  readonly mailboxSearchTools?: ReadonlySet<string>;
  /** The list_events tool of each calendar account enabled in the workspace: proven while one is registered. */
  readonly calendarTools?: ReadonlySet<string>;
  /** What the channels with an enabled connection in the workspace declare they prove (their descriptors' `proves`). */
  readonly channels?: readonly (readonly IdeaCapability[])[];
}

/**
 * The account tools that prove a mailbox or a calendar, from a workspace's enabled connections: only a signed-in
 * account's. One added but never signed in (or whose sign-in lapsed) has its tools registered, yet answers nothing.
 */
export function accountCensusTools(
  connections: readonly Pick<MessagingConnectionRecord, "providerId" | "connectionId" | "authState">[],
  grantsOf: (providerId: string) => { readonly mailbox?: boolean; readonly calendar?: boolean } | undefined = channelGrantsOf,
): Pick<IdeasCensusSettings, "mailboxSearchTools" | "calendarTools"> {
  const signedIn = connections.filter((connection) => connection.authState === "connected");
  const toolsOf = (grant: "mailbox" | "calendar", tool: string): ReadonlySet<string> =>
    new Set(
      signedIn
        .filter((connection) => grantsOf(connection.providerId)?.[grant] === true)
        .map((connection) => `${mailboxToolPrefix(connection.providerId, connection.connectionId)}${tool}`),
    );
  // A mailbox is what a channel was granted (`app.mailbox` with its kit, as `serve` registers its tools); a calendar
  // is a Google account's, once its opt-in registered its tools.
  return { mailboxSearchTools: toolsOf("mailbox", "search"), calendarTools: toolsOf("calendar", "list_events") };
}

/** The capabilities a workspace has now, in the contract's order. */
export function ideasCensus(tools: Iterable<IdeasCensusTool>, settings: IdeasCensusSettings): readonly IdeaCapability[] {
  const answering = [...tools].filter((tool) => settings.silentTools?.has(tool.id) !== true);
  const ids = answering.map((tool) => tool.id);
  const proven = new Set<IdeaCapability>();
  for (const [capability, proves] of Object.entries(PROVEN_BY) as [IdeaCapability, (toolId: string) => boolean][]) {
    if (ids.some(proves)) proven.add(capability);
  }
  for (const tool of answering) for (const capability of tool.proves ?? []) proven.add(capability);
  if (ids.some((id) => settings.mailboxSearchTools?.has(id) === true)) proven.add("mailbox");
  if (ids.some((id) => settings.calendarTools?.has(id) === true)) proven.add("calendar");
  for (const [slug, preset] of settings.presets ?? []) {
    const capability = PRESET_CAPABILITY[preset];
    if (capability !== undefined && ids.some((id) => id.startsWith(`mcp.${slug}.`))) proven.add(capability);
  }
  for (const declared of settings.channels ?? []) for (const capability of declared) proven.add(capability);
  return IDEA_CAPABILITIES.filter((capability) => proven.has(capability));
}

/** How many memory records and recent chats a provider is given at most. */
export const IDEAS_MEMORY_MAX = 20;
const IDEAS_TASKS_MAX = 10;
const OWN_SCOPES = new Set(["personal", "personal_workspace", "personal_agent"]);

/** How many records the store is asked for, newest first, so a core fact older than the passing ones is still found. */
const IDEAS_MEMORY_SCAN = 200;

/**
 * How close a record is to the person's profile ("About the person"): a core `me.*` fact first, then their
 * preferences and lessons, then any other fact. Ideas are meant to rest on who the person is, not on the newest
 * passing detail.
 */
function profileRank(record: { readonly kind: string; readonly topicKey?: string | undefined }): number {
  if (record.kind === "fact" && record.topicKey?.startsWith("me.") === true) return 0;
  if (record.kind === "preference") return 1;
  if (record.kind === "lesson") return 2;
  return 3;
}

/**
 * The person's preferences, facts and lessons of their own scopes that recall
 * would use now, profile first (`profileRank`), newest first within each:
 * approved, not past, normal sensitivity, and not resting on a source the
 * person revoked — `list` finds the candidates, `eligible` applies search's
 * own filters to them.
 */
export async function ideasMemoryContext(
  memory: Pick<MemoryServicePort, "list" | "eligible">,
  actor: { readonly workspaceId: string; readonly principalId: string },
  now: string,
): Promise<readonly MemoryExcerpt[]> {
  const asActor = { ...actor, caller: "ideas", authority: "operator" as const };
  const records = await memory.list({
    actor: asActor,
    kinds: ["preference", "fact", "lesson"],
    statuses: ["approved"],
    limit: IDEAS_MEMORY_SCAN,
    withCurrentRevision: true,
  });
  const candidates = records
    .filter(
      (record) =>
        record.currentRevision !== undefined &&
        record.sensitivity === "normal" &&
        OWN_SCOPES.has(record.scope.kind) &&
        !memoryRecordIsPast(record, now),
    )
    .map((record, order) => ({ record, order }))
    .sort((a, b) => profileRank(a.record) - profileRank(b.record) || a.order - b.order)
    .map(({ record }) => record)
    .slice(0, IDEAS_MEMORY_MAX * 3);
  if (candidates.length === 0) return [];
  // `eligible` takes at most `MEMORY_SEARCH_MAX` ids a call, and answers in its own order: the candidates' is kept.
  const eligible = new Map<string, Awaited<ReturnType<typeof memory.eligible>>[number]>();
  for (let start = 0; start < candidates.length; start += MEMORY_SEARCH_MAX) {
    for (const hit of await memory.eligible({
      actor: asActor,
      recordIds: candidates.slice(start, start + MEMORY_SEARCH_MAX).map((record) => record.recordId),
    }))
      eligible.set(hit.recordId, hit);
  }
  return candidates
    .flatMap((record) => {
      const hit = eligible.get(record.recordId);
      return hit === undefined || !OWN_SCOPES.has(hit.scope.kind) || hit.superseded ? [] : [{ record, hit }];
    })
    .slice(0, IDEAS_MEMORY_MAX)
    .map(({ record, hit }) => ({
      recordId: hit.recordId,
      revisionId: hit.revisionId,
      kind: record.kind === "preference" ? ("preference" as const) : record.kind === "lesson" ? ("lesson" as const) : ("fact" as const),
      text: memoryExcerptHead(hit.title, hit.snippet),
    }));
}

/** A chat as the task list has it: what decides whether it is the person's own to use. */
export interface IdeasChatRow {
  readonly taskId: string;
  readonly title?: string | undefined;
  /** Where the title came from: only a generated title or the reader's own name is given, never a prompt's first line. */
  readonly titleSource?: string | undefined;
  readonly summary?: string | null | undefined;
  /** `pending` after part of the chat was forgotten: its summary may still tell of what was erased. */
  readonly summaryState?: string | null | undefined;
  readonly origin?: string | null | undefined;
  readonly chatKind?: string | null | undefined;
  readonly memoryMode?: string | null | undefined;
  readonly updatedAt?: string | undefined;
}

/** A chat that is the person's own to suggest from, named by a title rather than their raw words. */
const ownChat = (row: IdeasChatRow): boolean =>
  row.origin !== "messaging" &&
  (row.chatKind ?? "chat") !== "run" &&
  row.chatKind !== "worker" &&
  row.chatKind !== "home" &&
  row.memoryMode !== "private" &&
  row.memoryMode !== "off" &&
  (row.titleSource === "generated" || row.titleSource === "reader") &&
  typeof row.title === "string" &&
  row.title.trim() !== "";

/** How recent a chat must be for the empty chat to offer "Continue". */
const IDEAS_CONTINUE_WITHIN_MS = 3 * 24 * 60 * 60_000;

/**
 * The empty chat's "Continue" chip: the newest of the person's own
 * chats (as `ideasRecentTasks` chooses them) with a summary written in the
 * last three days, none when it is older.
 */
export function ideasContinueChat(
  rows: readonly IdeasChatRow[],
  now: Date,
): { readonly taskId: string; readonly title: string } | undefined {
  const row = rows
    .filter(ownChat)
    .find((candidate) => typeof candidate.summary === "string" && candidate.summary !== "" && candidate.summaryState !== "pending");
  if (row === undefined || row.updatedAt === undefined || now.getTime() - Date.parse(row.updatedAt) > IDEAS_CONTINUE_WITHIN_MS)
    return undefined;
  return { taskId: row.taskId, title: row.title ?? "" };
}

/**
 * The person's own chats, as listed newest first: never one from a messaging
 * conversation (other people's words), a run, a worker or Home, and
 * never a private or memory-off chat — as the earlier-chats
 * notice chooses them. A chat named only by its prompt's first line is left
 * out: that line is the person's raw words, not a title.
 */
/**
 * A chat as a provider reads it: its summary only when the chat's label
 * was read and is trusted — a chat that read untrusted content, or whose label
 * cannot be read, gives its title alone, since its summary may echo what a page
 * said.
 */
export function ideasTaskExcerpt(task: IdeaTaskExcerpt, label: ContentLabel | undefined): IdeaTaskExcerpt {
  return task.summary === undefined || (label !== undefined && !isUntrusted(label)) ? task : { taskId: task.taskId, title: task.title };
}

export function ideasRecentTasks(rows: readonly IdeasChatRow[]): readonly IdeaTaskExcerpt[] {
  return rows
    .filter(ownChat)
    .slice(0, IDEAS_TASKS_MAX)
    .map((row) => ({
      taskId: row.taskId,
      title: row.title ?? "",
      ...(typeof row.summary === "string" && row.summary !== "" && row.summaryState !== "pending" ? { summary: row.summary } : {}),
    }));
}

/**
 * A provider's model turn: one tool-less call on the workspace's fast
 * model, as its operator, recorded under the ideas run. Its words are the
 * person's memory and chats read again, so the ledger keeps its usage only.
 * A call that does not complete throws with the `tokens` it spent, so
 * the day's budget still counts them.
 */
export function ideasModelTurn(deps: {
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly fastTarget: (workspaceId: string) => Promise<ModelTarget | undefined>;
  readonly models: Pick<ModelPort, "stream">;
  readonly newId: () => string;
  readonly now: () => string;
}): NonNullable<IdeasHostDependencies["turn"]> {
  return async ({ workspaceId, runId }, input, signal) => {
    const principalId = deps.principalOf(workspaceId);
    const target = await deps.fastTarget(workspaceId);
    if (principalId === undefined || target === undefined)
      throw new TaviError("UNAVAILABLE", "No fast model is set for this workspace: ideas are written without one");
    const attemptId = `ideas-${deps.newId()}`;
    const at = deps.now();
    const outcome = await deps.models.stream(
      {
        connectionId: target.connectionId,
        model: target.model,
        runId,
        attemptId,
        attemptNumber: 1,
        purpose: "generation",
        maxOutputTokens: input.maxOutputTokens,
        messages: [
          ...(input.system === "" ? [] : [{ id: `${attemptId}-system`, role: "system" as const, text: input.system, createdAt: at }]),
          { id: `${attemptId}-input`, role: "user" as const, text: input.user, createdAt: at },
        ],
        tools: [],
      },
      { signal, onEvent: () => {}, context: { workspaceId, principalId, runId, caller: "ideas" }, keepRequest: false, site: "ideas" },
    );
    const usage = outcome.usage;
    const tokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (outcome.status !== "completed")
      throw Object.assign(new Error(outcome.error?.message ?? "the ideas model turn did not complete"), { tokens });
    return { text: outcome.text, tokens };
  };
}

/**
 * The tools an idea's prepared step may use: the registered read-only tools proving the capabilities it uses (a
 * plugin's by its `proves`) —
 * `web` adds `web_search` to `web_fetch` — and nothing else. Empty when one
 * of its capabilities has none here: it is not prepared.
 */
export function ideasPrepareTools(
  uses: readonly IdeaCapability[],
  tools: readonly { readonly id: string; readonly effect: string; readonly proves?: readonly IdeaCapability[] | undefined }[],
): readonly string[] {
  const readOnly = tools.filter((tool) => tool.effect === "read-only");
  const chosen = new Set<string>();
  for (const capability of new Set(uses)) {
    const hosts = capability === "web" ? (id: string) => id === "web_fetch" || id === "web_search" : PROVEN_BY[capability];
    // The host's own tools by id; a plugin's by what it declares it proves.
    const found = readOnly.filter((tool) => hosts?.(tool.id) === true || tool.proves?.includes(capability) === true).map((tool) => tool.id);
    if (found.length === 0) return [];
    for (const id of found) chosen.add(id);
  }
  return [...chosen].sort();
}

/**
 * An idea's prepared step as one unattended run, of the
 * plumbing origin `ideas`, as its operator, offered only `ideasPrepareTools`.
 * The prompt was written by a provider or a model, not by the person, so the
 * run starts tainted: a URL in it is fetched only through the taint step,
 * which an unattended run answers with a denial. Each run is its own
 * admission (a new key), so a day's answer is never an earlier one replayed.
 * Stopped through `cancel` when `signal` aborts.
 */
export function ideasPrepareRun(deps: {
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly tools: () => readonly {
    readonly id: string;
    readonly effect: string;
    readonly proves?: readonly IdeaCapability[] | undefined;
  }[];
  readonly workflow: () => Pick<WorkflowPort, "admit"> | undefined;
  readonly cancel: (taskId: string, reason: string) => Promise<void>;
  /** What a run has spent so far: checked as it calls tools, and stopped past `IDEA_PREPARE_RUN_RESERVE_TOKENS`. */
  readonly tokensOf: (taskId: string) => Promise<number>;
  /** Each prepared run's idea provider, while it runs: that plugin's own hooks pass it over. */
  readonly providers: Map<string, string>;
  readonly now: () => string;
  /**
   * The local model a prepared step runs on when the idea was written from
   * local chats and records, and how it is saved as the run's own: such a step
   * never runs on a remote default. Absent: it runs the default.
   */
  readonly localModel?: {
    readonly target: (workspaceId: string) => Promise<ModelTarget | undefined>;
    readonly choose: (
      scope: { readonly workspaceId: string; readonly principalId: string },
      taskId: string,
      target: ModelTarget,
    ) => Promise<unknown>;
  };
}): NonNullable<IdeasHostDependencies["prepare"]> {
  return async ({ workspaceId }, idea, signal) => {
    const principalId = deps.principalOf(workspaceId);
    const workflow = deps.workflow();
    const toolAllowlist = ideasPrepareTools(
      idea.uses.map((use) => use.capability),
      deps.tools(),
    );
    if (principalId === undefined || workflow === undefined || toolAllowlist.length === 0) return undefined;
    const localTarget = await deps.localModel?.target(workspaceId);
    const at = deps.now();
    let taskId: string | undefined;
    let stopped = false;
    const stop = (reason = "the idea's first step ran past its time"): void => {
      if (taskId === undefined || stopped) return;
      stopped = true;
      // Best effort: a cancel that fails leaves the task to end on its own deadline.
      void deps.cancel(taskId, reason).catch(() => undefined);
    };
    const onAbort = (): void => stop();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const admission = await admitUnattended(
        workflow,
        {
          context: {
            workspaceId,
            principalId,
            runId: "pending-ideas-admission",
            caller: "ideas",
            inheritedTaint: true,
            inheritedLabel: untrustedLabel("agent", { ref: { ref: `idea:${idea.id}`, at } }),
          },
          operationKey: `ideas-prepare:${idea.id}:${at}`,
          prompt: idea.prompt,
          executionPolicy: {
            mode: "unattended",
            humanQuestionsAllowed: false,
            workerWaitsAllowed: false,
            toolAllowlist: [...toolAllowlist],
          },
          origin: "ideas",
          onAdmitted: async (admitted) => {
            taskId = admitted.taskId;
            deps.providers.set(admitted.taskId, idea.providerId);
            // Saved before its first model call: a step from local data runs on a local model, or not at all.
            if (localTarget !== undefined)
              await deps.localModel
                ?.choose({ workspaceId, principalId }, admitted.taskId, localTarget)
                .catch(() => stop("the idea's local model could not be kept for its first step"));
            if (signal.aborted) stop();
          },
        },
        {
          // Its reserve is its ceiling: past it, the run is stopped, whatever its pages cost.
          onToolEvent: async () => {
            if (taskId !== undefined && !stopped && (await deps.tokensOf(taskId)) > IDEA_PREPARE_RUN_RESERVE_TOKENS)
              stop("the idea's first step spent its share of the day's tokens");
          },
        },
      );
      if (admission.outcome.status !== "completed" || admission.outcome.finalText.trim() === "") return undefined;
      return { taskId: admission.taskId, text: admission.outcome.finalText };
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (taskId !== undefined) deps.providers.delete(taskId);
    }
  };
}
