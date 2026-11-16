import { emit, emitError, emitJson } from "../../cli/output.js";
import { EXIT, configRefusalExit, reportCommandFailure, reportFailure, reportRefusal } from "../../cli/exit.js";
import {
  BUILTIN_MEMORY_PROVIDER_ID,
  memoryErasesAt,
  memoryScopeForTarget,
  WorkspaceSettingsAnswerSchema,
  hostTimeZone,
  TaviError,
  type MemoryActor,
  type MemoryGetAnswer,
  type MemoryWhyAnswer,
  type MemoryForgetAnswer,
  type MemoryProviderAnswer,
  MemoryProviderAnswerSchema,
  type MemoryPayload,
  MemoryReindexAnswerSchema,
  MemoryReviewNowAnswerSchema,
  MemoryConsolidateNowAnswerSchema,
  type MemoryItem,
  type MemoryKind,
  type MemoryEgressField,
  type MemoryListAnswer,
  MEMORY_PARTIAL_MATCHES,
  memoryPendingProvidersNote,
  memoryProvenanceLine,
  memoryProvenanceUntrusted,
  type MemoryProvenance,
  type MemoryRecord,
  type MemoryStatus,
  MEMORY_IPC_LIST_MAX,
  encodeMemoryListCursor,
  type MemoryScope,
  type PersistencePort,
  type WorkspaceSettingsAnswer,
  MEMORY_CONFIG_KEYS,
  effectiveMemorySettings,
  memoryConfigKeySet,
  memoryConfigValue,
  withMemoryConfig,
  type TaviErrorCode,
} from "@tavi/contracts";
import { terminalText } from "../../shared/terminal-text.js";
import { runMemoryReview } from "./review.js";
import { memoryDateText, whyText } from "./slash.js";
import { keepLongerDates, workspaceZoneOf } from "./owner.js";
import type { TaviRuntime } from "../../runtime/types.js";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import { prefixedId, sleep } from "@tavi/node-kit";
import { memoryReindexNote, runMemoryReindex } from "./jobs-now.js";
import { approvedMemoryDeclaration, egressAsDeclared, externalMemoryIndexNote, spansWorkspaces } from "./providers.js";
import { operatorActor } from "../../server/config-commands.js";
import {
  applyWorkspaceSetting,
  memoryRetrievalDisclosure,
  openMemoryService,
  memorySettingsReader,
  workspaceSettingsAnswerFor,
} from "../../server/workspace-settings-commands.js";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import { type MemoryCommandOptions, MEMORY_USAGE } from "./parse.js";
import { requireFlag } from "../../cli/flags.js";
import type { CliIo } from "../../cli/io.js";
import {
  CONFIG_TIMEOUT_MS,
  configFailureReporter,
  configOnOwner,
  ownerWorkspacePrincipal,
  refuseOfflineOnly,
  runFamily,
} from "../../cli/owner.js";
import { resolveModelTargetOrReport } from "../../cli/run-target.js";
import { runtimeOptionsFor } from "../../cli/runtime-options.js";
import { type ResolvedDataDirectory, withStore } from "../../cli/store.js";

/** Every status but `deleted`: what `tavi memory list` has always shown. */
const MEMORY_LIST_STATUSES: readonly Exclude<MemoryStatus, "deleted">[] = [
  "proposed",
  "approved",
  "rejected",
  "superseded",
  "revoked",
  "expired",
];

/** One `tavi memory list`/`proposals` row, the same on both paths; marked when its words may have come from untrusted content. */
function memoryRow(
  record: Pick<MemoryRecord, "recordId" | "status" | "kind" | "scope" | "sensitivity"> & {
    readonly provenance?: MemoryProvenance | undefined;
  },
): string {
  return (
    `${record.recordId}\t${record.status}\t${record.kind}\t${record.scope.kind}` +
    (record.sensitivity === "sensitive" ? "\t(sensitive)" : "") +
    (memoryProvenanceUntrusted(record.provenance) ? "\t(from untrusted content)" : "")
  );
}

/**
 * One `tavi memory list --past` row: the row, then when it ended or
 * expired and, for an expired one, when it is erased — the Center's *Past*.
 */
function pastMemoryRow(
  record: Pick<MemoryRecord, "recordId" | "status" | "kind" | "scope" | "sensitivity" | "validTo" | "expiryAt" | "updatedAt"> & {
    readonly erasesAt?: string | undefined;
  },
  date: (iso: string, end?: boolean) => string,
): string {
  const when =
    record.expiryAt !== undefined
      ? `expired after ${date(record.expiryAt, true)}${record.erasesAt === undefined ? "" : `, erased on ${date(record.erasesAt)}`}`
      : record.validTo !== undefined
        ? `ended after ${date(record.validTo, true)}, kept`
        : `expired${record.erasesAt === undefined ? "" : `, erased on ${date(record.erasesAt)}`}`;
  return `${memoryRow(record)}\t${when}`;
}

/**
 * A past row's day, in the workspace's zone. An end date is the instant its last
 * day ends ("until Friday" ends as Saturday begins), so it names that last day.
 */
const pastDayIn =
  (timeZone: string) =>
  (iso: string, end = false): string =>
    new Date(Date.parse(iso) - (end ? 1 : 0)).toLocaleDateString("en-CA", { timeZone });

/**
 * `tavi memory <action>` on a live owner: the
 * `memory` command, acting as the workspace's operator. The output is the
 * offline command's; a JSON listing prints the owner's rows, which carry the
 * record's own fields. `undefined` when no owner serves the directory.
 */
async function memoryOnOwner(options: ResolvedDataDirectory<MemoryCommandOptions>, io: CliIo): Promise<number | undefined> {
  if (options.action === "export") {
    return refuseOfflineOnly(options.dataDirectory, "tavi memory export", "the owner answers evidence as counts, never as its sources", io);
  }
  const workspaceId = options.workspaceId;
  const listing = options.action === "list" || options.action === "proposals";
  // `tavi memory why`'s and `list --past`'s dates: the workspace's timezone, read before the answer.
  let timeZone = hostTimeZone();
  const readsZone = options.action === "why" || (options.action === "list" && options.past === true);
  return configOnOwner(options.dataDirectory, "memory", io, {
    label: `tavi memory ${options.action}`,
    mutates: !listing && options.action !== "search" && options.action !== "show" && options.action !== "why",
    ...(readsZone ? { follows: ["workspace-settings"] } : {}),
    codes: { MEMORY_CONFLICT: EXIT.usage, REVISION_CONFLICT: EXIT.usage, QUOTA_EXCEEDED: EXIT.usage },
    build: async (client) => {
      const recordId = (): string => requireFlag(options.recordId, "record id");
      if (readsZone) {
        // Dates in the workspace's timezone, as `/why` and the Center say them.
        const read = await client.request("workspace-settings", { action: "get", workspaceId }, prefixedId("workspace-settings-read"), {
          timeoutMs: CONFIG_TIMEOUT_MS,
        });
        if (!read.ok)
          throw new TaviError(
            (read.error?.code ?? "UNAVAILABLE") as TaviErrorCode,
            read.error?.message ?? "could not read the workspace settings",
          );
        timeZone = WorkspaceSettingsAnswerSchema.parse(read.result).settings.timezone ?? hostTimeZone();
      }
      switch (options.action) {
        case "list":
        case "proposals":
        case "search":
          return {
            action: "list",
            workspaceId,
            // *Past* is listed in place of the statuses.
            ...(options.action === "list" && options.past === true
              ? { past: true }
              : {
                  statuses: options.action === "list" ? MEMORY_LIST_STATUSES : options.action === "proposals" ? ["proposed"] : ["approved"],
                }),
            ...(options.scope === undefined ? {} : { scopes: [options.scope] }),
            // An unknown kind is the owner's to refuse, as the offline service does.
            ...(options.kind === undefined || options.action === "search" ? {} : { kinds: [options.kind as MemoryKind] }),
            // Bounded as the offline service bounds it, rather than refused.
            ...(options.limit === undefined ? {} : { limit: Math.min(Math.max(options.limit, 1), MEMORY_IPC_LIST_MAX) }),
            ...(options.offset === undefined || options.offset <= 0 || options.action === "search"
              ? {}
              : { cursor: encodeMemoryListCursor(options.offset) }),
            ...(options.action === "search" ? { query: requireFlag(options.query, "query") } : {}),
            ...(options.action !== "list" || options.originTaskId === undefined ? {} : { originTaskId: options.originTaskId }),
            ...(options.action !== "list" || options.usedInTaskId === undefined ? {} : { usedInTaskId: options.usedInTaskId }),
            ...(options.action !== "list" || options.chatNotes !== true ? {} : { chatNotes: true }),
          };
        case "show":
          return { action: "get", workspaceId, recordId: recordId() };
        case "remember": {
          const kind = (options.kind ?? "fact") as MemoryKind;
          if (options.body === undefined) throw new TaviError("INVALID_INPUT", "A memory record needs a body or an artifact reference");
          return {
            action: "remember",
            workspaceId,
            kind,
            scope: options.scope ?? "personal",
            body: options.body,
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.sensitive === true ? { sensitivity: "sensitive" } : {}),
            ...definedOnly({
              preferenceKey: options.preferenceKey,
              preferenceValue: options.preferenceValue,
              topicKey: options.topicKey,
              reason: options.reason,
            }),
          };
        }
        case "correct":
          return {
            action: "correct",
            workspaceId,
            recordId: recordId(),
            ...definedOnly({
              title: options.title,
              body: options.body,
              preferenceValue: options.preferenceValue,
              until: options.until,
              reason: options.reason,
            }),
          };
        case "approve":
        case "reject":
          return {
            action: options.action,
            workspaceId,
            recordId: recordId(),
            ...(options.note === undefined ? {} : { note: options.note }),
          };
        case "forget":
          return { action: "forget", workspaceId, recordId: recordId(), reason: requireFlag(options.reason, "--reason") };
        case "move":
          return {
            action: "move",
            workspaceId,
            recordId: recordId(),
            to: requireFlag(options.scope, "--scope"),
            ...(options.reason === undefined ? {} : { reason: options.reason }),
          };
        case "why": {
          const taskId = requireFlag(options.chatTaskId, "chat task id");
          return { action: "why", workspaceId, taskId, ...(options.turn === undefined ? {} : { seq: options.turn }) };
        }
        default:
          // `export` was refused above.
          return EXIT.usage;
      }
    },
    render: async (result) => {
      switch (options.action) {
        case "list":
        case "proposals": {
          const answer = result as MemoryListAnswer;
          if (options.past === true) {
            // The owner answers each expired record's erasure date (`erasesAt`).
            emit(io, options.format, answer.records, (rows) =>
              rows.length === 0 ? "(nothing past)" : rows.map((row) => pastMemoryRow(row, pastDayIn(timeZone))).join("\n"),
            );
            return EXIT.ok;
          }
          emit(io, options.format, answer.records, (rows) => (rows.length === 0 ? "(no records)" : rows.map(memoryRow).join("\n")));
          return EXIT.ok;
        }
        case "search": {
          const answer = result as MemoryListAnswer;
          // Every word matched, or — when none held them all — partial matches, said as such.
          emit(
            io,
            options.format,
            { hits: answer.records, coverage: answer.coverage, ...(answer.match === undefined ? {} : { match: answer.match }) },
            (value) => {
              const rows = value.hits.map((hit) => `${hit.recordId}\t${hit.kind}\t${hit.snippet ?? ""}`).join("\n") || "(no matches)";
              return value.match === "any" ? `${MEMORY_PARTIAL_MATCHES}\n${rows}` : rows;
            },
          );
          return EXIT.ok;
        }
        case "show":
          emit(io, options.format, (result as MemoryGetAnswer).record, memoryShowText);
          return EXIT.ok;
        case "why": {
          const answer = result as MemoryWhyAnswer;
          if (options.format === "json") {
            emitJson(io, answer);
            return EXIT.ok;
          }
          io.stdout(`${terminalText(await whyText(answer, (iso) => memoryDateText(iso, timeZone)))}\n`);
          return EXIT.ok;
        }
        case "forget": {
          // A provider that could not take the removal now gets it when it next runs.
          const receipt = result as MemoryForgetAnswer;
          // What no forget reaches is the receipt's `unreached`, in the JSON.
          emit(io, options.format, receipt, forgetReceiptText);
          return EXIT.ok;
        }
        default:
          emitJson(io, result as MemoryItem);
          return EXIT.ok;
      }
    },
  });
}

/**
 * `tavi memory show` as text: the record's JSON, then — for one proposed after its chat read untrusted
 * content, kept or not — what the chat read (`memoryProvenanceLine`).
 */
function memoryShowText(value: { readonly recordId: string; readonly provenance?: MemoryProvenance | undefined }): string {
  const { provenance, ...shown } = value;
  const read = memoryProvenanceLine(provenance);
  return `${terminalText(JSON.stringify(shown, null, 2))}${read === undefined ? "" : `\n${terminalText(read)}`}`;
}

/** A forget's receipt as the CLI prints it: the JSON, then the providers its removal waits for. */
function forgetReceiptText(value: { readonly pendingProviders?: readonly string[] | undefined }): string {
  const note = memoryPendingProvidersNote(value.pendingProviders);
  return `${JSON.stringify(value, null, 2)}${note === undefined ? "" : `\n${note}`}`;
}

/**
 * The providers an offline forget's removal waits for, with no owner to send it: each a workspace selects that keeps an index
 * of its own by its approved record (`index: "own"`, or no record to say)
 * and is given records — one spanning workspaces (`spansWorkspaces`) only
 * with `includePersonal` too. Sorted. The next owner resends it to each when
 * it runs.
 */
async function offlineRemovalTargets(port: PersistencePort, scope: MemoryScope): Promise<readonly string[]> {
  const targets = new Set<string>();
  for (const { settings } of await port.repositories.workspaceSettings.list()) {
    const { provider, providerEgress } = effectiveMemorySettings(settings.memory);
    if (provider === BUILTIN_MEMORY_PROVIDER_ID || targets.has(provider)) continue;
    // Unknown declaration: the configured egress decides (never the narrower declared one).
    const declared = await approvedMemoryDeclaration(port.repositories.plugins, provider).catch(() => undefined);
    if (declared?.index === "host") continue;
    const egress = declared === undefined ? providerEgress : egressAsDeclared(providerEgress, declared);
    if (egress.records && (!spansWorkspaces(scope) || egress.includePersonal)) targets.add(provider);
  }
  return [...targets].sort();
}

/**
 * `tavi memory set-provider` and `tavi memory egress`: through the owner's `memory` command, which shows the disclosure
 * as `APPROVAL_REQUIRED` until `--yes` accepts it. Owner-only.
 */
async function memoryProviderCliCommand(options: ResolvedDataDirectory<MemoryCommandOptions>, io: CliIo): Promise<number> {
  const label = `tavi memory ${options.action}`;
  const onOwner = await configOnOwner(options.dataDirectory, "memory", io, {
    label,
    mutates: true,
    build: () => {
      const guard = {
        ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
        ...(options.confirmed === true ? { confirmed: true as const } : {}),
      };
      return options.action === "set-provider"
        ? { action: "set-provider", workspaceId: options.workspaceId, providerId: requireFlag(options.providerId, "provider id"), ...guard }
        : {
            action: "egress",
            workspaceId: options.workspaceId,
            field: requireFlag(options.egressField, "egress field") as MemoryEgressField,
            on: options.egressOn === true,
            ...guard,
          };
    },
    render: (result) => {
      const answer = MemoryProviderAnswerSchema.parse(result);
      if (options.format === "json") {
        emitJson(io, answer);
        return EXIT.ok;
      }
      io.stdout(memoryProviderText(answer));
      return EXIT.ok;
    },
    refusal: (code, message) => ({
      line: code === "APPROVAL_REQUIRED" ? `${message} Run it again with --yes to confirm.` : message,
      exit: configRefusalExit(code),
    }),
  });
  if (onOwner !== undefined) return onOwner;
  io.stderr(`\`${label}\` needs a running owner: start \`tavi serve\` and run it again.\n`);
  return EXIT.usage;
}

/** How long one job request may take on the owner: a review is up to 30 s a chat, a run 60 s a person. */
const MEMORY_JOB_TIMEOUT_MS = 15 * 60_000;

/**
 * `tavi memory reindex | review-now | consolidate-now`: the `tavi.memory`
 * host's background jobs on demand (operator conveniences; every rule of
 * each job holds but its schedule). Over IPC on a live owner, else in a
 * runtime composed here under ownership, as `tavi run` composes one: with the
 * memory host on and no sweep, scheduler or channel of a daemon's.
 */
async function memoryJobCommand(options: ResolvedDataDirectory<MemoryCommandOptions>, io: CliIo): Promise<number> {
  const workspaceId = options.workspaceId;
  const payload: MemoryPayload =
    options.action === "reindex"
      ? { action: "reindex", workspaceId }
      : options.action === "review-now"
        ? { action: "review-now", workspaceId, ...(options.chatTaskId === undefined ? {} : { taskId: options.chatTaskId }) }
        : {
            action: "consolidate-now",
            workspaceId,
            ...(options.forPrincipalId === undefined ? {} : { principalId: options.forPrincipalId }),
          };
  const client = await connectOwnerOrReport(options.dataDirectory, ["memory"], io, EXIT);
  if (typeof client === "number") return client;
  let request: (body: MemoryPayload) => Promise<unknown>;
  let close: () => Promise<void>;
  if (client !== undefined) {
    request = async (body) => {
      const response = await client.request("memory", body, prefixedId("memory"), { timeoutMs: MEMORY_JOB_TIMEOUT_MS });
      if (!response.ok)
        throw new TaviError((response.error?.code ?? "UNAVAILABLE") as TaviErrorCode, response.error?.message ?? "the owner refused");
      return response.result;
    };
    close = async () => client.close();
  } else {
    const target = await resolveModelTargetOrReport(
      {
        prompt: "",
        format: options.format,
        workspaceId,
        principalId: options.principalId,
        dataDirectory: options.dataDirectory,
        approval: "deny",
        quiet: true,
        inMemory: false,
      },
      io,
      { requireTarget: false, usage: MEMORY_USAGE },
    );
    if (typeof target === "number") return target;
    let runtime: TaviRuntime;
    try {
      // Loaded here, not at the top: every other command this module serves stays off the owner runtime.
      const { composeTaviRuntime } = await import("../../runtime/composition.js");
      runtime = await composeTaviRuntime(
        {
          ...runtimeOptionsFor(
            { ...target.options, connectionId: target.options.connectionId ?? "default", model: target.options.model ?? "default" },
            process.env,
            target.connection,
            target.fallback,
          ),
          modelTargetUnconfigured: target.options.connectionId === undefined,
          // The jobs read each workspace's own model roles; nothing else a daemon runs is started.
          memoryHostEnabled: true,
          memoryTickEnabled: false,
          scheduleSweepEnabled: false,
          retentionSweepEnabled: false,
        },
        { requireModelTransport: false },
      );
    } catch (error) {
      return reportFailure(error, io, "runtime composition failed");
    }
    request = async (body) => {
      if (body.action === "reindex") return await runtime.memoryJobs.reindex(workspaceId);
      if (body.action === "review-now") {
        const task = body.taskId === undefined ? undefined : await runtime.store.asPort().repositories.tasks.get(body.taskId);
        if (body.taskId !== undefined && (task === undefined || task.workspaceId !== workspaceId))
          throw new TaviError("NOT_FOUND", `Task ${body.taskId} does not exist`);
        return await runtime.memoryJobs.reviewNow(workspaceId, body.taskId);
      }
      if (body.action === "consolidate-now") return await runtime.memoryJobs.consolidateNow(workspaceId, body.principalId);
      throw new TaviError("INTERNAL", `not a memory job: ${body.action}`);
    };
    close = async () => {
      await runtime.close();
    };
  }
  try {
    if (options.action === "reindex") {
      const outcome = await runMemoryReindex({
        pass: async () => MemoryReindexAnswerSchema.parse(await request(payload)),
        maxWaitMs: (options.maxWaitSeconds ?? 600) * 1000,
        now: () => Date.now(),
        sleep: (ms) => sleep(ms),
        progress: (line) => emitError(io, line),
      });
      const note = memoryReindexNote(outcome);
      const { last } = outcome;
      if (options.format === "json") {
        emitJson(io, {
          workspaceId,
          retrieval: last.retrieval,
          model: last.model,
          indexed: last.indexed,
          missing: last.missing,
          failed: last.failedTotal,
          embedded: outcome.embedded,
          passes: outcome.passes,
          stopped: outcome.stopped,
          ...(note === undefined ? {} : { note }),
        });
      } else {
        if (last.retrieval === "hybrid")
          io.stdout(
            `indexed ${last.indexed}, missing ${last.missing}, failed ${last.failedTotal}${last.model === null ? "" : ` (${last.model})`}\n`,
          );
        if (note !== undefined) io.stdout(`${note}\n`);
      }
      return outcome.stopped === "done" || outcome.stopped === "lexical" ? EXIT.ok : EXIT.unavailable;
    }
    if (options.action === "review-now") {
      const answer = MemoryReviewNowAnswerSchema.parse(await request(payload));
      if (options.format === "json") {
        emitJson(io, answer);
      } else {
        if (!answer.capturing) io.stdout("memory is paused or capture is off: no chat is reviewed (tavi memory config capture suggest)\n");
        if (answer.chats.length === 0 && answer.capturing) io.stdout("no chat has anything new to review\n");
        for (const chat of answer.chats)
          io.stdout(
            `${chat.taskId}\t${chat.outcome}${chat.outcome === "reviewed" ? `\t${chat.filed.length} filed${chat.filed.length === 0 ? "" : `: ${chat.filed.join(", ")}`}` : ""}${chat.reason === undefined ? "" : `\t${chat.reason}`}\n`,
          );
      }
      return answer.chats.some((chat) => chat.outcome === "failed") ? EXIT.unavailable : EXIT.ok;
    }
    const answer = MemoryConsolidateNowAnswerSchema.parse(await request(payload));
    if (options.format === "json") {
      emitJson(io, answer);
    } else if (answer.consolidation !== "weekly" || !answer.enabled) {
      io.stdout(
        answer.consolidation !== "weekly"
          ? "consolidation is off: nothing runs (tavi memory config consolidation weekly)\n"
          : "memory is paused: nothing runs\n",
      );
    } else {
      if (answer.people.length === 0) io.stdout("nobody keeps approved memory here: nothing to tidy\n");
      for (const person of answer.people)
        io.stdout(
          `${person.principalId}\t${person.outcome}${person.outcome === "ran" ? `\t${person.filed.length} filed of ${person.drafts} drafted${person.filed.length === 0 ? "" : `: ${person.filed.join(", ")}`}` : ""}${person.reason === undefined ? "" : `\t${person.reason}`}\n`,
        );
    }
    return answer.consolidation === "weekly" && answer.enabled && answer.people.some((person) => person.outcome === "failed")
      ? EXIT.unavailable
      : EXIT.ok;
  } catch (error) {
    return reportCommandFailure(error, io, `tavi memory ${options.action} failed`);
  } finally {
    await close();
  }
}

/** The workspace's memory provider as `set-provider` and `egress` print it. */
function memoryProviderText(answer: MemoryProviderAnswer): string {
  const onOff = (on: boolean): string => (on ? "on" : "off");
  const lines = [
    `provider = ${answer.selected}${answer.serving === answer.selected ? "" : answer.serving === "none" ? " (none serves: recall is Tavi's own search, and nothing drafts proposals)" : ` (the built-in serves meanwhile)`}`,
    ...(answer.fallback === undefined ? [] : [answer.fallback]),
    `egress records = ${onOff(answer.egress.records)}, conversation = ${onOff(answer.egress.conversation)}, personal = ${onOff(answer.egress.includePersonal)}`,
    ...(answer.pendingRemovals === 0
      ? []
      : [
          `${answer.pendingRemovals} forgotten ${answer.pendingRemovals === 1 ? "memory waits" : "memories wait"} to be removed from a provider that is not running`,
        ]),
    ...(answer.note === undefined ? [] : [answer.note]),
    `revision ${answer.revision}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * `tavi memory review`: each waiting proposal in turn, decided at
 * this terminal through the owner as the operator. Needs a terminal and a
 * running owner.
 */
async function memoryReviewCommand(options: ResolvedDataDirectory<MemoryCommandOptions>, io: CliIo): Promise<number> {
  if (!io.isTty) {
    io.stderr("tavi memory review needs a terminal; use `tavi memory proposals` and `tavi memory approve|reject` in scripts\n");
    return EXIT.usage;
  }
  const client = await connectOwnerOrReport(options.dataDirectory, ["memory"], io, EXIT);
  if (typeof client === "number") return client;
  if (client === undefined) {
    io.stderr("`tavi memory review` needs a running owner: start `tavi serve` and run it again.\n");
    return EXIT.usage;
  }
  const { createInterface } = await import("node:readline/promises");
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  let ended = false;
  lines.once("close", () => {
    ended = true;
  });
  try {
    const summary = await runMemoryReview({
      workspaceId: options.workspaceId,
      request: async (payload) => {
        const response = await client.request("memory", payload, prefixedId("memory"), { timeoutMs: CONFIG_TIMEOUT_MS });
        return response.ok
          ? { ok: true, result: response.result }
          : { ok: false, error: { code: response.error?.code ?? "INTERNAL", message: response.error?.message ?? "the owner refused" } };
      },
      // A question that cannot be asked (input closed) gets no answer, as a closed prompt does.
      ask: async (question) => (ended ? undefined : await lines.question(question).catch(() => undefined)),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    return summary.failed > 0 ? EXIT.unavailable : EXIT.ok;
  } finally {
    lines.close();
    client.close();
  }
}

export async function memoryCommand(options: ResolvedDataDirectory<MemoryCommandOptions>, io: CliIo): Promise<number> {
  // The workspace's memory section is a workspace setting, not a record.
  if (options.action === "config") return memoryConfigCommand(options, io);
  // The provider and its egress are the owner's to change: it knows what is installed and sends what each change calls for.
  if (options.action === "set-provider" || options.action === "egress") return memoryProviderCliCommand(options, io);
  // The interactive review decides through the owner, one request a decision.
  if (options.action === "review") return memoryReviewCommand(options, io);
  // The memory host's background jobs, run now: on the owner, else in a runtime composed here.
  if (options.action === "reindex" || options.action === "review-now" || options.action === "consolidate-now")
    return memoryJobCommand(options, io);
  try {
    const onOwner = await memoryOnOwner(options, io);
    if (onOwner !== undefined) return onOwner;
    // A chat's memory is the owner's to answer: these have no direct path.
    const ownerOnly =
      options.action === "move"
        ? "tavi memory move"
        : options.action === "why"
          ? "tavi memory why"
          : options.scope?.startsWith("chat:") === true
            ? `--scope ${options.scope}`
            : options.originTaskId !== undefined
              ? "--origin-task"
              : options.usedInTaskId !== undefined
                ? "--used-in"
                : options.chatNotes === true
                  ? "--chat-notes"
                  : undefined;
    if (ownerOnly !== undefined) {
      io.stderr(`\`${ownerOnly}\` needs a running owner: start \`tavi serve\` and run it again.\n`);
      return EXIT.usage;
    }
    return await withStore(options.dataDirectory, async (store) => {
      const port = store.asPort();
      // A write is charged to the workspace's quotas (`memory.limits.maxRecords`), as on the owner.
      const service = openMemoryService(port, memorySettingsReader(port.repositories.workspaceSettings));
      const target = resolveMemoryScope(options);
      const actor: MemoryActor = {
        principalId: options.principalId,
        workspaceId: options.workspaceId,
        caller: "cli",
        authority: "operator",
        // The service reads and writes an agent's scope only as that agent.
        ...(target.kind === "personal_agent" ? { agentId: target.agentId } : {}),
      };
      // list/search/export only narrow to one scope when the operator asked
      // to: omitting --scope must reach MemoryService's own "every authorized
      // scope" read path, not silently narrow to personal — export's own
      // usage text promises "everything the principal may see".
      const explicitScope = options.scope === undefined ? undefined : target;

      switch (options.action) {
        case "list": {
          const records = await service.list({
            actor,
            ...(explicitScope === undefined ? {} : { scope: explicitScope }),
            ...(options.kind === undefined ? {} : { kinds: [options.kind as MemoryKind] }),
            ...(options.past === true ? { past: true } : {}),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.offset === undefined ? {} : { offset: options.offset }),
          });
          if (options.past === true) {
            // *Past*: an expired record is erased the workspace's `proposalDays` after the sweep marked it.
            const proposalDays = (await memorySettingsReader(port.repositories.workspaceSettings)(options.workspaceId)).limits.proposalDays;
            const timeZone = await workspaceZoneOf(port.repositories.workspaceSettings)(options.workspaceId);
            const rows = records.map((record) =>
              record.status === "expired" ? { ...record, erasesAt: memoryErasesAt(record, proposalDays) } : record,
            );
            emit(io, options.format, rows, (value) =>
              value.length === 0 ? "(nothing past)" : value.map((row) => pastMemoryRow(row, pastDayIn(timeZone))).join("\n"),
            );
            return EXIT.ok;
          }
          emit(io, options.format, records, (rows) => (rows.length === 0 ? "(no records)" : rows.map(memoryRow).join("\n")));
          return EXIT.ok;
        }
        case "proposals": {
          const records = await service.list({
            actor,
            statuses: ["proposed"],
            ...(explicitScope === undefined ? {} : { scope: explicitScope }),
            ...(options.kind === undefined ? {} : { kinds: [options.kind as MemoryKind] }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.offset === undefined ? {} : { offset: options.offset }),
          });
          // Each with its shown revision's provenance, as the owner's list answers it.
          const rows = await Promise.all(
            records.map(async (record) => {
              // A proposal's shown revision is its newest, before any is current.
              const { revisions } = await service.history({ actor, recordId: record.recordId });
              const provenance = (
                record.currentRevisionId === undefined
                  ? revisions[0]
                  : revisions.find((revision) => revision.revisionId === record.currentRevisionId)
              )?.provenance;
              const { updates, mayUpdate, similarTo, supersedes } = await service.related({ actor, recordId: record.recordId });
              return {
                ...record,
                ...definedOnly({ provenance, updates, mayUpdate, similarTo }),
                ...(supersedes === undefined || supersedes.length === 0 ? {} : { supersedes }),
              };
            }),
          );
          emit(io, options.format, rows, (value) => (value.length === 0 ? "(no records)" : value.map(memoryRow).join("\n")));
          return EXIT.ok;
        }
        case "approve":
        case "reject": {
          const input = {
            actor,
            recordId: requireFlag(options.recordId, "record id"),
            ...(options.note === undefined ? {} : { reason: options.note }),
          };
          const record = options.action === "approve" ? await service.approve(input) : await service.reject(input);
          emitJson(io, record);
          return EXIT.ok;
        }
        case "search": {
          const query = requireFlag(options.query, "query");
          // Every word, then — when no record holds them all — partial matches, said as such (`result.match === "any"`).
          const result = await service.search({
            actor,
            query,
            ...(explicitScope === undefined ? {} : { scope: explicitScope }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          });
          emit(io, options.format, result, (value) => {
            const rows =
              value.hits.map((hit) => `${hit.recordId}\t${hit.kind}${hit.conflict ? "\t(conflict)" : ""}\t${hit.snippet}`).join("\n") ||
              "(no matches)";
            return value.match === "any" ? `${MEMORY_PARTIAL_MATCHES}\n${rows}` : rows;
          });
          return EXIT.ok;
        }
        case "show": {
          // --format text renders as JSON here (and for remember/correct/
          // forget below): a single record's clearest text rendering *is*
          // its JSON, unlike list/search/export's one-row-per-item tables.
          const record = await service.get({ actor, recordId: requireFlag(options.recordId, "record id") });
          // Where its words came from, kept on an approved record too: the revision it shows.
          const { revisions } = await service.history({ actor, recordId: record.recordId });
          const provenance = (revisions.find((revision) => revision.revisionId === record.currentRevisionId) ?? revisions[0])?.provenance;
          const related = record.status === "proposed" ? await service.related({ actor, recordId: record.recordId }) : {};
          emit(
            io,
            options.format,
            {
              ...record,
              ...definedOnly({ provenance, updates: related.updates, mayUpdate: related.mayUpdate, similarTo: related.similarTo }),
              ...(related.supersedes === undefined || related.supersedes.length === 0 ? {} : { supersedes: related.supersedes }),
            },
            memoryShowText,
          );
          return EXIT.ok;
        }
        case "remember": {
          const kind = (options.kind ?? "fact") as MemoryKind;
          // A write target must be one concrete scope, so remember always
          // resolves a default (personal) rather than reaching the
          // "every authorized scope" read path list/search/export use.
          const record = await service.remember({
            actor,
            scope: target,
            kind,
            ...definedOnly({
              title: options.title,
              body: options.body,
              preferenceKey: options.preferenceKey,
              topicKey: options.topicKey,
            }),
            ...(kind === "preference" && options.preferenceValue !== undefined
              ? { preference: { valueType: "string" as const, value: options.preferenceValue } }
              : {}),
            ...(options.sensitive === undefined ? {} : { sensitivity: "sensitive" as const }),
            ...(options.reason === undefined ? {} : { reason: options.reason }),
          });
          emitJson(io, record);
          return EXIT.ok;
        }
        case "correct": {
          const recordId = requireFlag(options.recordId, "record id");
          // *Keep longer*: the new date goes where the record keeps its end, through that day in the workspace's zone.
          const dates =
            options.until === undefined
              ? {}
              : keepLongerDates(
                  await service.get({ actor, recordId }),
                  options.until,
                  nowTimestamp(),
                  await workspaceZoneOf(port.repositories.workspaceSettings)(options.workspaceId),
                );
          const record = await service.correct({
            actor,
            recordId,
            ...dates,
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.body === undefined ? {} : { body: options.body }),
            ...(options.preferenceValue === undefined
              ? {}
              : { preference: { valueType: "string" as const, value: options.preferenceValue } }),
            ...(options.reason === undefined ? {} : { reason: options.reason }),
          });
          emitJson(io, record);
          return EXIT.ok;
        }
        case "forget": {
          const recordId = requireFlag(options.recordId, "record id");
          // No owner runs, so no provider can take the removal now: each that may hold the record waits for it.
          const before = await service.get({ actor, recordId }).catch(() => undefined);
          const deletion = await service.forget({ actor, recordId, reason: requireFlag(options.reason, "--reason") });
          // A record never approved, or sensitive, was never sent anywhere: nothing of it waits.
          const waiting =
            before === undefined || before.status === "proposed" || before.status === "rejected" || before.sensitivity === "sensitive"
              ? []
              : await offlineRemovalTargets(port, before.scope);
          if (waiting.length > 0) await port.repositories.memory.markDeletionPending(deletion.deletionId, waiting);
          const receipt =
            waiting.length === 0 ? deletion : { ...deletion, cleanupStatus: "pending" as const, pendingProviders: waiting.slice(0, 16) };
          emit(io, options.format, receipt, forgetReceiptText);
          return EXIT.ok;
        }
        case "export": {
          const bundle = await service.export({ actor, ...(explicitScope === undefined ? {} : { scope: explicitScope }) });
          // The export is Tavi's records: an external provider's own index is the plugin's. Said on
          // stderr, so the JSON stays the bundle.
          const provider = (await port.repositories.workspaceSettings.get(options.workspaceId)).settings.memory?.provider;
          if (provider !== undefined && provider !== BUILTIN_MEMORY_PROVIDER_ID) io.stderr(`${externalMemoryIndexNote([provider])}\n`);
          emit(
            io,
            options.format,
            bundle,
            (value) =>
              `${value.records.length} records${value.truncated ? " (truncated)" : ""}, ${value.revisions.length} revisions, ${value.evidence.length} evidence, ${value.reviews.length} reviews`,
          );
          return EXIT.ok;
        }
        default:
          io.stderr("Unsupported memory action\n");
          return EXIT.usage;
      }
    });
  } catch (error) {
    // A cited source (SOURCE_UNAVAILABLE) was valid when typed but has since been
    // revoked — the referenced resource is gone, not a malformed invocation.
    return reportRefusal(error, io, "memory command failed", {
      usage: ["INVALID_INPUT", "MEMORY_CONFLICT", "REVISION_CONFLICT", "QUOTA_EXCEEDED"],
      unavailable: ["NOT_FOUND", "NOT_AUTHORIZED", "SOURCE_UNAVAILABLE"],
    });
  }
}

/**
 * The scope `--scope` names (default: personal), as the owner resolves the
 * same target. `run_local` is not reachable: there is no CLI concept of "the
 * current run" outside a `tavi run` invocation.
 */
function resolveMemoryScope(options: MemoryCommandOptions): MemoryScope {
  return memoryScopeForTarget(options.scope ?? "personal", { principalId: options.principalId, workspaceId: options.workspaceId });
}

/**
 * `tavi memory config [<key> [<value>]]`: the workspace's memory section, one key at a time, through the
 * `workspace-settings` IPC on a live owner (which takes it from the operator
 * only) or the data directory with none. A change reads the section, changes
 * the key, and writes the whole section back held to the revision read — or
 * the one `--revision` names — so a concurrent change is a conflict.
 */
async function memoryConfigCommand(options: ResolvedDataDirectory<MemoryCommandOptions>, io: CliIo): Promise<number> {
  const { workspaceId, configKey: key, configValue: value } = options;
  const change = key !== undefined && value !== undefined ? { key, value } : undefined;
  const render = (answer: WorkspaceSettingsAnswer): number => {
    const section = answer.settings.memory;
    const effective = answer.effective.memory ?? effectiveMemorySettings(section);
    if (options.format === "json") {
      emitJson(io, { workspaceId: answer.workspaceId, revision: answer.revision, settings: section ?? {}, effective });
      return EXIT.ok;
    }
    for (const shown of key === undefined ? MEMORY_CONFIG_KEYS : [key]) {
      io.stdout(`${shown} = ${memoryConfigValue(effective, shown)} ${memoryConfigKeySet(section, shown) ? "(set)" : "(default)"}\n`);
    }
    if (key === undefined) io.stdout(`revision ${answer.revision}\n`);
    return EXIT.ok;
  };
  return runFamily(options.dataDirectory, "workspace-settings", io, {
    label: "tavi memory config",
    mutates: change !== undefined,
    build: async (client) => {
      if (change === undefined) return { action: "get", workspaceId };
      const read = await client.request("workspace-settings", { action: "get", workspaceId }, prefixedId("workspace-settings-read"), {
        timeoutMs: CONFIG_TIMEOUT_MS,
      });
      if (!read.ok)
        throw new TaviError(
          (read.error?.code ?? "UNAVAILABLE") as TaviErrorCode,
          read.error?.message ?? "could not read the workspace settings",
        );
      const current = WorkspaceSettingsAnswerSchema.parse(read.result);
      const section = withMemoryConfig(current.settings.memory, change.key, change.value);
      return {
        action: "set",
        workspaceId,
        key: "memory",
        value: JSON.stringify(section),
        expectedRevision: options.expectedRevision ?? current.revision,
        ...(options.confirmed === true ? { confirmed: true } : {}),
        ...(options.confirmedConnection === undefined ? {} : { confirmedConnection: options.confirmedConnection }),
        ...(options.retrievalPersonal === undefined ? {} : { retrievalPersonal: options.retrievalPersonal }),
      };
    },
    render: (result) => render(WorkspaceSettingsAnswerSchema.parse(result)),
    // Hybrid recall on a remote embedding connection: the disclosure, then how to accept it for that connection.
    refusal: (code, message, details) => ({
      line: code === "APPROVAL_REQUIRED" ? `${message} ${hybridAcceptHint(details)}` : message,
      exit: configRefusalExit(code),
    }),
    offline: async (store) => {
      const settings = store.asPort().repositories.workspaceSettings;
      if (change !== undefined) {
        const current = await settings.get(workspaceId);
        await applyWorkspaceSetting(settings, {
          workspaceId,
          key: "memory",
          value: JSON.stringify(withMemoryConfig(current.settings.memory, change.key, change.value)),
          expectedRevision: options.expectedRevision ?? current.revision,
          actor: operatorActor(false),
          now: nowTimestamp(),
          // Personal memory's disclosure counts the workspace principal's own, resolved as the owner resolves it
          // (`workspacePrincipal`), never a fixed name: the only personal memory it may send.
          retrievalCheck: async () =>
            memoryRetrievalDisclosure(
              store.services.modelConfig,
              store.asPort().repositories.memory,
              workspaceId,
              ownerWorkspacePrincipal(workspaceId),
              nowTimestamp(),
            ),
          ...(options.confirmed === true ? { confirmed: true } : {}),
          ...(options.confirmedConnection === undefined ? {} : { confirmedConnection: options.confirmedConnection }),
          ...(options.retrievalPersonal === undefined ? {} : { retrievalPersonal: options.retrievalPersonal }),
        });
      }
      return render(await workspaceSettingsAnswerFor(settings, workspaceId));
    },
    failed: (error) => {
      const failure = TaviError.from(error);
      // Hybrid recall on a remote embedding connection: the disclosure, then how to accept it.
      return configFailureReporter(
        options.format,
        io,
      )(
        failure.code === "APPROVAL_REQUIRED"
          ? new TaviError(
              failure.code,
              `${failure.message} ${hybridAcceptHint(failure.details)}`,
              failure.details === undefined ? {} : { details: failure.details },
            )
          : failure,
      );
    },
  });
}

/** How `memory config retrieval hybrid` accepts the disclosure it was refused with: for the connection it named. */
function hybridAcceptHint(details: Readonly<Record<string, unknown>> | undefined): string {
  const connection = details?.["connectionId"];
  return `Run it again with --yes=${typeof connection === "string" && connection !== "" ? terminalText(connection) : "<connection>"} to confirm.`;
}
