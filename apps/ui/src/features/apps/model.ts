import {
  signsIn,
  type AppAccess,
  type AppCategory,
  type AppHealth,
  type AppRepair,
  type AppToolView,
  type CatalogBadge,
  type ConnectableApp,
} from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { localDay } from "../../lib/time.js";
import type { UiKey } from "../../locales/en.js";

/**
 * Connected apps' words and groupings:
 * pure, and about the read model only. No app, preset or provider is named
 * here or anywhere under `apps/`; everything an app shows comes
 * from the owner.
 */

/** The badge a health word shows: its text's key, and the tone the badge classes use. */
export const HEALTH_BADGE: Readonly<
  Record<AppHealth, { readonly textKey: UiKey; readonly tone: "ok" | "info" | "warning" | "bad" | "muted" }>
> = {
  ready: { textKey: "apps.health.ready", tone: "ok" },
  "needs-sign-in": { textKey: "apps.health.needsSignIn", tone: "warning" },
  "needs-access": { textKey: "apps.health.needsAccess", tone: "warning" },
  "needs-review": { textKey: "apps.health.needsReview", tone: "info" },
  "not-set-up": { textKey: "apps.health.notSetUp", tone: "muted" },
  paused: { textKey: "apps.health.paused", tone: "muted" },
  off: { textKey: "apps.health.off", tone: "muted" },
  error: { textKey: "apps.health.error", tone: "bad" },
};

/** The Connected list's groups: what needs you, what works, what is turned off. */
export type AppGroup = "needs-you" | "connected" | "paused";

export function groupOf(health: AppHealth): AppGroup {
  if (health === "ready") return "connected";
  if (health === "paused" || health === "off") return "paused";
  return "needs-you";
}

export const GROUP_TITLES: Readonly<Record<AppGroup, UiKey>> = {
  "needs-you": "apps.group.needsYou",
  connected: "apps.group.connected",
  paused: "apps.group.paused",
};

/** The apps of each group, in the owner's order (worst health first). */
export function groupApps(
  apps: readonly ConnectableApp[],
): readonly { readonly group: AppGroup; readonly apps: readonly ConnectableApp[] }[] {
  const order: readonly AppGroup[] = ["needs-you", "connected", "paused"];
  return order
    .map((group) => ({ group, apps: apps.filter((app) => groupOf(app.health) === group) }))
    .filter((entry) => entry.apps.length > 0);
}

/** Whether an app matches what the person typed: its name, summary or an account's identity. */
export function appMatches(app: ConnectableApp, query: string): boolean {
  const words = query.trim().toLowerCase();
  if (words === "") return true;
  return [app.name, app.summary, app.publisher, ...app.accounts.map((account) => account.identity)].some(
    (text) => text?.toLowerCase().includes(words) === true,
  );
}

/** What a tool's calls do, grouped as the page lists them. */
export const ACCESS_TITLES: Readonly<Record<AppAccess, UiKey>> = {
  read: "apps.access.read",
  change: "apps.access.change",
  send: "apps.access.send",
};

export function toolsByAccess(
  tools: readonly AppToolView[],
): readonly { readonly access: AppAccess; readonly tools: readonly AppToolView[] }[] {
  const order: readonly AppAccess[] = ["read", "change", "send"];
  return order
    .map((access) => ({ access, tools: tools.filter((tool) => tool.access === access) }))
    .filter((entry) => entry.tools.length > 0);
}

/** Why a choice cannot be made here, in Tavi's words; undefined when nothing holds it back. */
export function ceilingOf(tool: AppToolView): string | undefined {
  if (tool.state === "disabled") return translateNow("apps.ceiling.disabled");
  if (tool.state !== "offered") return translateNow("apps.ceiling.waiting");
  if (tool.because.includes("critical")) return translateNow("apps.ceiling.critical");
  if (!tool.canSetHere.includes("allow") && tool.because.includes("never-always")) return translateNow("apps.ceiling.neverAlways");
  if (!tool.canSetHere.includes("allow") && tool.effect !== "read-only") return translateNow("apps.ceiling.cliAllow");
  if (tool.canSetHere.length === 1) return translateNow("apps.ceiling.cliBlocked");
  return undefined;
}

/** A catalog badge's words; never colour alone. */
export const BADGE_WORDS: Readonly<Record<CatalogBadge, UiKey>> = {
  "tavi-preset": "apps.badge.taviPreset",
  "built-in": "apps.badge.builtIn",
  "own-client": "apps.badge.ownClient",
  remote: "apps.badge.remote",
  "runs-here": "apps.badge.runsHere",
  "unreviewed-listing": "apps.badge.unreviewedListing",
  lan: "apps.badge.lan",
};

/** Two letters for an app with no icon. */
export function monogram(name: string): string {
  const letters = name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word[0] ?? "")
    .join("");
  return (letters.length >= 2 ? letters.slice(0, 2) : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2)).toUpperCase() || "?";
}

/** The fix an app offers first: a sign-in, an access to grant, a review, a setup, then the rest. */
export function primaryRepair(app: ConnectableApp): AppRepair | undefined {
  const order: readonly AppRepair["kind"][] = [
    "sign-in",
    "grant-access",
    "retry",
    "review-tools",
    "finish-setup",
    "enable",
    "sharing",
    "turn-on",
    "cli-only",
  ];
  return [...app.repairs].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0];
}

/** How the app's page fixes a repair, by its source; absent, the page shows the repair's command instead. */
export type PageFix = "connect" | "review" | "enable" | "test" | "sharing" | "settings" | "channels";

export function pageFix(app: ConnectableApp, repair: AppRepair | undefined): PageFix | undefined {
  if (repair === undefined) return undefined;
  // A channel signs in from its page; its settings and turning it on stay in Channels.
  if (app.source.kind === "channel")
    return (repair.kind === "sign-in" || repair.kind === "grant-access") && signsIn(app.auth) ? "connect" : "channels";
  if (repair.kind === "sharing") return repair.accountId === undefined ? undefined : "sharing";
  const settings = app.settings.length > 0 ? "settings" : undefined;
  if (app.source.kind === "mcp") {
    switch (repair.kind) {
      case "sign-in":
      case "grant-access":
        return "connect";
      case "review-tools":
        return "review";
      case "finish-setup":
        // Its client, or a keyed app's key, is given in its sheet.
        return app.clientSetup === undefined && app.auth.kind !== "api-key" ? settings : "connect";
      case "enable":
        return repair.accountId !== undefined || app.source.pluginIds.length > 0 ? "enable" : undefined;
      case "retry":
        return repair.accountId === undefined ? undefined : "test";
      default:
        return undefined;
    }
  }
  if (repair.kind === "finish-setup") return settings;
  if (repair.kind === "enable") return app.source.pluginIds.length > 0 ? "enable" : undefined;
  return undefined;
}

/** The isolation an app runs in, in words. */
export function isolationWords(app: ConnectableApp): string {
  switch (app.source.isolation) {
    case "remote":
      return translateNow("apps.isolation.remote");
    case "sandboxed":
      return translateNow("apps.isolation.sandboxed");
    case "unsandboxed":
      return translateNow("apps.isolation.unsandboxed");
    case "in-process":
      return translateNow("apps.isolation.inProcess");
  }
}

/** The tunnel a person on another computer runs, to sign in through this page. */
export function tunnelCommand(port: string): string {
  return `ssh -L ${port}:127.0.0.1:${port} <this server>`;
}

/** Whether the app's summary and access text are its author's own words, not Tavi's: shown as such. */
export function authorsWords(app: ConnectableApp): boolean {
  return app.source.verified === "reviewed" || app.source.verified === "unreviewed";
}

/** What a screen reader hears when an app's health moves to `health`; absent, nothing. */
function healthAnnouncement(appName: string, health: AppHealth): string | undefined {
  switch (health) {
    case "needs-sign-in":
      return translateNow("apps.announce.needsSignIn", { app: appName });
    case "needs-access":
      return translateNow("apps.announce.needsAccess", { app: appName });
    case "error":
      return translateNow("apps.announce.error", { app: appName });
    default:
      return undefined;
  }
}

/** Of a fresh list, what to announce: each app whose health changed since `before`, said once. A first read says nothing. */
export function healthChanges(before: ReadonlyMap<string, AppHealth> | undefined, apps: readonly ConnectableApp[]): readonly string[] {
  if (before === undefined) return [];
  return apps.flatMap((app) => {
    const was = before.get(app.appId);
    if (was === undefined || was === app.health) return [];
    const said = healthAnnouncement(app.name, app.health);
    return said === undefined ? [] : [said];
  });
}

/** A category's words, for the list's filter. */
export const CATEGORY_WORDS: Readonly<Record<AppCategory, UiKey>> = {
  calendar: "apps.category.calendar",
  email: "apps.category.email",
  chat: "apps.category.chat",
  notes: "apps.category.notes",
  tasks: "apps.category.tasks",
  files: "apps.category.files",
  home: "apps.category.home",
  dev: "apps.category.dev",
  business: "apps.category.business",
  search: "apps.category.search",
  other: "apps.category.other",
};

/** When a forecast sign-in is due, said the same on the list's row and an account's. */
export function signInByWords(iso: string, timeZone: string | undefined): string {
  return translateNow("apps.signIn.by", { day: localDay(iso, timeZone) });
}

/** The soonest an app's accounts must sign in again, as a row says it; none when no account forecasts one. */
export function nextSignInLine(app: ConnectableApp, timeZone: string | undefined): string | undefined {
  const next = app.accounts.flatMap((account) => (account.nextSignInBy === undefined ? [] : [account.nextSignInBy])).sort()[0];
  return next === undefined ? undefined : signInByWords(next, timeZone);
}

/** "you@example.com, +1" for a row. */
export function accountsLine(app: ConnectableApp): string {
  const names = app.accounts.map((account) => account.identity ?? account.label);
  if (names.length === 0) return translateNow("apps.accounts.none");
  return names.length === 1
    ? (names[0] as string)
    : translateNow("apps.accounts.more", { first: names[0] as string, more: String(names.length - 1) });
}

/** Names joined as one list ("Gmail and Calendar"), in the page's language. */
export function andList(names: readonly string[]): string {
  const last = names.at(-1);
  if (names.length < 2 || last === undefined) return last ?? "";
  return `${names.slice(0, -1).join(translateNow("apps.list.between"))}${translateNow("apps.list.and")}${last}`;
}

/**
 * Who keeps a provider's grant a disconnect leaves behind, said the same in Connected apps and Settings → Channels;
 * `provider` absent, the provider is not named.
 */
export function keptByWords(kept: readonly string[], provider: string | undefined): string {
  const params = { kept: andList(kept), provider: provider ?? translateNow("apps.keptBy.theProvider") };
  return translateNow(kept.length > 1 ? "apps.keptBy.many" : "apps.keptBy.one", params);
}

/** Whether a test's answer says its server listed its tools without checking the key (Google Maps'). */
export function keyUnchecked(tested: unknown): boolean {
  const answer = tested as { readonly tested?: { readonly keyChecked?: unknown } } | undefined;
  return answer?.tested?.keyChecked === false;
}

/**
 * What a secret field says of where its value goes, from where the credential store keeps its at-rest key (Settings →
 * Credentials reads the same): "encrypted" only when it is; plain when it is not, or when the owner did not say.
 */
export function storedWords(kept: "none" | "file" | "keychain" | undefined): string {
  if (kept === "file" || kept === "keychain") return translateNow("apps.stored.encrypted");
  return translateNow(kept === "none" ? "apps.stored.plain" : "apps.stored.unknown");
}

/** What a passed test says of an account: it answered, or only listed its tools when its server never checked the key. */
export function testedWords(who: string, tested: unknown): string {
  return translateNow(keyUnchecked(tested) ? "apps.tested.listed" : "apps.tested.answered", { who });
}

/** What lending an account lets people ask for, from what its tools do: read; read and change; or read, change and send through. */
export function lendingAccess(app: Pick<ConnectableApp, "tools">): AppAccess {
  const access = new Set(app.tools.map((tool) => tool.access));
  if (access.has("send")) return "send";
  if (access.has("change")) return "change";
  return "read";
}
