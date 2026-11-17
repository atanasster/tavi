import { z } from "zod";

import {
  AgentWaitInputSchema,
  AskUserInputSchema,
  IdSchema,
  MAX_SHARED_MEMORY_RECORD_IDS,
  MAX_SPAWN_TOOLS,
  MAX_TOOL_RESULT_BYTES,
  TOOL_LABEL_KEY,
  TaviError,
  untrustedLabel,
  type ToolResultLabel,
  type CallAssessment,
  type AgentActor,
  type ContentLabel,
  type AgentCommunicationServicePort,
  type AgentDefinitionRepositoryPort,
  type AgentDelegationRepositoryPort,
  type InvocationContext,
  type ToolOfferContext,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { ToolRegistry } from "@tavi/runtime";

import { assessAgentsSpawn } from "../approvals/call-assessors.js";

/**
 * The governed agent tool surface for delegation: a small governed agent
 * tool surface (`agents.spawn`, `agents.send`, `agents.request`,
 * `agents.reply`, `agents.wait`, `agents.status`, `agents.cancel`). All seven
 * are registered, plus `agents.read_payload` for reading a mailbox message's
 * offloaded payload in bounded ranges.
 *
 * `agents.receive`/`agents.ack` are deliberately not registered here: they
 * are runtime operations, not model-controlled delivery bookkeeping — the
 * same reasoning
 * `features/memory/tools.ts` already applies to `memory.correct`/`memory.forget`
 * being left off *that* surface.
 *
 * `agents.request`'s tool input deliberately omits `expectedReplySchema`
 * (present at the `AgentRequestInput` port level): the model has no way to construct a meaningful runtime validation
 * schema as a tool-call argument, and no JSON-Schema-to-Zod conversion
 * exists in this codebase to make that a well-defined thing to accept from
 * a model in the first place. Only a programmatic caller — none exists yet
 * — could pass one.
 *
 * `agents.wait` **is** registered, but its
 * `handler` below is defensive only — `packages/agent-host/src/workflow/nodes/tools.ts`'s
 * `toolsNode` dispatches this specific tool id directly against
 * `options.agents.waitFor`, bypassing the generic `dispatchTool` path
 * entirely, so a thrown `WorkflowWaitSuspend` can become a real
 * LangGraph `interrupt()` instead of being caught and turned into a
 * `TOOL_FAILED` tool-result the way `dispatchTool` treats every other
 * thrown error. The registration still matters: it is what makes
 * `agents.wait` appear in the model-facing tool list and resolves its
 * provider-safe name — `toolsNode`'s special-cased branch reads the
 * registry too, just not this `handler` function.
 */

export const agentActorFrom = (context: InvocationContext): AgentActor => ({
  principalId: context.principalId,
  workspaceId: context.workspaceId,
  runId: context.runId,
  caller: context.caller,
  // The channel the acting turn is held to, so a worker it spawns is held to it too.
  ...(context.heldChannel === undefined ? {} : { heldChannel: context.heldChannel }),
  ...(context.heldConnectionId === undefined ? {} : { heldConnectionId: context.heldConnectionId }),
  // The front end it was typed in, so a worker it spawns is held to rules for it too.
  ...(context.frontEnd === undefined ? {} : { frontEnd: context.frontEnd }),
  // A group conversation's turn can hand a worker only its chat's notes.
  ...(context.memoryReach === undefined ? {} : { memoryReach: context.memoryReach }),
  // A chat with memory off, or a private one, spawns workers that are off from their first turn.
  ...(context.chatMemoryMode === undefined ? {} : { chatMemoryMode: context.chatMemoryMode }),
});

/**
 * The acting call's actor with its context label: a worker it spawns starts with the label, and an envelope it sends
 * carries it. `tainted` still says a call's conversation was tainted when
 * the gate read it, for a caller that hands no label (read as `unknown-source`).
 */
function labelledActorFrom(context: InvocationContext, contextLabel: ContentLabel | undefined, tainted: boolean | undefined): AgentActor {
  return {
    ...agentActorFrom(context),
    ...(tainted === true ? { tainted: true as const } : {}),
    ...(contextLabel === undefined ? {} : { label: contextLabel }),
  };
}

/**
 * The key a model's `agents.spawn` is idempotent under:
 * its own key, namespaced by the spawning task and turn. A Home never ends,
 * so a key the model reuses in a later turn ("worker-1") would otherwise
 * resolve a worker of a turn long past instead of spawning; a retry within
 * the same turn (the same task and turn start — a resume keeps it) still
 * resolves the same worker. Hashed, so it stays within a key's bound.
 */
export function spawnOperationKey(context: Pick<InvocationContext, "runId" | "turnStartedAt">, operationKey: string): string {
  const digest = sha256Hex(`${context.turnStartedAt ?? ""}\n${operationKey}`).slice(0, 32);
  return `spawn:${context.runId}:${digest}`;
}

/** The built-in general worker's id (`features/agents/builtin.ts`): a worker with no persona, for a task that is not browsing. */
export const GENERAL_WORKER_AGENT_ID = "worker";

const AgentSpawnInputSchema = z.object({
  agentDefinitionId: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Reference to a workspace-configured agent identity. Built in: `worker`, a general worker for one self-contained task (a count, a summary, a calculation); `browser`, a worker that does one browsing task and answers with records, only while the browser can open",
    ),
  input: z.string().min(1).max(8_000).describe("The worker's initial prompt/task"),
  operationKey: z.string().min(1).max(256).describe("Idempotency key: retrying with the same key resolves the same worker"),
  sharedMemoryRecordIds: z
    .array(IdSchema)
    .max(MAX_SHARED_MEMORY_RECORD_IDS)
    .optional()
    .describe(
      "Specific memory record ids the caller has already read and chooses to share with this worker — never a scope, always " +
        "an explicit, bounded list. A record the caller cannot itself read is rejected, not silently dropped. Without this, " +
        "the worker gets NO personal-scope memory access by default, only its own run-local memory and any workspace-shared scope.",
    ),
  tools: z
    .array(z.string().regex(/^[a-z0-9_*][a-z0-9_.*-]{0,127}$/))
    .max(MAX_SPAWN_TOOLS)
    .optional()
    .describe(
      "Tool ids or patterns (fs.*) the worker needs: it is offered only these, within this chat's tools. Omitted: this chat's tools",
    ),
});

/**
 * The recipient's agent id, which the tools derive from its task now
 * (`recipientAgentOf`): still accepted for one release, so a call written to
 * the older schema is not refused, and never used.
 */
const DeprecatedRecipientAgentId = z.string().min(1).max(128).optional().describe("Deprecated; ignored");

const AgentSendInputSchema = z
  .object({
    recipientAgentId: DeprecatedRecipientAgentId,
    recipientTaskId: z.string().min(1).max(128),
    // "request"/"reply" are deliberately excluded: those carry extra
    // required semantics (correlation, grant checks, schema validation —
    // see agents.request/agents.reply below) that a plain send bypasses by
    // design (accepting them here would open a real bypass of those checks).
    kind: z.enum(["message", "progress", "result"]),
    // Bounded well above the 2 KiB inline cap
    // (`@tavi/contracts`'s `MAX_AGENT_ENVELOPE_INLINE_BYTES`): content
    // between that cap and this 64 KiB tool-level bound is transparently
    // offloaded to the artifact store by the service. Content over 64 KiB is still rejected right here by this
    // `.max()`, and content over the 2 KiB cap is separately rejected
    // service-side when no artifact store is configured (fail closed) —
    // this cap only widens the offload window, it does not remove either
    // rejection path.
    content: z.string().max(MAX_TOOL_RESULT_BYTES).optional(),
    correlationId: z.string().max(128).optional(),
  })
  .describe("Send a bounded message to an agent's task. Returns a message ID and accepted receipt, never proof of processing.");

const AgentRequestInputSchema = z
  .object({
    recipientAgentId: DeprecatedRecipientAgentId,
    recipientTaskId: z.string().min(1).max(128),
    content: z.string().max(MAX_TOOL_RESULT_BYTES).optional(),
    deadlineAt: z.iso
      .datetime({ offset: true })
      .describe("When the request's implied wait settles at the latest (ISO 8601); held to at most a week from now"),
  })
  .describe(
    "Ask a question of another agent's task, requiring an explicit peer-messaging grant. Returns a message ID; " +
      "wait for the answer with agents.wait { correlationId: <this messageId> }.",
  );

const AgentReplyInputSchema = z.object({
  requestMessageId: z.string().min(1).max(128).describe("The agents.request messageId this reply answers"),
  content: z.string().max(MAX_TOOL_RESULT_BYTES).optional(),
});

/** Reads an agent mailbox message's offloaded payload. */
export const AGENT_PAYLOAD_TOOL_ID = "agents.read_payload";

const ReadPayloadInputSchema = z.object({
  messageId: z
    .string()
    .min(1)
    .max(128)
    .describe("The mailbox message whose offloaded payload to read: the messageId an agents.wait result or a [mailbox] note gives"),
  offset: z.number().int().min(0).optional().describe("Byte offset into the artifact; default 0"),
  length: z.number().int().min(1).optional().describe("Bytes to read from offset, bounded per call regardless of what's requested"),
});

const AgentStatusInputSchema = z.object({ taskId: z.string().min(1).max(128) });

const AgentCancelInputSchema = z.object({ taskId: z.string().min(1).max(128), reason: z.string().min(1).max(500).optional() });

export interface AgentToolOptions {
  /** The workspace's agent definitions: a spawn naming one that is not there, or is off, is refused before any card. */
  readonly definitions?: Pick<AgentDefinitionRepositoryPort, "get" | "list">;
  /**
   * Who a task runs as: a worker its delegation's agent, any other task
   * itself — the identity a sent envelope names and a request's peer grant is
   * checked against. Absent: a task is its own agent.
   */
  readonly delegations?: Pick<AgentDelegationRepositoryPort, "getByWorkerTaskId">;
  /**
   * Whether a workspace's grant holds any peer-messaging permission
   * (`agentMessageGrant`): `agents.request` and `agents.reply` are offered only
   * there, since without one each can only be refused. Absent: offered.
   */
  readonly peerMessaging?: (context: ToolOfferContext) => boolean;
}

/** What a spawn's definition check binds (`SourceCheck.contentHash`, a SHA-256 hex): the definition it found on. */
const spawnCheckHash = (agentDefinitionId: string | undefined): string =>
  sha256Hex(JSON.stringify(["agents.spawn", agentDefinitionId ?? null]));

export function registerAgentTools(registry: ToolRegistry, agents: AgentCommunicationServicePort, options: AgentToolOptions = {}): void {
  /**
   * The recipient's agent, from its task, as a worker's result names its
   * parent: never the model's word, so a request's grant is checked against
   * the agent the task really runs as.
   */
  const recipientAgentOf = async (taskId: string): Promise<string> =>
    (await options.delegations?.getByWorkerTaskId(taskId))?.workerAgentId ?? taskId;
  const peerOffered = options.peerMessaging === undefined ? {} : { offered: options.peerMessaging };
  /**
   * The definition a spawn names, as the model wrote it: its id, else the one definition whose id or name it is
   * in another case ("Researcher" for `researcher`, Mac mini tests). Anything else is passed on as it is.
   */
  const definitionIdOf = async (workspaceId: string, named: string): Promise<string> => {
    const definitions = options.definitions;
    if (definitions === undefined || (await definitions.get(workspaceId, named)) !== undefined) return named;
    const wanted = named.trim().toLowerCase();
    const matches = ((await definitions.list(workspaceId))?.agents ?? []).filter(
      (agent) => agent.agentId.toLowerCase() === wanted || agent.name.trim().toLowerCase() === wanted,
    );
    return matches.length === 1 && matches[0] !== undefined ? matches[0].agentId : named;
  };
  registry.register({
    id: "agents.spawn",
    sink: "none",
    version: "1.0.0",
    description:
      "Delegate a bounded task to a new worker agent, with a delegated budget carved from the caller's own. In a chat or a scheduled run it runs in the background, and its result comes back to you by itself: call agents.wait only when you cannot go on without it. In any other run the spawn answers once the worker's turn has ended.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: AgentSpawnInputSchema,
    // What a spawn answers (a routine's research evidence) is a worker's words: an agent's, whatever label it carries.
    outputSource: "agent",
    assess: assessAgentsSpawn,
    // An agent definition that is not there, or is off, is refused before anyone is asked, with the ones there are.
    ...(options.definitions === undefined
      ? {}
      : {
          checkSources: async (input: unknown, context: InvocationContext) => {
            const parsed = AgentSpawnInputSchema.safeParse(input);
            // Nothing to refuse: the hash binds the definition checked (none), as the gate needs a SHA-256 hex.
            if (!parsed.success || parsed.data.agentDefinitionId === undefined)
              return { statuses: [], contentHash: spawnCheckHash(undefined) };
            const definitions = options.definitions;
            const definitionId = await definitionIdOf(context.workspaceId, parsed.data.agentDefinitionId);
            const definition = await definitions?.get(context.workspaceId, definitionId);
            if (definition !== undefined && definition.enabled) return { statuses: [], contentHash: spawnCheckHash(definitionId) };
            const known = ((await definitions?.list(context.workspaceId))?.agents ?? [])
              .filter((agent) => agent.enabled)
              // With its name beside its id where they differ: the person may know it only by the name.
              .map((agent) => (agent.name === agent.agentId ? agent.agentId : `${agent.agentId} (${agent.name})`))
              .slice(0, 40);
            return {
              refused: `No agent definition ${parsed.data.agentDefinitionId} is on here; the ones there are: ${[...new Set([...known, GENERAL_WORKER_AGENT_ID])].join(", ")}`,
            };
          },
        }),
    handler: async ({ input, context, signal, operationEnvelope, contextLabel }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "agents.spawn was cancelled");
      const parsed = AgentSpawnInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "agents.spawn received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      return agents.spawn({
        // The worker starts with the call's context label: clean from a clean turn, tainted from a tainted one.
        actor: {
          ...labelledActorFrom(context, contextLabel, operationEnvelope?.tainted),
          ...(context.inheritedKnownUrls === undefined ? {} : { knownUrls: [...context.inheritedKnownUrls] }),
        },
        agentDefinitionId: await definitionIdOf(context.workspaceId, parsed.data.agentDefinitionId),
        input: parsed.data.input,
        operationKey: spawnOperationKey(context, parsed.data.operationKey),
        ...(parsed.data.sharedMemoryRecordIds === undefined ? {} : { sharedMemoryRecordIds: parsed.data.sharedMemoryRecordIds }),
        ...(parsed.data.tools === undefined ? {} : { tools: parsed.data.tools }),
        // A model's spawn goes on in the background where its result comes back by itself (`AgentSpawnInput.background`).
        background: true,
      });
    },
  });

  registry.register({
    id: "agents.send",
    sink: "none",
    version: "1.0.0",
    description:
      "Send a bounded message to a worker or the orchestrator's own task; to message a person, reply with messaging.send or reach another conversation with messaging.send_to.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: AgentSendInputSchema,
    handler: async ({ input, context, signal, operationEnvelope, contextLabel }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "agents.send was cancelled");
      const parsed = AgentSendInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "agents.send received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      return agents.send({
        // Its envelope carries the sender's label at send time.
        actor: labelledActorFrom(context, contextLabel, operationEnvelope?.tainted),
        recipientAgentId: await recipientAgentOf(parsed.data.recipientTaskId),
        recipientTaskId: parsed.data.recipientTaskId,
        kind: parsed.data.kind,
        ...(parsed.data.content === undefined ? {} : { content: parsed.data.content }),
        ...(parsed.data.correlationId === undefined ? {} : { correlationId: parsed.data.correlationId }),
      });
    },
  });

  registry.register({
    id: "agents.request",
    sink: "none",
    version: "1.0.0",
    description: "Ask a question of another agent's task; requires an explicit peer-messaging grant.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: AgentRequestInputSchema,
    ...peerOffered,
    handler: async ({ input, context, signal, operationEnvelope, contextLabel }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "agents.request was cancelled");
      const parsed = AgentRequestInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "agents.request received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      return agents.request({
        // Its envelope carries the sender's label at send time.
        actor: labelledActorFrom(context, contextLabel, operationEnvelope?.tainted),
        recipientAgentId: await recipientAgentOf(parsed.data.recipientTaskId),
        recipientTaskId: parsed.data.recipientTaskId,
        deadlineAt: parsed.data.deadlineAt,
        ...(parsed.data.content === undefined ? {} : { content: parsed.data.content }),
      });
    },
  });

  registry.register({
    id: "agents.reply",
    sink: "none",
    version: "1.0.0",
    description: "Answer a pending agents.request; requires the same peer-messaging grant the request needed.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: AgentReplyInputSchema,
    ...peerOffered,
    handler: async ({ input, context, signal, operationEnvelope, contextLabel }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "agents.reply was cancelled");
      const parsed = AgentReplyInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "agents.reply received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      return agents.reply({
        // Its envelope carries the sender's label at send time.
        actor: labelledActorFrom(context, contextLabel, operationEnvelope?.tainted),
        requestMessageId: parsed.data.requestMessageId,
        ...(parsed.data.content === undefined ? {} : { content: parsed.data.content }),
      });
    },
  });

  registry.register({
    id: "agents.status",
    sink: "none",
    version: "1.0.0",
    description: "Inspect a delegated task's current status.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: AgentStatusInputSchema,
    // A task's final words are its model's: an agent's, whatever label they carry.
    outputSource: "agent",
    handler: async ({ input, context, signal }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "agents.status was cancelled");
      const parsed = AgentStatusInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "agents.status received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      const { label, ...status } = await agents.status({ actor: agentActorFrom(context), taskId: parsed.data.taskId });
      // A task's final words are labelled as it ended: a clean worker's are trusted, one that read a page's are not.
      return label === undefined ? status : { ...status, [TOOL_LABEL_KEY]: { stored: label } satisfies ToolResultLabel };
    },
  });

  registry.register({
    id: "agents.cancel",
    sink: "none",
    version: "1.0.0",
    description: "Request cancellation of a delegated task.",
    effect: "mutating",
    // A cancelled task's work stops and is not resumed; asking twice changes nothing more.
    annotations: { destructive: true, idempotent: true },
    requiredPermissions: ["tools.invoke"],
    inputSchema: AgentCancelInputSchema,
    handler: async ({ input, context, signal }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "agents.cancel was cancelled");
      const parsed = AgentCancelInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "agents.cancel received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      await agents.cancel({
        actor: agentActorFrom(context),
        taskId: parsed.data.taskId,
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
      });
      return { cancelled: true };
    },
  });

  registry.register({
    id: "agents.wait",
    sink: "none",
    version: "1.0.0",
    description:
      "Suspend until a matching reply arrives, a worker completes, or the deadline passes. Must be the only tool call in its turn.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: AgentWaitInputSchema,
    // A worker's result or a peer's reply is labelled by its sender's label at send time,
    // not a blanket untrusted: a clean worker does not taint its parent, one that fetched a page does.
    // The workflow labels every result it dispatches (`waitOutputLabel`); a result message without a label
    // is from before labels, and reads as an agent's, untrusted.
    outputSource: "agent",
    labelledByStore: true,
    // Defensive only — see this file's header comment. `toolsNode`
    // dispatches `agents.wait` directly, never through the generic
    // `dispatchTool` path this handler would run under.
    handler: async () => {
      throw new TaviError(
        "INTERNAL",
        "agents.wait is handled by the agent loop itself; it cannot be called through the general tool registry",
      );
    },
  });

  registry.register({
    // Namespaced like every other tool (`ToolIdSchema` requires it), and named
    // for who is being asked: `agents.*` asks agents, this asks the operator.
    id: "operator.ask_user",
    sink: "none",
    version: "1.0.0",
    description:
      "Ask the operator a question in their chat and suspend until they answer, or until the deadline passes. Must be the only tool call in its turn. When the answer is a choice, offer 2-4 `options` — the operator taps one or replies with its number, and the result names the chosen labels in `answers` (or their own words in `other`). Never ask for a secret: tell the operator which `tavi credentials set` command to run instead, then verify only that the reference resolves.",
    // `external`, because it puts a message in front of a person. Deliberately
    // not `read-only` even though it *waits*: a wait that a human reads is a
    // side effect outside this process, and classifying it as a read would hide
    // it from any policy that gates outbound contact.
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    inputSchema: AskUserInputSchema,
    // Defensive only — `toolsNode` dispatches `ask_user` directly, for the same
    // reason it dispatches `agents.wait` directly: the generic path converts a
    // thrown `WorkflowWaitSuspend` into a `TOOL_FAILED` message instead of
    // letting it become a real suspension.
    handler: async () => {
      throw new TaviError(
        "INTERNAL",
        "operator.ask_user is handled by the agent loop itself; it cannot be called through the general tool registry",
      );
    },
  });

  registry.register({
    id: AGENT_PAYLOAD_TOOL_ID,
    sink: "none",
    version: "1.0.0",
    description:
      "Read a bounded byte range of an agent mailbox message's offloaded payload (a worker's long result or message); " +
      "paginate with offset/length. It reads no other artifact.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: ReadPayloadInputSchema,
    assess: (): CallAssessment => ({
      display: { title: "Read a worker's offloaded result" },
      subjects: [],
      risk: "low",
      reasons: [],
    }),
    // An offloaded payload may be a worker's fetched page or search result: its label is the
    // one it was stored with, raised into the result, not a blanket untrusted. One stored
    // before labels reads as an agent's, untrusted (`AgentArtifactGetResult.label`).
    outputSource: "agent",
    labelledByStore: true,
    handler: async ({ input, context, signal }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", `${AGENT_PAYLOAD_TOOL_ID} was cancelled`);
      const parsed = ReadPayloadInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", `${AGENT_PAYLOAD_TOOL_ID} received invalid arguments`, {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      const { label, ...read } = await agents.getArtifact({
        actor: agentActorFrom(context),
        messageId: parsed.data.messageId,
        ...(parsed.data.offset === undefined ? {} : { offset: parsed.data.offset }),
        ...(parsed.data.length === undefined ? {} : { length: parsed.data.length }),
      });
      // A port that says nothing of the label fails safe: an agent's payload, untrusted.
      return { ...read, [TOOL_LABEL_KEY]: { stored: label ?? untrustedLabel("agent") } satisfies ToolResultLabel };
    },
  });
}
