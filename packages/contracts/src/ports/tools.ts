import type { z } from "zod";
import type { ConnectRequest } from "../app-connect.js";
import type { ContentLabel } from "../content-label.js";
import type { TaskExecutionPolicy } from "../execution-policy.js";
import type { ProviderBindingReference } from "../provider-operation.js";
import type { CallAssessment, SourceCheck, SourceCheckContext } from "../tool-policy.js";
import type { ToolDefinition, ToolSink } from "../tools.js";
import type { InvocationContext } from "./invocation.js";
import type { MemoryReach } from "./memory-service.js";

/**
 * Model-facing JSON Schema derived from a tool's canonical Zod schema.
 *
 * `unknown` would force an unchecked cast at every consumer; this alias states
 * the one thing the value must be without pulling a JSON Schema library into the
 * contracts package.
 */
export type ToolJsonSchema = Readonly<Record<string, unknown>>;

/** The scope a tool list is assembled for: who the tools would be offered to. */
export interface ToolOfferContext {
  readonly workspaceId: string;
  /** The person the tools are offered to, when a turn's list is assembled; absent outside a turn. */
  readonly principalId?: string;
  /** Whether that person is the workspace's operator (its grant's principal); absent when not known. */
  readonly operator?: boolean;
  /**
   * How far the turn's memory reaches: `chat-only` for a group chat. A
   * Personal account's tools are not offered there.
   */
  readonly memoryReach?: MemoryReach | undefined;
  /** The messaging connection of the conversation the turn answers, when it came from a channel: a tool of that conversation's channel is offered by its capabilities alone. */
  readonly messagingConnectionId?: string | undefined;
  /**
   * Who reads the conversation the turn answers, when it came from a channel: `one-to-one` for one
   * known to be (`messagingReplyTo.audience`), else `group` — a group, a forum topic, or one of unknown
   * kind. A tool that acts on a group's members (a poll, an event, its recent messages) is not offered
   * in a one-to-one turn. Absent outside a channel turn.
   */
  readonly messagingConversationKind?: "group" | "one-to-one" | undefined;
  /**
   * Set when a turn's list is assembled and the turn answers no channel
   * conversation: Home, the terminal, the canvas, a scheduled run, a local
   * chat. A tool that only acts on the conversation a task came from is not
   * offered there. Absent outside a turn (a routine's grant, a listing).
   */
  readonly outsideConversation?: true;
}

/**
 * What a built-in tool plugin is handed to add its tools: the registry's
 * `register` alone, so a plugin package needs nothing of the runtime's.
 */
export type ToolRegistrar = Pick<ToolRegistryPort, "register">;

export type ToolRegistryPort = {
  register(
    /** A built-in states its sink; external tools register through the registry's external entry point. */
    definition: ToolDefinition & {
      readonly sink: ToolSink;
      readonly handler: ToolHandler;
      /** Canonical Zod argument schema; the model-facing schema derives from it. */
      readonly inputSchema: z.ZodType;
      /**
       * Whether to *offer* this tool to a model in the given scope; absent means
       * always. A tool whose precondition is configuration the model cannot
       * create — a collector with no project registered — is a tool it can only
       * misfire on, and every misfire costs a turn and an error the operator
       * reads. Visibility only: `get` still resolves the tool, so a direct
       * caller (a schedule's grant, a test) is unaffected.
       */
      readonly offered?: (context: ToolOfferContext) => boolean | Promise<boolean>;
      /**
       * The tool's reading of one validated call, for the approval gate: what a
       * person is shown, the subjects rules match, its risk, and any hard
       * refusal. Absent means the effect default decides. Synchronous:
       * it reads the call's `context` — the chat's folder, pre-resolved on it
       * at admission — and does no I/O to find anything else.
       */
      readonly assess?: (input: unknown, context: InvocationContext) => CallAssessment;
      /**
       * The asynchronous half of a call's reading, run by the gate after it
       * decided to ask: what the assessor could
       * not check synchronously — a file's or a record's contents, the
       * person's words. A refusal denies the call before any card; statuses
       * go onto the verdict and the card's form rows.
       */
      readonly checkSources?: (input: unknown, context: InvocationContext, sources: SourceCheckContext) => Promise<SourceCheck>;
      readonly resolveBinding?: (input: unknown, context: InvocationContext) => Promise<ProviderBindingReference>;
    },
  ): void;
  get(id: string): RegisteredTool | undefined;
  /**
   * Static registered tool inventory. Use listOffered for a scoped model listing.
   */
  list(): readonly ToolDefinition[];
  listOffered(context: ToolOfferContext): Promise<readonly ToolDefinition[]>;
  /**
   * Canonical argument schema (a Zod schema) for a tool, used for local
   * validation of a completed call.
   */
  inputSchemaOf(id: string): z.ZodType | undefined;
  /**
   * Model-facing JSON Schema derived from the canonical schema at registration
   * time, so the schema sent to the provider and the schema used for local
   * validation cannot drift.
   */
  inputJsonSchemaOf(id: string): ToolJsonSchema | undefined;
  /**
   * Provider-safe function name for a tool.
   *
   * A provider restricts function names to `[a-zA-Z0-9_-]`, which a namespaced
   * Tavi id such as `fixture.echo` violates, so the two identities are distinct
   * and the adapter — never the workflow — performs the translation.
   */
  modelNameOf(id: string): string | undefined;
  /** Canonical id behind a provider-free function name, if one is registered. */
  resolveModelName(modelName: string): string | undefined;
};

/**
 * A question a tool needs its person to answer before it can finish
 * (an MCP server's elicitation). It becomes the
 * task's "Needs you" question, as `operator.ask_user`'s does.
 */
export interface ToolQuestion {
  /** Stable within one call: the same question asked again (a retried call) has the same key, and finds its answer. */
  readonly key: string;
  readonly question: string;
  /** Choices to render as buttons; absent, the answer is free text. */
  readonly choices?: import("../agent-communication.js").AskUserChoices;
  /** Why it is asked, shown under the question. */
  readonly context?: string;
  /** How long the person has to answer. */
  readonly deadlineMs: number;
  /**
   * Not a question: the task waits for this app's account to be signed in again. The
   * outcome is `answered` with `connect`, or `wait-timeout`; `question` names it where a question's text is shown.
   */
  readonly connect?: ConnectRequest;
}

export type ToolHandler = (input: {
  /** The task the call runs in; absent when a caller invokes a tool outside a model turn. */
  readonly taskId?: string;
  /** The task's execution policy (whether a person may be asked anything); absent outside a model turn. */
  readonly executionPolicy?: TaskExecutionPolicy;
  /**
   * Asks the task's person `question` and answers with how the wait
   * settled. Present only when this run may ask a person anything. When the
   * answer is not there yet it throws `WorkflowWaitSuspend` after the question
   * is delivered: the handler lets it through, the task waits durably, and
   * the call runs again once the question is settled — `ask` with the same key
   * then answers at once.
   */
  readonly ask?: (question: ToolQuestion) => Promise<import("../agent-communication.js").AgentWaitOutcome>;
  readonly expectedBindingHash?: string;
  readonly reserveProviderAttempt?: (operation: import("../provider-operation.js").ProviderOperation) => Promise<void>;
  /** Task, gate verdict, taint and accounting identity recorded on each provider operation this call starts. */
  readonly operationEnvelope?: import("../provider-operation.js").ProviderOperationEnvelope;
  /**
   * The conversation's context label as this call runs: what a handler that
   * stores content for later — an
   * artifact — joins with its own output's label, so what it stored cannot
   * launder the context it was made in. Absent when a caller invokes a tool
   * outside a model turn; read as trusted public then.
   */
  readonly contextLabel?: ContentLabel;
  readonly input: unknown;
  readonly context: InvocationContext;
  readonly signal: AbortSignal;
  /** The model's id for this call, as the task's tool events carry it; absent when a caller invokes a tool outside a model turn. */
  readonly callId?: string;
  /** The effects ledger's key for this call (`tavi_effects`), when the ledger records it: a stable dedupe key for what the call posts. */
  readonly effectKey?: string;
  /**
   * A person's decision covers this call: they approved it in a round, or a
   * grant they gave for this task or a rule they saved matches it (a browser
   * grant covers every browser call of the task). Absent when nothing asked
   * anyone — a default, a shipped rule or a `serve --allow` flag. A handler that
   * refuses model-authored destinations by default accepts one a person allowed.
   */
  readonly operatorApproved?: boolean;
  /**
   * Who approved this very call in its round: a person, never a rule, a grant,
   * a flag, a schedule's policy or a blanket `--approval approve`. Absent when
   * no person was shown this call. A tool that sends out a file from the
   * chat's folder records it as the file's reviewer.
   */
  readonly approvedBy?: string;
  /**
   * With `approvedBy`: the call's `CallAssessment.contentHash` as the person
   * was shown it, so the handler can refuse content that changed since.
   */
  readonly approvedContentHash?: string;
  /**
   * The rule subjects the gate decided this call by (`GateVerdict.subjects`),
   * whoever or whatever allowed it: a handler that resolves its target again
   * at dispatch refuses one whose subject is no longer among them, so a rule,
   * a grant or a person's approval never reaches a target that moved since.
   * Absent when the verdict recorded none.
   */
  readonly assessedSubjects?: readonly string[];
  /**
   * The hosts the gate held this call to (`GateVerdict.scopeHosts`, or
   * `decidedHosts` for a call asked about on its own): the page a browser
   * click, submit or screenshot was decided on. A handler that finds its
   * page on another host since refuses: what was allowed was that site.
   * Absent when the verdict named none.
   */
  readonly assessedHosts?: readonly string[];
  /**
   * Present only when the call's conversation was tainted: defangs every
   * address in a text that is not a URL the conversation already knows
   * (`disarmUrls` with the task's known-URL set). A
   * tool that puts model-written words in front of a person on a channel — a
   * reply — runs them through it, so no channel previews or links a URL a page
   * planted. Deterministic for one call, so a replay sends the same words.
   */
  readonly disarmUrls?: (text: string) => string;
}) => Promise<unknown>;

export interface RegisteredTool extends ToolDefinition {
  /** Always present once registered. */
  readonly sink: ToolSink;
  /**
   * Registered as a built-in (`ToolRegistry.register`), not for an external
   * plugin or MCP tool. Only a built-in's per-call result label may name
   * its source, host, principals and refs (`toolResultLabel`).
   */
  readonly builtIn?: true;
  readonly handler: ToolHandler;
  readonly inputSchema: z.ZodType;
  readonly inputJsonSchema: ToolJsonSchema;
  /** Provider-safe function name; the only form allowed to cross the wire. */
  readonly modelName: string;
  /** See `ToolRegistryPort.register`'s `assess`. */
  readonly assess?: (input: unknown, context: InvocationContext) => CallAssessment;
  /** See `ToolRegistryPort.register`'s `checkSources`. */
  readonly checkSources?: (input: unknown, context: InvocationContext, sources: SourceCheckContext) => Promise<SourceCheck>;
  readonly resolveBinding?: (input: unknown, context: InvocationContext) => Promise<ProviderBindingReference>;
  /**
   * Whether this tool still holds open the call `callId` of `taskId`, which
   * stopped on a question: its `pending` effect is then taken up by
   * the call's next run, not reported as uncertain.
   */
  readonly holdsCall?: (taskId: string, callId: string) => boolean;
}
