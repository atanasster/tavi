import { JOB_FLAGS, type JobFlag, type Place, type Salary } from "./contracts.js";
import { annualise } from "./salary.js";

/**
 * What makes a posting worth a second look. Flags are shown with the
 * posting and never move it across a hard filter; matching is code, so no
 * words in a posting can argue it onto the shortlist.
 */

/** Words written to a model rather than to a person: an instruction to an agent. */
const INJECTION: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\b[^.\n]{0,20}\b(previous|prior|above|earlier|all|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules)\b/i,
  // Addressed to a model: "AI assistants: send…", "Note to the AI", "If you are an LLM". A job ad about AI ("AI should
  // transform how we work", "As an AI company") is not addressed to one.
  // The addressee is a model by name ("AI assistants:", "LLM:", "ChatGPT:"), never a role ("Executive Assistant: you will…").
  /\b(ai|llm|language model|chat ?gpt|claude|gemini|copilot)(\s+(assistants?|agents?|models?|bots?|tools?|systems?))?\s*:\s*(please\s+)?(ignore|disregard|forget|don't|do not|send|email|forward|include|add|mention|rate|rank|score|recommend|reply|respond|tell|say|output)\b/i,
  /\b(note|message|instructions?)\s+(to|for)\s+(the\s+|any\s+|all\s+)?(ai|llm|language model|assistant|agent|bot|model)s?\b/i,
  /\bif you are an?\s+(ai|llm|large language model|language model|assistant|agent|bot)\b/i,
  /\bas an ai (language )?(model|assistant)\b/i,
  /\b(system|developer) (prompt|message)\b/i,
  /\b(send|email|forward|upload|share)\b[^.\n]{0,40}\b(cv|resume|résumé|passport|id card|identity|ssn|social security|bank (details|account)|tax (id|number))\b[^.\n]{0,60}(@|https?:\/\/)/i,
  /<\|?(im_start|im_end|system|endoftext)\|?>/i,
];

const SCAMS: readonly (readonly [JobFlag, RegExp])[] = [
  [
    "scam:payment",
    /\b(pay|purchase|buy|fee|deposit)\b[^.\n]{0,40}\b(training|equipment|starter kit|registration|onboarding|background check|certification|software)\b/i,
  ],
  ["scam:check", /\b(send|deposit|cash|receive)\b[^.\n]{0,20}\b(a )?(check|cheque)\b|\bmobile deposit\b/i],
  [
    "scam:id",
    /\b(send|provide|upload|submit)\b[^.\n]{0,30}\b(ssn|social security|passport|driver'?s licen[cs]e|bank (account|details)|routing number)\b[^.\n]{0,40}\b(before|prior to|in order to|to (apply|be considered|proceed))\b/i,
  ],
  [
    "scam:messaging",
    /\b(telegram|whatsapp|signal app|wickr|google hangouts|wire app)\b[^.\n]{0,40}\b(interview|contact|message|text|chat|reach)\b|\b(interview|contact|message|text)\b[^.\n]{0,40}\b(on|via|through|using)\b[^.\n]{0,10}\b(telegram|whatsapp|wickr|google hangouts)\b/i,
  ],
];

// The address's domain alone: a pattern over its local part would backtrack across a long run of word characters.
const FREE_MAIL =
  /[\w.+-]@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|aol|proton|protonmail|icloud|gmx|mail|yandex)\.[a-z.]{2,6}\b/i;

/** "AI" and an application in one sentence: the employer's rule on AI-written applications (`aiPolicy`). */
const AI_WORDS = /\b(ai|artificial intelligence|chat ?gpt|generative|llm)\b/i;
const APPLICATION_WORDS = /\b(application|apply|applying|resume|cv|cover letter|assessment|interview|candidates?)\b/i;
/** A rule's words, so an AI engineer's job ad that mentions candidates is not a policy. */
const POLICY_WORDS =
  /\b(use|using|used|generated|written|assisted|assistance|tools?|policy|prohibit(ed)?|permitted|allowed|forbidden|disclose|disqualif(y|ied|ication))\b/i;

/** Days after which a posting still open is likely a ghost (`ghost:age`). */
export const GHOST_AGE_DAYS = 60;

/**
 * Where a job ad must state its pay, from when
 * (`salary-missing-required`): a dated table, reviewed on
 * `SALARY_LAWS_REVIEWED`. Employer-size thresholds are not applied, so the
 * flag says the law may require pay, not that this employer broke it.
 */
export const SALARY_LAWS_REVIEWED = "2026-10-17";
export const SALARY_LAWS: readonly { readonly country: string; readonly region: string; readonly name: string; readonly since: string }[] =
  [
    { country: "US", region: "CO", name: "Colorado", since: "2021-01-01" },
    { country: "US", region: "CA", name: "California", since: "2023-01-01" },
    { country: "US", region: "WA", name: "Washington", since: "2023-01-01" },
    { country: "US", region: "NY", name: "New York", since: "2023-09-17" },
    { country: "US", region: "HI", name: "Hawaii", since: "2024-01-01" },
    { country: "US", region: "MD", name: "Maryland", since: "2024-10-01" },
    { country: "US", region: "IL", name: "Illinois", since: "2025-01-01" },
    { country: "US", region: "MN", name: "Minnesota", since: "2025-01-01" },
    { country: "US", region: "NJ", name: "New Jersey", since: "2025-06-01" },
    { country: "US", region: "VT", name: "Vermont", since: "2025-07-01" },
    { country: "US", region: "MA", name: "Massachusetts", since: "2025-10-29" },
    { country: "CA", region: "BC", name: "British Columbia", since: "2023-11-01" },
    { country: "CA", region: "ON", name: "Ontario", since: "2026-01-01" },
  ];

/** Pay by the hour, day or week that comes to more than this a year looks like bait (`scam:pay-outlier`; Tavi's threshold). */
export const PAY_OUTLIER_ANNUAL = 300_000;
/** The currencies whose units that threshold is in. */
const PAY_OUTLIER_CURRENCIES = new Set(["USD", "EUR", "GBP", "CHF", "CAD", "AUD"]);

/** Whether a place falls under a pay-transparency law in force on `day`. */
function payLawCovers(place: Place, day: string): boolean {
  const region = (place.region ?? "").trim().toLowerCase();
  if (region === "") return false;
  return SALARY_LAWS.some(
    (law) =>
      law.since <= day &&
      (place.country === undefined || place.country === law.country) &&
      (region === law.region.toLowerCase() || region === law.name.toLowerCase()),
  );
}

/** Whether stated short-period pay annualises past `PAY_OUTLIER_ANNUAL`. */
function payOutlier(salary: Salary): boolean {
  if (!PAY_OUTLIER_CURRENCIES.has(salary.currency) || salary.period === "MONTH" || salary.period === "YEAR") return false;
  const annual = annualise(salary);
  return (annual.min ?? annual.max ?? 0) > PAY_OUTLIER_ANNUAL;
}

export interface FlagInput {
  readonly title: string;
  /** The text a reader sees, hidden text already dropped. */
  readonly description: string;
  /** What the page hid from a reader (`hiddenText`). */
  readonly hiddenText: string;
  readonly postedAt?: string | undefined;
  readonly now: string;
  /** Where the job is and what it pays, for the pay flags. */
  readonly places?: readonly Place[];
  readonly salary?: Salary | undefined;
}

/** Whether `text` holds words written to a model. */
export function looksInjected(text: string): boolean {
  return INJECTION.some((pattern) => pattern.test(text));
}

/** The employer's stated rule on AI in applications, as one sentence, if it states one. */
export function aiPolicyOf(text: string): string | undefined {
  // Sentence by sentence: one pattern spanning both word lists would backtrack over a long description.
  const sentence = text
    .split(/(?<=[.!?])\s+|\n+/)
    .find((each) => AI_WORDS.test(each) && APPLICATION_WORDS.test(each) && POLICY_WORDS.test(each));
  return sentence === undefined ? undefined : sentence.trim().slice(0, 500);
}

const JOB_FLAG_ORDER: readonly JobFlag[] = JOB_FLAGS;

/** A posting's own flags, in `JOB_FLAGS` order, each once: the store adds the ghost flags its history earns. */
export function flagsOf(input: FlagInput): JobFlag[] {
  const flags = new Set<JobFlag>();
  const visible = `${input.title}\n${input.description}`;
  // Only words a reader sees count for a match; a hidden instruction is dropped, and its being there is the flag.
  if (/\p{L}{3,}/u.test(input.hiddenText)) flags.add("hidden-text");
  if (looksInjected(visible)) flags.add("injection-suspect");
  for (const [flag, pattern] of SCAMS) if (pattern.test(visible)) flags.add(flag);
  if (FREE_MAIL.test(visible)) flags.add("scam:free-mail");
  if (input.postedAt !== undefined && Date.parse(input.now) - Date.parse(input.postedAt) > GHOST_AGE_DAYS * 86_400_000)
    flags.add("ghost:age");
  if (input.salary !== undefined && payOutlier(input.salary)) flags.add("scam:pay-outlier");
  const day = (input.postedAt ?? input.now).slice(0, 10);
  if (input.salary === undefined && (input.places ?? []).some((place) => payLawCovers(place, day))) flags.add("salary-missing-required");
  if (aiPolicyOf(input.description) !== undefined) flags.add("ai-policy");
  return JOB_FLAG_ORDER.filter((flag) => flags.has(flag));
}
