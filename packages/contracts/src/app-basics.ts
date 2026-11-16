import { z } from "zod";

/**
 * The words an app presents itself in,
 * kept apart so a channel's descriptor can present its app too without the
 * whole connected-apps contract (core names no channel).
 */

export const APP_CATEGORIES = [
  "calendar",
  "email",
  "chat",
  "notes",
  "tasks",
  "files",
  "home",
  "dev",
  "business",
  "search",
  "other",
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];
/** What a tool or a scope does, in a person's terms; `send` reaches other people (why a call that emails attendees is `external`). */
export const APP_ACCESS = ["read", "change", "send"] as const;
export type AppAccess = (typeof APP_ACCESS)[number];

/** One scope, in words a person reads before consenting. */
export const AppScopeSchema = z.strictObject({
  scope: z.string().min(1).max(256),
  says: z.string().min(1).max(160),
  access: z.enum(APP_ACCESS),
  /** May be unticked under Google's granular consent; the app still works without it. */
  optional: z.boolean().default(false),
});
export type AppScope = z.infer<typeof AppScopeSchema>;
