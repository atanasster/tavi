import {
  chmodSync,
  fchmodSync,
  fstatSync,
  readSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { CHAT_FOLDERS_TRASH, TaviError, WebProviderConfigurationSchema } from "@tavi/contracts";
import { APPLICATION_TABLES, FTS_SHADOW_TABLES, MIGRATIONS, SAVER_SCHEMA_VERSION_KEY, SAVER_TABLES } from "./migrations.js";
import { removeTreeSync } from "../folder-retention.js";
import { assertProfileFormat } from "./profile-validation.js";
import { PROFILE_FORMAT } from "./profile-format.js";
import { SNAPSHOT_DATABASE, SNAPSHOT_MANIFEST, readSnapshotManifest, type SnapshotManifest } from "./snapshot-files.js";
import { loadBetterSqlite3, type Database } from "./sqlite-loader.js";
import {
  flushFile,
  NoFollowReadError,
  openDirectoryNoFollowSync,
  openNoFollowSync,
  readNoFollowSync,
  retryWhileHeld,
  sameIdentity,
  type FileIdentity,
} from "@tavi/node-kit";

/**
 * Snapshots, exports and restores of a data directory, so an operator upgrading
 * a long-lived data directory has a supported way to take a copy of it. A backup
 * built from a hand-kept table list can go stale: it would silently omit the
 * tables the list missed (messaging and delegation rows, say — exactly the
 * conversational state a backup exists to preserve) and the restore would
 * still look successful.
 *
 * **Every copy here goes through SQLite, never through the filesystem's own file
 * copy.** A live directory is WAL-mode and may have a concurrent owner, so
 * copying `tavi.sqlite` without its `-wal` gives a database missing the newest
 * commits, and copying all three without a lock gives a torn one. `VACUUM INTO`
 * is SQLite's consistent-snapshot operation, works from a read-only connection,
 * and folds the WAL in — so a backup is safe while `tavi serve` runs, which is
 * when an operator actually wants one, and a *restore* from a directory that
 * happens to be live is not silently stale.
 */

/** A rename of a database file Windows may still hold a moment after its last close (an antivirus scan, the indexer): retried briefly there. */
const renameHeld = (from: string, to: string): void => retryWhileHeld(() => renameSync(from, to));

/** Entries a snapshot owns; `--force` replaces exactly these and nothing else. */
const SNAPSHOT_ENTRIES = [
  SNAPSHOT_DATABASE,
  SNAPSHOT_MANIFEST,
  "artifacts",
  "chats",
  "credentials",
  "plugins",
  "web-providers.json",
] as const;
/**
 * What a snapshot leaves out of `chats/`: the
 * prune trash, and each chat's scratch and shell home, which are emptied or
 * rebuilt anyway and hold toolchain caches rather than the chat's work.
 * `ChatFolders` recreates `.tmp/` and `.home/` at the chat's next admission.
 */
const CHATS_EXCLUDED = ["chats/.trash/", "chats/*/*/.tmp/", "chats/*/*/.home/"] as const;

function openReadOnly(path: string): Database {
  const DatabaseCtor = loadBetterSqlite3();
  if (!existsSync(path)) {
    throw new TaviError("INVALID_INPUT", `no database exists at ${JSON.stringify(path)}`);
  }
  // `fileMustExist` + `readonly`: this process must never create or migrate the
  // database it is copying. Opening it the ordinary way would run migrations
  // (SqliteStore's constructor does) and take the ownership lock — both wrong for
  // a reader, and the second would make a backup impossible while `serve` runs.
  return new DatabaseCtor(path, { readonly: true, fileMustExist: true });
}

function withReadOnly<T>(path: string, body: (db: Database) => T): T {
  const db = openReadOnly(path);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/**
 * Real path of `path`; for one that does not exist yet (a backup's new
 * folder), its nearest existing ancestor's real path with the rest appended,
 * so a folder about to be made inside the data directory is seen as inside it.
 */
function realPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realPath(parent), relative(parent, absolute));
  }
}

/**
 * Refuse two directories that would write over each other.
 *
 * Both directions matter and both were reachable before this check: `backup
 * --out <data-dir> --force` deleted the live database and then reported that none
 * existed, and `restore --from <data-dir> --data-dir <data-dir>` moved the
 * database aside and left the directory with no `tavi.sqlite` at all.
 */
export function assertDistinctDirectories(other: string, dataDirectory: string, what = "the snapshot directory"): void {
  const otherReal = realPath(other);
  const dataReal = realPath(dataDirectory);
  const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + sep);
  if (inside(otherReal, dataReal) || inside(dataReal, otherReal)) {
    throw new TaviError(
      "INVALID_INPUT",
      `${what} ${JSON.stringify(other)} and the data directory ${JSON.stringify(dataDirectory)} are ` +
        "the same directory or one contains the other; choose a directory outside the data directory",
      { details: { outDirectory: other, dataDirectory } },
    );
  }
}

/** `tavi_` tables plus the saver's own; what a JSON export writes out. */
export function exportableTables(db: Database): readonly string[] {
  const declared = new Set<string>([...APPLICATION_TABLES, ...SAVER_TABLES]);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return rows.map((row) => row.name).filter((name) => declared.has(name));
}

function countRows(db: Database, tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    // The table names come from `sqlite_master`, never from operator input, and
    // are quoted anyway: a name is data, not SQL.
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  }
  return counts;
}

/**
 * Copy one file or a whole private tree, refusing symlinks.
 *
 * `cpSync` follows symlinks by default, which is wrong twice over for the
 * credentials directory: a link pointing outside the data directory copies a
 * secret *into* the snapshot, and tightening the copy's modes would `chmod` the
 * file the link points at — a file outside the tree this command owns. The store
 * itself refuses a symlinked credential file, so
 * refusing one here is the same rule rather than a new one.
 */
function assertNoSymlinks(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new TaviError("INVALID_INPUT", `refusing to copy the symlink ${JSON.stringify(path)} into a snapshot`, {
      details: { path },
    });
  }
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) assertNoSymlinks(join(path, entry));
  }
}

function copyPrivateTree(source: string, destination: string): void {
  // Checked in full *before* anything is written, so a refused backup leaves no
  // half-copied credentials directory behind for a later restore to find.
  assertNoSymlinks(source);
  copyPrivateTreeUnchecked(source, destination);
}

function copyPrivateTreeUnchecked(source: string, destination: string): void {
  const stats = lstatSync(source);
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    chmodSync(destination, 0o700);
    for (const entry of readdirSync(source)) copyPrivateTreeUnchecked(join(source, entry), join(destination, entry));
    return;
  }
  cpSync(source, destination, { force: true });
  chmodSync(destination, 0o600);
}

/** Whether something is at `path`, a dangling link included (`existsSync` follows links). */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `<directory>/chats` is there to copy: a real directory, never a link
 * (I-nofollow). A `chats` that is a link or a file is refused rather than
 * copied as one, since a restore would then make the chats' folders resolve
 * somewhere else.
 */
function chatsDirectory(directory: string): boolean {
  const path = join(directory, "chats");
  if (!present(path)) return false;
  if (!lstatSync(path).isDirectory()) {
    throw new TaviError("INVALID_INPUT", `${JSON.stringify(path)} is not a directory; refusing to copy it`, { details: { path } });
  }
  return true;
}

/** An entry a running chat changed between its look and its copy: skipped, as one that is gone. */
class ChangedWhileCopied extends Error {}

/**
 * Copy a `chats/` tree, links kept as links and never followed.
 *
 * A chat's shell writes its folder, so it can plant a link to anywhere in it:
 * a link is copied as itself, its target as written. (Node's `cpSync` with
 * `dereference: false` rewrites a relative target to an absolute path into
 * the *source* tree unless `verbatimSymlinks` is set, so a restored link would
 * point back into the snapshot.) What `CHATS_EXCLUDED` names is skipped, and
 * so are sockets, FIFOs and devices, which a copy cannot carry.
 *
 * A walk of its own rather than `cpSync`: chats keep running while a backup
 * is taken, and an entry a chat's shell removes between the listing and its
 * copy is skipped (`ENOENT`) instead of failing the whole backup. Any other
 * error still fails it. A directory gets its mode once its entries are in, so
 * a read-only one is still filled.
 *
 * Nothing is read through a link swapped in after an entry was looked at
 * (I-nofollow): a file is opened `O_NOFOLLOW` and copied from that descriptor
 * only when it is the inode `lstat` found and its path still resolves to
 * itself and to that inode (no ancestor swapped for a link); a folder is
 * listed only while it is that folder, checked the same way. An entry that
 * changed so is skipped, as one that is gone. A link is copied as a link,
 * except on Windows, where it is skipped.
 */
function copyChats(source: string, destination: string): void {
  // Gone, or swapped for a link (`ELOOP`) or a file where a folder was (`ENOTDIR`).
  const skipped = (error: unknown): boolean =>
    error instanceof ChangedWhileCopied ||
    ["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
  const same = (a: FileIdentity, b: FileIdentity): boolean => sameIdentity(a, b);
  /**
   * `path`, opened as the entry `stats` describes, still at a path that
   * resolves to itself. Non-blocking, so a FIFO swapped in is opened at once
   * and refused as another inode, never waited on.
   */
  const checkedOpen = <T extends number | undefined>(path: string, stats: FileIdentity, descriptor: T): T => {
    try {
      const opened = descriptor === undefined ? lstatSync(path) : fstatSync(descriptor);
      if (!same(opened, stats) || realpathSync.native(path) !== path || !same(statSync(path), opened)) throw new ChangedWhileCopied(path);
      return descriptor;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
  };
  const copyFile = (from: string, to: string, stats: FileIdentity & { mode: number }): void => {
    const input = checkedOpen(from, stats, openNoFollowSync(from, "read"));
    try {
      if (!fstatSync(input).isFile()) throw new ChangedWhileCopied(from);
      const output = openNoFollowSync(to, "create", { mode: 0o600 });
      try {
        const buffer = Buffer.alloc(64 * 1024);
        for (let read = readSync(input, buffer); read > 0; read = readSync(input, buffer)) {
          for (let written = 0; written < read; ) written += writeSync(output, buffer, written, read - written);
        }
        fchmodSync(output, stats.mode & 0o7777);
      } finally {
        closeSync(output);
      }
    } finally {
      closeSync(input);
    }
  };
  const copy = (from: string, to: string, depth: number): void => {
    let stats;
    try {
      stats = lstatSync(from);
      if (stats.isSymbolicLink()) {
        // On Windows a link is skipped: making one needs Developer Mode or elevation, and a junction
        // (a package manager's) reads back as an absolute path into the live folder, not the copy.
        if (process.platform !== "win32") symlinkSync(readlinkSync(from), to);
      } else if (stats.isFile()) {
        copyFile(from, to, stats);
      } else if (stats.isDirectory()) {
        // Windows opens no directory this way: there the folder is checked by name, with no descriptor to hold.
        const listing = checkedOpen(from, stats, openDirectoryNoFollowSync(from));
        let entries: string[];
        try {
          entries = readdirSync(from);
          // The listing was this folder's, not one an ancestor's link led to meanwhile.
          if (realpathSync.native(from) !== from || !same(statSync(from), stats)) throw new ChangedWhileCopied(from);
        } finally {
          if (listing !== undefined) closeSync(listing);
        }
        mkdirSync(to, { mode: 0o700 });
        for (const entry of entries) {
          if (depth === 0 && entry === CHAT_FOLDERS_TRASH) continue;
          if (depth === 2 && (entry === ".tmp" || entry === ".home")) continue;
          copy(join(from, entry), join(to, entry), depth + 1);
        }
        chmodSync(to, stats.mode & 0o7777);
      }
    } catch (error) {
      if (!skipped(error)) throw error;
    }
  };
  copy(realpathSync.native(source), destination, 0);
}

/** This small startup file contains provider IDs and deadlines, never keys. */
function webProviderConfiguration(directory: string): string | undefined {
  let bytes: Buffer | undefined;
  try {
    bytes = readNoFollowSync(join(directory, "web-providers.json"), { maxBytes: 65_536 });
  } catch (error) {
    if (error instanceof NoFollowReadError)
      throw new TaviError("INVALID_INPUT", "web-providers.json must be a regular file of at most 64 KiB", { cause: error });
    throw error;
  }
  if (bytes === undefined) return undefined;
  const content = bytes.toString("utf8");
  // One line naming the file and its first problem, never the validator's whole report.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TaviError(
      "INVALID_INPUT",
      `${join(directory, "web-providers.json")} is not valid JSON; fix it or remove it (it holds only the search provider choices)`,
    );
  }
  const checked = WebProviderConfigurationSchema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
    throw new TaviError(
      "INVALID_INPUT",
      `${join(directory, "web-providers.json")} is not a valid search provider file${where}: ${issue?.message ?? "invalid"}; fix it or remove it (it holds only the search provider choices)`,
    );
  }
  return content;
}

/**
 * Write a consistent directory snapshot of `dataDirectory` into `outDirectory`.
 *
 * The database always; `artifacts/` unless `includeArtifacts` is false (it can be
 * large); the chats' folders (`chats/`) whenever there are any;
 * `credentials/` only when asked for explicitly, because copying secrets
 * to a second location is a decision the operator has to make on purpose. The
 * manifest states which of the three are there, so a restore is never read as
 * "everything came back" — and `--force` *replaces* the entries a snapshot owns,
 * so a re-taken snapshot cannot keep a previous run's credentials next to a
 * manifest that says they are excluded.
 */
export function createSnapshot(input: {
  readonly dataDirectory: string;
  readonly outDirectory: string;
  readonly buildId: string;
  readonly now: string;
  readonly includeArtifacts: boolean;
  readonly includeCredentials: boolean;
  readonly force: boolean;
}): SnapshotManifest {
  assertProfileFormat(join(input.dataDirectory, SNAPSHOT_DATABASE));
  const selection = webProviderConfiguration(input.dataDirectory);
  // Checked before anything is written, as a symlinked credential is.
  const chats = chatsDirectory(input.dataDirectory);
  const out = input.outDirectory;
  const source = join(input.dataDirectory, SNAPSHOT_DATABASE);
  if (!existsSync(source)) {
    throw new TaviError("INVALID_INPUT", `no database exists at ${JSON.stringify(source)}`);
  }
  // Before anything is written: a snapshot inside the data directory would copy itself, and a restore refuses it.
  assertDistinctDirectories(out, input.dataDirectory);
  if (existsSync(out)) {
    if (readdirSync(out).length > 0 && !input.force) {
      throw new TaviError("INVALID_INPUT", `${JSON.stringify(out)} is not empty; pass --force to overwrite it`, {
        details: { outDirectory: out },
      });
    }
  } else {
    mkdirSync(out, { recursive: true, mode: 0o700 });
  }
  // Replace, not merge: the previous run's `credentials/` surviving next to a
  // manifest that excludes them made a restore copy secrets the manifest denied.
  // Only the entries a snapshot owns are removed, never a foreign file the
  // operator happened to have in the same directory.
  // A copied chat's folder keeps its mode, so a read-only one is made its owner's to go.
  for (const entry of SNAPSHOT_ENTRIES) removeTreeSync(join(out, entry));

  const target = join(out, SNAPSHOT_DATABASE);
  withReadOnly(source, (db) => db.prepare("VACUUM INTO ?").run(target));
  // Metadata must describe the completed SQLite snapshot, even if its live
  // source changes before metadata is collected.
  // Read once, so what the manifest says it includes and what it says it left out agree.
  const pluginsPresent = existsSync(join(input.dataDirectory, "plugins"));
  // What the manifest says it includes is what is copied: a directory with no artifacts yet carries none.
  const artifactsCopied = input.includeArtifacts && existsSync(join(input.dataDirectory, "artifacts"));
  const manifest = withReadOnly(target, (db) => {
    // The manifest lists every table the snapshot carries, FTS internals
    // included — a database copy has them all.
    const tables = [
      ...exportableTables(db),
      ...FTS_SHADOW_TABLES.filter(
        (name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined,
      ),
    ].sort();
    const migrations = (
      db.prepare("SELECT migration_id FROM tavi_schema_migrations ORDER BY migration_id").all() as {
        migration_id: string;
      }[]
    ).map((row) => row.migration_id);
    const meta = db.prepare("SELECT value FROM tavi_meta WHERE key = ?").get(SAVER_SCHEMA_VERSION_KEY) as { value: string } | undefined;
    return {
      profileFormat: PROFILE_FORMAT,
      createdAt: input.now,
      buildId: input.buildId,
      dataDirectory: input.dataDirectory,
      applicationTables: tables,
      migrations,
      rowCounts: countRows(db, tables),
      saverSchemaVersion: meta?.value ?? null,
      // Installed plugins always travel with the database that records them: a
      // restore without their files would list enabled plugins that cannot load.
      // The chats' folders travel too: `tavi reset` erases them, so a
      // snapshot is the one copy tavi makes of a chat's work.
      includes: {
        artifacts: artifactsCopied,
        credentials: input.includeCredentials,
        plugins: pluginsPresent,
        webProviders: selection !== undefined,
        chats,
      },
      excluded: [
        ...(input.includeArtifacts ? [] : ["artifacts/"]),
        ...(input.includeCredentials ? [] : ["credentials/"]),
        ...CHATS_EXCLUDED,
        // A plugin worker's rebuildable data: its home's own data travels, its cache does not.
        ...(pluginsPresent ? [PLUGIN_CACHE_EXCLUDED] : []),
        // Never copied: the daemon's own rotated log is diagnostic, and a
        // snapshot is for restoring a working directory. Named so a restore is
        // not read as "everything came back".
        "credentials.key",
        "provider-bindings.key",
        "logs/",
        "owner.process.json",
        "owner.lock",
      ],
    } satisfies SnapshotManifest;
  });

  // Directory modes: the snapshot may hold credentials, so it is never
  // world-readable, and the database itself is 0600 like the original.
  chmodSync(out, 0o700);
  chmodSync(target, 0o600);
  if (artifactsCopied) cpSync(join(input.dataDirectory, "artifacts"), join(out, "artifacts"), { recursive: true, dereference: false });
  if (input.includeCredentials) {
    const credentials = join(input.dataDirectory, "credentials");
    if (existsSync(credentials)) copyPrivateTree(credentials, join(out, "credentials"));
  }
  if (manifest.includes.plugins === true) {
    const plugins = join(input.dataDirectory, "plugins");
    // A worker's SQLite store may be written while this runs (a jobs worker never idles out): copied file by
    // file with its WAL it could be torn, so each is snapshotted with VACUUM INTO, as the core database is.
    const stores: string[] = [];
    cpSync(plugins, join(out, "plugins"), {
      recursive: true,
      dereference: false,
      filter: (source) => {
        if (isPluginCache(plugins, source)) return false;
        if (isSqliteSidecar(source)) return false;
        if (!isSqliteFile(source)) return true;
        stores.push(source);
        return false;
      },
    });
    for (const store of stores) {
      const copy = join(out, "plugins", relative(plugins, store));
      mkdirSync(dirname(copy), { recursive: true });
      withReadOnly(store, (db) => db.prepare("VACUUM INTO ?").run(copy));
      chmodSync(copy, 0o600);
    }
  }
  if (chats) copyChats(join(input.dataDirectory, "chats"), join(out, "chats"));
  if (selection !== undefined) writeFileSync(join(out, "web-providers.json"), selection, { mode: 0o600 });
  writeFileSync(join(out, SNAPSHOT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/** Whether a regular file is an SQLite database, by its header. */
function isSqliteFile(path: string): boolean {
  if (!lstatSync(path).isFile()) return false;
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    return readSync(fd, header, 0, 16, 0) === 16 && header.toString("latin1") === "SQLite format 3\0";
  } finally {
    closeSync(fd);
  }
}

/** A database's WAL, shared-memory or rollback journal, folded into its snapshot rather than copied. */
function isSqliteSidecar(path: string): boolean {
  const base = /^(.*)-(wal|shm|journal)$/.exec(path)?.[1];
  return base !== undefined && existsSync(base) && isSqliteFile(base);
}

/** How a snapshot's manifest names the plugin caches it leaves out. */
const PLUGIN_CACHE_EXCLUDED = "plugins/*/home/cache/";

/**
 * Whether `source` is in, or is, a plugin worker's `home/cache/` under
 * `plugins`: data the
 * plugin can fetch again, which a backup leaves out. Its other home data — a
 * plugin's store of what a person saved — is copied.
 */
export function isPluginCache(plugins: string, source: string): boolean {
  const parts = relative(plugins, source).split(sep);
  return parts.length >= 3 && parts[1] === "home" && parts[2] === "cache";
}

export interface ExportResult {
  readonly directory: string;
  readonly files: readonly { readonly table: string; readonly rows: number; readonly bytes: number }[];
}

/**
 * One NDJSON row.
 *
 * BLOB columns are base64-wrapped under `$blob` rather than refused: the pinned
 * saver's `checkpoints`/`writes` hold the graph's BLOBs and exist in every
 * composed directory, so refusing them (the first version did) made `tavi export`
 * fail on every directory that had ever run a task. A tagged wrapper keeps the
 * file valid NDJSON and the value recoverable, and cannot collide with a real
 * column value, which is never an object.
 */
function serializeRow(row: Record<string, unknown>): string {
  // Built key by key rather than through `JSON.stringify`'s replacer: a
  // better-sqlite3 BLOB is a `Buffer`, and `JSON.stringify` calls
  // `Buffer.prototype.toJSON` *before* the replacer, so a replacer only ever
  // sees `{type: "Buffer", data: [...]}` and the `$blob` tag never appears.
  const encoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    encoded[key] = value instanceof Uint8Array ? { $blob: Buffer.from(value).toString("base64") } : value;
  }
  return JSON.stringify(encoded);
}

/**
 * Write every application table to `<out>/<table>.ndjson`.
 *
 * The portable counterpart to the snapshot: a snapshot restores *this* build's
 * schema, while NDJSON can be read by anything, which is what makes it an export
 * rather than a copy. Read-only, so it too is safe while an owner runs. The FTS5
 * shadow tables are excluded: they are SQLite's index internals for
 * `tavi_memory_fts` and `tavi_memory_fts_stem`, they hold BLOBs, and they can be
 * rebuilt from `tavi_memory_records`, which *is* exported.
 */
export function exportTables(input: {
  readonly dataDirectory: string;
  readonly outDirectory: string;
  readonly force: boolean;
}): ExportResult {
  const out = input.outDirectory;
  assertDistinctDirectories(out, input.dataDirectory, "the export directory");
  if (existsSync(out)) {
    if (readdirSync(out).length > 0 && !input.force) {
      throw new TaviError("INVALID_INPUT", `${JSON.stringify(out)} is not empty; pass --force to overwrite it`);
    }
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const files = withReadOnly(join(input.dataDirectory, SNAPSHOT_DATABASE), (db) => {
    db.exec("BEGIN");
    const written: { table: string; rows: number; bytes: number }[] = [];
    for (const table of exportableTables(db)) {
      let rows = 0;
      let bytes = 0;
      const fd = openSync(join(out, `${table}.ndjson`), "w", 0o600);
      try {
        for (const row of db.prepare(`SELECT * FROM "${table}"`).iterate() as Iterable<Record<string, unknown>>) {
          const encoded = Buffer.from(`${serializeRow(row)}\n`);
          let offset = 0;
          while (offset < encoded.byteLength) offset += writeSync(fd, encoded, offset, encoded.byteLength - offset);
          rows++;
          bytes += encoded.byteLength;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      written.push({ table, rows, bytes });
    }
    db.exec("ROLLBACK");
    return written;
  });
  return { directory: out, files };
}

export interface RestoreResult {
  readonly restoredFrom: string;
  readonly movedAside: string | null;
  readonly migrations: readonly string[];
  readonly restoredFiles: readonly string[];
  /** Entries present in the snapshot that its manifest says it does not carry. */
  readonly ignored: readonly string[];
  /** Where each directory the restore replaced was moved, as `movedAside` is for the database. */
  readonly directoriesMovedAside: Readonly<Partial<Record<"artifacts" | "chats" | "plugins", string>>>;
  /**
   * The moved-aside database's memory deletion journal, carried over: `stayForgotten`, how many forgotten records the restored database
   * did not know were forgotten (the next start forgets them again); or
   * `unchecked`, when the moved-aside database could not be read, with the
   * snapshot's time (absent for a snapshot without a manifest). Absent when
   * nothing was moved aside: a restore into an empty directory has nothing to
   * reconcile.
   */
  readonly forgottenMemory?: { readonly stayForgotten: number } | { readonly unchecked: true; readonly snapshotAt?: string };
}

/** Whether `table` has `column` in `db`. */
function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { readonly name: string }[]).some((entry) => entry.name === column);
}

/**
 * Carry the deletion journal of the database a restore replaces into the
 * restored one (invariant 9): every `tavi_memory_deletions`
 * row it lacks, pending and complete alike (each is a forget the person
 * asked for), and each scope's revocation generation raised to the larger of
 * the two. The rows hold no body, so nothing erased is copied. The worker's
 * next start forgets every record a row names that is not yet deleted.
 * Answers how many records the copied rows name that the restored copy holds
 * and has not erased — what the next start forgets again; a record made after
 * the snapshot, or already erased in it, is not counted — or `undefined` when
 * the replaced database is not a database or is corrupt. Any other failure to
 * read it (busy, locked, unreadable) is thrown: the restore stops, and nothing
 * is said to be unchecked that a retry would check.
 */
function carryDeletionJournal(replaced: string, restored: string): number | undefined {
  const DatabaseCtor = loadBetterSqlite3();
  let rows: readonly Record<string, unknown>[];
  let generations: readonly { readonly scope_key: string; readonly revocation_generation: number }[];
  let waitsFor: boolean;
  try {
    ({ rows, generations, waitsFor } = withReadOnly(replaced, (db) => {
      const has = (name: string): boolean =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
      return {
        rows: has("tavi_memory_deletions")
          ? (db.prepare("SELECT * FROM tavi_memory_deletions ORDER BY requested_at, deletion_id").all() as Record<string, unknown>[])
          : [],
        generations: has("tavi_memory_scope_generations")
          ? (db.prepare("SELECT scope_key, revocation_generation FROM tavi_memory_scope_generations").all() as {
              scope_key: string;
              revocation_generation: number;
            }[])
          : [],
        waitsFor: has("tavi_memory_deletions") && hasColumn(db, "tavi_memory_deletions", "pending_providers_json"),
      };
    }));
  } catch (error) {
    // A file that was the live database a moment ago and is not one, or is corrupt: no later retry helps.
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (typeof code === "string" && (code.startsWith("SQLITE_NOTADB") || code.startsWith("SQLITE_CORRUPT"))) return undefined;
    throw error;
  }
  // The staged copy is written directly, as `VACUUM INTO` wrote it: never opened the ordinary way, which would
  // migrate it and take the ownership lock.
  const db = new DatabaseCtor(restored, { fileMustExist: true });
  try {
    const records = new Set<string>();
    // The providers a pending row waits for travel with it when both databases know them: a row
    // naming none would be given the providers its forget goes to now, and none, after a switch to the built-in, completes it unsent.
    const providers = waitsFor && hasColumn(db, "tavi_memory_deletions", "pending_providers_json");
    db.transaction(() => {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO tavi_memory_deletions
           (deletion_id, record_id, scope_key, deletion_generation, requested_by, reason, requested_at, cleanup_status, cleaned_at${providers ? ", pending_providers_json" : ""})
         VALUES (@deletion_id, @record_id, @scope_key, @deletion_generation, @requested_by, @reason, @requested_at, @cleanup_status, @cleaned_at${providers ? ", @pending_providers_json" : ""})`,
      );
      for (const row of rows) if (insert.run(row).changes > 0) records.add(String(row["record_id"]));
      const raise = db.prepare(
        `INSERT INTO tavi_memory_scope_generations (scope_key, revocation_generation) VALUES (?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET revocation_generation = max(revocation_generation, excluded.revocation_generation)`,
      );
      for (const generation of generations) raise.run(generation.scope_key, generation.revocation_generation);
    })();
    // Only what the next start forgets again: a record the restored copy holds and has not erased.
    const live = db.prepare("SELECT 1 FROM tavi_memory_records WHERE record_id = ? AND status <> 'deleted'");
    return [...records].filter((recordId) => live.get(recordId) !== undefined).length;
  } finally {
    db.close();
  }
}

/** Marks every MCP tree index in the staged copy stale (written directly, never migrated or locked, as the journal is). */
function markMcpIndexesStale(staged: string): void {
  const DatabaseCtor = loadBetterSqlite3();
  const db = new DatabaseCtor(staged, { fileMustExist: true });
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tavi_mcp_versions'").get() !== undefined;
    if (has) db.prepare("UPDATE tavi_mcp_versions SET tree_index_stale = 1").run();
  } finally {
    db.close();
  }
}

/**
 * Replace `dataDirectory`'s database (and, when the snapshot carries them,
 * artifacts and credentials) with a snapshot's contents.
 *
 * Validation happens **before** anything moves: the snapshot must be a readable
 * SQLite database, must carry `tavi_schema_migrations`, and every migration it
 * records must be one this build ships — the same rule that stops an older build
 * opening a newer schema, applied to a *restored* file, which is
 * otherwise a way to smuggle exactly that state past the guard.
 *
 * The new database is staged inside the target directory and `rename`d into
 * place, which is atomic on one filesystem: a killed process or a full disk then
 * leaves the old database where it was rather than a truncated file. The old one
 * is moved aside, never deleted, and put back if the rename fails.
 */
export function restoreSnapshot(input: {
  readonly snapshotDirectory: string;
  readonly dataDirectory: string;
  readonly now: string;
}): RestoreResult {
  assertDistinctDirectories(input.snapshotDirectory, input.dataDirectory);
  const snapshotDatabase = join(input.snapshotDirectory, SNAPSHOT_DATABASE);
  // The manifest decides what is carried, not the directory's contents: a
  // snapshot re-taken with `--force` kept a previous run's credentials next to a
  // manifest that excluded them, and the restore copied them anyway.
  //
  // The profile format, the manifest's and the database's, is checked before the migration ledger: a snapshot of
  // another format (a development build's, from before the baseline) carries migration ids this build does not know,
  // and is refused for its format rather than as "written by a newer build".
  const manifest = readSnapshotManifest(input.snapshotDirectory);
  if (manifest?.profileFormat !== undefined && manifest.profileFormat !== PROFILE_FORMAT)
    throw new TaviError("CONFLICT", "Snapshot profile format is incompatible");
  assertProfileFormat(snapshotDatabase);
  try {
    assertProfileFormat(join(input.dataDirectory, SNAPSHOT_DATABASE));
  } catch (error) {
    // A database that is not one, or is corrupt, is what a restore replaces (it is moved aside, never deleted). Any
    // other failure to open it — locked, not allowed, an I/O error — refuses, as does a readable one of another profile.
    const code = (error as { readonly code?: unknown }).code;
    if (code !== "SQLITE_NOTADB" && code !== "SQLITE_CORRUPT") throw error;
  }
  const migrations = withReadOnly(snapshotDatabase, (db) => {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tavi_schema_migrations'").get() as
      | { name: string }
      | undefined;
    if (table === undefined) {
      throw new TaviError("INVALID_INPUT", "the snapshot is not a tavi data directory: it has no migration ledger", {
        details: { snapshot: input.snapshotDirectory },
      });
    }
    return (
      db.prepare("SELECT migration_id FROM tavi_schema_migrations ORDER BY migration_id").all() as {
        migration_id: string;
      }[]
    ).map((row) => row.migration_id);
  });
  const known = new Set(MIGRATIONS.map((migration) => migration.id));
  const unknown = migrations.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new TaviError(
      "UNAVAILABLE",
      `the snapshot was written by a newer build of tavi (${unknown.join(", ")}); this build cannot restore it`,
      { details: { unknownMigrations: unknown } },
    );
  }

  const selection = manifest?.includes.webProviders === true ? webProviderConfiguration(input.snapshotDirectory) : undefined;
  if (manifest?.includes.webProviders === true && selection === undefined)
    throw new TaviError("INVALID_INPUT", "Snapshot is missing web-providers.json");
  // A snapshot with no `chats/` (there were none to copy) leaves the live
  // `chats/` as it is, never removed.
  const wanted = (directory: "artifacts" | "chats" | "credentials" | "plugins"): boolean => {
    if (!existsSync(join(input.snapshotDirectory, directory))) return false;
    return manifest === null ? true : manifest.includes[directory] === true;
  };
  // Refused before anything moves, as an unknown migration is.
  if (wanted("chats")) chatsDirectory(input.snapshotDirectory);
  const ignored = (["artifacts", "chats", "credentials", "plugins"] as const).filter(
    (directory) => existsSync(join(input.snapshotDirectory, directory)) && !wanted(directory),
  );

  const target = join(input.dataDirectory, SNAPSHOT_DATABASE);
  mkdirSync(input.dataDirectory, { recursive: true, mode: 0o700 });
  const staged = `${target}.restore-${process.pid}`;
  rmSync(staged, { force: true });
  try {
    // Through SQLite, so a snapshot directory that has a `-wal` (a hand-made copy
    // of a live directory) restores its newest commits instead of dropping them
    // silently, and the read is one consistent snapshot rather than a file copy
    // racing a writer.
    withReadOnly(snapshotDatabase, (db) => {
      db.prepare("VACUUM INTO ?").run(staged);
    });
    chmodSync(staged, 0o600);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  // What was forgotten since the snapshot stays forgotten: the journal of the database being replaced is
  // carried into the staged copy before it is put in place. Nothing replaced, nothing to reconcile.
  let forgottenMemory: RestoreResult["forgottenMemory"];
  if (existsSync(target)) {
    let carried: number | undefined;
    try {
      carried = carryDeletionJournal(target, staged);
    } catch (error) {
      rmSync(staged, { force: true });
      throw error;
    }
    forgottenMemory =
      carried !== undefined
        ? { stayForgotten: carried }
        : { unchecked: true, ...(manifest?.createdAt === undefined ? {} : { snapshotAt: manifest.createdAt }) };
  }
  // An MCP server's tree index was taken against files the restore may replace: every one
  // is marked stale, so the next start re-hashes each tree in full. Tool states stay as reviewed.
  try {
    markMcpIndexesStale(staged);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  try {
    // `VACUUM INTO` writes and closes the file; fsync before the rename so the
    // directory entry cannot point at a file whose pages are still in cache.
    flushFile(staged);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }

  let movedAside: string | null = null;
  if (existsSync(target)) {
    // Never delete an existing database: an operator restoring the wrong snapshot
    // must still be able to get yesterday's directory back.
    const stamp = input.now.replaceAll(/[:.]/g, "-");
    movedAside = `${target}.pre-restore-${stamp}`;
    // A second restore in the same millisecond would otherwise overwrite the
    // first one's only copy.
    let suffix = 1;
    while (existsSync(movedAside)) {
      movedAside = `${target}.pre-restore-${stamp}-${suffix}`;
      suffix += 1;
    }
    renameHeld(target, movedAside);
    // The WAL sidecars belong to the database that was just moved, and go with it: its WAL may hold commits.
    for (const sidecar of ["-wal", "-shm"]) {
      if (existsSync(`${target}${sidecar}`)) renameHeld(`${target}${sidecar}`, `${movedAside}${sidecar}`);
    }
  }
  try {
    renameHeld(staged, target);
  } catch (error) {
    // Put the previous database back rather than leaving the directory with no
    // `tavi.sqlite` at all, and name where it went if even that fails.
    const cause = TaviError.from(error);
    let note = "";
    if (movedAside !== null) {
      try {
        renameHeld(movedAside, target);
        for (const sidecar of ["-wal", "-shm"]) {
          if (existsSync(`${movedAside}${sidecar}`)) renameHeld(`${movedAside}${sidecar}`, `${target}${sidecar}`);
        }
        note = " (the previous database was put back)";
      } catch {
        note = ` (the previous database is at ${movedAside})`;
      }
    }
    throw new TaviError(cause.code, `the restored database could not be put in place${note}: ${cause.message}`);
  }

  const restoredFiles: string[] = [];
  // Keep the previous selections and private generation key beside the old database.
  // Restored credentials get fresh bindings and require new binding-specific approvals.
  for (const entry of ["web-providers.json", "provider-bindings.key"]) {
    const live = join(input.dataDirectory, entry);
    if (!existsSync(live)) continue;
    const stamp = input.now.replaceAll(/[:.]/g, "-");
    let aside = `${live}.pre-restore-${stamp}`;
    for (let suffix = 1; existsSync(aside); suffix += 1) aside = `${live}.pre-restore-${stamp}-${suffix}`;
    renameHeld(live, aside);
  }
  if (selection !== undefined) {
    writeFileSync(join(input.dataDirectory, "web-providers.json"), selection, { mode: 0o600 });
    restoredFiles.push("web-providers.json");
  }
  const directoriesMovedAside: Partial<Record<"artifacts" | "chats" | "plugins", string>> = {};
  for (const directory of ["artifacts", "chats", "credentials", "plugins"] as const) {
    if (!wanted(directory)) continue;
    // Plugin snapshots are replaced, not overlaid: a file left from a later install of the
    // same version would change its hash and the restored plugin would be refused. The
    // previous directory is kept aside, as the database is. The chats' folders are too:
    // a copy over the live tree would write through a link a chat's shell planted there
    // (I-nofollow), and would mix two directories' files in one chat's folder. Artifacts
    // too: a copy over them overwrote a same-named file with no copy to undo it.
    const live = join(input.dataDirectory, directory);
    if (directory !== "credentials" && present(live)) {
      const stamp = input.now.replaceAll(/[:.]/g, "-");
      let aside = `${live}.pre-restore-${stamp}`;
      for (let suffix = 1; existsSync(aside); suffix += 1) aside = `${live}.pre-restore-${stamp}-${suffix}`;
      renameHeld(live, aside);
      directoriesMovedAside[directory] = aside;
    }
    if (directory === "chats") {
      try {
        copyChats(join(input.snapshotDirectory, directory), live);
      } catch (error) {
        // A copy that stopped partway leaves a partial `chats/`: name where the previous one is.
        const cause = TaviError.from(error);
        const note = directoriesMovedAside.chats === undefined ? "" : ` (the previous chats/ is at ${directoriesMovedAside.chats})`;
        throw new TaviError(cause.code, `the snapshot's chats/ could not be restored${note}: ${cause.message}`);
      }
      restoredFiles.push("chats/");
      continue;
    }
    cpSync(join(input.snapshotDirectory, directory), join(input.dataDirectory, directory), {
      recursive: true,
      force: true,
      dereference: false,
    });
    restoredFiles.push(`${directory}/`);
  }
  return {
    restoredFrom: input.snapshotDirectory,
    movedAside,
    migrations,
    restoredFiles,
    ignored,
    directoriesMovedAside,
    ...(forgottenMemory === undefined ? {} : { forgottenMemory }),
  };
}

/** Reads the ownership record without blocking the application's event loop. */
export function readRecordedOwner(dataDirectory: string): unknown {
  try {
    const db = loadBetterSqlite3()(join(dataDirectory, "owner.lock"), { readonly: true, timeout: 0 });
    try {
      return db.prepare("SELECT session_id, pid, acquired_at FROM tavi_owner").get() ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
