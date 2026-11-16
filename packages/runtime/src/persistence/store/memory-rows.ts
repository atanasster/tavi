import {
  TaviError,
  EvidenceSourceSchema,
  LineageEdgeSchema,
  MemoryDeletionSchema,
  MemoryRecordSchema,
  MemoryRevisionSchema,
  MemoryReviewSchema,
  type EvidenceSource,
  type LineageEdge,
  type MemoryDeletion,
  type MemoryRecord,
  type MemoryReview,
  type MemoryRevision,
  type MemoryScope,
  CHAT_NOTES_KEY_PREFIX,
  MemoryProvenanceSchema,
  unreadableMemoryProvenance,
  type MemoryProvenance,
} from "@tavi/contracts";
import { parseJsonColumn, parseStoredRow } from "./stored-values.js";

/**
 * Memory the workspace's operator may review (`r` is the record): the shared
 * workspace scope, their own personal scopes in this workspace, and their
 * personal scopes that name no workspace. Run-local memory is a task's own
 * scratch space and is never an operator's to review. `operatorSeesMemory` in
 * the contracts states the same rule for one record; the two change together.
 * Takes the workspace id, then the principal id twice.
 */
export const OPERATOR_MEMORY = (r: string): string => `${r}.scope_kind <> 'run_local' AND (
  (${r}.workspace_id = ? AND (${r}.scope_kind = 'shared_workspace' OR ${r}.principal_id = ?))
  OR (${r}.workspace_id IS NULL AND ${r}.principal_id = ?))`;

/**
 * Personal memory that belongs with a workspace (`r` is the record): recorded
 * in it, or naming no workspace and held by someone the workspace knows — a
 * person with tasks in it or bound to it as an allowed messaging sender. One
 * owner serves several workspaces, and a person of another one is not this
 * workspace's to count. Takes the workspace id three times.
 */
export const WORKSPACE_PERSONAL_MEMORY = (r: string): string => `${r}.scope_kind IN ('personal', 'personal_workspace', 'personal_agent')
  AND (${r}.workspace_id = ? OR (${r}.workspace_id IS NULL AND ${r}.principal_id IN (
    SELECT t.principal_id FROM tavi_tasks t WHERE t.workspace_id = ?
    UNION SELECT b.principal_id FROM tavi_messaging_identity_bindings b WHERE b.workspace_id = ?)))`;

/**
 * The records a workspace's vectors cover: its own (`workspace_id`)
 * and the personal ones (no workspace) of the people it serves
 * (`@principalIds`, a JSON array), approved, current, in force at `@now` and
 * not sensitive. Another person's personal memory never leaves through this
 * workspace's embedding connection. Aliases `r` (records) and `v` (the current
 * revision); parameters `@workspaceId`, `@principalIds` and `@now`.
 */
export const VECTOR_ELIGIBLE_SQL = `(r.workspace_id = @workspaceId OR (r.workspace_id IS NULL AND r.principal_id IN (SELECT value FROM json_each(@principalIds))))
            AND r.status = 'approved'
            AND r.sensitivity = 'normal' AND v.sensitivity = 'normal'
            AND (r.valid_from IS NULL OR r.valid_from <= @now)
            AND (r.valid_to IS NULL OR r.valid_to > @now)
            AND (r.expiry_at IS NULL OR r.expiry_at > @now)`;

/** The most characters of a record the backfill embeds: the embedding call's own bound on a text. */
const MEMORY_VECTOR_TEXT_MAX_CHARS = 8_000;

/** The text a revision is embedded from: its title, body and a preference's key and value, one per line. */
export function memoryVectorText(row: {
  readonly title: string | null;
  readonly body: string | null;
  readonly preference_key: string | null;
  readonly preference_value: string | null;
}): string {
  let value: string | undefined;
  if (row.preference_key !== null) {
    try {
      const parsed: unknown = row.preference_value === null ? undefined : JSON.parse(row.preference_value);
      value = parsed === undefined ? undefined : typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {
      value = row.preference_value ?? undefined;
    }
  }
  const parts = [row.title, row.body, row.preference_key === null ? null : `${row.preference_key}: ${value ?? ""}`]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "");
  return Array.from(parts.join("\n")).slice(0, MEMORY_VECTOR_TEXT_MAX_CHARS).join("");
}

/**
 * The SQL that keeps rows to `scopeKeys`: a plain key matches its scope, a
 * `CHAT_NOTES_KEY_PREFIX` key only its scope's durable records, and an
 * `allChatNotesKey` the durable run-local records of the person and workspace
 * it names. `alias` is the records table's alias in the query, `""` for none.
 */
export function scopeKeyFilter(
  scopeKeys: readonly string[],
  alias: string,
): { readonly sql: string; readonly parameters: readonly string[] } {
  const column = (name: string): string => (alias === "" ? name : `${alias}.${name}`);
  const every = `${CHAT_NOTES_KEY_PREFIX}*`;
  const plain = scopeKeys.filter((key) => !key.startsWith(CHAT_NOTES_KEY_PREFIX));
  const notes = scopeKeys
    .filter((key) => key.startsWith(CHAT_NOTES_KEY_PREFIX) && !key.startsWith(every))
    .map((key) => key.slice(CHAT_NOTES_KEY_PREFIX.length));
  // `allChatNotesKey`: one person's chats in one workspace, matched by column, exactly.
  const owners = scopeKeys.filter((key) => key.startsWith(every)).map((key) => allChatNotesOwner(key.slice(every.length)));
  const parts = [
    ...(plain.length === 0 ? [] : [`${column("scope_key")} IN (${plain.map(() => "?").join(", ")})`]),
    ...(notes.length === 0 ? [] : [`(${column("scope_key")} IN (${notes.map(() => "?").join(", ")}) AND ${column("durable")} = 1)`]),
    ...owners.map(
      () =>
        `(${column("scope_kind")} = 'run_local' AND ${column("principal_id")} = ? AND ${column("workspace_id")} = ? AND ${column("durable")} = 1)`,
    ),
  ];
  return { sql: `(${parts.join(" OR ")})`, parameters: [...plain, ...notes, ...owners.flat()] };
}

/** The person and workspace an `allChatNotesKey` names; a key this build did not make is refused. */
function allChatNotesOwner(encoded: string): [string, string] {
  try {
    const value = JSON.parse(encoded) as unknown;
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string")
      return [value[0], value[1]];
  } catch {
    // Refused below.
  }
  throw new TaviError("INVALID_INPUT", "Unreadable chat notes key");
}

export interface MemoryRecordRow {
  readonly record_id: string;
  readonly scope_key: string;
  readonly scope_kind: string;
  readonly principal_id: string;
  readonly workspace_id: string | null;
  readonly agent_id: string | null;
  readonly run_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly sensitivity: string;
  readonly preference_key: string | null;
  readonly topic_key: string | null;
  readonly current_revision_id: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly expiry_at: string | null;
  readonly confidence: number | null;
  readonly confidence_basis: string | null;
  readonly supersedes_record_id: string | null;
  readonly revocation_generation: number;
  readonly recorded_at: string;
  readonly updated_at: string;
  readonly durable: number;
  readonly local_origin: number;
  readonly origin_task_id: string | null;
}

export function toMemoryScope(row: MemoryRecordRow): MemoryScope {
  switch (row.scope_kind) {
    case "personal":
      return { kind: "personal", principalId: row.principal_id };
    case "personal_workspace":
      return {
        kind: "personal_workspace",
        principalId: row.principal_id,
        workspaceId: row.workspace_id ?? "",
      };
    case "personal_agent":
      return {
        kind: "personal_agent",
        principalId: row.principal_id,
        agentId: row.agent_id ?? "",
        ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
      };
    case "shared_workspace":
      return { kind: "shared_workspace", workspaceId: row.workspace_id ?? "" };
    case "run_local":
      return {
        kind: "run_local",
        principalId: row.principal_id,
        workspaceId: row.workspace_id ?? "",
        runId: row.run_id ?? "",
      };
    default:
      throw new TaviError("INTERNAL", `Stored memory record has unknown scope kind ${row.scope_kind}`);
  }
}

export function toMemoryRecord(row: MemoryRecordRow): MemoryRecord {
  return parseStoredRow<MemoryRecord>(
    MemoryRecordSchema,
    {
      recordId: row.record_id,
      kind: row.kind,
      scope: toMemoryScope(row),
      scopeKey: row.scope_key,
      status: row.status,
      sensitivity: row.sensitivity,
      revocationGeneration: row.revocation_generation,
      recordedAt: row.recorded_at,
      updatedAt: row.updated_at,
      ...(row.preference_key === null ? {} : { preferenceKey: row.preference_key }),
      ...(row.topic_key === null ? {} : { topicKey: row.topic_key }),
      ...(row.current_revision_id === null ? {} : { currentRevisionId: row.current_revision_id }),
      ...(row.valid_from === null ? {} : { validFrom: row.valid_from }),
      ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
      ...(row.expiry_at === null ? {} : { expiryAt: row.expiry_at }),
      ...(row.confidence === null ? {} : { confidence: row.confidence }),
      ...(row.confidence_basis === null ? {} : { confidenceBasis: row.confidence_basis }),
      ...(row.supersedes_record_id === null ? {} : { supersedesRecordId: row.supersedes_record_id }),
      ...(row.durable === 1 ? { durable: true } : {}),
      ...(row.origin_task_id === null ? {} : { originTaskId: row.origin_task_id }),
      ...(row.local_origin === 1 ? { localOrigin: true } : {}),
    },
    "memory record",
  );
}

export interface MemoryRevisionRow {
  readonly revision_id: string;
  readonly record_id: string;
  readonly revision_number: number;
  readonly schema_version: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly artifact_id: string | null;
  readonly content_hash: string;
  readonly author: string;
  readonly source_ids_json: string;
  readonly observed_at: string | null;
  readonly recorded_at: string;
  readonly sensitivity: string;
  readonly status: string;
  readonly superseded_by_revision_id: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly preference_key: string | null;
  readonly preference_type: string | null;
  readonly preference_value: string | null;
  /** Where the revision's words came from, and whether they are trusted. */
  readonly provenance_json: string | null;
  readonly keywords_json?: string | null;
}

/** A revision's stored provenance; one that cannot be read is untrusted, from an unknown source. */
function storedProvenanceOf(json: string): MemoryProvenance {
  try {
    const parsed = MemoryProvenanceSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : unreadableMemoryProvenance();
  } catch {
    return unreadableMemoryProvenance();
  }
}

export function toMemoryRevision(row: MemoryRevisionRow): MemoryRevision {
  const preference =
    row.preference_key === null || row.preference_type === null
      ? undefined
      : {
          revisionId: row.revision_id,
          key: row.preference_key,
          valueType: row.preference_type,
          value: row.preference_value === null ? undefined : (JSON.parse(row.preference_value) as unknown),
        };
  const keywords =
    row.keywords_json === undefined || row.keywords_json === null ? [] : parseJsonColumn<string[]>(row.keywords_json, "keywords");
  return parseStoredRow<MemoryRevision>(
    MemoryRevisionSchema,
    {
      revisionId: row.revision_id,
      recordId: row.record_id,
      revisionNumber: row.revision_number,
      schemaVersion: row.schema_version,
      contentHash: row.content_hash,
      author: row.author,
      sourceIds: parseJsonColumn<string[]>(row.source_ids_json, "source ids"),
      recordedAt: row.recorded_at,
      sensitivity: row.sensitivity,
      status: row.status,
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.body === null ? {} : { body: row.body }),
      ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
      ...(row.observed_at === null ? {} : { observedAt: row.observed_at }),
      ...(row.superseded_by_revision_id === null ? {} : { supersededByRevisionId: row.superseded_by_revision_id }),
      ...(row.valid_from === null ? {} : { validFrom: row.valid_from }),
      ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
      ...(preference === undefined ? {} : { preference }),
      ...(keywords.length === 0 ? {} : { keywords }),
      ...(row.provenance_json === null ? {} : { provenance: storedProvenanceOf(row.provenance_json) }),
    },
    "memory revision",
  );
}

export interface MemorySearchRow {
  readonly revision_id: string;
  readonly record_id: string;
  readonly snippet: string | null;
}

export interface EvidenceSourceRow {
  readonly source_id: string;
  readonly scope_key: string;
  readonly record_id: string | null;
  readonly revision_id: string | null;
  readonly conversation_id: string | null;
  readonly message_id: string | null;
  readonly artifact_id: string | null;
  readonly operator_input: number;
  readonly observed_at: string;
  readonly content_hash: string;
  readonly capture_basis: string;
  readonly retention_policy: string;
  readonly revocation_status: string;
  readonly access_revoked_at: string | null;
  readonly claimed_author: string | null;
}

export function toEvidenceSource(row: EvidenceSourceRow): EvidenceSource {
  return parseStoredRow<EvidenceSource>(
    EvidenceSourceSchema,
    {
      sourceId: row.source_id,
      scopeKey: row.scope_key,
      operatorInput: row.operator_input === 1,
      observedAt: row.observed_at,
      contentHash: row.content_hash,
      captureBasis: row.capture_basis,
      retentionPolicy: row.retention_policy,
      revocationStatus: row.revocation_status,
      ...(row.record_id === null ? {} : { recordId: row.record_id }),
      ...(row.revision_id === null ? {} : { revisionId: row.revision_id }),
      ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
      ...(row.message_id === null ? {} : { messageId: row.message_id }),
      ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
      ...(row.access_revoked_at === null ? {} : { accessRevokedAt: row.access_revoked_at }),
      ...(row.claimed_author === null ? {} : { claimedAuthor: row.claimed_author }),
    },
    "evidence source",
  );
}

export interface MemoryReviewRow {
  readonly review_id: string;
  readonly record_id: string;
  readonly revision_id: string;
  readonly revision_hash: string;
  readonly reviewer_principal_id: string;
  readonly decision: string;
  readonly reason: string | null;
  readonly decided_at: string;
}

export function toMemoryReview(row: MemoryReviewRow): MemoryReview {
  return parseStoredRow<MemoryReview>(
    MemoryReviewSchema,
    {
      reviewId: row.review_id,
      recordId: row.record_id,
      revisionId: row.revision_id,
      revisionHash: row.revision_hash,
      reviewerPrincipalId: row.reviewer_principal_id,
      decision: row.decision,
      decidedAt: row.decided_at,
      ...(row.reason === null ? {} : { reason: row.reason }),
    },
    "memory review",
  );
}

export interface LineageEdgeRow {
  readonly edge_id: string;
  readonly from_revision_id: string;
  readonly to_revision_id: string;
  readonly claim_id: string | null;
  readonly dependency_kind: string;
  readonly derived_freshness: string;
  readonly freshness_reason: string | null;
  readonly affected_source_ids_json: string;
  readonly last_validated_generation: number;
}

export function toLineageEdge(row: LineageEdgeRow): LineageEdge {
  return parseStoredRow<LineageEdge>(
    LineageEdgeSchema,
    {
      edgeId: row.edge_id,
      fromRevisionId: row.from_revision_id,
      toRevisionId: row.to_revision_id,
      dependencyKind: row.dependency_kind,
      derivedFreshness: row.derived_freshness,
      affectedSourceIds: parseJsonColumn<string[]>(row.affected_source_ids_json, "affected source ids"),
      lastValidatedGeneration: row.last_validated_generation,
      ...(row.claim_id === null ? {} : { claimId: row.claim_id }),
      ...(row.freshness_reason === null ? {} : { freshnessReason: row.freshness_reason }),
    },
    "lineage edge",
  );
}

export interface MemoryDeletionRow {
  readonly deletion_id: string;
  readonly record_id: string;
  readonly scope_key: string;
  readonly deletion_generation: number;
  readonly requested_by: string;
  readonly reason: string;
  readonly requested_at: string;
  readonly cleanup_status: string;
  readonly cleaned_at: string | null;
  /** The providers a pending row waits for. */
  readonly pending_providers_json: string | null;
}

/** The providers a journal row's `column` names, as `json_each` rows (`p.value`): an unreadable list is none, as `pendingProvidersOf` reads it. */
export function pendingProvidersSql(column: string): string {
  return `json_each(CASE WHEN json_valid(${column}) AND json_type(${column}) = 'array' THEN ${column} ELSE '[]' END)`;
}

/** A provider id `pendingProvidersOf` keeps: a string of 1 to 128 characters. */
export const PENDING_PROVIDER_VALID = "p.type = 'text' AND length(p.value) BETWEEN 1 AND 128";

/** The providers a pending journal row waits for: an unreadable list is none. */
export function pendingProvidersOf(json: string | null | undefined): readonly string[] {
  if (json === null || json === undefined) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128) : [];
  } catch {
    return [];
  }
}

export function toMemoryDeletion(row: MemoryDeletionRow): MemoryDeletion {
  const waiting = row.cleanup_status === "pending" ? pendingProvidersOf(row.pending_providers_json) : [];
  return parseStoredRow<MemoryDeletion>(
    MemoryDeletionSchema,
    {
      deletionId: row.deletion_id,
      recordId: row.record_id,
      scopeKey: row.scope_key,
      deletionGeneration: row.deletion_generation,
      requestedBy: row.requested_by,
      reason: row.reason,
      requestedAt: row.requested_at,
      cleanupStatus: row.cleanup_status,
      ...(row.cleaned_at === null ? {} : { cleanedAt: row.cleaned_at }),
      ...(waiting.length === 0 ? {} : { pendingProviders: waiting.slice(0, 16) }),
    },
    "memory deletion",
  );
}
