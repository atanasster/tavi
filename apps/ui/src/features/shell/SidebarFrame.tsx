import type { CSSProperties, ReactNode } from "react";

import { IconButton } from "../../ui/IconButton.js";
import { type PanelBounds, loadWidth, saveWidth, useResizablePanel } from "../../hooks/resizable.js";
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_RESERVE_WIDTH } from "../../lib/layout.js";
import { translateCore, useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import type { CanvasCoreKey } from "@tavi/contracts/locales/core-canvas-en";

export const SIDEBAR_WIDTH_KEY = "tavi.sidebar.width";

const SIDEBAR_BOUNDS: PanelBounds = {
  side: "left",
  key: SIDEBAR_WIDTH_KEY,
  min: MIN_SIDEBAR_WIDTH,
  max: MAX_SIDEBAR_WIDTH,
  initial: DEFAULT_SIDEBAR_WIDTH,
  reserve: SIDEBAR_RESERVE_WIDTH,
};

/** Which panel the frame holds: the chats, the Command Center's sections, or Settings' views. */
export type SidebarPanel = "chats" | "center" | "settings";

/**
 * Each panel's words, whole: its heading, its nav's name, and its hide and show controls. A heading that names a
 * place messages name too (the Command Center) is a `core` word, `{ core }`.
 */
const PANEL_WORDS: Readonly<
  Record<
    SidebarPanel,
    { readonly title: UiKey | { readonly core: CanvasCoreKey }; readonly label: UiKey; readonly hide: UiKey; readonly show: UiKey }
  >
> = {
  chats: {
    title: "shell.sidebar.chats.title",
    label: "shell.sidebar.chats.label",
    hide: "shell.sidebar.chats.hide",
    show: "shell.sidebar.chats.show",
  },
  center: {
    title: { core: "nav.route.commandCenter" },
    label: "shell.sidebar.center.label",
    hide: "shell.sidebar.center.hide",
    show: "shell.sidebar.center.show",
  },
  settings: {
    title: "shell.sidebar.settings.title",
    label: "shell.sidebar.settings.label",
    hide: "shell.sidebar.settings.hide",
    show: "shell.sidebar.settings.show",
  },
};

export function loadSidebarWidth(storage?: Pick<Storage, "getItem">): number {
  return loadWidth(SIDEBAR_BOUNDS, storage);
}

export function saveSidebarWidth(width: number, storage?: Pick<Storage, "setItem">): void {
  saveWidth(SIDEBAR_WIDTH_KEY, width, storage);
}

/**
 * The sessions panel's frame: its heading, its own collapse control, and the
 * scrolling body. The Command Center puts its section nav in the same frame
 * (`panel` names it), so the column keeps its width key. The control lives here rather than in the header because
 * it acts on this panel — a reader closes what they are looking at — and the
 * `Cmd+Shift+S` chord is the browser's to overrule, so the panel is
 * never without a button.
 */
export function SidebarFrame({
  panel = "chats",
  className,
  onNew,
  newLabel,
  onNewOwn,
  onNewPrivate,
  onCollapse,
  initialWidth,
  onWidthChange,
  children,
}: {
  /** The panel held: its heading, its nav's name and what its collapse control says. */
  readonly panel?: SidebarPanel;
  readonly className?: string | undefined;
  readonly onNew?: (() => void) | undefined;
  /** What `onNew` starts: "New side chat" while Home is on, else "New chat". */
  readonly newLabel?: string | undefined;
  /** *New chat* while Home is on, beside + (*New side chat*): a chat of its own, with nothing of the chat on screen. */
  readonly onNewOwn?: (() => void) | undefined;
  /** *New private chat*, beside the new chat's +: a chat whose memory is off for good. */
  readonly onNewPrivate?: (() => void) | undefined;
  readonly onCollapse?: (() => void) | undefined;
  readonly initialWidth?: number | undefined;
  readonly onWidthChange?: ((width: number) => void) | undefined;
  readonly children: ReactNode;
}) {
  const t = useT();
  const words = PANEL_WORDS[panel];
  const { width, dragging, separator } = useResizablePanel(SIDEBAR_BOUNDS, { initialWidth, onWidthChange });
  const newWords = newLabel ?? t("shell.sidebar.newChat");

  return (
    <nav
      className={className === undefined ? "side-panel sidebar" : `side-panel sidebar ${className}`}
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      aria-label={t(words.label)}
    >
      <div className="sidebar-head">
        <h2>{typeof words.title === "string" ? t(words.title) : translateCore(words.title.core)}</h2>
        <div className="sidebar-head-actions">
          {onNewOwn === undefined ? null : (
            <IconButton
              icon="square-pen"
              size="sm"
              className="new-own-session button-sm button-xs"
              label={t("shell.sidebar.newChat")}
              tooltip={t("shell.sidebar.newChatTooltip")}
              onClick={onNewOwn}
            />
          )}
          {onNew === undefined ? null : (
            <IconButton
              icon="plus"
              size="sm"
              className="new-session button-sm button-xs"
              label={newWords}
              tooltip={newTooltip(t, newWords)}
              onClick={onNew}
            />
          )}
          {onNewPrivate === undefined ? null : (
            <IconButton
              icon="ghost"
              size="sm"
              className="new-private-session button-sm button-xs"
              label={t("shell.sidebar.newPrivateChat")}
              tooltip={t("shell.sidebar.newPrivateChatTooltip")}
              onClick={onNewPrivate}
            />
          )}
          {onCollapse === undefined ? null : (
            <IconButton
              icon="panel-close"
              size="sm"
              className="sidebar-toggle button-sm button-xs"
              label={t(words.hide)}
              tooltip={`${t(words.hide)} (Cmd+Shift+S)`}
              aria-expanded={true}
              onClick={onCollapse}
            />
          )}
        </div>
      </div>
      <div className="sidebar-body">{children}</div>
      <div
        className={`panel-resizer sidebar-resizer${dragging ? " active" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("shell.sidebar.resize")}
        aria-valuenow={width}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabIndex={0}
        {...separator}
      />
    </nav>
  );
}

/** The + control's tooltip: a side chat says it carries on from the chat on screen, its untrusted content included. */
function newTooltip(t: ReturnType<typeof useT>, label: string): string {
  return label === t("shell.sidebar.newSideChat") ? t("shell.sidebar.newSideChatTooltip") : label;
}

/** The panel, collapsed: a rail that keeps the way back one click away. */
export function SidebarRail({
  panel = "chats",
  onExpand,
  onNew,
  newLabel,
  onNewOwn,
}: {
  readonly panel?: SidebarPanel;
  readonly onExpand: () => void;
  readonly onNew?: (() => void) | undefined;
  readonly newLabel?: string;
  /** *New chat* while Home is on, beside + (*New side chat*), as in the open panel. */
  readonly onNewOwn?: (() => void) | undefined;
}) {
  const t = useT();
  const words = PANEL_WORDS[panel];
  const newWords = newLabel ?? t("shell.sidebar.newChat");
  return (
    <aside className="panel-rail sidebar-rail">
      <IconButton
        icon="panel-open"
        className="sidebar-toggle button-sm"
        label={t(words.show)}
        tooltip={`${t(words.show)} (Cmd+Shift+S)`}
        aria-expanded={false}
        onClick={onExpand}
      />
      {onNewOwn === undefined ? null : (
        <IconButton
          icon="square-pen"
          className="new-own-session button-sm"
          label={t("shell.sidebar.newChat")}
          tooltip={t("shell.sidebar.newChatTooltip")}
          onClick={onNewOwn}
        />
      )}
      {onNew === undefined ? null : (
        <IconButton icon="plus" className="new-session button-sm" label={newWords} tooltip={newTooltip(t, newWords)} onClick={onNew} />
      )}
    </aside>
  );
}
