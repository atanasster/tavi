import { z } from "zod";

/**
 * A plugin's id and version shapes, apart from both the registry's schemas
 * and the UI's, which each need them: an id is dotted lower-case segments, a
 * version a semantic version — both become directory names.
 */

/** Dotted lower-case segments, such as `acme.weather` (or a built-in's `tavi.browserview`). */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

// At most 32 characters (a tool's version bound), and a lower-case prerelease only: versions are
// directory names, and on a case-insensitive filesystem 1.0.0-A and 1.0.0-a would be one directory.
export const PluginVersionSchema = z
  .string()
  .max(32)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9a-z]+(?:\.[0-9a-z]+)*)?$/, "versions use semantic versioning, such as 1.2.0 (a prerelease in lower case)");

/**
 * Semantic-version precedence of two plugin versions: negative when `a` is older, positive when
 * newer, zero when equal. A prerelease sorts before its release; numeric identifiers compare as
 * numbers and sort before alphanumeric ones.
 */
export function comparePluginVersions(a: string, b: string): number {
  const [aCore = "", aPre] = splitVersion(a);
  const [bCore = "", bPre] = splitVersion(b);
  const aParts = aCore.split(".").map(Number);
  const bParts = bCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre === undefined || bPre === undefined) return aPre === bPre ? 0 : aPre === undefined ? 1 : -1;
  const aIds = aPre.split("."),
    bIds = bPre.split(".");
  for (let index = 0; index < Math.max(aIds.length, bIds.length); index += 1) {
    const x = aIds[index],
      y = bIds[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x),
      yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function splitVersion(version: string): [string, string | undefined] {
  const dash = version.indexOf("-");
  return dash === -1 ? [version, undefined] : [version.slice(0, dash), version.slice(dash + 1)];
}
