import type { ReactNode } from "react";
import { useT } from "../../lib/i18n.js";
import { Button } from "../../ui/Button.js";

// The canvas's general pieces, under the names the settings pages know them by.
export { LoadError, Failure as FormFailure } from "../../ui/Parts.js";

/**
 * A form's Cancel and submit buttons, the submit saying what it is doing.
 * A button given no `disabled` carries none (a disabled fieldset around it
 * may still hold it). `small` is an inline form's: small buttons, the submit
 * first. `children` lead the row (a dialog's extra step).
 */
export function FormActions({
  saving,
  label,
  busyLabel,
  onCancel,
  disabled,
  cancelDisabled,
  cancelLabel,
  small = false,
  children,
}: {
  readonly saving: boolean;
  readonly label: string;
  readonly busyLabel?: string;
  readonly onCancel: () => void;
  readonly disabled?: boolean;
  readonly cancelDisabled?: boolean;
  readonly cancelLabel?: string;
  readonly small?: boolean;
  readonly children?: ReactNode;
}) {
  const t = useT();
  const cancel = (
    <Button variant="ghost" size={small ? "sm" : undefined} disabled={cancelDisabled} onClick={onCancel}>
      {cancelLabel ?? t("ui.confirm.cancel")}
    </Button>
  );
  const submit = (
    <Button variant="primary" size={small ? "sm" : undefined} type="submit" disabled={disabled}>
      {saving ? (busyLabel ?? t("ui.parts.saving")) : label}
    </Button>
  );
  return (
    <div className="actions">
      {children}
      {small ? submit : cancel}
      {small ? cancel : submit}
    </div>
  );
}
