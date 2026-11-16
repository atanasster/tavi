import type { PluginUiContext, PluginUiNavigation, PluginUiPlacement, PluginUiShortcut } from "@tavi/contracts";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useModalFocus } from "../../hooks/use-modal-focus.js";
import { IconButton } from "../../ui/IconButton.js";
import { PluginFrame, type PluginFrameClient } from "./PluginFrame.js";
import { contributionKey, type ResolvedContribution } from "./slots.js";
import { TakeOverButton } from "./TakeOverButton.js";

/**
 * A contributed chat panel tab (slot `chat.panel.tab`): the plugin's frame,
 * under a head the host draws. On the browser view that head offers Take
 * control (a plugin can never start a takeover) and Expand, which shows the
 * same frame large, over the page — moved by style alone, so its stream
 * carries on without reloading. The canvas owns `expanded`: Escape, another
 * chat or another tab put it back.
 */
export function PluginPanelTab({
  item,
  client,
  context,
  visible,
  expanded,
  onExpanded,
  onTakeOver,
  attention,
  onNavigate,
  onShortcut,
  onBadge,
  modState,
}: {
  readonly item: ResolvedContribution & { readonly placement: PluginUiPlacement };
  readonly client: PluginFrameClient;
  readonly context: PluginUiContext;
  readonly visible: boolean;
  readonly expanded: boolean;
  readonly onExpanded: (expanded: boolean) => void;
  readonly onTakeOver?: (() => void) | undefined;
  /** The agent asked for a person: Take control is the primary action. */
  readonly attention: boolean;
  readonly onNavigate: (target: PluginUiNavigation) => void;
  readonly onShortcut: (key: PluginUiShortcut) => void;
  readonly onBadge: (badge: { readonly count?: number | undefined; readonly dot?: boolean | undefined }) => void;
  /** What the plugin's own code published for the chat in view. */
  readonly modState?: Readonly<Record<string, unknown>> | undefined;
}) {
  const browser = item.contribution.role === "browser-view";
  const large = expanded && browser;
  const view = useRef<HTMLDivElement>(null);
  // A modal view holds focus, moved in as it opens; the page behind it is inert meanwhile.
  useModalFocus(large, view);
  const stops = (): HTMLElement[] => [...(view.current?.querySelectorAll<HTMLElement>("button:not([disabled]), iframe") ?? [])];
  /**
   * Tab and Shift+Tab cycle inside the large view: what is behind the backdrop is out of reach.
   * A key pressed inside the plugin's frame never reaches this handler, so the
   * guards either side of the view catch focus leaving the frame and send it round.
   */
  const keepFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!large || event.key !== "Tab" || view.current === null) return;
    const all = stops();
    const first = all[0];
    const last = all.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === view.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === view.current) {
      // The view itself (as it opened): forward goes to its first stop, not past its guard.
      event.preventDefault();
      first.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  useEffect(() => {
    if (!large) return;
    // Ahead of everything else (a tooltip takes Escape for itself), and handled,
    // so the page's own Escape cannot stop the turn behind the view.
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      // A modal over it (the takeover) owns Escape while it is up.
      if (
        [...document.querySelectorAll('[aria-modal="true"]')].some(
          (modal) => modal !== view.current && view.current?.contains(modal) !== true,
        )
      )
        return;
      event.preventDefault();
      onExpanded(false);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [large, onExpanded]);
  return (
    <>
      {large ? (
        <div className="chat-panel-plugin-backdrop" aria-hidden="true" data-modal-backdrop="" onClick={() => onExpanded(false)} />
      ) : null}
      <div
        ref={view}
        className={large ? "chat-panel-plugin-tab expanded" : "chat-panel-plugin-tab"}
        onKeyDown={keepFocus}
        {...(large ? { role: "dialog", "aria-modal": true, "aria-label": item.contribution.title, tabIndex: -1 } : {})}
      >
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a focus-trap sentinel; focusing it moves focus to the dialog's last stop */}
        {large ? <span className="focus-guard" tabIndex={0} onFocus={() => stops().at(-1)?.focus()} /> : null}
        {!browser ? null : (
          <div className="chat-panel-top-head">
            {/* The panel's own heading names the tab; the large view names itself. */}
            <span className="chat-panel-top-title">{onTakeOver !== undefined || large ? item.contribution.title : null}</span>
            <span className="chat-panel-plugin-actions">
              {onTakeOver === undefined ? null : <TakeOverButton attention={attention} onTakeOver={onTakeOver} />}
              <IconButton
                icon={large ? "minimize" : "maximize"}
                size="sm"
                label={large ? "Shrink the browser view" : "Expand the browser view"}
                tooltip={large ? "Shrink (Esc)" : "Expand"}
                aria-pressed={large}
                onClick={() => onExpanded(!large)}
              />
            </span>
          </div>
        )}
        <PluginFrame
          key={`${contributionKey(item)}@${item.contentHash}`}
          className="chat-panel-plugin-frame"
          resolved={item}
          slot="chat.panel.tab"
          placement={item.placement}
          context={context}
          client={client}
          visible={visible}
          onNavigate={onNavigate}
          onShortcut={onShortcut}
          onBadge={onBadge}
          modState={modState}
        />
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a focus-trap sentinel; focusing it moves focus to the dialog's first stop */}
        {large ? <span className="focus-guard" tabIndex={0} onFocus={() => stops()[0]?.focus()} /> : null}
      </div>
    </>
  );
}
