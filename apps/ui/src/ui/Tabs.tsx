import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "./Button.js";

/**
 * A nav of the shell's views: one button each, the current one marked the
 * same way in every nav (`active`, and `aria-current="page"`). Where the nav
 * scrolls inside itself (a narrow window, a long language), the current one
 * is brought into view.
 */
export function Tabs<T extends string>({
  label,
  className,
  items,
  current,
  onPick,
}: {
  /** The nav's name for a screen reader ("pages", "settings"). */
  readonly label: string;
  /** The nav's own class, beside `segmented`. */
  readonly className: string;
  readonly items: readonly { readonly value: T; readonly label: string; readonly badge?: ReactNode }[];
  readonly current: T;
  readonly onPick: (value: T) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);
  return (
    <nav ref={nav} className={`${className} segmented`} aria-label={label}>
      {items.map((item) => (
        <Button
          key={item.value}
          className={item.value === current ? "view segment active" : "view segment"}
          aria-current={item.value === current ? "page" : undefined}
          onClick={() => onPick(item.value)}
        >
          {item.label}
          {item.badge}
        </Button>
      ))}
    </nav>
  );
}

/**
 * A tab list (ARIA tabs) over one panel: one tab is in the tab order, the
 * arrow keys (and Home and End) move between them and pick the one they land
 * on. The panel is the caller's, labelled by `tabId(current)`.
 */
export function TabList<T extends string>({
  label,
  className,
  tabClassName,
  activeClassName,
  items,
  current,
  onPick,
  tabId,
  panelId,
  tabRef,
}: {
  /** The list's name for a screen reader ("this chat's sections"). */
  readonly label: string;
  readonly className: string;
  /** Every tab's class, and the one the current tab adds. */
  readonly tabClassName: string;
  readonly activeClassName?: string;
  readonly items: readonly { readonly value: T; readonly content: ReactNode; readonly ariaLabel?: string }[];
  readonly current: T;
  readonly onPick: (value: T) => void;
  readonly tabId: (value: T) => string;
  readonly panelId: string;
  /** Each tab's button, for a caller that moves focus to one. */
  readonly tabRef?: (value: T, node: HTMLButtonElement | null) => void;
}) {
  const buttons = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.value === current);
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    const value = next === undefined ? undefined : items[next]?.value;
    if (value === undefined) return;
    event.preventDefault();
    onPick(value);
    buttons.current[value]?.focus();
  };
  return (
    <div className={className} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const selected = item.value === current;
        return (
          <button
            key={item.value}
            ref={(node) => {
              buttons.current[item.value] = node;
              tabRef?.(item.value, node);
            }}
            type="button"
            role="tab"
            id={tabId(item.value)}
            className={selected && activeClassName !== undefined ? `${tabClassName} ${activeClassName}` : tabClassName}
            aria-selected={selected}
            aria-controls={panelId}
            aria-label={item.ariaLabel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onPick(item.value)}
          >
            {item.content}
          </button>
        );
      })}
    </div>
  );
}
