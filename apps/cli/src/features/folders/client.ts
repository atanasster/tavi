import { EXIT, refusalExit, reportCommandFailure } from "../../cli/exit.js";
import { TASK_LIST_LIMIT, FolderViewSchema, TaviError } from "@tavi/contracts";
import { ChatFolders } from "@tavi/runtime";
import type { TaskFolderOptions, TaskFoldersPruneOptions } from "./parse.js";
import { foldersPrune } from "./prune.js";
import { folderLines, hostPathOf } from "./owner.js";
import { terminalText } from "../../shared/terminal-text.js";
import { storeWords } from "../../shared/terminal-words.js";
import { prefixedId } from "@tavi/node-kit";
import { homedir } from "node:os";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import { type CliIo, confirmOnTerminal } from "../../cli/io.js";
import { CONFIG_TIMEOUT_MS } from "../../cli/owner.js";
import { withStorePreservingOwnership } from "../../cli/store.js";
import { emitJson } from "../../cli/output.js";
import { remoteFoldersOf } from "../remote/folders.js";

/**
 * `tavi tasks folder <task-id> [show|set <path>|attach <path> [--rw]|detach <label>|reset]`:
 * one chat's working folder, as `/folder`
 * in `tavi chat` shows and changes it. On the owner only: a path is checked
 * against its `--fs-root` folders, which no data directory records.
 */
export async function taskFolderCli(
  io: CliIo,
  dataDirectory: string,
  options: TaskFolderOptions,
  format?: "text" | "json",
): Promise<number> {
  // A folder for an owner on another computer is named as it is there; a path that cannot be is refused before anything is sent.
  let folderPath = "";
  if (options.action === "set" || options.action === "attach") {
    try {
      folderPath = hostPathOf(options.path ?? "", undefined, undefined, remoteFoldersOf(dataDirectory));
    } catch (error) {
      if (!(error instanceof TaviError) || error.code !== "INVALID_INPUT") throw error;
      io.stderr(`tavi tasks folder: ${error.message}\n`);
      return EXIT.usage;
    }
  }
  const client = await connectOwnerOrReport(dataDirectory, ["folder"], io, EXIT);
  if (typeof client === "number") return client;
  if (client === undefined) {
    io.stderr(
      `tavi tasks folder needs a running owner, whose --fs-root folders a folder is checked against; no owner is running on ${dataDirectory}\n`,
    );
    return EXIT.unavailable;
  }
  try {
    const target = { workspaceId: options.workspaceId, taskId: options.taskId };
    const payload =
      options.action === "show"
        ? { action: "show", ...target }
        : options.action === "set"
          ? { action: "set", ...target, folder: { path: folderPath } }
          : options.action === "attach"
            ? {
                action: "attach",
                ...target,
                folder: { path: folderPath },
                ...(options.rw === true ? { mode: "rw" } : {}),
              }
            : options.action === "detach"
              ? { action: "detach", ...target, label: options.label ?? "" }
              : { action: "reset", ...target };
    const answer = await client.request("folder", payload, prefixedId("tasks-folder"), { timeoutMs: CONFIG_TIMEOUT_MS });
    if (!answer.ok) {
      return refusalExit(io, answer.error);
    }
    const view = FolderViewSchema.safeParse(answer.result);
    if (!view.success) {
      io.stderr("The owner's answer for the chat's folder could not be read\n");
      return EXIT.internal;
    }
    // JSON is the owner's view as it came: where the chat works, its attachments, its own folder and its budget.
    if (format === "json") emitJson(io, view.data);
    else for (const line of folderLines(view.data, options.action !== "show")) io.stdout(`${terminalText(line)}\n`);
    // A folder that is gone is shown, not refused: `reset` is the remedy.
    return view.data.unavailable === undefined ? EXIT.ok : EXIT.unavailable;
  } catch (error) {
    return refusalExit(io, TaviError.from(error));
  } finally {
    client.close();
  }
}

/**
 * `tavi tasks folders prune [--older-than <days>] [--chat <task-id>] [--dry-run] [--yes]`.
 * Offline, like `tavi prune`:
 * it takes the data directory's ownership, so a running owner refuses it with
 * the ownership message — no turn can start while folders move.
 */
export async function taskFoldersPruneCli(io: CliIo, dataDirectory: string, options: TaskFoldersPruneOptions): Promise<number> {
  try {
    return await withStorePreservingOwnership(
      dataDirectory,
      async (store) => {
        const repositories = store.asPort().repositories;
        // No roots offline: only chats' own folders are ever touched.
        const folders = new ChatFolders({
          dataDirectory,
          fsRoots: [],
          homeDirectory: homedir(),
          repository: repositories.taskFolders,
          tasks: repositories.tasks,
          agentDelegations: repositories.agentDelegations,
        });
        return await foldersPrune(
          {
            dataDirectory,
            tasks: repositories.tasks,
            workersInProgress: async (workspaceId, taskId) => await repositories.agentDelegations.countRunningInTree(workspaceId, taskId),
            sideChats: async (workspaceId, taskId) => {
              const ids: string[] = [];
              let cursor: string | undefined;
              do {
                const page = await store.listTaskSessions({
                  workspaceId,
                  parentChatId: taskId,
                  limit: TASK_LIST_LIMIT,
                  ...(cursor === undefined ? {} : { cursor }),
                });
                ids.push(...page.rows.map((row) => row.taskId));
                cursor = page.nextCursor;
              } while (cursor !== undefined);
              return ids;
            },
            folderRecord: async (taskId) => await repositories.taskFolders.get(taskId),
            managedPath: (workspaceId, taskId) => folders.managedPath(workspaceId, taskId),
            chatOf: async (workspaceId, taskId) => await folders.chatOf(workspaceId, taskId),
            io,
            confirm: io.isTty ? confirmOnTerminal : undefined,
            words: await storeWords(store, options.workspaceId),
            exit: EXIT,
          },
          options,
        );
      },
      "pruning folders needs it to itself, even with --dry-run, so no turn starts while folders move",
    );
  } catch (error) {
    return reportCommandFailure(error, io, "tasks folders prune failed");
  }
}
