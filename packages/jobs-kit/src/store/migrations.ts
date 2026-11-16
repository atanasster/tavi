import type { DomainMigration } from "@tavi/domain-kit";

import { JOBS_DB_SCHEMA } from "./schema.js";

/** `jobs.db`'s migrations, forward only (the domain kit's runner). */
export const JOBS_MIGRATIONS: readonly DomainMigration[] = [{ version: 1, sql: JOBS_DB_SCHEMA }];
