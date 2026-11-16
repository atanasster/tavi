import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ArtifactsPayloadSchema,
  ArtifactsResultSchema,
  IdSchema,
  TaviError,
  type ArtifactsPayload,
  type ArtifactsResult,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

const Cursor = z.object({ scope: z.string(), at: z.string().max(64), id: IdSchema }).strict();
/** Metadata only. Every page and every ID lookup is scoped before its SQL bound. */
export function queryArtifacts(db: Database.Database, input: ArtifactsPayload): ArtifactsResult {
  const filters = ArtifactsPayloadSchema.parse(input);
  const scope = sha256Hex(
    JSON.stringify([filters.workspaceId, filters.taskId, filters.artifactIds?.slice().sort(), filters.includeDecided ?? false]),
  );
  // Internal artifacts (a browser session's thumbnail) are not the operator's
  // artifacts to review or open here; the Browser section serves them.
  const where = ["workspace_id = ?", "purpose IS NULL"];
  const parameters: (string | number)[] = [filters.workspaceId];
  if (filters.taskId) {
    where.push("run_id = ?");
    parameters.push(filters.taskId);
  }
  if (filters.artifactIds) {
    where.push(`artifact_id IN (${filters.artifactIds.map(() => "?").join(",")})`);
    parameters.push(...filters.artifactIds);
  } else if (!filters.includeDecided) where.push("review_state = 'pending'");
  if (filters.cursor) {
    try {
      const cursor = Cursor.parse(JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8")));
      if (cursor.scope !== scope) throw new Error("scope");
      where.push("(created_at > ? OR (created_at = ? AND artifact_id > ?))");
      parameters.push(cursor.at, cursor.at, cursor.id);
    } catch {
      throw new TaviError("INVALID_INPUT", "Invalid artifact cursor for this query");
    }
  }
  const rows = db
    .prepare(
      `SELECT artifact_id AS artifactId, workspace_id AS workspaceId, run_id AS runId, substr(content_type,1,256) AS contentType, byte_size AS byteSize, review_state AS reviewState, substr(file_name,1,255) AS fileName, created_at AS at FROM tavi_artifacts WHERE ${where.join(" AND ")} ORDER BY created_at, artifact_id LIMIT ?`,
    )
    .all(...parameters, filters.limit + 1) as (Omit<ArtifactsResult["rows"][number], "fileName"> & {
    at: string;
    fileName: string | null;
  })[];
  const page = rows.slice(0, filters.limit);
  const last = page.at(-1);
  return ArtifactsResultSchema.parse({
    rows: page.map(({ at: _at, fileName, ...row }) => (fileName === null ? row : { ...row, fileName })),
    ...(rows.length > filters.limit && last
      ? { nextCursor: Buffer.from(JSON.stringify({ scope, at: last.at, id: last.artifactId })).toString("base64url") }
      : {}),
  });
}
