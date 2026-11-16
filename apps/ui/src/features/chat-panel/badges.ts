import { useEffect, useState } from "react";

import type { SettingsClient } from "../../lib/ipc.js";
import type { ChatPanelBadge } from "./ChatPanel.js";
import { listChatNotes, listLearnedHere, loadChatContext } from "./api.js";
import type { ChatPanelTab } from "./tabs.js";

/** What the Memory and Instructions icons carry for one chat, and what it is called. */
interface ChatBadges {
  /** What waits for the reader from this chat: its proposed notes, and what its cards proposed for every chat. */
  readonly memory: number;
  /** The reader's name for the chat, else its generated title. */
  readonly title?: string | undefined;
  readonly renamed: boolean;
  /** The instructions' current revision, 0 for none. */
  readonly revision: number;
}

/** The open chat's badges and name, and a way to read them again after a change. */
export interface ChatSummary {
  readonly badges: Partial<Record<ChatPanelTab, ChatPanelBadge>>;
  readonly title: string | undefined;
  readonly renamed: boolean;
  /** The instructions' current revision as last read; undefined before a read. */
  readonly revision: number | undefined;
  readonly refresh: () => void;
}

/** The last badges read per chat, so the rail keeps them after the panel is shut. */
const known = new Map<string, ChatBadges>();

/** Forget what was read (tests). */
export function forgetChatBadges(): void {
  known.clear();
}

/**
 * The Memory badge, the instructions' revision and the name of the open chat, read while the panel
 * is open on an owner that offers `chat-context` — a shut panel asks the owner for nothing — and again whenever the
 * reader moves between its tabs, so a change made in one is counted when they
 * leave it, and whenever `version` says the chat or its memory changed.
 */
export function useChatSummary(
  client: SettingsClient,
  workspaceId: string,
  taskId: string | undefined,
  editable: boolean,
  open: boolean,
  tab: ChatPanelTab,
  version = "",
): ChatSummary {
  const [, setRevision] = useState(0);
  const [asked, setAsked] = useState(0);
  const enabled = editable && open;
  useEffect(() => {
    if (!enabled || taskId === undefined) return;
    let current = true;
    void (async () => {
      const context = await loadChatContext(client, workspaceId, taskId);
      if (!context.ok) return;
      const chat = context.value.delegatedFrom ?? taskId;
      const [notes, learned] = await Promise.all([listChatNotes(client, workspaceId, chat), listLearnedHere(client, workspaceId, chat)]);
      if (!current) return;
      const waiting = new Set(
        [...(notes.ok ? notes.value.records : []), ...(learned.ok ? learned.value.records : [])]
          .filter((record) => record.status === "proposed")
          .map((record) => record.recordId),
      );
      known.set(taskId, {
        memory: waiting.size,
        title: context.value.title,
        renamed: context.value.renamed === true,
        revision: context.value.revision,
      });
      setRevision((value) => value + 1);
    })();
    return () => {
      current = false;
    };
  }, [client, workspaceId, taskId, enabled, tab, asked, version]);
  // An owner without `chat-context` has no chat notes or instructions to mark.
  const summary = !editable || taskId === undefined ? undefined : known.get(taskId);
  const refresh = () => setAsked((value) => value + 1);
  if (summary === undefined) return { badges: {}, title: undefined, renamed: false, revision: undefined, refresh };
  return { badges: { memory: summary.memory }, title: summary.title, renamed: summary.renamed, revision: summary.revision, refresh };
}
