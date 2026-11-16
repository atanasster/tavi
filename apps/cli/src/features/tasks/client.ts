import { emitError, emitJson, isTextOutput } from "../../cli/output.js";
import { EXIT, configRefusalExit, refusalExit, reportFailure } from "../../cli/exit.js";
import {
  type IpcPayload,
  ChatContextPayloadSchema,
  type ChatContextAnswer,
  type ChatContextPayload,
  type ChatContextExportAnswer,
  type ChatContextForgetAnswer,
  type ChatContextHistoryAnswer,
  type ChatContextRewindAnswer,
  TranscriptPageSchema,
  type TranscriptEntry,
  byteSize,
  chatFolderPruneCommand,
  CHECKPOINTS_KEPT,
  TaviError,
  memoryPendingProvidersNote,
} from "@tavi/contracts";
import type { IpcClient } from "@tavi/runtime";
import type { TaskHistoryOptions, TaskInstructionsOptions, CancelCommandOptions, RecoverCommandOptions } from "./parse.js";
import { terminalText } from "../../shared/terminal-text.js";
import { nowTimestamp, plural } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { homedir } from "node:os";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import { resolveDataDirectory } from "../../shared/data-directory.js";
import type { CliIo } from "../../cli/io.js";
import { attachToOwner, CONFIG_TIMEOUT_MS, runFamily } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStore, withStorePreservingOwnership } from "../../cli/store.js";

/**
 * Cancel a task durably.
 *
 * The record is authoritative in application storage, so a later reply cannot
 * revive the work and pending approvals are closed with it.
 */
export async function cancelTask(options: ResolvedDataDirectory<CancelCommandOptions>, io: CliIo): Promise<number> {
  try {
    const attached = await attachToOwner(
      options.dataDirectory,
      "cancel",
      { taskId: options.taskId, reason: options.reason, operator: options.operator },
      io,
    );
    if (attached !== undefined) return attached;
    const { HOME_CANCEL_REFUSAL, recordCancellation } = await import("./mutations.js");
    return await withStore(options.dataDirectory, async (store) => {
      const repositories = store.asPort().repositories;
      const cancelled = await repositories.tasks.get(options.taskId);
      if (cancelled === undefined) {
        io.stderr(`Task ${options.taskId} does not exist\n`);
        return EXIT.unavailable;
      }
      if (cancelled.chatKind === "home") {
        emitError(io, HOME_CANCEL_REFUSAL);
        // As the owner's refusal exits when attached.
        return EXIT.taskFailed;
      }
      const { record, cancelledApprovals } = await recordCancellation(
        store,
        { taskId: options.taskId, reason: options.reason, operator: options.operator },
        nowTimestamp,
      );
      emitJson(io, { ...record, cancelledApprovals });
      return EXIT.ok;
    });
  } catch (error) {
    return reportFailure(error, io, "could not cancel the task");
  }
}

/**
 * Clear a dead execution slot.
 *
 * This is the production path for `terminate`: without it an invocation killed
 * mid-run would hold its task forever, because the ledger deliberately refuses to
 * treat an expired lease as permission to overlap.
 */
export async function recoverTask(options: ResolvedDataDirectory<RecoverCommandOptions>, io: CliIo): Promise<number> {
  try {
    // A live owner is the authority and answers `recover` too, so this command
    // attaches like `tasks` and `cancel`. Reaching for the database while an owner
    // holds the directory would either fail (exit 5) or become a second writer.
    const attached = await attachToOwner(
      options.dataDirectory,
      "recover",
      {
        taskId: options.taskId,
        generation: options.generation,
        reason: options.reason,
        operator: options.operator,
      },
      io,
    );
    if (attached !== undefined) return attached;
    const { terminateExecution } = await import("./mutations.js");
    return await withStore(options.dataDirectory, async (store) => {
      const document = await terminateExecution(
        store,
        {
          taskId: options.taskId,
          generation: options.generation,
          reason: options.reason,
          operator: options.operator,
        },
        nowTimestamp,
      );
      emitJson(io, document);
      return EXIT.ok;
    });
  } catch (error) {
    // The shared mutation reports these as typed refusals; map them to the exit
    // codes the command documents rather than treating them as failures.
    const refusal = TaviError.from(error);
    if (refusal.code === "NOT_FOUND") {
      emitError(io, refusal.message);
      return EXIT.unavailable;
    }
    if (refusal.code === "INVALID_INPUT") {
      emitError(io, refusal.message);
      return EXIT.usage;
    }
    return reportFailure(error, io, "could not terminate the execution");
  }
}

export async function listTasks(io: CliIo, explicit?: string, taskId?: string): Promise<number> {
  const dataDirectory = resolveDataDirectory(explicit);
  try {
    // A live owner answers over IPC; opening the database directly is only for
    // when nobody is running. The task-id filter travels in the request
    // payload so an attached client gets the same single-task view a direct,
    // unattached invocation would.
    const print = (document: unknown): void => printTasks(io, document as Record<string, unknown>, taskId);
    const attached = await attachToOwner(dataDirectory, "tasks", taskId === undefined ? {} : { taskId }, io, undefined, undefined, print);
    if (attached !== undefined) return attached;
    // The offline path's modules load only when no owner answers: an attached `tavi tasks` stays off the runtime.
    const { buildTaskDocument, buildTaskShowDocument } = await import("../doctor/reports.js");
    return await withStore(dataDirectory, async (store) => {
      const now = nowTimestamp();
      const document =
        taskId === undefined
          ? await buildTaskDocument(store, dataDirectory, now)
          : await buildTaskShowDocument(store, dataDirectory, taskId, now);
      // Matches the attached (IPC) path: a not-found task is NOT_FOUND/exit
      // `unavailable` with no document body, not a document that merely says
      // `found: false` — the two paths must agree on both the exit code and
      // what gets printed for the same outcome.
      if (taskId !== undefined && document["found"] !== true) {
        io.stderr(`tasks failed: NOT_FOUND: Task ${taskId} does not exist\n`);
        return EXIT.unavailable;
      }
      print(document);
      return EXIT.ok;
    });
  } catch (error) {
    return reportFailure(error, io, "could not read task history");
  }
}

/** `tavi tasks` as its text form at a terminal or under `--format text` (the list; one task stays a record), else JSON. */
function printTasks(io: CliIo, document: Record<string, unknown>, taskId: string | undefined): void {
  if (taskId === undefined && isTextOutput(io)) io.stdout(taskListText(document));
  else emitJson(io, document);
}

const listOf = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];

/** One line a task's own text is shown on: no control character or line break, clipped. */
const lineOf = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? terminalText(value).replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * `tavi tasks` for a person: the most recent tasks, a line each — status, when, id, title — then what waits on
 * them (approvals, unresolved effects, deliveries, expired leases), each a count with the command that shows it.
 */
export function taskListText(document: Record<string, unknown>): string {
  const tasks = listOf(document["tasks"]);
  const lines: string[] = [];
  if (tasks.length === 0) lines.push("No tasks yet.");
  else {
    const width = Math.max(...tasks.map((task) => String(task["status"] ?? "").length));
    for (const task of tasks) {
      const status = String(task["status"] ?? "").padEnd(width);
      const when = typeof task["updatedAt"] === "string" ? task["updatedAt"].slice(0, 16).replace("T", " ") : "";
      const title = lineOf(task["title"], 70) || lineOf(task["summary"], 70) || lineOf(task["finalText"], 70);
      lines.push(`${status}  ${when}  ${String(task["taskId"] ?? "")}${title === "" ? "" : `  ${title}`}`);
    }
  }
  const counts: [unknown, string, string][] = [
    [document["pendingApprovals"], "pending approval", "pending approvals"],
    [document["unresolvedEffects"], "effect of unknown outcome", "effects of unknown outcome"],
    [document["pendingDeliveries"], "delivery of unknown outcome", "deliveries of unknown outcome"],
    [document["expiredLeases"], "expired lease", "expired leases"],
    [document["cancellations"], "cancellation", "cancellations"],
  ];
  const waiting = counts.filter(([list]) => listOf(list).length > 0).map(([list, one, many]) => plural(listOf(list).length, one, many));
  if (waiting.length > 0) lines.push("", `Also: ${waiting.join(", ")}.`);
  lines.push("", "One task in full: tavi tasks <task-id>. Everything as JSON: tavi tasks --format json.");
  return `${lines.join("\n")}\n`;
}

/**
 * `tavi tasks instructions <task-id> [show|history|set <text>|reset]`:
 * one chat's own instructions, through the
 * owner's `chat-context` when one is running, else from the data directory.
 * A write saves against the revision it read, or the one `--revision` names.
 */
/** `tavi tasks history`: a chat's saved history, exported page by page, erased or rewound, on the owner or the data directory. */
export async function taskHistoryCli(io: CliIo, dataDirectory: string, options: TaskHistoryOptions): Promise<number> {
  const target = { workspaceId: options.workspaceId, taskId: options.taskId };
  /** Ask once, on the owner when one runs, else on the data directory; a refusal is reported and ends the command. */
  const ask = async (payload: ChatContextPayload, client?: IpcClient): Promise<{ readonly result?: unknown; readonly exit?: number }> => {
    if (client !== undefined) {
      const answer = await client.request("chat-context", payload, prefixedId("tasks-history"), { timeoutMs: CONFIG_TIMEOUT_MS });
      if (answer.ok) return { result: answer.result };
      return { exit: refusalExit(io, answer.error) };
    }
    const [{ ChatFolders, measureFolder }, { chatContextCommand }, { operatorActor }] = await Promise.all([
      import("@tavi/runtime"),
      import("./history-owner.js"),
      import("../../server/config-commands.js"),
    ]);
    return withStorePreservingOwnership(dataDirectory, async (store) => {
      const repositories = store.asPort().repositories;
      // No roots offline: only the chat's own folder is named.
      const folders = new ChatFolders({
        dataDirectory,
        fsRoots: [],
        homeDirectory: homedir(),
        repository: repositories.taskFolders,
        tasks: repositories.tasks,
        agentDelegations: repositories.agentDelegations,
      });
      const answer = await chatContextCommand(
        {
          repositories,
          author: operatorActor(false),
          principalOf: () => "operator",
          now: nowTimestamp,
          pruneCheckpoints: (threadId: string) => store.checkpoints.pruneThread({ threadId, keep: CHECKPOINTS_KEPT }),
          // The untagged archives only its checkpoint names go too, as on the owner.
          folderOf: async (workspaceId, taskId) => await measureFolder(await folders.managedFolderPath(workspaceId, taskId)),
        },
        payload,
      );
      if (answer.ok) return { result: answer.result };
      return { exit: refusalExit(io, answer.error) };
    });
  };
  /** Saved turn `seq`, read where the rewind will run: its prompt is what the rewind is checked against. */
  const savedTurn = async (
    seq: number,
    client?: IpcClient,
  ): Promise<{ readonly entry?: TranscriptEntry | undefined; readonly exit?: number }> => {
    if (client !== undefined) {
      const answer = await client.request(
        "tasks",
        { action: "transcript", ...target, before: seq + 1, limit: 1 },
        prefixedId("tasks-history"),
        { timeoutMs: CONFIG_TIMEOUT_MS },
      );
      if (!answer.ok) {
        return { exit: refusalExit(io, answer.error) };
      }
      const page = TranscriptPageSchema.safeParse(answer.result);
      if (!page.success) {
        io.stderr("The owner's answer for the chat's history could not be read\n");
        return { exit: EXIT.internal };
      }
      return { entry: page.data.entries.find((saved) => saved.seq === seq) };
    }
    return withStorePreservingOwnership(dataDirectory, async (store) => {
      const repositories = store.asPort().repositories;
      const task = await repositories.tasks.get(options.taskId);
      if (task === undefined || task.workspaceId !== options.workspaceId) {
        io.stderr(`Task ${terminalText(options.taskId)} does not exist\n`);
        return { exit: configRefusalExit("NOT_FOUND") };
      }
      return {
        entry: (await repositories.transcripts.page(options.taskId, { before: seq + 1, limit: 1 })).entries.find(
          (saved) => saved.seq === seq,
        ),
      };
    });
  };
  const command = async (client?: IpcClient): Promise<number> => {
    if (options.action === "rewind") {
      const seq = options.turn ?? 0;
      const read = await savedTurn(seq, client);
      if (read.exit !== undefined) return read.exit;
      const prompt = read.entry?.turn.prompt;
      if (prompt === undefined || prompt === "") {
        io.stderr(
          `Chat ${terminalText(options.taskId)} has no turn ${seq} with a message to rewind to: \`tavi tasks history ${terminalText(options.taskId)}\` lists its turns\n`,
        );
        return configRefusalExit("NOT_FOUND");
      }
      const done = await ask({ action: "rewind", ...target, seq, prompt }, client);
      if (done.exit !== undefined) return done.exit;
      const answer = done.result as ChatContextRewindAnswer;
      io.stdout(
        `Rewound chat ${terminalText(options.taskId)} to before turn ${seq}: took back ${plural(answer.rewound, "saved turn")}. The model is no longer given ${answer.rewound === 1 ? "it" : "them"} from the chat's next message.\n`,
      );
      // Rewind never touches files.
      io.stdout("Files in the chat's folder were not changed.\n");
      io.stdout(`Turn ${seq}'s message, to send again:\n${terminalText(answer.prompt)}\n`);
      return EXIT.ok;
    }
    if (options.action === "forget") {
      // The chat's memory is the owner's to forget: asked offline, nothing is erased yet.
      if (options.withMemory === true && client === undefined) {
        io.stderr("`--with-memory` needs a running owner: start `tavi serve` and run it again.\n");
        return EXIT.usage;
      }
      const done = await ask(
        {
          action: "forget",
          ...target,
          ...(options.epoch === undefined ? { before: options.before ?? "" } : { epoch: options.epoch }),
          ...(options.withMemory === true ? { withMemory: true as const } : {}),
        },
        client,
      );
      if (done.exit !== undefined) return done.exit;
      // An older owner answers neither `before` nor `related`.
      const answer = done.result as Omit<ChatContextForgetAnswer, "before" | "related"> &
        Partial<Pick<ChatContextForgetAnswer, "before" | "related">>;
      const related = answer.related ?? [];
      const pruned = answer.checkpointsPruned === 0 ? "" : `, and let go of ${plural(answer.checkpointsPruned, "older checkpoint")}`;
      io.stdout(
        `Erased ${plural(answer.forgotten, "saved turn")} from before ${answer.before ?? options.before ?? "then"}${options.epoch === undefined ? "" : ` (epoch ${options.epoch} began)`}${pruned}.\n`,
      );
      // Its archives and what it taught; an older owner answers none of these.
      if (answer.archives !== undefined && answer.archives > 0)
        io.stdout(`Deleted ${plural(answer.archives, "archive")} of its earlier turns.\n`);
      if (answer.proposals !== undefined && answer.proposals > 0)
        io.stdout(`Forgot ${plural(answer.proposals, "memory proposal")} it made that still waited.\n`);
      if (answer.memories !== undefined && answer.memories > 0)
        io.stdout(`Forgot ${plural(answer.memories, "memory", "memories")} it taught.\n`);
      if (answer.memoriesKept !== undefined)
        io.stdout(
          `${plural(answer.memoriesKept, "memory", "memories")} it taught ${answer.memoriesKept === 1 ? "stays" : "stay"}; --with-memory forgets ${answer.memoriesKept === 1 ? "it" : "them"} too.\n`,
        );
      if (answer.memoryNotYours === true) io.stdout("Its memory belongs to the person the chat is with and was not touched.\n");
      // A provider that could not take a removal now is named, as `tavi memory forget` names it.
      const waiting = memoryPendingProvidersNote(answer.memoryWaitsFor);
      if (waiting !== undefined) io.stdout(`${waiting.replace(/^It will/, "What it taught will")}\n`);
      if (client === undefined)
        io.stdout("Its memory proposals were not checked offline: run this again with `tavi serve` running to forget them.\n");
      if (related.length > 0) {
        io.stdout("These chats were begun from it before then and keep their own copy of what they were given; forget them too:\n");
        for (const chat of related) io.stdout(`  ${terminalText(chat.taskId)}\t${chat.kind === "side" ? "side chat" : "worker"}\n`);
      }
      // Nor does forget reach the chat's folder: named, with its size and how to clear it.
      if (answer.folder !== undefined) {
        io.stdout(
          `The chat's folder was not touched: ${terminalText(answer.folder.path)} (${answer.folder.approximate === true ? "at least " : ""}${byteSize(answer.folder.bytes)}); clear it with \`${chatFolderPruneCommand(options.taskId)}\` (with the owner stopped).\n`,
        );
      }
      return EXIT.ok;
    }
    // Oldest page first, each written as it comes: a long Home is never held whole.
    let after: number | undefined;
    let noticeSkip: number | undefined;
    let first = true;
    do {
      const done = await ask(
        { action: "export", ...target, ...(after === undefined ? {} : { after }), ...(noticeSkip === undefined ? {} : { noticeSkip }) },
        client,
      );
      if (done.exit !== undefined) return done.exit;
      const page = done.result as ChatContextExportAnswer;
      if (first) {
        io.stdout(`# ${page.title}\n`);
        if (page.epochSummary !== undefined) io.stdout(`\n## Earlier, in summary\n\n${page.epochSummary}\n`);
        first = false;
      }
      if (page.markdown !== "") io.stdout(`\n${page.markdown}\n`);
      after = page.nextAfter;
      noticeSkip = page.nextNoticeSkip;
    } while (after !== undefined);
    return EXIT.ok;
  };
  try {
    const client = await connectOwnerOrReport(dataDirectory, ["chat-context"], io, EXIT);
    if (typeof client === "number") return client;
    if (client === undefined) return await command();
    try {
      return await command(client);
    } finally {
      client.close();
    }
  } catch (error) {
    return refusalExit(io, TaviError.from(error));
  }
}

export async function taskInstructionsCli(io: CliIo, dataDirectory: string, options: TaskInstructionsOptions): Promise<number> {
  const label = `tavi tasks instructions ${options.action}`;
  const write = options.action === "set" || options.action === "reset";
  const payloadFor = (expectedRevision: number): IpcPayload<"chat-context"> =>
    options.action === "set"
      ? { action: "set", workspaceId: options.workspaceId, taskId: options.taskId, text: options.text as string, expectedRevision }
      : options.action === "reset"
        ? { action: "reset", workspaceId: options.workspaceId, taskId: options.taskId, expectedRevision }
        : { action: options.action === "show" ? "get" : "history", workspaceId: options.workspaceId, taskId: options.taskId };
  const render = (result: unknown): number => {
    if (options.action === "history") {
      const revisions = (result as ChatContextHistoryAnswer).revisions;
      if (revisions.length === 0) io.stdout("No instructions of its own.\n");
      for (const revision of revisions) {
        const line = revision.text === "" ? "(cleared)" : (revision.text.split("\n", 1)[0] ?? "");
        io.stdout(`${revision.revision}\t${revision.recordedAt}\t${revision.author}\t${terminalText(line)}\n`);
      }
      return EXIT.ok;
    }
    const answer = result as ChatContextAnswer;
    if (write) {
      io.stdout(`Saved revision ${answer.revision}; it applies from the chat's next turn.\n`);
      return EXIT.ok;
    }
    if (answer.delegatedFrom !== undefined)
      io.stdout(`An agent's task: it runs under its agent's instructions, not those of its chat ${answer.delegatedFrom}.\n`);
    if (answer.current === null || answer.current.text === "") {
      io.stdout(answer.current === null ? "No instructions of its own.\n" : `Cleared in revision ${answer.revision}.\n`);
      return EXIT.ok;
    }
    io.stdout(
      `Revision ${answer.revision} (${answer.current.author}, ${answer.current.recordedAt}):\n${terminalText(answer.current.text)}\n`,
    );
    return EXIT.ok;
  };
  return runFamily(dataDirectory, "chat-context", io, {
    label,
    mutates: write,
    build: async (client) => {
      if (!write || options.revision !== undefined) return payloadFor(options.revision ?? 0);
      // The revision a write is checked against, read on the same connection.
      const read = await client.request(
        "chat-context",
        { action: "get", workspaceId: options.workspaceId, taskId: options.taskId },
        prefixedId("chat-context-read"),
        { timeoutMs: CONFIG_TIMEOUT_MS },
      );
      if (!read.ok) {
        return refusalExit(io, read.error, "could not read the chat's instructions");
      }
      return payloadFor((read.result as ChatContextAnswer).revision);
    },
    render,
    offline: async (store) => {
      const [{ chatContextCommand }, { operatorActor }] = await Promise.all([
        import("./history-owner.js"),
        import("../../server/config-commands.js"),
      ]);
      const repositories = store.asPort().repositories;
      const deps = {
        repositories,
        author: operatorActor(false),
        principalOf: () => "operator",
        now: nowTimestamp,
        pruneCheckpoints: (threadId: string) => store.checkpoints.pruneThread({ threadId, keep: CHECKPOINTS_KEPT }),
      };
      const expectedRevision = options.revision ?? (await repositories.chatInstructions.current(options.taskId))?.revision ?? 0;
      const payload = ChatContextPayloadSchema.safeParse(payloadFor(expectedRevision));
      if (!payload.success) {
        io.stderr(`${label}: ${terminalText(payload.error.issues[0]?.message ?? "invalid arguments")}\n`);
        return EXIT.usage;
      }
      const answer = await chatContextCommand(deps, payload.data);
      // Reported as the owner path reports a refusal: its message, and the exit for its code.
      if (!answer.ok) {
        return refusalExit(io, answer.error);
      }
      return render(answer.result);
    },
    failed: (error) => {
      return refusalExit(io, TaviError.from(error));
    },
  });
}
