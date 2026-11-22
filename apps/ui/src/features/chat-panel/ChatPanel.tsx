import type { CSSProperties, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { TASK_TITLE_MAX } from "@tavi/contracts";

import { Icon, type IconName } from "../../ui/Icon.js";
import { IconButton } from "../../ui/IconButton.js";
import { Failure } from "../../ui/Parts.js";
import { TabList } from "../../ui/Tabs.js";
import { Tooltip } from "../../ui/Tooltip.js";
import { type PanelBounds, useResizablePanel } from "../../hooks/resizable.js";
import { useT } from "../../lib/i18n.js";
import type { Translate } from "@tavi/contracts/i18n";
import type { UiKey } from "../../locales/en.js";
import { readStored, writeStored } from "../../lib/storage.js";
import {
  CHAT_PANEL_LABELS,
  CHAT_PANEL_TABS,
  isChatPanelTab,
  isPanelTab,
  type ChatPanelTab,
  type PanelTab,
  type PluginPanelTab,
} from "./tabs.js";
import { Button } from "../../ui/Button.js";
import { Field } from "../../ui/Field.js";
import {
  CHAT_PANEL_SNAP_COLLAPSE_WIDTH,
  DEFAULT_CHAT_PANEL_WIDTH,
  MAX_CHAT_PANEL_WIDTH,
  MIN_CHAT_PANEL_WIDTH,
  SHEET,
  TRANSCRIPT_MIN_WIDTH,
} from "../../lib/layout.js";

/**
 * The chat panel: the Command Center's sections for
 * the open chat, in a right-hand column the reader can resize, collapse to an
 * icon rail, or close. The Center stays the global view; this is that view
 * filtered to one chat.
 */
const CHAT_PANEL_ICONS: Readonly<Record<ChatPanelTab, IconName>> = {
  activity: "center-activity",
  schedule: "center-schedule",
  memory: "center-soul",
  instructions: "instructions",
  details: "info",
};

const CHAT_PANEL_WIDTH_KEY = "tavi.chatpanel.width";
const CHAT_PANEL_OPEN_KEY = "tavi.chatpanel.open";
const CHAT_PANEL_TAB_KEY = "tavi.chatpanel.tab";
const CHAT_PANEL_SHEET_KEY = "tavi.chatpanel.sheet";

export const CHAT_PANEL_BOUNDS: PanelBounds = {
  side: "right",
  key: CHAT_PANEL_WIDTH_KEY,
  min: MIN_CHAT_PANEL_WIDTH,
  max: MAX_CHAT_PANEL_WIDTH,
  initial: DEFAULT_CHAT_PANEL_WIDTH,
  reserve: TRANSCRIPT_MIN_WIDTH,
  snapCollapse: CHAT_PANEL_SNAP_COLLAPSE_WIDTH,
};

/** Whether the reader left the panel open, and on which tab; optional storage, read once. */
export function loadChatPanel(storage?: Pick<Storage, "getItem">): { readonly open: boolean; readonly tab: PanelTab } {
  const tab = readStored(CHAT_PANEL_TAB_KEY, storage);
  return { open: readStored(CHAT_PANEL_OPEN_KEY, storage) === "true", tab: isPanelTab(tab) ? tab : "activity" };
}

export function saveChatPanel(state: { readonly open: boolean; readonly tab: PanelTab }, storage?: Pick<Storage, "setItem">): void {
  writeStored(CHAT_PANEL_OPEN_KEY, String(state.open), storage);
  writeStored(CHAT_PANEL_TAB_KEY, state.tab, storage);
}

/** What a rail icon carries: a count, or a dot for "something changed". */
export type ChatPanelBadge = number | "dot";

/** Whether a badge has anything to show. */
const shows = (badge: ChatPanelBadge | undefined): badge is ChatPanelBadge => badge !== undefined && badge !== 0;

/** A badge as it is drawn: hidden from a screen reader, which hears it in its tab's name (`named`). */
function Badge({ badge }: { readonly badge: ChatPanelBadge | undefined }) {
  if (!shows(badge)) return null;
  return badge === "dot" ? (
    <span className="chat-panel-dot" aria-hidden="true" />
  ) : (
    <span className="chat-panel-count" aria-hidden="true">
      {badge}
    </span>
  );
}

/** A tab's or rail icon's name with what its badge says: "Activity, 3 new", "Details, changed". */
const named = (t: Translate<UiKey>, label: string, badge: ChatPanelBadge | undefined): string =>
  !shows(badge) ? label : badge === "dot" ? t("chatPanel.tab.changed", { label }) : t("chatPanel.tab.new", { label, count: badge });

/**
 * A tab a UI plugin contributes (slot `chat.panel.tab`): its title, its icon
 * (served under `/plugin-ui/`, an `<img>`: an SVG shown as an image runs no
 * script), and what its plugin marked it with.
 */
export interface PluginTabInfo {
  readonly tab: PluginPanelTab;
  readonly label: string;
  readonly icon?: string | undefined;
  readonly badge?: ChatPanelBadge | undefined;
}

function TabGlyph({ tab, pluginTabs }: { readonly tab: PanelTab; readonly pluginTabs: readonly PluginTabInfo[] }) {
  if (isChatPanelTab(tab)) return <Icon name={CHAT_PANEL_ICONS[tab]} size="sm" />;
  const icon = pluginTabs.find((candidate) => candidate.tab === tab)?.icon;
  return icon === undefined ? (
    <Icon name="info" size="sm" />
  ) : (
    <img className="chat-panel-plugin-icon" src={icon} alt="" width={16} height={16} />
  );
}

/**
 * The panel. Closed, it is a 44px rail of the same tabs, so any section is one
 * click away; open, a header, a tab list and the current tab's body, which is
 * rendered only while shown so a closed panel asks the owner for nothing.
 *
 * UI plugins add to it: `pluginTabs` after
 * the built-in five, and `top`, shown between the header and the tab strip
 * (the `chat.panel.top` slot), told how high the phone sheet stands.
 */
export function ChatPanel({
  open,
  tab,
  title,
  status,
  onRename,
  renamed = false,
  titleKey,
  badges = {},
  onOpen,
  onTab,
  onWidthChange,
  render,
  pluginTabs = [],
  top,
}: {
  readonly open: boolean;
  readonly tab: PanelTab;
  /** The chat's name; absent before one is selected. */
  readonly title: string | undefined;
  /** What the chat is doing, in words. */
  readonly status?: string | undefined;
  /** Name the chat (`null`: back to its generated title); absent, the title is not editable. Resolves to a refusal's message, or undefined. */
  readonly onRename?: ((title: string | null) => Promise<string | undefined>) | undefined;
  /** The title is the reader's name, so it can go back to the generated one. */
  readonly renamed?: boolean | undefined;
  /** Which chat the title names: a rename begun on one chat is dropped when another opens. */
  readonly titleKey?: string | undefined;
  readonly badges?: Partial<Record<ChatPanelTab, ChatPanelBadge>>;
  readonly onOpen: (open: boolean) => void;
  readonly onTab: (tab: PanelTab) => void;
  readonly onWidthChange?: ((width: number) => void) | undefined;
  readonly render: (tab: PanelTab) => ReactNode;
  /** Contributed tabs, after the built-in ones. */
  readonly pluginTabs?: readonly PluginTabInfo[];
  /** The `chat.panel.top` slot's content, given the phone sheet's height. */
  readonly top?: ((sheet: SheetSnap) => ReactNode) | undefined;
}) {
  const t = useT();
  const id = useId();
  const tabs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});
  /** Every tab in order; a contributed tab that has gone (its plugin was disabled) shows Activity instead. */
  const order: readonly PanelTab[] = [...CHAT_PANEL_TABS, ...pluginTabs.map((plugin) => plugin.tab)];
  const shown: PanelTab = order.includes(tab) ? tab : "activity";
  const labelOf = (value: PanelTab): string =>
    isChatPanelTab(value)
      ? CHAT_PANEL_LABELS[value]
      : (pluginTabs.find((plugin) => plugin.tab === value)?.label ?? t("chatPanel.tab.plugin"));
  const badgeOf = (value: PanelTab): ChatPanelBadge | undefined =>
    isChatPanelTab(value) ? badges[value] : pluginTabs.find((plugin) => plugin.tab === value)?.badge;
  // A tab-panel id may not hold the contributed tab's colon or slash.
  const tabId = (value: PanelTab): string => `${id}-${value.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const rail = useRef<HTMLElement>(null);
  const panelId = `${id}-panel`;
  // A control that opens or closes the panel unmounts with it, so focus is put
  // where the reader's next step is: the rail's toggle, or the open tab. Shut
  // from elsewhere (the shortcut, the sidebar taking the room) with focus
  // inside it, the focus would be lost with the panel: it goes to the toggle too.
  const focusAfter = useRef<"rail" | "tab" | undefined>(undefined);
  const wasOpen = useRef(open);
  /** Whether focus is in the open panel: a removed element sends no blur, so it still says so once the panel is gone. */
  const focusInside = useRef(false);
  useEffect(() => {
    const lost =
      wasOpen.current && !open && focusInside.current && (document.activeElement === null || document.activeElement === document.body);
    wasOpen.current = open;
    if (!open) focusInside.current = false;
    if (focusAfter.current === "rail" || (focusAfter.current === undefined && lost))
      rail.current?.querySelector<HTMLButtonElement>(".chat-panel-toggle")?.focus();
    else if (focusAfter.current === "tab") tabs.current[shown]?.focus();
    focusAfter.current = undefined;
  }, [open]);
  const close = () => {
    focusAfter.current = "rail";
    onOpen(false);
  };
  // On a phone the panel is a sheet the reader sizes: its height in percent of the page's, kept for the next visit.
  const [height, setHeight] = useState(readSheetHeight);
  const sheet: SheetSnap = height >= SHEET.fullFrom ? "full" : "half";
  const resize = (next: number) => {
    setHeight(next);
    writeStored(CHAT_PANEL_SHEET_KEY, String(next));
  };
  // The page under the sheet reads its height too, to keep room to scroll above it: set on the page's body as well.
  useEffect(() => {
    const element = aside.current;
    const holder = element?.closest<HTMLElement>(".body") ?? element;
    if (!open || holder === null || holder === undefined) return;
    holder.style.setProperty("--chat-panel-sheet-height", `${height}dvh`);
    return () => {
      holder.style.removeProperty("--chat-panel-sheet-height");
    };
  }, [open, height]);
  // A drag moves the sheet by a style on the element, not by state: the
  // panel's tabs are not rendered again for every move of a finger.
  const aside = useRef<HTMLElement>(null);
  const dragSheet = (offset: number) => {
    const element = aside.current;
    if (element === null) return;
    if (offset === 0) element.style.removeProperty("--chat-panel-sheet-drag");
    else element.style.setProperty("--chat-panel-sheet-drag", `${offset}px`);
    element.classList.toggle("sheet-dragging", offset !== 0);
  };
  const { width, dragging, separator } = useResizablePanel(CHAT_PANEL_BOUNDS, { onWidthChange, onCollapse: close });

  const pick = (next: PanelTab) => {
    onTab(next);
    focusAfter.current = "tab";
    if (!open) onOpen(true);
  };

  // Arrow keys move between tabs and select them (the APG's automatic tabs).
  if (!open) {
    return (
      <aside ref={rail} className="panel-rail chat-panel-rail" aria-label={t("chatPanel.label")}>
        <span className="chat-panel-rail-toggle">
          <IconButton
            icon="panel-right-open"
            className="chat-panel-toggle button-sm"
            label={t("chatPanel.show")}
            tooltip={t("chatPanel.showTooltip", { chord: "Cmd+Shift+." })}
            aria-expanded={false}
            onClick={() => {
              focusAfter.current = "tab";
              onOpen(true);
            }}
          />
          {/* On a phone the rail is this one button: it marks that any tab has news. */}
          {order.some((value) => shows(badgeOf(value))) ? (
            <span className="chat-panel-dot chat-panel-any" role="img" aria-label={t("chatPanel.anyChanged")} />
          ) : null}
        </span>
        {order.map((value) => (
          <span key={value} className="chat-panel-rail-item">
            {isChatPanelTab(value) ? (
              <IconButton
                icon={CHAT_PANEL_ICONS[value]}
                className="button-sm"
                label={named(t, CHAT_PANEL_LABELS[value], badgeOf(value))}
                tooltip={CHAT_PANEL_LABELS[value]}
                onClick={() => pick(value)}
              />
            ) : (
              <Tooltip text={labelOf(value)}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="button-icon"
                  aria-label={named(t, labelOf(value), badgeOf(value))}
                  onClick={() => pick(value)}
                >
                  <TabGlyph tab={value} pluginTabs={pluginTabs} />
                </Button>
              </Tooltip>
            )}
            <Badge badge={badgeOf(value)} />
          </span>
        ))}
      </aside>
    );
  }

  return (
    <aside
      ref={aside}
      className={`side-panel chat-panel sheet-${sheet}`}
      aria-label={t("chatPanel.label")}
      style={{ "--chat-panel-width": `${width}px`, "--chat-panel-sheet-height": `${height}dvh` } as CSSProperties}
      onFocus={() => {
        focusInside.current = true;
      }}
      onBlur={(event) => {
        focusInside.current = event.currentTarget.contains(event.relatedTarget);
      }}
    >
      <SheetHandle
        height={height}
        onResize={resize}
        onDrag={dragSheet}
        onClose={() => {
          resize(SHEET.half);
          close();
        }}
      />
      <div
        className={`panel-resizer chat-panel-resizer${dragging ? " active" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("chatPanel.resize")}
        aria-valuenow={width}
        aria-valuemin={MIN_CHAT_PANEL_WIDTH}
        aria-valuemax={MAX_CHAT_PANEL_WIDTH}
        tabIndex={0}
        {...separator}
      />
      <div className="chat-panel-head">
        <div className="chat-panel-title">
          {onRename === undefined ? (
            <h2 className="truncate">{title ?? t("chatPanel.thisChat")}</h2>
          ) : (
            <ChatTitle key={titleKey} title={title} renamed={renamed} onRename={onRename} />
          )}
          {status === undefined ? null : <span className="chat-panel-status meta-sm">{status}</span>}
        </div>
        <IconButton
          icon="panel-right-close"
          size="sm"
          className="chat-panel-toggle"
          label={t("chatPanel.hide")}
          tooltip={t("chatPanel.hideTooltip", { chord: "Cmd+Shift+." })}
          aria-expanded={true}
          onClick={close}
        />
      </div>
      {top?.(sheet)}
      <TabList
        label={t("chatPanel.sections")}
        className="chat-panel-tabs segmented"
        tabClassName="chat-panel-tab segment"
        activeClassName="active"
        items={order.map((value) => ({
          value,
          ariaLabel: named(t, labelOf(value), badgeOf(value)),
          content: (
            <>
              <TabGlyph tab={value} pluginTabs={pluginTabs} />
              <Badge badge={badgeOf(value)} />
            </>
          ),
        }))}
        current={shown}
        onPick={onTab}
        tabId={tabId}
        panelId={panelId}
        tabRef={(value, node) => {
          tabs.current[value] = node;
        }}
      />
      <h3 className="chat-panel-section eyebrow">{labelOf(shown)}</h3>
      <div
        className={isChatPanelTab(shown) ? "chat-panel-body" : "chat-panel-body chat-panel-plugin-body"}
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(shown)}
      >
        {render(shown)}
      </div>
    </aside>
  );
}

/**
 * The chat's name, renamed in place: the pencil opens a field, Enter
 * saves and Escape leaves it as it was; an empty name, or "Use the generated
 * name", goes back to the title the chat was given.
 */
function ChatTitle({
  title,
  renamed,
  onRename,
}: {
  readonly title: string | undefined;
  readonly renamed: boolean;
  readonly onRename: (title: string | null) => Promise<string | undefined>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);
  const save = async (next: string | null): Promise<void> => {
    setSaving(true);
    const refused = await onRename(next === null || next.trim() === "" ? null : next.trim());
    setSaving(false);
    setFailure(refused);
    if (refused === undefined) setEditing(false);
  };
  if (!editing) {
    return (
      <div className="chat-panel-name">
        <h2 className="truncate">{title ?? t("chatPanel.thisChat")}</h2>
        <IconButton
          icon="instructions"
          size="sm"
          label={t("chatPanel.rename.action")}
          onClick={() => {
            setDraft(title ?? "");
            setFailure(undefined);
            setEditing(true);
          }}
        />
      </div>
    );
  }
  return (
    <form
      className="chat-panel-rename"
      onSubmit={(event) => {
        event.preventDefault();
        void save(draft);
      }}
    >
      <Field id={id} label={t("chatPanel.rename.field")} labelClassName="visually-hidden">
        <input
          ref={field}
          value={draft}
          maxLength={TASK_TITLE_MAX}
          disabled={saving}
          aria-invalid={failure === undefined ? undefined : true}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
        />
      </Field>
      {renamed ? (
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => void save(null)}>
          {t("chatPanel.rename.generated")}
        </Button>
      ) : null}
      <Failure message={failure} />
    </form>
  );
}

/** Whether the phone sheet stands low or high: the plugin slot shows only when it is high. */
export type SheetSnap = "half" | "full";

/** The sheet's height as the reader last left it, in range; where it opens otherwise. */
function readSheetHeight(): number {
  const stored = Number(readStored(CHAT_PANEL_SHEET_KEY));
  return Number.isFinite(stored) && stored >= SHEET.min && stored <= SHEET.full ? stored : SHEET.half;
}

/**
 * The phone sheet's grip (shown at 720px and narrower): a drag sizes the
 * sheet to where the finger lets go, between `SHEET.min` and `SHEET.full`,
 * and lower than the least closes it; a tap moves between half and full
 * height. Its arrow keys step the height, and down past the least close it,
 * so it is never touch-only.
 */
function SheetHandle({
  height,
  onResize,
  onDrag,
  onClose,
}: {
  readonly height: number;
  readonly onResize: (height: number) => void;
  readonly onDrag: (offset: number) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const start = useRef<number | undefined>(undefined);
  const moved = useRef(false);
  const settle = (next: number) => {
    if (next < SHEET.min) onClose();
    else onResize(Math.min(SHEET.full, Math.round(next)));
  };
  const full = height >= SHEET.fullFrom;
  return (
    <Button
      className="chat-panel-grip"
      aria-label={full ? t("chatPanel.sheet.shrink") : t("chatPanel.sheet.expand")}
      title={t("chatPanel.sheet.drag")}
      onPointerDown={(event) => {
        start.current = event.clientY;
        moved.current = false;
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (start.current === undefined) return;
        const offset = event.clientY - start.current;
        if (Math.abs(offset) > 4) moved.current = true;
        onDrag(offset);
      }}
      onPointerUp={(event) => {
        if (start.current === undefined) return;
        const offset = event.clientY - start.current;
        start.current = undefined;
        onDrag(0);
        if (moved.current) settle(height - (offset / window.innerHeight) * 100);
      }}
      onPointerCancel={() => {
        start.current = undefined;
        onDrag(0);
      }}
      onClick={() => {
        if (moved.current) {
          moved.current = false;
          return;
        }
        onResize(full ? SHEET.half : SHEET.full);
      }}
      onKeyDown={(event) => {
        // A touch drag that brought no click must not swallow the next key press as its tap.
        moved.current = false;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onResize(Math.min(SHEET.full, height + SHEET.step));
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          settle(height - SHEET.step);
        }
      }}
    />
  );
}
