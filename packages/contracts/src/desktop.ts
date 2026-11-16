import { z } from "zod";
import { type BrowserCaptureScale, type BrowserSensitiveReason, toLogicalPoint } from "./browser.js";
import type { BrowserLiveInputEvent, LiveControlTarget, LiveDialogInfo, LiveTarget, LiveTargetFrame } from "./browser-live.js";
import { definedOnly } from "./util.js";

/**
 * Desktop computer-use contracts (`@tavi/plugin-desktop`).
 *
 * Models `DesktopPort` on `BrowserPort.pointer`, carries `subrole` on every
 * accessibility node, defines fail-closed blocklists, credential roles/subroles,
 * authentication dialog signatures, per-app grant tiers, and adapts a
 * `DesktopPort` to the existing `LiveTarget` / `LiveControlTarget` contracts.
 */

export const BLOCKED_DESKTOP_APPS = [
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.agilebits.onepassword-osx",
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "com.bitwarden.desktop",
  "com.lastpass.LastPass",
  "com.dashlane.Dashlane",
  "com.dashlane.dashlanephonefinal",
  "com.callpod.keepermac",
  "me.proton.pass.catalyst",
  "org.keepassxc.keepassxc",
  "com.enpass.Enpass",
  "com.apple.securityagent",
  "com.apple.CoreAuthUI",
  "com.apple.LocalAuthentication.UIAgent",
  "ai.tavi.app",
  "ai.tavi.desktop",
  "ai.tavi.cli",
] as const;

export type BlockedDesktopAppId = (typeof BLOCKED_DESKTOP_APPS)[number];

const BLOCKED_DESKTOP_APP_SET: ReadonlySet<string> = new Set(BLOCKED_DESKTOP_APPS.map((id) => id.toLowerCase()));

const BLOCKED_DESKTOP_APP_NAME_PATTERNS: readonly RegExp[] = [
  /\b1password\b/i,
  /\bkeychain\s*access\b/i,
  /^passwords$/i,
  /\bbitwarden\b/i,
  /\blastpass\b/i,
  /\bdashlane\b/i,
  /\bkeeper\s*password\b/i,
  /\bproton\s*pass\b/i,
  /\bkeepassxc?\b/i,
  /\benpass\b/i,
  /\bsecurityagent\b/i,
  /\bcoreauthui\b/i,
  /^tavi(?:\s+desktop|\s+cli)?$/i,
];

/**
 * Fail-closed check for whether a desktop app is blocked.
 * Unresolved (`undefined` or empty) bundle IDs and app names are treated as blocked.
 */
export function isBlockedDesktopApp(bundleId?: string | undefined, appName?: string | undefined): boolean {
  const normalizedBundle = bundleId?.trim().toLowerCase() ?? "";
  const normalizedName = appName?.trim() ?? "";
  if (normalizedBundle.length === 0 && normalizedName.length === 0) {
    return true;
  }
  if (normalizedBundle.length > 0) {
    if (BLOCKED_DESKTOP_APP_SET.has(normalizedBundle)) {
      return true;
    }
    if (normalizedBundle.startsWith("ai.tavi.") || normalizedBundle.startsWith("com.1password.")) {
      return true;
    }
  }
  if (normalizedName.length > 0) {
    for (const pattern of BLOCKED_DESKTOP_APP_NAME_PATTERNS) {
      if (pattern.test(normalizedName)) {
        return true;
      }
    }
  }
  return false;
}

export function isTaviDesktopApp(bundleId?: string | undefined, appName?: string | undefined): boolean {
  const normalizedBundle = bundleId?.trim().toLowerCase() ?? "";
  if (normalizedBundle === "ai.tavi.app" || normalizedBundle === "ai.tavi.desktop" || normalizedBundle === "ai.tavi.cli") {
    return true;
  }
  if (normalizedBundle.startsWith("ai.tavi.")) {
    return true;
  }
  const normalizedName = appName?.trim() ?? "";
  return /^tavi(?:\s+desktop|\s+cli)?$/i.test(normalizedName);
}

export const DESKTOP_CREDENTIAL_ROLES = ["AXSecureTextField", "AXPasswordField"] as const;
export const DESKTOP_CREDENTIAL_SUBROLES = ["AXSecureTextField", "AXPasswordInput"] as const;

const CREDENTIAL_ROLE_SET: ReadonlySet<string> = new Set(DESKTOP_CREDENTIAL_ROLES.map((r) => r.toLowerCase()));
const CREDENTIAL_SUBROLE_SET: ReadonlySet<string> = new Set(DESKTOP_CREDENTIAL_SUBROLES.map((r) => r.toLowerCase()));

/**
 * Checks whether an accessibility node represents a credential or password field
 * by its `role` or `subrole` (including `AXSecureTextField`).
 */
export function isDesktopCredentialNode(
  element: { readonly role?: string | undefined; readonly subrole?: string | undefined } | undefined,
): boolean {
  if (element === undefined) {
    return false;
  }
  const role = element.role?.trim().toLowerCase() ?? "";
  const subrole = element.subrole?.trim().toLowerCase() ?? "";
  return CREDENTIAL_ROLE_SET.has(role) || CREDENTIAL_SUBROLE_SET.has(subrole);
}

export const DESKTOP_AUTH_DIALOG_BUNDLE_IDS = [
  "com.apple.securityagent",
  "com.apple.CoreAuthUI",
  "com.apple.LocalAuthentication.UIAgent",
  "com.apple.UserNotificationCenter",
] as const;

const AUTH_DIALOG_BUNDLE_SET: ReadonlySet<string> = new Set(DESKTOP_AUTH_DIALOG_BUNDLE_IDS.map((id) => id.toLowerCase()));

export const DESKTOP_AUTH_DIALOG_PATTERNS: readonly RegExp[] = [
  /\bwants to make changes\b/i,
  /\btouch id or enter your password\b/i,
  /\benter your password to allow\b/i,
  /\bauthentication is required\b/i,
  /\bwants to use your confidential information stored in\b/i,
  /\bkeychain\b.*\bwants to\b/i,
  /\bsudo\s*:/i,
  /\bpolkit\b/i,
  /\badministrator privileges\b/i,
];

export function isDesktopAuthDialog(input: {
  readonly bundleId?: string | undefined;
  readonly appName?: string | undefined;
  readonly windowTitle?: string | undefined;
  readonly role?: string | undefined;
  readonly subrole?: string | undefined;
  readonly text?: string | undefined;
}): boolean {
  const bundleId = input.bundleId?.trim().toLowerCase() ?? "";
  if (bundleId.length > 0 && AUTH_DIALOG_BUNDLE_SET.has(bundleId)) {
    return true;
  }
  const appName = input.appName?.trim() ?? "";
  if (/\b(?:SecurityAgent|CoreAuthUI|UserNotificationCenter)\b/i.test(appName)) {
    return true;
  }
  const combined = [input.windowTitle ?? "", input.text ?? ""].join(" ").trim();
  if (combined.length > 0) {
    for (const pattern of DESKTOP_AUTH_DIALOG_PATTERNS) {
      if (pattern.test(combined)) {
        return true;
      }
    }
  }
  return false;
}

export const DESKTOP_APP_GRANT_TIERS = ["view-only", "click-only", "warning", "full"] as const;
export const DesktopAppGrantTierSchema = z.enum(DESKTOP_APP_GRANT_TIERS);
export type DesktopAppGrantTier = z.infer<typeof DesktopAppGrantTierSchema>;

const VIEW_ONLY_BROWSER_BUNDLES: ReadonlySet<string> = new Set([
  "com.apple.safari",
  "com.apple.safaritechnologypreview",
  "com.google.chrome",
  "com.google.chrome.canary",
  "org.chromium.chromium",
  "org.mozilla.firefox",
  "org.mozilla.firefoxdeveloperedition",
  "company.thebrowser.browser",
  "company.thebrowser.dia",
  "com.brave.browser",
  "com.microsoft.edgemac",
  "com.operasoftware.opera",
  "com.vivaldi.vivaldi",
  "app.zen-browser.zen",
]);

const CLICK_ONLY_TERMINAL_IDE_BUNDLES: ReadonlySet<string> = new Set([
  "com.apple.terminal",
  "com.googlecode.iterm2",
  "dev.warp.warp-stable",
  "net.kovidgoyal.kitty",
  "io.alacritty",
  "com.mitchellh.ghostty",
  "co.zeit.hyper",
  "com.github.wez.wezterm",
  "com.microsoft.vscode",
  "com.microsoft.vscodeinsiders",
  "com.todesktop.230313mzl4w4u92",
  "com.apple.dt.xcode",
  "dev.zed.zed",
  "com.sublimetext.4",
]);

const WARNING_TIER_BUNDLES: ReadonlySet<string> = new Set([
  "com.apple.finder",
  "com.apple.systempreferences",
  "com.apple.settings",
  "com.apple.scripteditor2",
  "com.apple.automator",
  "com.apple.shortcuts",
  "com.apple.activitymonitor",
]);

/**
 * Classifies an application's default grant tier:
 * - Browsers are `"view-only"` (use `browser.*` tools instead).
 * - Terminals and IDEs are `"click-only"` (no arbitrary command typing).
 * - File managers, script editors, and System Settings are `"warning"`.
 * - Standard desktop apps are `"full"`.
 */
export function defaultDesktopAppGrantTier(bundleId: string, appName?: string): DesktopAppGrantTier {
  const b = bundleId.trim().toLowerCase();
  const name = appName?.trim().toLowerCase() ?? "";
  if (VIEW_ONLY_BROWSER_BUNDLES.has(b) || /\b(?:safari|chrome|firefox|brave|edge|arc|vivaldi|opera)\b/.test(name)) {
    return "view-only";
  }
  if (
    CLICK_ONLY_TERMINAL_IDE_BUNDLES.has(b) ||
    b.startsWith("com.jetbrains.") ||
    /\b(?:terminal|iterm2?|warp|kitty|alacritty|ghostty|wezterm|visual studio code|cursor|xcode|intellij|pycharm|webstorm|goland|clion|zed)\b/.test(
      name,
    )
  ) {
    return "click-only";
  }
  if (
    WARNING_TIER_BUNDLES.has(b) ||
    /\b(?:finder|system settings|system preferences|script editor|automator|activity monitor)\b/.test(name)
  ) {
    return "warning";
  }
  return "full";
}

export interface DesktopBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopNode {
  readonly ref: string;
  readonly role: string;
  readonly subrole?: string;
  readonly title?: string;
  readonly value?: string;
  readonly description?: string;
  readonly bounds?: DesktopBox;
  readonly enabled?: boolean;
  readonly focused?: boolean;
  readonly children?: readonly DesktopNode[];
}

export interface DesktopAppInfo {
  readonly bundleId: string;
  readonly name: string;
  readonly pid: number;
  readonly active?: boolean;
  readonly hidden?: boolean;
  readonly windowTitle?: string;
  readonly bounds?: DesktopBox;
}

export interface DesktopTreeResult {
  readonly app: DesktopAppInfo;
  readonly windowTitle?: string;
  readonly focused?: {
    readonly ref?: string;
    readonly role: string;
    readonly subrole?: string;
    readonly title?: string;
    readonly value?: string;
  };
  readonly nodes: readonly DesktopNode[];
}

export type DesktopCaptureTarget =
  | { readonly kind: "app"; readonly app: string }
  | { readonly kind: "display"; readonly displayId?: number };

export interface DesktopCaptureOptions {
  readonly maxWidth?: number;
  readonly quality?: number;
  readonly excludeBundleIds?: readonly string[];
  /** The apps whose windows a capture may show, an allowlist: the gate's granted apps. */
  readonly includeBundleIds?: readonly string[];
}

export interface DesktopCaptureResult {
  readonly data: string;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly scale: BrowserCaptureScale;
  readonly app?: DesktopAppInfo;
}

/**
 * Desktop action grammar, modelled on `BrowserPointerAction` plus `ax-` ref targeting.
 */
export type DesktopAction =
  | {
      readonly kind: "click";
      readonly ref?: string;
      readonly x?: number;
      readonly y?: number;
      readonly button?: "left" | "right" | "middle";
      readonly double?: boolean;
      readonly triple?: boolean;
      readonly modifiers?: readonly string[];
    }
  | {
      readonly kind: "move";
      readonly ref?: string;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly kind: "mouse_down";
      readonly x?: number;
      readonly y?: number;
      readonly button?: "left" | "right" | "middle";
    }
  | {
      readonly kind: "mouse_up";
      readonly x?: number;
      readonly y?: number;
      readonly button?: "left" | "right" | "middle";
    }
  | {
      readonly kind: "type";
      readonly ref?: string;
      readonly text: string;
    }
  | {
      readonly kind: "press";
      readonly key: string;
      readonly modifiers?: readonly string[];
    }
  | {
      readonly kind: "key_down";
      readonly key: string;
    }
  | {
      readonly kind: "key_up";
      readonly key: string;
    }
  | {
      readonly kind: "scroll";
      readonly ref?: string;
      readonly x?: number;
      readonly y?: number;
      readonly dx: number;
      readonly dy: number;
    }
  | {
      readonly kind: "drag";
      readonly x: number;
      readonly y: number;
      readonly toX: number;
      readonly toY: number;
    }
  | {
      readonly kind: "wait";
      readonly ms: number;
    };

/**
 * What a click-only grant (terminals, IDEs) allows: a plain left click, single or double, and a scroll. A right or
 * middle click opens a menu with Paste, a modifier click or a drag can drop text, a held button is a drag in parts.
 */
export function desktopClickOnlyAllows(action: {
  readonly kind: string;
  readonly button?: string | undefined;
  readonly triple?: boolean | undefined;
  readonly modifiers?: readonly unknown[] | undefined;
}): boolean {
  if (action.kind === "scroll") return true;
  if (action.kind !== "click") return false;
  return (action.button ?? "left") === "left" && action.triple !== true && (action.modifiers ?? []).length === 0;
}

export interface DesktopResolvedElement {
  readonly app: DesktopAppInfo;
  readonly windowTitle?: string;
  readonly role: string;
  readonly subrole?: string;
  readonly title?: string;
  readonly value?: string;
  readonly description?: string;
  readonly bounds?: DesktopBox;
  readonly enabled?: boolean;
  readonly focused?: boolean;
}

export interface DesktopActOptions {
  readonly app?: string;
  readonly approvedCommit?: boolean;
  /**
   * The label (`desktopNodeLabel`) of the element the approval card named:
   * an approved commit presses a commit control by that label only.
   */
  readonly approvedLabel?: string;
  readonly approvedWarningTier?: boolean;
  /** The app (bundle id or name) the approval card named: an approved warning-tier action acts in that app only. */
  readonly approvedApp?: string;
  /**
   * Whether a person attends the run this action is for: a gate built
   * without its own `attended` takes the call's word, and refuses when it is
   * absent or `false`.
   */
  readonly attended?: boolean;
  readonly signal?: AbortSignal;
}

export interface DesktopStateSnapshot {
  readonly app?: string;
  readonly bundleId?: string;
  readonly windowTitle?: string;
  readonly focusedRole?: string;
  readonly focusedSubrole?: string;
  readonly focusedTitle?: string;
  readonly focusedValue?: string;
}

export interface DesktopActionOutcome {
  readonly status: "accepted" | "rejected";
  readonly detail?: string;
  readonly changes?: readonly string[];
  readonly before?: DesktopStateSnapshot;
  readonly after?: DesktopStateSnapshot;
  readonly capture?: DesktopCaptureResult;
}

export interface DesktopPort {
  apps(): Promise<readonly DesktopAppInfo[]>;
  tree(app: string): Promise<DesktopTreeResult>;
  capture(target: DesktopCaptureTarget, options?: DesktopCaptureOptions): Promise<DesktopCaptureResult>;
  act(action: DesktopAction, options?: DesktopActOptions): Promise<DesktopActionOutcome>;
  elementAtPoint?(x: number, y: number): Promise<DesktopResolvedElement | undefined>;
  focusedElement?(): Promise<DesktopResolvedElement | undefined>;
  abort?(): Promise<void>;
  dispose?(): Promise<void>;
}

/** The element `ref` names in an accessibility tree, searched depth first. */
export function findDesktopNode(nodes: readonly DesktopNode[], ref: string): DesktopNode | undefined {
  for (const node of nodes) {
    if (node.ref === ref) return node;
    if (node.children !== undefined) {
      const found = findDesktopNode(node.children, ref);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * A key's name as the desktop helper reads it, made one per key: a single
 * character as itself (lower case), any longer name without case, spaces,
 * `_` or `-`, with the helper's aliases folded together (`return` and
 * `keypadenter` are `enter`, `backspace` is `delete`, `del` is
 * `forwarddelete`, `" "` is `space`).
 */
export function desktopKeyOf(name: string): string {
  if (name === " ") return "space";
  const key = name.length === 1 ? name.toLowerCase() : name.toLowerCase().replace(/[\s_-]/g, "");
  switch (key) {
    case "return":
    case "keypadenter":
      return "enter";
    case "backspace":
      return "delete";
    case "del":
      return "forwarddelete";
    case "esc":
      return "escape";
    default:
      return key;
  }
}

/** A modifier's name as the desktop helper reads it, made one per key: `cmd`, `ctrl`, `alt` or `shift`. */
export function desktopModifierOf(name: string): string {
  const modifier = name.trim().toLowerCase();
  if (modifier === "command" || modifier === "meta" || modifier === "super") return "cmd";
  if (modifier === "control") return "ctrl";
  if (modifier === "option") return "alt";
  return modifier;
}

/**
 * A key press that commits whatever has focus, as its card and the gate both
 * name it (`cmd+enter`): ⌘ or Ctrl, with any other modifier, and Enter or
 * Delete (send, delete). Names are read as the helper reads them
 * (`desktopKeyOf`, `desktopModifierOf`). `undefined` for any other press.
 */
export function desktopCommitShortcut(key: string, modifiers: readonly string[] | undefined): string | undefined {
  const held = [...new Set((modifiers ?? []).map(desktopModifierOf))].sort();
  if (!held.includes("cmd") && !held.includes("ctrl")) return undefined;
  const pressed = desktopKeyOf(key);
  if (pressed !== "enter" && pressed !== "delete" && pressed !== "forwarddelete") return undefined;
  return [...held, pressed].join("+");
}

/**
 * What changed between two desktop states, in words a model reads: the
 * focused app, the window's title, the focused element and its value.
 */
export function describeDesktopChanges(
  before: DesktopStateSnapshot | undefined,
  after: DesktopStateSnapshot | undefined,
): readonly string[] {
  const changes: string[] = [];
  if (before === undefined && after === undefined) {
    return changes;
  }
  if (before?.app !== after?.app && after?.app !== undefined) {
    changes.push(`focused app: ${before?.app ?? "none"} -> ${after.app}`);
  }
  if (before?.windowTitle !== after?.windowTitle && after?.windowTitle !== undefined) {
    changes.push(`window title: "${before?.windowTitle ?? ""}" -> "${after.windowTitle}"`);
  }
  if ((before?.focusedRole !== after?.focusedRole || before?.focusedTitle !== after?.focusedTitle) && after?.focusedRole !== undefined) {
    const label = after.focusedTitle !== undefined ? ` "${after.focusedTitle}"` : "";
    changes.push(`focused element: ${after.focusedRole}${label}`);
  }
  if (before?.focusedValue !== after?.focusedValue && after?.focusedValue !== undefined) {
    changes.push(`value changed to "${after.focusedValue.slice(0, 80)}"`);
  }
  return changes;
}

/** An accessibility element's label as the desktop gate reads it: its title and description. */
export function desktopNodeLabel(element: { readonly title?: string | undefined; readonly description?: string | undefined }): string {
  return [element.title ?? "", element.description ?? ""].join(" ").trim();
}

/** A key press the desktop gate may take as its abort hotkey. */
export interface DesktopAbortHotkeyEvent {
  readonly key: string;
  readonly modifiers?: readonly string[];
  consume?: () => void;
}

/**
 * A `DesktopPort` behind the desktop gate (`createGatedDesktopPort` in
 * `@tavi/plugin-desktop`): the only kind the desktop tools take, since they do
 * no checks of their own.
 */
export interface GatedDesktopPort extends DesktopPort {
  /**
   * Handles a global hotkey event: if it matches the configured abort hotkey, consumes the keypress
   * and aborts any active desktop operation, returning `true`.
   */
  handleGlobalHotkey(event: DesktopAbortHotkeyEvent): Promise<boolean>;
  /**
   * Clears the aborted state so subsequent attended turns may proceed.
   */
  resetAbort(): void;
  /**
   * The tree the gate resolves a ref in: `app`'s last tree (by the name it
   * was asked for, its bundle id or its name), else the latest one observed.
   */
  observedTree(app?: string): DesktopTreeResult | undefined;
}

/**
 * Adapts a `DesktopPort` into a `LiveTarget` and `LiveControlTarget` that implement
 * the existing `browser-live.ts` live-view and operator takeover contracts.
 */
export function createDesktopLiveTarget(
  desktop: DesktopPort,
  options: {
    readonly target: DesktopCaptureTarget;
    readonly subscribeFrames?: (tick: () => void, intervalMs: number) => () => void;
    readonly intervalMs?: number;
  },
): { readonly target: LiveTarget; readonly control: LiveControlTarget; readonly pushFrame: () => Promise<void> } {
  const intervalMs = Math.max(100, options.intervalMs ?? 500);
  let lastScale: BrowserCaptureScale | undefined;
  let activeCast:
    | {
        readonly maxWidth: number;
        readonly quality: number;
        readonly onFrame: (frame: LiveTargetFrame) => void;
      }
    | undefined;
  let inFlight = false;

  const pushFrame = async (): Promise<void> => {
    const cast = activeCast;
    if (cast === undefined || inFlight) return;
    inFlight = true;
    try {
      const shot = await desktop.capture(options.target, {
        maxWidth: cast.maxWidth,
        quality: cast.quality,
      });
      lastScale = shot.scale;
      if (activeCast !== cast) return;
      const frame: LiveTargetFrame = {
        data: shot.data,
        metadata: {
          deviceWidth: shot.scale.logicalWidth,
          deviceHeight: shot.scale.logicalHeight,
          pageScaleFactor: 1,
          offsetTop: 0,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
        ack() {},
      };
      cast.onFrame(frame);
    } catch {
      // Capture refusals or transient errors skip the frame; sensitivity() reports hidden state.
    } finally {
      inFlight = false;
    }
  };

  const target: LiveTarget = {
    async screencast(castOptions, onFrame) {
      activeCast = {
        maxWidth: castOptions.maxWidth,
        quality: castOptions.quality,
        onFrame,
      };
      await pushFrame();
      const unsubscribe = options.subscribeFrames?.(() => {
        void pushFrame();
      }, intervalMs);
      return {
        async stop() {
          activeCast = undefined;
          unsubscribe?.();
        },
      };
    },

    async sensitivity(): Promise<BrowserSensitiveReason | undefined> {
      try {
        // What has focus cannot be read: nothing says the frame is safe to show.
        const focused = await desktop.focusedElement?.();
        if (focused === undefined) return "blocked-host";
        if (isBlockedDesktopApp(focused.app.bundleId, focused.app.name)) return "blocked-host";
        if (isDesktopCredentialNode(focused)) return "password-field";
        const authDialog = isDesktopAuthDialog({
          bundleId: focused.app.bundleId,
          appName: focused.app.name,
          windowTitle: focused.windowTitle,
          role: focused.role,
          subrole: focused.subrole,
          text: focused.title,
        });
        return authDialog ? "password-field" : undefined;
      } catch {
        return "blocked-host";
      }
    },

    onNavigated() {
      return () => {};
    },
  };

  /** A mouse button the person holds down, and where: their moves drag until they let go. */
  let held: { readonly button: "left" | "right" | "middle"; x: number; y: number } | undefined;
  /** Lets go of a button still held: before another press, and when the person's control ends. */
  const release = async (): Promise<void> => {
    const holding = held;
    if (holding === undefined) return;
    const outcome = await desktop.act({ kind: "mouse_up", x: holding.x, y: holding.y, button: holding.button });
    if (outcome.status === "accepted") held = undefined;
  };
  const control: LiveControlTarget = {
    async begin(_events: {
      dialog(info: LiveDialogInfo): void;
      fileChooser(info: { readonly multiple: boolean; readonly accept?: string }): void;
    }) {
      return async () => {
        await release();
      };
    },

    async input(event: BrowserLiveInputEvent) {
      switch (event.type) {
        case "mouse": {
          const pt = toLogicalPoint({ x: event.x, y: event.y }, lastScale, false);
          const button = event.button === "right" || event.button === "middle" ? event.button : "left";
          if (event.action === "move") {
            if (held !== undefined) {
              held.x = pt.x;
              held.y = pt.y;
            }
            await desktop.act({ kind: "move", x: pt.x, y: pt.y });
          } else if (event.action === "down") {
            await release();
            if ((event.clickCount ?? 1) >= 2) {
              await desktop.act({ kind: "click", x: pt.x, y: pt.y, button, double: true });
            } else {
              // Held down, then moved and let go: a drag, as the person makes it.
              const pressed = await desktop.act({ kind: "mouse_down", x: pt.x, y: pt.y, button });
              if (pressed.status === "accepted") held = { button, x: pt.x, y: pt.y };
            }
          } else if (event.action === "up" && held !== undefined) {
            held.x = pt.x;
            held.y = pt.y;
            await release();
          }
          break;
        }
        case "wheel": {
          const pt = toLogicalPoint({ x: event.x, y: event.y }, lastScale, false);
          await desktop.act({
            kind: "scroll",
            x: pt.x,
            y: pt.y,
            dx: Math.round(event.deltaX),
            dy: Math.round(event.deltaY),
          });
          break;
        }
        case "key": {
          if (event.action === "down") {
            await desktop.act({ kind: "press", key: event.key });
          }
          break;
        }
        case "text": {
          await desktop.act({ kind: "type", text: event.text });
          break;
        }
      }
    },

    async selectAt() {
      return undefined;
    },

    async selectOption() {},

    async answerDialog() {},

    async setFiles() {},

    async dismissChooser() {},
  };

  return { target, control, pushFrame };
}

const COMPACT_STRUCTURAL_ROLES: ReadonlySet<string> = new Set(["AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea"]);

/**
 * Compacts an accessibility tree for the model by keeping interactive, labelled,
 * focused, or value-bearing nodes with `ax-` refs and hoisting children of
 * unlabelled layout containers. Bounds are left out unless `withBounds` is set.
 */
export function compactDesktopTree(
  nodes: readonly DesktopNode[],
  { withBounds = false }: { readonly withBounds?: boolean } = {},
): readonly DesktopNode[] {
  const result: DesktopNode[] = [];
  for (const node of nodes) {
    const compactedChildren = node.children !== undefined ? compactDesktopTree(node.children, { withBounds }) : undefined;
    const hasMeaningfulLabel =
      (node.title !== undefined && node.title.trim().length > 0) ||
      (node.value !== undefined && node.value.trim().length > 0) ||
      (node.description !== undefined && node.description.trim().length > 0) ||
      node.focused === true ||
      node.subrole === "AXSecureTextField";

    if (COMPACT_STRUCTURAL_ROLES.has(node.role) && !hasMeaningfulLabel) {
      if (compactedChildren !== undefined && compactedChildren.length > 0) {
        result.push(...compactedChildren);
      }
      continue;
    }

    result.push({
      ref: node.ref,
      role: node.role,
      ...definedOnly({ subrole: node.subrole, title: node.title, value: node.value, description: node.description }),
      // Where each element is, only when asked: an element is acted on by its ref.
      ...(node.bounds === undefined || !withBounds ? {} : { bounds: node.bounds }),
      ...(node.enabled === undefined ? {} : { enabled: node.enabled }),
      ...(node.focused === undefined ? {} : { focused: node.focused }),
      ...(compactedChildren !== undefined && compactedChildren.length > 0 ? { children: compactedChildren } : {}),
    });
  }
  return result;
}
