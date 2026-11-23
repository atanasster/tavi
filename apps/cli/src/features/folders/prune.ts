import { FOLDER_TRASH_KEEP_DAYS, byteSize } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { applyFolderPrune, planFolderPrune, type FolderPruneDependencies } from "@tavi/runtime";

import type { TaskFoldersPruneOptions } from "./parse.js";
import { terminalText } from "../../shared/terminal-text.js";
import { yesNoHint } from "../../shared/terminal-words.js";

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
  /** The workspace's words for the plan, the question and the outcome; English when absent. */
  readonly words?: CoreT;
  readonly exit: { readonly ok: number; readonly usage: number; readonly unavailable: number };
}

/** The prune's question: `Move 2 folder(s) (3 MB) to the trash and delete 1 from it?`, in the workspace's words. */
function foldersQuestion(folders: number, total: string, expired: number, t: CoreT = coreEnglish): string {
  const move = t("prompt.folders.move", { n: String(folders), count: folders, total });
  return expired > 0
    ? t("prompt.folders.moveAndDelete", { move, n: String(expired), count: expired })
    : t("prompt.folders.moveOnly", { move });
}

/** A size as the plan prints it: "at least" when its walk stopped at its bound. */
const sized = (entry: { readonly bytes: number; readonly approximate?: true }, t: CoreT): string =>
  entry.approximate === true ? t("prompt.folders.atLeast", { size: byteSize(entry.bytes) }) : byteSize(entry.bytes);

export async function foldersPrune(deps: FoldersPruneDependencies, options: TaskFoldersPruneOptions): Promise<number> {
  const { io } = deps;
  const t = deps.words ?? coreEnglish;
  const days = String(FOLDER_TRASH_KEEP_DAYS);
  const plan = await planFolderPrune(deps, {
    olderThanDays: options.olderThanDays,
    olderThanGiven: options.olderThanGiven,
    ...(options.chat === undefined ? {} : { chat: { workspaceId: options.workspaceId, taskId: options.chat } }),
  });
  const expired = plan.trash.filter((entry) => entry.expired);
  if (plan.folders.length === 0)
    io.stdout(
      `${
        options.chat === undefined
          ? t("prompt.folders.noneOld", { days: String(options.olderThanDays) })
          : t("prompt.folders.noneChat", { chat: options.chat })
      }\n`,
    );
  else {
    io.stdout(`${t(options.dryRun ? "prompt.folders.wouldMove" : "prompt.folders.toMove", { days })}\n`);
    for (const entry of plan.folders)
      io.stdout(
        `  ${terminalText(entry.taskId)}\t${entry.kind}\t${sized(entry, t)}\t${t("prompt.folders.lastActive", { when: entry.lastActiveAt })}\t${terminalText(entry.path)}\n`,
      );
  }
  if (plan.skipped.length > 0) {
    io.stdout(`${t("prompt.folders.leftInPlace")}\n`);
    for (const entry of plan.skipped) io.stdout(`  ${terminalText(entry.taskId ?? entry.path)}\t${terminalText(entry.reason)}\n`);
  }
  if (plan.trash.length > 0) {
    io.stdout(
      `${t(options.dryRun ? "prompt.folders.trashWould" : "prompt.folders.trash", {
        n: String(plan.trash.length),
        count: plan.trash.length,
        size: byteSize(plan.trash.reduce((total, entry) => total + entry.bytes, 0)),
        expired: String(expired.length),
        days,
      })}\n`,
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
      !(await deps.confirm(`${foldersQuestion(plan.folders.length, total, expired.length, deps.words)} ${yesNoHint(false, deps.words)} `))
    ) {
      io.stdout(`${t("prompt.folders.nothingMoved")}\n`);
      return deps.exit.ok;
    }
  }
  const result = await applyFolderPrune(deps, plan);
  for (const moved of result.moved)
    io.stdout(`${t("prompt.folders.moved", { task: terminalText(moved.taskId), to: terminalText(moved.to) })}\n`);
  for (const removed of result.removed) io.stdout(`${t("prompt.folders.deleted", { path: terminalText(removed) })}\n`);
  for (const failed of result.failed)
    io.stderr(`${t("prompt.folders.moveFailed", { task: terminalText(failed.taskId), reason: terminalText(failed.reason) })}\n`);
  for (const failed of result.trashFailed)
    io.stderr(`${t("prompt.folders.deleteFailed", { path: terminalText(failed.path), reason: terminalText(failed.reason) })}\n`);
  return result.failed.length === 0 && result.trashFailed.length === 0 ? deps.exit.ok : deps.exit.unavailable;
}
