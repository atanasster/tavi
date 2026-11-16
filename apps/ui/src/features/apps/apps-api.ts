import {
  AppsActivityAnswerSchema,
  AppsCatalogAnswerSchema,
  AppsConnectAnswerSchema,
  AppsConnectStatusSchema,
  AppsListAnswerSchema,
  ConnectableAppSchema,
  type AppMailboxAccess,
  type AppPermissionTarget,
  type AppSharing,
  type CatalogRef,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { z } from "zod";

import { ask, read, type SettingsClient } from "../../lib/ipc.js";

/** The `apps` command's answers, each read through its contract schema (Connected apps). */
const AppsShowAnswer = z.object({ app: ConnectableAppSchema });
const AppsCatalogAnswer = z.object({ catalog: AppsCatalogAnswerSchema });
const AppsConnectAnswer = z.object({ connect: AppsConnectAnswerSchema });
const AppsStatusAnswer = z.object({ status: AppsConnectStatusSchema });
const AppsActivityAnswer = z.object({ activity: AppsActivityAnswerSchema });
const AppsAddedAnswer = z.object({ added: z.object({ appId: z.string(), pluginId: z.string(), accountId: z.string().optional() }) });

/**
 * Connected apps: one read model over every source, and the owner's façade
 * over `mcp` and `plugins`. The page draws any app from what these return; it names none of them itself.
 */
export const appActions = {
  list: (client: SettingsClient, workspaceId: string) => read(client, "apps", { action: "list", workspaceId }, AppsListAnswerSchema),
  show: (client: SettingsClient, appId: string, workspaceId: string) =>
    read(client, "apps", { action: "show", appId, workspaceId }, AppsShowAnswer),
  catalog: (client: SettingsClient, workspaceId: string, query: string, cursor?: string) =>
    read(client, "apps", { action: "catalog", workspaceId, query, ...(cursor === undefined ? {} : { cursor }) }, AppsCatalogAnswer, {
      timeoutMs: 60_000,
    }),
  /** `switchWayIn`: a preset that is another way into a server already added replaces that server (Todoist's sign-in or token). */
  add: (client: SettingsClient, workspaceId: string, entry: CatalogRef, switchWayIn = false) =>
    read(client, "apps", { action: "add", workspaceId, entry, ...(switchWayIn ? { switch: true } : {}) }, AppsAddedAnswer, {
      timeoutMs: 300_000,
    }),
  configure: (
    client: SettingsClient,
    workspaceId: string,
    appId: string,
    input: {
      readonly accountId?: string;
      readonly values?: Readonly<Record<string, string | number | boolean>>;
      /** The provider's client file, read by the owner for the shared client's id and secret. */
      readonly clientFile?: string;
    },
  ) =>
    ask<unknown>(client, "apps", {
      action: "configure",
      workspaceId,
      appId,
      values: input.values ?? {},
      ...definedOnly({ accountId: input.accountId, clientFile: input.clientFile }),
    }),
  connect: (
    client: SettingsClient,
    workspaceId: string,
    appId: string,
    input: {
      readonly via: "here" | "public" | "paste";
      readonly origin?: string;
      readonly accountId?: string;
      readonly addAccount?: boolean;
    },
  ) =>
    read(
      client,
      "apps",
      {
        action: "connect",
        workspaceId,
        appId,
        via: input.via,
        addAccount: input.addAccount === true,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      },
      AppsConnectAnswer,
      { timeoutMs: 120_000 },
    ),
  /** `workspaceId`: a channel's sign-in is its workspace's. */
  status: (client: SettingsClient, flowId: string, workspaceId: string) =>
    read(client, "apps", { action: "connect-status", flowId, workspaceId }, AppsStatusAnswer),
  finish: (client: SettingsClient, flowId: string, address: string, workspaceId: string) =>
    ask<unknown>(client, "apps", { action: "connect-finish", flowId, address, workspaceId }, { timeoutMs: 120_000 }),
  cancel: (client: SettingsClient, flowId: string, workspaceId: string) =>
    ask<unknown>(client, "apps", { action: "connect-cancel", flowId, workspaceId }),
  test: (client: SettingsClient, workspaceId: string, appId: string, accountId: string) =>
    ask<unknown>(client, "apps", { action: "test", workspaceId, appId, accountId }, { timeoutMs: 180_000 }),
  permission: (client: SettingsClient, workspaceId: string, appId: string, toolId: string, target: AppPermissionTarget) =>
    ask<unknown>(client, "apps", { action: "permission", workspaceId, appId, toolId, target }),
  sharing: (client: SettingsClient, workspaceId: string, appId: string, accountId: string, sharing: AppSharing) =>
    ask<unknown>(client, "apps", { action: "sharing", workspaceId, appId, accountId, sharing }),
  disconnect: (client: SettingsClient, workspaceId: string, appId: string, accountId: string, remove: boolean) =>
    ask<unknown>(client, "apps", { action: "disconnect", workspaceId, appId, accountId, remove }),
  remove: (client: SettingsClient, workspaceId: string, appId: string) =>
    ask<unknown>(client, "apps", { action: "remove", workspaceId, appId }, { timeoutMs: 120_000 }),
  /** *Not now* for one task's connect need. */
  declineConnect: (client: SettingsClient, workspaceId: string, waitId: string) =>
    ask<unknown>(client, "apps", { action: "decline-connect", workspaceId, waitId }),
  mailbox: (client: SettingsClient, workspaceId: string, appId: string, accountId: string, mailbox: AppMailboxAccess) =>
    ask<unknown>(client, "apps", { action: "mailbox", workspaceId, appId, accountId, mailbox }),
  /** Whether a channel account takes messages in. */
  receive: (client: SettingsClient, workspaceId: string, appId: string, accountId: string, on: boolean) =>
    ask<unknown>(client, "apps", { action: "receive", workspaceId, appId, accountId, on }),
  /** Whether the agent may use an account's calendar. */
  calendar: (client: SettingsClient, workspaceId: string, appId: string, accountId: string, on: boolean) =>
    ask<unknown>(client, "apps", { action: "calendar", workspaceId, appId, accountId, on }),
  /** A site profile the app may browse: off until turned on. */
  sites: (client: SettingsClient, workspaceId: string, appId: string, siteId: string, on: boolean) =>
    ask<unknown>(client, "apps", { action: "sites", workspaceId, appId, siteId, on }),
  activity: (client: SettingsClient, workspaceId: string, appId: string, cursor?: string) =>
    read(client, "apps", { action: "activity", workspaceId, appId, ...(cursor === undefined ? {} : { cursor }) }, AppsActivityAnswer),
};
