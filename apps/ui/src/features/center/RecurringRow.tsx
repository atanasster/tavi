import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "../../ui/Button.js";
import { AppLink } from "../shell/AppLink.js";
import { Switch } from "./PlainSchedules.js";

/** What a row in Recurring is. */
export type RecurringKind = "reminder" | "routine" | "schedule" | "heartbeat";

const KIND_WORDS: Readonly<Record<RecurringKind, string>> = {
  reminder: "Reminder",
  routine: "Routine",
  schedule: "Schedule",
  heartbeat: "Heartbeat",
};

/** Focus the More button of the row `rowKey`, once it is drawn: where an action that took the row away, or opened a form, began. */
export function focusRowMenu(rowKey: string): void {
  requestAnimationFrame(() =>
    [...document.querySelectorAll<HTMLElement>("[data-row-key]")]
      .find((row) => row.dataset["rowKey"] === rowKey)
      ?.querySelector<HTMLElement>('[aria-haspopup="menu"]')
      ?.focus(),
  );
}

/** One entry of a row's More menu. */
export interface RowMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  /** It deletes or archives: drawn in the danger colour. */
  readonly danger?: boolean;
}

/**
 * One row of Recurring, the same for every kind: its kind and name (a link to
 * its page), its badge, when it runs and next runs, how it last went; then
 * Run now where the kind has one, the Pause/Resume switch, and More. Visible
 * labels stay short; the name is in each control's accessible name.
 */
export function RecurringRow({
  kind,
  rowKey,
  name,
  href,
  onOpen,
  badge,
  titleExtra,
  when,
  last,
  lastClassName,
  linkClassName,
  extra,
  runNow,
  toggle,
  menu,
  busy,
}: {
  readonly kind: RecurringKind;
  /** The row's key in the list (`kind:id`): Undo finds the row by it. */
  readonly rowKey: string;
  readonly name: string;
  readonly href: string;
  readonly onOpen: () => void;
  /** Its state or last outcome, beside the name. */
  readonly badge?: ReactNode;
  /** What else the title line says: the person it is for. */
  readonly titleExtra?: ReactNode;
  /** Its cadence and next run. */
  readonly when: ReactNode;
  /** How it last went. */
  readonly last: ReactNode;
  /** A class the last line adds to its own. */
  readonly lastClassName?: string;
  /** A class the name's link adds to its own. */
  readonly linkClassName?: string;
  /** Anything under the last line, such as the chat it was asked in. */
  readonly extra?: ReactNode;
  /** Run now: absent where the kind cannot be run by hand. */
  readonly runNow?: { readonly onRun: () => void; readonly disabled?: boolean; readonly title?: string | undefined } | undefined;
  readonly toggle: {
    readonly on: boolean;
    readonly label: string;
    readonly disabled: boolean;
    readonly warning?: string | undefined;
    /** Why it is disabled, when that is not obvious. */
    readonly hint?: string | undefined;
    readonly onToggle: () => void;
  };
  readonly menu: readonly RowMenuItem[];
  /** An action is on its way: nothing else starts. */
  readonly busy: boolean;
}) {
  return (
    <li className={`schedule-recurring schedule-recurring-${kind}`} data-row-key={rowKey}>
      <div className="schedule-recurring-main">
        <span className="schedule-recurring-title">
          <span className={`schedule-kind eyebrow schedule-kind-${kind}`}>{KIND_WORDS[kind]}</span>
          <AppLink
            className={linkClassName === undefined ? "item-title button-link" : `item-title ${linkClassName} button-link`}
            href={href}
            onFollow={onOpen}
          >
            {name}
          </AppLink>
          {badge}
          {titleExtra}
        </span>
        <span className="item-meta meta-sm">{when}</span>
        <span className={lastClassName === undefined ? "item-meta meta-sm" : `item-meta meta-sm ${lastClassName}`}>{last}</span>
        {extra}
      </div>
      <div className="schedule-recurring-controls">
        {runNow === undefined ? null : (
          <Button
            size="sm"
            aria-label={`Run now: ${name}`}
            title={runNow.title}
            disabled={busy || runNow.disabled === true}
            onClick={runNow.onRun}
          >
            Run now
          </Button>
        )}
        <Switch
          on={toggle.on}
          label={toggle.label}
          warning={toggle.warning}
          hint={toggle.hint}
          disabled={busy || toggle.disabled}
          onToggle={toggle.onToggle}
        />
        {menu.length === 0 ? null : <MoreMenu label={`More actions for ${name}`} items={menu} disabled={busy} />}
      </div>
    </li>
  );
}

/**
 * A small menu behind a More button: opened by a click, Enter, Space or the
 * down arrow, its first item focused; the arrows, Home and End move through
 * it; Escape closes it and returns focus to the button, as choosing an item
 * does (before the item acts, so a dialog it opens returns focus there too);
 * Tab or a press outside closes it.
 */
function MoreMenu({
  label,
  items,
  disabled = false,
}: {
  /** The menu's name, and its button's: "More actions for <name>". */
  readonly label: string;
  readonly items: readonly RowMenuItem[];
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const entries = (): HTMLButtonElement[] => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();
    const away = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !wrapper.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const all = entries();
    const at = document.activeElement instanceof HTMLButtonElement ? all.indexOf(document.activeElement) : -1;
    const go = (index: number): void => {
      event.preventDefault();
      all[(index + all.length) % all.length]?.focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(all.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") setOpen(false);
  };

  return (
    <span className="row-menu" ref={wrapper}>
      <Button
        ref={button}
        size="sm"
        variant="ghost"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        More
      </Button>
      {open ? (
        <div id={menuId} ref={list} role="menu" aria-label={label} className="row-menu-list surface-popover" onKeyDown={move}>
          {items.map((item) => (
            <Button
              key={item.label}
              variant="bare"
              role="menuitem"
              tabIndex={-1}
              className={item.danger === true ? "row-menu-item row-menu-danger" : "row-menu-item"}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
