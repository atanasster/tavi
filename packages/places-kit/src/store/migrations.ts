import type { DomainMigration } from "@tavi/domain-kit";

import { PLACES_DB_SCHEMA } from "./schema.js";

/** `places.db`'s migrations, forward only (the domain kit's runner). */
export const PLACES_MIGRATIONS: readonly DomainMigration[] = [{ version: 1, sql: PLACES_DB_SCHEMA }];
