import type { FieldType, Sensitive, UserOnly } from "./pdf.js";

/**
 * Deterministic classification of PDF form fields: which fields Tavi never
 * fills (`userOnly`), and which hold
 * sensitive values that channels mask. The parser child classifies fields;
 * the owner masks values with the same table, so the two cannot drift.
 *
 * Over-classifying is the safe side: it can only mask more and route more
 * approvals to the canvas.
 */

/**
 * The words of a field name or label: split on `_`, `-`, `.`, spaces, digit
 * boundaries and camelCase, lower-cased.
 */
export function fieldTokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token !== "");
}

const SIGNATURE_LIKE = /(?:^|[_\W])(?:sig|signature|sign[_\W]?here|initials?|signed[_\W]?by)(?:[_\W]|$)/i;
const ATTESTATION = /\b(?:certify|attest|declare|penalty of perjury|under oath|acknowledge and agree)/i;

/** Whether a field is the person's alone: a signature, something signature-like, or an attestation. */
export function userOnlyOf(type: FieldType, name: string, label: string | undefined): UserOnly | undefined {
  if (type === "signature") return "signature";
  const texts = [name, label ?? ""];
  // Tried on the raw text and on its words, so `parentSignature` reads as `parent signature`.
  if (texts.some((text) => SIGNATURE_LIKE.test(text) || SIGNATURE_LIKE.test(fieldTokens(text).join(" ")))) return "signature-like";
  if (texts.some((text) => ATTESTATION.test(text))) return "attestation";
  return undefined;
}

interface LabelRule {
  /** Short codes: must equal a token. */
  readonly tokens?: readonly string[];
  /** Longer stems: may prefix a token. */
  readonly stems?: readonly string[];
  /** Every word of one entry must be among the tokens. */
  readonly together?: readonly (readonly string[])[];
}

const LABEL_RULES: Readonly<Record<Sensitive, LabelRule>> = {
  "government-id": {
    tokens: ["ssn", "ein", "itin"],
    together: [
      ["social", "security"],
      ["national", "id"],
      ["tax", "id"],
    ],
  },
  financial: {
    tokens: ["iban", "routing", "bank"],
    together: [
      ["account", "no"],
      ["account", "number"],
      ["credit", "card"],
      ["card", "no"],
      ["card", "number"],
    ],
  },
  "birth-date": { tokens: ["dob", "birthday", "birthdate", "birthdates", "dateofbirth"], together: [["birth", "date"]] },
  health: { tokens: ["health", "medical", "doctor", "physician"], stems: ["immuniz", "vaccin", "allerg", "medicat", "diagnos"] },
  insurance: { tokens: ["policy", "medicaid", "medicare", "carrier"], stems: ["insur"], together: [["rx", "grp"]] },
  contact: { tokens: ["phone", "email", "mobile", "cell", "fax"] },
};

function matchesRule(tokens: readonly string[], rule: LabelRule): boolean {
  const set = new Set(tokens);
  if (rule.tokens?.some((token) => set.has(token)) === true) return true;
  if (rule.stems?.some((stem) => tokens.some((token) => token.startsWith(stem))) === true) return true;
  return rule.together?.some((words) => words.every((word) => set.has(word))) === true;
}

/** A Luhn-valid card number: 13–19 digits. */
export function isLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Numeric dates, year first or last: any of them may be a birth date, so all of them mask. */
const DATE = /^(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})$/;

/**
 * The value patterns, tried whatever the label says. Only shapes that are
 * recognisable on their own are listed: a medical string or an insurance
 * identifier has no shape of its own, and is found by its label alone.
 */
function valueCategories(value: string): Sensitive[] {
  const normal = value.normalize("NFKC").trim();
  const digits = normal.replace(/[\s-]/g, "");
  const found: Sensitive[] = [];
  const ssn = /^\d{3}-?\d{2}-?\d{4}$/.test(normal);
  if (ssn) found.push("government-id");
  if (/^\d{10,19}$/.test(normal) || isLuhn(digits) || /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(digits.toUpperCase())) found.push("financial");
  const phone = /^\+?[\d\s().-]{7,20}$/.test(normal) && (normal.match(/\d/g) ?? []).length >= 7 && !ssn;
  if (EMAIL.test(normal) || phone) found.push("contact");
  if (DATE.test(normal)) found.push("birth-date");
  return found;
}

/** The sensitive categories of a field: by its name's and label's words, and by its value's shape. */
export function sensitiveOf(name: string, label: string | undefined, value?: string): Sensitive[] {
  const tokens = [...fieldTokens(name), ...fieldTokens(label ?? "")];
  const found = new Set<Sensitive>();
  for (const [category, rule] of Object.entries(LABEL_RULES) as [Sensitive, LabelRule][]) {
    if (matchesRule(tokens, rule)) found.add(category);
  }
  if (value !== undefined) for (const category of valueCategories(value)) found.add(category);
  return SENSITIVE_STRICTNESS.filter((category) => found.has(category));
}

/** Strictest first: masking uses the first a field has. */
export const SENSITIVE_STRICTNESS: readonly Sensitive[] = ["government-id", "financial", "health", "insurance", "birth-date", "contact"];

const lastFour = (text: string): string => text.replace(/[^A-Za-z0-9]/g, "").slice(-4);

/** A sensitive value as a channel shows it: the strictest category's mask. */
export function maskSensitive(value: string, categories: readonly Sensitive[]): string {
  const strictest = SENSITIVE_STRICTNESS.find((category) => categories.includes(category));
  const normal = value.normalize("NFKC").trim();
  switch (strictest) {
    case undefined:
      return value;
    case "government-id":
      return `•••-••-${lastFour(normal)}`;
    case "financial":
    case "insurance":
      return `•••• ${lastFour(normal)}`;
    case "health":
      return "[health-verified]";
    case "birth-date": {
      const year = /\b(\d{4})\b/.exec(normal)?.[1];
      return year === undefined ? "••••-••-••" : `${year}-••-••`;
    }
    case "contact": {
      const email = /^([^\s@])[^\s@]*(@.+)$/.exec(normal);
      return email === null ? `•••-•••-${lastFour(normal)}` : `${email[1]}•••${email[2]}`;
    }
  }
}
