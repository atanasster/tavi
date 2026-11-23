import {
  renderTextRef,
  textRef,
  worseHealth,
  type AppHealth,
  type AppRepair,
  type MessagingConnectionRecord,
  type McpNoticeKind,
  type TextRef,
  type TextRefParams,
} from "@tavi/contracts";
import type { CanvasCoreKey } from "@tavi/contracts/locales/core";

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

/**
 * A repair's words by key: the English it has always shown, cut to its line, beside the key the canvas says in its
 * language. The English is the key's own template, so it reads as before.
 */
function said(key: CanvasCoreKey, params: TextRefParams | undefined, max: number): { readonly text: string; readonly ref: TextRef } {
  const ref = textRef(key, params);
  return { text: (renderTextRef(ref) ?? key).slice(0, max), ref };
}

/** A repair's title (its button) by key. */
function titled(key: CanvasCoreKey, params?: TextRefParams): { readonly title: string; readonly titleRef: TextRef } {
  const words = said(key, params, 120);
  return { title: words.text, titleRef: words.ref };
}

/** A repair's detail (its cause) by key. */
function detailed(key: CanvasCoreKey, params?: TextRefParams): { readonly detail: string; readonly detailRef: TextRef } {
  const words = said(key, params, 300);
  return { detail: words.text, detailRef: words.ref };
}

/** "Review Calendar's tools", or "Review notes' tools" for a name ending in s. */
const possessiveKey = (name: string, key: "app.repair.reviewTools" | "app.repair.fixSettings"): CanvasCoreKey =>
  /s$/i.test(name) ? `${key}S` : key;

/** "a and b and c", each by its label, as one nested reference. */
function andList(words: readonly string[]): string | TextRef {
  const [first, ...rest] = words;
  return rest.length === 0 ? (first ?? "") : textRef("app.repair.and", { first: first ?? "", rest: andList(rest) });
}

/** "It needs your Maps API key and city.": each missing setting by its label, else its key. */
function missingWords(
  missing: readonly string[],
  fields: SettingFields | undefined,
): { readonly detail: string; readonly detailRef: TextRef } {
  return detailed("app.repair.needs", { settings: andList(missing.map((key) => inSentence(fields?.[key]?.label ?? key))) });
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
        ...titled("app.repair.stopped", { app: appName }),
        // A server's own reason is shown as it said it.
        ...(facts.reason !== undefined
          ? { detail: facts.reason.slice(0, 300) }
          : detailed(facts.state === "backing-off" ? "app.repair.restarting" : "app.repair.failedRepeatedly")),
        cli: `tavi mcp probe ${id}`,
      };
    case "needs-sign-in":
      return {
        kind: "sign-in",
        ...account,
        ...titled("app.repair.signInAgain", { app: appName }),
        ...(facts.learnedWeekly === true
          ? detailed("app.repair.weeklyLearned")
          : facts.reason !== undefined
            ? { detail: facts.reason.slice(0, 300) }
            : detailed("app.repair.signInLapsed")),
        cli: `tavi mcp login ${id}`,
      };
    case "needs-access":
      return {
        kind: "grant-access",
        ...account,
        ...titled("app.repair.allowAccess", { app: appName }),
        ...detailed((facts.missingScopes ?? []).length > 0 ? "app.repair.scopesLeftOut" : "app.repair.accessNotGranted"),
        cli: `tavi mcp login ${id}`,
      };
    case "needs-review":
      return {
        kind: "review-tools",
        ...account,
        ...titled(possessiveKey(appName, "app.repair.reviewTools"), { app: appName }),
        ...(facts.pendingVersions.length > 0
          ? detailed("app.repair.versionWaits", { versions: facts.pendingVersions.join(", ") })
          : detailed("app.repair.toolsWaiting", { count: Math.max(facts.waitingTools, 1), n: String(Math.max(facts.waitingTools, 1)) })),
        cli: `tavi mcp show ${id}`,
      };
    case "not-set-up":
      if (facts.missingSettings.length > 0)
        return {
          kind: "finish-setup",
          ...account,
          ...titled("app.repair.finishSetup", { app: appName }),
          ...missingWords(facts.missingSettings, facts.fields),
          cli: settingFix(id, facts.missingSettings[0] as string, facts.fields),
        };
      if (facts.refusedKey !== undefined)
        return {
          kind: "finish-setup",
          ...account,
          ...titled("app.repair.finishSetup", { app: appName }),
          ...detailed("app.repair.keyRefused", { key: inSentence(facts.refusedKey.label) }),
          cli: fitted(`tavi credentials set ${facts.refusedKey.ref} --file … && tavi mcp probe ${id}`, `tavi mcp probe ${id}`),
        };
      if (facts.oauth && !facts.signedIn)
        return {
          kind: "sign-in",
          ...account,
          ...titled("app.repair.signIn", { app: appName }),
          ...detailed("app.repair.notSignedIn"),
          cli: `tavi mcp login ${id}`,
        };
      return {
        kind: "review-tools",
        ...account,
        ...titled("app.repair.review", { app: appName }),
        ...detailed("app.repair.noVersion"),
        cli: `tavi mcp show ${id}`,
      };
    case "paused":
      return {
        kind: "enable",
        ...account,
        ...titled("app.repair.turnOn", { app: appName }),
        ...detailed("app.repair.offNoTools"),
        cli: `tavi plugins enable ${id}`,
      };
    case "off":
      return { kind: "cli-only", ...account, ...titled("app.repair.mcpOn"), ...detailed("app.repair.mcpOff"), cli: "tavi mcp on" };
  }
}

/** How long an app in Testing stays signed in, and how early Tavi reminds. */
const WEEKLY_SIGN_IN_MS = 7 * 86_400_000;
const SIGN_IN_REMINDER_MS = 86_400_000;

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
    ...(due
      ? titled("app.repair.signInAgain", { app: appName })
      : titled("app.repair.signInAgainBy", { app: appName, date: nextSignInBy.slice(0, 10) })),
    ...detailed(due ? "app.repair.weeklyDue" : "app.repair.weeklySoon"),
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
          ...titled("app.repair.pasteToken", { app: appName }),
          ...detailed("app.repair.tokenRefused"),
          cli: `tavi channels secret ${connectionId} ${secretKey} --file …`,
        };
      return {
        kind: "sign-in",
        ...account,
        ...titled("app.repair.reconnect", { app: appName }),
        ...detailed("app.repair.signInLapsedSentence"),
        cli: `tavi channels connect ${connectionId}`,
      };
    case "needs-access":
      if (secretKey !== undefined)
        return {
          kind: "grant-access",
          ...account,
          ...titled(possessiveKey(appName, "app.repair.fixSettings"), { app: appName }),
          ...detailed("app.repair.providerRefused"),
          cli: `tavi channels test ${connectionId} --to …`,
        };
      return {
        kind: "grant-access",
        ...account,
        ...titled("app.repair.reconnect", { app: appName }),
        ...detailed("app.repair.accessNotGranted"),
        cli: `tavi channels connect ${connectionId}`,
      };
    case "not-set-up":
      return {
        kind: "sign-in",
        ...account,
        ...titled("app.repair.connect", { app: appName }),
        ...detailed("app.repair.notSignedIn"),
        cli: `tavi channels connect ${connectionId}`,
      };
    case "paused":
      return {
        kind: "enable",
        ...account,
        ...titled("app.repair.turnOn", { app: appName }),
        ...detailed("app.repair.connectionOff"),
        cli: `tavi channels enable ${connectionId}`,
      };
    default:
      return {
        kind: "retry",
        ...account,
        ...titled("app.repair.stopped", { app: appName }),
        ...detailed("app.repair.connectionFailed"),
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
        ...titled("app.repair.review", { app: appName }),
        ...detailed("app.repair.aVersionWaits"),
        cli: `tavi plugins show ${pluginId}`,
      };
    case "not-set-up":
      return {
        kind: "finish-setup",
        ...account,
        ...titled("app.repair.finishSetup", { app: appName }),
        ...(missingSettings.length > 0 ? missingWords(missingSettings, fields) : detailed("app.repair.noVersion")),
        cli: missingSettings.length > 0 ? settingFix(pluginId, missingSettings[0] as string, fields) : `tavi plugins show ${pluginId}`,
      };
    case "paused":
      return {
        kind: "enable",
        ...account,
        ...titled("app.repair.turnOn", { app: appName }),
        ...detailed("app.repair.off"),
        cli: `tavi plugins enable ${pluginId}`,
      };
    default:
      return {
        kind: "retry",
        ...account,
        ...titled("app.repair.stopped", { app: appName }),
        ...detailed("app.repair.failedToStart"),
        cli: `tavi plugins show ${pluginId}`,
      };
  }
}
