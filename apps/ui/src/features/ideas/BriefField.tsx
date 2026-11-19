import { IDEA_BRIEF_MAX } from "@tavi/contracts";
import { Field } from "../../ui/Field.js";

/** The brief ideas are written from, as the tab's *Tune* and Settings → Ideas both edit it. */
export function BriefField({
  id,
  value,
  disabled = false,
  onChange,
}: {
  readonly id: string;
  readonly value: string | undefined;
  readonly disabled?: boolean;
  readonly onChange: (text: string) => void;
}) {
  return (
    <Field
      id={id}
      label="What should Ideas favour or avoid?"
      hint="Ideas read it word for word, at their next look."
      hintClassName="meta-sm"
    >
      <textarea
        rows={3}
        maxLength={IDEA_BRIEF_MAX}
        value={value ?? ""}
        disabled={disabled || value === undefined}
        placeholder="More about the garden, nothing about money."
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
