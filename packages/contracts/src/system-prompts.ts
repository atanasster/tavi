import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";

/**
 * The editable workspace system prompt, and the per-task snapshot of the base
 * that a task actually ran with.
 *
 * Two distinct things live in this module, deliberately:
 *
 *  - the **editable setting** — one optional custom base per workspace, bounded
 *    by the editor limit and written through a compare-and-set;
 *  - the **task snapshot** — the base a task selected at admission, immutable
 *    for that task, and allowed to be larger than the editor limit because a
 *    composed explicit routine prompt legitimately is.
 *
 * Folding them into one schema would be a mistake: the editor's
 * 20,000-unit bound would then apply to routine prompts that already exceed it,
 * and a snapshot would appear writable from the settings editor.
 */

/**
 * The editor bound, in JavaScript string code units (UTF-16), matching the unit
 * `agents.ts:55` / `routines.ts:47` state.
 *
 * The code-unit count is checked explicitly rather than with `.max()`: the
 * pinned zod 4.6.5 counts *code points* for a string maximum, so `"\u{1F600}"
 * .repeat(10_001)` (20,002 code units) satisfies `.max(20_000)`. Under the
 * code-unit bound it must be refused, and the DOM `maxLength` the editor uses
 * counts code units too.
 */
export const MAX_SYSTEM_PROMPT_CODE_UNITS = 20_000;

/**
 * The execution-snapshot bound, in UTF-8 text bytes.
 *
 * Independent of both the editor bound and `MAX_ADMISSION_PAYLOAD_BYTES`
 * (the snapshot is its own row, not part of an admission payload), and
 * deliberately generous: a composed routine prompt plus pinned skills may pass
 * the editor bound without being corrupt. It is a storage sanity bound, not the
 * invocation-fit rule — `assembleContext` is.
 */
export const MAX_TASK_PROMPT_SNAPSHOT_BYTES = 256 * 1024;

/** A lowercase hex SHA-256, matching `RoutineAgentPinSchema.hash`. */
export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Accepted editable prompt text, verbatim.
 *
 * `min(1)` alone accepts `"   "`, so the whitespace-only case is a separate
 * refinement rather than a claim that an empty-after-trim base is meaningful.
 * Nothing here trims: the accepted text is stored and sent exactly as written.
 */
export const SystemPromptTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.length <= MAX_SYSTEM_PROMPT_CODE_UNITS, {
    message: `a system prompt must be at most ${MAX_SYSTEM_PROMPT_CODE_UNITS} JavaScript string code units`,
  })
  .refine((value) => value.trim().length > 0, { message: "a system prompt must not be whitespace-only" });
export type SystemPromptText = z.infer<typeof SystemPromptTextSchema>;

/** Where a task's selected base came from. */
export const TASK_PROMPT_SOURCES = ["workspace", "builtin", "explicit"] as const;
export type TaskPromptSource = (typeof TASK_PROMPT_SOURCES)[number];

/**
 * The operations that can change the workspace setting.
 *
 * Recorded on the row as latest-change metadata — this is not a
 * historical ledger; historical *task* text lives in the snapshot table.
 */
export const SYSTEM_PROMPT_OPERATIONS = ["set", "reset"] as const;
export type SystemPromptOperation = (typeof SYSTEM_PROMPT_OPERATIONS)[number];

/** Actor metadata is a label from the trusted operator path, never prompt content or a payload-supplied identity. */
export const SystemPromptActorSchema = z.string().min(1).max(128);

/**
 * A nonnegative revision; an absent row is revision zero.
 *
 * Bounded by `Number.MAX_SAFE_INTEGER`, not merely by SQLite's 64-bit INTEGER:
 * a hand-edited or restored row above it reads back as a non-integer double and
 * would fail `parseStoredRow` as `INTERNAL`, so the contract states the range
 * storage can actually honour.
 */
export const SystemPromptRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * The persisted workspace setting.
 *
 * A row is retained even when the override is cleared, because a deleted row
 * would let a stale write carrying an old revision match again — the ABA
 * problem. `clearWorkspaceDefault` and `setActivation` do delete on clear
 * (`store.ts:2264`, `:3856`); copying either here would reintroduce it.
 *
 * `text === null` therefore means "no override, use the shipped default",
 * while `lastOperation` and `previousRevision` still record what happened.
 *
 * The change-metadata columns are nullable **on purpose**, so this describes the
 * shape of a row rather than promising every field was written. A *stored* row
 * with text always carries them — every `set` writes them and `updated_at` is
 * `NOT NULL` — but the schema does not enforce that, and the two readers differ
 * on a row that lost them: `selectWorkspacePromptSnapshot` still runs the text
 * (the override is readable, and substituting the shipped default for a readable
 * override is forbidden), while `systemPromptAnswerFor`
 * cannot describe the change and raises `INTERNAL`. Neither invents metadata;
 * the remedy is a `reset`, which clears the row without reading it.
 */
export const WorkspaceSystemPromptRecordSchema = z
  .strictObject({
    workspaceId: IdSchema,
    text: SystemPromptTextSchema.nullable(),
    revision: SystemPromptRevisionSchema,
    /**
     * When the latest change was applied. `null` on the synthetic absent record
     * (`absentWorkspaceSystemPrompt`) and on a row whose change metadata was lost.
     */
    updatedAt: TimestampSchema.nullable(),
    lastOperation: z.enum(SYSTEM_PROMPT_OPERATIONS).nullable(),
    previousRevision: SystemPromptRevisionSchema.nullable(),
    actor: SystemPromptActorSchema.nullable(),
    /** Hash of `text`; `null` exactly when `text` is `null`. */
    hash: Sha256HexSchema.nullable(),
  })
  // The hash describes the stored text, so the two cannot disagree: a hash with
  // nothing to hash is a row this build cannot account for.
  .refine((record) => (record.text === null) === (record.hash === null), {
    message: "a stored system prompt hash must be present exactly when its text is",
    path: ["hash"],
  });
export type WorkspaceSystemPromptRecord = z.infer<typeof WorkspaceSystemPromptRecordSchema>;

/** The synthetic revision-zero record returned for a workspace that has never saved an override. */
export function absentWorkspaceSystemPrompt(workspaceId: string): WorkspaceSystemPromptRecord {
  return {
    workspaceId,
    text: null,
    revision: 0,
    updatedAt: null,
    lastOperation: null,
    previousRevision: null,
    actor: null,
    hash: null,
  };
}

const snapshotCommon = {
  taskId: IdSchema,
  workspaceId: IdSchema,
  /**
   * When the base was first bound to this task.
   *
   * Caller-supplied, and two producers mean two exact values: the admission
   * instant for a new task, and whatever a custom initializer supplies. A
   * re-inserted identical snapshot keeps the **persisted** value, so a retry is
   * indistinguishable from the first write.
   */
  boundAt: TimestampSchema,
} as const;
const snapshotText = z
  .string()
  .min(1)
  .refine(
    (value) =>
      // At most 3 UTF-8 bytes per code unit (a lone surrogate encodes as the
      // 3-byte replacement character), so a string this short cannot exceed the
      // bound and skips the encoder allocation. The model node re-reads this
      // record on every call, so the common case must not copy a quarter
      // megabyte to validate itself.
      value.length * 3 <= MAX_TASK_PROMPT_SNAPSHOT_BYTES || new TextEncoder().encode(value).length <= MAX_TASK_PROMPT_SNAPSHOT_BYTES,
    { message: `a task prompt snapshot must be at most ${MAX_TASK_PROMPT_SNAPSHOT_BYTES} UTF-8 bytes` },
  );
const templateVersion = z.string().min(1).max(64);
const boundSnapshotFields = { text: snapshotText, hash: Sha256HexSchema } as const;

/**
 * The per-task snapshot, as a discriminated union on `source`: a non-null text
 * and a 64-hex hash always. The hash is *format*-checked here; matching it to
 * the text needs a digest from the platform runtime, which is the repository's
 * check.
 */
export const WorkspacePromptSnapshotSchema = z.strictObject({
  ...snapshotCommon,
  ...boundSnapshotFields,
  source: z.literal("workspace"),
  revision: SystemPromptRevisionSchema,
  templateVersion: z.null(),
});

export const BuiltinPromptSnapshotSchema = z.strictObject({
  ...snapshotCommon,
  ...boundSnapshotFields,
  source: z.literal("builtin"),
  revision: z.null(),
  templateVersion,
});

export const ExplicitPromptSnapshotSchema = z.strictObject({
  ...snapshotCommon,
  ...boundSnapshotFields,
  source: z.literal("explicit"),
  revision: z.null(),
  templateVersion: z.null(),
});

/** The arms an initializer may return: every source that carries a selected base. */
export const BoundTaskPromptSnapshotSchema = z.discriminatedUnion("source", [
  WorkspacePromptSnapshotSchema,
  BuiltinPromptSnapshotSchema,
  ExplicitPromptSnapshotSchema,
]);
export type BoundTaskPromptSnapshot = z.infer<typeof BoundTaskPromptSnapshotSchema>;

/** A stored snapshot row: always a bound selection. */
export const TaskPromptSnapshotRecordSchema = BoundTaskPromptSnapshotSchema;
export type TaskPromptSnapshotRecord = BoundTaskPromptSnapshot;

/** The write payloads, as schemas rather than bare interfaces: every boundary in this package validates, and the repository consumes these aliases so the contract and the implementation cannot drift. */
export const SetWorkspaceSystemPromptInputSchema = z.strictObject({
  workspaceId: IdSchema,
  text: SystemPromptTextSchema,
  /** The revision the writer read; a mismatch is a `CONFLICT`, never a last-writer-wins overwrite. */
  expectedRevision: SystemPromptRevisionSchema,
  actor: SystemPromptActorSchema,
  now: TimestampSchema,
});
export type SetWorkspaceSystemPromptInput = z.infer<typeof SetWorkspaceSystemPromptInputSchema>;

export const ResetWorkspaceSystemPromptInputSchema = z.strictObject({
  workspaceId: IdSchema,
  expectedRevision: SystemPromptRevisionSchema,
  actor: SystemPromptActorSchema,
  now: TimestampSchema,
});
export type ResetWorkspaceSystemPromptInput = z.infer<typeof ResetWorkspaceSystemPromptInputSchema>;

/**
 * Storage for the **workspace setting**.
 *
 * One concern only: the editable base a workspace that has never saved gets,
 * and the compare-and-set write of that base. The *task* half of the feature —
 * the snapshot a task pinned at admission — lives on `TaskRepositoryPort`
 * (`getPromptSnapshot`/`putTaskSnapshot`), because that is the port the write
 * shares a transaction with. Declaring the task pair here as well would advertise a second implementation of the same
 * durability rule and let the two drift.
 *
 * `set`/`reset` are compare-and-set under `transactionImmediate` and report a
 * stale revision as `CONFLICT` with bounded revision details — never prompt
 * text, which would put the base into an error payload.
 */
interface SystemPromptRepositoryPortDefinition {
  /** Never absent: a workspace that has never saved gets the revision-zero record. */
  get(workspaceId: string): WorkspaceSystemPromptRecord;
  set(input: SetWorkspaceSystemPromptInput): WorkspaceSystemPromptRecord;
  reset(input: ResetWorkspaceSystemPromptInput): WorkspaceSystemPromptRecord;
}

export type SystemPromptRepositoryPort = AsyncRepository<SystemPromptRepositoryPortDefinition>;

/**
 * The `system-prompt` IPC command's actions.
 *
 * `set`/`reset` are compare-and-set: the payload carries the revision the client
 * read, and a mismatch is `CONFLICT` with the current revision rather than a
 * last-writer-wins overwrite. `expectedRevision` is required for both, so a
 * client cannot accidentally omit it and get an unconditional write.
 *
 * `preview` is a read: the layers a new task's model request is assembled from,
 * in order, optionally with a named agent's persona (`agentId`).
 */
export const SYSTEM_PROMPT_ACTIONS = ["get", "set", "reset", "preview"] as const;
export type SystemPromptAction = (typeof SYSTEM_PROMPT_ACTIONS)[number];

export const SystemPromptPayloadSchema = z
  .strictObject({
    action: z.enum(SYSTEM_PROMPT_ACTIONS),
    /** Required for `get`, `set` and `reset`; `preview` defaults to the default workspace. */
    workspaceId: IdSchema.optional(),
    /** The revision the writer read. Required for `set` and `reset`. */
    expectedRevision: SystemPromptRevisionSchema.optional(),
    /** The replacement base. Required for `set`. */
    text: SystemPromptTextSchema.optional(),
    /** `preview` only: the agent whose persona the preview appends. */
    agentId: IdSchema.optional(),
    /**
     * `preview` only: the chat whose next turn to preview — its own base (the
     * one it was created with) and its current instructions as the chat layer.
     */
    taskId: IdSchema.optional(),
  })
  // Refined rather than optional-and-ignored: a `set` without text or a write
  // without its expected revision is a malformed request, not a default — and
  // the converse is refused too, so a field no action reads cannot silently
  // enlarge a payload or look as though it were honoured.
  .refine((payload) => payload.action === "preview" || payload.workspaceId !== undefined, {
    message: "system-prompt get, set and reset need a workspaceId",
    path: ["workspaceId"],
  })
  .refine((payload) => payload.action !== "set" || payload.text !== undefined, {
    message: "system-prompt set needs text",
    path: ["text"],
  })
  .refine((payload) => payload.action === "get" || payload.action === "preview" || payload.expectedRevision !== undefined, {
    message: "a system-prompt write needs the expectedRevision it read",
    path: ["expectedRevision"],
  })
  .refine((payload) => payload.action !== "reset" || payload.text === undefined, {
    message: "system-prompt reset takes no text",
    path: ["text"],
  })
  .refine((payload) => payload.action !== "get" || (payload.text === undefined && payload.expectedRevision === undefined), {
    message: "system-prompt get takes only its workspace",
    path: ["action"],
  })
  .refine((payload) => payload.action !== "preview" || (payload.text === undefined && payload.expectedRevision === undefined), {
    message: "system-prompt preview takes only its workspace, an optional agentId and an optional taskId",
    path: ["action"],
  })
  .refine((payload) => payload.action === "preview" || payload.agentId === undefined, {
    message: "only system-prompt preview takes an agentId",
    path: ["agentId"],
  })
  .refine((payload) => payload.action === "preview" || payload.taskId === undefined, {
    message: "only system-prompt preview takes a taskId",
    path: ["taskId"],
  });
export type SystemPromptPayload = z.infer<typeof SystemPromptPayloadSchema>;

/** What a *new* task in this workspace would select, and which tier it came from. */
export const SystemPromptEffectiveSchema = z
  .strictObject({
    text: z.string().min(1),
    source: z.enum(["workspace", "builtin"]),
    /** The workspace revision, present exactly when `source` is `workspace`. */
    revision: SystemPromptRevisionSchema.nullable(),
    /** The shipped template version, present exactly when `source` is `builtin`. */
    templateVersion: z.string().min(1).max(64).nullable(),
  })
  // The tier decides which metadata is meaningful: a `builtin` selection has no
  // workspace revision, and a `workspace` selection has no template version.
  // Without this a caller could describe a selection that cannot exist.
  .refine(
    (effective) =>
      effective.source === "workspace"
        ? effective.revision !== null && effective.templateVersion === null
        : effective.templateVersion !== null && effective.revision === null,
    { message: "a prompt selection's source must agree with the metadata it carries", path: ["source"] },
  );
export type SystemPromptEffective = z.infer<typeof SystemPromptEffectiveSchema>;

/** The saved override, as latest-change metadata. Never prompt text in an error; here it is the operator's own read. */
export const SystemPromptCustomSchema = z.strictObject({
  text: SystemPromptTextSchema,
  revision: SystemPromptRevisionSchema,
  updatedAt: TimestampSchema,
  lastOperation: z.enum(SYSTEM_PROMPT_OPERATIONS),
  previousRevision: SystemPromptRevisionSchema,
  actor: SystemPromptActorSchema,
  hash: Sha256HexSchema,
});
export type SystemPromptCustom = z.infer<typeof SystemPromptCustomSchema>;

/**
 * The `system-prompt` answer, for both a read and a write.
 *
 * A write answers the same shape as `get`, so a client updates its saved state
 * from the acknowledgement alone rather than issuing a second read.
 *
 * `effective` describes the selection the next message would make: a new
 * chat's, and an existing chat's next turn too (a chat whose base
 * is an explicit prompt keeps its own). It never describes a
 * turn already running, which keeps the base it was admitted under: an
 * operator editing this setting must not read the answer as "the running
 * turn changed". `appliesTo` says so as `next-message`; `new-tasks` is what an
 * older owner answers.
 *
 * Both `effective` and `appliesTo` are **contract surface for out-of-tree
 * clients**: this build's CLI derives its human-readable line from `custom` and
 * `shipped`, and the Settings editor reads `custom`/`revision`/`shipped`, so
 * neither reads these two. They are still answered (and appear under
 * `tavi system-prompt show --format json`) so a client can report the tier and
 * the scope without re-deriving either from the override.
 */
export const SystemPromptAnswerSchema = z.strictObject({
  workspaceId: IdSchema,
  /** The revision of the setting row, override or not. */
  revision: SystemPromptRevisionSchema,
  /** The saved override, or `null` when this workspace follows the shipped default. */
  custom: SystemPromptCustomSchema.nullable(),
  /** The shipped default a new task with no override would use, and its version. */
  shipped: z.strictObject({ text: z.string().min(1), templateVersion: z.string().min(1).max(64) }),
  effective: SystemPromptEffectiveSchema,
  /** Activation scope: what a client that renders a scope sentence should say. */
  appliesTo: z.enum(["next-message", "new-tasks"]),
  /**
   * True when this owner's adapter was built with an explicit prompt, which
   * outranks the workspace setting. Always false for the composed runtime: no
   * production caller supplies one, so this is a UI-honesty field rather
   * than a reachable operational state.
   */
  explicitAdapterShadowing: z.boolean(),
});
export type SystemPromptAnswer = z.infer<typeof SystemPromptAnswerSchema>;

/** The parts a model request's instructions are assembled from, in the order the model receives them. */
export const SYSTEM_PROMPT_LAYER_KINDS = ["base", "persona", "chat", "facts", "context"] as const;
export type SystemPromptLayerKind = (typeof SYSTEM_PROMPT_LAYER_KINDS)[number];

/**
 * Where a base layer's text came from: the workspace override, a shipped
 * template (the current default), or an adapter's
 * explicit prompt (a routine's pinned instructions).
 */
export const SYSTEM_PROMPT_LAYER_SOURCES = ["workspace", "shipped", "explicit"] as const;
export type SystemPromptLayerSource = (typeof SYSTEM_PROMPT_LAYER_SOURCES)[number];

/**
 * One layer of the effective prompt.
 *
 * A concrete layer (`generated: false`) has a known text and its `length` in
 * UTF-16 code units — the editor's unit. A generated layer (`facts`,
 * `context`) is produced for every model call from state a preview cannot
 * know, so it has no length; `detail` describes it, and a facts `detail` is a
 * rendering from representative inputs (`sample: true`), not the text any call
 * received.
 *
 * `active: false` marks a layer that is listed but not sent: the shipped
 * default a workspace override replaces, or a disabled or blank persona.
 */
export const SystemPromptLayerSchema = z.strictObject({
  kind: z.enum(SYSTEM_PROMPT_LAYER_KINDS),
  source: z.enum(SYSTEM_PROMPT_LAYER_SOURCES).optional(),
  label: z.string().min(1).max(512),
  length: z.number().int().nonnegative().optional(),
  generated: z.boolean(),
  active: z.boolean(),
  detail: z
    .string()
    .max(64 * 1024)
    .optional(),
  /** `facts`: `detail` is a sample rendering, not a recorded one. */
  sample: z.boolean().optional(),
  /** A shipped base's template version. */
  templateVersion: z.string().min(1).max(64).optional(),
  /** A workspace base's revision, or the revision of a chat's instructions. */
  revision: SystemPromptRevisionSchema.optional(),
  /** A persona's agent. */
  agentId: IdSchema.optional(),
  name: z.string().min(1).max(200).optional(),
  /** `context`: the workspace's active (approved) skills the context may draw on, when the composer was told. */
  skills: z.number().int().nonnegative().optional(),
});
export type SystemPromptLayer = z.infer<typeof SystemPromptLayerSchema>;

/**
 * What `system-prompt preview` answers: the layers a **new** task in this
 * workspace would be given, built by the same `composeSystemPromptLayers` the
 * workflow assembles every model request with, so the two cannot drift.
 *
 * `baseText` is the base a new task selects; `personaText` is the persona as it
 * is appended (trimmed), present when the named agent contributes one.
 */
export const SystemPromptPreviewSchema = z.strictObject({
  workspaceId: IdSchema,
  agentId: IdSchema.optional(),
  layers: z.array(SystemPromptLayerSchema).max(16),
  /** The shipped default's length, in UTF-16 code units. */
  shippedLength: z.number().int().nonnegative(),
  /** Whether a workspace override replaces the shipped default. */
  overridden: z.boolean(),
  baseText: z.string().min(1),
  personaText: z.string().min(1).optional(),
  /** The chat previewed, when one was named. */
  taskId: IdSchema.optional(),
  /** The chat's instructions as its next turn would be given them, heading included. */
  chatText: z.string().min(1).optional(),
  /**
   * The fixed prompt — base, persona and a chat's instructions, before the
   * runtime facts and retrieved context — as estimated tokens, and the budget
   * each call is checked against. Absent from an
   * offline preview, which does not know the owner's budget.
   */
  budget: z.strictObject({ fixedTokens: z.number().int().nonnegative(), maxTokens: z.number().int().positive() }).optional(),
});
export type SystemPromptPreview = z.infer<typeof SystemPromptPreviewSchema>;
