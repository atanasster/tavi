import type { ChatNotice } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import { useState, type ReactNode } from "react";
import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { Button } from "../../ui/Button.js";
import { Markdown } from "../../ui/Markdown.js";
import { RowAction } from "../../ui/RowAction.js";

/**
 * A chat's notices: what a run delivered to
 * Home, a standalone run or a side chat that settled, a new Home's earlier
 * chats, a reminder said in Home, a channel conversation's activity.
 * Compact cards placed among the chat's turns (`noticesByRun`) — at each
 * place the newest few, the rest behind a toggle — each linking to the run it is about,
 * with **Reply in a side chat**, which opens a side chat of this chat seeded
 * with that run's output. A notice never starts a turn of this chat.
 */

/** How many of the newest notices show before the toggle. */
const NOTICES_SHOWN = 3;

const KIND_LABELS: Readonly<Record<ChatNotice["kind"], string>> = {
  "run-result": "Run result",
  "run-settled": "Run",
  "side-chat-settled": "Side chat",
  "earlier-chats": "Earlier chats",
  reminder: "Reminder",
  conversation: "Conversation",
  epoch: "Epoch",
  // The chat's working folder: budget warnings.
  folder: "Folder",
  // One heartbeat item.
  heartbeat: "Heartbeat",
  // A memory card.
  memory: "Memory",
  // An MCP server's notice: decided in Center or the CLI.
  mcp: "Server",
};

/** What a notice's Open button opens. */
const OPEN_LABELS: Readonly<Partial<Record<ChatNotice["kind"], string>>> = {
  "side-chat-settled": "side chat",
  conversation: "conversation",
};

export function NoticeCards({
  notices,
  connected,
  onOpen,
  onReply,
  heartbeatCard,
  memoryCard,
}: {
  readonly notices: readonly ChatNotice[] | undefined;
  readonly connected: boolean;
  /** A heartbeat notice's item card, shown in place of its title and summary. */
  readonly heartbeatCard?: ((notice: ChatNotice & { readonly heartbeatItemId: string }) => ReactNode) | undefined;
  /** A memory notice's card, read from the owner: the notice itself holds only counts. */
  readonly memoryCard?: ((notice: ChatNotice) => ReactNode) | undefined;
  /** Open the run or side chat a notice is about. */
  readonly onOpen?: ((taskId: string) => void) | undefined;
  /** Reply to a notice in a side chat of this chat. */
  readonly onReply?: ((notice: ChatNotice) => void) | undefined;
}) {
  const [all, setAll] = useState(false);
  // An epoch's notice is a divider between the turns, not a card.
  const cards = notices?.filter((notice) => notice.kind !== "epoch") ?? [];
  if (cards.length === 0) return null;
  const shown = all ? cards : cards.slice(-NOTICES_SHOWN);
  const hidden = cards.length - shown.length;
  return (
    <section className="chat-notices" aria-label="notices">
      {hidden > 0 ? (
        <p className="earlier">
          <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
            Show {plural(hidden, "earlier notice")}
          </Button>
        </p>
      ) : null}
      {shown.map((notice) => (
        <article key={`${notice.noticeId}@${notice.createdAt}`} className="chat-notice" data-notice-kind={notice.kind}>
          {notice.kind === "heartbeat" && notice.heartbeatItemId !== undefined && heartbeatCard !== undefined ? (
            heartbeatCard({ ...notice, heartbeatItemId: notice.heartbeatItemId })
          ) : notice.kind === "memory" && memoryCard !== undefined ? (
            memoryCard(notice)
          ) : notice.kind === "earlier-chats" && notice.summary !== "" ? (
            // A list, not news: folded to one line, so it does not head every turn of a Home that was rewound to its start.
            <details className="chat-notice-list">
              <summary className="chat-notice-title">
                {notice.title} <span className="chat-notice-count">({notice.summary.split("\n").length})</span>
              </summary>
              <p className="chat-notice-summary">{notice.summary}</p>
            </details>
          ) : (
            <>
              <p className="chat-notice-title">
                <span className="visually-hidden">{KIND_LABELS[notice.kind]}: </span>
                {notice.title}
              </p>
              {/* What a run said, drawn as its answer is (a list, bold), not as its Markdown's raw marks; its links ask first, as a worker's do. */}
              {notice.summary === "" ? null : (
                <div className="chat-notice-summary">
                  <Markdown text={notice.summary} tainted />
                </div>
              )}
            </>
          )}
          {notice.sourceTaskId === undefined &&
          (notice.kind === "earlier-chats" ||
            notice.kind === "folder" ||
            notice.kind === "heartbeat" ||
            notice.kind === "memory" ||
            notice.kind === "mcp") ? null : (
            <div className="chat-notice-actions">
              {notice.sourceTaskId !== undefined && onOpen !== undefined ? (
                <RowAction onClick={() => onOpen(notice.sourceTaskId as string)}>Open {OPEN_LABELS[notice.kind] ?? "run"}</RowAction>
              ) : null}
              {/* A conversation's notice is metadata only, with no output to reply about; a side chat is answered in itself, by opening it; a folder notice is about this chat itself. */}
              {notice.sourceTaskId !== undefined &&
              onReply !== undefined &&
              notice.kind !== "conversation" &&
              notice.kind !== "side-chat-settled" &&
              notice.kind !== "folder" ? (
                <RowAction disabled={!connected} onClick={() => onReply(notice)}>
                  Reply in a side chat
                </RowAction>
              ) : null}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}

/**
 * Where each notice card goes among a chat's turns: after the saved
 * turn its `afterSeq` names, so a new Home's "Earlier chats" (`afterSeq` 0)
 * comes before its first turn and scrolls away with it. A turn of the
 * notice's chat with a known `seq` follows it when that `seq` is later; any
 * other turn — one this page ran, not read back — when it started after the
 * notice was posted, or has not started yet. Keyed by the index of the turn it
 * precedes (`runs.length`: after the last). Epoch notices are dividers, placed
 * by `epochDividersByRun`.
 */
export function noticesByRun(
  runs: readonly {
    readonly seq?: number | undefined;
    readonly startedAt?: string | undefined;
    readonly run: { readonly taskId?: string | undefined };
  }[],
  notices: readonly ChatNotice[] | undefined,
): ReadonlyMap<number, readonly ChatNotice[]> {
  const placed = new Map<number, ChatNotice[]>();
  for (const notice of notices ?? []) {
    if (notice.kind === "epoch") continue;
    const found = runs.findIndex((run) =>
      run.seq !== undefined && run.run.taskId === notice.taskId
        ? run.seq > notice.afterSeq
        : run.startedAt === undefined || run.startedAt > notice.createdAt,
    );
    const index = found === -1 ? runs.length : found;
    placed.set(index, [...(placed.get(index) ?? []), notice]);
  }
  return placed;
}

/**
 * Where each epoch divider goes among a chat's turns: before the
 * first turn still going, or ended, when the chat rolled over — the turn the
 * rollover happened in, or the one it was admitted with — else after them
 * all. A turn the page has no time for yet is still going. Keyed by the
 * index of the turn it precedes (`runs.length`: after the last).
 */
export function epochDividersByRun(
  runs: readonly { readonly lastAt?: string | undefined }[],
  notices: readonly ChatNotice[] | undefined,
): ReadonlyMap<number, readonly ChatNotice[]> {
  const placed = new Map<number, ChatNotice[]>();
  for (const notice of notices ?? []) {
    if (notice.kind !== "epoch") continue;
    const found = runs.findIndex((run) => run.lastAt === undefined || run.lastAt >= notice.createdAt);
    const index = found === -1 ? runs.length : found;
    placed.set(index, [...(placed.get(index) ?? []), notice]);
  }
  return placed;
}

/**
 * Fresh context, asked for: busy while the owner answers, then what it said —
 * that the next message starts a new epoch, or why it did not (`request`
 * answers the refusal, or nothing).
 */
export function useFreshContext(
  request: (() => Promise<string | undefined>) | undefined,
  /** What changes when the chat moves on (its next message): what was said is cleared then, no longer true. */
  until?: string,
): {
  readonly busy: boolean;
  readonly said?: string;
  readonly failed?: boolean;
  readonly ask: () => void;
} {
  const [state, setState] = useState<{ readonly busy: boolean; readonly said?: string; readonly failed?: boolean }>({ busy: false });
  useResetOnChange([until], () => setState((was) => (was.busy ? was : { busy: false })));
  const ask = (): void => {
    if (request === undefined) return;
    setState({ busy: true });
    void request().then((refused) =>
      setState(
        refused === undefined
          ? { busy: false, said: "Your next message starts a new epoch." }
          : { busy: false, said: refused, failed: true },
      ),
    );
  };
  return { ...state, ask };
}

/**
 * An epoch divider: where the chat rolled over into a new epoch
 * — its earlier turns summarized for the model and archived. Links
 * the archive of what was folded, and offers **Fresh context**: the chat's
 * next message starts a new epoch now, whatever its length.
 */
export function EpochDivider({
  notice,
  connected,
  onOpenArchive,
  onFreshContext,
}: {
  readonly notice: ChatNotice;
  readonly connected: boolean;
  /** Show the archive of what this rollover folded. */
  readonly onOpenArchive?: ((artifactId: string) => void) | undefined;
  /** Ask for fresh context; answers why it was not set, or nothing when it was. */
  readonly onFreshContext?: (() => Promise<string | undefined>) | undefined;
}) {
  const fresh = useFreshContext(onFreshContext);
  return (
    // A group, not a separator: it holds buttons, which a separator's children may not be (WCAG 4.1.2).
    <div className="epoch-divider" role="group" aria-label={notice.title} data-notice-kind="epoch">
      <p className="epoch-divider-title">{notice.title}</p>
      <p className="epoch-divider-summary">
        Earlier turns were summarized for the model.{" "}
        {notice.artifactId === undefined ? "Nothing was archived." : "The full turns are kept in the archive."}
      </p>
      <div className="epoch-divider-actions">
        {notice.artifactId !== undefined && onOpenArchive !== undefined ? (
          <Button variant="ghost" size="sm" onClick={() => onOpenArchive(notice.artifactId as string)}>
            Open archive
          </Button>
        ) : null}
        {onFreshContext !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={!connected || fresh.busy}
            onClick={fresh.ask}
            title="Start the next message from a summary of this chat, whatever its length"
          >
            Fresh context
          </Button>
        ) : null}
      </div>
      {fresh.said === undefined ? null : (
        <p className={fresh.failed === true ? "failure" : "epoch-divider-status"} role="status">
          {fresh.said}
        </p>
      )}
    </div>
  );
}
