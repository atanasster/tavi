import type { RoutineSnapshot } from "@tavi/contracts";
import type { WorkspaceGrant } from "../access/policy.js";
/** Owner configuration is data; the worker rechecks database authority at execution. */
export interface RoutineWorkerConfiguration {
  /** Each workspace's pinned provider bindings, by the principal they were resolved for (a binding names its caller). */
  readonly toolBindings?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
  readonly modelBindings?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
  readonly ownerEpoch: string;
  readonly workspaces: readonly WorkspaceGrant[];
  /** The people allowed in each workspace besides its principal (Allowed people): they own routines too. */
  readonly people?: Readonly<Record<string, readonly string[]>>;
  readonly toolPermissions: Readonly<Record<string, readonly string[]>>;
  /** The plugin tools a routine's research may be granted (`routinePluginReads`). */
  readonly pluginReads?: readonly string[];
  readonly deliveryAuthorizationAvailable?: boolean;
  readonly destinations: readonly { workspaceId: string; connectionId: string; chatId: string }[];
  readonly providerConnectionIds: readonly string[];
  readonly modelOverride: boolean;
  readonly executionAvailable: boolean;
  readonly dataDirectory?: string;
  readonly defaultModels?: RoutineSnapshot["models"];
  readonly allowedHosts: readonly string[];
  readonly renderer?: { available: boolean; provider: string };
}
