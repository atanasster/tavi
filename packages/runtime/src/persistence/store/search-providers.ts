import type { SearchProviderRepositoryPort } from "../internal-contracts.js";
import { TaviError, SearchProviderConfigSchema, TimestampSchema, type SearchProviderConfig } from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { assertWritable, parseStoredRow, partitionReadable } from "./stored-values.js";

interface SearchProviderRow {
  readonly provider_id: string;
  readonly kind: string;
  readonly credential_ref: string | null;
  readonly base_url: string | null;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function toSearchProvider(row: SearchProviderRow): SearchProviderConfig {
  return parseStoredRow(
    SearchProviderConfigSchema,
    {
      providerId: row.provider_id,
      kind: row.kind,
      ...(row.credential_ref === null ? {} : { credentialRef: row.credential_ref }),
      ...(row.base_url === null ? {} : { baseUrl: row.base_url }),
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    `search provider ${row.provider_id}`,
  );
}

/** Configured web search providers, in the order they were added. */
export class SqliteSearchProviderRepository implements SearchProviderRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  add(input: Omit<SearchProviderConfig, "createdAt" | "updatedAt"> & { readonly now: string }): SearchProviderConfig {
    const parsed = SearchProviderConfigSchema.safeParse({
      providerId: input.providerId,
      kind: input.kind,
      ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      enabled: input.enabled,
      createdAt: input.now,
      updatedAt: input.now,
    });
    // Refused before writing, saying why: the refinements' reasons are the
    // operator's to act on ("a searxng provider needs its instance's baseUrl").
    if (!parsed.success) {
      throw new TaviError(
        "INVALID_INPUT",
        `search provider ${input.providerId} is not valid and was not written: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        { details: { providerId: input.providerId } },
      );
    }
    const config = parsed.data;
    // By id alone: an existing row that no longer parses is still a conflict.
    if (this.#store.handle.prepare("SELECT 1 FROM tavi_search_providers WHERE provider_id = ?").get(config.providerId) !== undefined) {
      throw new TaviError("CONFLICT", `search provider ${config.providerId} already exists`, {
        details: { providerId: config.providerId },
      });
    }
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_search_providers (provider_id, kind, credential_ref, base_url, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        config.providerId,
        config.kind,
        config.credentialRef ?? null,
        config.baseUrl ?? null,
        config.enabled ? 1 : 0,
        input.now,
        input.now,
      );
    return config;
  }

  get(providerId: string): SearchProviderConfig | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_search_providers WHERE provider_id = ?").get(providerId) as
      | SearchProviderRow
      | undefined;
    return row === undefined ? undefined : toSearchProvider(row);
  }

  list(): { readonly providers: readonly SearchProviderConfig[]; readonly unreadable: readonly string[] } {
    const rows = this.#store.handle.prepare("SELECT * FROM tavi_search_providers ORDER BY rowid").all() as SearchProviderRow[];
    const partitioned = partitionReadable(rows, (row) => row.provider_id, toSearchProvider);
    return { providers: partitioned.readable, unreadable: partitioned.unreadable };
  }

  remove(providerId: string): boolean {
    return this.#store.handle.prepare("DELETE FROM tavi_search_providers WHERE provider_id = ?").run(providerId).changes > 0;
  }

  setEnabled(providerId: string, enabled: boolean, now: string): boolean {
    // A bad instant would leave the row unreadable: refused before the UPDATE.
    assertWritable(TimestampSchema, now, `The update time of search provider ${providerId}`);
    return (
      this.#store.handle
        .prepare("UPDATE tavi_search_providers SET enabled = ?, updated_at = ? WHERE provider_id = ?")
        .run(enabled ? 1 : 0, now, providerId).changes > 0
    );
  }
}
