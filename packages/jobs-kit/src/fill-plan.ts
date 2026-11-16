import { protectedFieldClass, protectedFieldRefusal } from "@tavi/contracts";
import { KIT_ZOD, objectsOf, type ObjectMode, type Zod } from "@tavi/domain-kit";
import { z } from "zod";

import type { JobPosting } from "./contracts.js";

/**
 * `fill_plan`: a value for each field the agent observed on
 * an application form, from the person's profile facts and their answers in
 * chat, each with where it came from. A protected field is left for the
 * person; a field nothing answers is unmapped, never guessed. Advisory: the
 * browser's rules enforce, whatever the fill plan says.
 */

/** The jobs vocabulary of fields a stage profile may let Tavi fill (`fillable`). */
export const FILLABLE_FIELDS = [
  "name",
  "first_name",
  "last_name",
  "email",
  "phone",
  "location",
  "links",
  "work_history",
  "education",
  "cv_upload",
  "cover_letter",
  "custom_answer",
] as const;
export type FillableField = (typeof FILLABLE_FIELDS)[number];

/** A form field as `browser.observe` gave it; drawn with `zod` (`objectsOf`). */
export const observedFieldInput = (zod: Zod, mode: ObjectMode) =>
  objectsOf(
    zod,
    mode,
  )({
    ref: zod.string().max(64).optional(),
    label: zod.string().max(300).default(""),
    name: zod.string().max(200).optional(),
    type: zod.string().max(40).optional(),
    options: zod.array(zod.string().max(200)).max(100).optional(),
    required: zod.boolean().optional(),
  });
export const ObservedFieldSchema = observedFieldInput(KIT_ZOD, "strict");
export type ObservedField = z.infer<typeof ObservedFieldSchema>;

/** What a form may ask that the person's `jobs.profile.facts` record holds. */
export const FillFactsSchema = z.strictObject({
  name: z.string().max(200).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().max(320).optional(),
  phone: z.string().max(60).optional(),
  location: z.string().max(200).optional(),
  links: z
    .array(z.strictObject({ label: z.string().max(60), url: z.string().url().max(2_048) }))
    .max(10)
    .default([]),
  workHistory: z.array(z.string().max(500)).max(20).default([]),
  education: z.array(z.string().max(500)).max(10).default([]),
});
export type FillFacts = z.infer<typeof FillFactsSchema>;

/** An answer the person gave in chat, to a question in their own words. */
export const personAnswerInput = (zod: Zod, mode: ObjectMode) =>
  objectsOf(zod, mode)({ question: zod.string().min(1).max(300), answer: zod.string().max(4_000) });
export const PersonAnswerSchema = personAnswerInput(KIT_ZOD, "strict");

export interface PlannedField {
  readonly ref?: string;
  readonly label: string;
  readonly kind?: FillableField;
  readonly value?: string;
  /** `facts.<key>`, `answer` (the person said it in chat), or `cv` for an upload the person chooses. */
  readonly source?: string;
  /** Why the person fills it: a protected field. */
  readonly leaveForPerson?: string;
  readonly unmapped?: true;
}

export interface FillPlan {
  readonly fields: readonly PlannedField[];
  /** A posting with a scam flag: stop and show the person why. */
  readonly blocked?: true;
  readonly reasons: readonly string[];
  /** The employer's rule on AI in applications, quoted. */
  readonly aiPolicy?: string;
}

/**
 * A field's kind in the jobs vocabulary, from its whole label, its name and
 * its type: only where the field asks for exactly that. "Company name",
 * "School name" or "Years of experience" are no kind, so nothing is guessed
 * for them.
 */
export function fieldKindOf(field: ObservedField): FillableField | undefined {
  const label = normal(field.label).replace(/\s*required$/, "");
  const name = normal((field.name ?? "").replace(/([a-z])([A-Z])/g, "$1 $2"));
  const type = (field.type ?? "").toLowerCase();
  const is = (pattern: RegExp): boolean => pattern.test(label) || pattern.test(name);
  if (type === "file") return /cover/.test(`${label} ${name}`) ? "cover_letter" : "cv_upload";
  if (type === "email" || is(/^(your )?e ?mail( address)?$/)) return "email";
  if (type === "tel" || is(/^(your )?(phone|mobile|telephone|phone number|mobile number|telefon|téléphone|teléfono)$/)) return "phone";
  if (is(/^(your )?(first|given) name$|^vorname$|^prénom$|^first$/)) return "first_name";
  if (is(/^(your )?(last|family) name$|^surname$|^nachname$|^nom( de famille)?$|^last$/)) return "last_name";
  if (is(/^(your )?(full |legal )?name$/)) return "name";
  if (is(/^(your )?(location|city|current location|wohnort|ville)$/)) return "location";
  if (is(/^(linkedin|github|portfolio|website|personal website)( (profile|url|link|profile url))?$/)) return "links";
  if (is(/^cover letter$|^anschreiben$|^lettre de motivation$/)) return "cover_letter";
  return undefined;
}

const normal = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The answer the person gave to this very question: its words, whole, as the field asks it. */
function answerFor(field: ObservedField, answers: readonly z.infer<typeof PersonAnswerSchema>[]): string | undefined {
  const label = normal(field.label);
  if (label === "") return undefined;
  return answers.find((answer) => normal(answer.question) === label)?.answer;
}

/** The plan for a form's fields. `posting` gives its flags and the employer's AI rule. */
export function fillPlan(input: {
  readonly fields: readonly ObservedField[];
  readonly facts: FillFacts;
  readonly answers: readonly z.infer<typeof PersonAnswerSchema>[];
  readonly posting?: Pick<JobPosting, "flags" | "aiPolicy">;
}): FillPlan {
  const scams = (input.posting?.flags ?? []).filter((flag) => flag.startsWith("scam:"));
  const fields = input.fields.map((field): PlannedField => {
    const base = { ...(field.ref === undefined ? {} : { ref: field.ref }), label: field.label };
    const shielded = protectedFieldClass([field.label, field.name]);
    if (shielded !== undefined) return { ...base, leaveForPerson: protectedFieldRefusal(shielded) };
    const kind = fieldKindOf(field);
    // The person's own answer to this very question, in the chat, stands over what the facts say.
    const told = answerFor(field, input.answers);
    if (told !== undefined) return { ...base, ...(kind === undefined ? {} : { kind }), value: told, source: "answer" };
    const facts = input.facts;
    // A link the field names ("GitHub URL" is the GitHub link, never another).
    const link = (label: string): string | undefined =>
      facts.links.find((each) => normal(label).split(" ").includes(normal(each.label)))?.url;
    const fromFacts: Partial<Record<FillableField, readonly [string | undefined, string]>> = {
      name: [facts.name ?? ([facts.firstName, facts.lastName].filter((part) => part !== undefined).join(" ") || undefined), "facts.name"],
      first_name: [facts.firstName ?? facts.name?.split(/\s+/)[0], "facts.firstName"],
      last_name: [
        facts.lastName ?? (facts.name !== undefined && facts.name.includes(" ") ? facts.name.split(/\s+/).slice(1).join(" ") : undefined),
        "facts.lastName",
      ],
      email: [facts.email, "facts.email"],
      phone: [facts.phone, "facts.phone"],
      location: [facts.location, "facts.location"],
      links: [link(`${field.label} ${field.name ?? ""}`), "facts.links"],
    };
    if (kind === "cv_upload" || kind === "cover_letter")
      return {
        ...base,
        kind,
        source: "cv",
        leaveForPerson:
          kind === "cv_upload"
            ? "the CV upload asks the person every time (browser.act upload)"
            : "a cover letter is drafted with the person, then uploaded",
      };
    const [value, source] = kind === undefined ? [undefined, ""] : (fromFacts[kind] ?? [undefined, ""]);
    if (kind !== undefined && value !== undefined && value !== "") return { ...base, kind, value, source };
    return { ...base, ...(kind === undefined ? {} : { kind }), unmapped: true };
  });
  return {
    fields,
    ...(scams.length > 0 ? { blocked: true as const } : {}),
    reasons: scams.map((flag) => `the posting is flagged ${flag}: stop and show the person`),
    ...(input.posting?.aiPolicy === undefined ? {} : { aiPolicy: input.posting.aiPolicy }),
  };
}
