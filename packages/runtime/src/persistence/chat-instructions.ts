import {
  CHAT_INSTRUCTIONS_HISTORY_MAX,
  CHAT_INSTRUCTIONS_MAX,
  TaviError,
  type ChatInstructionsRevision,
  type RecordChatInstructionsInput,
} from "@tavi/contracts";

import type { ChatInstructionsRepositoryPort } from "./internal-contracts.js";
import type { Database } from "./sqlite-loader.js";

interface Row {
  task_id: string;
  revision: number;
  text: string;
  author: string;
  recorded_at: string;
}

const toRevision = (row: Row): ChatInstructionsRevision => ({
  taskId: row.task_id,
  revision: row.revision,
  text: row.text,
  author: row.author,
  recordedAt: row.recorded_at,
});

/** The chat's highest revision number, 0 when it has none. */
export function currentChatInstructionsRevision(db: Database, taskId: string): number {
  return (
    db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM tavi_chat_instructions WHERE task_id = ?").get(taskId) as {
      revision: number;
    }
  ).revision;
}

/** Write a chat's next revision; the caller holds the write transaction and has checked the task and the bound. */
export function insertChatInstructions(
  db: Database,
  input: { readonly taskId: string; readonly revision: number; readonly text: string; readonly author: string; readonly now: string },
): ChatInstructionsRevision {
  db.prepare("INSERT INTO tavi_chat_instructions (task_id, revision, text, author, recorded_at) VALUES (?, ?, ?, ?, ?)").run(
    input.taskId,
    input.revision,
    input.text,
    input.author,
    input.now,
  );
  return { taskId: input.taskId, revision: input.revision, text: input.text, author: input.author, recordedAt: input.now };
}

/** The bounds `ChatInstructionsRevisionSchema` reads a revision back with, checked before one is written. */
export function assertChatInstructionsBound(text: string, author: string): void {
  if (text.length > CHAT_INSTRUCTIONS_MAX) {
    throw new TaviError("INVALID_INPUT", `A chat's instructions are at most ${CHAT_INSTRUCTIONS_MAX} characters`, {
      details: { length: text.length, max: CHAT_INSTRUCTIONS_MAX },
    });
  }
  if (author.length < 1 || author.length > 256) {
    throw new TaviError("INVALID_INPUT", "A chat's instructions name who saved them in 1 to 256 characters");
  }
}

/**
 * Each chat's own instructions, by revision. Reads are plain; `record` is compare-and-set
 * on the revision the writer read, in an immediate transaction.
 */
export class SqliteChatInstructionsRepository implements ChatInstructionsRepositoryPort {
  readonly #db: () => Database;
  readonly #transaction: <T>(work: () => T) => T;

  constructor(db: () => Database, transaction: <T>(work: () => T) => T) {
    this.#db = db;
    this.#transaction = transaction;
  }

  current(taskId: string): ChatInstructionsRevision | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_chat_instructions WHERE task_id = ? ORDER BY revision DESC LIMIT 1").get(taskId) as
      | Row
      | undefined;
    return row === undefined ? undefined : toRevision(row);
  }

  get(taskId: string, revision: number): ChatInstructionsRevision | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_chat_instructions WHERE task_id = ? AND revision = ?").get(taskId, revision) as
      | Row
      | undefined;
    return row === undefined ? undefined : toRevision(row);
  }

  forAdmission(admissionId: string): ChatInstructionsRevision | undefined {
    const row = this.#db()
      .prepare(`SELECT c.* FROM tavi_admissions a
        JOIN tavi_chat_instructions c ON c.task_id = a.task_id AND c.revision = a.instructions_revision
        WHERE a.admission_id = ?`)
      .get(admissionId) as Row | undefined;
    return row === undefined ? undefined : toRevision(row);
  }

  history(taskId: string, limit: number): readonly ChatInstructionsRevision[] {
    if (!Number.isInteger(limit) || limit < 1) throw new TaviError("INVALID_INPUT", "A history limit is a positive integer");
    const rows = this.#db()
      .prepare("SELECT * FROM tavi_chat_instructions WHERE task_id = ? ORDER BY revision DESC LIMIT ?")
      .all(taskId, Math.min(limit, CHAT_INSTRUCTIONS_HISTORY_MAX)) as Row[];
    return rows.map(toRevision);
  }

  record(input: RecordChatInstructionsInput): ChatInstructionsRevision {
    assertChatInstructionsBound(input.text, input.author);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TaviError("INVALID_INPUT", "The revision a save expects is a non-negative integer");
    }
    return this.#transaction(() => {
      const db = this.#db();
      if (db.prepare("SELECT 1 FROM tavi_tasks WHERE task_id = ?").get(input.taskId) === undefined) {
        throw new TaviError("NOT_FOUND", `Task ${input.taskId} does not exist`);
      }
      const current = currentChatInstructionsRevision(db, input.taskId);
      if (current !== input.expectedRevision) {
        throw new TaviError("CONFLICT", "The chat's instructions changed since they were read", {
          details: { taskId: input.taskId, expectedRevision: input.expectedRevision, currentRevision: current },
        });
      }
      return insertChatInstructions(db, {
        taskId: input.taskId,
        revision: current + 1,
        text: input.text,
        author: input.author,
        now: input.now,
      });
    });
  }
}
