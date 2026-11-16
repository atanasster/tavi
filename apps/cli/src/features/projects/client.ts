import { emitJson, emit } from "../../cli/output.js";
import { EXIT, reportCommandFailure } from "../../cli/exit.js";
import { TaviError, type ProjectRecord, ProjectSchema, type Project } from "@tavi/contracts";
import { readProjectsFile } from "./file.js";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import type { ProjectsCommandOptions } from "./parse.js";
import { type CliIo, printUnreadableWarning } from "../../cli/io.js";
import { configOnOwner, refuseOfflineOnly } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStorePreservingOwnership } from "../../cli/store.js";

/** `tavi projects <action>` on a live owner; `import` is offline-only. */
async function projectsOnOwner(options: ResolvedDataDirectory<ProjectsCommandOptions>, io: CliIo): Promise<number | undefined> {
  const action = options.action;
  if (action === "import") {
    return refuseOfflineOnly(
      options.dataDirectory,
      "tavi projects import",
      "it writes the projects file into the registry in one transaction",
      io,
    );
  }
  return configOnOwner(options.dataDirectory, "projects", io, {
    label: `tavi projects ${options.action}`,
    mutates: options.action !== "list" && options.action !== "show",
    codes: { NOT_FOUND: EXIT.usage },
    build: () => {
      if (options.action === "add") return { action: "add", workspaceId: options.workspaceId, project: projectFromOptions(options) };
      if (options.action === "list") return { action: "list", workspaceId: options.workspaceId };
      if (options.projectId === undefined) {
        io.stderr(`projects ${options.action} needs a project id\n`);
        return EXIT.usage;
      }
      return { action, workspaceId: options.workspaceId, projectId: options.projectId };
    },
    render: (result) => {
      switch (options.action) {
        case "list": {
          const listed = result as {
            readonly projects: readonly ProjectRecord[];
            readonly truncated: boolean;
            readonly unreadable?: readonly string[];
          };
          if (options.format === "json") {
            emitJson(io, listed);
            return EXIT.ok;
          }
          for (const project of listed.projects) io.stdout(projectLine(project));
          printUnreadableWarning(
            io,
            "project row(s)",
            listed.unreadable ?? [],
            "Fix them with `tavi projects remove <id>` then `tavi projects add`.",
          );
          if (listed.truncated) io.stderr(`note: the owner lists the first ${listed.projects.length} projects\n`);
          return EXIT.ok;
        }
        case "show":
          emit(io, options.format, result as ProjectRecord, projectShowText);
          return EXIT.ok;
        case "remove":
          emit(io, options.format, result as { readonly removed: string }, projectRemovedText);
          return EXIT.ok;
        default:
          // `add`, `enable`, `disable`: the id, the name and the state.
          emit(io, options.format, result as ProjectRecord, projectStateLine);
          return EXIT.ok;
      }
    },
  });
}

/** `tavi projects add|enable|disable`'s text: the id, the name and the state (a new project is enabled). */
function projectStateLine(value: ProjectRecord): string {
  return `${value.id}\t${value.name ?? ""}\t${value.enabled ? "enabled" : "disabled"}\n`;
}

/** `tavi projects remove`'s text. */
function projectRemovedText(value: { readonly removed: string }): string {
  return `removed ${value.removed}\n`;
}

/** `tavi projects list`'s text line for one project. */
function projectLine(project: ProjectRecord): string {
  const sources = [
    project.ga4PropertyId === undefined ? undefined : "ga4",
    project.gscSiteUrl === undefined ? undefined : "gsc",
    project.gcp === undefined ? undefined : "gcp",
    project.stripeCredentialRef === undefined ? undefined : "stripe",
    // Keywords for the news collector: news comes only once a feed or a search provider is configured too.
    (project.keywords?.length ?? 0) === 0 ? undefined : "news keywords",
  ].filter((source) => source !== undefined);
  return `${project.id}\t${project.name ?? ""}\t${project.enabled ? "enabled" : "disabled"}\t${sources.join(",") || "no sources"}\n`;
}

/** `tavi projects show`'s text. */
function projectShowText(value: ProjectRecord): string {
  return [
    `project ${value.id} (${value.name ?? "unnamed"})`,
    `  state     ${value.enabled ? "enabled" : "disabled"}`,
    `  ga4       ${value.ga4PropertyId ?? "(not configured)"}`,
    `  gsc       ${value.gscSiteUrl ?? "(not configured)"}`,
    `  gcp       ${value.gcp === undefined ? "(not configured)" : `${value.gcp.billingProjectId} / ${value.gcp.billingTable}`}`,
    `  stripe    ${value.stripeCredentialRef ?? "(not configured)"}`,
    `  keywords  ${value.keywords?.join(", ") ?? "(none — no news collected)"}`,
    `  language  ${value.language ?? "(unset)"}   region ${value.region ?? "(unset)"}`,
  ].join("\n");
}

/** The registry's fields as the CLI supplies them, validated through the same schema the collectors read. */
function projectFromOptions(options: ProjectsCommandOptions): Project {
  const parsed = ProjectSchema.safeParse({
    id: options.projectId,
    ...definedOnly({
      name: options.name,
      ga4PropertyId: options.ga4,
      gscSiteUrl: options.gsc,
    }),
    ...(options.gcpProject === undefined || options.gcpTable === undefined
      ? {}
      : { gcp: { billingProjectId: options.gcpProject, billingTable: options.gcpTable } }),
    ...(options.stripeRef === undefined ? {} : { stripeCredentialRef: options.stripeRef }),
    ...(options.keywords === undefined ? {} : { keywords: [...options.keywords] }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.region === undefined ? {} : { region: options.region }),
  });
  if (!parsed.success) {
    throw new TaviError(
      "INVALID_INPUT",
      `invalid project: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * `tavi projects <action>`.
 *
 * The registry replaced `<dataDir>/projects.json`, so `import` is the migration
 * path and everything else edits the database directly. Reads and writes are
 * plain store operations, so an operator can inspect the registry while `serve`
 * owns the directory — the same reasoning as `tavi agents`.
 */
export async function projectsCommand(options: ResolvedDataDirectory<ProjectsCommandOptions>, io: CliIo): Promise<number> {
  const onOwner = await projectsOnOwner(options, io);
  if (onOwner !== undefined) return onOwner;
  try {
    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const projects = store.asPort().repositories.projects;
      const now = nowTimestamp();

      if (options.action === "import") {
        const file = await readProjectsFile(options.dataDirectory);
        // The whole file is judged before the first write, and the writes then
        // commit as one transaction. `readProjectsFile` already
        // proved each project's *shape* and says nothing about uniqueness, so
        // two entries can still carry the same id. The transaction is what makes
        // the guarantee whole: the one reachable mid-loop failure — a registry
        // row whose `project_id` matches a file entry but whose stored columns
        // are unreadable, which `projects.get` refuses while `list` would have
        // isolated it as `unreadable` — would otherwise leave the settings row
        // and the earlier projects committed while the command exits 70, so the
        // operator could not tell what was applied.
        const seen = new Set<string>();
        for (const project of file.projects) {
          if (seen.has(project.id)) {
            throw new TaviError(
              "INVALID_INPUT",
              `the project configuration lists project ${JSON.stringify(project.id)} more than once; nothing was imported`,
              {
                details: { projectId: project.id },
              },
            );
          }
          seen.add(project.id);
        }
        // Merged onto what is already configured, field by field. Replacing the
        // whole row would make a *re-import* of a stale or partial file print
        // "imported 0 project(s)" while silently clearing the Google reference
        // or the lookback window — breaking every later scheduled brief from a
        // command that reported success. The settings a file does not mention
        // are exactly the ones an operator has since set elsewhere.
        const { settings, created, skipped } = await store.importProjects({
          workspaceId: options.workspaceId,
          projects: file.projects,
          now,
          settings: {
            ...definedOnly({ googleServiceAccountRef: file.googleServiceAccountRef, lookbackDays: file.lookbackDays, news: file.news }),
          },
        });

        emit(
          io,
          options.format,
          { imported: created, skipped, settings },
          (value) =>
            `imported ${value.imported} project(s)${value.skipped.length === 0 ? "" : `; left ${value.skipped.join(", ")} alone (already present)`}\n`,
        );
        return EXIT.ok;
      }

      if (options.action === "list") {
        const { projects: all, unreadable } = await projects.list(options.workspaceId);
        if (options.format === "json") {
          emitJson(io, { projects: all, ...(unreadable.length === 0 ? {} : { unreadable }) });
          return EXIT.ok;
        }
        for (const project of all) io.stdout(projectLine(project));
        // Reported, not swallowed: a project the collectors can no longer read
        // looks exactly like a project that was never configured.
        printUnreadableWarning(
          io,
          "project row(s)",
          unreadable,
          "Fix them with `tavi projects remove <id>` then `tavi projects add`, or restore a backup.",
        );
        return EXIT.ok;
      }

      if (options.action === "add") {
        const project = projectFromOptions(options);
        const created = await projects.create({ workspaceId: options.workspaceId, project, enabled: true, now });
        emit(io, options.format, created, projectStateLine);
        return EXIT.ok;
      }

      const projectId = options.projectId;
      if (projectId === undefined) {
        io.stderr(`projects ${options.action} needs a project id\n`);
        return EXIT.usage;
      }
      const existing = await projects.get(options.workspaceId, projectId);
      if (existing === undefined) {
        io.stderr(`no project ${JSON.stringify(projectId)} exists in workspace ${options.workspaceId}\n`);
        return EXIT.usage;
      }

      if (options.action === "show") {
        emit(io, options.format, existing, projectShowText);
        return EXIT.ok;
      }

      if (options.action === "remove") {
        await projects.remove(options.workspaceId, projectId);
        emit(io, options.format, { removed: projectId }, projectRemovedText);
        return EXIT.ok;
      }

      if (options.action === "enable" || options.action === "disable") {
        const enabled = options.action === "enable";
        await projects.update({ workspaceId: options.workspaceId, projectId, enabled, now });
        const updated = (await projects.get(options.workspaceId, projectId)) ?? existing;
        emit(io, options.format, updated, projectStateLine);
        return EXIT.ok;
      }

      io.stderr(`projects ${options.action} is not implemented\n`);
      return EXIT.usage;
    });
  } catch (error) {
    return reportCommandFailure(error, io, "projects command failed");
  }
}
