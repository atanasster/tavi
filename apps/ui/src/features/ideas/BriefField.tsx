import { IDEA_BRIEF_MAX } from "@tavi/contracts";
import { useT } from "../../lib/i18n.js";
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
  const t = useT();
  return (
    <Field id={id} label={t("ideas.brief.label")} hint={t("ideas.brief.hint")} hintClassName="meta-sm">
      <textarea
        rows={3}
        maxLength={IDEA_BRIEF_MAX}
        value={value ?? ""}
        disabled={disabled || value === undefined}
        placeholder={t("ideas.brief.placeholder")}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
