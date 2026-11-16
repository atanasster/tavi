import { redactedError } from "@tavi/channel-kit";
import type { InboundEvent, MessagingConnectionStatus } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { sleep } from "@tavi/node-kit";

import type { TelegramApi, TelegramApiResult } from "./api.js";
import { toInboundEvent, type TelegramBot, type TelegramUpdate } from "./inbound.js";

/**
 * Receiving from Telegram by long polling (`getUpdates`); webhook mode is not
 * supported. The offset moves past an update only once it has been handed
 * off, and every failure is recorded on the connection's status, backed off,
 * and polled through.
 */

export const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
export const DEFAULT_POLL_ERROR_BACKOFF_MS = 2000;

export interface TelegramPollerOptions {
  readonly api: TelegramApi;
  readonly connectionId: string;
  readonly now: () => string;
  readonly pollTimeoutSeconds: number;
  readonly pollErrorBackoffMs: number;
  /** The connection's receive status, read and set as the loop runs. */
  readonly status: { readonly get: () => MessagingConnectionStatus; readonly set: (status: MessagingConnectionStatus) => void };
  /** The inbound handler registered when an update arrives, if any. */
  readonly handler: () => ((event: InboundEvent) => Promise<void>) | undefined;
}

/** One connection's poller: its offset outlives a stop and a start. */
export class TelegramPoller {
  private updateOffset: number | undefined;
  private readonly options: TelegramPollerOptions;

  constructor(options: TelegramPollerOptions) {
    this.options = options;
  }

  async run(signal: AbortSignal, bot: TelegramBot): Promise<void> {
    const { api, connectionId, now, pollTimeoutSeconds, pollErrorBackoffMs } = this.options;
    const status = this.options.status;
    while (!signal.aborted) {
      let result: TelegramApiResult<readonly TelegramUpdate[]>;
      try {
        result = await api.call<readonly TelegramUpdate[]>(
          "getUpdates",
          // Button presses arrive as `callback_query` updates, and the bot's own
          // membership of a chat as `my_chat_member`, which Telegram
          // sends only when asked for by name.
          { offset: this.updateOffset, timeout: pollTimeoutSeconds, allowed_updates: ["message", "callback_query", "my_chat_member"] },
          signal,
        );
      } catch (error) {
        // `stop()` aborting the in-flight request is a clean exit, not a
        // failure — the loop must not report `"failed"` on its own shutdown.
        if (signal.aborted) return;
        // A token already refused stays refused: only a poll that succeeds clears its repair.
        const refused = status.get().repair === "credentials";
        status.set({
          state: "failed",
          detail: redactedError(error, [api.token()]),
          since: now(),
          ...(refused ? { repair: "credentials" as const } : {}),
        });
        await sleep(pollErrorBackoffMs);
        if (!signal.aborted && !refused) status.set({ state: "running", since: now() });
        continue;
      }
      if (!result.ok) {
        // A token refused while running stays failed, with its repair, until a poll succeeds. So does a bot
        // another consumer holds (409: a webhook is set, or another poller runs): that never clears by waiting,
        // and "running" would hide why no message arrives.
        const refused = result.error_code === 401;
        const held = result.error_code === 409;
        status.set({ state: "failed", detail: result.description, since: now(), ...(refused ? { repair: "credentials" as const } : {}) });
        await sleep(pollErrorBackoffMs);
        if (!signal.aborted && !refused && !held) status.set({ state: "running", since: now() });
        continue;
      }
      for (const update of result.result) {
        const event = toInboundEvent(connectionId, update, now(), bot);
        if (event === undefined) {
          // Nothing to hand to a handler (an update kind we don't parse at
          // all, e.g. a non-text message) — safe to acknowledge outright,
          // there is nothing here a retry could ever succeed at.
          this.updateOffset = update.update_id + 1;
          continue;
        }
        try {
          // The offset advances ONLY after the handler actually runs, not
          // before: updates are persisted before the polling offset moves —
          // `handler` is `MessagingService.ingest()`, which durably records
          // the event before returning. Advancing first would make a handler
          // failure silently and permanently skip that specific update:
          // `updateOffset` would already live past it in this process's
          // memory, so the NEXT `getUpdates` call would never see it again,
          // yet nothing durable would record it as processed or failed either.
          //
          // No handler is a failure too, not a no-op. `await handler?.(event)`
          // used to acknowledge the update with nobody to hand it to, and since
          // `MessagingService.openConnection` registered none, every inbound
          // message in production was dropped that way without a trace.
          const handler = this.options.handler();
          if (handler === undefined) throw new Error("no inbound handler is registered");
          await handler(event);
          this.updateOffset = update.update_id + 1;
        } catch (error) {
          // A handler failure must degrade the loop the same way a
          // getUpdates failure does (recorded, backed off, still polling)
          // rather than silently terminating it while `status` keeps
          // reporting `"running"` for a connector that stopped delivering
          // inbound messages. The offset is deliberately left where it
          // was: the NEXT `getUpdates` call redelivers this exact update
          // (and, since Telegram's `offset` semantics are "everything
          // from here forward," every update after it in this batch too —
          // acceptable double-processing under `ingest()`'s own
          // dedup-by-providerEventId, and far better than a silent drop),
          // so this loop stops processing the rest of the CURRENT batch
          // rather than racing ahead of an update that hasn't actually
          // been durably handled yet.
          status.set({ state: "failed", detail: `inbound handler failed: ${errorMessage(error)}`, since: now() });
          // Same backoff the sibling getUpdates-request/API-error branches
          // above already use — without it, a persistently failing
          // handler (this exact update sits at the head of the queue
          // again on the very next `getUpdates` call, which returns
          // immediately since Telegram already has it buffered) hot-loops
          // against the Telegram API with no client-side throttling.
          await sleep(pollErrorBackoffMs);
          break;
        }
      }
      if (status.get().state === "failed" && !signal.aborted) status.set({ state: "running", since: now() });
    }
  }
}
