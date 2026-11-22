import type { WebSearchKind } from "@tavi/contracts";

import { useT } from "../../lib/i18n.js";
import { Field } from "../../ui/Field.js";
import { SEARCH_KIND_LABELS, searchKindNeeds } from "./search-api.js";
import { PasswordInput } from "./PasswordInput.js";

/**
 * What a web search provider of `kind` is given, by what the kind needs
 * (`searchKindNeeds`): SearXNG its instance's address, a hosted kind its API
 * key — optional for one that also runs keyless. The fields of both forms
 * that add one (Settings → Web search, and the welcome walk's search step); each
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
  const t = useT();
  const needs = searchKindNeeds(kind);
  const label = SEARCH_KIND_LABELS[kind];
  return (
    <>
      {needs.baseUrl ? (
        <Field label={t("settings.search.instance")} error={errors.baseUrl}>
          <input
            autoComplete="off"
            value={baseUrl}
            placeholder={t("settings.search.instancePlaceholder")}
            onChange={(event) => onBaseUrl(event.target.value)}
          />
        </Field>
      ) : null}
      {needs.key === "none" ? null : (
        <Field
          label={t(needs.key === "optional" ? "settings.search.apiKeyOptional" : "settings.search.apiKey", { label })}
          error={errors.apiKey}
        >
          {(control) => (
            <PasswordInput
              id={control.id}
              value={apiKey}
              placeholder={t("settings.secret.paste")}
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
