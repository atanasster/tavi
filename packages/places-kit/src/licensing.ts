import { KIT_ZOD, objectsOf, type ObjectMode, type Zod } from "@tavi/domain-kit";
import { z } from "zod";

/**
 * Whether a trade is licensed where the person is, as data. A row says
 * the regime, who keeps the register and how it is reached. "This trade is
 * not licensed here" is an answer of its own, made with no request; "no
 * licence found" is another.
 */

export const LICENSING_REGIMES = ["licensed", "registered_business", "certified_voluntary", "not_licensed", "unknown"] as const;
export const LICENSING_ACCESS = ["api", "bulk", "web", "none"] as const;
const JURISDICTION = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
const PROFESSION = /^[a-z][a-z0-9_]{1,39}$/;

export const LicensingRowSchema = z
  .strictObject({
    jurisdiction: z.string().regex(JURISDICTION),
    profession: z.string().regex(PROFESSION),
    regime: z.enum(LICENSING_REGIMES),
    regulator: z.string().max(200).optional(),
    access: z.enum(LICENSING_ACCESS),
    /** The adapter that answers an `api` row. */
    source: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{1,39}$/)
      .optional(),
    /** What the source's licence types are matched with, for an `api` row: upper-case words. */
    licenseTypes: z
      .array(z.string().regex(/^[A-Z0-9 /&-]{2,40}$/))
      .max(8)
      .optional(),
    verifyUrl: z.string().url().optional(),
    /** Where the rule itself is stated. */
    ruleUrl: z.string().url().optional(),
    note: z.string().min(1).max(500),
    reviewedAt: z.iso.date(),
  })
  .refine((row) => row.access !== "api" || (row.source !== undefined && row.licenseTypes !== undefined), {
    message: "an api row names its source and licence types",
  });
export type LicensingRow = z.infer<typeof LicensingRowSchema>;

export const LicensingFileSchema = z.strictObject({
  country: z.string().regex(/^[A-Z]{2}$/),
  rows: z.array(LicensingRowSchema).max(200),
});
export type LicensingFile = z.infer<typeof LicensingFileSchema>;

/** `professions`: what the model is told the matrix's professions are. */
export const verifyLicenseInput = (zod: Zod, mode: ObjectMode, professions: string) => {
  const object = objectsOf(zod, mode);
  return object({
    jurisdiction: zod.string().regex(JURISDICTION).describe("ISO 3166-2: US-TX, GB-ENG"),
    profession: zod.string().regex(PROFESSION).describe(professions),
    subject: object({ name: zod.string().min(2).max(200).optional(), licenceNumber: zod.string().min(1).max(40).optional() })
      .optional()
      .describe("A business or licensee to look up"),
  });
};
export const VerifyLicenseInputSchema = verifyLicenseInput(
  KIT_ZOD,
  "strict",
  "auto_repair, electrician, contractor, gas_engineer, kennel …",
);
export type VerifyLicenseInput = z.infer<typeof VerifyLicenseInputSchema>;

export const LicenceMatchSchema = z.strictObject({
  name: z.string(),
  number: z.string(),
  status: z.string(),
  actions: z.array(z.string().max(300)).max(10),
  asOf: z.string(),
});
export type LicenceMatch = z.infer<typeof LicenceMatchSchema>;

export const VerifyLicenseResultSchema = z.strictObject({
  regime: z.enum(LICENSING_REGIMES),
  regulator: z.string().max(200).optional(),
  access: z.enum(LICENSING_ACCESS),
  matches: z.array(LicenceMatchSchema).max(10),
  /** For `web` access: opened in the browser under its site profile. */
  verifyUrl: z.string().url().optional(),
  note: z.string().max(500),
  /** Provenance: `data/licensing/<file>#<jurisdiction>/<profession>`. */
  matrixRow: z.string(),
});
export type VerifyLicenseResult = z.infer<typeof VerifyLicenseResultSchema>;

/**
 * The row for a jurisdiction and profession: the jurisdiction's own, else its
 * country's (`GB-ENG` reads `GB`), with where it came from.
 */
export function findLicensingRow(
  files: readonly LicensingFile[],
  jurisdiction: string,
  profession: string,
): { readonly row: LicensingRow; readonly ref: string } | undefined {
  const country = jurisdiction.slice(0, 2);
  const file = files.find((each) => each.country === country);
  if (file === undefined) return undefined;
  const row =
    file.rows.find((each) => each.jurisdiction === jurisdiction && each.profession === profession) ??
    file.rows.find((each) => each.jurisdiction === country && each.profession === profession);
  return row === undefined ? undefined : { row, ref: `data/licensing/${country.toLowerCase()}.json#${row.jurisdiction}/${row.profession}` };
}

/** Each matrix file's problems: two rows for one jurisdiction and profession, or a row outside its file's country. */
export function licensingProblems(files: readonly LicensingFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const seen = new Set<string>();
    for (const row of file.rows) {
      const key = `${row.jurisdiction}/${row.profession}`;
      if (!row.jurisdiction.startsWith(file.country)) problems.push(`${file.country}: ${key} is not in ${file.country}`);
      if (seen.has(key)) problems.push(`${file.country}: ${key} twice`);
      seen.add(key);
    }
  }
  return problems;
}
