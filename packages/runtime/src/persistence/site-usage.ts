import type { SiteUsage, SiteUsageCounter } from "@tavi/contracts";

import type { SiteUsageRepositoryPort } from "./internal-contracts.js";
import type { Database } from "./sqlite-loader.js";

interface UsageRow {
  readonly pages: number;
  readonly final_steps: number;
}

const COLUMN: Readonly<Record<SiteUsageCounter, "pages" | "final_steps">> = { pages: "pages", finalSteps: "final_steps" };

/** Site usage: each site profile's pages and final steps per workspace and UTC day. */
export class SqliteSiteUsageRepository implements SiteUsageRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  take(input: {
    readonly workspaceId: string;
    readonly profile: string;
    readonly day: string;
    readonly counter: SiteUsageCounter;
    readonly limit: number;
  }): { readonly ok: boolean; readonly usage: SiteUsage } {
    const column = COLUMN[input.counter];
    // One statement: the count only rises while it is under the limit, however many calls race.
    const changed = this.#db()
      .prepare(`INSERT INTO tavi_site_usage (workspace_id, profile, day, ${column}) SELECT ?, ?, ?, 1 WHERE ? > 0
        ON CONFLICT (workspace_id, profile, day) DO UPDATE SET ${column} = ${column} + 1 WHERE ${column} < ?`)
      .run(input.workspaceId, input.profile, input.day, input.limit, input.limit);
    return { ok: Number(changed.changes) > 0, usage: this.get(input.workspaceId, input.profile, input.day) };
  }

  get(workspaceId: string, profile: string, day: string): SiteUsage {
    const row = this.#db()
      .prepare("SELECT pages, final_steps FROM tavi_site_usage WHERE workspace_id = ? AND profile = ? AND day = ?")
      .get(workspaceId, profile, day) as UsageRow | undefined;
    return { pages: row?.pages ?? 0, finalSteps: row?.final_steps ?? 0 };
  }

  prune(before: string): number {
    return Number(this.#db().prepare("DELETE FROM tavi_site_usage WHERE day < ?").run(before).changes);
  }
}
