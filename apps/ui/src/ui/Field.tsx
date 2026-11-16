import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import { Failure } from "./Parts.js";

/** What a field hands its control: the id its label names, what describes it, and whether it is wrong. */
export interface FieldControl {
  readonly id: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: true;
}

type ControlProps = { readonly id?: string; readonly "aria-describedby"?: string | undefined };

/** A field's error, linked to its input by id (`aria-describedby`). */
function FieldError({ id, message }: { readonly id: string; readonly message: string | undefined }) {
  return message === undefined ? null : (
    <Failure alert={false} id={id}>
      {message}
    </Failure>
  );
}

/**
 * A label and the one control it names, with the line that explains it
 * (`hint`) and what is wrong with it (`error`) after: the field owns the
 * wiring — the control's `id` (`useId` unless one is given), its
 * `aria-describedby` (the hint's and the error's ids, after any it carries)
 * and `aria-invalid` while there is an error. The control is an element,
 * cloned with those, or a function given them (a control whose props are
 * named otherwise). `inline` puts a space between the label, the control and
 * the hint, as a field written inside a line of text has. The hint is a
 * paragraph unless `hintAs` says otherwise; nothing is wrapped around the parts.
 */
export function Field({
  label,
  id: given,
  labelClassName,
  hint,
  hintAs: Hint = "p",
  hintClassName,
  error,
  inline = false,
  children,
}: {
  readonly label: ReactNode;
  readonly id?: string;
  readonly labelClassName?: string;
  readonly hint?: ReactNode;
  readonly hintAs?: "p" | "span";
  readonly hintClassName?: string;
  readonly error?: string | undefined;
  readonly inline?: boolean;
  readonly children: ReactElement<ControlProps> | ((control: FieldControl) => ReactNode);
}) {
  const generated = useId();
  const id = given ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const own = typeof children === "function" ? undefined : children.props["aria-describedby"];
  const describedBy = [own, hint === undefined ? undefined : hintId, error === undefined ? undefined : errorId].filter(Boolean).join(" ");
  const control: FieldControl = {
    id,
    ...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
    ...(error === undefined ? {} : { "aria-invalid": true as const }),
  };
  return (
    <>
      <label htmlFor={id} className={labelClassName}>
        {label}
      </label>
      {inline ? " " : null}
      {typeof children === "function" ? children(control) : cloneElement(children, control)}
      {inline && hint !== undefined ? " " : null}
      {hint === undefined ? null : (
        <Hint id={hintId} className={hintClassName}>
          {hint}
        </Hint>
      )}
      <FieldError id={errorId} message={error} />
    </>
  );
}
