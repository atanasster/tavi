import {
  BLOCKED_DESKTOP_APPS,
  type GatedDesktopPort,
  commitCategory,
  desktopClickOnlyAllows,
  describeDesktopChanges,
  desktopCommitShortcut,
  desktopKeyOf,
  desktopModifierOf,
  desktopNodeLabel,
  findDesktopNode,
  type DesktopAction,
  type DesktopActionOutcome,
  type DesktopActOptions,
  type DesktopAppGrantTier,
  type DesktopAppInfo,
  type DesktopCaptureOptions,
  type DesktopCaptureResult,
  type DesktopCaptureTarget,
  type DesktopNode,
  type DesktopAbortHotkeyEvent,
  type DesktopPort,
  type DesktopResolvedElement,
  type DesktopStateSnapshot,
  type DesktopTreeResult,
  defaultDesktopAppGrantTier,
  isBlockedDesktopApp,
  isDesktopAuthDialog,
  isDesktopCredentialNode,
  isTaviDesktopApp,
  refusedEarly,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

export type { DesktopAbortHotkeyEvent, GatedDesktopPort } from "@tavi/contracts";

export interface GatedDesktopOptions {
  /**
   * Explicit map or resolver of granted apps (`bundleId` or lowercased app name -> grant tier, or `true` for default tier).
   * An app not in `grantedApps` is denied for actions and excluded from captures.
   */
  readonly grantedApps:
    | Readonly<Record<string, DesktopAppGrantTier | boolean>>
    | ((app: { readonly bundleId: string; readonly name: string }) => DesktopAppGrantTier | undefined);
  /**
   * Whether the current session has an attended human operator. Absent, or `false` (an unattended run), every
   * `act` is denied: only a caller that says a person is there drives the desktop.
   */
  readonly attended?: boolean | (() => boolean);
  /**
   * Global abort hotkey combination (default `{ key: "Escape", modifiers: ["cmd", "shift"] }`).
   */
  readonly abortHotkey?: {
    readonly key: string;
    readonly modifiers?: readonly string[];
  };
  /**
   * Optional post-action capture when `includeCaptureOnAct` is true.
   * Gated as one unit with the action: a denied action never takes or returns a capture.
   */
  readonly includeCaptureOnAct?: boolean;
}

function resolveGrantTier(
  grantedApps: GatedDesktopOptions["grantedApps"],
  app: { readonly bundleId: string; readonly name: string },
): DesktopAppGrantTier | undefined {
  if (isBlockedDesktopApp(app.bundleId, app.name)) {
    return undefined;
  }
  if (typeof grantedApps === "function") {
    return grantedApps(app);
  }
  const bundleKey = app.bundleId.trim().toLowerCase();
  const nameKey = app.name.trim().toLowerCase();
  const entry =
    grantedApps[app.bundleId] ?? grantedApps[bundleKey] ?? grantedApps[app.name] ?? (nameKey.length > 0 ? grantedApps[nameKey] : undefined);
  if (entry === undefined || entry === false) {
    return undefined;
  }
  if (entry === true) {
    return defaultDesktopAppGrantTier(app.bundleId, app.name);
  }
  return entry;
}

function treeHasCredentialOrAuthDialog(tree: DesktopTreeResult): string | undefined {
  if (
    isDesktopAuthDialog({
      bundleId: tree.app.bundleId,
      appName: tree.app.name,
      windowTitle: tree.windowTitle,
    })
  ) {
    return "Authentication dialog is active";
  }
  if (tree.focused !== undefined && isDesktopCredentialNode(tree.focused)) {
    return "Focused element is a credential field (AXSecureTextField)";
  }
  const walk = (nodes: readonly DesktopNode[]): string | undefined => {
    for (const node of nodes) {
      if (node.focused === true && isDesktopCredentialNode(node)) {
        return `Focused node ${node.ref} is a credential field (${node.subrole ?? node.role})`;
      }
      if (
        isDesktopAuthDialog({
          bundleId: tree.app.bundleId,
          appName: tree.app.name,
          windowTitle: tree.windowTitle,
          role: node.role,
          subrole: node.subrole,
          text: node.title ?? node.description,
        })
      ) {
        return "Authentication prompt detected in accessibility tree";
      }
      if (node.children !== undefined) {
        const childHit = walk(node.children);
        if (childHit !== undefined) return childHit;
      }
    }
    return undefined;
  };
  return walk(tree.nodes);
}

function snapshotFromElement(el: DesktopResolvedElement | undefined): DesktopStateSnapshot | undefined {
  if (el === undefined) return undefined;
  const isSecure = isDesktopCredentialNode(el);
  return {
    app: el.app.name,
    bundleId: el.app.bundleId,
    ...(el.windowTitle === undefined ? {} : { windowTitle: el.windowTitle }),
    focusedRole: el.role,
    ...(el.subrole === undefined ? {} : { focusedSubrole: el.subrole }),
    ...(el.title === undefined ? {} : { focusedTitle: el.title }),
    ...(!isSecure && el.value !== undefined ? { focusedValue: el.value } : {}),
  };
}

function isKeyboardOrWriteAction(action: DesktopAction): boolean {
  return action.kind === "type" || action.kind === "press" || action.kind === "key_down" || action.kind === "key_up";
}

/** Roles whose press acts on what they name: a button, a menu item, a link. */
const PRESSED_ROLES = /button|menuitem|link/i;
/** Roles a hit-test returns from inside a control: its text, its image. */
const INSIDE_A_CONTROL_ROLES = /statictext|image/i;
/** Whether a key press holds ⌘ or Ctrl: a shortcut, not a press of the key itself. */
function holdsCommandKey(modifiers: readonly string[] | undefined): boolean {
  return (modifiers ?? []).some((modifier) => ["cmd", "ctrl"].includes(desktopModifierOf(modifier)));
}

/** The nodes at a point, deepest first, each followed by its ancestors. */
function nodesAt(nodes: readonly DesktopNode[], x: number, y: number): DesktopNode[] {
  for (const node of nodes) {
    const box = node.bounds;
    if (box === undefined || x < box.x || y < box.y || x >= box.x + box.width || y >= box.y + box.height) continue;
    return [...nodesAt(node.children ?? [], x, y), node];
  }
  return [];
}

/** Every node of a tree. */
function allNodes(nodes: readonly DesktopNode[]): DesktopNode[] {
  return nodes.flatMap((node) => [node, ...allNodes(node.children ?? [])]);
}

function isPointerActionWithPoint(
  action: DesktopAction,
): action is Extract<DesktopAction, { readonly kind: "click" | "move" | "mouse_down" | "mouse_up" | "scroll" | "drag" }> {
  return (
    action.kind === "click" ||
    action.kind === "move" ||
    action.kind === "mouse_down" ||
    action.kind === "mouse_up" ||
    action.kind === "scroll" ||
    action.kind === "drag"
  );
}

const SHELL_LAUNCH_PATTERNS: readonly RegExp[] = [/\b(?:terminal|iterm2?|warp|kitty|alacritty|ghostty|wezterm)\b/i];
/** Apps that open what is typed into them: a shell's name typed there launches it. */
const LAUNCHER_BUNDLES: ReadonlySet<string> = new Set(["com.apple.spotlight", "com.runningwithcrayons.alfred", "com.raycast.macos"]);

/**
 * Wraps a `DesktopPort` with fail-closed safety gates:
 * 1. Unresolved app or element denies the action.
 * 2. Hit-tested app at the target coordinates is checked against `BLOCKED_DESKTOP_APPS`.
 * 3. Credential fields (`AXSecureTextField` by role or subrole) at focus or hit point are refused.
 * 4. Auth dialogs are refused.
 * 5. Per-app grant tiers (`view-only`, `click-only`, `warning`, `full`) are enforced.
 * 6. Captures exclude ungranted apps, blocked apps, and Tavi's own windows.
 * 7. Commit button titles (`commitCategory`) require `approvedCommit: true` with `approvedLabel` naming that
 *    control's label; a warning-tier app requires `approvedWarningTier: true` with `approvedApp` naming that app.
 * 8. Runs not known to be attended (`attended` absent or false) are refused on every `act`.
 * 9. Global abort hotkey consumes the keypress and aborts active desktop actions.
 */
export function createGatedDesktopPort(inner: DesktopPort, options: GatedDesktopOptions): GatedDesktopPort {
  const lastTrees = new Map<string, DesktopTreeResult>();
  let latestTree: DesktopTreeResult | undefined;
  let abortedByHotkey = false;
  /** Moves at every abort: an action that read it before the abort is refused before it reaches the desktop. */
  let abortGeneration = 0;

  const abortCombo = {
    key: (options.abortHotkey?.key ?? "Escape").toLowerCase(),
    modifiers: (options.abortHotkey?.modifiers ?? ["cmd", "shift"]).map((m) => m.toLowerCase()).sort(),
  };

  // Unknown means unattended: a caller that does not say never drives the desktop.
  // The gate's own word when it was given one; else the call's, as a gate shared by many runs is told per action.
  const isAttended = (actOptions?: DesktopActOptions): boolean => {
    if (options.attended === undefined) return actOptions?.attended === true;
    return typeof options.attended === "function" ? options.attended() : options.attended;
  };

  // A ref names an element of one app's tree: the named app's, or the latest observed. Refs repeat across apps
  // (each tree counts from ax-1), so another app's tree is never searched for it.
  const observedTree = (app?: string): DesktopTreeResult | undefined => (app !== undefined ? lastTrees.get(app) : latestTree);
  const resolveNodeFromRef = (ref: string, preferredApp?: string): { node: DesktopNode; tree: DesktopTreeResult } | undefined => {
    const tree = observedTree(preferredApp);
    const found = tree === undefined ? undefined : findDesktopNode(tree.nodes, ref);
    return tree === undefined || found === undefined ? undefined : { node: found, tree };
  };

  /**
   * Why keys or text cannot go where the call means them, in words a person can act on: nothing has keyboard focus
   * that can be read (naming the app in front when the helper reports one), or focus is in another app than the
   * one the call names. Either way the keystrokes would land elsewhere, so the call is refused before any is sent.
   */
  const keyboardTargetDenial = async (
    focused: DesktopResolvedElement | undefined,
    target: string | undefined,
  ): Promise<string | undefined> => {
    const wanted = target?.trim() ?? "";
    const bringForward = `Ask the person to bring ${wanted === "" ? "the app" : wanted} to the front and click where the text goes, then try again; do not retry before that.`;
    if (focused === undefined) {
      const front = (await inner.apps().catch(() => [])).find((app) => app.active === true);
      const inFront = front === undefined ? "" : ` (${front.name || front.bundleId} is in front)`;
      return `Nothing has keyboard focus that desktop control can read${inFront}, so the keys would land somewhere unknown. ${bringForward}`;
    }
    if (wanted === "") return undefined;
    const lower = wanted.toLowerCase();
    const { app } = focused;
    if (app.bundleId.toLowerCase() === lower || app.name.toLowerCase() === lower) return undefined;
    return `Keyboard focus is in ${app.name || app.bundleId}, not ${wanted}: the keys would go to ${app.name || app.bundleId}. ${bringForward}`;
  };

  const checkElementSafety = (
    el: DesktopResolvedElement | undefined,
    action: DesktopAction,
    actOptions: DesktopActOptions,
  ): string | undefined => {
    // 1. Unresolved means denied.
    if (el === undefined) {
      return "Target element or application could not be resolved (fail-closed). Do not retry.";
    }
    const { app } = el;
    if (app.bundleId.trim().length === 0 && app.name.trim().length === 0) {
      return "Target application identity is unresolved (fail-closed). Do not retry.";
    }

    // 2. Blocklist checked on the resolved/hit-tested app.
    if (isBlockedDesktopApp(app.bundleId, app.name) || isTaviDesktopApp(app.bundleId, app.name)) {
      return `Application '${app.name || app.bundleId}' is on BLOCKED_DESKTOP_APPS. Do not retry.`;
    }

    // 3. Auth dialogs refused.
    if (
      isDesktopAuthDialog({
        bundleId: app.bundleId,
        appName: app.name,
        windowTitle: el.windowTitle,
        role: el.role,
        subrole: el.subrole,
        text: el.title ?? el.description,
      })
    ) {
      return `Authentication dialog in '${app.name || app.bundleId}' is refused. Do not retry.`;
    }

    // 4. Credential fields refused (by role or subrole).
    if (isDesktopCredentialNode(el)) {
      return `Credential field (${el.subrole ?? el.role}) in '${app.name || app.bundleId}' is refused. Do not retry.`;
    }

    // 5. Per-app grant tiers enforced.
    const tier = resolveGrantTier(options.grantedApps, app);
    if (tier === undefined) {
      return `Application '${app.name || app.bundleId}' is not granted for desktop control. Do not retry.`;
    }
    if (tier === "view-only") {
      return `Application '${app.name || app.bundleId}' has a view-only grant tier: it can be seen, not acted in. Do not retry.`;
    }
    if (tier === "click-only" && !desktopClickOnlyAllows(action)) {
      return `Application '${app.name || app.bundleId}' has a click-only grant tier; only a plain left click or a scroll is allowed. Do not retry.`;
    }
    // Approved for the app its card named: never another warning-tier app the action lands in.
    const approvedHere =
      actOptions.approvedApp !== undefined && (actOptions.approvedApp === app.bundleId || actOptions.approvedApp === app.name);
    if (tier === "warning" && (actOptions.approvedWarningTier !== true || !approvedHere)) {
      return `Application '${app.name || app.bundleId}' is in the warning grant tier and requires explicit approval. Do not retry.`;
    }

    // Prevent Spotlight/launcher typing from opening a terminal when Terminal is not full-tier granted.
    // Into a launcher, a shell's name opens it: refused unless Terminal is granted in full. Typed anywhere else it is text.
    if (
      action.kind === "type" &&
      LAUNCHER_BUNDLES.has(el.app.bundleId.toLowerCase()) &&
      SHELL_LAUNCH_PATTERNS.some((p) => p.test(action.text))
    ) {
      const terminalTier = resolveGrantTier(options.grantedApps, {
        bundleId: "com.apple.Terminal",
        name: "Terminal",
      });
      if (terminalTier !== "full") {
        return "Typing a terminal or shell application name to launch it is refused by grant tiers. Do not retry.";
      }
    }

    // 6. Commit button guard on AX titles: a click or a press of the mouse on it, Enter or Space pressed (or held
    // down) on it, or a newline or space typed on it. Keys are read as the helper reads them. A release is no press: a
    // control fires only when the button went down on it, and a release refused would leave the button held.
    if (
      action.kind === "click" ||
      action.kind === "mouse_down" ||
      ((action.kind === "press" || action.kind === "key_down") && ["enter", "space"].includes(desktopKeyOf(action.key))) ||
      (action.kind === "type" && /[\r\n ]/.test(action.text))
    ) {
      const label = desktopNodeLabel(el);
      if (label.length > 0 && PRESSED_ROLES.test(el.role)) {
        const category = commitCategory(label);
        // Approved for the control the card named, by its label: never another commit the press lands on instead.
        if (category !== undefined && (actOptions.approvedCommit !== true || actOptions.approvedLabel !== label)) {
          return `Commit control "${label}" (${category}) requires operator approval before acting. Do not retry.`;
        }
      }
    }

    return undefined;
  };

  /**
   * An app's tree read now, as a press would find it: an observed one may be
   * stale (a dialog that opened since). Not kept, so refs keep naming what
   * the person's card read. `undefined` when it cannot be read.
   */
  const treeOf = async (app: DesktopAppInfo): Promise<DesktopTreeResult | undefined> =>
    await inner.tree(app.bundleId || app.name).catch(() => undefined);

  /**
   * What a press at `point` acts on: the element a hit-test returned, or the
   * button, menu item or link it sits in (a hit-test answers the deepest
   * element, the text inside a "Delete" button). With no tree to read, text or
   * an image is taken to be inside a control, so its label is held to the
   * commit check as a control's would be.
   */
  const pressedControl = async (
    element: DesktopResolvedElement | undefined,
    point: { readonly x: number; readonly y: number },
  ): Promise<DesktopResolvedElement | undefined> => {
    if (element === undefined || PRESSED_ROLES.test(element.role)) return element;
    const tree = await treeOf(element.app);
    if (tree === undefined) return INSIDE_A_CONTROL_ROLES.test(element.role) ? { ...element, role: "AXButton" } : element;
    const control = nodesAt(tree.nodes, point.x, point.y).find((node) => PRESSED_ROLES.test(node.role));
    if (control === undefined) return element;
    const { title: _title, description: _description, ...rest } = element;
    return {
      ...rest,
      role: control.role,
      ...(control.title === undefined ? {} : { title: control.title }),
      ...(control.description === undefined ? {} : { description: control.description }),
    };
  };

  /** Refuses a press at `point` whose control commits, though the element hit-tested there does not say so. */
  const checkPressedControl = async (
    element: DesktopResolvedElement | undefined,
    point: { readonly x: number; readonly y: number },
    action: DesktopAction,
    actOptions: DesktopActOptions,
  ): Promise<string | undefined> => {
    const control = await pressedControl(element, point);
    return control === element ? undefined : checkElementSafety(control, action, actOptions);
  };

  /**
   * A key that presses something other than what has focus: a ⌘ or Ctrl
   * shortcut that sends or deletes, approved only by its own name, and Enter
   * (or a typed newline) in a field, which may press the window's default
   * button, refused while the window holds a commit control the call was not
   * approved for by its label.
   */
  const checkKeyPress = async (
    action: DesktopAction,
    focused: DesktopResolvedElement | undefined,
    actOptions: DesktopActOptions,
  ): Promise<string | undefined> => {
    // A key held down presses with whatever else is held, which no single call shows: one that sends, deletes or
    // presses a control goes as a press, asked about with its modifiers.
    if (action.kind === "key_down" && ["enter", "delete", "forwarddelete", "space"].includes(desktopKeyOf(action.key)))
      return `Holding ${desktopKeyOf(action.key)} down presses what has focus: press it with its modifiers instead. Do not retry.`;
    const keyed = action.kind === "press" ? action : undefined;
    const shortcut = keyed === undefined ? undefined : desktopCommitShortcut(keyed.key, keyed.modifiers);
    if (shortcut !== undefined && (actOptions.approvedCommit !== true || actOptions.approvedLabel !== shortcut))
      return `Shortcut ${shortcut} sends or deletes, and requires operator approval before acting. Do not retry.`;
    // In a text area a newline or a tab is text.
    if (focused !== undefined && /textarea/i.test(focused.role)) return undefined;
    // A typed tab moves focus to the next control, and what is typed after it lands there unchecked.
    if (action.kind === "type" && action.text.includes("\t"))
      return "A typed tab moves focus to another control: type each field by its ref instead. Do not retry.";
    const enter =
      (keyed !== undefined && desktopKeyOf(keyed.key) === "enter" && !holdsCommandKey(keyed.modifiers)) ||
      (action.kind === "type" && /[\r\n]/.test(action.text));
    if (!enter || focused === undefined) return undefined;
    // Return presses the window's default button whatever has focus, a field or another control.
    const tree = await treeOf(focused.app);
    if (tree === undefined)
      return "Enter here may press the window's default button, and the window could not be read (fail-closed). Do not retry.";
    const box = focused.bounds;
    const window =
      box === undefined
        ? undefined
        : tree.nodes.find((node) => node.bounds !== undefined && nodesAt([node], box.x + box.width / 2, box.y + box.height / 2).length > 0);
    const scanned = allNodes(window === undefined ? tree.nodes : [window]);
    // A web page's form may hold its submit deeper than the tree is read: refused rather than guessed at.
    if (scanned.some((node) => /webarea/i.test(node.role)))
      return "Enter here may submit a web form whose controls are not all read: press its submit by its ref. Do not retry.";
    for (const node of scanned) {
      if (node.enabled === false) continue;
      const label = desktopNodeLabel(node);
      const category = PRESSED_ROLES.test(node.role) && label.length > 0 ? commitCategory(label) : undefined;
      if (category !== undefined && (actOptions.approvedCommit !== true || actOptions.approvedLabel !== label))
        return `Enter here may press "${label}" (${category}): press that control by its ref, so it is asked about. Do not retry.`;
    }
    return undefined;
  };

  return {
    async handleGlobalHotkey(event: DesktopAbortHotkeyEvent): Promise<boolean> {
      const key = event.key.trim().toLowerCase();
      const mods = (event.modifiers ?? []).map((m) => m.trim().toLowerCase()).sort();
      const matches =
        key === abortCombo.key && mods.length === abortCombo.modifiers.length && mods.every((m, idx) => m === abortCombo.modifiers[idx]);
      if (!matches) {
        return false;
      }
      event.consume?.();
      abortedByHotkey = true;
      abortGeneration += 1;
      await inner.abort?.();
      return true;
    },

    resetAbort(): void {
      abortedByHotkey = false;
    },

    async apps(): Promise<readonly DesktopAppInfo[]> {
      const all = await inner.apps();
      return all.filter((app) => !isBlockedDesktopApp(app.bundleId, app.name) && !isTaviDesktopApp(app.bundleId, app.name));
    },

    async tree(app: string): Promise<DesktopTreeResult> {
      if (isBlockedDesktopApp(app, app) || isTaviDesktopApp(app, app)) {
        throw new Error(`Application '${app}' is blocked and cannot be observed. Do not retry.`);
      }
      const tree = await inner.tree(app);
      if (isBlockedDesktopApp(tree.app.bundleId, tree.app.name) || isTaviDesktopApp(tree.app.bundleId, tree.app.name)) {
        throw new Error(`Application '${tree.app.name || tree.app.bundleId}' is blocked. Do not retry.`);
      }
      const tier = resolveGrantTier(options.grantedApps, tree.app);
      if (tier === undefined) {
        // Nothing of the tree is handed on, so the chat read nothing; `notGranted` names the app for the caller's words.
        throw refusedEarly("NOT_AUTHORIZED", `Application '${tree.app.name || tree.app.bundleId}' is not granted. Do not retry.`, {
          notGranted: tree.app.name || tree.app.bundleId,
        });
      }
      for (const key of [app, tree.app.bundleId, tree.app.name]) if (key !== "") lastTrees.set(key, tree);
      latestTree = tree;
      return tree;
    },

    observedTree,

    async elementAtPoint(x: number, y: number): Promise<DesktopResolvedElement | undefined> {
      return await inner.elementAtPoint?.(x, y);
    },

    async focusedElement(): Promise<DesktopResolvedElement | undefined> {
      return await inner.focusedElement?.();
    },

    async capture(target: DesktopCaptureTarget, captureOptions: DesktopCaptureOptions = {}): Promise<DesktopCaptureResult> {
      if (target.kind === "app") {
        if (isBlockedDesktopApp(target.app, target.app) || isTaviDesktopApp(target.app, target.app)) {
          throw new Error(`Cannot capture blocked application '${target.app}'. Do not retry.`);
        }
        const tree = lastTrees.get(target.app);
        const appInfo = tree?.app ?? { bundleId: target.app, name: target.app, pid: 0 };
        const tier = resolveGrantTier(options.grantedApps, appInfo);
        if (tier === undefined) {
          throw new Error(`Cannot capture ungranted application '${target.app}'. Do not retry.`);
        }
        if (tree !== undefined) {
          const reason = treeHasCredentialOrAuthDialog(tree);
          if (reason !== undefined) {
            throw new Error(`Cannot capture '${target.app}': ${reason}. Do not retry.`);
          }
        }
      }

      const focused = await inner.focusedElement?.();
      if (focused !== undefined) {
        if (isDesktopCredentialNode(focused)) {
          throw new Error("Screen capture refused while a credential field (AXSecureTextField) is focused. Do not retry.");
        }
        if (
          isDesktopAuthDialog({
            bundleId: focused.app.bundleId,
            appName: focused.app.name,
            windowTitle: focused.windowTitle,
            role: focused.role,
            subrole: focused.subrole,
            text: focused.title,
          })
        ) {
          throw new Error("Screen capture refused while an authentication dialog is active. Do not retry.");
        }
      }

      const runningApps = await inner.apps();
      const excludeSet = new Set<string>([...BLOCKED_DESKTOP_APPS, ...(captureOptions.excludeBundleIds ?? [])]);
      for (const app of runningApps) {
        if (
          isBlockedDesktopApp(app.bundleId, app.name) ||
          isTaviDesktopApp(app.bundleId, app.name) ||
          resolveGrantTier(options.grantedApps, app) === undefined
        ) {
          if (app.bundleId.length > 0) {
            excludeSet.add(app.bundleId);
          }
        }
      }

      // An allowlist too: the granted apps' windows, and no other's.
      const includeSet = new Set<string>();
      for (const app of runningApps)
        if (app.bundleId.length > 0 && !excludeSet.has(app.bundleId) && resolveGrantTier(options.grantedApps, app) !== undefined)
          includeSet.add(app.bundleId);
      return await inner.capture(target, {
        ...captureOptions,
        excludeBundleIds: [...excludeSet],
        includeBundleIds: [...includeSet],
      });
    },

    async act(action: DesktopAction, actOptions: DesktopActOptions = {}): Promise<DesktopActionOutcome> {
      const generation = abortGeneration;
      const abortedSince = (): DesktopActionOutcome | undefined =>
        abortGeneration !== generation || actOptions.signal?.aborted === true
          ? { status: "rejected", detail: "Desktop action aborted by operator hotkey. Do not retry." }
          : undefined;
      if (abortedByHotkey || actOptions.signal?.aborted === true) {
        return {
          status: "rejected",
          detail: "Desktop action aborted by operator hotkey. Do not retry.",
        };
      }

      // Attended only: unattended runs never drive the desktop.
      if (!isAttended(actOptions)) {
        return {
          status: "rejected",
          detail: "Desktop actions are attended-only; unattended runs cannot drive the desktop. Do not retry.",
        };
      }

      if (action.kind === "wait") {
        return await inner.act(action, actOptions);
      }

      const beforeFocused = await inner.focusedElement?.();
      let dispatched: DesktopAction = action;

      // Check currently focused element for active credential fields or auth dialogs before any keyboard/type action.
      if (isKeyboardOrWriteAction(action)) {
        // Keys go to the app in front: said so, by name, when that is not the app the call names (or none can be read).
        const misdirected = await keyboardTargetDenial(beforeFocused, actOptions.app);
        if (misdirected !== undefined) return { status: "rejected", detail: misdirected };
        const focusDenial =
          checkElementSafety(beforeFocused, action, actOptions) ?? (await checkKeyPress(action, beforeFocused, actOptions));
        if (focusDenial !== undefined) {
          return { status: "rejected", detail: focusDenial };
        }
      }

      // Resolve target by ref if specified.
      if ("ref" in action && action.ref !== undefined) {
        const resolved = resolveNodeFromRef(action.ref, actOptions.app);
        if (resolved === undefined || resolved.node.bounds === undefined) {
          return {
            status: "rejected",
            detail: `Target ref '${action.ref}' could not be resolved (fail-closed). Do not retry.`,
          };
        }
        const { node, tree } = resolved;
        const bounds = node.bounds;
        if (bounds === undefined) {
          return {
            status: "rejected",
            detail: `Target ref '${action.ref}' has no bounds (fail-closed). Do not retry.`,
          };
        }
        const syntheticElement: DesktopResolvedElement = {
          app: tree.app,
          ...(tree.windowTitle === undefined ? {} : { windowTitle: tree.windowTitle }),
          role: node.role,
          ...definedOnly({ subrole: node.subrole, title: node.title, value: node.value, description: node.description }),
          bounds,
          ...(node.enabled === undefined ? {} : { enabled: node.enabled }),
          ...(node.focused === undefined ? {} : { focused: node.focused }),
        };
        const refDenial = checkElementSafety(syntheticElement, action, actOptions);
        if (refDenial !== undefined) {
          return { status: "rejected", detail: refDenial };
        }

        // Also hit-test the center of the ref's bounds so an overlapping blocked window (e.g. 1Password over TextEdit) is
        // caught. Without a hit-test nothing says what is there: refused.
        const cx = Math.round(bounds.x + bounds.width / 2);
        const cy = Math.round(bounds.y + bounds.height / 2);
        if (inner.elementAtPoint === undefined) {
          return { status: "rejected", detail: "Hit-test unavailable for the ref's point (fail-closed). Do not retry." };
        }
        const hitElement = await inner.elementAtPoint(cx, cy);
        const hitDenial =
          checkElementSafety(hitElement, action, actOptions) ??
          (action.kind === "click" || action.kind === "type"
            ? await checkPressedControl(hitElement, { x: cx, y: cy }, { kind: "click", x: cx, y: cy }, actOptions)
            : undefined);
        if (hitDenial !== undefined) {
          return { status: "rejected", detail: hitDenial };
        }
        // What is sent is the point just checked, never the ref: the engine's own idea of a ref (another app's tree read
        // later) could name another place.
        if (action.kind === "type") {
          // Typing by ref clicks into the field first: that click is checked as a click (a "Send" under the ref is a
          // commit), and the focus it lands on is what the text goes to, checked again.
          const click: DesktopAction = { kind: "click", x: cx, y: cy };
          const clickDenial = checkElementSafety(hitElement, click, actOptions);
          if (clickDenial !== undefined) {
            return { status: "rejected", detail: clickDenial };
          }
          const stoppedBeforeClick = abortedSince();
          if (stoppedBeforeClick !== undefined) return stoppedBeforeClick;
          const clicked = await inner.act(click, actOptions);
          if (clicked.status !== "accepted") {
            return { status: "rejected", ...(clicked.detail === undefined ? {} : { detail: clicked.detail }) };
          }
          const landed = await inner.focusedElement?.();
          const landedDenial = checkElementSafety(landed, action, actOptions) ?? (await checkKeyPress(action, landed, actOptions));
          if (landedDenial !== undefined) {
            return { status: "rejected", detail: landedDenial };
          }
          dispatched = { kind: "type", text: action.text };
        } else if (action.kind === "click" || action.kind === "move" || action.kind === "scroll") {
          const { ref: _ref, ...rest } = action;
          dispatched = { ...rest, x: cx, y: cy };
        }
      } else if (isPointerActionWithPoint(action)) {
        const x = action.x;
        const y = action.y;
        if (typeof x !== "number" || typeof y !== "number" || inner.elementAtPoint === undefined) {
          return {
            status: "rejected",
            detail: "Pointer coordinates or hit-test unavailable (fail-closed). Do not retry.",
          };
        }
        const hitElement = await inner.elementAtPoint(x, y);
        // A drag, and a mouse button held down, presses what is there, as a click would.
        const presses = action.kind === "click" || action.kind === "drag" || action.kind === "mouse_down";
        const pressAt = { kind: "click", x, y } as const;
        const hitDenial =
          checkElementSafety(hitElement, action, actOptions) ??
          (presses ? checkElementSafety(hitElement, pressAt, actOptions) : undefined) ??
          (presses ? await checkPressedControl(hitElement, { x, y }, pressAt, actOptions) : undefined);
        if (hitDenial !== undefined) {
          return { status: "rejected", detail: hitDenial };
        }
        if (action.kind === "drag") {
          const endHit = await inner.elementAtPoint(action.toX, action.toY);
          const endDenial = checkElementSafety(endHit, action, actOptions);
          if (endDenial !== undefined) {
            return { status: "rejected", detail: endDenial };
          }
        }
      }

      // Every check above awaited: an abort that came in meanwhile stops the action here.
      const stopped = abortedSince();
      if (stopped !== undefined) return stopped;
      const outcome = await inner.act(dispatched, actOptions);
      if (outcome.status !== "accepted") {
        // Gate action and capture as one unit: a rejected action returns no capture.
        return {
          status: "rejected",
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        };
      }

      const afterFocused = await inner.focusedElement?.();
      const beforeSnap = snapshotFromElement(beforeFocused);
      const afterSnap = snapshotFromElement(afterFocused);
      const changes = outcome.changes ?? describeDesktopChanges(beforeSnap, afterSnap);

      let postCapture: DesktopCaptureResult | undefined;
      if (options.includeCaptureOnAct === true) {
        try {
          postCapture = await this.capture({ kind: "display" });
        } catch {
          postCapture = undefined;
        }
      }

      return {
        status: "accepted",
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        ...(changes.length === 0 ? {} : { changes }),
        ...definedOnly({ before: beforeSnap, after: afterSnap, capture: postCapture }),
      };
    },

    async abort(): Promise<void> {
      abortedByHotkey = true;
      abortGeneration += 1;
      await inner.abort?.();
    },

    async dispose(): Promise<void> {
      await inner.dispose?.();
    },
  };
}
