import { z } from "zod";

/**
 * A plugin's own messages (`messages` in `locales/<lang>.json`, `ctx.t`, and a UI
 * contribution's `init`), apart from both the registry's schemas and the UI's,
 * which each check them: one shape and one set of bounds for both.
 */

/** The most messages one language pack, or a contribution's words in one language, carries. */
export const PLUGIN_MESSAGES_MAX = 1000;
/** The longest message, or plural form of one. */
export const PLUGIN_MESSAGE_MAX_CHARS = 2000;

/** A message's key, as `ctx.t(key)` takes it. */
export const PLUGIN_MESSAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const PluginMessageKeySchema = z
  .string()
  .regex(PLUGIN_MESSAGE_KEY_PATTERN, "a message key is letters, digits, dots, dashes and underscores");

const PluginMessageTextSchema = z.string().trim().min(1).max(PLUGIN_MESSAGE_MAX_CHARS);

/** One of a plugin's own messages: a string with `{param}`s, or a plural object chosen by the count. */
export const PluginMessageSchema = z.union([
  PluginMessageTextSchema,
  z.strictObject({
    zero: PluginMessageTextSchema.optional(),
    one: PluginMessageTextSchema.optional(),
    two: PluginMessageTextSchema.optional(),
    few: PluginMessageTextSchema.optional(),
    many: PluginMessageTextSchema.optional(),
    other: PluginMessageTextSchema,
  }),
]);
