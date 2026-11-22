import { useState } from "react";

import { WEB_SEARCH_KINDS, type WebSearchKind } from "@tavi/contracts";

import {
  SEARCH_KIND_LABELS,
  keyToStore,
  searchKeyReference,
  searchKindNeeds,
  validateWebSearchForm,
  type WebSearchFormValues,
} from "./search-api.js";
import { useT } from "../../lib/i18n.js";
import { Modal } from "../../ui/Modal.js";
import { FormActions, FormFailure } from "./FormParts.js";
import { Field } from "../../ui/Field.js";
import { WebSearchProviderFields } from "./WebSearchProviderFields.js";
import { useFormSubmit } from "../../hooks/use-action.js";
import { Notice } from "../../ui/Parts.js";
import { withParts } from "../../ui/with-parts.js";

/**
 * Meggy's `WebSearchFormModal`, ported to tavi's providers:
 * pick a kind, name it, give SearXNG its instance and a hosted kind its key.
 * The checks are the owner's (`validateWebSearchForm`), made before it is asked;
 * the key goes into a credential of its own and is never shown again. Adding
 * only: a provider's key is rotated on the Credentials view.
 */
export function WebSearchFormModal({
  taken,
  onSave,
  onClose,
}: {
  /** Provider ids already configured — readable or not. */
  readonly taken: readonly string[];
  readonly onSave: (values: WebSearchFormValues) => Promise<string | undefined>;
  readonly onClose: () => void;
}) {
  const t = useT();
  const [values, setValues] = useState<WebSearchFormValues>({
    kind: "tavily",
    providerId: freeId("tavily", taken),
    baseUrl: "",
    apiKey: "",
  });
  const errors = validateWebSearchForm(values);
  const clash = taken.includes(values.providerId) ? t("settings.search.nameTaken") : undefined;
  const valid = Object.keys(errors).length === 0 && clash === undefined;
  const { touched, saving, failure, submit } = useFormSubmit(valid, () => onSave(values), onClose);
  const set = (change: Partial<WebSearchFormValues>): void => setValues({ ...values, ...change });
  const nameError = touched ? (errors.providerId ?? clash) : undefined;

  const choose = (kind: WebSearchKind): void =>
    set({
      kind,
      // A name that was the default follows the kind; one the operator typed stays.
      providerId: values.providerId === freeId(values.kind, taken) ? freeId(kind, taken) : values.providerId,
      // A kind that takes no key drops one typed for another: a hidden field is never stored.
      apiKey: searchKindNeeds(kind).key === "none" ? "" : values.apiKey,
    });

  return (
    <Modal title={t("settings.search.addTitle")} busy={saving} onClose={onClose}>
      <form
        className="form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset className="kinds">
          <legend>{t("settings.search.provider")}</legend>
          {WEB_SEARCH_KINDS.map((kind: WebSearchKind) => (
            <label key={kind} className={values.kind === kind ? "kind active" : "kind"}>
              <input type="radio" name="kind" value={kind} checked={values.kind === kind} onChange={() => choose(kind)} />
              {SEARCH_KIND_LABELS[kind]}
            </label>
          ))}
        </fieldset>
        <Field label={t("settings.search.name")} error={nameError}>
          <input autoComplete="off" value={values.providerId} onChange={(event) => set({ providerId: event.target.value })} />
        </Field>
        <WebSearchProviderFields
          kind={values.kind}
          baseUrl={values.baseUrl}
          apiKey={values.apiKey}
          errors={touched ? errors : {}}
          onBaseUrl={(baseUrl) => set({ baseUrl })}
          onApiKey={(apiKey) => set({ apiKey })}
        />
        {keyToStore(values) !== "" ? (
          <Notice>{withParts(t("settings.search.storedAs"), { reference: <code>{searchKeyReference(values.providerId)}</code> })}</Notice>
        ) : null}
        <FormFailure message={failure} />
        <FormActions
          saving={saving}
          disabled={saving || (touched && !valid)}
          cancelDisabled={saving}
          label={t("settings.action.save")}
          onCancel={onClose}
        />
      </form>
    </Modal>
  );
}

/** `kind`, or `kind-2`, `kind-3`… — the first name no provider has. */
export function freeId(kind: string, taken: readonly string[]): string {
  if (!taken.includes(kind)) return kind;
  for (let index = 2; ; index += 1) if (!taken.includes(`${kind}-${index}`)) return `${kind}-${index}`;
}
