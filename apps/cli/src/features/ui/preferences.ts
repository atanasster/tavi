import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EMPTY_SESSION_PREFERENCES,
  SessionPreferencesSchema,
  TaviError,
  type SessionPreferences,
  type UiPreferencesPayload,
  type UiPreferencesResult,
} from "@tavi/contracts";
import { sha256Hex, writeJsonAtomic } from "@tavi/node-kit";

/**
 * The sessions panel's pins, archive and seen marks, kept per workspace under
 * the data directory (`ui/<workspace hash>.json`) the way the messaging
 * settings are: written whole through a rename, so a crash mid-write leaves
 * the previous file rather than half of a new one.
 */
const preferencesPath = (directory: string, workspaceId: string) => join(directory, "ui", `${sha256Hex(workspaceId).slice(0, 32)}.json`);

export function readSessionPreferences(directory: string, workspaceId: string): SessionPreferences {
  try {
    return SessionPreferencesSchema.parse(JSON.parse(readFileSync(preferencesPath(directory, workspaceId), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_SESSION_PREFERENCES };
    throw new TaviError("INVALID_INPUT", "Saved session preferences could not be read.");
  }
}

export function uiPreferencesCommand(directory: string, input: UiPreferencesPayload): { ok: true; result: UiPreferencesResult } {
  if (input.action === "get") return { ok: true, result: { preferences: readSessionPreferences(directory, input.workspaceId) } };
  mkdirSync(join(directory, "ui"), { recursive: true, mode: 0o700 });
  const path = preferencesPath(directory, input.workspaceId);
  writeJsonAtomic(path, input.preferences);
  return { ok: true, result: { preferences: input.preferences } };
}
