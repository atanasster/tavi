import { z } from "zod";

/**
 * The record every domain plugin keeps for each source it reads: who
 * the source is, where it lives, how it is reached, and what its terms allow.
 * A domain extends it with its own fields and then applies
 * `checkDomainSourceRecord`; a source whose terms ban use by a model has no
 * record at all.
 */
export const DOMAIN_SOURCE_TERMS_MAX_AGE_DAYS = 180;

export const DomainSourceCacheSchema = z.discriminatedUnion("mode", [
  /** Kept until the person forgets it or removes the plugin. */
  z.strictObject({ mode: z.literal("keep") }),
  z.strictObject({ mode: z.literal("ttl"), days: z.number().int().min(1).max(365) }),
  /** A source whose terms ask for a refresh within hours (Adzuna's 4). */
  z.strictObject({ mode: z.literal("ttl-hours"), hours: z.number().int().min(1).max(72) }),
  /** Only the source's identifiers are kept. */
  z.strictObject({ mode: z.literal("ids-only") }),
  z.strictObject({ mode: z.literal("none") }),
]);
export type DomainSourceCache = z.infer<typeof DomainSourceCacheSchema>;

export const DomainSourceRecordSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
  name: z.string().min(1).max(60),
  /** ISO 3166 alpha-2 codes, or `*` for everywhere. */
  countries: z.array(z.string().regex(/^([A-Z]{2}|\*)$/)).min(1),
  /** Each within the manifest's `network.domains`. */
  hosts: z.array(z.string().min(1).max(253)).min(1).max(8),
  auth: z.enum(["none", "key-header", "key-query", "key-basic", "oauth-client", "public-token"]),
  /** Config keys; a `key-query` or `key-basic` source's must be in `rawSecrets`. */
  credential: z.array(z.string().min(1)).max(3).optional(),
  /** `http` (the default), or an official MCP server's Streamable HTTP endpoint. */
  transport: z.enum(["http", "mcp"]).default("http"),
  standing: z.enum(["documented", "undocumented", "unofficial"]).default("documented"),
  /** Only a `documented` source may be on by default. */
  defaultOn: z.boolean().default(true),
  terms: z.strictObject({
    url: z.string().url(),
    /** A release test fails once this is older than `DOMAIN_SOURCE_TERMS_MAX_AGE_DAYS`. */
    reviewedAt: z.iso.date(),
    licence: z.string().min(1).max(60),
    /** `banned` has no record: `checkDomainSourceRecord` refuses it. */
    llmUse: z.enum(["allowed", "silent", "carve-out", "banned"]),
    cache: DomainSourceCacheSchema,
    attribution: z.string().max(200),
    displayRules: z.array(z.string().min(1).max(200)).max(4),
    /** No background polling: refused in code when the call context says unattended. */
    userTriggeredOnly: z.boolean(),
  }),
  budget: z.strictObject({ perSecond: z.number().positive(), perDay: z.number().int().positive() }),
});
export type DomainSourceRecord = z.infer<typeof DomainSourceRecordSchema>;

/**
 * The rules a record's fields hold together, for a domain's extended schema's
 * `superRefine`: Zod refuses to extend a refined object, so the base stays
 * plain and each domain applies this after its `extend`.
 */
export function checkDomainSourceRecord(record: DomainSourceRecord, context: z.RefinementCtx): void {
  if (record.terms.llmUse === "banned")
    context.addIssue({
      code: "custom",
      path: ["terms", "llmUse"],
      message: `source ${record.id}: terms that ban use by a model leave no record`,
    });
  if (record.defaultOn && record.standing !== "documented")
    context.addIssue({
      code: "custom",
      path: ["defaultOn"],
      message: `source ${record.id}: only a documented source may be on by default`,
    });
  if (record.auth !== "none" && record.auth !== "public-token" && (record.credential ?? []).length === 0)
    context.addIssue({
      code: "custom",
      path: ["credential"],
      message: `source ${record.id}: ${record.auth} names the config keys it uses`,
    });
}
