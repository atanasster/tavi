import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ProjectsFileSchema, TaviError } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { z } from "zod";

/** `<dataDir>/projects.json`, as `tavi projects import` reads it. */
export type ProjectsImportFile = z.infer<typeof ProjectsFileSchema>;

/** Where the import file lives; read only by `tavi projects import`. */
function projectsFilePath(dataDirectory: string): string {
  return join(dataDirectory, "projects.json");
}

/**
 * Read and validate `<dataDir>/projects.json`.
 *
 * Only `tavi projects import` calls this. The collectors read the registry, not
 * a file — unqueryable, invisible to the agent, validated only by a startup
 * parse — for which projects exist; this is the one-time migration path.
 */
export async function readProjectsFile(dataDirectory: string): Promise<ProjectsImportFile> {
  const path = projectsFilePath(dataDirectory);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new TaviError("INVALID_INPUT", "no projects file exists to import", { details: { path: "projects.json" } });
    }
    throw new TaviError("UNAVAILABLE", "the project configuration could not be read");
  }
  try {
    return ProjectsFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new TaviError("INVALID_INPUT", "the project configuration is not valid", {
      details: { reason: errorMessage(error) },
    });
  }
}
