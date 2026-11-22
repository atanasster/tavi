import {
  SECRET_KEY_REF_PATTERN,
  SEARCH_PROVIDER_ID_PATTERN,
  WEB_SEARCH_CAPABILITIES,
  type SearchProviderConfig,
  type WebSearchKind,
  type WebSearchResult,
} from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { ask, mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { SETTINGS_BOUNDS, restartNote, type FormErrors } from "./common.js";
import { credentialActions } from "./credentials-api.js";
import type { ConnectionSummary } from "./models-api.js";

export const SEARCH_KIND_LABELS: Readonly<Record<WebSearchKind, string>> = {
  tavily: "Tavily",
  brave: "Brave Search",
  serper: "Serper",
  searxng: "SearXNG",
};

export interface WebSearchFormValues {
  readonly kind: WebSearchKind;
  readonly providerId: string;
  readonly baseUrl: string;
  /** Typed into a masked field; stored as a credential, never sent back. */
  readonly apiKey: string;
}

/** What the form needs for `kind`: a key (required, optional or none) and an instance URL. */
export function searchKindNeeds(kind: WebSearchKind): { readonly key: "required" | "optional" | "none"; readonly baseUrl: boolean } {
  const capabilities = WEB_SEARCH_CAPABILITIES[kind];
  if (capabilities.selfHosted) return { key: "none", baseUrl: true };
  return { key: capabilities.supportsKeyless ? "optional" : "required", baseUrl: false };
}

/** The key the form would store: none for a kind that takes none, whatever a hidden field still holds. */
export function keyToStore(values: Pick<WebSearchFormValues, "kind" | "apiKey">): string {
  return searchKindNeeds(values.kind).key === "none" ? "" : values.apiKey.trim();
}

/** The form's checks — the ones the owner makes, said before it is asked (Meggy's zod schema, over tavi's kinds). */
export function validateWebSearchForm(values: WebSearchFormValues): FormErrors<WebSearchFormValues> {
  const errors: { -readonly [K in keyof WebSearchFormValues]?: string } = {};
  const needs = searchKindNeeds(values.kind);
  if (!SEARCH_PROVIDER_ID_PATTERN.test(values.providerId) || values.providerId.length > SETTINGS_BOUNDS.providerId) {
    errors.providerId = translateNow("settings.searchApi.badName");
  }
  const baseUrl = values.baseUrl.trim();
  if (needs.baseUrl && (!/^https?:\/\/[^/@\s?#]+(?:\/[^\s?#]*)?$/i.test(baseUrl) || baseUrl.length > SETTINGS_BOUNDS.baseUrl)) {
    errors.baseUrl = translateNow("settings.searchApi.badBaseUrl");
  }
  const key = keyToStore(values);
  if (needs.key === "required" && key === "")
    errors.apiKey = translateNow("settings.searchApi.needsKey", { label: SEARCH_KIND_LABELS[values.kind] });
  else if (key.length > SETTINGS_BOUNDS.value) errors.apiKey = translateNow("settings.credentials.tooLong");
  return errors;
}

/** Where a provider's key is stored: its own reference, never a model connection's. */
export function searchKeyReference(providerId: string): string {
  return `search.${providerId}`;
}

/**
 * Save the form. Before anything is written, the owner is asked again
 * — the page's own list may be stale, cut off, or missing rows it cannot read —
 * and the save is refused when the name is taken, or when anything already
 * holds `search.<id>`: a stored credential, or a model connection naming it.
 * So a key never replaces another's. Only then is the key stored, and the
 * provider added naming it; a key the owner stored for a provider it then
 * refused (a race with another writer) is said, by name.
 */
export async function saveWebSearchProvider(client: SettingsClient, values: WebSearchFormValues): Promise<Outcome<string | undefined>> {
  const key = keyToStore(values);
  const reference = searchKeyReference(values.providerId);
  const providers = await searchActions.list(client);
  if (!providers.ok) return providers;
  const taken = [...providers.value.providers.map((provider) => provider.providerId), ...(providers.value.unreadable ?? [])];
  if (taken.includes(values.providerId))
    return { ok: false, message: translateNow("settings.searchApi.nameTaken", { id: values.providerId }) };
  if (key !== "") {
    // Guards a later change to either pattern: an id the form accepts always names a usable reference today.
    if (!SECRET_KEY_REF_PATTERN.test(reference))
      return { ok: false, message: translateNow("settings.searchApi.badReference", { reference }) };
    const [stored, connections] = await Promise.all([
      credentialActions.list(client),
      ask<readonly ConnectionSummary[]>(client, "models", { action: "list" }),
    ]);
    if (!stored.ok) return stored;
    if (!connections.ok) return connections;
    if (stored.value.credentials.includes(reference) || connections.value.some((connection) => connection.credentialRef === reference)) {
      return {
        ok: false,
        message: translateNow("settings.searchApi.referenceTaken", { reference }),
      };
    }
    const written = await ask<unknown>(client, "credentials", { action: "set", reference, value: key });
    if (!written.ok) return written;
  }
  const added = await ask<unknown>(client, "search", {
    action: "add",
    providerId: values.providerId,
    kind: values.kind,
    ...(key === "" ? {} : { credentialRef: reference }),
    ...(searchKindNeeds(values.kind).baseUrl ? { baseUrl: values.baseUrl.trim() } : {}),
  });
  if (!added.ok)
    return key === "" ? added : { ok: false, message: translateNow("settings.searchApi.notAdded", { message: added.message, reference }) };
  return { ok: true, value: restartNote(added.value, "search") ?? translateNow("settings.searchApi.added", { id: values.providerId }) };
}

export const searchActions = {
  list: (client: SettingsClient) =>
    ask<{ readonly providers: readonly SearchProviderConfig[]; readonly truncated?: boolean; readonly unreadable?: readonly string[] }>(
      client,
      "search",
      {
        action: "list",
      },
    ),
  async setEnabled(client: SettingsClient, providerId: string, enabled: boolean): Promise<Outcome<string | undefined>> {
    const written = await ask<unknown>(client, "search", { action: enabled ? "enable" : "disable", providerId });
    return mapOutcome(
      written,
      (value) =>
        restartNote(value, "search") ??
        translateNow(enabled ? "settings.searchApi.enabled" : "settings.searchApi.disabled", { id: providerId }),
    );
  },
  async remove(
    client: SettingsClient,
    provider: Pick<SearchProviderConfig, "providerId" | "credentialRef">,
  ): Promise<Outcome<string | undefined>> {
    const removed = await ask<unknown>(client, "search", { action: "remove", providerId: provider.providerId });
    if (!removed.ok) return removed;
    // Its key is not deleted with it: another provider, or a later one of the same name, may use it.
    return {
      ok: true,
      value:
        provider.credentialRef === undefined
          ? translateNow("settings.searchApi.removed", { id: provider.providerId })
          : translateNow("settings.searchApi.removedKeyKept", { id: provider.providerId, reference: provider.credentialRef }),
    };
  },
  async test(client: SettingsClient, providerId: string): Promise<Outcome<string | undefined>> {
    // The owner's search test answers what a search answers.
    const tested = await ask<WebSearchResult>(client, "search", { action: "test", providerId });
    return mapOutcome(tested, (value) => translateNow("settings.searchApi.tested", { id: providerId, count: value.sources.length }));
  },
};
