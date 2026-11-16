import type { PluginUiContext, PluginUiNavigation, PluginUiShortcut } from "@tavi/contracts";
import { BrowserListAnswerSchema } from "@tavi/contracts";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { usePhone } from "../../hooks/page.js";
import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { IconButton } from "../../ui/IconButton.js";
import type { SheetSnap } from "../chat-panel/ChatPanel.js";
import { ask, type SettingsClient } from "../../lib/ipc.js";
import { readStoredJson, writeStoredJson } from "../../lib/storage.js";
import { PluginFrame, type PluginFrameClient } from "./PluginFrame.js";
import { contributionKey, type ResolvedContribution } from "./slots.js";
import { TakeOverButton } from "./TakeOverButton.js";
import { TOP_SLOT_HEIGHT_STEP } from "../../lib/layout.js";

/**
 * The chat panel's `chat.panel.top` slot:
 * between the panel's header and its tab strip, where a UI plugin's view of
 * the chat — the live browser view by default — is shown.
 *
 * - **When.** A contribution placed `while-active` shows only while what it
 *   shows is active, by its declared role: a `browser-view` while a browser
 *   session of the chat's task tree is open and the chat's task is running,
 *   any other while the chat's task is running; then for `TOP_SLOT_LINGER_MS`
 *   more, so its last frame does not vanish as the turn ends. `always` shows
 *   it whatever the chat is doing.
 * - **Size.** Collapsible, and its height dragged (or set with the arrow keys
 *   on its handle) within the placement's bounds; the plugin may ask for a
 *   height too. The reader's choice is kept for the browser tab
 *   (`sessionStorage`).
 * - **Phone.** On the phone sheet it shows only at full height.
 * - Collapsed or on a half sheet, the frame is told it is hidden, and its
 *   watch ends after the grace (flow control); past its linger it is
 *   unmounted, which ends it at once.
 */

/** How long a `while-active` contribution stays after the chat stops being active. */
export const TOP_SLOT_LINGER_MS = 30_000;
const DEFAULT_HEIGHT = { min: 140, default: 220, max: 480 } as const;

/**
 * The newest browser session of the chat's task tree that is open now, by its
 * live-view id, while the chat runs; read again on each `browser` change.
 */
export function useOpenBrowserSession(
  client: SettingsClient,
  workspaceId: string,
  taskId: string | undefined,
  running: boolean,
  revision: number,
): string | undefined {
  const [open, setOpen] = useState<string>();
  useEffect(() => {
    if (taskId === undefined || !running) {
      setOpen(undefined);
      return;
    }
    let current = true;
    void ask<unknown>(client, "browser", { action: "list", workspaceId, taskId, tree: true, open: true, limit: 1 }).then((outcome) => {
      if (!current || !outcome.ok) return;
      const parsed = BrowserListAnswerSchema.safeParse(outcome.value);
      setOpen(parsed.success ? parsed.data.items[0]?.sessionId : undefined);
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId, taskId, running, revision]);
  return running ? open : undefined;
}

/** `active`, kept true for `ms` after it falls: a contribution's last frame stays a moment. */
function useLinger(active: boolean, ms: number): boolean {
  const [lingering, setLingering] = useState(active);
  useEffect(() => {
    if (active) {
      setLingering(true);
      return;
    }
    const timer = setTimeout(() => setLingering(false), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active || lingering;
}

interface TopState {
  readonly collapsed: boolean;
  readonly height: number | undefined;
}

const storageKey = (key: string): string => `tavi.chatpanel.top.${key}`;

function loadTop(key: string): TopState {
  const parsed = readStoredJson(storageKey(key), "session") as Partial<TopState> | null | undefined;
  return { collapsed: parsed?.collapsed === true, height: typeof parsed?.height === "number" ? parsed.height : undefined };
}

function saveTop(key: string, state: TopState): void {
  writeStoredJson(storageKey(key), state, "session");
}

export interface ChatPanelTopProps {
  readonly items: readonly (ResolvedContribution & { readonly placement: ResolvedContribution["placements"][number] })[];
  readonly client: PluginFrameClient;
  readonly context: PluginUiContext;
  /** What each plugin's own code published for the chat, by plugin id. */
  readonly modStates?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** What is active in the chat: its task running, and a browser session of its tree open while it does. */
  readonly active: { readonly running: boolean; readonly browser: boolean };
  readonly sheet: SheetSnap;
  /** Where the plugin of `pluginId` asked to go. */
  readonly onNavigate?: (pluginId: string, target: PluginUiNavigation) => void;
  readonly onShortcut?: (key: PluginUiShortcut) => void;
  /** Opens the takeover surface on the chat's session: the host's own control, never the plugin's. */
  readonly onTakeOver?: () => void;
  /** The agent asked for a person: the slot shows, expanded. */
  readonly attention?: boolean;
}

export function ChatPanelTop({ items, active, ...rest }: ChatPanelTopProps) {
  const attention = rest.attention === true;
  const browserLingering = useLinger(active.browser || attention, TOP_SLOT_LINGER_MS);
  const runningLingering = useLinger(active.running || attention, TOP_SLOT_LINGER_MS);
  const phone = usePhone();
  // Active by what the contribution shows: a browser view by the chat's browser, anything else by its run.
  const shown = items.filter(
    (item) => item.placement.show === "always" || (item.contribution.role === "browser-view" ? browserLingering : runningLingering),
  );
  if (shown.length === 0) return null;
  return (
    <div className="chat-panel-top">
      {shown.map((item) => (
        <TopItem key={`${contributionKey(item)}@${item.contentHash}`} item={item} phone={phone} {...rest} />
      ))}
    </div>
  );
}

function TopItem({
  item,
  client,
  context,
  modStates,
  sheet,
  phone,
  onNavigate,
  onShortcut,
  onTakeOver,
  attention,
}: Omit<ChatPanelTopProps, "items" | "active"> & { readonly item: ChatPanelTopProps["items"][number]; readonly phone: boolean }) {
  const key = contributionKey(item);
  const bounds = item.placement.height ?? DEFAULT_HEIGHT;
  // Asked for a person: shown, whatever the reader collapsed earlier — as it opens, and each time it asks again.
  const shownFor = (now: TopState): TopState => (attention === true && now.collapsed ? { ...now, collapsed: false } : now);
  const [state, setState] = useState<TopState>(() => shownFor(loadTop(key)));
  useResetOnChange([attention], () => setState(shownFor));
  const height = Math.min(bounds.max, Math.max(bounds.min, state.height ?? bounds.default));
  const update = (next: TopState): void => {
    setState(next);
    saveTop(key, next);
  };
  const setHeight = (px: number): void => update({ ...state, height: Math.min(bounds.max, Math.max(bounds.min, Math.round(px))) });
  const drag = useRef<{ readonly start: number; readonly from: number } | undefined>(undefined);
  const halfSheet = phone && sheet === "half";
  const visible = !state.collapsed && !halfSheet;
  const onHandleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowUp") setHeight(height - TOP_SLOT_HEIGHT_STEP);
    else if (event.key === "ArrowDown") setHeight(height + TOP_SLOT_HEIGHT_STEP);
    else return;
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === undefined) return;
    setHeight(drag.current.from + event.clientY - drag.current.start);
  };
  return (
    <section
      className={`chat-panel-top-item${state.collapsed ? " collapsed" : ""}${halfSheet ? " sheet-hidden" : ""}${attention === true ? " needs-you" : ""}`}
      aria-label={item.contribution.title}
    >
      <div className="chat-panel-top-head">
        <span className="chat-panel-top-title">{item.contribution.title}</span>
        {/* Drawn by the host, outside the plugin's frame: a plugin can never start a takeover. */}
        {onTakeOver === undefined || item.contribution.role !== "browser-view" ? null : (
          <TakeOverButton attention={attention === true} onTakeOver={onTakeOver} />
        )}
        <IconButton
          icon={state.collapsed ? "chevron-down" : "chevron-up"}
          size="sm"
          label={state.collapsed ? `Show ${item.contribution.title}` : `Hide ${item.contribution.title}`}
          aria-expanded={!state.collapsed}
          onClick={() => update({ ...state, collapsed: !state.collapsed })}
        />
      </div>
      <PluginFrame
        className="chat-panel-top-frame"
        style={{ height: `${height}px` }}
        hidden={!visible}
        resolved={item}
        slot="chat.panel.top"
        placement={item.placement}
        context={context}
        client={client}
        visible={visible}
        modState={modStates?.[item.pluginId]}
        onRequestHeight={setHeight}
        {...(onNavigate === undefined ? {} : { onNavigate: (target: PluginUiNavigation) => onNavigate(item.pluginId, target) })}
        {...(onShortcut === undefined ? {} : { onShortcut })}
      />
      {visible ? (
        <div
          className="chat-panel-top-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${item.contribution.title}`}
          aria-valuenow={height}
          aria-valuemin={bounds.min}
          aria-valuemax={bounds.max}
          tabIndex={0}
          onKeyDown={onHandleKey}
          onPointerDown={(event) => {
            drag.current = { start: event.clientY, from: height };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = undefined)}
          onPointerCancel={() => (drag.current = undefined)}
        />
      ) : null}
    </section>
  );
}
