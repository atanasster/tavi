import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The commit a source checkout of Tavi is at, short, read from `.git` without
 * running git: what `tavi --version` adds to the version, since a build from
 * a clone is told apart by its commit. Undefined outside a checkout — an
 * install under `node_modules` is not one, whatever repository holds it — or
 * when `.git` cannot be read. A worktree's `.git` file and packed refs are followed.
 */
export function checkoutRevision(start: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  try {
    if (resolve(start).split(sep).includes("node_modules")) return undefined;
    const gitDirectory = findGitDirectory(start);
    if (gitDirectory === undefined) return undefined;
    const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
    const reference = /^ref:\s*(\S+)$/.exec(head)?.[1];
    const commit = reference === undefined ? head : resolveReference(gitDirectory, reference);
    return commit !== undefined && /^[0-9a-f]{40,64}$/.test(commit) ? commit.slice(0, 12) : undefined;
  } catch {
    return undefined;
  }
}

/** The `.git` directory at or above `start`: a directory, or a worktree's `gitdir:` file. */
function findGitDirectory(start: string): string | undefined {
  for (let directory = resolve(start); ; directory = dirname(directory)) {
    const candidate = join(directory, ".git");
    // lstat, so a broken `.git` link stops the walk here rather than at a parent repository.
    if (lstatSync(candidate, { throwIfNoEntry: false }) !== undefined) {
      if (!existsSync(candidate)) return undefined;
      if (statSync(candidate).isDirectory()) return candidate;
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, "utf8"))?.[1]?.trim();
      return pointer === undefined ? undefined : isAbsolute(pointer) ? pointer : resolve(directory, pointer);
    }
    if (dirname(directory) === directory) return undefined;
  }
}

/** A ref's commit: its loose file, else `packed-refs`, in the worktree's directory or the common one. */
function resolveReference(gitDirectory: string, reference: string): string | undefined {
  const common = existsSync(join(gitDirectory, "commondir"))
    ? resolve(gitDirectory, readFileSync(join(gitDirectory, "commondir"), "utf8").trim())
    : gitDirectory;
  for (const directory of [gitDirectory, common]) {
    const loose = join(directory, reference);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
  }
  const packed = join(common, "packed-refs");
  if (!existsSync(packed)) return undefined;
  for (const line of readFileSync(packed, "utf8").split("\n")) {
    const [commit, name] = line.trim().split(" ");
    if (name === reference) return commit;
  }
  return undefined;
}
