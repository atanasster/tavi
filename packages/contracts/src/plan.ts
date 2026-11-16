import { z } from "zod";

/**
 * `plan.update`: the whole plan, every time. Declared here so the tool,
 * the terminal chat and the canvas read one shape.
 *
 * The card is drawn from the tool call's event `input`, which
 * `boundEventPayload` replaces with a truncated preview once its JSON passes
 * `MAX_EVENT_PAYLOAD_BYTES` (8 KiB, UTF-8). The bounds keep the worst case
 * under that: a character JSON escapes as `\u0000` costs six bytes, so
 * 12 × (100 × 6 + the item's ~40 bytes of keys and status) + the wrapper is
 * about 7.7 KB. At the earlier 20 × 200 a plan in any non-Latin script became
 * a preview and the card disappeared.
 */
export const PLAN_TOOL_ID = "plan.update";
export const PLAN_STATUSES = ["pending", "in_progress", "done"] as const;
export const PLAN_MAX_ITEMS = 12;
export const PLAN_MAX_ITEM_CHARS = 100;
export const PlanUpdateInputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        content: z.string().min(1).max(PLAN_MAX_ITEM_CHARS).describe("One step, as the person will read it"),
        status: z.enum(PLAN_STATUSES).describe("pending, in_progress (at most one), or done"),
      }),
    )
    .min(1)
    .max(PLAN_MAX_ITEMS)
    .describe("The whole plan, every time: this replaces the previous one"),
});
export type PlanItem = z.infer<typeof PlanUpdateInputSchema>["items"][number];

/** A `plan.update` input's items; `undefined` for input that is not a plan. */
export function planItems(input: unknown): readonly PlanItem[] | undefined {
  const parsed = PlanUpdateInputSchema.safeParse(input);
  return parsed.success ? parsed.data.items : undefined;
}

/** The mark a plan item is listed with, wherever a plan is drawn. */
export const PLAN_MARKS: Readonly<Record<PlanItem["status"], string>> = { done: "☑", in_progress: "◐", pending: "☐" };

/** A plan's items as a card lists them: `☑ done`, `◐ in progress`, `☐ pending`; `undefined` for input that is not a plan. */
export function planLines(input: unknown): readonly string[] | undefined {
  return planItems(input)?.map((item) => `${PLAN_MARKS[item.status]} ${item.content}`);
}
