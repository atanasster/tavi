import { z } from "zod";

import { TaviError, type CatalogEntry, type ConnectableApp } from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

import { attended } from "../mcp/bridge.js";
import { awaitConnect } from "./connect-waits.js";

/**
 * `apps.request_connect`: the agent
 * asks the person to connect an app a task needs. The chat shows a Connect
 * card from this call's own result; the tool never starts a sign-in, so
 * nothing is connected without the person. In a run that may ask its person,
 * an added app that needs its sign-in waits for it, durably, as a call that
 * met the lapse does, and goes on once it is connected.
 *
 * It is the operator's: their apps, their health and their accounts are not
 * for the people a chat lets in.
 */

export interface AppsToolOptions {
  /** The workspace's Connected apps, as the owner projects them. */
  readonly apps: (workspaceId: string) => Promise<readonly ConnectableApp[]>;
  /** Tavi's presets and installed apps not set up, to offer one not yet added. */
  readonly catalog: (workspaceId: string) => Promise<readonly CatalogEntry[]>;
  /** The workspace's operator: the only one the tool is offered to and answers. */
  readonly operatorOf: (workspaceId: string) => string | undefined;
}

/** Health that a sign-in fixes: the call waits for one. */
const SIGN_IN_FIXES: ReadonlySet<ConnectableApp["health"]> = new Set(["needs-sign-in", "needs-access", "not-set-up"]);

const RequestConnectSchema = z.strictObject({
  appId: z.string().min(1).max(128).describe("The app's id, such as gmail, or its name"),
  why: z.string().min(1).max(300).describe("What it is needed for, in one sentence the person reads on the card"),
});

/** What the card shows: the app, whether it is added yet, and what it may do once connected. */
export interface ConnectRequest {
  readonly appId?: string;
  readonly name: string;
  readonly installed: boolean;
  readonly health?: ConnectableApp["health"];
  readonly accountId?: string;
  /** What signing in lets it do, in Tavi's words. */
  readonly access: readonly string[];
  readonly why: string;
  /** For an app not added yet: the catalog entry the card's *Add and connect* opens. */
  readonly entry?: CatalogEntry["ref"];
}

const sameName = (name: string, wanted: string): boolean => name.trim().toLowerCase() === wanted.trim().toLowerCase();

export async function requestConnect(
  options: AppsToolOptions,
  workspaceId: string,
  input: z.infer<typeof RequestConnectSchema>,
): Promise<ConnectRequest> {
  const apps = await options.apps(workspaceId);
  const app = apps.find((candidate) => candidate.appId === input.appId || sameName(candidate.name, input.appId));
  if (app !== undefined) {
    const scopes = app.auth.kind === "oauth" || app.auth.kind === "device" ? app.auth.scopes : [];
    const account =
      app.repairs.find((repair) => repair.kind === "sign-in" || repair.kind === "grant-access")?.accountId ?? app.accounts[0]?.accountId;
    return {
      appId: app.appId,
      name: app.name,
      installed: true,
      health: app.health,
      ...(account === undefined ? {} : { accountId: account }),
      access: scopes.map((scope) => scope.says).slice(0, 16),
      why: input.why,
    };
  }
  const entries = await options.catalog(workspaceId);
  const entry = entries.find(
    (candidate) =>
      candidate.appId === input.appId ||
      (candidate.ref.kind === "preset" && candidate.ref.id === input.appId) ||
      sameName(candidate.name, input.appId),
  );
  if (entry !== undefined)
    return {
      ...(entry.appId === undefined ? {} : { appId: entry.appId }),
      name: entry.name,
      installed: false,
      access: [],
      why: input.why,
      entry: entry.ref,
    };
  const known = [
    ...apps.map((candidate) => candidate.appId),
    ...entries.flatMap((candidate) => (candidate.ref.kind === "preset" ? [candidate.ref.id] : [])),
  ];
  throw new TaviError("NOT_FOUND", `no app ${input.appId}; the apps are: ${[...new Set(known)].slice(0, 20).join(", ") || "none yet"}`);
}

export function registerAppsTools(registry: ToolRegistry, options: AppsToolOptions): void {
  registry.register({
    id: "apps.request_connect",
    sink: "none",
    version: "1.0.0",
    description:
      "Ask the person to connect an app (their calendar, mail…) or sign in to it again, when the task needs it. Shows them a Connect button in this chat with your reason; it never signs in itself. Tell them, and continue once they say it is done.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: RequestConnectSchema,
    offered: (context) => context.operator === true,
    handler: async ({ input, context, executionPolicy, ask }) => {
      if (options.operatorOf(context.workspaceId) !== context.principalId)
        throw new TaviError("NOT_AUTHORIZED", "only the operator connects apps here");
      const parsed = RequestConnectSchema.parse(input);
      const connect = await requestConnect(options, context.workspaceId, parsed);
      // Signed in already, or once the wait below resumed the task and ran this call again: nothing to ask.
      if (connect.installed && connect.health === "ready") return { connected: { appId: connect.appId, name: connect.name } };
      // Added and needing its sign-in, where the person may be asked: the task waits for it. The call runs
      // again once it settles; reaching here again means signing in did not help, so the call fails as it would have.
      if (
        connect.installed &&
        connect.accountId !== undefined &&
        connect.health !== undefined &&
        SIGN_IN_FIXES.has(connect.health) &&
        ask !== undefined &&
        attended(executionPolicy)
      ) {
        await awaitConnect(
          ask,
          {
            ...(connect.appId === undefined ? {} : { appId: connect.appId }),
            appName: connect.name.slice(0, 80),
            accountId: connect.accountId,
            reason: parsed.why,
            health: connect.health,
          },
          { signIn: true, ...(connect.appId === undefined ? {} : { appId: connect.appId }), accountId: connect.accountId },
        );
        throw new TaviError("NOT_AUTHORIZED", `${connect.name} is still not signed in`, {
          details: { signIn: true, ...(connect.appId === undefined ? {} : { appId: connect.appId }), accountId: connect.accountId },
        });
      }
      return { connect };
    },
  });
}
