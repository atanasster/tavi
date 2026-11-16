import { z } from "zod";

import { IdSchema } from "./ids.js";

/**
 * A typed service token.
 *
 * The token carries its TypeScript interface in the `__service` phantom field so
 * the plugin host can hand a plugin a typed dependency object without an
 * unrestricted global service locator (responsibility 1).
 */
export interface ServiceToken<T> {
  readonly id: string;
  /** Compile-time brand only; never read at runtime. */
  readonly __service?: T;
}

/** Service ids are stable, namespaced and versionless; releases replace code, not tokens. */
export const SERVICE_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export function createServiceToken<T>(id: string): ServiceToken<T> {
  if (!SERVICE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid service token id ${JSON.stringify(id)}: expected dotted lowercase segments such as "tavi.persistence"`);
  }
  return Object.freeze({ id }) as ServiceToken<T>;
}

/**
 * Plugin identity. Declared statically so composition can be validated before
 * any plugin starts (responsibility 2).
 */
export const PluginIdSchema = z.string().min(1).max(128).regex(SERVICE_ID_PATTERN, "plugin ids use dotted lowercase segments");

export type PluginId = z.infer<typeof PluginIdSchema>;

export const PluginPhaseSchema = z.enum(["registered", "starting", "ready", "stopping", "stopped", "failed"]);
export type PluginPhase = z.infer<typeof PluginPhaseSchema>;

export interface PluginStatus {
  readonly id: PluginId;
  readonly phase: PluginPhase;
  /** Present only when `phase === "failed"`. */
  readonly error?: unknown;
  /** Number of disposers completed at shutdown. */
  readonly disposersRun?: number;
}

/** Shape of a plugin id used by dependency validation. */
export function isPluginId(value: unknown): value is PluginId {
  return typeof value === "string" && PluginIdSchema.safeParse(value).success;
}

/** Exported for tests and diagnostics; the runner validates against this. */
export const PluginRecordKeySchema = z.object({ id: PluginIdSchema, key: IdSchema });
export type PluginRecordKey = z.infer<typeof PluginRecordKeySchema>;
