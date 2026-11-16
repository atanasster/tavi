import { TaviError, type ChannelMailboxKit } from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

/**
 * A channel mailbox's tools, named: what `mailbox-tools.ts`
 * registers for each account, and what Connected apps lists on its page, from one place.
 */

/**
 * An account's part of its tools' ids: `mail-1a2b3c4d` → `mail_1a2b3c4d`.
 * An id that would not stay itself — upper case, other characters, or too
 * long for a model's 64-character tool name — is named by a digest instead,
 * so no two accounts share a tool.
 */
export function mailboxToolSlug(connectionId: string): string {
  if (/^[a-z][a-z0-9-]{0,31}$/.test(connectionId)) return connectionId.replace(/-/g, "_");
  return `m${sha256Hex(connectionId).slice(0, 16)}`;
}

/**
 * Each mailbox account's tools, as Connected apps lists them: the same the owner registers for it (`toolsOf`).
 * One with `method` is registered only for a mailbox that implements that optional method (`mailboxCan`).
 */
export const MAILBOX_TOOLS = [
  { name: "search", title: "Search mail", effect: "read-only", sink: "none", needs: "read" },
  { name: "read", title: "Read a message", effect: "read-only", sink: "none", needs: "read" },
  { name: "thread", title: "Read a thread", effect: "read-only", sink: "none", needs: "read", method: "thread" },
  { name: "label", title: "Label, archive and mark mail", effect: "mutating", sink: "persist", needs: "read", method: "modifyLabels" },
  { name: "draft", title: "Write a draft", effect: "mutating", sink: "persist", needs: "read" },
  { name: "send_draft", title: "Send a draft you approve", effect: "external", sink: "message", needs: "send" },
] as const;

/** Where an account's mailbox tools' ids start. */
export function mailboxToolPrefix(providerId: string, connectionId: string): string {
  return `${providerId}.${mailboxToolSlug(connectionId)}.`;
}

/** What a channel's mailbox does beyond the methods every one has: its optional methods, by name. */
export interface MailboxCan {
  readonly searchPage: boolean;
  readonly thread: boolean;
  readonly modifyLabels: boolean;
}

/**
 * Which optional methods a channel's mailbox implements, asked of a mailbox opened and never called (its
 * token is never asked); a kit that cannot open one now (its plugin stopped) implements none.
 */
export function mailboxCan(kit: ChannelMailboxKit<typeof fetch> | undefined): MailboxCan {
  try {
    const mailbox = kit?.open({
      accessToken: async () => {
        throw new TaviError("UNAVAILABLE", "a mailbox opened to see what it implements is never signed in");
      },
    });
    return {
      searchPage: typeof mailbox?.searchPage === "function",
      thread: typeof mailbox?.thread === "function",
      modifyLabels: typeof mailbox?.modifyLabels === "function",
    };
  } catch {
    return { searchPage: false, thread: false, modifyLabels: false };
  }
}
