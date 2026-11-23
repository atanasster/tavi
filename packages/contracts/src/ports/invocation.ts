import type { z } from "zod";
import type { ChatFolder } from "../chat-folders.js";
import type { Locale } from "../i18n.js";
import type { ContentLabel } from "../content-label.js";
import type { RunIdSchema, WorkspaceIdSchema } from "../ids.js";
import type { ChatMemoryMode, FrontEnd, TurnChannel } from "../task-origins.js";
import type { MemoryReach } from "./memory-service.js";

/**
 * Authenticated invocation context.
 *
 * Every service call that can touch scoped data receives this. Ownership is
 * derived from context, never from a caller-supplied id.
 */
export interface InvocationContext {
  readonly workspaceId: z.infer<typeof WorkspaceIdSchema>;
  readonly principalId: string;
  readonly runId: z.infer<typeof RunIdSchema>;
  /** Authenticated caller identity, e.g. "cli" or a connector binding id. */
  readonly caller: string;
  /**
   * True only for a spawned worker's admitted context — set once by
   * `contextFrom` at spawn time (`packages/agent-host/src/agents/agent-communication.ts`),
   * never mutated afterward (this whole object is captured once into
   * checkpointed state with no reducer). Read by
   * memory resolution to skip auto-granting `personal`/
   * `personal_workspace`/`personal_agent` scope to a worker that merely
   * inherited its orchestrator's `principalId`/`workspaceId`: a worker
   * receives only selected scoped references. By convention `contextFrom` always sets
   * this together with `delegatedMemoryRecordIds` (both present for a
   * worker, both absent otherwise) — not enforced by the type, since a
   * future `true` with an empty grant list is a legitimate distinct state.
   *
   * The explicit `| undefined` (rather than a bare `?:`) matches this
   * field's actual runtime source: `InvocationContextSchema`
   * (`packages/contracts/src/workflow-state.ts`) is a SEPARATE Zod schema
   * that validates the checkpointed `invocation` state channel a worker's
   * context is read back from — `z.optional()` infers as `T | undefined`,
   * which `exactOptionalPropertyTypes` treats as distinct from a bare
   * optional property. Without this, `current.invocation` (typed from that
   * schema) fails to satisfy this interface wherever it's passed as one.
   */
  readonly memoryScopeRestricted?: boolean | undefined;
  /**
   * The agent definition whose persona this task runs under, or `undefined`
   * for a task with no named persona.
   *
   * A **reference**, resolved to instructions on every turn — the same pattern
   * `skillId`/`credentialRef` use, and for the same reason: an operator's edit
   * to a persona should take effect on the task's next turn, and a prompt
   * snapshot would silently pin every in-flight task to stale wording.
   * Admission validates that the reference resolves, so a task can never start
   * with an unknown one.
   *
   * Explicit `| undefined` for the same `exactOptionalPropertyTypes` reason as
   * `memoryScopeRestricted` above: `InvocationContextSchema` is a separate Zod
   * schema that validates the *checkpointed* `invocation` channel, and
   * `z.optional()` infers `T | undefined`.
   */
  readonly agentDefinitionId?: string | undefined;
  /**
   * The specific memory record ids this worker was granted at spawn
   * time (`AgentSpawnInput.sharedMemoryRecordIds`), captured once — not
   * re-validated against the granting actor's ongoing access on every
   * later read (a deliberate staleness tradeoff; a
   * `forget()`ed record must still disappear regardless of this list).
   * See `memoryScopeRestricted`'s own comment for why `| undefined` is
   * explicit here too.
   */
  readonly delegatedMemoryRecordIds?: readonly string[] | undefined;
  /**
   * A delegated task's chat — its delegation root — whose chat notes it reads
   * (`MemoryActor.chatTaskId`). Re-derived from the
   * delegation row on every turn, like the memory grant. Mirrored in
   * `InvocationContextSchema`; `| undefined` for the reason
   * `memoryScopeRestricted` gives.
   */
  readonly chatTaskId?: string | undefined;
  /**
   * The chat a side chat was opened from (`TaskRecord.parentChatId`), whose
   * chat notes it reads besides its own
   * (`MemoryActor.parentChatId`). Set by the workflow from the task's record at
   * every admission, never by a caller. Mirrored in `InvocationContextSchema`;
   * `| undefined` for the reason `memoryScopeRestricted` gives.
   */
  readonly parentChatId?: string | undefined;
  /**
   * When the turn this context runs began: the creation time of the `start`
   * or `reply` admission that began it. Set by the workflow at every
   * such admission, never by a caller; a resume (an approval, a deadline)
   * keeps the checkpointed context, so it keeps its turn's. Model accounting
   * reads it to tell an earlier turn's attempt from this turn's. Mirrored in
   * `InvocationContextSchema`; `| undefined` for the reason
   * `memoryScopeRestricted` gives.
   */
  readonly turnStartedAt?: string | undefined;
  /**
   * The channel this turn is held to besides its task's origin: set by
   * the workflow at every admission — from the composition's reading of the
   * caller's context (a reply into a messaging conversation), or carried down
   * from a spawning turn (`AgentActor.heldChannel`, the delegation row). It
   * only ever narrows the rules (`ruleAppliesToTurn`), so a caller can at most
   * hold its own turn tighter. Mirrored in `InvocationContextSchema`;
   * `| undefined` for the reason `memoryScopeRestricted` gives.
   */
  readonly heldChannel?: TurnChannel | undefined;
  /**
   * A schedule fire's own delivery target, as its schedule configures it (its
   * alert destination, where it asks and reports): a `messaging.send_to` to it
   * is a reply, its destination fixed by configuration as `heartbeat.report`'s
   * is. Kept by the workflow only on a task of
   * origin `schedule`. Mirrored in `InvocationContextSchema`.
   */
  readonly scheduleDelivery?: { readonly connectionId: string; readonly destination: string } | undefined;
  /**
   * How a schedule fire tells its person, when not on every run: its runtime
   * facts then say how to end with nothing to report, and with `if-changed` a
   * `messaging.send_to` to `scheduleDelivery` the same as
   * `lastDeliveredHash` is not sent again. Kept by the workflow only on a task
   * of origin `schedule`. Mirrored in `InvocationContextSchema`.
   */
  readonly scheduleNotify?: { readonly mode: "when-sent" | "if-changed"; readonly lastDeliveredHash?: string | undefined } | undefined;
  /**
   * The messaging connection a turn held to `messaging` came in on: its own
   * reply target's, or carried down from a spawning turn as `heldChannel` is
   * (the delegation row). Set by the workflow at every admission. It names
   * the turn's `channel` to plugins' hooks, so a `channels` match
   * reaches a worker its channel turn spawned. Mirrored in
   * `InvocationContextSchema`.
   */
  readonly heldConnectionId?: string | undefined;
  /**
   * The workspace's language, set by the gate only on the context it gives a tool's `assess`, so the approval card
   * it writes (its title, detail and reasons) is said in it. Never stored with the turn, never what the model
   * reads, and not mirrored in `InvocationContextSchema`; absent: English.
   */
  readonly locale?: Locale | undefined;
  /**
   * The front end this turn was typed in, on the owner's local connection:
   * `web` through `tavi ui`'s bridge, `ipc` from another
   * attached client. Set by the owner from the IPC connection, never from a
   * payload; absent for any other admission. Rules apply as the narrower of
   * the task's origin and it (`ruleAppliesToTurn`), so a Home begun by `tavi
   * chat` is held to `web`-scoped deny rules for a turn typed in the canvas.
   * Mirrored in `InvocationContextSchema`; `| undefined` for the reason
   * `memoryScopeRestricted` gives.
   */
  readonly frontEnd?: FrontEnd | undefined;
  /**
   * The chat's working folder as this turn sees it: resolved once per
   * admission by the
   * composition's `ChatFolders` — a worker's is its root chat's, a turn held
   * to `messaging` sees only the managed folder — and stamped by the workflow,
   * never by a caller or the model. A resume keeps its turn's, so a
   * change applies from the chat's next message. Absent where the
   * composition resolves no folders, and when this turn's could not be
   * resolved (`folderUnavailable` then says why). Mirrored in
   * `InvocationContextSchema`; `| undefined` for the reason
   * `memoryScopeRestricted` gives.
   */
  readonly folder?: ChatFolder | undefined;
  /**
   * Why this turn's folder could not be resolved: a host primary
   * or attachment that no longer exists or no longer lies under an
   * `--fs-root`. The message names `/folder reset`; the tools that need the
   * folder report it rather than fall back to another. Stamped with `folder`,
   * never by a caller. Mirrored in `InvocationContextSchema`.
   */
  readonly folderUnavailable?: string | undefined;
  /**
   * A worker spawned by a call whose conversation was tainted: set by the
   * spawn, so the worker's conversation is held
   * tainted from its first turn — its shell writes only the managed folder
   * and its file writes outside it ask. Only ever narrows, so any caller may
   * set it. Read at admission, where it becomes the conversation's sticky
   * flag; not checkpointed.
   */
  readonly inheritedTaint?: true | undefined;
  /**
   * The label this conversation starts with,
   * beside `inheritedTaint`: what the caller knows of where its first turn's
   * content came from — a heartbeat *Do it*'s `heartbeat`. Joined into the
   * conversation's context label at admission, so it only narrows (more
   * untrusted, more private), and any caller may set it. A bare
   * `inheritedTaint` reads as `UNTRUSTED_UNKNOWN_SOURCE` (untrusted, source unknown).
   * Read at admission; not checkpointed.
   */
  readonly inheritedLabel?: ContentLabel | undefined;
  /**
   * The known-URL set of the call that spawned this worker: its first turn's
   * `knownUrls`, since the worker's prompt is the
   * spawning model's words, not a person's. On a tool call's context, the
   * calling task's own set, which `agents.spawn` hands on. Read at admission;
   * not checkpointed.
   */
  readonly inheritedKnownUrls?: readonly string[] | undefined;
  /**
   * How far this turn's memory reaches: `"chat-only"` for a
   * group conversation's Home, its forum topics' side chats and every worker
   * they spawn, whose words are the group's members' and whose answers they
   * read. Such a turn reads only its chat's own notes — no personal memory or
   * preferences — proposes only chat notes, and searches only its own
   * conversation's earlier chats (`MemoryActor.reach`). Set by the workflow at
   * every admission from the composition's reading of the conversation, never
   * lifted by a caller (a caller's `"chat-only"` is kept: it only narrows).
   * Mirrored in `InvocationContextSchema`; `| undefined` for the reason
   * `memoryScopeRestricted` gives.
   */
  readonly memoryReach?: MemoryReach | undefined;
  /**
   * The memory mode of the chat this turn belongs to, when
   * it is off or private: such a turn has no manifest, no `memory.*` or
   * `sessions.search` tool and no flush. Set by the workflow at every
   * admission from the composition's reading of the chat, never lifted by a
   * caller (a caller's mode is kept: it only narrows), so a worker spawned
   * from an off or private chat is off from its first turn, before its
   * delegation row exists to be read. Mirrored in `InvocationContextSchema`;
   * `| undefined` for the reason `memoryScopeRestricted` gives.
   */
  readonly chatMemoryMode?: ChatMemoryMode | undefined;
  /**
   * Set once, at admission, for a message-driven task only — never for an
   * operator/CLI-driven or spawned-worker task. Gives `messaging.send`'s
   * tool handler what it needs to reply through the right connection/
   * conversation without threading connector-specific state through the
   * graph.
   *
   * `externalSenderId` is carried alongside `externalConversationId`
   * because the two are NOT interchangeable across
   * providers — Mailgun's `externalConversationId` is the bot's own
   * receiving address (constant per connection, useless as a reply
   * target), while `externalSenderId` is the human's actual address a
   * reply must go `to:`. Telegram's connector only needs
   * `externalConversationId` (its `chatId`), but the field is here for
   * every provider since a generic pipeline can't assume which one a
   * given connector's `destinationFromInbound` will actually use.
   *
   * `externalMessageId`: the originating message's own id, when the
   * inbound event carried one.
   * Needed for RFC 5322 `In-Reply-To`/`References` threading headers —
   * without it, an email reply (Mailgun) renders as a brand-new,
   * unthreaded conversation in most mail clients, since a generic reply
   * subject alone is only a weak fallback most clients don't rely on.
   * Optional because not every provider's inbound event carries a stable
   * message id, and even Mailgun's own is best-effort — its own explicit
   * `| undefined` is required for the same `exactOptionalPropertyTypes`
   * reason as `memoryScopeRestricted`'s own comment above, one level
   * deeper: Zod's `.optional()` on THIS nested field infers `string |
   * undefined` too, not just the outer `messagingReplyTo` object itself.
   *
   * Mirrored in `InvocationContextSchema`
   * (`packages/contracts/src/workflow-state.ts`) — that schema, not this
   * interface, is what actually validates the checkpointed `invocation`
   * state channel LangGraph reads back; a field added only here is
   * silently stripped on every real checkpoint round-trip (the bug
   * `memoryScopeRestricted`/`delegatedMemoryRecordIds` above once had —
   * both files must be edited
   * together, every time).
   */
  readonly messagingReplyTo?:
    | {
        readonly connectionId: string;
        readonly externalConversationId: string;
        readonly externalSenderId: string;
        readonly externalMessageId?: string | undefined;
        /** The forum topic or thread the task's first message arrived in. */
        readonly externalThreadId?: string | undefined;
        /**
         * The inbound email's `References` header, oldest ancestor first.
         * A reply threads correctly only one level deep from
         * `externalMessageId`/`In-Reply-To` alone; deeper threads need the
         * full ancestor chain. Optional: not every provider's inbound
         * event carries one (Telegram has no such concept), and even
         * Mailgun's own may be absent on a first message in a thread.
         */
        readonly externalReferences?: readonly string[] | undefined;
        /** The subject of the message the task started from, where its channel has one. */
        readonly subject?: string | undefined;
        /**
         * Who reads a reply, fixed at admission:
         * `one-to-one` for a conversation known to be one. Absent: a group, a
         * forum topic, or a conversation of unknown kind — a reply there asks
         * under [A]∧[B] (`private-group-reply`).
         */
        readonly audience?: "one-to-one" | undefined;
      }
    | undefined;
}
