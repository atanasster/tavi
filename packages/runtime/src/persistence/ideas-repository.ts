import {
  IDEA_BASIS_KINDS,
  IDEA_BRIEF_MAX,
  IDEA_PREPARED_FRESH_MS,
  IDEA_PREPARED_TEXT_MAX,
  IDEA_PRIOR_WINDOW_MS,
  IDEA_PROMPT_MAX,
  IDEA_DEFAULT_SETTINGS,
  IDEA_IGNORED_RUNS,
  IDEA_IGNORED_SUPPRESS_MS,
  IDEA_MAX_ACTIVE,
  IDEA_RUN_HASH_MAX,
  IDEA_RUN_REASON_MAX,
  IDEA_RUN_STALE_MS,
  IDEA_SHOWN_EVERY_MS,
  IDEA_TTL_MS,
  IdeaCategorySchema,
  IdeaDraftSchema,
  IdeaFeedbackSchema,
  IdeaRunSchema,
  IdeaSchema,
  IdeaSettingsSchema,
  TaviError,
  type FinishIdeaRunInput,
  type Idea,
  type IdeaBasisKind,
  type IdeaCategory,
  type IdeaFeedbackInput,
  type IdeaLedger,
  type IdeaRun,
  type IdeaSettingsRecord,
  type ListIdeasInput,
  type ResetIdeasInput,
  type SeedIdeaChatInput,
  type SaveIdeaSettingsInput,
  type StartIdeaRunInput,
  type StoreIdeasInput,
  type StoreIdeasResult,
} from "@tavi/contracts";

import type { IdeaRepositoryPort } from "./internal-contracts.js";
import { purgePlumbingTasks } from "./plumbing-tasks.js";
import type { Database } from "./sqlite-loader.js";

/** Ideas, their runs, feedback and settings. */

interface IdeaRow {
  idea_id: string;
  workspace_id: string;
  run_id: string;
  provider_id: string;
  idea_key: string;
  use_case: string | null;
  category: string;
  icon: string;
  title: string;
  pitch: string;
  label: string;
  prompt: string;
  basis_json: string;
  uses_json: string;
  recurring_cadence: string | null;
  score: number;
  status: string;
  pinned: number;
  shown_runs: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  snoozed_until: string | null;
  last_shown_at: string | null;
  prepared_task_id: string | null;
  prepared_text: string | null;
  prepared_at: string | null;
}

interface RunRow {
  run_id: string;
  workspace_id: string;
  provider_id: string | null;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  reason: string | null;
  inputs_hash: string | null;
  generated: number;
  dropped: number;
  tokens: number;
  usd: number;
}

interface SettingsRow {
  settings_json: string;
  brief: string;
  updated_at: string;
}

/** Capabilities stored under the names they had before they became categories: read as the category now. */
const RENAMED_CAPABILITIES: Readonly<Record<string, string>> = {
  gmail: "mailbox",
  flights: "travel",
  "home-assistant": "home",
  telegram: "messaging",
  discord: "messaging",
};

/** An idea's stored uses, each capability under its name now; two that now share one are one, asking if either did. */
function usesOf(json: string): unknown {
  const uses: unknown = JSON.parse(json);
  if (!Array.isArray(uses)) return uses;
  const merged: Record<string, unknown>[] = [];
  for (const use of uses as unknown[]) {
    if (typeof use !== "object" || use === null) return uses;
    const entry = use as Record<string, unknown>;
    const capability =
      typeof entry["capability"] === "string" ? (RENAMED_CAPABILITIES[entry["capability"]] ?? entry["capability"]) : entry["capability"];
    const same = merged.find((kept) => kept["capability"] === capability);
    if (same === undefined) merged.push({ ...entry, capability });
    else if (entry["approval"] === true) same["approval"] = true;
  }
  return merged;
}

const ideaOf = (row: IdeaRow): Idea =>
  IdeaSchema.parse({
    id: row.idea_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    providerId: row.provider_id,
    key: row.idea_key,
    // The column predates providers: it holds the provider's template id.
    ...(row.use_case === null ? {} : { templateId: row.use_case }),
    category: row.category,
    icon: row.icon,
    title: row.title,
    pitch: row.pitch,
    label: row.label,
    prompt: row.prompt,
    basis: JSON.parse(row.basis_json) as unknown,
    uses: usesOf(row.uses_json),
    ...(row.recurring_cadence === null ? {} : { recurring: { cadence: row.recurring_cadence } }),
    score: row.score,
    status: row.status,
    pinned: row.pinned === 1,
    shownRuns: row.shown_runs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    ...(row.snoozed_until === null ? {} : { snoozedUntil: row.snoozed_until }),
    ...(row.prepared_task_id === null || row.prepared_text === null || row.prepared_at === null
      ? {}
      : { prepared: { taskId: row.prepared_task_id, text: row.prepared_text, at: row.prepared_at } }),
  });

const runOf = (row: RunRow): IdeaRun =>
  IdeaRunSchema.parse({
    id: row.run_id,
    workspaceId: row.workspace_id,
    ...(row.provider_id === null ? {} : { providerId: row.provider_id }),
    trigger: row.trigger,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    outcome: row.outcome,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.inputs_hash === null ? {} : { inputsHash: row.inputs_hash }),
    generated: row.generated,
    dropped: row.dropped,
    tokens: row.tokens,
    usd: row.usd,
  });

const shift = (at: string, ms: number): string => new Date(Date.parse(at) + ms).toISOString();

/** The last word on each subject wins: a mute then an unmute is unmuted. */
function lastSaid(rows: readonly { subject: string; on: number }[]): string[] {
  const state = new Map<string, boolean>();
  for (const row of rows) state.set(row.subject, row.on === 1);
  return [...state].filter(([, on]) => on).map(([subject]) => subject);
}

/** Whether an idea's basis cites `ref`, in SQL over `basis_json`. */
const CITES = "EXISTS (SELECT 1 FROM json_each(tavi_ideas.basis_json) WHERE json_extract(json_each.value, '$.ref') = ?)";

/**
 * Delete every idea, in any workspace, whose basis cites `ref`: a forgotten
 * memory record (its id) or chat (`taskId`) takes the ideas that quoted it
 * along. Called inside the forget's own transaction.
 */
export function deleteIdeasCiting(db: Database, ref: string): number {
  // The prompts the person edited from those ideas go too: they were written from what is now forgotten.
  db.prepare(
    `DELETE FROM tavi_idea_feedback WHERE signal = 'edited' AND (basis_ref = ? OR idea_id IN (SELECT idea_id FROM tavi_ideas WHERE ${CITES}))`,
  ).run(ref, ref);
  // A forgotten chat an idea started: the idea no longer points at it (what was sent there went just above).
  db.prepare("UPDATE tavi_ideas SET seeded_task_id = NULL WHERE seeded_task_id = ?").run(ref);
  // Their prepared runs stay for `prune`: a prepared idea rests only on a general basis, so its run read nothing
  // forgotten, and the day's cap counts it (`preparedSince`) until it is old enough to go.
  return db.prepare(`DELETE FROM tavi_ideas WHERE ${CITES}`).run(ref).changes;
}

/**
 * A source that may no longer be quoted — a memory record revised, rejected,
 * archived or made sensitive, a chat whose memory was turned off (invariant
 * 1): every idea citing it keeps the citation but not its words, the unpinned
 * offered ones end, and their prepared answers are no longer offered;
 * the runs behind them, which read only a general prompt, are left to
 * `prune`. Run inside the caller's transaction.
 */
export function unquoteIdeasCiting(db: Database, ref: string, now: string): void {
  db.prepare(`UPDATE tavi_ideas SET prepared_task_id = NULL, prepared_text = NULL, prepared_at = NULL WHERE ${CITES}`).run(ref);
  db.prepare(
    `UPDATE tavi_ideas SET status = 'expired', snoozed_until = NULL, updated_at = ? WHERE status IN ('active', 'snoozed') AND pinned = 0 AND ${CITES}`,
  ).run(now, ref);
  const strip = db.prepare("UPDATE tavi_ideas SET basis_json = ?, updated_at = ? WHERE idea_id = ?");
  for (const row of db.prepare(`SELECT idea_id, basis_json FROM tavi_ideas WHERE ${CITES}`).all(ref) as {
    idea_id: string;
    basis_json: string;
  }[]) {
    strip.run(
      JSON.stringify(
        (JSON.parse(row.basis_json) as { kind: string; ref: string; excerpt?: string }[]).map((entry) =>
          entry.ref === ref ? { kind: entry.kind, ref: entry.ref } : entry,
        ),
      ),
      now,
      row.idea_id,
    );
  }
}

/** The basis without the words it quoted: what a dismissed idea keeps. */
const withoutExcerpts = (basisJson: string): string =>
  JSON.stringify((JSON.parse(basisJson) as { kind: string; ref: string }[]).map(({ kind, ref }) => ({ kind, ref })));

export class SqliteIdeaRepository implements IdeaRepositoryPort {
  readonly #db: () => Database;
  readonly #transaction: <T>(work: () => T) => T;

  constructor(db: () => Database, transaction: <T>(work: () => T) => T) {
    this.#db = db;
    this.#transaction = transaction;
  }

  store(input: StoreIdeasInput): StoreIdeasResult {
    const drafts = input.ideas.map((idea) => {
      const draft = IdeaDraftSchema.safeParse(idea.draft);
      if (!draft.success)
        throw new TaviError("INVALID_INPUT", "An idea is outside its bounds", {
          details: { key: idea.draft.key, issues: draft.error.issues.slice(0, 5).map((issue) => issue.message) },
        });
      if (!(idea.score >= 0 && idea.score <= 1))
        throw new TaviError("INVALID_INPUT", "An idea's score is between 0 and 1", { details: { key: idea.draft.key } });
      return { id: idea.id, score: idea.score, draft: draft.data };
    });
    if (new Set(drafts.map((idea) => idea.draft.key)).size !== drafts.length)
      throw new TaviError("INVALID_INPUT", "A run offers each key once");
    return this.#transaction(() => {
      const db = this.#db();
      if (input.whileSelected === true) {
        const { settings } = this.settings(input.workspaceId);
        if (!settings.enabled || settings.provider !== input.providerId) {
          throw new TaviError(
            "CONFLICT",
            settings.enabled ? `The workspace now uses the ideas provider ${settings.provider}` : "Ideas were turned off during the run",
            { details: { providerId: input.providerId, notSelected: true } },
          );
        }
        const switchedOff = (input.usedSources ?? []).filter((source) => !settings.sources[source]);
        if (switchedOff.length > 0)
          throw new TaviError("CONFLICT", `The person switched off ${switchedOff.join(", ")} during the run`, {
            details: { providerId: input.providerId, notSelected: true },
          });
        if (input.briefRead !== undefined && this.settings(input.workspaceId).brief !== input.briefRead)
          throw new TaviError("CONFLICT", "The person rewrote the ideas brief during the run", {
            details: { providerId: input.providerId, notSelected: true },
          });
      }
      this.#settle(input.workspaceId, input.now);
      const ledger = this.#ledger(input.workspaceId, input.now);
      const ruledOut = new Set([...ledger.dismissedKeys, ...ledger.snoozedKeys, ...ledger.suppressedKeys, ...ledger.recentKeys]);
      const muted = new Set<IdeaCategory>(ledger.mutedCategories);
      const excluded = new Set(ledger.excludedBasis);
      const expiresAt = shift(input.now, IDEA_TTL_MS);
      const refused: string[] = [];
      const storedIds: string[] = [];
      const inserted = new Set<string>();
      for (const { id, score, draft } of drafts) {
        if (ruledOut.has(draft.key) || muted.has(draft.category) || draft.basis.some((basis) => excluded.has(basis.ref))) {
          refused.push(draft.key);
          continue;
        }
        const content = [
          input.runId,
          input.providerId,
          draft.templateId ?? null,
          draft.category,
          draft.icon,
          draft.title,
          draft.pitch,
          draft.label,
          draft.prompt,
          JSON.stringify(draft.basis),
          JSON.stringify(draft.uses),
          draft.recurring?.cadence ?? null,
          score,
        ];
        const current = db
          .prepare(
            "SELECT idea_id, shown_runs, pinned, created_at, last_shown_at, prompt, uses_json, prepared_task_id FROM tavi_ideas WHERE workspace_id = ? AND idea_key = ? AND status = 'active'",
          )
          .get(input.workspaceId, draft.key) as
          | {
              idea_id: string;
              shown_runs: number;
              pinned: number;
              created_at: string;
              last_shown_at: string | null;
              prompt: string;
              uses_json: string;
              prepared_task_id: string | null;
            }
          | undefined;
        if (current === undefined) {
          if (db.prepare("SELECT 1 FROM tavi_ideas WHERE idea_id = ?").get(id) !== undefined)
            throw new TaviError("CONFLICT", "An idea with that id already exists", { details: { ideaId: id } });
          db.prepare(`INSERT INTO tavi_ideas (idea_id, workspace_id, idea_key, run_id, provider_id, use_case, category, icon, title, pitch, label, prompt, basis_json, uses_json, recurring_cadence, score, status, pinned, shown_runs, created_at, updated_at, expires_at, last_shown_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 1, ?, ?, ?, ?)`).run(
            id,
            input.workspaceId,
            draft.key,
            ...content,
            input.now,
            input.now,
            expiresAt,
            input.now,
          );
          storedIds.push(id);
          inserted.add(id);
        } else if (current.pinned === 0 && current.shown_runs >= IDEA_IGNORED_RUNS && this.#showsAgain(current, input.now)) {
          // Offered this often and never opened (*Ignored*): it goes, and its key rests a while.
          db.prepare("UPDATE tavi_ideas SET status = 'expired', updated_at = ? WHERE idea_id = ?").run(input.now, current.idea_id);
          this.#record({
            id: `${id}:ignored`,
            workspaceId: input.workspaceId,
            ideaId: current.idea_id,
            key: draft.key,
            category: draft.category,
            signal: "ignored",
            at: input.now,
          });
          refused.push(draft.key);
        } else {
          const shown = this.#showsAgain(current, input.now);
          // An answer prepared for other words, or other tools, is not this idea's any more: it goes. Its run
          // stays for `prune`, so the day's cap (`preparedSince`) still counts what it spent.
          if (current.prepared_task_id !== null && (current.prompt !== draft.prompt || current.uses_json !== JSON.stringify(draft.uses))) {
            db.prepare("UPDATE tavi_ideas SET prepared_task_id = NULL, prepared_text = NULL, prepared_at = NULL WHERE idea_id = ?").run(
              current.idea_id,
            );
          }
          db.prepare(`UPDATE tavi_ideas SET run_id = ?, provider_id = ?, use_case = ?, category = ?, icon = ?, title = ?, pitch = ?, label = ?, prompt = ?, basis_json = ?, uses_json = ?, recurring_cadence = ?, score = ?,
            shown_runs = shown_runs + ?, last_shown_at = ?, updated_at = ?, expires_at = ? WHERE idea_id = ?`).run(
            ...content,
            shown ? 1 : 0,
            shown ? input.now : (current.last_shown_at ?? current.created_at),
            input.now,
            expiresAt,
            current.idea_id,
          );
          storedIds.push(current.idea_id);
        }
      }
      const evicted = this.#enforceCap(input.workspaceId, input.now);
      const gone = new Set(evicted);
      // One the cap expired the moment it was stored was never seen: it is not counted as shown (auto-volume's acceptance).
      const unseen = db.prepare("UPDATE tavi_ideas SET last_shown_at = NULL, shown_runs = 0 WHERE idea_id = ?");
      for (const ideaId of evicted) if (inserted.has(ideaId)) unseen.run(ideaId);
      return {
        stored: storedIds.filter((ideaId) => !gone.has(ideaId)).map((ideaId) => this.#require(input.workspaceId, ideaId)),
        refused,
        evicted,
      };
    });
  }

  get(workspaceId: string, ideaId: string): Idea | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_ideas WHERE idea_id = ? AND workspace_id = ?").get(ideaId, workspaceId) as
      | IdeaRow
      | undefined;
    return row === undefined ? undefined : ideaOf(row);
  }

  list(input: ListIdeasInput): readonly Idea[] {
    return this.#transaction(() => {
      this.#settle(input.workspaceId, input.now);
      const rows = this.#db()
        .prepare(`SELECT * FROM tavi_ideas WHERE workspace_id = ? AND ${input.includeInactive === true ? "status <> 'expired'" : "status = 'active'"} AND (? IS NULL OR category = ?)
        ORDER BY status = 'active' DESC, pinned DESC, score DESC, created_at DESC, idea_id`)
        .all(input.workspaceId, input.category ?? null, input.category ?? null) as IdeaRow[];
      return rows.map(ideaOf);
    });
  }

  feedback(input: IdeaFeedbackInput): Idea | undefined {
    const { snoozedUntil, now, ...rest } = input;
    if (input.signal === "not-now" && (snoozedUntil === undefined || Date.parse(snoozedUntil) <= Date.parse(now))) {
      throw new TaviError("INVALID_INPUT", "A snooze runs until a time still ahead");
    }
    return this.#transaction(() => {
      const db = this.#db();
      this.#settle(input.workspaceId, now);
      const idea = input.ideaId === undefined ? undefined : this.#require(input.workspaceId, input.ideaId);
      const category = input.category ?? idea?.category;
      const refuse = (what: string): never => {
        throw new TaviError("INVALID_INPUT", `${input.signal} names ${what}`);
      };
      const setStatus = (status: Idea["status"], allowed: readonly Idea["status"][]): void => {
        const target = idea ?? refuse("its idea");
        if (!allowed.includes(target.status))
          throw new TaviError("CONFLICT", `That idea is ${target.status}`, { details: { ideaId: target.id } });
        // Tried or done, it stays a week from now: the ledger's "tried lately" holds that long, whatever its first expiry.
        // Tried, made recurring or dismissed, it is retired: unpinned, so it frees its place and expires with its week.
        db.prepare(`UPDATE tavi_ideas SET status = ?, snoozed_until = ?, pinned = CASE WHEN ? IN ('dismissed', 'tried', 'done') THEN 0 ELSE pinned END,
          expires_at = CASE WHEN ? IN ('tried', 'done') THEN MAX(expires_at, ?) ELSE expires_at END, updated_at = ? WHERE idea_id = ?`).run(
          status,
          status === "snoozed" ? (snoozedUntil ?? null) : null,
          status,
          status,
          shift(now, IDEA_TTL_MS),
          now,
          target.id,
        );
      };
      switch (input.signal) {
        case "tried":
          setStatus("tried", ["active", "tried", "snoozed"]);
          break;
        case "done":
          setStatus("done", ["active", "tried", "snoozed", "done"]);
          break;
        case "not-now":
          setStatus("snoozed", ["active", "tried", "snoozed"]);
          break;
        case "not-interested": {
          // An expired idea too: a dismissal from a stale tab must still reach the ledger.
          setStatus("dismissed", ["active", "tried", "snoozed", "done", "dismissed", "expired"]);
          const target = idea ?? refuse("its idea");
          // The key is what the ledger keeps: the idea's quoted words go, and every other row of the key ends with it.
          db.prepare("UPDATE tavi_ideas SET basis_json = ? WHERE idea_id = ?").run(
            withoutExcerpts(JSON.stringify(target.basis)),
            target.id,
          );
          db.prepare(
            "UPDATE tavi_ideas SET status = 'expired', snoozed_until = NULL, updated_at = ? WHERE workspace_id = ? AND idea_key = ? AND idea_id <> ? AND status IN ('active', 'tried', 'snoozed')",
          ).run(now, input.workspaceId, target.key, target.id);
          break;
        }
        case "mute-category":
          db.prepare(
            "UPDATE tavi_ideas SET status = 'expired', snoozed_until = NULL, updated_at = ? WHERE workspace_id = ? AND status IN ('active', 'snoozed') AND pinned = 0 AND category = ?",
          ).run(now, input.workspaceId, category ?? refuse("its section"));
          break;
        case "unmute-category":
          if (category === undefined) refuse("its section");
          break;
        case "exclude-basis": {
          const basisRef = input.basisRef ?? refuse("its basis");
          if (idea !== undefined && !idea.basis.some((basis) => basis.ref === basisRef))
            throw new TaviError("INVALID_INPUT", `Idea ${idea.id} does not rest on ${basisRef}`);
          // Pinned or not: an idea quoting what the person excluded ends, and its pin with it.
          db.prepare(
            `UPDATE tavi_ideas SET status = 'expired', snoozed_until = NULL, pinned = 0, updated_at = ? WHERE workspace_id = ? AND status IN ('active', 'snoozed', 'tried') AND ${CITES}`,
          ).run(now, input.workspaceId, basisRef);
          break;
        }
        case "include-basis":
          if (input.basisRef === undefined) refuse("its basis");
          break;
        case "edited":
          if (input.editedPrompt === undefined) refuse("what was sent");
          if (idea === undefined) refuse("its idea");
          break;
        case "more-like-this":
        case "ignored":
          if (idea === undefined) refuse("its idea");
          break;
      }
      this.#record({ ...rest, at: now, ...(idea === undefined ? {} : { key: idea.key }), ...(category === undefined ? {} : { category }) });
      return idea === undefined ? undefined : this.#require(input.workspaceId, idea.id);
    });
  }

  restore(workspaceId: string, ideaId: string, now: string): Idea {
    return this.#transaction(() => {
      this.#settle(workspaceId, now);
      const idea = this.#require(workspaceId, ideaId);
      if (idea.status !== "dismissed" && idea.status !== "snoozed")
        throw new TaviError("CONFLICT", `Only a dismissed or snoozed idea comes back; this one is ${idea.status}`, { details: { ideaId } });
      const ledger = this.#ledger(workspaceId, now);
      if (ledger.mutedCategories.includes(idea.category))
        throw new TaviError("CONFLICT", `Its section ${idea.category} is muted; unmute it first`, { details: { ideaId } });
      const excluded = idea.basis.find((basis) => ledger.excludedBasis.includes(basis.ref));
      if (excluded !== undefined)
        throw new TaviError("CONFLICT", `It rests on ${excluded.ref}, which you excluded; include it again first`, { details: { ideaId } });
      // As an ended snooze revives (`#revive`): only an idea of the provider in use comes back.
      if (idea.providerId !== this.settings(workspaceId).settings.provider)
        throw new TaviError("CONFLICT", `It came from ${idea.providerId}, which no longer writes this workspace's ideas`, {
          details: { ideaId },
        });
      const db = this.#db();
      if (
        db.prepare("SELECT 1 FROM tavi_ideas WHERE workspace_id = ? AND idea_key = ? AND status = 'active'").get(workspaceId, idea.key) !==
        undefined
      ) {
        throw new TaviError("CONFLICT", "An idea with that key is already active", { details: { ideaId } });
      }
      // The cap spares the idea coming back, so another must be able to make room: with every place pinned, none can.
      if (
        !idea.pinned &&
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM tavi_ideas WHERE workspace_id = ? AND status = 'active' AND pinned = 1")
            .get(workspaceId) as { count: number }
        ).count >= IDEA_MAX_ACTIVE
      ) {
        throw new TaviError("CONFLICT", `All ${IDEA_MAX_ACTIVE} places are pinned; unpin one first`, { details: { ideaId } });
      }
      // The key leaves the ledger whichever row put it there: its feedback, and any other dismissed row of it.
      db.prepare("DELETE FROM tavi_idea_feedback WHERE workspace_id = ? AND idea_key = ? AND signal = 'not-interested'").run(
        workspaceId,
        idea.key,
      );
      db.prepare(
        "UPDATE tavi_ideas SET status = 'expired', updated_at = ? WHERE workspace_id = ? AND idea_key = ? AND status = 'dismissed' AND idea_id <> ?",
      ).run(now, workspaceId, idea.key, ideaId);
      db.prepare(
        "UPDATE tavi_ideas SET status = 'active', snoozed_until = NULL, expires_at = MAX(expires_at, ?), updated_at = ? WHERE idea_id = ?",
      ).run(shift(now, IDEA_TTL_MS), now, ideaId);
      // The idea the person asked back is not the one the cap takes, however low its score: another unpinned one goes.
      this.#enforceCap(workspaceId, now, ideaId);
      return this.#require(workspaceId, ideaId);
    });
  }

  setPinned(workspaceId: string, ideaId: string, pinned: boolean, now: string): Idea {
    return this.#transaction(() => {
      this.#settle(workspaceId, now);
      const idea = this.#require(workspaceId, ideaId);
      if (idea.status === "expired" || idea.status === "dismissed" || (pinned && (idea.status === "tried" || idea.status === "done")))
        throw new TaviError("CONFLICT", `That idea is ${idea.status}`, { details: { ideaId } });
      const db = this.#db();
      if (pinned && !idea.pinned) {
        const count = (
          db
            .prepare("SELECT COUNT(*) AS count FROM tavi_ideas WHERE workspace_id = ? AND pinned = 1 AND status IN ('active', 'snoozed')")
            .get(workspaceId) as { count: number }
        ).count;
        if (count >= IDEA_MAX_ACTIVE) throw new TaviError("CONFLICT", `At most ${IDEA_MAX_ACTIVE} ideas can be pinned; unpin one first`);
      }
      db.prepare("UPDATE tavi_ideas SET pinned = ?, updated_at = ? WHERE idea_id = ?").run(pinned ? 1 : 0, now, ideaId);
      this.#enforceCap(workspaceId, now);
      return this.#require(workspaceId, ideaId);
    });
  }

  ledger(workspaceId: string, now: string): IdeaLedger {
    return this.#ledger(workspaceId, now);
  }

  reset(input: ResetIdeasInput): number {
    return this.#transaction(() => {
      const db = this.#db();
      this.#settle(input.workspaceId, input.now);
      const ledger = this.#ledger(input.workspaceId, input.now);
      if (input.what === "categories") {
        db.prepare("DELETE FROM tavi_idea_feedback WHERE workspace_id = ? AND signal IN ('mute-category', 'unmute-category')").run(
          input.workspaceId,
        );
        return ledger.mutedCategories.length;
      }
      // The prompts the person edited go too: a reset forgets what they told Ideas, examples included.
      db.prepare(
        "DELETE FROM tavi_idea_feedback WHERE workspace_id = ? AND signal IN ('not-interested', 'exclude-basis', 'include-basis', 'ignored', 'edited')",
      ).run(input.workspaceId);
      // A dismissal is forgotten (its idea may be offered again); a snooze ends, its idea back for a fresh week.
      db.prepare("UPDATE tavi_ideas SET status = 'expired', updated_at = ? WHERE workspace_id = ? AND status = 'dismissed'").run(
        input.now,
        input.workspaceId,
      );
      this.#revive(input.workspaceId, input.now, "");
      this.#enforceCap(input.workspaceId, input.now);
      return new Set([...ledger.dismissedKeys, ...ledger.snoozedKeys, ...ledger.suppressedKeys]).size + ledger.excludedBasis.length;
    });
  }

  retireProvider(workspaceId: string, keep: string, now: string): number {
    return this.#db()
      .prepare(
        "UPDATE tavi_ideas SET status = 'expired', snoozed_until = NULL, updated_at = ? WHERE workspace_id = ? AND status IN ('active', 'snoozed') AND pinned = 0 AND provider_id <> ?",
      )
      .run(now, workspaceId, keep).changes;
  }

  unquote(input: {
    readonly workspaceId: string;
    readonly ref?: string;
    readonly kind?: "memory" | "task" | "brief";
    readonly now: string;
  }): number {
    if ((input.ref === undefined) === (input.kind === undefined))
      throw new TaviError("INVALID_INPUT", "unquote names one source by ref, or a kind");
    return this.#transaction(() => {
      const db = this.#db();
      const cites =
        input.ref !== undefined
          ? { sql: CITES, arg: input.ref }
          : {
              sql: "EXISTS (SELECT 1 FROM json_each(tavi_ideas.basis_json) WHERE json_extract(json_each.value, '$.kind') = ?)",
              arg: input.kind,
            };
      // The prepared answers of the ideas quoting it are no longer offered; their runs, which read only a
      // general prompt, stay for `prune`, so the day's cap still counts them.
      db.prepare(
        `UPDATE tavi_ideas SET prepared_task_id = NULL, prepared_text = NULL, prepared_at = NULL WHERE workspace_id = ? AND ${cites.sql}`,
      ).run(input.workspaceId, cites.arg);
      db.prepare(
        `UPDATE tavi_ideas SET status = 'expired', snoozed_until = NULL, updated_at = ? WHERE workspace_id = ? AND status IN ('active', 'snoozed') AND pinned = 0 AND ${cites.sql}`,
      ).run(input.now, input.workspaceId, cites.arg);
      // What is left (pinned, tried, done, dismissed) keeps the citation, not the words.
      const rows = db
        .prepare(`SELECT idea_id, basis_json FROM tavi_ideas WHERE workspace_id = ? AND ${cites.sql}`)
        .all(input.workspaceId, cites.arg) as { idea_id: string; basis_json: string }[];
      const strip = db.prepare("UPDATE tavi_ideas SET basis_json = ?, updated_at = ? WHERE idea_id = ?");
      for (const row of rows) {
        const basis = (JSON.parse(row.basis_json) as { kind: string; ref: string; excerpt?: string }[]).map((entry) =>
          (input.ref !== undefined ? entry.ref === input.ref : entry.kind === input.kind) ? { kind: entry.kind, ref: entry.ref } : entry,
        );
        strip.run(JSON.stringify(basis), input.now, row.idea_id);
      }
      // Each idea touched counts once: those it ended are among those it stripped.
      return rows.length;
    });
  }

  forgetBasis(ref: string): number {
    // Its statements stand or fall together: an edited example must not outlive the ideas that go with it.
    return this.#transaction(() => deleteIdeasCiting(this.#db(), ref));
  }

  prune(before: string, now?: string): number {
    return this.#transaction(() => {
      const db = this.#db();
      const ideas = db.prepare("DELETE FROM tavi_ideas WHERE status = 'expired' AND updated_at < ?").run(before).changes;
      // A prepared step's run, a finished one no idea still offers: its turn (the pages it read) goes after a day.
      // Read after the ideas above go, so the run of one deleted in this pass goes in it too.
      const stale = now === undefined ? before : shift(now, -IDEA_PREPARED_FRESH_MS);
      const preparedRuns = (
        db
          .prepare(`SELECT task_id FROM tavi_tasks WHERE origin IS 'ideas' AND status IN ('completed', 'failed', 'stopped', 'cancelled') AND created_at < ?
        AND task_id NOT IN (SELECT prepared_task_id FROM tavi_ideas WHERE prepared_task_id IS NOT NULL)`)
          .all(stale) as { task_id: string }[]
      ).map((row) => row.task_id);
      purgePlumbingTasks(db, preparedRuns);
      const runs = db.prepare("DELETE FROM tavi_idea_runs WHERE outcome <> 'running' AND started_at < ?").run(before).changes;
      // The ledger's own rows stay until the person resets them; what only tuned ranking, or a snooze long over, ages out.
      const feedback = db
        .prepare(
          "DELETE FROM tavi_idea_feedback WHERE signal IN ('tried', 'done', 'edited', 'more-like-this', 'ignored', 'not-now') AND at < ?",
        )
        .run(before).changes;
      // A mute later taken back, or an exclusion later included again, says nothing any more: the pair goes once old.
      const settled = (column: "category" | "basis_ref", on: string, off: string): number =>
        db
          .prepare(`DELETE FROM tavi_idea_feedback WHERE signal IN (?, ?) AND at < ? AND (workspace_id, ${column}) IN (
          SELECT latest.workspace_id, latest.${column} FROM tavi_idea_feedback AS latest WHERE latest.signal IN (?, ?)
          AND latest.rowid = (SELECT newer.rowid FROM tavi_idea_feedback AS newer WHERE newer.workspace_id = latest.workspace_id AND newer.${column} = latest.${column} AND newer.signal IN (?, ?)
            ORDER BY newer.at DESC, newer.rowid DESC LIMIT 1)
          AND latest.signal = ?)`)
          .run(on, off, before, on, off, on, off, off).changes;
      return (
        ideas +
        runs +
        feedback +
        settled("category", "mute-category", "unmute-category") +
        settled("basis_ref", "exclude-basis", "include-basis")
      );
    });
  }

  startRun(input: StartIdeaRunInput): IdeaRun {
    return this.#transaction(() => {
      const db = this.#db();
      if (input.trigger === "refresh" && input.refreshesPerHour !== undefined) {
        const asked = this.refreshesSince(input.workspaceId, shift(input.now, -60 * 60_000));
        if (asked >= input.refreshesPerHour)
          throw new TaviError(
            "QUOTA_EXCEEDED",
            `Ideas were refreshed ${asked} times in the last hour; at most ${input.refreshesPerHour} are allowed`,
          );
      }
      const running = db
        .prepare("SELECT run_id, started_at FROM tavi_idea_runs WHERE workspace_id = ? AND outcome = 'running'")
        .all(input.workspaceId) as { run_id: string; started_at: string }[];
      for (const run of running) {
        if (Date.parse(input.now) - Date.parse(run.started_at) < IDEA_RUN_STALE_MS)
          throw new TaviError("CONFLICT", "Ideas are already being looked for", { details: { runId: run.run_id } });
        db.prepare(
          "UPDATE tavi_idea_runs SET outcome = 'failed', reason = 'The owner stopped before this run finished', finished_at = ? WHERE run_id = ?",
        ).run(input.now, run.run_id);
      }
      db.prepare(
        "INSERT INTO tavi_idea_runs (run_id, workspace_id, provider_id, trigger, started_at, outcome) VALUES (?, ?, ?, ?, ?, 'running')",
      ).run(input.runId, input.workspaceId, input.providerId ?? null, input.trigger, input.now);
      return this.#run(input.runId);
    });
  }

  finishRun(input: FinishIdeaRunInput): IdeaRun {
    const counts = [input.generated, input.dropped, input.tokens].filter((count) => count !== undefined);
    if (counts.some((count) => !Number.isInteger(count) || count < 0) || (input.usd !== undefined && !(input.usd >= 0))) {
      throw new TaviError("INVALID_INPUT", "A run's counts and cost are non-negative", { details: { runId: input.runId } });
    }
    if ((input.reason?.length ?? 0) > IDEA_RUN_REASON_MAX || (input.inputsHash?.length ?? 0) > IDEA_RUN_HASH_MAX) {
      throw new TaviError(
        "INVALID_INPUT",
        `A run's reason is at most ${IDEA_RUN_REASON_MAX} characters and its inputs hash at most ${IDEA_RUN_HASH_MAX}`,
        { details: { runId: input.runId } },
      );
    }
    return this.#transaction(() => {
      const current = this.#run(input.runId);
      if (current.outcome !== "running")
        throw new TaviError("CONFLICT", "That idea run has already finished", {
          details: { runId: input.runId, outcome: current.outcome },
        });
      this.#db()
        .prepare(
          "UPDATE tavi_idea_runs SET finished_at = ?, outcome = ?, reason = ?, inputs_hash = ?, generated = ?, dropped = ?, tokens = ?, usd = ? WHERE run_id = ?",
        )
        .run(
          input.now,
          input.outcome,
          input.reason ?? null,
          input.inputsHash ?? null,
          input.generated ?? 0,
          input.dropped ?? 0,
          input.tokens ?? 0,
          input.usd ?? 0,
          input.runId,
        );
      return this.#run(input.runId);
    });
  }

  lastRun(workspaceId: string, trigger?: IdeaRun["trigger"]): IdeaRun | undefined {
    const row = this.#db()
      .prepare(
        "SELECT * FROM tavi_idea_runs WHERE workspace_id = ? AND (? IS NULL OR trigger = ?) ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(workspaceId, trigger ?? null, trigger ?? null) as RunRow | undefined;
    return row === undefined ? undefined : runOf(row);
  }

  lastInputsHash(workspaceId: string): string | undefined {
    const row = this.#db()
      .prepare(
        "SELECT inputs_hash FROM tavi_idea_runs WHERE workspace_id = ? AND outcome IN ('generated', 'unchanged') AND inputs_hash IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(workspaceId) as { inputs_hash: string } | undefined;
    return row?.inputs_hash;
  }

  generatedSince(workspaceId: string, since: string): boolean {
    return (
      this.#db()
        .prepare(
          "SELECT 1 FROM tavi_idea_runs WHERE workspace_id = ? AND trigger = 'schedule' AND outcome = 'generated' AND started_at >= ? LIMIT 1",
        )
        .get(workspaceId, since) !== undefined
    );
  }

  keepOffered(workspaceId: string, now: string): number {
    return this.#transaction(() => {
      this.#settle(workspaceId, now);
      return this.#db()
        .prepare("UPDATE tavi_ideas SET expires_at = MAX(expires_at, ?) WHERE workspace_id = ? AND status = 'active'")
        .run(shift(now, IDEA_TTL_MS), workspaceId).changes;
    });
  }

  seedChat(input: SeedIdeaChatInput): Idea {
    return this.#transaction(() => {
      const idea = this.#require(input.workspaceId, input.ideaId);
      this.#db()
        .prepare("UPDATE tavi_ideas SET seeded_task_id = ?, updated_at = ? WHERE idea_id = ?")
        .run(input.taskId, input.now, idea.id);
      // What the person changed before sending is how they like to ask: kept as an example for the next run.
      const sent = input.sent.trim();
      if (sent !== "" && sent !== idea.prompt.trim()) {
        // Keyed by the chat it was sent in, so forgetting that chat takes its words, whichever chat the idea names now.
        this.#record({
          id: input.id,
          workspaceId: input.workspaceId,
          ideaId: idea.id,
          key: idea.key,
          category: idea.category,
          basisRef: input.taskId,
          signal: "edited",
          editedPrompt: sent.slice(0, IDEA_PROMPT_MAX * 2),
          at: input.now,
        });
      }
      return this.#require(input.workspaceId, idea.id);
    });
  }

  chatFinished(taskId: string, id: string, now: string): Idea | undefined {
    const row = this.#db()
      .prepare(
        "SELECT workspace_id, idea_id FROM tavi_ideas WHERE seeded_task_id = ? AND status IN ('active', 'tried', 'snoozed') ORDER BY updated_at DESC LIMIT 1",
      )
      .get(taskId) as { workspace_id: string; idea_id: string } | undefined;
    if (row === undefined) return undefined;
    return this.feedback({ id, workspaceId: row.workspace_id, ideaId: row.idea_id, signal: "done", now });
  }

  prepared(input: {
    readonly workspaceId: string;
    readonly ideaId: string;
    readonly taskId: string;
    readonly text: string;
    readonly ranFor?: { readonly prompt: string; readonly uses: Idea["uses"] };
    readonly now: string;
  }): Idea | undefined {
    return this.#transaction(() => {
      const row = this.#db()
        .prepare("SELECT idea_id, prompt, uses_json FROM tavi_ideas WHERE workspace_id = ? AND idea_id = ? AND status = 'active'")
        .get(input.workspaceId, input.ideaId) as { idea_id: string; prompt: string; uses_json: string } | undefined;
      // Gone or no longer offered meanwhile: nothing to show it with (what it spent is counted from its run).
      if (row === undefined) return undefined;
      // Rewritten by a run while the step ran: an answer for other words, or other tools, is not this idea's (as `store` drops one).
      if (input.ranFor !== undefined && (row.prompt !== input.ranFor.prompt || row.uses_json !== JSON.stringify(input.ranFor.uses)))
        return undefined;
      const text = input.text.trim().slice(0, IDEA_PREPARED_TEXT_MAX);
      if (text === "") return undefined;
      this.#db()
        .prepare("UPDATE tavi_ideas SET prepared_task_id = ?, prepared_text = ?, prepared_at = ?, updated_at = ? WHERE idea_id = ?")
        .run(input.taskId, text, input.now, input.now, row.idea_id);
      return this.#require(input.workspaceId, row.idea_id);
    });
  }

  preparedSince(workspaceId: string, since: string): { readonly count: number; readonly tokens: number } {
    // Counted from the prepared runs themselves, kept or not: a run whose idea went still spent its share.
    const row = this.#db()
      .prepare(`SELECT COUNT(*) AS count FROM tavi_tasks WHERE workspace_id = ? AND origin IS 'ideas' AND created_at >= ?`)
      .get(workspaceId, since) as { count: number };
    const tokens = this.#db()
      .prepare(`SELECT COALESCE(SUM(COALESCE(json_extract(data, '$.usage.totalTokens'), COALESCE(json_extract(data, '$.usage.inputTokens'), 0) + COALESCE(json_extract(data, '$.usage.outputTokens'), 0))), 0) AS tokens FROM tavi_provider_attempts
      WHERE run_id IN (SELECT task_id FROM tavi_tasks WHERE workspace_id = ? AND origin IS 'ideas' AND created_at >= ?)`)
      .get(workspaceId, since) as { tokens: number };
    return { count: row.count, tokens: tokens.tokens };
  }

  acceptance(workspaceId: string, since: string): { readonly shown: number; readonly tried: number } {
    const db = this.#db();
    const shown = (
      db.prepare("SELECT COUNT(*) AS count FROM tavi_ideas WHERE workspace_id = ? AND last_shown_at >= ?").get(workspaceId, since) as {
        count: number;
      }
    ).count;
    // Taken up: tried, or done without a *Try it* (a routine made from it).
    const tried = (
      db
        .prepare(
          "SELECT COUNT(DISTINCT idea_id) AS count FROM tavi_idea_feedback WHERE workspace_id = ? AND signal IN ('tried', 'done') AND at >= ?",
        )
        .get(workspaceId, since) as { count: number }
    ).count;
    return { shown, tried };
  }

  excludedSources(workspaceId: string, now: string): readonly { readonly ref: string; readonly kind?: IdeaBasisKind }[] {
    const db = this.#db();
    const kindOf = db.prepare(`SELECT json_extract(cited.value, '$.kind') AS kind FROM tavi_idea_feedback AS feedback
      JOIN tavi_ideas AS idea ON idea.idea_id = feedback.idea_id AND idea.workspace_id = feedback.workspace_id, json_each(idea.basis_json) AS cited
      WHERE feedback.workspace_id = ? AND feedback.signal = 'exclude-basis' AND feedback.basis_ref = ? AND json_extract(cited.value, '$.ref') = ?
      ORDER BY feedback.at DESC, feedback.rowid DESC LIMIT 1`);
    return this.#ledger(workspaceId, now).excludedBasis.map((ref) => {
      const kind = ref === "brief" ? "brief" : (kindOf.get(workspaceId, ref, ref) as { kind: unknown } | undefined)?.kind;
      return IDEA_BASIS_KINDS.includes(kind as IdeaBasisKind) ? { ref, kind: kind as IdeaBasisKind } : { ref };
    });
  }

  refreshesSince(workspaceId: string, since: string): number {
    return (
      this.#db()
        .prepare("SELECT COUNT(*) AS count FROM tavi_idea_runs WHERE workspace_id = ? AND trigger = 'refresh' AND started_at >= ?")
        .get(workspaceId, since) as { count: number }
    ).count;
  }

  spentSince(workspaceId: string, since: string): { readonly tokens: number; readonly usd: number } {
    const row = this.#db()
      .prepare(
        "SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(usd), 0) AS usd FROM tavi_idea_runs WHERE workspace_id = ? AND started_at >= ?",
      )
      .get(workspaceId, since) as { tokens: number; usd: number };
    return { tokens: row.tokens, usd: row.usd };
  }

  settings(workspaceId: string): IdeaSettingsRecord {
    const row = this.#db()
      .prepare("SELECT settings_json, brief, updated_at FROM tavi_idea_settings WHERE workspace_id = ?")
      .get(workspaceId) as SettingsRow | undefined;
    if (row === undefined) return { settings: IDEA_DEFAULT_SETTINGS, brief: "" };
    const settings = IdeaSettingsSchema.safeParse(JSON.parse(row.settings_json));
    if (!settings.success) throw new TaviError("INTERNAL", "A workspace's idea settings are unreadable", { details: { workspaceId } });
    return { settings: settings.data, brief: row.brief, updatedAt: row.updated_at };
  }

  saveSettings(input: SaveIdeaSettingsInput): IdeaSettingsRecord {
    if (input.brief !== undefined && input.brief.length > IDEA_BRIEF_MAX)
      throw new TaviError("INVALID_INPUT", `The ideas brief is at most ${IDEA_BRIEF_MAX} characters`);
    if (input.settings !== undefined && (input.patch !== undefined || input.clear !== undefined))
      throw new TaviError("INVALID_INPUT", "Idea settings are saved whole or patched, not both");
    const parsed = (value: unknown) => {
      const result = IdeaSettingsSchema.safeParse(value);
      if (!result.success)
        throw new TaviError("INVALID_INPUT", "Idea settings are outside their bounds", {
          details: { issues: result.error.issues.slice(0, 5).map((issue) => issue.message) },
        });
      return result.data;
    };
    const whole = input.settings === undefined ? undefined : parsed(input.settings);
    return this.#transaction(() => {
      const current = this.settings(input.workspaceId);
      // A patch is merged into what is saved now, in this transaction: no writer works from a copy read earlier.
      const patched =
        input.patch === undefined && input.clear === undefined
          ? undefined
          : (() => {
              const { sources, ...rest } = input.patch ?? {};
              const merged: Record<string, unknown> = {
                ...current.settings,
                ...rest,
                sources: { ...current.settings.sources, ...sources },
              };
              for (const field of input.clear ?? []) delete merged[field];
              return parsed(merged);
            })();
      const next = { settings: whole ?? patched ?? current.settings, brief: input.brief ?? current.brief };
      this.#db()
        .prepare(`INSERT INTO tavi_idea_settings (workspace_id, settings_json, brief, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET settings_json = excluded.settings_json, brief = excluded.brief, updated_at = excluded.updated_at`)
        .run(input.workspaceId, JSON.stringify(next.settings), next.brief, input.now);
      return { ...next, updatedAt: input.now };
    });
  }

  /**
   * Time's effects: a snooze that ran out ends with a fresh lifetime (a week's
   * *Not now* outlasts the week the idea had) — expired instead when its key
   * was offered and is active again meanwhile — and an unpinned active or
   * tried idea past its expiry expires. An ended snooze may push past the
   * cap, which is kept.
   */
  #settle(workspaceId: string, now: string): void {
    const db = this.#db();
    const ended = this.#revive(workspaceId, now, "AND snoozed_until <= ?", now);
    // A prepared answer a day old is stale: it is not offered with *Try it* again.
    db.prepare(
      "UPDATE tavi_ideas SET prepared_task_id = NULL, prepared_text = NULL, prepared_at = NULL WHERE workspace_id = ? AND prepared_at <= ?",
    ).run(workspaceId, shift(now, -IDEA_PREPARED_FRESH_MS));
    // A done idea goes too once its week is up: what it quoted is not kept as history.
    db.prepare(
      "UPDATE tavi_ideas SET status = 'expired', pinned = 0, updated_at = ? WHERE workspace_id = ? AND (status IN ('tried', 'done') OR (status = 'active' AND pinned = 0)) AND expires_at <= ?",
    ).run(now, workspaceId, now);
    if (ended > 0) this.#enforceCap(workspaceId, now);
  }

  /**
   * End the snoozes `where` picks: each idea comes back active for a fresh
   * lifetime, one per key — the best scored, and none when its key is active
   * already — and the rest expire, so the one-active-row-per-key index holds.
   * How many came back.
   */
  #revive(workspaceId: string, now: string, where: string, ...args: unknown[]): number {
    const db = this.#db();
    const snoozed = db
      .prepare(
        `SELECT idea_id, idea_key, category, basis_json, provider_id, pinned FROM tavi_ideas WHERE workspace_id = ? AND status = 'snoozed' ${where} ORDER BY score DESC, updated_at DESC, idea_id`,
      )
      .all(workspaceId, ...args) as {
      idea_id: string;
      idea_key: string;
      category: string;
      basis_json: string;
      provider_id: string;
      pinned: number;
    }[];
    if (snoozed.length === 0) return 0;
    // What the person said since the snooze began still holds: a dismissed key, a muted section, an excluded source, another provider.
    const ledger = this.#ledger(workspaceId, now);
    const dismissed = new Set(ledger.dismissedKeys);
    const muted = new Set<string>(ledger.mutedCategories);
    const excluded = new Set(ledger.excludedBasis);
    const provider = this.settings(workspaceId).settings.provider;
    // A pinned idea is ended only by its own dismissal, as mute and a provider switch leave pins alone; an exclusion already ended it.
    const ruledOut = (row: (typeof snoozed)[number]): boolean =>
      dismissed.has(row.idea_key) ||
      (row.pinned === 0 &&
        (muted.has(row.category) ||
          row.provider_id !== provider ||
          (JSON.parse(row.basis_json) as { ref: string }[]).some((basis) => excluded.has(basis.ref))));
    const active = new Set(
      (
        db.prepare("SELECT idea_key FROM tavi_ideas WHERE workspace_id = ? AND status = 'active'").all(workspaceId) as {
          idea_key: string;
        }[]
      ).map((row) => row.idea_key),
    );
    const back = db.prepare(
      "UPDATE tavi_ideas SET status = 'active', snoozed_until = NULL, expires_at = MAX(expires_at, ?), updated_at = ? WHERE idea_id = ?",
    );
    const gone = db.prepare("UPDATE tavi_ideas SET status = 'expired', snoozed_until = NULL, updated_at = ? WHERE idea_id = ?");
    let revived = 0;
    for (const row of snoozed) {
      if (active.has(row.idea_key) || ruledOut(row)) {
        gone.run(now, row.idea_id);
        continue;
      }
      active.add(row.idea_key);
      back.run(shift(now, IDEA_TTL_MS), now, row.idea_id);
      revived += 1;
    }
    return revived;
  }

  /**
   * Whether offering an idea again counts as one more showing: at most once
   * per `IDEA_SHOWN_EVERY_MS` since it was last counted, so the refreshes a
   * person asks for in an hour never make an idea look ignored, however old
   * the idea is.
   */
  #showsAgain(row: { readonly created_at: string; readonly last_shown_at: string | null }, now: string): boolean {
    return Date.parse(now) - Date.parse(row.last_shown_at ?? row.created_at) >= IDEA_SHOWN_EVERY_MS;
  }

  /**
   * Expire the lowest-scored unpinned active ideas past `IDEA_MAX_ACTIVE`; the
   * ids expired. `keep`, when given, still counts toward the cap but is never
   * the one expired.
   */
  #enforceCap(workspaceId: string, now: string, keep?: string): string[] {
    const db = this.#db();
    const unpinned = db
      .prepare(
        "SELECT idea_id FROM tavi_ideas WHERE workspace_id = ? AND status = 'active' AND pinned = 0 ORDER BY score ASC, updated_at ASC, idea_id",
      )
      .all(workspaceId) as { idea_id: string }[];
    const pinned = (
      db
        .prepare("SELECT COUNT(*) AS count FROM tavi_ideas WHERE workspace_id = ? AND status = 'active' AND pinned = 1")
        .get(workspaceId) as { count: number }
    ).count;
    const over = Math.max(0, unpinned.length + pinned - IDEA_MAX_ACTIVE);
    const evicted = unpinned
      .filter((row) => row.idea_id !== keep)
      .slice(0, over)
      .map((row) => row.idea_id);
    const expire = db.prepare("UPDATE tavi_ideas SET status = 'expired', updated_at = ? WHERE idea_id = ?");
    for (const ideaId of evicted) expire.run(now, ideaId);
    return evicted;
  }

  #record(feedback: Omit<IdeaFeedbackInput, "snoozedUntil" | "now"> & { readonly key?: string; readonly at: string }): void {
    const row = IdeaFeedbackSchema.parse(feedback);
    this.#db()
      .prepare(
        "INSERT INTO tavi_idea_feedback (feedback_id, workspace_id, idea_id, idea_key, category, basis_ref, signal, edited_prompt, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.workspaceId,
        row.ideaId ?? null,
        row.key ?? null,
        row.category ?? null,
        row.basisRef ?? null,
        row.signal,
        row.editedPrompt ?? null,
        row.at,
      );
  }

  #ledger(workspaceId: string, now: string): IdeaLedger {
    const db = this.#db();
    const keys = (sql: string, ...args: unknown[]): string[] =>
      (db.prepare(sql).all(...args) as { idea_key: string }[]).map((row) => row.idea_key);
    const dismissedKeys = keys(
      `SELECT idea_key FROM tavi_idea_feedback WHERE workspace_id = ? AND signal = 'not-interested' AND idea_key IS NOT NULL
      UNION SELECT idea_key FROM tavi_ideas WHERE workspace_id = ? AND status = 'dismissed' ORDER BY idea_key`,
      workspaceId,
      workspaceId,
    );
    const snoozedKeys = keys(
      "SELECT DISTINCT idea_key FROM tavi_ideas WHERE workspace_id = ? AND status = 'snoozed' AND snoozed_until > ? ORDER BY idea_key",
      workspaceId,
      now,
    );
    const suppressedKeys = keys(
      "SELECT DISTINCT idea_key FROM tavi_idea_feedback WHERE workspace_id = ? AND signal = 'ignored' AND idea_key IS NOT NULL AND at > ? ORDER BY idea_key",
      workspaceId,
      shift(now, -IDEA_IGNORED_SUPPRESS_MS),
    );
    const recentKeys = keys(
      "SELECT DISTINCT idea_key FROM tavi_ideas WHERE workspace_id = ? AND status IN ('tried', 'done') AND updated_at > ? ORDER BY idea_key",
      workspaceId,
      shift(now, -IDEA_TTL_MS),
    );
    const said = (column: "category" | "basis_ref", on: string, off: string): string[] =>
      lastSaid(
        db
          .prepare(
            `SELECT ${column} AS subject, signal = ? AS "on" FROM tavi_idea_feedback WHERE workspace_id = ? AND signal IN (?, ?) ORDER BY at, rowid`,
          )
          .all(on, workspaceId, on, off) as { subject: string; on: number }[],
      );
    const boosts = db
      .prepare(
        "SELECT idea_key, category FROM tavi_idea_feedback WHERE workspace_id = ? AND signal = 'more-like-this' ORDER BY at DESC, rowid DESC LIMIT 20",
      )
      .all(workspaceId) as { idea_key: string | null; category: string | null }[];
    // Taken up, by section: tried +1, edited +0.5, done +2, over the window — each idea once a signal, so
    // trying the same idea again (a second click, the terminal, a digest pick) does not weigh its section twice.
    const weights: Readonly<Record<string, number>> = { tried: 1, edited: 0.5, done: 2 };
    const categoryPriors: Partial<Record<IdeaCategory, number>> = {};
    for (const row of db
      .prepare(
        "SELECT category, signal, COUNT(DISTINCT COALESCE(idea_id, rowid)) AS count FROM tavi_idea_feedback WHERE workspace_id = ? AND signal IN ('tried', 'edited', 'done') AND category IS NOT NULL AND at > ? GROUP BY category, signal",
      )
      .all(workspaceId, shift(now, -IDEA_PRIOR_WINDOW_MS)) as { category: IdeaCategory; signal: string; count: number }[]) {
      categoryPriors[row.category] = (categoryPriors[row.category] ?? 0) + (weights[row.signal] ?? 0) * row.count;
    }
    const excludedBasis = said("basis_ref", "exclude-basis", "include-basis");
    // A chat set aside is not quoted through what the person typed there either: its examples wait until it is included again.
    const examples = (
      db
        .prepare(`SELECT edited_prompt FROM tavi_idea_feedback WHERE workspace_id = ? AND signal = 'edited' AND edited_prompt IS NOT NULL
      AND (basis_ref IS NULL OR basis_ref NOT IN (SELECT value FROM json_each(?))) ORDER BY at DESC, rowid DESC LIMIT 5`)
        .all(workspaceId, JSON.stringify(excludedBasis)) as { edited_prompt: string }[]
    ).map((row) => row.edited_prompt);
    return {
      dismissedKeys,
      snoozedKeys,
      suppressedKeys,
      recentKeys,
      mutedCategories: IdeaCategorySchema.array().parse(said("category", "mute-category", "unmute-category")),
      excludedBasis,
      boostedKeys: [...new Set(boosts.flatMap((row) => (row.idea_key === null ? [] : [row.idea_key])))],
      boostedCategories: IdeaCategorySchema.array().parse([
        ...new Set(boosts.flatMap((row) => (row.category === null ? [] : [row.category]))),
      ]),
      examples,
      categoryPriors,
    };
  }

  #require(workspaceId: string, ideaId: string): Idea {
    const idea = this.get(workspaceId, ideaId);
    if (idea === undefined) throw new TaviError("NOT_FOUND", `Idea ${ideaId} does not exist`, { details: { ideaId } });
    return idea;
  }

  #run(runId: string): IdeaRun {
    const row = this.#db().prepare("SELECT * FROM tavi_idea_runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    if (row === undefined) throw new TaviError("NOT_FOUND", "No such idea run", { details: { runId } });
    return runOf(row);
  }
}
