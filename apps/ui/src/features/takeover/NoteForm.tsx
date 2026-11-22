import { BROWSER_LIVE_NOTE_MAX } from "@tavi/contracts";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n.js";
import { Button } from "../../ui/Button.js";
import { Field } from "../../ui/Field.js";

/** A short note to Tavi about the browser (why not, what went wrong), sent with `submit`; never a secret. */
export function NoteForm({
  id,
  className,
  label,
  note,
  onNote,
  submit,
  submitClassName,
  onSubmit,
  onCancel,
}: {
  readonly id: string;
  readonly className?: string;
  readonly label: ReactNode;
  readonly note: string;
  readonly onNote: (note: string) => void;
  readonly submit: string;
  readonly submitClassName?: string;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  const t = useT();
  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Field id={id} label={label}>
        <input maxLength={BROWSER_LIVE_NOTE_MAX} value={note} onChange={(event) => onNote(event.target.value)} autoFocus />
      </Field>
      <small className="muted">{t("takeover.note.noSecrets")}</small>
      <Button type="submit" className={submitClassName}>
        {submit}
      </Button>{" "}
      <Button onClick={onCancel}>{t("ui.confirm.cancel")}</Button>
    </form>
  );
}
