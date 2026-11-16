import { useEffect, useId, useRef, type ReactNode } from "react";

import { IconButton } from "./IconButton.js";

/**
 * A modal dialog on the native `<dialog>` (Meggy's Radix modal, ported): shown
 * with `showModal`, so the page behind it is inert and Tab stays inside;
 * focus moves to its first field and returns to what opened it on close;
 * Escape and the header's close button close it — unless `busy`, while a save
 * is on its way. A click on the backdrop does not: a half-filled form is not
 * lost to a stray click beside it.
 *
 * The title stays put while a long form scrolls beneath it, and the form's
 * `.actions` row stays visible at the bottom of the scroll.
 */
export function Modal({
  title,
  busy = false,
  wide = false,
  describedBy,
  onClose,
  children,
}: {
  readonly title: string;
  /** The id of what the dialog says (a confirm's message), read with its title as it opens. */
  readonly describedBy?: string;
  readonly busy?: boolean;
  /** For a dialog that lists things (a model picker), not a short form. */
  readonly wide?: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // The latest `onClose` and `busy`, without re-running the effect for each render's new arrow.
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    element
      .querySelector<HTMLElement>(
        ".modal-content input:not([readonly]), .modal-content select, .modal-content textarea, .modal-content button",
      )
      ?.focus();
    const cancel = (event: Event): void => {
      // Escape: closed here, by the parent, not by the browser.
      event.preventDefault();
      if (!latest.current.busy) latest.current.onClose();
    };
    element.addEventListener("cancel", cancel);
    return () => {
      element.removeEventListener("cancel", cancel);
      if (typeof element.close === "function" && element.open) element.close();
      opener?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className={wide ? "modal surface-popover modal-wide" : "modal surface-popover"}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
    >
      <div className="modal-body">
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton icon="close" label="Close dialog" disabled={busy} onClick={() => latest.current.onClose()} />
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </dialog>
  );
}
