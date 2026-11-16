import { useId, useState } from "react";

import type { AppSettingField } from "@tavi/contracts";

import { PasswordInput } from "../settings/PasswordInput.js";
import { Button } from "../../ui/Button.js";
import { Select } from "../../ui/Select.js";

type Value = string | number | boolean;

/**
 * An app's settings, whatever kind of app it is:
 * every field arrives as an `AppSettingField` — a plugin's config, a
 * channel's field or a provider's setting, adapted by the owner — and is drawn
 * here by its type. Only the fields changed are saved; an advanced one is
 * folded under *More settings*.
 */
export function SettingsForm({
  fields,
  busy,
  onSave,
}: {
  readonly fields: readonly AppSettingField[];
  readonly busy: boolean;
  readonly onSave: (values: Readonly<Record<string, Value>>) => void;
}) {
  const base = useId();
  const [values, setValues] = useState<Record<string, Value>>({});
  const field = (each: AppSettingField) => (
    <SettingField
      key={each.key}
      id={`${base}-${each.key}`}
      field={each}
      value={values[each.key]}
      onChange={(next) =>
        setValues((current) => {
          // A field emptied again is left as it was, not saved empty.
          if (next !== undefined) return { ...current, [each.key]: next };
          const { [each.key]: _cleared, ...rest } = current;
          return rest;
        })
      }
    />
  );
  const advanced = fields.filter((each) => each.advanced);
  return (
    <form
      className="apps-settings stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(values);
        setValues({});
      }}
    >
      {fields.filter((each) => !each.advanced).map(field)}
      {advanced.length === 0 ? null : (
        <details className="apps-more-settings">
          <summary>More settings</summary>
          {advanced.map(field)}
        </details>
      )}
      <div className="actions">
        <Button variant="primary" type="submit" disabled={busy || Object.keys(values).length === 0}>
          Save
        </Button>
      </div>
    </form>
  );
}

function SettingField({
  id,
  field,
  value,
  onChange,
}: {
  readonly id: string;
  readonly field: AppSettingField;
  readonly value: Value | undefined;
  readonly onChange: (next: Value | undefined) => void;
}) {
  const text = typeof value === "string" ? value : "";
  const placeholder = field.placeholder ?? (field.default === undefined ? undefined : `Default: ${String(field.default)}`);
  const helpId = field.help === undefined ? undefined : `${id}-help`;
  const described = helpId === undefined ? {} : { "aria-describedby": helpId };
  const label = `${field.label}${field.required ? " (required)" : ""}`;
  return (
    <div className="apps-field">
      {/* A list has no control here, so its name is a heading of the note, not a label. */}
      {field.type === "strings" ? <span id={id}>{label}</span> : <label htmlFor={id}>{label}</label>}
      {field.type === "credential" ? (
        <PasswordInput
          id={id}
          value={text}
          placeholder="Stored as a credential; leave empty to keep it"
          invalid={false}
          {...(helpId === undefined ? {} : { describedBy: helpId })}
          onChange={(next) => onChange(next === "" ? undefined : next)}
        />
      ) : null}
      {field.type === "boolean" ? (
        <input
          id={id}
          type="checkbox"
          checked={value === undefined ? field.default === true : value === true}
          {...described}
          onChange={(event) => onChange(event.target.checked)}
        />
      ) : null}
      {field.type === "number" ? (
        <input
          id={id}
          type="number"
          value={typeof value === "number" ? value : ""}
          placeholder={placeholder}
          {...described}
          onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
        />
      ) : null}
      {field.type === "choice" ? (
        <Select id={id} value={text} {...described} onChange={(event) => onChange(event.target.value)}>
          <option value="" disabled>
            {placeholder ?? "Choose…"}
          </option>
          {(field.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      ) : null}
      {field.type === "string" || field.type === "url" ? (
        <input
          id={id}
          type={field.type === "url" ? "url" : "text"}
          value={text}
          placeholder={placeholder}
          {...(field.pattern === undefined ? {} : { pattern: field.pattern })}
          {...described}
          onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
        />
      ) : null}
      {/* A list is not one value this form can save: it is set where its plugin is configured. */}
      {field.type === "strings" ? <span className="meta-sm">A list: set it in Settings → Plugins.</span> : null}
      {field.help === undefined ? null : (
        <span id={helpId} className="meta-sm">
          {field.help}
        </span>
      )}
    </div>
  );
}
