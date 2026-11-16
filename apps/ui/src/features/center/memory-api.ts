import {
  MEMORY_IPC_LIST_DEFAULT,
  MEMORY_IPC_LIST_MAX,
  MemoryDecideAllAnswerSchema,
  type MemoryDecideAllAnswer,
  MemoryGetAnswerSchema,
  MemoryItemSchema,
  MemoryListAnswerSchema,
  MemoryUsageAnswerSchema,
  MemoryProviderAnswerSchema,
  type MemoryEgressField,
  type MemoryProviderAnswer,
  WorkspaceSettingsAnswerSchema,
  withMemoryConfig,
  type MemoryConfigKey,
  type WorkspaceSettingsAnswer,
  SystemPromptPreviewSchema,
  type MemoryGetAnswer,
  type MemoryItem,
  type MemoryKind,
  type MemoryListAnswer,
  type MemoryScopeTarget,
  type MemoryUsageAnswer,
  type SystemPromptPreview,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { z } from "zod";

import { ask, read, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/** The workspace settings document, for its `memory` section and revision. */
export function loadMemorySettings(client: SettingsClient, workspaceId: string): Promise<Outcome<WorkspaceSettingsAnswer>> {
  return read(client, "workspace-settings", { action: "get", workspaceId }, WorkspaceSettingsAnswerSchema);
}

/**
 * Memory settings changed (each `[key, value]` as `tavi memory config` takes
 * it): the whole section is written once, against the revision the page read,
 * so a change made meanwhile is a conflict the card reports rather than
 * replaces. Only the workspace operator's write is taken.
 */
export async function saveMemorySettings(
  client: SettingsClient,
  workspaceId: string,
  current: Pick<WorkspaceSettingsAnswer, "settings" | "revision">,
  changes: readonly (readonly [MemoryConfigKey, string])[],
  /**
   * The disclosure hybrid recall on a remote embedding connection needs, accepted for the connection it named
   * (its refusal's `details.connectionId`): the owner refuses without it, and refuses again with the new
   * disclosure if another connection is bound since.
   */
  confirmedConnection?: string,
  /** Personal memory embedded through the remote connection too, or not: on only after its own disclosure is `confirmed`. Absent: unchanged. */
  retrievalPersonal?: boolean,
): Promise<Outcome<WorkspaceSettingsAnswer>> {
  let section = current.settings.memory;
  try {
    for (const [key, value] of changes) section = withMemoryConfig(section, key, value);
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  return read(
    client,
    "workspace-settings",
    {
      action: "set",
      workspaceId,
      key: "memory",
      value: JSON.stringify(section ?? {}),
      expectedRevision: current.revision,
      ...(confirmedConnection === undefined ? {} : { confirmed: true, confirmedConnection }),
      ...(retrievalPersonal === undefined ? {} : { retrievalPersonal }),
    },
    WorkspaceSettingsAnswerSchema,
  );
}

/** The workspace's memory provider: selected, serving, its egress and the providers installed. */
export function loadMemoryProvider(client: SettingsClient, workspaceId: string): Promise<Outcome<MemoryProviderAnswer>> {
  return read(client, "memory", { action: "provider", workspaceId }, MemoryProviderAnswerSchema);
}

/**
 * Choose the workspace's memory provider, or change one egress switch:
 * refused `APPROVAL_REQUIRED` with what it sends until `confirmed`,
 * and held to the settings revision the page read.
 */
export function changeMemoryProvider(
  client: SettingsClient,
  workspaceId: string,
  change: { readonly providerId: string } | { readonly field: MemoryEgressField; readonly on: boolean },
  revision: number,
  confirmed = false,
): Promise<Outcome<MemoryProviderAnswer>> {
  const payload =
    "providerId" in change
      ? { action: "set-provider", providerId: change.providerId }
      : { action: "egress", field: change.field, on: change.on };
  return read(
    client,
    "memory",
    { ...payload, workspaceId, expectedRevision: revision, ...(confirmed ? { confirmed: true } : {}) },
    MemoryProviderAnswerSchema,
  );
}

/** The layers a new task's instructions are assembled from, with a named agent's persona when one is picked. */
export function loadPromptPreview(client: SettingsClient, workspaceId: string, agentId?: string): Promise<Outcome<SystemPromptPreview>> {
  return read(
    client,
    "system-prompt",
    { action: "preview", workspaceId, ...(agentId === undefined ? {} : { agentId }) },
    SystemPromptPreviewSchema,
  );
}

/** One agent as the persona picker lists it: no persona text, its length and its version. */
const AgentSummarySchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  updatedAt: z.string().min(1),
  systemPromptLength: z.number().int().nonnegative(),
  /** Routines that run this agent under the instructions pinned in their revision; absent from an older owner. */
  pinnedBy: z.array(z.object({ routineId: z.string().min(1), name: z.string().min(1) })).optional(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

const AgentsListSchema = z.object({ agents: z.array(AgentSummarySchema), truncated: z.boolean() });

/** The workspace's agents, for the persona picker and the Remember scope picker. */
export function listAgents(client: SettingsClient, workspaceId: string): Promise<Outcome<z.infer<typeof AgentsListSchema>>> {
  return read(client, "agents", { action: "list", workspaceId }, AgentsListSchema);
}

/** One agent's persona as saved, and the version an update asserts. */
const PersonaSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
  systemPrompt: z.string(),
  updatedAt: z.string().min(1),
});
export type Persona = z.infer<typeof PersonaSchema>;

export function loadPersona(client: SettingsClient, workspaceId: string, agentId: string): Promise<Outcome<Persona>> {
  return read(client, "agents", { action: "show", workspaceId, agentId }, PersonaSchema);
}

/**
 * Save a persona, asserting the version it was read at: a definition changed
 * since is `CONFLICT`, which the editor offers Reload / Copy draft for.
 */
export function savePersona(
  client: SettingsClient,
  workspaceId: string,
  agentId: string,
  prompt: string,
  expectedUpdatedAt: string,
): Promise<Outcome<Persona>> {
  return read(client, "agents", { action: "update", workspaceId, agentId, prompt, expectedUpdatedAt }, PersonaSchema);
}

/** Memory records per page: the owner's default. */
export const MEMORY_PAGE_SIZE = MEMORY_IPC_LIST_DEFAULT;

/**
 * One page of the operator's memory: `proposed` records, or those in force.
 * With `query`, a full-text search (one page, no cursor). `limit` defaults to
 * a page and is bounded by one request's most.
 */
export function listMemory(
  client: SettingsClient,
  workspaceId: string,
  options: {
    readonly status: "approved" | "proposed";
    readonly query?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
): Promise<Outcome<MemoryListAnswer>> {
  const query = options.query?.trim();
  return read(
    client,
    "memory",
    {
      action: "list",
      workspaceId,
      statuses: [options.status],
      limit: Math.min(MEMORY_IPC_LIST_MAX, options.limit ?? MEMORY_PAGE_SIZE),
      ...(query ? { query } : {}),
      ...(options.cursor === undefined || query ? {} : { cursor: options.cursor }),
    },
    MemoryListAnswerSchema,
  );
}

/**
 * One page of *Past*: ended facts, kept, and expired preferences and
 * lessons, each erased `limits.proposalDays` after it expired (`erasesAt`).
 */
export function listPastMemory(
  client: SettingsClient,
  workspaceId: string,
  options: { readonly cursor?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<Outcome<MemoryListAnswer>> {
  return read(
    client,
    "memory",
    {
      action: "list",
      workspaceId,
      past: true,
      limit: Math.min(MEMORY_IPC_LIST_MAX, options.limit ?? MEMORY_PAGE_SIZE),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    MemoryListAnswerSchema,
  );
}

/**
 * *Keep longer*: a new end date (`YYYY-MM-DD`, through that day in
 * the workspace's zone), or `null` to keep it with no end. An expired record
 * returns to approved; a preference whose key has another value kept meanwhile
 * is `MEMORY_CONFLICT`.
 */
export function keepMemoryLonger(
  client: SettingsClient,
  workspaceId: string,
  record: Pick<MemoryItem, "recordId" | "currentRevisionId">,
  until: string | null,
): Promise<Outcome<MemoryItem>> {
  return read(
    client,
    "memory",
    {
      action: "correct",
      workspaceId,
      recordId: record.recordId,
      ...(record.currentRevisionId === undefined ? {} : { expectedRevisionId: record.currentRevisionId }),
      until,
    },
    MemoryItemSchema,
  );
}

/** One record whole; `reveal` returns a sensitive record's title and body. */
export function getMemory(
  client: SettingsClient,
  workspaceId: string,
  recordId: string,
  reveal: boolean,
): Promise<Outcome<MemoryGetAnswer>> {
  return read(client, "memory", { action: "get", workspaceId, recordId, ...(reveal ? { reveal: true } : {}) }, MemoryGetAnswerSchema);
}

/** Records and body bytes in the scopes the operator sees. */
export function memoryUsage(client: SettingsClient, workspaceId: string): Promise<Outcome<MemoryUsageAnswer>> {
  return read(client, "memory", { action: "usage", workspaceId }, MemoryUsageAnswerSchema);
}

/** What Remember writes. */
export interface RememberInput {
  readonly kind: MemoryKind;
  readonly scope: MemoryScopeTarget;
  readonly title?: string | undefined;
  readonly body: string;
  readonly sensitive: boolean;
  /** A preference's key; required for a preference. */
  readonly preferenceKey?: string | undefined;
}

export function rememberMemory(client: SettingsClient, workspaceId: string, input: RememberInput): Promise<Outcome<MemoryItem>> {
  const preference = input.kind === "preference";
  return read(
    client,
    "memory",
    {
      action: "remember",
      workspaceId,
      kind: input.kind,
      scope: input.scope,
      body: input.body,
      ...(input.title ? { title: input.title } : {}),
      ...(input.sensitive ? { sensitivity: "sensitive" } : {}),
      // A preference's value is its body, stored typed as a string.
      ...(preference && input.preferenceKey ? { preferenceKey: input.preferenceKey, preferenceValue: input.body } : {}),
    },
    MemoryItemSchema,
  );
}

/** A new revision of a record's title and body, made against the revision the page showed. */
export function correctMemory(
  client: SettingsClient,
  workspaceId: string,
  record: Pick<MemoryItem, "recordId" | "kind" | "currentRevisionId">,
  change: { readonly title?: string | undefined; readonly body?: string | undefined },
): Promise<Outcome<MemoryItem>> {
  return read(
    client,
    "memory",
    {
      action: "correct",
      workspaceId,
      recordId: record.recordId,
      ...definedOnly({ expectedRevisionId: record.currentRevisionId, title: change.title, body: change.body }),
      ...(record.kind === "preference" && change.body !== undefined ? { preferenceValue: change.body } : {}),
    },
    MemoryItemSchema,
  );
}

/**
 * *Replace* an update: the owner applies the proposal as a correction
 * of the kept record it updates — held to the revisions shown — and discards
 * the proposal as applied. Answers the corrected record.
 */
export function replaceMemory(
  client: SettingsClient,
  workspaceId: string,
  item: Pick<MemoryItem, "recordId" | "currentRevisionId" | "updates" | "mayUpdate">,
): Promise<Outcome<MemoryItem>> {
  const targetRevisionId = (item.updates ?? item.mayUpdate)?.currentRevisionId;
  return read(
    client,
    "memory",
    {
      action: "replace",
      workspaceId,
      recordId: item.recordId,
      ...(item.currentRevisionId === undefined ? {} : { expectedRevisionId: item.currentRevisionId }),
      ...(targetRevisionId === undefined ? {} : { targetRevisionId }),
    },
    MemoryItemSchema,
  );
}

/** Keep (approve) or discard (reject) a proposal. */
export function decideMemory(client: SettingsClient, workspaceId: string, recordId: string, keep: boolean): Promise<Outcome<MemoryItem>> {
  return read(client, "memory", { action: keep ? "approve" : "reject", workspaceId, recordId }, MemoryItemSchema);
}

/**
 * The bulk *Keep* / *Discard* over the proposals listed: *keep* keeps
 * the plain ones only — the rest wait and are counted as needing a look — and
 * answers the ids it kept, which the receipt's Undo forgets; *discard* has no
 * exclusions.
 */
export function decideAllMemory(
  client: SettingsClient,
  workspaceId: string,
  recordIds: readonly string[],
  decision: "keep" | "discard",
): Promise<Outcome<MemoryDecideAllAnswer>> {
  return read(client, "memory", { action: "decide-all", workspaceId, recordIds: [...recordIds], decision }, MemoryDecideAllAnswerSchema);
}

/**
 * Erase a record. The owner answers a content-free receipt; its shape is not
 * required (an acknowledged forget is done), and the page reads only the
 * providers its removal waits for from it (`forgetWaitsFor`).
 */
export function forgetMemory(client: SettingsClient, workspaceId: string, recordId: string): Promise<Outcome<unknown>> {
  return ask<unknown>(client, "memory", { action: "forget", workspaceId, recordId });
}

/** The memory providers a forget's removal waits for (the receipt's `pendingProviders`); none when it names none, or is no receipt. */
export function forgetWaitsFor(receipt: unknown): readonly string[] {
  const waiting =
    receipt !== null && typeof receipt === "object" ? (receipt as { readonly pendingProviders?: unknown }).pendingProviders : undefined;
  return Array.isArray(waiting) ? waiting.filter((id): id is string => typeof id === "string" && id !== "") : [];
}
