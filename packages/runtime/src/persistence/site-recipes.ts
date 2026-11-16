import { SITE_RECIPES_MAX, SITE_RECIPE_MAX_STEPS, TaviError, type SiteRecipe, type SiteRecipeStep } from "@tavi/contracts";

import type { SiteRecipeRepositoryPort } from "./internal-contracts.js";
import type { Database } from "./sqlite-loader.js";

interface RecipeRow {
  readonly workspace_id: string;
  readonly host: string;
  readonly steps_json: string;
  readonly results: number;
  readonly uses: number;
  readonly updated_at: string;
  readonly replay: number;
}

function toRecipe(row: RecipeRow): SiteRecipe {
  let steps: SiteRecipeStep[];
  try {
    steps = JSON.parse(row.steps_json) as SiteRecipeStep[];
  } catch {
    throw new TaviError("INTERNAL", `The recipe for ${row.host} is unreadable`);
  }
  return {
    workspaceId: row.workspace_id,
    host: row.host,
    steps,
    results: row.results,
    uses: row.uses,
    updatedAt: row.updated_at,
    ...(row.replay === 1 ? { replay: true } : {}),
  };
}

/** Site recipes: one per workspace and site. */
export class SqliteSiteRecipeRepository implements SiteRecipeRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  put(input: {
    readonly workspaceId: string;
    readonly host: string;
    readonly steps: readonly SiteRecipeStep[];
    readonly results: number;
    readonly updatedAt: string;
  }): SiteRecipe {
    const steps = input.steps.slice(-SITE_RECIPE_MAX_STEPS);
    this.#db()
      .prepare(`INSERT INTO tavi_site_recipes (workspace_id, host, steps_json, results, uses, updated_at) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT (workspace_id, host) DO UPDATE SET steps_json = excluded.steps_json, results = excluded.results, uses = uses + 1, updated_at = excluded.updated_at`)
      .run(input.workspaceId, input.host, JSON.stringify(steps), Math.max(0, Math.trunc(input.results)), input.updatedAt);
    // Bounded per workspace: the sites used longest ago go first.
    this.#db()
      .prepare(`DELETE FROM tavi_site_recipes WHERE workspace_id = ? AND host NOT IN (
        SELECT host FROM tavi_site_recipes WHERE workspace_id = ? ORDER BY updated_at DESC, host LIMIT ?)`)
      .run(input.workspaceId, input.workspaceId, SITE_RECIPES_MAX);
    const stored = this.get(input.workspaceId, input.host);
    if (stored === undefined) throw new TaviError("INTERNAL", `The recipe for ${input.host} was not kept`);
    return stored;
  }

  get(workspaceId: string, host: string): SiteRecipe | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_site_recipes WHERE workspace_id = ? AND host = ?").get(workspaceId, host) as
      | RecipeRow
      | undefined;
    return row === undefined ? undefined : toRecipe(row);
  }

  list(workspaceId: string): readonly SiteRecipe[] {
    return (
      this.#db()
        .prepare("SELECT * FROM tavi_site_recipes WHERE workspace_id = ? ORDER BY updated_at DESC, host LIMIT ?")
        .all(workspaceId, SITE_RECIPES_MAX) as RecipeRow[]
    ).map(toRecipe);
  }

  setReplay(workspaceId: string, host: string, replay: boolean): number {
    return this.#db()
      .prepare("UPDATE tavi_site_recipes SET replay = ? WHERE workspace_id = ? AND host = ?")
      .run(replay ? 1 : 0, workspaceId, host).changes;
  }

  remove(workspaceId: string, host?: string): number {
    return host === undefined
      ? this.#db().prepare("DELETE FROM tavi_site_recipes WHERE workspace_id = ?").run(workspaceId).changes
      : this.#db().prepare("DELETE FROM tavi_site_recipes WHERE workspace_id = ? AND host = ?").run(workspaceId, host).changes;
  }
}
