import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Icon } from "./Icon.js";
import { Card } from "./Card.js";
import { useAnnounce } from "../hooks/use-announce.js";
import type { ActionTone } from "../hooks/use-action.js";
import { useT } from "../lib/i18n.js";
import { statusLabel } from "../lib/format.js";
import { Button } from "./Button.js";

/**
 * Pieces every area of the canvas shares, in the Models page's vocabulary: a
 * section card with a title and its own actions, a label/value summary, a
 * status badge coloured by what the status means, readable times, the link
 * back from a drilled-in page, and a list's "Load older".
 */

type Tone = "ok" | "info" | "warning" | "bad" | "muted";

/** What a routine, run, evaluation or delivery status means for the reader. */
const TONES: Readonly<Record<string, Tone>> = {
  ok: "ok",
  active: "ok",
  succeeded: "ok",
  passed: "ok",
  delivered: "ok",
  completed: "ok",
  running: "info",
  queued: "info",
  evaluating: "info",
  pending: "info",
  waiting: "info",
  draft: "info",
  resumed: "info",
  degraded: "warning",
  interrupted: "warning",
  "setup-needed": "warning",
  "paused-failures": "warning",
  "credential-blocked": "warning",
  deferred: "warning",
  suppressed: "muted",
  skipped: "muted",
  cancelled: "muted",
  stopped: "muted",
  paused: "muted",
  archived: "muted",
  failed: "bad",
  expired: "bad",
};

export function StatusBadge({ status }: { readonly status: string }) {
  return <span className={`badge badge-${TONES[status] ?? "muted"}`}>{statusLabel(status)}</span>;
}

export function Section({
  title,
  anchor,
  actions,
  className = "",
  children,
}: {
  readonly title: string;
  /** The heading's id is `section-<anchor>`, the same in every language, for a link or a scroll to it. */
  readonly anchor?: string;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const own = useId();
  // A title in another script slugs to nothing, so it falls back to an id of its own.
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const id = `section-${anchor ?? (/[a-z0-9]/.test(slug) ? slug : own)}`;
  return (
    <Card title={title} titleId={id} actions={actions} className={className}>
      {children}
    </Card>
  );
}

/** Label/value pairs, two columns wide on a desktop and one on a phone. */
export function Summary({ items }: { readonly items: readonly (readonly [label: string, value: ReactNode] | false)[] }) {
  return (
    <dl className="summary-grid">
      {items
        .filter((item): item is readonly [string, ReactNode] => item !== false)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** The link back from a drilled-in page. */
export function BackLink({ label, onBack }: { readonly label: string; readonly onBack: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="back-link" onClick={onBack}>
      ← {label}
    </Button>
  );
}

/** The chat panel's way to the same thing across every chat, in the Command Center; nothing without one. */
export function CenterLink({ what, onCenter }: { readonly what: string; readonly onCenter: (() => void) | undefined }) {
  const t = useT();
  return onCenter === undefined ? null : (
    <Button variant="ghost" size="sm" className="chat-panel-center" onClick={onCenter}>
      {t("ui.parts.centerLink", { what })}
    </Button>
  );
}

/**
 * A paged list's next page, asked for at the foot of the list (`children`
 * stand before the button). `className` is the line around it — `null`: the
 * button alone — and `busyLabel` what the button says while the page is read.
 */
export function LoadMore({
  busy,
  onLoad,
  label,
  busyLabel,
  className = "center-more",
  buttonClassName = "button-sm",
  children,
}: {
  readonly busy: boolean;
  readonly onLoad: () => void;
  readonly label?: string;
  readonly busyLabel?: string;
  readonly className?: string | null;
  readonly buttonClassName?: string;
  readonly children?: ReactNode;
}) {
  const t = useT();
  const button = (
    <Button className={buttonClassName} disabled={busy} onClick={onLoad}>
      {busy ? (busyLabel ?? t("ui.parts.loading")) : (label ?? t("ui.parts.loadOlder"))}
    </Button>
  );
  return className === null ? (
    button
  ) : (
    <p className={className}>
      {children}
      {button}
    </p>
  );
}

/**
 * A page's head: its h1 (`id` for the section's `aria-labelledby`), the line
 * under it when there is one — the two wrapped together then — and its actions.
 */
export function PageHead({
  className,
  title,
  id,
  description,
  children,
}: {
  readonly className: "center-head" | "settings-head";
  readonly title: ReactNode;
  readonly id?: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
}) {
  const heading = <h1 id={id}>{title}</h1>;
  return (
    <header className={className}>
      {description === undefined ? (
        heading
      ) : (
        <div>
          {heading}
          <p className="settings-description">{description}</p>
        </div>
      )}
      {children}
    </header>
  );
}

/**
 * A drilled-in page's head (a routine, one of its runs): the link back, the
 * title — focused on arrival through `headingRef` — the line under it once
 * there is one, and the page's actions.
 */
export function DetailHead({
  back,
  onBack,
  headingRef,
  title,
  description,
  children,
}: {
  readonly back: string;
  readonly onBack: () => void;
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <>
      <BackLink label={back} onBack={onBack} />
      <header className="settings-head">
        <div>
          <h2 className="page-title" ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          {description === undefined ? null : <p className="settings-description">{description}</p>}
        </div>
        {children}
      </header>
    </>
  );
}

/**
 * What an action said, success or refusal, while there is something to say.
 * `className` is the line's ("": none). It is said through the page's one
 * live region (`useAnnounce`) as it changes; with `announce` off it is only shown.
 */
export function StatusNote({
  note,
  className = "notice",
  announce = true,
}: {
  readonly note: string | undefined;
  readonly className?: string;
  readonly announce?: boolean;
}) {
  useAnnounce(announce ? note : undefined);
  return note === undefined ? null : <p className={className === "" ? undefined : className}>{note}</p>;
}

/**
 * What an action said (`useAction`'s note and tone): a refusal as a `Failure`,
 * anything else as a `StatusNote`, either with its `className` and `announce`.
 */
export function ActionNote({
  note,
  tone,
  className,
  announce,
}: {
  readonly note: string | undefined;
  readonly tone: ActionTone;
  readonly className?: string;
  readonly announce?: boolean;
}) {
  return tone === "failure" ? (
    <Failure message={note} alert={announce !== false} {...(className === undefined ? {} : { className })} />
  ) : (
    <StatusNote note={note} {...(className === undefined ? {} : { className })} {...(announce === undefined ? {} : { announce })} />
  );
}

/** How long a page's new note stays in view while the page scrolls, before it settles back under the page's head. */
export const PAGE_NOTE_HELD_MS = 6000;

/**
 * What a page's action said, for the whole page (`ActionNote`'s note and tone): a boxed line under the page's head
 * (`.page-note`). For a few seconds after it changes it is held in view (`.page-note-held`), so a save or a clear far
 * down a long page is answered where the reader is; then it settles back, rather than covering the page as it scrolls.
 */
export function PageNote({ note, tone }: { readonly note: string | undefined; readonly tone: ActionTone }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (note === undefined) return;
    setHeld(true);
    const timer = window.setTimeout(() => setHeld(false), PAGE_NOTE_HELD_MS);
    return () => window.clearTimeout(timer);
  }, [note, tone]);
  const className = held ? "page-note page-note-held" : "page-note";
  return tone === "failure" ? (
    <Failure message={note} className={className} />
  ) : (
    <StatusNote note={note} className={`notice ${className}`} />
  );
}

/** A line of text in the canvas's tone classes: a paragraph unless `as` says otherwise, with the caller's own class beside. */
type LineProps = Omit<HTMLAttributes<HTMLElement>, "className" | "children"> & {
  readonly as?: "p" | "div" | "span";
  readonly className?: string | undefined;
  readonly children?: ReactNode;
};

/** A neutral line about what it sits by: a state, a limit, a next step (`.notice`). */
export function Notice({ as: Tag = "p", className, children, ...props }: LineProps) {
  return (
    <Tag {...props} className={className === undefined ? "notice" : `notice ${className}`}>
      {children}
    </Tag>
  );
}

/**
 * A refusal, said once there is one (`message`, or the `children` it is
 * written as): as an alert, or with `alert` off as a plain line; a `role`
 * given (`status`) is kept.
 */
export function Failure({
  message,
  alert = true,
  as: Tag = "p",
  className,
  role,
  children,
  ...props
}: LineProps & { readonly message?: string | undefined; readonly alert?: boolean }) {
  const content = children ?? message;
  return content === undefined ? null : (
    <Tag {...props} className={className === undefined ? "failure" : `failure ${className}`} role={role ?? (alert ? "alert" : undefined)}>
      {content}
    </Tag>
  );
}

/** A page's failed load, with a way to ask again. */
export function LoadError({ error, reload }: { readonly error: string; readonly reload: () => void }) {
  const t = useT();
  return (
    <Failure>
      {error} <Button onClick={reload}>{t("ui.parts.retry")}</Button>
    </Failure>
  );
}

/**
 * A read not answered yet: its `label` ("Loading…") as a line of `className`
 * ("": none; with `status`, said through the page's live region), or its failure once it has one —
 * with Retry when there is a `reload`.
 */
export function Pending({
  error,
  reload,
  label: labelGiven,
  className = "empty",
  status = false,
}: {
  readonly error?: string | undefined;
  readonly reload?: (() => void) | undefined;
  readonly label?: string;
  readonly className?: string;
  readonly status?: boolean;
}) {
  const t = useT();
  const label = labelGiven ?? t("ui.parts.loading");
  useAnnounce(status && error === undefined ? label : undefined);
  if (error !== undefined)
    return reload === undefined ? <Failure message={error} alert={false} /> : <LoadError error={error} reload={reload} />;
  return <p className={className === "" ? undefined : className}>{label}</p>;
}

/**
 * A page's load as its lists show it: the failure with Retry, then
 * `children` (what an action said), then `label` while `loading` — each on
 * its own, so a failed reload and the data it kept show together.
 */
export function LoadState({
  error,
  reload,
  loading,
  label,
  className = "notice",
  status = false,
  children,
}: {
  readonly error: string | undefined;
  readonly reload: () => void;
  readonly loading: boolean;
  readonly label?: string;
  readonly className?: string;
  readonly status?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <>
      {error === undefined ? null : <LoadError error={error} reload={reload} />}
      {children}
      {loading ? <Pending {...(label === undefined ? {} : { label })} className={className} status={status} /> : null}
    </>
  );
}

/**
 * A row's expandable list (follow-ups, workers, visits): its toggle, and while
 * open the list (`children`) under its loading line and its failure.
 */
export function Disclosure({
  className,
  id,
  label,
  open,
  onToggle,
  loading,
  loadingLabel,
  error,
  reload,
  children,
}: {
  readonly className: string;
  /** The list's id, which the toggle controls. */
  readonly id: string;
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly loading: boolean;
  readonly loadingLabel: string;
  readonly error: string | undefined;
  readonly reload: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className={className}>
      <Button variant="bare" className="center-followups-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        {label} <Icon name={open ? "chevron-up" : "chevron-down"} size="sm" />
      </Button>
      {open ? (
        <div id={id}>
          {loading ? <p className="muted">{loadingLabel}</p> : null}
          {error === undefined ? null : <LoadError error={error} reload={reload} />}
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A destructive step's inline second question: what happens, the step, and a
 * way back. With `focusCancel` the way back takes focus as it opens, so a
 * repeated Enter cannot do what it asks about. `inline` sets it among a row's
 * other actions instead — a question and two small buttons, the way back
 * never disabled, so the row can always be left as it was.
 */
export function InlineConfirm({
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy,
  small = true,
  className,
  label,
  focusCancel = false,
  onConfirmKeyDown,
  inline = false,
}: {
  readonly message: ReactNode;
  readonly confirmLabel: ReactNode;
  readonly cancelLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly busy?: boolean;
  /** The strip's buttons in their small size (the default). */
  readonly small?: boolean;
  readonly className?: string;
  /** The strip as a named group. */
  readonly label?: string;
  readonly focusCancel?: boolean;
  readonly onConfirmKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly inline?: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusCancel) cancel.current?.focus();
  }, [focusCancel]);
  if (inline) {
    return (
      <>
        <span>{message}</span>
        <Button size="sm" disabled={busy} onKeyDown={onConfirmKeyDown} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" size="sm" ref={cancel} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </>
    );
  }
  return (
    <div
      className={className === undefined ? "confirmation" : `confirmation ${className}`}
      {...(label === undefined ? {} : { role: "group", "aria-label": label })}
    >
      <p>{message}</p>
      <div className="actions">
        <Button variant="destructive" size={small ? "sm" : undefined} disabled={busy} onKeyDown={onConfirmKeyDown} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" size={small ? "sm" : undefined} ref={cancel} disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}

/** A section's search box. */
export function SearchField({
  value,
  placeholder,
  label,
  onChange,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="center-search">
      <Icon name="search" size="sm" />
      <input type="search" value={value} placeholder={placeholder} aria-label={label} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/** One person's items, or everyone's: shown once more than one person is named. */
export function PersonChips({
  people,
  person,
  onPick,
}: {
  readonly people: Readonly<Record<string, string>>;
  readonly person: string;
  readonly onPick: (person: string) => void;
}) {
  const t = useT();
  return (
    <div className="center-chips" role="group" aria-label={t("ui.parts.filterByPerson")}>
      <FilterChip pressed={person === "all"} onPick={() => onPick("all")}>
        {t("ui.parts.everyone")}
      </FilterChip>
      {Object.entries(people).map(([principalId, name]) => (
        <FilterChip key={principalId} pressed={person === principalId} onPick={() => onPick(principalId)}>
          {name}
        </FilterChip>
      ))}
    </div>
  );
}

/** A pressed-or-not filter button. */
export function FilterChip({
  pressed,
  onPick,
  children,
}: {
  readonly pressed: boolean;
  readonly onPick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button className="center-chip" aria-pressed={pressed} onClick={onPick}>
      {children}
    </Button>
  );
}

/**
 * A form's fields, disabled while `busy` (a save on its way). Disabling the
 * control that has focus (the Save just pressed) would drop focus to the
 * page's body, and a screen reader's place with it: focus waits instead on a
 * "Saving…" line just before the fields, and goes back to that control when
 * the save is done, if it is still there to take it.
 */
export function BusyFieldset({
  busy,
  className,
  label,
  children,
}: {
  readonly busy: boolean;
  readonly className?: string;
  readonly label?: string;
  readonly children: ReactNode;
}) {
  const t = useT();
  const fields = useRef<HTMLFieldSetElement>(null);
  const waiting = useRef<HTMLSpanElement>(null);
  const had = useRef<HTMLElement | null>(null);
  // Read while rendering, before the commit: Chromium takes focus off a control the moment its fieldset disables.
  if (busy && had.current === null) {
    const active = document.activeElement;
    if (active instanceof HTMLElement && fields.current?.contains(active) === true) had.current = active;
  }
  useLayoutEffect(() => {
    if (busy) {
      if (had.current !== null) waiting.current?.focus({ preventScroll: true });
      return;
    }
    const back = had.current;
    had.current = null;
    if (back !== null && back.isConnected && document.activeElement === waiting.current && !back.matches(":disabled"))
      back.focus({ preventScroll: true });
  }, [busy]);
  return (
    <>
      <span ref={waiting} className="visually-hidden" tabIndex={-1}>
        {busy ? (label ?? t("ui.parts.saving")) : ""}
      </span>
      <fieldset ref={fields} className={className} disabled={busy} aria-busy={busy || undefined}>
        {children}
      </fieldset>
    </>
  );
}
