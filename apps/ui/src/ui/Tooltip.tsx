import { cloneElement, useEffect, useId, useRef, useState, type HTMLAttributes, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { useAnchoredPosition } from "../hooks/use-anchored-position.js";
import { useDismiss } from "../hooks/use-dismiss.js";

/** Shared hover/focus tooltip, portaled so scroll containers cannot clip it.
 *  `placement` is the preferred side; the other is used when it does not fit.
 *  `suppressed` keeps it shut (its control has opened a popover of its own)
 *  without changing the tree, so the control keeps its focus.
 *
 *  It describes its control only when its text adds to the control's name:
 *  a tooltip that repeats the `aria-label` would be read twice. */
export function Tooltip({
  text,
  children,
  placement = "top",
  suppressed = false,
}: {
  readonly text: string;
  readonly children: ReactElement<HTMLAttributes<HTMLElement>>;
  readonly placement?: "top" | "bottom";
  readonly suppressed?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // How it opened: one that came with keyboard focus does not take Escape for itself.
  const via = useRef<"hover" | "focus">("hover");
  // A click focuses too, and a pointer that has moved on must not leave the tip over what it went to.
  const pressed = useRef(false);
  const [shown, setOpen] = useState(false);
  const open = shown && !suppressed;
  const cancel = () => clearTimeout(timer.current);
  const show = (how: "hover" | "focus") => () => {
    cancel();
    via.current = how;
    setOpen(true);
  };
  const leave = () => {
    cancel();
    timer.current = setTimeout(() => {
      if (via.current === "hover" || !trigger.current?.contains(document.activeElement)) setOpen(false);
    }, 120);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const { position } = useAnchoredPosition(open, trigger, tip, { placement, clampBelow: true }, [text]);
  useDismiss(
    open,
    () => {
      clearTimeout(timer.current);
      setOpen(false);
    },
    { capture: true, scroll: true, resize: true, claimEscape: () => via.current === "hover" && !inModal() },
  );
  /** Within a dialog, Escape is the dialog's as well: claimed here, a native one would never hear its cancel. */
  const inModal = (): boolean =>
    document.querySelector("dialog[open]") !== null || trigger.current?.closest('[aria-modal="true"], dialog') != null;
  const describes = open && text !== children.props["aria-label"];
  return (
    <>
      <span
        className="tooltip-trigger"
        ref={trigger}
        onMouseEnter={show("hover")}
        onMouseLeave={leave}
        onPointerDown={() => {
          pressed.current = true;
        }}
        onFocus={() => {
          if (!pressed.current) show("focus")();
          pressed.current = false;
        }}
        onBlur={() => {
          cancel();
          setOpen(false);
        }}
      >
        {cloneElement(children, {
          "aria-describedby": [children.props["aria-describedby"], describes ? id : undefined].filter(Boolean).join(" ") || undefined,
        })}
      </span>
      {open
        ? createPortal(
            <span id={id} ref={tip} role="tooltip" className="tooltip" style={position} onMouseEnter={cancel} onMouseLeave={leave}>
              {text}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
