import { existsSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { TaviError } from "@tavi/contracts";

/*
 * Apart from `ownership.ts`, which loads the database driver: the CLI checks a
 * data directory's filesystem on its own thread, where the driver is never loaded.
 */

/** `statfs`'s type for a 9p mount: on WSL, a Windows drive under `/mnt`. */
const V9FS_MAGIC = 0x01021997;

/**
 * Refuse a data directory on a 9p mount (on WSL, a Windows drive such as
 * `/mnt/c`), before anything is created in it: file modes there are not kept,
 * so a private directory cannot be made, and SQLite's shared memory for its
 * write-ahead log is not safe over 9p. Checked on the nearest folder that
 * exists, since the data directory may not yet. Linux only.
 */
export function assertLocalFilesystem(
  dataDirectory: string,
  options: { readonly platform?: NodeJS.Platform; readonly statfs?: (path: string) => { readonly type: number } } = {},
): void {
  if ((options.platform ?? process.platform) !== "linux") return;
  let existing = resolve(dataDirectory);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  let type: number;
  try {
    type = (options.statfs ?? statfsSync)(existing).type;
  } catch {
    return;
  }
  if (type !== V9FS_MAGIC) return;
  throw new TaviError(
    "INVALID_INPUT",
    `Data directory ${dataDirectory} is on a Windows drive or another 9p mount, where file permissions are not kept ` +
      "and the database is not safe. Put the data directory on the Linux filesystem (the default ~/.local/share/tavi, for instance).",
    { details: { filesystem: "9p" } },
  );
}
