import { translateNow } from "../../../lib/i18n.js";
import { initialRunState } from "@tavi/client/browser";
import { parsePluginCommandLine, type RunPayload } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { loadTranscriptPage, rewindChat } from "../tasks-api.js";
import type { StoreContext } from "./context.js";
import { BUSY_STATUSES, without } from "./runs.js";
import { refusedAs, said } from "./said.js";
import type { CanvasStore, SubmitExtra } from "./types.js";

/** Sending, queuing, steering and rewinding prompts, and starting new chats. */
export function installPrompts(ctx: StoreContext): void {
  const { client, options, conversations, workers, queuedPrompts, attachmentsOf } = ctx;
  /**
   * Where a new run goes: Home, a side chat of a parent, or — absent — an ordinary chat. A message to Home carries no
   * drafted instructions: the owner refuses them there (Home has its own).
   */
  const runPayload = (
    id: string,
    prompt: string,
    extra?: SubmitExtra,
    to?: { readonly target: "home" } | { readonly parentChatId: string; readonly fromNoticeId?: string },
  ): RunPayload => {
    const chatInstructions = extra?.chatInstructions;
    const toHome = to !== undefined && "target" in to;
    return {
      prompt,
      workspaceId: options.workspaceId,
      principal: options.principal,
      operationKey: id,
      approval: "client",
      ...to,
      ...(toHome || chatInstructions === undefined || chatInstructions.trim() === "" ? {} : { chatInstructions }),
      // Home keeps its own model: only a new chat begins on the one picked for it.
      ...(toHome || extra?.model === undefined ? {} : { model: extra.model }),
      ...(extra?.attachments === undefined || extra.attachments.length === 0 ? {} : { attachments: [...extra.attachments] }),
      ...(extra?.fromIdeaId === undefined ? {} : { fromIdeaId: extra.fromIdeaId }),
      // Home's too: the owner attaches them only when this message begins it.
      ...(extra?.folderAttachments === undefined ? {} : { folderAttachments: extra.folderAttachments }),
    };
  };
  const submit: CanvasStore["submit"] = (prompt, extra) => {
    // A plugin's slash command: answered by the plugin, and nothing goes to the model.
    // Not for a suggestion pressed (`asPrompt`): what a plugin suggests is a prompt, whatever its words.
    const command = extra?.asPrompt === true ? undefined : parsePluginCommandLine(prompt);
    if (command !== undefined && (ctx.state.pluginCommands ?? []).some((entry) => entry.name === command.name)) {
      // The chat in view, not the page's last entry: another chat's may be newer.
      const taskId = extra !== undefined && "viewing" in extra ? extra.viewing : ctx.onScreen();
      void client
        .request("plugin-commands", {
          action: "run",
          workspaceId: options.workspaceId,
          name: command.name,
          args: command.args,
          ...(taskId === undefined ? {} : { taskId }),
        })
        .then((answer) => {
          const text = answer.ok ? (answer.result as { readonly text?: string } | undefined)?.text : undefined;
          ctx.publish({
            ...ctx.state,
            commandAnswer:
              text === undefined
                ? { name: command.name, text: refusedAs(answer, said("chat.store.why.refused")), failed: true }
                : { name: command.name, text },
          });
        })
        .catch((error: unknown) =>
          ctx.publish({ ...ctx.state, commandAnswer: { name: command.name, text: errorMessage(error), failed: true } }),
        );
      return;
    }
    if (ctx.state.commandAnswer !== undefined) ctx.publish(without(ctx.state, "commandAnswer"));
    if (ctx.state.unsent !== undefined) ctx.publish(without(ctx.state, "unsent"));
    const route = ctx.nextPrompt();
    const files = extra?.attachments !== undefined && extra.attachments.length > 0 ? extra.attachments : undefined;
    // What the message shows of them: their names, as badges.
    const shown = files !== undefined && extra?.attachmentNames !== undefined ? { fileNames: extra.attachmentNames } : {};
    // The one question open is a worker's: answered at its wait. A message with files is a turn of its own.
    if (files === undefined && route.kind === "answer" && route.waitId !== undefined && route.rootTaskId !== undefined) {
      ctx.answerWorker(route.rootTaskId, route.waitId, prompt);
      return;
    }
    // A chat waiting on a question is answered by what is typed, as a chat message answers one.
    const question = route.kind === "answer" && files === undefined ? ctx.asked() : undefined;
    if (question !== undefined) {
      ctx.answerQuestion(question.id, prompt);
      return;
    }
    // A message with files to a chat waiting on a question waits behind that chat, as a turn of its own.
    const busy =
      route.kind === "queue"
        ? route.taskId
        : files !== undefined && route.kind === "answer"
          ? (route.rootTaskId ?? route.taskId)
          : undefined;
    if (busy !== undefined) {
      // Queued, not forked: sent as the chat's next turn when this one ends.
      const id = options.mintKey();
      if (files !== undefined) attachmentsOf.set(id, files);
      ctx.publish({
        ...ctx.state,
        runs: [
          ...ctx.state.runs,
          ctx.entry(id, prompt, {
            continues: busy,
            queued: true,
            run: initialRunState({ taskId: busy }),
            ...(files === undefined ? {} : { carriesFiles: true as const }),
            ...shown,
          }),
        ],
      });
      queuedPrompts.set(busy, [...(queuedPrompts.get(busy) ?? []), id]);
      return;
    }
    const taskId = route.kind === "continue" ? route.taskId : undefined;
    const conversationId = taskId === undefined ? undefined : conversations.get(taskId);
    const id = options.mintKey();
    // A reply reads them by its entry; a new chat's run carries them in its payload.
    if (files !== undefined && taskId !== undefined) attachmentsOf.set(id, files);
    const toHome = route.kind === "home";
    // After New side chat, the chat that was on screen is its parent.
    const parentChatId = route.kind === "new" && ctx.fresh ? ctx.sideParent : undefined;
    // A reply to a notice: its chat is the parent, so the owner seeds the side chat with the run's output.
    const fromNoticeId = parentChatId !== undefined && ctx.sideNotice?.taskId === parentChatId ? ctx.sideNotice.noticeId : undefined;
    // A private chat is made so by its first message.
    const makePrivate = route.kind === "new" && ctx.fresh && ctx.freshPrivate;
    ctx.sideNotice = undefined;
    ctx.freshPrivate = false;
    ctx.fresh = false;
    ctx.homeDraft = false;
    ctx.settled = undefined;
    if (taskId !== undefined) {
      // The task's earlier entries follow it no more: the new turn is this entry's alone.
      for (const earlier of ctx.state.runs) if (earlier.run.taskId === taskId || earlier.continues === taskId) ctx.retire(earlier.id);
      ctx.publish({
        ...ctx.state,
        runs: [...ctx.state.runs, ctx.entry(id, prompt, { continues: taskId, run: initialRunState({ taskId }), ...shown })],
      });
      ctx.continueTask(id, taskId, prompt, conversationId);
      return;
    }
    ctx.publish({ ...ctx.state, runs: [...ctx.state.runs, ctx.entry(id, prompt, { ...(toHome ? { toHome } : {}), ...shown })] });
    const payload = runPayload(
      id,
      prompt,
      extra,
      toHome
        ? { target: "home" }
        : parentChatId === undefined
          ? undefined
          : { parentChatId, ...(fromNoticeId === undefined ? {} : { fromNoticeId }) },
    );
    ctx.start(id, makePrivate && !toHome ? { ...payload, memory: "private" } : payload, false);
  };
  const newTask: CanvasStore["newTask"] = (parentChatId, newOptions) => {
    ctx.homeDraft = false;
    // *New private chat* and an idea's *Try it* are chats of their own, never side chats: they
    // begin with no parent's background and answer no notice, whatever draft was left open before them.
    ctx.freshPrivate = newOptions?.private === true;
    if (ctx.freshPrivate || newOptions?.own === true) {
      ctx.sideParent = undefined;
      ctx.sideNotice = undefined;
      ctx.fresh = true;
      ctx.publish(ctx.state);
      return;
    }
    // Pressed again while the new chat is still a draft (nothing on screen
    // then): it is the same side chat, of the same parent.
    if (!(ctx.fresh && parentChatId === undefined)) {
      ctx.sideParent = parentChatId === undefined || workers.has(parentChatId) ? undefined : parentChatId;
      if (ctx.sideNotice !== undefined && ctx.sideNotice.taskId !== ctx.sideParent) ctx.sideNotice = undefined;
    }
    ctx.fresh = true;
    ctx.publish(ctx.state);
  };
  const replyToNotice: CanvasStore["replyToNotice"] = (notice) => {
    ctx.sideNotice = notice;
    ctx.newTask(notice.taskId);
  };
  const heartbeatTurn: CanvasStore["heartbeatTurn"] = ({ prompt, toHome, itemId, action }) => {
    const id = options.mintKey();
    ctx.sideNotice = undefined;
    ctx.fresh = false;
    ctx.settled = undefined;
    ctx.publish({ ...ctx.state, runs: [...ctx.state.runs, ctx.entry(id, prompt, toHome ? { toHome } : {})] });
    const payload = runPayload(id, prompt, undefined, toHome ? { target: "home" } : undefined);
    ctx.start(id, { ...payload, fromHeartbeatItemId: itemId, heartbeatAction: action }, false);
  };
  const openHome: CanvasStore["openHome"] = () => {
    ctx.homeDraft = true;
    ctx.fresh = false;
    ctx.freshPrivate = false;
    ctx.sideParent = undefined;
    ctx.sideNotice = undefined;
    ctx.settled = undefined;
    ctx.publish(ctx.state);
  };
  const setHome: CanvasStore["setHome"] = (on) => {
    if (ctx.homeOn === on) return;
    ctx.homeOn = on;
    ctx.publish(ctx.state);
  };
  const steerQueued: CanvasStore["steerQueued"] = (id) => {
    const entryOf = ctx.find(id);
    const taskId = entryOf?.continues;
    // A message with files waits for its own turn: merged into the running one, its files would go unquoted.
    if (entryOf?.queued !== true || entryOf.steering !== undefined || taskId === undefined || ctx.disposed || entryOf.carriesFiles === true)
      return;
    // First in the queue: should the turn end before it reads this, it is the next turn.
    queuedPrompts.set(taskId, [id, ...(queuedPrompts.get(taskId) ?? []).filter((queued) => queued !== id)]);
    ctx.update(id, (run) => ({ ...without(run, "error"), steering: "sending" }));
    const conversationId = conversations.get(taskId);
    const payload = {
      workspaceId: options.workspaceId,
      ...(conversationId === undefined ? { taskId } : { conversationId }),
      text: entryOf.prompt,
      clientMessageId: id,
      intent: "steer" as const,
    };
    void (async () => {
      const { response: reply } = await ctx.sendOnceMore(() => client.request("reply", payload));
      if (ctx.disposed || ctx.find(id)?.queued !== true) return;
      if (reply.ok) {
        const result = reply.result as { readonly conversationId?: unknown; readonly steered?: unknown } | undefined;
        if (typeof result?.conversationId === "string") conversations.set(taskId, result.conversationId);
        if (result?.steered === true) {
          ctx.update(id, (run) => ({ ...run, steering: "sent" }));
          return;
        }
        // No turn ran by the time it arrived: the owner sent it as the chat's
        // next message. It stays first in the queue, and the turn before it
        // ending sends it again under its id — the same message, which this
        // entry then follows. Not sent from here: that turn's last events
        // may still be on their way.
        ctx.update(id, (run) => without(run, "steering"));
        return;
      }
      // Not sent into the turn: it stays queued, for after it.
      ctx.update(id, (run) => ({
        ...without(run, "steering"),
        error: said("chat.store.steerFailed", {
          why: reply.error?.message ?? reply.error?.code ?? said("chat.store.why.refused"),
        }),
      }));
    })().catch((error: unknown) =>
      ctx.update(id, (run) => ({
        ...without(run, "steering"),
        error: said("chat.store.steerFailed", { why: errorMessage(error) }),
      })),
    );
  };
  const rewind: CanvasStore["rewind"] = async (id) => {
    const target = ctx.find(id);
    const taskId = target?.run.taskId ?? target?.continues;
    if (
      target === undefined ||
      taskId === undefined ||
      target.prompt === "" ||
      target.queued === true ||
      target.merged === true ||
      target.recordedPrompts !== undefined
    )
      return { ok: false, message: translateNow("chat.rewind.cannot") };
    const ofTask = ctx.state.runs.filter((run) => (run.run.taskId ?? run.continues) === taskId);
    if (ofTask.some((run) => run.queued === true || BUSY_STATUSES.has(run.run.status) || run.run.status === "waiting"))
      return { ok: false, message: translateNow("chat.rewind.wait") };
    const from = ofTask.indexOf(target);
    // A turn sent from this page has no saved number yet: it is the one as many saved turns back as the page shows from it.
    let seq = target.seq;
    if (seq === undefined) {
      const page = await loadTranscriptPage(client, options.workspaceId, taskId);
      if (!page.ok) return { ok: false, message: page.message };
      // An entry holding several recorded turns counts as one here: the count would land on the wrong turn.
      if (ofTask.slice(from).some((run) => run.merged === true || run.recordedPrompts !== undefined))
        return { ok: false, message: translateNow("chat.rewind.reload") };
      const back = ofTask.slice(from).filter((run) => run.prompt !== "").length;
      seq = page.value.entries.filter((saved) => (saved.turn.prompt ?? "") !== "").at(-back)?.seq;
      if (seq === undefined) return { ok: false, message: translateNow("chat.rewind.notSaved") };
    }
    const answer = await rewindChat(client, options.workspaceId, taskId, seq, target.prompt);
    if (!answer.ok) return { ok: false, message: answer.message };
    if (ctx.disposed) return { ok: true, prompt: answer.value.prompt };
    const gone = new Set(ofTask.slice(from).map((run) => run.id));
    // The chat stays the one a message goes to, even with none of its turns left on the page.
    ctx.fresh = false;
    ctx.settled = taskId;
    ctx.publish({ ...ctx.state, runs: ctx.state.runs.filter((run) => !gone.has(run.id)) });
    return { ok: true, prompt: target.prompt };
  };
  const cancelQueued: CanvasStore["cancelQueued"] = (id) => {
    const entryOf = ctx.find(id);
    const taskId = entryOf?.continues;
    // One sent into the turn is the turn's now: it cannot be taken back.
    if (entryOf?.queued !== true || entryOf.steering !== undefined || taskId === undefined) return;
    attachmentsOf.delete(id);
    const rest = (queuedPrompts.get(taskId) ?? []).filter((queued) => queued !== id);
    if (rest.length === 0) queuedPrompts.delete(taskId);
    else queuedPrompts.set(taskId, rest);
    ctx.publish({ ...ctx.state, runs: ctx.state.runs.filter((run) => run.id !== id) });
  };
  Object.assign(ctx, {
    submit,
    newTask,
    replyToNotice,
    heartbeatTurn,
    setHome,
    openHome,
    steerQueued,
    rewind,
    cancelQueued,
  } satisfies Partial<StoreContext>);
}
