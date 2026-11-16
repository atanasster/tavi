/** The oldest Node.js the CLI supports: the floor `engines.node` in its package.json declares. */
export const MIN_NODE_VERSION = "22.22.2";

/** `doctor`'s `node` section: the Node.js running the CLI, the floor, and whether it is met. */
export interface NodeVersionReport {
  readonly version: string;
  readonly required: string;
  readonly ok: boolean;
}

/** Whether `version` (`major.minor.patch`) is at least `MIN_NODE_VERSION`. */
export function nodeVersionReport(version: string = process.versions.node): NodeVersionReport {
  const parts = (text: string) => text.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const have = parts(version);
  const need = parts(MIN_NODE_VERSION);
  let ok = true;
  for (let index = 0; index < need.length; index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) {
      ok = difference > 0;
      break;
    }
  }
  return { version, required: `>=${MIN_NODE_VERSION}`, ok };
}
