import type { WebSearchKind } from "@tavi/contracts";

import { Field } from "../../ui/Field.js";
import { SEARCH_KIND_LABELS, searchKindNeeds } from "./search-api.js";
import { PasswordInput } from "./PasswordInput.js";

/**
 * What a web search provider of `kind` is given, by what the kind needs
 * (`searchKindNeeds`): SearXNG its instance's address, a hosted kind its API
 * key — optional for one that also runs keyless. The fields of both forms
 * that add one (Settings → Search, and the welcome walk's search step); each
 * form picks the kind, checks the values and submits them its own way.
 */
export function WebSearchProviderFields({
  kind,
  baseUrl,
  apiKey,
  errors = {},
  onBaseUrl,
  onApiKey,
}: {
  readonly kind: WebSearchKind;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** What is wrong with each, once the form says so. */
  readonly errors?: { readonly baseUrl?: string | undefined; readonly apiKey?: string | undefined };
  readonly onBaseUrl: (baseUrl: string) => void;
  readonly onApiKey: (apiKey: string) => void;
}) {
  const needs = searchKindNeeds(kind);
  const label = SEARCH_KIND_LABELS[kind];
  return (
    <>
      {needs.baseUrl ? (
        <Field label="Instance address" error={errors.baseUrl}>
          <input
            autoComplete="off"
            value={baseUrl}
            placeholder="e.g. http://127.0.0.1:8888 (with json in its search.formats)"
            onChange={(event) => onBaseUrl(event.target.value)}
          />
        </Field>
      ) : null}
      {needs.key === "none" ? null : (
        <Field
          label={
            <>
              {label} API key
              {needs.key === "optional" ? ` (optional: ${label} also runs keyless)` : ""}
            </>
          }
          error={errors.apiKey}
        >
          {(control) => (
            <PasswordInput
              id={control.id}
              value={apiKey}
              placeholder="Paste the key"
              invalid={control["aria-invalid"] === true}
              describedBy={control["aria-describedby"]}
              onChange={onApiKey}
            />
          )}
        </Field>
      )}
    </>
  );
}
