import type { SystemPromptRepositoryPort } from "../internal-contracts.js";
import {
  TaviError,
  TimestampSchema,
  MAX_SYSTEM_PROMPT_CODE_UNITS,
  IdSchema,
  SystemPromptActorSchema,
  SystemPromptTextSchema,
  SystemPromptRevisionSchema,
  WorkspaceSystemPromptRecordSchema,
  absentWorkspaceSystemPrompt,
  type ResetWorkspaceSystemPromptInput,
  type SetWorkspaceSystemPromptInput,
  type SystemPromptText,
  type WorkspaceSystemPromptRecord,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { StoreContext } from "./context.js";
import { assertWritable, parseStoredRow } from "./stored-values.js";

interface WorkspaceSystemPromptRow {
  readonly workspace_id: string;
  readonly text: string | null;
  readonly revision: number;
  readonly last_operation: string | null;
  readonly previous_revision: number | null;
  readonly actor: string | null;
  readonly hash: string | null;
  readonly updated_at: string;
}

/**
 * The editable workspace system prompt.
 *
 * Both mutations are compare-and-set under `transactionImmediate`: a plain
 * `SELECT` inside the default deferred transaction takes only a read lock, so a
 * read-then-write would not actually be atomic against another writer under WAL
 * (`SqliteStore.transactionImmediate`). A stale expected revision is a `CONFLICT` with revision
 * details only — never the prompt text.
 *
 * The row is retained after a reset rather than deleted, so a stale writer
 * carrying an old revision can never match a later recreated setting.
 */
export class SqliteSystemPromptRepository implements SystemPromptRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  get(workspaceId: string): WorkspaceSystemPromptRecord {
    const id = assertSystemPromptWorkspaceId(workspaceId, "The system prompt workspace id");
    // No row is not an error and not an empty string: it is revision zero with
    // no override, which is what "never configured" means.
    const row = this.#store.handle.prepare("SELECT * FROM tavi_workspace_system_prompts WHERE workspace_id = ?").get(id) as
      | WorkspaceSystemPromptRow
      | undefined;
    if (row === undefined) return absentWorkspaceSystemPrompt(id);
    // A row whose hash does not describe its own text is not a record this build
    // can account for: the hash is the only durable statement of *what* changed,
    // so a corrupted one would make the audit metadata silently wrong.
    if (row.text !== null && row.hash !== null) {
      // The revision is named, and is the one thing that makes the corruption
      // recoverable from the CLI: `reset` takes the revision it is replacing as
      // its compare-and-set, and a read that refused to report it would leave the
      // operator nothing to assert. No prompt text appears here.
      assertHashMatchesText(
        row.text,
        row.hash,
        `Stored system prompt for workspace ${id}`,
        `the override is at revision ${row.revision}, so reset the setting at that revision or restore a backup`,
      );
    }
    return parseStoredRow(
      WorkspaceSystemPromptRecordSchema,
      {
        workspaceId: row.workspace_id,
        text: row.text,
        revision: row.revision,
        updatedAt: row.updated_at,
        lastOperation: row.last_operation,
        previousRevision: row.previous_revision,
        actor: row.actor,
        hash: row.hash,
      },
      `system prompt for workspace ${id}`,
    );
  }

  set(input: SetWorkspaceSystemPromptInput): WorkspaceSystemPromptRecord {
    const workspaceId = assertSystemPromptWorkspaceId(input.workspaceId, "The system prompt workspace id");
    const text = assertSystemPromptText(input.text);
    const actor = assertSystemPromptActor(input.actor);
    const expectedRevision = assertWritable(
      SystemPromptRevisionSchema,
      input.expectedRevision,
      `The expected system prompt revision for workspace ${workspaceId}`,
    );
    assertWritable(TimestampSchema, input.now, "The system prompt update time");
    return this.#store.transactionImmediate(() => {
      const current = this.get(workspaceId);
      assertExpectedSystemPromptRevision(workspaceId, current.revision, expectedRevision);
      this.#write({
        workspaceId,
        text,
        revision: current.revision + 1,
        lastOperation: "set",
        previousRevision: current.revision,
        actor,
        // The prompt's SHA-256, as `RoutineAgentPinSchema.hash` and `systemPromptHash` in
        // `@tavi/agent-host/system-prompt` write it: a change to the format is made in both.
        hash: sha256Hex(text),
        now: input.now,
      });
      return this.get(workspaceId);
    });
  }

  reset(input: ResetWorkspaceSystemPromptInput): WorkspaceSystemPromptRecord {
    const workspaceId = assertSystemPromptWorkspaceId(input.workspaceId, "The system prompt workspace id");
    const actor = assertSystemPromptActor(input.actor);
    const expectedRevision = assertWritable(
      SystemPromptRevisionSchema,
      input.expectedRevision,
      `The expected system prompt revision for workspace ${workspaceId}`,
    );
    assertWritable(TimestampSchema, input.now, "The system prompt reset time");
    return this.#store.transactionImmediate(() => {
      // The revision alone, never `get`: clearing an unreadable override is the
      // repair that reading it refuses to perform, so validating the text here
      // would let the corruption block the one operation that fixes it. The
      // compare-and-set still holds — it is asserted against the stored revision,
      // which survives a text/hash disagreement.
      const current = this.#revisionOf(workspaceId);
      assertExpectedSystemPromptRevision(workspaceId, current, expectedRevision);
      // The row survives with `text = NULL`; deleting it would let the revision
      // restart and a stale writer's expected revision match again.
      this.#write({
        workspaceId,
        text: null,
        revision: current + 1,
        lastOperation: "reset",
        previousRevision: current,
        actor,
        hash: null,
        now: input.now,
      });
      return this.get(workspaceId);
    });
  }

  /**
   * The stored revision, read without reading the override itself.
   *
   * No row reads as revision zero, exactly as `get` reports it, so a `reset` on a
   * workspace that never saved an override is still the ordinary
   * compare-and-set. A revision that does not parse is refused: at that point the
   * row is unreadable in a way no in-product write repairs.
   */
  #revisionOf(workspaceId: string): number {
    const row = this.#store.handle.prepare("SELECT revision FROM tavi_workspace_system_prompts WHERE workspace_id = ?").get(workspaceId) as
      | { readonly revision: unknown }
      | undefined;
    if (row === undefined) return 0;
    const revision = SystemPromptRevisionSchema.safeParse(row.revision);
    if (!revision.success) {
      throw new TaviError("INTERNAL", `Stored system prompt for workspace ${workspaceId} has an unreadable revision; restore a backup`, {
        details: { workspaceId },
      });
    }
    return revision.data;
  }

  #write(input: {
    readonly workspaceId: string;
    readonly text: string | null;
    readonly revision: number;
    readonly lastOperation: "set" | "reset";
    readonly previousRevision: number;
    readonly actor: string;
    readonly hash: string | null;
    readonly now: string;
  }): void {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_workspace_system_prompts
           (workspace_id, text, revision, last_operation, previous_revision, actor, hash, updated_at)
         VALUES (@workspaceId, @text, @revision, @lastOperation, @previousRevision, @actor, @hash, @now)
         ON CONFLICT (workspace_id) DO UPDATE SET
           text = @text, revision = @revision, last_operation = @lastOperation,
           previous_revision = @previousRevision, actor = @actor, hash = @hash, updated_at = @now`,
      )
      .run({
        workspaceId: input.workspaceId,
        text: input.text,
        revision: input.revision,
        lastOperation: input.lastOperation,
        previousRevision: input.previousRevision,
        actor: input.actor,
        hash: input.hash,
        now: input.now,
      });
  }
}

/**
 * Refuse text the current schema does not accept.
 *
 * Deliberately *not* `assertWritable`, whose `details.value` echoes the rejected
 * value: for a 20,000-unit prompt that would copy the base into an error payload
 * and then into whatever logs it. The reason is carried instead.
 */
function assertSystemPromptText(value: unknown): SystemPromptText {
  const parsed = SystemPromptTextSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaviError("INVALID_INPUT", "The system prompt is not valid and was not written", {
      details: { reason: parsed.error.issues[0]?.message ?? "invalid", maxCodeUnits: MAX_SYSTEM_PROMPT_CODE_UNITS },
    });
  }
  return parsed.data;
}

/** Actor labels are bounded and come from the trusted operator path; the value is not secret, so echoing it is safe. */
function assertSystemPromptActor(value: unknown): string {
  const parsed = SystemPromptActorSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaviError("INVALID_INPUT", "The system prompt actor label is not valid and was not written", {
      details: { actor: typeof value === "string" ? value.slice(0, 128) : null },
    });
  }
  return parsed.data;
}

/**
 * Ids are validated before a write, like every other input.
 *
 * Without this an over-long id is a caller error reported *after* the write, as
 * an `INTERNAL` "repair it or run a migration" from the read-back — and with the
 * unbounded id interpolated into the message. The length is echoed instead.
 */
function assertSystemPromptWorkspaceId(value: unknown, what: string): string {
  return assertSystemPromptId(IdSchema, value, what);
}

function assertSystemPromptId(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: string } },
  value: unknown,
  what: string,
): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    throw new TaviError("INVALID_INPUT", `${what} is not valid`, {
      details: {
        reason: "expected a non-empty id of at most 128 characters",
        length: typeof value === "string" ? value.length : null,
      },
    });
  }
  return parsed.data;
}

/**
 * The text/hash rule, in one place: every reader of a stored base — the workspace
 * setting and both task-snapshot paths — calls it, so the three cannot drift.
 *
 * `remedy` is appended when a caller can say something more useful than "repair
 * it", such as the revision an operator needs to clear an unreadable override.
 */
export function assertHashMatchesText(text: string, hash: string, what: string, remedy?: string): void {
  if (sha256Hex(text) !== hash) {
    throw new TaviError("INTERNAL", `${what} does not hash to its own text; ${remedy ?? "repair it or restore a backup"}`);
  }
}

function assertExpectedSystemPromptRevision(workspaceId: string, currentRevision: number, expected: number): void {
  if (currentRevision !== expected) {
    throw new TaviError(
      "CONFLICT",
      `The system prompt for workspace ${workspaceId} changed since it was read ` +
        `(expected revision ${expected}, current revision ${currentRevision})`,
      { details: { expectedRevision: expected, currentRevision } },
    );
  }
}
