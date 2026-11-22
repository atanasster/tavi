import { useState } from "react";

import { useT } from "../../lib/i18n.js";
import { Field } from "../../ui/Field.js";
import { IconButton } from "../../ui/IconButton.js";

/**
 * The attributes of every field that takes a key or token. It is a text field
 * masked by CSS, not `type="password"`: browsers and password managers
 * (Chrome, iCloud Passwords) offer saved site logins on any password field
 * whatever its `autocomplete`, and a key is not a login. `autocomplete="off"`
 * and the managers' own opt-outs keep them from filling or saving one.
 */
export const SECRET_INPUT = {
  type: "text",
  className: "secret",
  autoComplete: "off",
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
} as const;

/**
 * A masked field with a show/hide toggle (Meggy's `PasswordInput`): what is
 * typed stays masked until asked for, and is never prefilled — a stored
 * credential is never sent back to the page to fill it with.
 */
export function PasswordInput({
  id,
  value,
  placeholder,
  invalid,
  describedBy,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly placeholder: string;
  readonly invalid: boolean;
  readonly describedBy?: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <span className="password">
      <input
        id={id}
        {...SECRET_INPUT}
        className={shown ? undefined : SECRET_INPUT.className}
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
        onChange={(event) => onChange(event.target.value)}
      />
      <IconButton
        icon={shown ? "eye-off" : "eye"}
        size="sm"
        label={shown ? t("settings.secret.hide") : t("settings.secret.show")}
        onClick={() => setShown(!shown)}
      />
    </span>
  );
}

/** A labelled field that takes a key to store (Rhumb's, SerpApi's): masked, empty until typed, never prefilled. */
export function KeyField({
  label,
  id,
  value,
  onChange,
}: {
  readonly label: string;
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <Field label={label} id={id}>
      {(control) => (
        <PasswordInput
          id={control.id}
          value={value}
          placeholder={t("settings.secret.paste")}
          invalid={false}
          {...(control["aria-describedby"] === undefined ? {} : { describedBy: control["aria-describedby"] })}
          onChange={onChange}
        />
      )}
    </Field>
  );
}
