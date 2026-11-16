/** What `sameIdentity` reads of a file's status: any `Stats` has it. */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

/**
 * Whether two statuses are of one file: the same device and inode. On
 * Windows a file id is 64 bits, which a number keeps only to 2^53, so two
 * files whose ids differ in their low bits can read as one there: their
 * creation times must match too.
 */
export function sameIdentity(a: FileIdentity, b: FileIdentity, platform: NodeJS.Platform = process.platform): boolean {
  return a.dev === b.dev && a.ino === b.ino && (platform !== "win32" || a.birthtimeMs === b.birthtimeMs);
}
