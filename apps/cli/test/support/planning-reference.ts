/**
 * Internal design-record references a reader cannot follow: decision ids, plan sections, step and
 * finding ids, planning-doc names. Text a user sees (usage, generated files) must hold none.
 */
const PLANNING_REFERENCE =
  /\bD-\d{3}\b|§|[A-Z0-9]-PLAN\b|PLAN\.md|-EVIDENCE|-RESEARCH|\bSB-D\d+|\bSB\d\.\d|\bMEM\d\.\d|\bO\d\.\d\b|\bUC-\d+|\bF\d{2}\b|\bthe plan requires\b/;

/** The lines of `text` that cite one. */
export function planningReferences(text: string): string[] {
  return text.split("\n").filter((line) => PLANNING_REFERENCE.test(line));
}
