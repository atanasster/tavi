import type { ProjectRepositoryPort } from "../internal-contracts.js";
import {
  TaviError,
  CollectorSettingsSchema,
  type CollectorSettings,
  type Project,
  type ProjectRecord,
  ProjectRecordSchema,
  ProjectSchema,
} from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { assertWritable, parseJsonColumn, parseStoredRow, partitionReadable } from "./stored-values.js";

/**
 * The project registry.
 *
 * `create` refuses a duplicate id rather than upserting — an operator adding a
 * project that already exists has probably mistyped it, and silently replacing
 * one would change which accounts the next brief reads. `update` is the
 * deliberate path for changing one.
 */
export class SqliteProjectRepository implements ProjectRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  create(input: {
    readonly workspaceId: string;
    readonly project: Project;
    readonly enabled: boolean;
    readonly now: string;
  }): ProjectRecord {
    const existing = this.#store.handle
      .prepare("SELECT project_id FROM tavi_projects WHERE workspace_id = ? AND project_id = ?")
      .get(input.workspaceId, input.project.id) as { readonly project_id: string } | undefined;
    if (existing !== undefined) {
      throw new TaviError("CONFLICT", `Project ${input.project.id} already exists in this workspace`, {
        details: { projectId: input.project.id },
      });
    }
    // Before the INSERT, not after the read-back: a rejected write must leave no
    // row behind.
    const project = assertWritable(ProjectSchema, input.project, `Project ${input.project.id}`);
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_projects
           (workspace_id, project_id, name, ga4_property_id, gsc_site_url, gcp_billing_project_id, gcp_billing_table,
            stripe_credential_ref, keywords_json, language, region, enabled, created_at, updated_at)
         VALUES (@workspaceId, @projectId, @name, @ga4PropertyId, @gscSiteUrl, @gcpBillingProjectId, @gcpBillingTable,
            @stripeCredentialRef, @keywordsJson, @language, @region, @enabled, @now, @now)`,
      )
      .run(projectColumns(input.workspaceId, project, { enabled: input.enabled, now: input.now }));
    const created = this.get(input.workspaceId, input.project.id);
    if (created === undefined) {
      throw new TaviError("INTERNAL", `Project ${input.project.id} vanished immediately after insert`);
    }
    return created;
  }

  get(workspaceId: string, projectId: string): ProjectRecord | undefined {
    const row = this.#store.handle
      .prepare("SELECT * FROM tavi_projects WHERE workspace_id = ? AND project_id = ?")
      .get(workspaceId, projectId) as ProjectRow | undefined;
    return row === undefined ? undefined : toProjectRecord(row);
  }

  list(
    workspaceId: string,
    options: { readonly enabledOnly?: boolean } = {},
  ): { readonly projects: readonly ProjectRecord[]; readonly unreadable: readonly string[] } {
    const rows = (
      options.enabledOnly === true
        ? this.#store.handle
            .prepare("SELECT * FROM tavi_projects WHERE workspace_id = ? AND enabled = 1 ORDER BY project_id")
            .all(workspaceId)
        : this.#store.handle.prepare("SELECT * FROM tavi_projects WHERE workspace_id = ? ORDER BY project_id").all(workspaceId)
    ) as ProjectRow[];
    // Per row, and reported rather than thrown: before this, one malformed column
    // threw a raw `SyntaxError` out of the whole query, so a single hand-edited
    // row took every collector in the workspace down with it.
    const partitioned = partitionReadable(rows, (row) => row.project_id, toProjectRecord);
    return { projects: partitioned.readable, unreadable: partitioned.unreadable };
  }

  remove(workspaceId: string, projectId: string): boolean {
    return (
      this.#store.handle.prepare("DELETE FROM tavi_projects WHERE workspace_id = ? AND project_id = ?").run(workspaceId, projectId)
        .changes > 0
    );
  }

  update(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly project?: Project;
    readonly enabled?: boolean;
    readonly now: string;
  }): boolean {
    // A supplied `project` replaces the whole configuration, which is what
    // "import this project's new settings" means; `enabled` is separate because
    // parking a project must not require re-sending its accounts.
    //
    // Validated before the UPDATE for the reason `AgentDefinitionRepository.update`
    // states: a `true` return must mean the row is still readable.
    if (input.project !== undefined) {
      assertWritable(ProjectSchema, input.project, `Project ${input.projectId}`);
    }
    const sets: string[] = ["updated_at = @now"];
    const params: Record<string, unknown> = { workspaceId: input.workspaceId, projectId: input.projectId, now: input.now };
    if (input.project !== undefined) {
      const columns = projectColumns(input.workspaceId, input.project, { enabled: undefined, now: input.now });
      const map: Readonly<Record<string, string>> = {
        name: "name",
        ga4PropertyId: "ga4_property_id",
        gscSiteUrl: "gsc_site_url",
        gcpBillingProjectId: "gcp_billing_project_id",
        gcpBillingTable: "gcp_billing_table",
        stripeCredentialRef: "stripe_credential_ref",
        keywordsJson: "keywords_json",
        language: "language",
        region: "region",
      };
      for (const [key, column] of Object.entries(map)) {
        sets.push(`${column} = @${key}`);
        params[key] = columns[key] ?? null;
      }
    }
    if (input.enabled !== undefined) {
      sets.push("enabled = @enabled");
      params["enabled"] = input.enabled ? 1 : 0;
    }
    const result = this.#store.handle
      .prepare(`UPDATE tavi_projects SET ${sets.join(", ")} WHERE workspace_id = @workspaceId AND project_id = @projectId`)
      .run(params);
    return result.changes > 0;
  }

  getSettings(workspaceId: string): CollectorSettings {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_collector_settings WHERE workspace_id = ?").get(workspaceId) as
      | CollectorSettingsRow
      | undefined;
    if (row === undefined) return {};
    // Zod's inferred array type is mutable, so the parsed list is copied into a
    // fresh one rather than asserted into a shape it is not.
    //
    // `parseJsonColumn`, not a bare `JSON.parse`: a hand-edited or restored
    // settings row used to throw a raw `SyntaxError` with no code and no row
    // identity out of `loadProjects`, which killed `collect.daily`,
    // `reports.generate` and `projects.get` for the whole workspace — and a
    // scalar like `"https://a.example/rss"` spread into `["h","t","t","p",…]` and
    // was returned as a confidently wrong `feedUrls`. That is the same failure
    // the project rows next door already handle.
    const feedUrls: unknown =
      row.news_feed_urls_json === null ? undefined : parseJsonColumn<unknown>(row.news_feed_urls_json, "news feed URLs");
    const news =
      feedUrls === undefined && row.news_max_items === null && row.news_search_credential_ref === null
        ? undefined
        : {
            // Passed through as parsed: the schema below is what decides whether an
            // array of strings is what the column actually held, so a scalar (a
            // single URL written by hand) is a typed refusal rather than a
            // character-by-character `feedUrls`.
            ...(feedUrls === undefined ? {} : { feedUrls }),
            ...(row.news_max_items === null ? {} : { maxItemsPerProject: row.news_max_items }),
            ...(row.news_search_credential_ref === null ? {} : { searchCredentialRef: row.news_search_credential_ref }),
          };
    // Validated as a whole, like every sibling repository: the schema is what
    // decides whether the assembled object is a `CollectorSettings` at all.
    return parseStoredRow<CollectorSettings>(
      CollectorSettingsSchema,
      {
        ...(row.google_service_account_ref === null ? {} : { googleServiceAccountRef: row.google_service_account_ref }),
        ...(row.lookback_days === null ? {} : { lookbackDays: row.lookback_days }),
        ...(news === undefined ? {} : { news }),
      },
      "collector settings",
    );
  }

  putSettings(input: { readonly workspaceId: string; readonly settings: CollectorSettings; readonly now: string }): CollectorSettings {
    // Validated before the write, like the project and agent repositories: a
    // caller must not be able to make the row unreadable, which is the other half
    // of validating it on the way out.
    const settings = assertWritable(CollectorSettingsSchema, input.settings, "Collector settings");
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_collector_settings
           (workspace_id, google_service_account_ref, lookback_days, news_feed_urls_json, news_max_items, news_search_credential_ref, updated_at)
         VALUES (@workspaceId, @googleServiceAccountRef, @lookbackDays, @newsFeedUrlsJson, @newsMaxItems, @newsSearchCredentialRef, @now)
         ON CONFLICT (workspace_id) DO UPDATE SET
           google_service_account_ref = @googleServiceAccountRef,
           lookback_days = @lookbackDays,
           news_feed_urls_json = @newsFeedUrlsJson,
           news_max_items = @newsMaxItems,
           news_search_credential_ref = @newsSearchCredentialRef,
           updated_at = @now`,
      )
      .run({
        workspaceId: input.workspaceId,
        googleServiceAccountRef: settings.googleServiceAccountRef ?? null,
        lookbackDays: settings.lookbackDays ?? null,
        newsFeedUrlsJson: settings.news?.feedUrls === undefined ? null : JSON.stringify(settings.news.feedUrls),
        newsMaxItems: settings.news?.maxItemsPerProject ?? null,
        newsSearchCredentialRef: settings.news?.searchCredentialRef ?? null,
        now: input.now,
      });
    return this.getSettings(input.workspaceId);
  }
}

/** Column values for a project row, so `create` and `update` cannot drift on how a field is stored. */
function projectColumns(
  workspaceId: string,
  project: Project,
  bookkeeping: { readonly enabled: boolean | undefined; readonly now: string },
): Record<string, unknown> {
  return {
    workspaceId,
    projectId: project.id,
    name: project.name ?? null,
    ga4PropertyId: project.ga4PropertyId ?? null,
    gscSiteUrl: project.gscSiteUrl ?? null,
    gcpBillingProjectId: project.gcp?.billingProjectId ?? null,
    gcpBillingTable: project.gcp?.billingTable ?? null,
    stripeCredentialRef: project.stripeCredentialRef ?? null,
    keywordsJson: project.keywords === undefined ? null : JSON.stringify(project.keywords),
    language: project.language ?? null,
    region: project.region ?? null,
    enabled: bookkeeping.enabled === undefined ? undefined : bookkeeping.enabled ? 1 : 0,
    now: bookkeeping.now,
  };
}

interface ProjectRow {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly name: string | null;
  readonly ga4_property_id: string | null;
  readonly gsc_site_url: string | null;
  readonly gcp_billing_project_id: string | null;
  readonly gcp_billing_table: string | null;
  readonly stripe_credential_ref: string | null;
  readonly keywords_json: string | null;
  readonly language: string | null;
  readonly region: string | null;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function toProjectRecord(row: ProjectRow): ProjectRecord {
  // Assembled first, then validated as a whole: the columns include the
  // registry's own bookkeeping, and `keywords_json` is a JSON column that used to
  // be parsed with a bare cast — so `'"acme"'` silently became `["a","c","m","e"]`
  // and a malformed value threw a raw `SyntaxError` at every caller.
  const record = {
    id: row.project_id,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.ga4_property_id === null ? {} : { ga4PropertyId: row.ga4_property_id }),
    ...(row.gsc_site_url === null ? {} : { gscSiteUrl: row.gsc_site_url }),
    // Both billing coordinates come from one object, so a row with only one of
    // them is incomplete rather than half-configured: it is omitted entirely and
    // the GCP source reports itself unconfigured, which is the honest reading.
    // A half-written pair is a malformed row, not an unconfigured source: the
    // operator did set a billing project, and reporting GCP as "not configured"
    // is the same silent loss as dropping a keyword. Reported via `unreadable`
    // exactly like any other unreadable row.
    ...gcpColumns(row),
    ...(row.stripe_credential_ref === null ? {} : { stripeCredentialRef: row.stripe_credential_ref }),
    ...(row.keywords_json === null ? {} : { keywords: parseJsonColumn<unknown>(row.keywords_json, `project ${row.project_id} keywords`) }),
    ...(row.language === null ? {} : { language: row.language }),
    ...(row.region === null ? {} : { region: row.region }),
    workspaceId: row.workspace_id,
    // The raw column, so the schema decides: `=== 1` turned a hand-edited `2`
    // into a confident `false` and the project silently vanished from every brief.
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return parseStoredRow(ProjectRecordSchema, record, `project ${row.project_id}`);
}

/** `{}`, or a complete pair — never a half-configured one. */
function gcpColumns(row: ProjectRow): { readonly gcp?: { readonly billingProjectId: string; readonly billingTable: string } } {
  if (row.gcp_billing_project_id === null && row.gcp_billing_table === null) return {};
  if (row.gcp_billing_project_id === null || row.gcp_billing_table === null) {
    throw new TaviError("INTERNAL", `Stored project ${row.project_id} has half a GCP billing pair; repair the row or restore a backup`);
  }
  return { gcp: { billingProjectId: row.gcp_billing_project_id, billingTable: row.gcp_billing_table } };
}

interface CollectorSettingsRow {
  readonly workspace_id: string;
  readonly google_service_account_ref: string | null;
  readonly lookback_days: number | null;
  readonly news_feed_urls_json: string | null;
  readonly news_max_items: number | null;
  readonly news_search_credential_ref: string | null;
  readonly updated_at: string;
}
