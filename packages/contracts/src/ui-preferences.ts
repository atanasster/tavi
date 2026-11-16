import { z } from "zod";

/**
 * What the page's sessions panel remembers per workspace — which sessions the
 * reader pinned, which they archived, and the last update they saw of each —
 * kept by the owner rather than the browser: `tavi ui` serves on a fresh
 * loopback port each start, and a browser's storage is per origin, port
 * included, so anything kept there comes back empty after a restart.
 */
export const SESSION_PREFERENCE_LIMIT = 2000;
const taskIdList = z.array(z.string().min(1).max(128)).max(SESSION_PREFERENCE_LIMIT);
export const SessionPreferencesSchema = z
  .object({
    pins: taskIdList,
    archived: taskIdList,
    seen: z
      .record(z.string().min(1).max(128), z.string().min(1).max(64))
      .refine((value) => Object.keys(value).length <= SESSION_PREFERENCE_LIMIT, `At most ${SESSION_PREFERENCE_LIMIT} seen entries`),
  })
  .strict();
export type SessionPreferences = z.infer<typeof SessionPreferencesSchema>;
export const EMPTY_SESSION_PREFERENCES: SessionPreferences = { pins: [], archived: [], seen: {} };

export const UiPreferencesPayloadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), workspaceId: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal("set"), workspaceId: z.string().min(1).max(128), preferences: SessionPreferencesSchema }).strict(),
]);
export type UiPreferencesPayload = z.infer<typeof UiPreferencesPayloadSchema>;
export interface UiPreferencesResult {
  preferences: SessionPreferences;
}
