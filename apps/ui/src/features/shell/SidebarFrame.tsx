import type { CSSProperties, ReactNode } from "react";

import { IconButton } from "../../ui/IconButton.js";
import { type PanelBounds, loadWidth, saveWidth, useResizablePanel } from "../../hooks/resizable.js";
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_RESERVE_WIDTH } from "../../lib/layout.js";

export const SIDEBAR_WIDTH_KEY = "tavi.sidebar.width";

const SIDEBAR_BOUNDS: PanelBounds = {
  side: "left",
  key: SIDEBAR_WIDTH_KEY,
  min: MIN_SIDEBAR_WIDTH,
  max: MAX_SIDEBAR_WIDTH,
  initial: DEFAULT_SIDEBAR_WIDTH,
  reserve: SIDEBAR_RESERVE_WIDTH,
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
 * (`title` and `label` name it), so the column keeps its width key. The control lives here rather than in the header because
 * it acts on this panel — a reader closes what they are looking at — and the
 * `Cmd+Shift+S` chord is the browser's to overrule, so the panel is
 * never without a button.
 */
export function SidebarFrame({
  title = "Chats",
  label = "chats",
  className,
  onNew,
  newLabel = "New chat",
  onNewOwn,
  onNewPrivate,
  onCollapse,
  initialWidth,
  onWidthChange,
  children,
}: {
  /** The panel's heading, and what its collapse control names. */
  readonly title?: string;
  /** The nav's accessible name. */
  readonly label?: string;
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
  const { width, dragging, separator } = useResizablePanel(SIDEBAR_BOUNDS, { initialWidth, onWidthChange });

  return (
    <nav
      className={className === undefined ? "side-panel sidebar" : `side-panel sidebar ${className}`}
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      aria-label={label}
    >
      <div className="sidebar-head">
        <h2>{title}</h2>
        <div className="sidebar-head-actions">
          {onNewOwn === undefined ? null : (
            <IconButton
              icon="square-pen"
              size="sm"
              className="new-own-session button-sm button-xs"
              label={NEW_OWN_CHAT_LABEL}
              tooltip={NEW_OWN_CHAT_TOOLTIP}
              onClick={onNewOwn}
            />
          )}
          {onNew === undefined ? null : (
            <IconButton
              icon="plus"
              size="sm"
              className="new-session button-sm button-xs"
              label={newLabel}
              tooltip={newTooltip(newLabel)}
              onClick={onNew}
            />
          )}
          {onNewPrivate === undefined ? null : (
            <IconButton
              icon="ghost"
              size="sm"
              className="new-private-session button-sm button-xs"
              label={NEW_PRIVATE_CHAT_LABEL}
              tooltip="New private chat: memory off, not searched later, forgotten a day after its last message"
              onClick={onNewPrivate}
            />
          )}
          {onCollapse === undefined ? null : (
            <IconButton
              icon="panel-close"
              size="sm"
              className="sidebar-toggle button-sm button-xs"
              label={`Hide ${title.toLowerCase()}`}
              tooltip={`Hide ${title.toLowerCase()} (Cmd+Shift+S)`}
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
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabIndex={0}
        {...separator}
      />
    </nav>
  );
}

/** What a chat of its own is called while Home is on, beside *New side chat*. */
const NEW_OWN_CHAT_LABEL = "New chat";
const NEW_OWN_CHAT_TOOLTIP = "New chat: a chat of its own, with nothing of the chat on screen";

/** The + control's tooltip: a side chat says it carries on from the chat on screen, its untrusted content included. */
function newTooltip(label: string | undefined): string {
  return label === "New side chat"
    ? "New side chat: carries on from the chat on screen, with what it read; for a clean start use New chat"
    : (label ?? "New chat");
}

/** What *New private chat* is called wherever it is offered. */
export const NEW_PRIVATE_CHAT_LABEL = "New private chat";

/** The panel, collapsed: a rail that keeps the way back one click away. */
export function SidebarRail({
  title = "Chats",
  onExpand,
  onNew,
  newLabel = "New chat",
  onNewOwn,
}: {
  readonly title?: string;
  readonly onExpand: () => void;
  readonly onNew?: (() => void) | undefined;
  readonly newLabel?: string;
  /** *New chat* while Home is on, beside + (*New side chat*), as in the open panel. */
  readonly onNewOwn?: (() => void) | undefined;
}) {
  return (
    <aside className="panel-rail sidebar-rail">
      <IconButton
        icon="panel-open"
        className="sidebar-toggle button-sm"
        label={`Show ${title.toLowerCase()}`}
        tooltip={`Show ${title.toLowerCase()} (Cmd+Shift+S)`}
        aria-expanded={false}
        onClick={onExpand}
      />
      {onNewOwn === undefined ? null : (
        <IconButton
          icon="square-pen"
          className="new-own-session button-sm"
          label={NEW_OWN_CHAT_LABEL}
          tooltip={NEW_OWN_CHAT_TOOLTIP}
          onClick={onNewOwn}
        />
      )}
      {onNew === undefined ? null : (
        <IconButton icon="plus" className="new-session button-sm" label={newLabel} tooltip={newTooltip(newLabel)} onClick={onNew} />
      )}
    </aside>
  );
}
