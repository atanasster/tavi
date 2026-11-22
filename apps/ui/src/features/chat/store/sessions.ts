import { translateNow } from "../../../lib/i18n.js";
import { conversationOfRecorded, turnEnded } from "@tavi/client/browser";
import { TASK_NEEDS, type TaskListFilters, TaskListResultSchema, type TaskListRow } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { refusal } from "../../../lib/ipc.js";
import { mergeBy } from "../../../lib/paging.js";
import { readTaskRecord } from "../tasks-api.js";
import type { StoreContext } from "./context.js";
import { cancelReasonOf, promptsOf, RECORD_READ } from "./record.js";
import type { CanvasStore } from "./types.js";

const taskKey = (row: TaskListRow): string => row.taskId;

/** The chat list, and opening a chat. */
export function installSessions(ctx: StoreContext): void {
  const { client, options, conversations, workers, reopening } = ctx;
  let listGeneration = 0;
  let loadedPages = 1;
  let activeSessionFilters: TaskListFilters = {};
  let listedRows: readonly TaskListRow[] = [];
  /** The shown chat's listed `updatedAt` when the page first saw it settled: a later one is a turn the page missed. */
  const settledSince = new Map<string, string>();
  const loadSessions: CanvasStore["loadSessions"] = async (filters, more = false, refresh = false) => {
    if (filters !== undefined) activeSessionFilters = filters;
    const query = activeSessionFilters;
    const observedNeeds = Object.fromEntries(
      ctx.state.runs.flatMap((run) => (run.run.taskId && run.needsRevision ? [[run.run.taskId, run.needsRevision]] : [])),
    );
    const generation = ++listGeneration;
    const previous = ctx.state.directory;
    const pages = refresh ? loadedPages : 1;
    const cursor = more ? previous?.nextCursor : undefined;
    ctx.publish({
      ...ctx.state,
      directory: {
        ...previous,
        rows: previous?.rows ?? [],
        needs: previous?.needs ?? [],
        needsTruncated: previous?.needsTruncated ?? false,
        loading: true,
      },
    });
    try {
      const [page, inbox, homeAnswer] = await Promise.all([
        client.request("tasks", { ...query, action: "list", workspaceId: options.workspaceId, ...(cursor ? { cursor } : {}) }),
        client.request("tasks", { action: "list", workspaceId: options.workspaceId, needs: [...TASK_NEEDS] }),
        // The reader's Home, read apart: pinned in the sidebar
        // whatever the search, and however many newer chats push it off the page.
        // An owner that cannot answer costs only the pin.
        client
          .request("tasks", {
            action: "list",
            workspaceId: options.workspaceId,
            chatKinds: ["home"],
            principalId: options.principal,
            limit: 1,
          })
          .catch(() => undefined),
      ]);
      if (ctx.disposed || generation !== listGeneration) return;
      if (!page.ok || !inbox.ok)
        throw new Error(
          translateNow("chat.files.restartHint", {
            message: page.error?.message ?? inbox.error?.message ?? translateNow("chat.store.listRefused"),
          }),
        );
      const list = TaskListResultSchema.safeParse(page.result);
      const needs = TaskListResultSchema.safeParse(inbox.result);
      if (!list.success || !needs.success) throw new Error(translateNow("chat.store.listUnsupported"));
      const inWorkspace = (row: TaskListRow) => row.workspaceId === options.workspaceId;
      // A worker is no chat: its need is its root's, which counts it (`descendantNeeds`)
      // and shows it in the root's transcript, so its own inbox row is never listed.
      const needsRows = needs.data.rows.filter((row) => inWorkspace(row) && row.rootTaskId === undefined && row.chatKind !== "worker");
      const pageRows = list.data.rows.filter(inWorkspace);
      let nextCursor = list.data.nextCursor;
      for (let pageIndex = 1; pageIndex < pages && nextCursor; pageIndex++) {
        const answer = await client.request("tasks", { ...query, action: "list", workspaceId: options.workspaceId, cursor: nextCursor });
        if (ctx.disposed || generation !== listGeneration) return;
        if (!answer.ok) throw new Error(refusal(answer, translateNow("chat.store.listRefused")));
        const next = TaskListResultSchema.parse(answer.result);
        pageRows.push(...next.rows.filter(inWorkspace));
        nextCursor = next.nextCursor;
      }
      loadedPages = more ? loadedPages + 1 : pages;
      const homeList = homeAnswer?.ok === true ? TaskListResultSchema.safeParse(homeAnswer.result) : undefined;
      const homeRows = homeList?.success === true ? homeList.data.rows.filter((row) => inWorkspace(row) && row.chatKind === "home") : [];
      listedRows = mergeBy([homeRows, more ? listedRows : [], pageRows], taskKey);
      const inboxRows = new Map(needsRows.map((row) => [row.taskId, row]));
      const rows = mergeBy(
        [
          listedRows.map((row) => ({ ...row, needs: inboxRows.get(row.taskId)?.needs ?? (needs.data.truncated ? row.needs : []) })),
          needsRows,
        ],
        taskKey,
      );
      ctx.publish({
        ...ctx.state,
        directory: {
          observedNeeds,
          rows,
          needs: needsRows,
          needsTruncated: needs.data.truncated,
          loading: false,
          ...(nextCursor ? { nextCursor } : {}),
        },
      });
      // The chat shown here waits on its person — a channel's turn raised a round — or took a turn this page did not
      // start (Home reading a worker's answer), while the page holds it settled: taken up again, so it shows live.
      const shown = ctx.state.runs.at(-1);
      const shownRow = shown === undefined ? undefined : rows.find((row) => row.taskId === ctx.chatOf(shown));
      const settledHere = shown !== undefined && turnEnded(shown.run.status);
      // A turn can also start and end between two polls: the list then shows the settled chat only updated since.
      const since = shownRow === undefined ? undefined : settledSince.get(shownRow.taskId);
      if (shownRow !== undefined) {
        if (settledHere) {
          if (since === undefined) settledSince.set(shownRow.taskId, shownRow.updatedAt);
        } else settledSince.delete(shownRow.taskId);
      }
      const changedSince = settledHere && since !== undefined && shownRow !== undefined && since !== shownRow.updatedAt;
      if (
        shownRow !== undefined &&
        (shownRow.status === "input-required" ||
          (settledHere && (shownRow.status === "working" || shownRow.status === "submitted")) ||
          changedSince)
      ) {
        if (changedSince) settledSince.set(shownRow.taskId, shownRow.updatedAt);
        ctx.catchUp(shownRow.taskId, { at: shownRow.updatedAt });
      }
      // The workers' needs of each root read, again while the list says its workers wait or the page still shows one.
      for (const [root, held] of Object.entries(ctx.state.workers ?? {})) {
        const waits =
          rows
            .find((row) => row.taskId === root)
            ?.descendantNeeds?.some((need) => need === "question" || need === "handoff" || need === "approval") === true;
        if (waits || held.questions.length > 0 || held.handoffs.length > 0 || (held.approvals?.length ?? 0) > 0)
          void ctx.loadWorkerNeeds(root);
      }
    } catch (error) {
      if (!ctx.disposed && generation === listGeneration)
        ctx.publish({
          ...ctx.state,
          directory: {
            ...previous,
            rows: previous?.rows ?? [],
            needs: previous?.needs ?? [],
            needsTruncated: previous?.needsTruncated ?? false,
            loading: false,
            error: errorMessage(error),
          },
        });
    }
  };
  const openTask: CanvasStore["openTask"] = async (taskId) => {
    const existing = ctx.state.runs.filter((run) => run.run.taskId === taskId);
    const last = existing.at(-1);
    if (last !== undefined) {
      ctx.fresh = false;
      ctx.homeDraft = false;
      ctx.settled = turnEnded(last.run.status) ? taskId : undefined;
      ctx.publish({ ...ctx.state, runs: [...ctx.state.runs.filter((run) => run.run.taskId !== taskId), ...existing] });
      if (turnEnded(last.run.status) && !reopening.has(taskId)) {
        reopening.add(taskId);
        ctx.restore({ taskId, conversationId: conversations.get(taskId) ?? "" }, [], last);
      }
      return;
    }
    const answer = await readTaskRecord(client, options.workspaceId, taskId, {
      ...RECORD_READ,
      refused: translateNow("chat.store.openFailed"),
    });
    if (ctx.disposed) return;
    if (!answer.ok && answer.code !== "NOT_FOUND") throw new Error(answer.message);
    if (ctx.state.runs.some((run) => run.run.taskId === taskId)) return;
    if (!answer.ok) throw new Error(answer.message);
    const record = answer.value;
    // A Home's conversation is the person's, not its first message's key.
    const conversationId = conversationOfRecorded(record);
    ctx.fresh = false;
    ctx.homeDraft = false;
    ctx.settled = undefined;
    if (record.task?.chatKind === "home" && ctx.state.home !== taskId) ctx.publish({ ...ctx.state, home: taskId });
    if (record.task?.chatKind === "worker") workers.add(taskId);
    const cancelled = cancelReasonOf(record);
    ctx.restore({ taskId, conversationId: conversationId ?? "", ...(cancelled === undefined ? {} : { cancelled }) }, promptsOf(record));
    if (!conversationId) conversations.delete(taskId);
  };
  Object.assign(ctx, { loadSessions, openTask } satisfies Partial<StoreContext>);
}
