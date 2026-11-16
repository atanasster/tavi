import { worseHealth, type AppHealth, type AppRepair, type MessagingConnectionRecord, type McpNoticeKind } from "@tavi/contracts";

/**
 * One closed health vocabulary for every source, each
 * non-ready state with one repair and its CLI twin.
 */

/** What an MCP server's account reports, from `tavi mcp list` and its review. */
export interface McpAccountFacts {
  readonly pluginId: string;
  /** The supervisor's word, or `off`/`disabled`/`unknown` from the list. */
  readonly state: string;
  readonly reason?: string | undefined;
  readonly enabled: boolean;
  /** The version it runs, or the approved one it would run once turned on: absent until one is approved. */
  readonly activeVersion?: string | undefined;
  readonly pendingVersions: readonly string[];
  readonly waitingTools: number;
  readonly openNotices: readonly McpNoticeKind[];
  /** Required settings with no value (a client, a url, a token). */
  readonly missingSettings: readonly string[];
  /** Its settings' labels and types, to name a missing one in words and store a missing credential. */
  readonly fields?: SettingFields;
  /** Its last test was refused the key it holds, unchanged and not probed since: the key, in words, and where it is kept. */
  readonly refusedKey?: { readonly label: string; readonly ref: string };
  readonly oauth: boolean;
  /** An OAuth server holds a grant. */
  readonly signedIn: boolean;
  /** Scopes its sign-in asked for and consent left out. */
  readonly missingScopes?: readonly string[];
  /** Its sign-in was refused 7 days after signing in, so it is known to sign out weekly. */
  readonly learnedWeekly?: boolean;
}

export function mcpAccountHealth(facts: McpAccountFacts): AppHealth {
  let health: AppHealth = "ready";
  const worse = (next: AppHealth): void => {
    health = worseHealth(health, next);
  };
  if (facts.state === "off") worse("off");
  if (!facts.enabled) worse("paused");
  // Without its key (or with one refused) or its first sign-in a server can't be probed, so a version waiting on it is no
  // review yet: its setup comes first.
  const unset =
    facts.missingSettings.length > 0 ||
    facts.refusedKey !== undefined ||
    (facts.oauth && !facts.signedIn && facts.state !== "login-required");
  if (facts.activeVersion === undefined || unset) worse("not-set-up");
  if (!unset && (facts.pendingVersions.length > 0 || facts.waitingTools > 0 || facts.openNotices.includes("drift"))) worse("needs-review");
  if (facts.openNotices.includes("scope") || (facts.missingScopes ?? []).length > 0) worse("needs-access");
  if (facts.state === "login-required" || facts.openNotices.includes("login")) worse("needs-sign-in");
  if (facts.state === "failed" || facts.state === "backing-off" || facts.openNotices.includes("failed")) worse("error");
  return health;
}

/** A plugin's settings as its manifest gives them: a label and a type. */
export type SettingFields = Readonly<Record<string, { readonly label?: string | undefined; readonly type: string }>>;

/** A label inside a sentence: "Your Maps API key" → "your Maps API key". */
const inSentence = (label: string): string => label.replace(/^Your /, "your ");

/** "It needs your Maps API key and city.": each missing setting by its label, else its key. */
function missingWords(missing: readonly string[], fields: SettingFields | undefined): string {
  return `It needs ${missing.map((key) => inSentence(fields?.[key]?.label ?? key)).join(" and ")}.`.slice(0, 300);
}

/** A command, or a shorter one when it would not fit a repair's line. */
const fitted = (command: string, shorter: string): string => (command.length <= 200 ? command : shorter);

/** A missing setting's fix: a credential is stored first, then the setting names it. */
function settingFix(pluginId: string, key: string, fields: SettingFields | undefined): string {
  if (fields?.[key]?.type !== "credential") return `tavi plugins config ${pluginId} --set ${key}=…`;
  const ref = `plugins.${pluginId}.${key}`;
  const name = `tavi plugins config ${pluginId} --set ${key}=${ref}`;
  return fitted(`tavi credentials set ${ref} --file … && ${name}`, name);
}

/** An app's name as its owner: "notes'" for a name ending in s, else "Calendar's". */
const possessive = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** The one repair a non-ready account offers, in Tavi's words, with the same fix as a command. */
export function mcpAccountRepair(appName: string, health: AppHealth, facts: McpAccountFacts): AppRepair | undefined {
  const id = facts.pluginId;
  const account = { accountId: id };
  switch (health) {
    case "ready":
      return undefined;
    case "error":
      return {
        kind: "retry",
        ...account,
        title: `${appName} stopped working`,
        detail: (facts.reason ?? (facts.state === "backing-off" ? "restarting after a failure" : "it failed repeatedly")).slice(0, 300),
        cli: `tavi mcp probe ${id}`,
      };
    case "needs-sign-in":
      return {
        kind: "sign-in",
        ...account,
        title: `Sign in to ${appName} again`,
        detail: (facts.learnedWeekly === true ? WEEKLY_LEARNED_DETAIL : (facts.reason ?? "its sign-in expired or was revoked")).slice(
          0,
          300,
        ),
        cli: `tavi mcp login ${id}`,
      };
    case "needs-access":
      return {
        kind: "grant-access",
        ...account,
        title: `Allow ${appName} the access it needs`,
        detail:
          (facts.missingScopes ?? []).length > 0
            ? "Its sign-in left out some of the access it asked for; sign in again and allow all of it."
            : "It asks for access it was not granted.",
        cli: `tavi mcp login ${id}`,
      };
    case "needs-review":
      return {
        kind: "review-tools",
        ...account,
        title: `Review ${possessive(appName)} tools`,
        detail:
          facts.pendingVersions.length > 0
            ? `Version ${facts.pendingVersions.join(", ")} waits for your review.`
            : `${String(Math.max(facts.waitingTools, 1))} of its tools are new or changed and won't be used until you review them.`,
        cli: `tavi mcp show ${id}`,
      };
    case "not-set-up":
      if (facts.missingSettings.length > 0)
        return {
          kind: "finish-setup",
          ...account,
          title: `Finish setting up ${appName}`,
          detail: missingWords(facts.missingSettings, facts.fields),
          cli: settingFix(id, facts.missingSettings[0] as string, facts.fields),
        };
      if (facts.refusedKey !== undefined)
        return {
          kind: "finish-setup",
          ...account,
          title: `Finish setting up ${appName}`,
          detail: `Its server refused ${inSentence(facts.refusedKey.label)}: check it and paste it again.`.slice(0, 300),
          cli: fitted(`tavi credentials set ${facts.refusedKey.ref} --file … && tavi mcp probe ${id}`, `tavi mcp probe ${id}`),
        };
      if (facts.oauth && !facts.signedIn)
        return {
          kind: "sign-in",
          ...account,
          title: `Sign in to ${appName}`,
          detail: "It has not been signed in yet.",
          cli: `tavi mcp login ${id}`,
        };
      return {
        kind: "review-tools",
        ...account,
        title: `Review ${appName}`,
        detail: "It has no approved version yet.",
        cli: `tavi mcp show ${id}`,
      };
    case "paused":
      return {
        kind: "enable",
        ...account,
        title: `Turn ${appName} on`,
        detail: "It is turned off; its tools aren't offered.",
        cli: `tavi plugins enable ${id}`,
      };
    case "off":
      return { kind: "cli-only", ...account, title: "Turn MCP on", detail: "Every MCP app is off.", cli: "tavi mcp on" };
  }
}

/** How long an app in Testing stays signed in, and how early Tavi reminds. */
const WEEKLY_SIGN_IN_MS = 7 * 86_400_000;
const SIGN_IN_REMINDER_MS = 86_400_000;

const WEEKLY_LEARNED_DETAIL =
  "It was signed out 7 days after signing in, as an app in Testing is. Tavi now expects a weekly sign-in and reminds you a day before.";

/** When a weekly sign-in is next due. */
export function nextWeeklySignIn(signedInAt: string): string {
  return new Date(Date.parse(signedInAt) + WEEKLY_SIGN_IN_MS).toISOString();
}

/** A day before a weekly sign-in lapses, a reminder in place of a failure. */
export function weeklySignInReminder(appName: string, accountId: string, nextSignInBy: string, now: string): AppRepair | undefined {
  if (Date.parse(now) < Date.parse(nextSignInBy) - SIGN_IN_REMINDER_MS) return undefined;
  const due = Date.parse(now) >= Date.parse(nextSignInBy);
  return {
    kind: "sign-in",
    accountId,
    title: (due ? `Sign in to ${appName} again` : `Sign in to ${appName} again by ${nextSignInBy.slice(0, 10)}`).slice(0, 120),
    detail: due
      ? "Its weekly sign-in is due: its provider signs an app in Testing out every 7 days."
      : "Its provider signs an app in Testing out every 7 days; signing in again now keeps it working.",
    cli: `tavi mcp login ${accountId}`,
  };
}

/** What the owner knows of a running connection: its state, and what its connector says would fix a failure. */
export interface ChannelRunningStatus {
  readonly state: string;
  readonly repair?: "credentials" | "provider-settings" | undefined;
}

/**
 * A channel connection: its sign-in state, and whether the host runs it. A
 * failed connection whose connector names its repair
 * is a sign-in (a revoked or reset token) or an access (a setting at the
 * provider), so the heartbeat's apps source raises it like an OAuth lapse.
 */
export function channelAccountHealth(
  record: Pick<MessagingConnectionRecord, "enabled" | "authState">,
  oauth: boolean,
  running?: ChannelRunningStatus,
): AppHealth {
  if (!record.enabled) return "paused";
  if (oauth && (record.authState === "expired" || record.authState === "revoked")) return "needs-sign-in";
  if (oauth && record.authState === "needs-consent") return "needs-access";
  if (oauth && record.authState === "none") return "not-set-up";
  if (running?.state === "failed" && running.repair === "credentials") return "needs-sign-in";
  if (running?.state === "failed" && running.repair === "provider-settings") return "needs-access";
  if (running?.state === "failed") return "error";
  return "ready";
}

/**
 * A channel's repair: a sign-in from its app's page, the rest in
 * Settings → Channels. A channel that signs in with a key (`secretKey`, its
 * descriptor's first field) is repaired by pasting a new one.
 */
export function channelAccountRepair(appName: string, health: AppHealth, connectionId: string, secretKey?: string): AppRepair | undefined {
  const account = { accountId: connectionId };
  switch (health) {
    case "ready":
      return undefined;
    case "needs-sign-in":
      if (secretKey !== undefined)
        return {
          kind: "sign-in",
          ...account,
          title: `Paste a new ${appName} token`.slice(0, 120),
          detail: "Its token was refused: it was revoked or reset at the provider.",
          cli: `tavi channels secret ${connectionId} ${secretKey} --file …`,
        };
      return {
        kind: "sign-in",
        ...account,
        title: `Reconnect ${appName}`,
        detail: "Its sign-in expired or was revoked.",
        cli: `tavi channels connect ${connectionId}`,
      };
    case "needs-access":
      if (secretKey !== undefined)
        return {
          kind: "grant-access",
          ...account,
          title: `Fix ${possessive(appName)} settings at its provider`.slice(0, 120),
          detail: "The provider refused a setting the channel needs, such as an intent or a permission turned off for its bot.",
          cli: `tavi channels test ${connectionId} --to …`,
        };
      return {
        kind: "grant-access",
        ...account,
        title: `Reconnect ${appName}`,
        detail: "It asks for access it was not granted.",
        cli: `tavi channels connect ${connectionId}`,
      };
    case "not-set-up":
      return {
        kind: "sign-in",
        ...account,
        title: `Connect ${appName}`,
        detail: "It has not been signed in yet.",
        cli: `tavi channels connect ${connectionId}`,
      };
    case "paused":
      return {
        kind: "enable",
        ...account,
        title: `Turn ${appName} on`,
        detail: "The connection is turned off.",
        cli: `tavi channels enable ${connectionId}`,
      };
    default:
      return {
        kind: "retry",
        ...account,
        title: `${appName} stopped working`,
        detail: "The connection failed.",
        cli: `tavi channels test ${connectionId}`,
      };
  }
}

/** An external plugin. */
export function pluginHealth(input: {
  readonly enabled: boolean;
  readonly proposed: boolean;
  readonly activeVersion?: string | undefined;
  readonly missingSettings: readonly string[];
  readonly error?: string | undefined;
}): AppHealth {
  let health: AppHealth = "ready";
  if (!input.enabled) health = worseHealth(health, "paused");
  if (input.missingSettings.length > 0 || input.activeVersion === undefined) health = worseHealth(health, "not-set-up");
  if (input.proposed) health = worseHealth(health, "needs-review");
  if (input.error !== undefined) health = worseHealth(health, "error");
  return health;
}

export function pluginRepair(
  appName: string,
  pluginId: string,
  health: AppHealth,
  missingSettings: readonly string[],
  fields?: SettingFields,
): AppRepair | undefined {
  const account = { accountId: pluginId };
  switch (health) {
    case "ready":
      return undefined;
    case "needs-review":
      return {
        kind: "review-tools",
        ...account,
        title: `Review ${appName}`,
        detail: "A version waits for your review.",
        cli: `tavi plugins show ${pluginId}`,
      };
    case "not-set-up":
      return {
        kind: "finish-setup",
        ...account,
        title: `Finish setting up ${appName}`,
        detail: missingSettings.length > 0 ? missingWords(missingSettings, fields) : "It has no approved version yet.",
        cli: missingSettings.length > 0 ? settingFix(pluginId, missingSettings[0] as string, fields) : `tavi plugins show ${pluginId}`,
      };
    case "paused":
      return {
        kind: "enable",
        ...account,
        title: `Turn ${appName} on`,
        detail: "It is turned off.",
        cli: `tavi plugins enable ${pluginId}`,
      };
    default:
      return {
        kind: "retry",
        ...account,
        title: `${appName} stopped working`,
        detail: "It failed to load or start.",
        cli: `tavi plugins show ${pluginId}`,
      };
  }
}
