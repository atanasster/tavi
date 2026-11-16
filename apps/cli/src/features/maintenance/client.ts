import { emitJson, emit } from "../../cli/output.js";
import { EXIT, reportCommandFailure } from "../../cli/exit.js";
import { type RestoreResult, RoutineService, RoutineExecutionService, RoutineNewsService } from "@tavi/runtime";
import { byteSize } from "@tavi/contracts";
import { BUILD_ID } from "../../build-id.js";
import { createSnapshot, exportTables, readSnapshotManifest, restoreSnapshot, snapshotBytes } from "./backup.js";
import { defaultLogPath, readLogTail } from "../../server/log-file.js";
import { retentionCutoff } from "./retention.js";
import { existsSync } from "node:fs";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
import { minuteUtc } from "../../shared/minute-utc.js";
import { join } from "node:path";
import type { LogsCommandOptions, PruneCommandOptions, MaintenanceCommandOptions } from "./parse.js";
import { resolveDataDirectory } from "../../shared/data-directory.js";
import type { CliIo } from "../../cli/io.js";
import { withOwnership, withStorePreservingOwnership } from "../../cli/store.js";

/**
 * `tavi prune`.
 *
 * Takes the ownership lock, because it deletes rows: while `serve` owns the
 * directory the sweep there does the same work, so the refusal is not a gap —
 * `reportCommandFailure` maps the ownership conflict to exit 5 with the message
 * that says so.
 */
export async function pruneCommand(options: PruneCommandOptions, io: CliIo): Promise<number> {
  try {
    return await withStorePreservingOwnership(
      resolveDataDirectory(options.dataDirectory),
      async (store) => {
        const cutoff = retentionCutoff(new Date(), options.olderThanDays);
        const counts = await store.pruneTransport({ olderThan: cutoff, dryRun: options.dryRun });
        const routines = new RoutineService(store);
        const routineRuns = new RoutineExecutionService(routines, { ownerEpoch: "offline" });
        const routineDetails = await routineRuns.pruneDueDetails(options.dryRun);
        const routineEvidence = await new RoutineNewsService(routineRuns).pruneEvidence(nowTimestamp(), options.dryRun);
        // Not counted in the total: a run's snapshot copy is dropped, never the run, which reads its revision's instead.
        const routineSnapshots = await routineRuns.pruneDueSnapshots(options.dryRun);
        // The artifact half is opt-in, and only ever touches artifacts that are not
        // pending and not the report PDFs a report row references.
        const artifacts = options.includeArtifacts
          ? await store.pruneArtifacts({
              olderThan: cutoff,
              dryRun: options.dryRun,
              includeReports: false,
            })
          : { artifacts: 0, bytes: 0 };
        const total =
          counts.inbox + counts.outbox + counts.mailbox + counts.waitIntents + artifacts.artifacts + routineDetails + routineEvidence;
        emit(
          io,
          options.format,
          { ...counts, ...artifacts, routineDetails, routineEvidence, routineSnapshots, olderThan: cutoff, dryRun: options.dryRun, total },
          (value) =>
            `${value.dryRun ? "would delete" : "deleted"} ${value.total} row(s) older than ${minuteUtc(value.olderThan)}\n` +
            `  routine details ${value.routineDetails}, routine evidence ${value.routineEvidence} (saved retention policy)\n` +
            `  routine run snapshots ${value.routineSnapshots} (copies of their revision's)\n` +
            `  inbox ${value.inbox}, outbox ${value.outbox}, mailbox ${value.mailbox}, wait intents ${value.waitIntents}` +
            (options.includeArtifacts ? `, artifacts ${value.artifacts} (${byteSize(value.bytes)})\n` : "\n"),
        );
        return EXIT.ok;
      },
      "prune needs it to itself, even with --dry-run, and the running owner prunes on its own",
    );
  } catch (error) {
    return reportCommandFailure(error, io, "prune command failed");
  }
}

/**
 * `tavi logs`.
 *
 * Reads the daemon's own log file back. A missing file is not an error to shout
 * about — a fresh install has no daemon yet — but it must not look like "the log
 * is empty" either, so the message says which path was checked.
 */
export async function logsCommand(options: LogsCommandOptions, io: CliIo): Promise<number> {
  const path = options.file ?? defaultLogPath(resolveDataDirectory(options.dataDirectory));
  let lines: readonly string[];
  try {
    lines = readLogTail(path, options.tail);
  } catch (error) {
    // Reading while the daemon rotates can lose the race between the existence
    // check and the read; that is a designed unavailability, not a crash.
    io.stderr(`logs could not read ${path}: ${errorMessage(error)}\n`);
    return EXIT.unavailable;
  }
  if (lines.length === 0) {
    io.stdout(options.format === "json" ? "[]\n" : `no log lines at ${path}\n`);
    return EXIT.ok;
  }
  if (options.format === "json") {
    emitJson(io, lines);
    return EXIT.ok;
  }
  for (const line of lines) {
    // The file holds one JSON object per line; render it readably, and fall back
    // to the raw line when something else got in (a crash trace, a hand edit)
    // rather than dropping it.
    try {
      const parsed = JSON.parse(line) as { at?: string; level?: string; message?: string };
      io.stdout(`${parsed.at ?? "-"}\t${parsed.level ?? "-"}\t${parsed.message ?? line}\n`);
    } catch {
      io.stdout(`${line}\n`);
    }
  }
  return EXIT.ok;
}

/**
 * What a restore says of forgotten memory: how many records
 * forgotten after the snapshot stay forgotten (the next start forgets them
 * again), or that the replaced database could not be read to tell.
 */
function restoredMemoryLine(forgotten: RestoreResult["forgottenMemory"]): string {
  if (forgotten === undefined) return "";
  if ("unchecked" in forgotten) {
    return `forgotten memories could not be checked: anything you forgot after ${forgotten.snapshotAt ?? "the snapshot was taken"} may be back; forget it again\n`;
  }
  // Nothing forgotten since the snapshot: nothing to say.
  if (forgotten.stayForgotten === 0) return "";
  return `${forgotten.stayForgotten} forgotten ${forgotten.stayForgotten === 1 ? "memory stays" : "memories stay"} forgotten\n`;
}

/**
 * `tavi backup` / `tavi export` / `tavi restore`.
 *
 * Backup and export **read** the directory and take no ownership lock: the
 * snapshot is SQLite's own consistent-snapshot operation from a read-only
 * connection, so both work while `tavi serve` owns the directory — which is when
 * an operator wants a copy. Restore writes, so it takes the lock and refuses with
 * exit 5 while a daemon holds it, exactly like every other direct-database
 * command.
 */
export async function maintenanceCommand(options: MaintenanceCommandOptions, io: CliIo): Promise<number> {
  const dataDirectory = resolveDataDirectory(options.dataDirectory);
  try {
    if (options.action === "restore") {
      const from = options.fromDirectory;
      if (from === undefined) {
        io.stderr("restore needs --from <dir>\n");
        return EXIT.usage;
      }
      return await withOwnership(
        dataDirectory,
        async () => {
          const manifest = readSnapshotManifest(from);
          const result = await restoreSnapshot({ snapshotDirectory: from, dataDirectory, now: nowTimestamp() });
          emit(
            io,
            options.format,
            { ...result, manifest },
            (value) =>
              `restored ${value.migrations.length} migration(s) from ${value.restoredFrom}\n` +
              (value.movedAside === null
                ? "no existing database to move aside\n"
                : `moved the previous database to ${value.movedAside}\n`) +
              (value.restoredFiles.length === 0
                ? "database only (the snapshot carries no other files)\n"
                : `also restored ${value.restoredFiles.join(", ")}\n`) +
              // Each folder the restore replaced, moved aside as the database is.
              (["artifacts", "chats", "plugins"] as const)
                .flatMap((folder) => {
                  const aside = value.directoriesMovedAside[folder];
                  return aside === undefined ? [] : [`moved the previous ${folder}/ to ${aside}\n`];
                })
                .join("") +
              // A snapshot with no chats' folders leaves the live ones where they are.
              (!value.restoredFiles.includes("chats/") && existsSync(join(dataDirectory, "chats"))
                ? "kept the chats' folders already in the data directory (the snapshot carries none)\n"
                : "") +
              (value.ignored.length === 0 ? "" : `ignored (the manifest excludes them): ${value.ignored.join(", ")}\n`) +
              restoredMemoryLine(value.forgottenMemory),
          );
          return EXIT.ok;
        },
        "restoring would replace the database it is using",
      );
    }

    const out = options.outDirectory;
    if (out === undefined) {
      io.stderr(`${options.action} needs --out <dir>\n`);
      return EXIT.usage;
    }
    if (options.action === "backup") {
      const manifest = await createSnapshot({
        dataDirectory,
        outDirectory: out,
        buildId: BUILD_ID,
        now: nowTimestamp(),
        includeArtifacts: options.includeArtifacts,
        includeCredentials: options.includeCredentials,
        force: options.force,
      });
      // The chats' folders can be the largest part, so their share is named.
      const value = {
        ...manifest,
        bytes: snapshotBytes(out),
        ...(manifest.includes.chats === true ? { chatsBytes: snapshotBytes(join(out, "chats")) } : {}),
      };
      emit(io, options.format, value, (snapshot) => {
        const rows = Object.values(snapshot.rowCounts).reduce((sum, count) => sum + count, 0);
        const included = [
          "database",
          ...(snapshot.includes.artifacts ? ["artifacts/"] : []),
          ...(snapshot.includes.plugins === true ? ["plugins/"] : []),
          ...(snapshot.chatsBytes === undefined ? [] : [`chats/ (${byteSize(snapshot.chatsBytes)})`]),
          ...(snapshot.includes.credentials ? ["credentials/"] : []),
        ];
        return (
          `snapshot ${out} (${byteSize(snapshot.bytes)})\n` +
          `  ${snapshot.applicationTables.length} table(s), ${rows} row(s), ${snapshot.migrations.length} migration(s)\n` +
          `  includes: ${included.join(", ")}\n` +
          `  excluded: ${snapshot.excluded.length === 0 ? "(nothing)" : snapshot.excluded.join(", ")}\n`
        );
      });
      return EXIT.ok;
    }
    const exported = await exportTables({ dataDirectory, outDirectory: out, force: options.force });
    const value = { ...exported, bytes: snapshotBytes(out) };
    emit(
      io,
      options.format,
      value,
      (result) =>
        `exported ${result.files.length} table(s) to ${out} (${byteSize(result.bytes)})\n` +
        result.files.map((file) => `  ${file.table}\t${file.rows} row(s)\n`).join(""),
    );
    return EXIT.ok;
  } catch (error) {
    return reportCommandFailure(error, io, `${options.action} command failed`);
  }
}
