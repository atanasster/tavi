import { maskSensitive, type ApprovalForm, type ApprovalFormRow, type SourceStatus } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import { GLYPHS } from "../../tui/theme.js";

/**
 * A form fill's values on an approval surface:
 * `full` on the canvas and in the terminal, `masked` in the owner's private
 * chat and on an email link's page, `labels` (no values) in a group, a topic
 * or an email card.
 */
export type FormView = "full" | "masked" | "labels";

/** How a row's status reads: what the gate checked its value against. */
export const FORM_STATUS_TEXT: Readonly<Record<SourceStatus, string>> = {
  verified: `${GLYPHS.done} verified`,
  unmatched: "? not found in its source",
  document: "the form's own words",
  choice: "a choice, not a copy",
};

const LEFT_BLANK_TEXT: Readonly<Record<ApprovalForm["leftBlank"][number]["why"], string>> = {
  signature: "signature",
  "signature-like": "signature",
  attestation: "attestation",
  "required-unfilled": "required, not filled",
};

const sensitiveRow = (row: ApprovalFormRow): boolean => row.sensitive !== undefined && row.sensitive.length > 0;

/** A row's source named without the words quoted from it, its sender note kept: "leo.yaml (sent by member:tg:9)". */
function sourceName(source: string): string {
  const note = /\s\(sent by [^)]*\)$/.exec(source)?.[0] ?? "";
  return `${source.slice(0, source.length - note.length).replace(/:\s[\s\S]*$/, "")}${note}`;
}

/**
 * The form as a channel shows it: each sensitive value masked by its
 * strictest category, and every row's source named without the words quoted
 * from it ("your words", "insurance_card.yaml"): a quote holds the value
 * itself, and a plain row's may hold another's (a line with an ID beside a
 * name).
 */
export function maskedForm(form: ApprovalForm): ApprovalForm {
  return {
    ...form,
    rows: form.rows.map((row) => ({
      ...row,
      ...(sensitiveRow(row) ? { value: maskSensitive(row.value, row.sensitive ?? []) } : {}),
      source: sourceName(row.source),
    })),
  };
}

/**
 * Whether a surface showing the masked view may approve: every row
 * was shown, and every masked one was verified against its source — a person
 * never approves a value they could neither see nor trust the check of.
 */
export function maskedApprovable(form: ApprovalForm): boolean {
  return form.truncated !== true && form.rows.every((row) => !sensitiveRow(row) || row.status === "verified");
}

/**
 * The form as plain lines, grouped by page: the values under `view`, each
 * with its source and status, then what is left for the person and the
 * warnings. `safe` runs over every string from the document or a source
 * (a channel's `disarmUrls`): they are the sender's words and the person's
 * data, never links.
 */
export function formLines(form: ApprovalForm, view: FormView, safe: (text: string) => string = (text) => text): string[] {
  const shown = view === "masked" ? maskedForm(form) : form;
  const lines = [`📄 ${safe(shown.source)} → ${safe(shown.output)}`];
  let page: number | undefined;
  for (const row of shown.rows) {
    if (row.page !== page) {
      page = row.page;
      lines.push(`Page ${page}`);
    }
    const value = view === "labels" ? "" : `: ${safe(row.value)}`;
    const source = view === "labels" ? "" : ` — ${safe(row.source)}`;
    lines.push(
      `${GLYPHS.bullet} ${safe(row.field)}${value}${source} [${FORM_STATUS_TEXT[row.status]}${sensitiveRow(row) ? ", sensitive" : ""}]`,
    );
  }
  if (shown.truncated === true)
    lines.push(
      view === "full"
        ? "…more rows than fit: this fill can only be rejected."
        : "…more rows than fit here: this fill can only be rejected.",
    );
  if (view === "labels") lines.push(`${plural(shown.rows.length, "value")}; the values are shown in Tavi.`);
  if (shown.leftBlank.length > 0)
    lines.push(
      `You sign or complete these yourself: ${shown.leftBlank.map((entry) => `${safe(entry.field)} (${LEFT_BLANK_TEXT[entry.why]})`).join(", ")}`,
    );
  for (const warning of shown.warnings) lines.push(`${GLYPHS.warning} ${safe(warning)}`);
  return lines;
}

/**
 * A message split at line boundaries into parts of at most `max` characters,
 * at most `parts` of them; `undefined` when it does not fit. A single line
 * longer than `max` never fits.
 */
export function splitMessage(text: string, max: number, parts: number): string[] | undefined {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > max) return undefined;
    const next = current === "" ? line : `${current}\n${line}`;
    if (next.length <= max) {
      current = next;
      continue;
    }
    out.push(current);
    current = line;
  }
  if (current !== "") out.push(current);
  return out.length <= parts ? out : undefined;
}
