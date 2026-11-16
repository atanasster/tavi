import { FOLDER_TRASH_KEEP_DAYS, byteSize } from "@tavi/contracts";
import { applyFolderPrune, planFolderPrune, type FolderPruneDependencies } from "@tavi/runtime";

import type { TaskFoldersPruneOptions } from "./parse.js";
import { terminalText } from "../../shared/terminal-text.js";

/**
 * `tavi tasks folders prune`:
 * print the plan, ask, then move each folder into `chats/.trash/` and delete
 * what has waited there seven days. Nothing moves without a yes: `--yes`
 * answers it, and without a terminal (no `confirm`) it is required.
 */
export interface FoldersPruneDependencies extends FolderPruneDependencies {
  readonly io: { readonly stdout: (chunk: string) => void; readonly stderr: (chunk: string) => void };
  /** Asks the person at the terminal; absent without one. */
  readonly confirm: ((question: string) => Promise<boolean>) | undefined;
  readonly exit: { readonly ok: number; readonly usage: number; readonly unavailable: number };
}

/** A size as the plan prints it: "at least" when its walk stopped at its bound. */
const sized = (entry: { readonly bytes: number; readonly approximate?: true }): string =>
  `${entry.approximate === true ? "at least " : ""}${byteSize(entry.bytes)}`;

export async function foldersPrune(deps: FoldersPruneDependencies, options: TaskFoldersPruneOptions): Promise<number> {
  const { io } = deps;
  const plan = await planFolderPrune(deps, {
    olderThanDays: options.olderThanDays,
    olderThanGiven: options.olderThanGiven,
    ...(options.chat === undefined ? {} : { chat: { workspaceId: options.workspaceId, taskId: options.chat } }),
  });
  const expired = plan.trash.filter((entry) => entry.expired);
  const what =
    options.chat === undefined ? `runs' folders unused for more than ${options.olderThanDays} days` : `chat ${options.chat}'s folder`;
  if (plan.folders.length === 0) io.stdout(`No ${what} to move.\n`);
  else {
    io.stdout(`${options.dryRun ? "Would move" : "To move"} to chats/.trash/ (deleted after ${FOLDER_TRASH_KEEP_DAYS} days):\n`);
    for (const entry of plan.folders)
      io.stdout(
        `  ${terminalText(entry.taskId)}\t${entry.kind}\t${sized(entry)}\tlast active ${entry.lastActiveAt}\t${terminalText(entry.path)}\n`,
      );
  }
  if (plan.skipped.length > 0) {
    io.stdout("Left in place:\n");
    for (const entry of plan.skipped) io.stdout(`  ${terminalText(entry.taskId ?? entry.path)}\t${terminalText(entry.reason)}\n`);
  }
  if (plan.trash.length > 0) {
    io.stdout(
      `In the trash: ${plan.trash.length} folder(s), ${byteSize(plan.trash.reduce((total, entry) => total + entry.bytes, 0))}; ${expired.length} past ${FOLDER_TRASH_KEEP_DAYS} days ${options.dryRun ? "would be" : "to be"} deleted.\n`,
    );
  }
  if (options.dryRun) return deps.exit.ok;
  if (plan.folders.length === 0 && expired.length === 0) return deps.exit.ok;
  if (!options.yes) {
    if (deps.confirm === undefined) {
      io.stderr(
        "tasks folders prune asks before it moves anything, and this is not a terminal: pass --yes to go ahead, or --dry-run to see the plan only\n",
      );
      return deps.exit.usage;
    }
    const total = byteSize(plan.folders.reduce((sum, entry) => sum + entry.bytes, 0));
    if (
      !(await deps.confirm(
        `Move ${plan.folders.length} folder(s) (${total}) to the trash${expired.length > 0 ? ` and delete ${expired.length} from it` : ""}? [y/N] `,
      ))
    ) {
      io.stdout("Nothing moved.\n");
      return deps.exit.ok;
    }
  }
  const result = await applyFolderPrune(deps, plan);
  for (const moved of result.moved) io.stdout(`Moved ${terminalText(moved.taskId)}'s folder to ${terminalText(moved.to)}\n`);
  for (const removed of result.removed) io.stdout(`Deleted ${terminalText(removed)} from the trash\n`);
  for (const failed of result.failed) io.stderr(`Could not move ${terminalText(failed.taskId)}'s folder: ${terminalText(failed.reason)}\n`);
  for (const failed of result.trashFailed)
    io.stderr(`Could not delete ${terminalText(failed.path)} from the trash: ${terminalText(failed.reason)}\n`);
  return result.failed.length === 0 && result.trashFailed.length === 0 ? deps.exit.ok : deps.exit.unavailable;
}
