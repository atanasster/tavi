import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

/**
 * The project registry.
 *
 * The report collectors need to know which projects exist and which account
 * each one belongs to. That lives in the database rather than a
 * `<dataDir>/projects.json` file (unvalidated beyond a startup parse,
 * unqueryable, and invisible to the agent), and the agent has a read-only
 * view of it (`projects.get`): an orchestrator that can see the
 * registry can tell the operator what it already knows and ask only for the
 * gaps.
 *
 * `CollectorSettings` is stored alongside, deliberately in the same module: the
 * Google service-account reference, the default lookback window and the news
 * feeds are **deployment-wide**, not per project, and leaving them in the JSON
 * file would have meant the file stayed authoritative for half the
 * configuration — a confusing split.
 */

/** Per-source billing coordinates; both are required together or neither is meaningful. */
export const ProjectGcpSchema = z.strictObject({
  billingProjectId: z.string().min(1).max(128),
  billingTable: z.string().min(1).max(512),
});

/**
 * The fields a collector needs about one project.
 *
 * Every source identifier is optional, because a project is legitimately
 * partially configured: a site with no Stripe account should still produce GA4
 * and Search Console data, and each unconfigured source reports itself as
 * `partial` rather than failing the whole report.
 *
 * `strictObject`, matching `ScheduleSpecSchema`: a typo in an operator's config
 * is a visible error rather than a silently-ignored key — which matters more
 * here than anywhere, because a dropped `gscSiteUrl` looks exactly like a site
 * with no search traffic.
 */
export const ProjectSchema = z.strictObject({
  id: z.string().min(1).max(64).describe("Stable project id, e.g. `ai-crucible`"),
  name: z.string().min(1).max(200).optional(),
  ga4PropertyId: z.string().min(1).max(64).optional().describe("GA4 property, e.g. `properties/513076108`"),
  gscSiteUrl: z.string().min(1).max(512).optional().describe("Search Console property, e.g. `sc-domain:example.com`"),
  gcp: ProjectGcpSchema.optional(),
  stripeCredentialRef: z.string().min(1).max(128).optional(),
  keywords: z.array(z.string().min(1).max(128)).max(32).optional(),
  language: z.string().min(2).max(16).optional().describe("BCP-47-ish language for news relevance"),
  region: z.string().min(2).max(16).optional().describe("Region for news relevance"),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Deployment-wide collector configuration — see this module's header for why it is not per project. */
export const CollectorSettingsSchema = z.strictObject({
  googleServiceAccountRef: z.string().min(1).max(128).optional(),
  lookbackDays: z.number().int().min(1).max(90).optional(),
  news: z
    .strictObject({
      feedUrls: z.array(z.string().min(1).max(2_048)).max(20).optional(),
      maxItemsPerProject: z.number().int().min(1).max(20).optional(),
      searchCredentialRef: z.string().min(1).max(128).optional(),
    })
    .optional(),
});
export type CollectorSettings = z.infer<typeof CollectorSettingsSchema>;

/**
 * The import format: what `tavi projects import` accepts from
 * `<dataDir>/projects.json`. The database is authoritative; this shape still
 * carries the deployment-wide settings inline, as operators have it on disk.
 */
export const ProjectsFileSchema = CollectorSettingsSchema.extend({
  projects: z.array(ProjectSchema).min(1).max(50),
});

export interface ProjectRecord extends Project {
  readonly workspaceId: string;
  /**
   * A disabled project keeps its configuration but is skipped by every
   * collector, so an operator can park a project without deleting the account
   * ids they would have to re-enter.
   */
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The stored-row shape, used to validate a row on the way **out**, not only in.
 *
 * `ProjectSchema` alone cannot do this job: the columns also carry the registry's
 * own bookkeeping. Validating the assembled record is what keeps a hand-edited,
 * restored or older-release row from silently becoming a wrong project —
 * `keywords_json = '"acme"'` used to arrive as `["a","c","m","e"]`, and a
 * malformed column threw a raw `SyntaxError` out of every query in the workspace.
 */
export const ProjectRecordSchema = ProjectSchema.extend({
  workspaceId: z.string().min(1).max(128),
  /**
   * The stored column, validated rather than coerced.
   *
   * `row.enabled === 1` turned any other value — including a hand-edited `2` —
   * into a confident `false`, which the collectors then skipped silently, so a
   * project could vanish from every brief while every row "read fine". Anything
   * that is not exactly 0 or 1 is now an unreadable row instead.
   */
  enabled: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
  /** A real instant, not merely a non-empty string: `'now'` used to validate. */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
// `ProjectSchema` is a `strictObject` and `.extend()` preserves that in the
// pinned zod, so an unknown column key is still rejected — asserted by a test,
// because it is an implementation detail of `.extend` that this schema depends
// on for the drift it exists to catch.

interface ProjectRepositoryPortDefinition {
  /**
   * Refuses a duplicate `(workspaceId, id)` with a typed `CONFLICT`, and refuses
   * a `project` outside `ProjectSchema` with `INVALID_INPUT` **before writing**.
   *
   * Validating only on the way out is not enough: the row would already be
   * committed, and `list` would then hide it in `unreadable`, so the write looks
   * like a success and the project disappears.
   */
  create(input: {
    readonly workspaceId: string;
    readonly project: Project;
    readonly enabled: boolean;
    readonly now: string;
  }): ProjectRecord;
  /** Throws a typed `INTERNAL` naming the row if it does not match the current schema. */
  get(workspaceId: string, projectId: string): ProjectRecord | undefined;
  /**
   * `enabledOnly` is what the collectors use; the CLI lists everything so a
   * parked project stays visible.
   *
   * `unreadable` holds the `project_id` of each row that could not be validated.
   * They are **isolated and reported, never thrown**: one bad row must not make
   * every collector in the workspace fail, and it must not vanish silently either
   * — a brief that omits a project looks exactly like a brief for a deployment
   * with fewer projects. Mirrors `ScheduleRepositoryPort.listDue`'s established
   * shape.
   *
   * @example `{ projects: [...], unreadable: ["acme"] }`
   */
  list(
    workspaceId: string,
    options?: { readonly enabledOnly?: boolean },
  ): { readonly projects: readonly ProjectRecord[]; readonly unreadable: readonly string[] };
  remove(workspaceId: string, projectId: string): boolean;
  /**
   * **Replace** the project's configuration with `project`, and/or set
   * `enabled`.
   *
   * Replace, not merge: `Project`'s fields are optional, so a partial project is
   * indistinguishable from a deliberate clear, and guessing which was meant is
   * how a field disappears silently. A caller editing one field therefore sends
   * the result of `get` merged with its change. Deliberately *not* the
   * absent-versus-clear shape `AgentDefinitionRepositoryPort.update` uses, which
   * works there because every field is a scalar the caller either names or does
   * not — `Project` carries a nested `gcp` and a `keywords` list, where "absent"
   * is genuinely ambiguous. The first version's JSDoc promised the merge
   * semantics without implementing them, which is worse than either.
   *
   * `enabled` is separate because parking a project must not require re-sending
   * the account ids an operator would otherwise need to look up again.
   *
   * Returns `false` for an unknown id, and throws `INVALID_INPUT` for a value
   * outside `ProjectSchema` — it never reports success for a write that would
   * make the row unreadable.
   */
  update(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly project?: Project;
    readonly enabled?: boolean;
    readonly now: string;
  }): boolean;
  /** Never absent: an unconfigured deployment gets empty settings rather than an error, so a first `collect.daily` reports "not configured" per source. */
  getSettings(workspaceId: string): CollectorSettings;
  /**
   * **Replace** the settings row. It takes a complete `CollectorSettings`, so a
   * caller that wants to keep a field must send it — pass the result of
   * `getSettings` merged with the change. That is what `tavi projects import`
   * does, deliberately: an import that clobbered the Google reference because
   * the file did not mention it would break every later brief from a command
   * that reported success.
   */
  putSettings(input: { readonly workspaceId: string; readonly settings: CollectorSettings; readonly now: string }): CollectorSettings;
}

export type ProjectRepositoryPort = AsyncRepository<ProjectRepositoryPortDefinition>;
