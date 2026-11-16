import { z } from "zod";

import { SensitiveSchema, SourceStatusSchema } from "./pdf.js";
import { displaySafe, hasHiddenCharacters } from "./terminal-text.js";
import { clip } from "./util.js";

/**
 * What a person is shown about one tool call before deciding it: the card's
 * text and a form fill's rows, and the bounds every surface clips them to.
 * The card's text is marked for hidden characters before it is clipped.
 */

/**
 * One value a form fill would write, as the card shows it: the field (its
 * label, else its id — the
 * document's words), the value as written (booleans as ☑/☐), where it came
 * from, and that source's status as the gate checked it.
 */
export const ApprovalFormRowSchema = z.strictObject({
  page: z.number().int().min(1),
  field: z.string().max(120),
  value: z.string().max(200),
  source: z.string().max(160),
  status: SourceStatusSchema,
  /** The sensitive categories of the field, by which a channel masks the value. */
  sensitive: z.array(SensitiveSchema).max(6).optional(),
  /** The handler's read-back, on the result card only. */
  readBack: z.boolean().optional(),
});
export type ApprovalFormRow = z.infer<typeof ApprovalFormRowSchema>;

export const ApprovalFormSchema = z.strictObject({
  /** The form being filled: "registration-2026.pdf (art-in-…), 10 pages". */
  source: z.string().max(200),
  /** Where the filled copy goes: "forms/registration-2026-filled.pdf". */
  output: z.string().max(300),
  rows: z.array(ApprovalFormRowSchema).max(512),
  /** The rows did not fit the card's budget: every surface offers Reject only. */
  truncated: z.literal(true).optional(),
  leftBlank: z
    .array(z.strictObject({ field: z.string().max(120), why: z.enum(["signature", "signature-like", "attestation", "required-unfilled"]) }))
    .max(256),
  warnings: z.array(z.string().max(200)).max(8),
});
export type ApprovalForm = z.infer<typeof ApprovalFormSchema>;

/**
 * The most characters a form's rows and left-blank list take on a card: 512
 * rows of four 200-character strings would be ~400 KB, against the 1 MiB IPC
 * frame that carries the round with everything else. Rows past it are cut,
 * and the form is `truncated`.
 */
export const APPROVAL_FORM_BUDGET = 48_000;

/** What a person is shown about one call: the parts a decision is made on. */
export const ApprovalDisplaySchema = z.strictObject({
  title: z.string().min(1).max(300),
  detail: z.string().max(2_000).optional(),
  command: z.string().max(4_000).optional(),
  /** What the call gives the program on standard input, as much as a card shows (a script run that way is the command). */
  stdin: z.string().max(2_100).optional(),
  /** What approving for the rest of the chat covers, when that is more than this call (`git diff *`). */
  forThisChat: z.string().max(600).optional(),
  host: z.string().max(300).optional(),
  destination: z.string().max(300).optional(),
  /** A form fill's values, row by row. */
  form: ApprovalFormSchema.optional(),
  /** The tool deletes or overwrites what cannot be had back (`ToolAnnotations.destructive`): the card says so. */
  destructive: z.literal(true).optional(),
});
export type ApprovalDisplay = z.infer<typeof ApprovalDisplaySchema>;

/** A card's title as a line of text says it: the display's (else `summary`), and that it cannot be undone when so. */
export function approvalTitleOf(request: {
  readonly display?: Pick<ApprovalDisplay, "title" | "destructive"> | undefined;
  readonly summary: string;
}): string {
  return `${request.display?.title ?? request.summary}${request.display?.destructive === true ? " (cannot be undone)" : ""}`;
}

/** At most `limit` UTF-16 units, the cut marked with `…` and never splitting a surrogate pair. */
export function clipText(text: string, limit: number): string {
  return clip(text, limit);
}

/** Card text: its hidden characters marked (`displaySafe`), then clipped, so the marks count against the bound. */
export function cardText(text: string, limit: number): string {
  return clip(displaySafe(text), limit);
}

/** An assessor's display within `ApprovalDisplaySchema`'s bounds; a missing or empty title names the tool. */
export function clipDisplay(display: ApprovalDisplay | undefined, toolId: string): ApprovalDisplay {
  const title = display === undefined || display.title === "" ? `Run ${toolId}` : display.title;
  return {
    title: cardText(title, 300),
    ...(display?.detail === undefined ? {} : { detail: cardText(display.detail, 2_000) }),
    ...(display?.command === undefined ? {} : { command: cardText(display.command, 4_000) }),
    ...(display?.stdin === undefined ? {} : { stdin: cardText(display.stdin, 2_100) }),
    ...(display?.forThisChat === undefined ? {} : { forThisChat: cardText(display.forThisChat, 600) }),
    ...(display?.host === undefined ? {} : { host: cardText(display.host, 300) }),
    ...(display?.destination === undefined ? {} : { destination: cardText(display.destination, 300) }),
    ...(display?.form === undefined ? {} : { form: clipForm(display.form) }),
    ...(display?.destructive === true ? { destructive: true as const } : {}),
  };
}

/** Whether a card's text, as the assessor wrote it, holds a character `displaySafe` marks. */
export function displayHides(display: ApprovalDisplay | undefined, reasons: readonly string[]): boolean {
  if (display === undefined) return reasons.some(hasHiddenCharacters);
  const form = display.form;
  const texts = [
    display.title,
    display.detail,
    display.command,
    display.stdin,
    display.forThisChat,
    display.host,
    display.destination,
    ...(form === undefined
      ? []
      : [
          form.source,
          form.output,
          ...form.rows.flatMap((row) => [row.field, row.value, row.source]),
          ...form.leftBlank.map((entry) => entry.field),
          ...form.warnings,
        ]),
    ...reasons,
  ];
  return texts.some((text) => text !== undefined && hasHiddenCharacters(text));
}

/**
 * A form part within its schema's bounds and `APPROVAL_FORM_BUDGET`: each
 * string clipped, then rows (and the left-blank list) kept in order while
 * they fit. A form that lost any row is `truncated`, which every surface
 * reads as Reject-only: a person never approves values they were not shown.
 */
export function clipForm(form: ApprovalForm): ApprovalForm {
  let budget = APPROVAL_FORM_BUDGET;
  const rows: ApprovalFormRow[] = [];
  let truncated = form.truncated === true || form.rows.length > 512;
  for (const row of form.rows.slice(0, 512)) {
    const clipped: ApprovalFormRow = {
      ...row,
      field: cardText(row.field, 120),
      value: cardText(row.value, 200),
      source: cardText(row.source, 160),
      ...(row.sensitive === undefined ? {} : { sensitive: row.sensitive.slice(0, 6) }),
    };
    const cost = clipped.field.length + clipped.value.length + clipped.source.length + 16;
    if (cost > budget) {
      truncated = true;
      break;
    }
    budget -= cost;
    rows.push(clipped);
  }
  const leftBlank: ApprovalForm["leftBlank"][number][] = [];
  if (form.leftBlank.length > 256) truncated = true;
  for (const entry of form.leftBlank.slice(0, 256)) {
    const field = cardText(entry.field, 120);
    // A field left for the person to sign or complete is part of what they approve: one that does not fit truncates.
    if (field.length + 8 > budget) {
      truncated = true;
      break;
    }
    budget -= field.length + 8;
    leftBlank.push({ field, why: entry.why });
  }
  return {
    source: cardText(form.source, 200),
    output: cardText(form.output, 300),
    rows,
    ...(truncated ? { truncated: true as const } : {}),
    leftBlank,
    warnings: form.warnings.slice(0, 8).map((warning) => cardText(warning, 200)),
  };
}
