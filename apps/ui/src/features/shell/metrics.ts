/** Token totals and actual model identities now arrive as optional metrics on
 * terminal events. They describe the latest execution, not all historical turns.
 * Unknown provider usage stays explicitly partial; old records are not estimated.
 * The global strip remains elapsed · tool calls · running model.
 */

/** A figure the canvas could show, and whether anything can answer it today. */
export interface Measurable {
  readonly name: string;
  /** Where the number comes from, or why there is none. */
  readonly source: string;
}

/** The name of each figure the strip shows, in the order it shows them. */
export type MeasuredName = "elapsed" | "tool calls" | "Model";

/**
 * The figures measured in the global strip. The chat panel's Details tab shows provider usage.
 */
export const MEASURED: readonly (Measurable & { readonly name: MeasuredName })[] = [
  {
    name: "elapsed",
    source:
      "working time on the owner's own `at` stamps: the gaps between a chat's events while it ran, or its executions' summed spans; waits on a person and time between turns are not in it",
  },
  { name: "tool calls", source: "the transcript's tool cards, folded out of the render window or not" },
  { name: "Model", source: "`models roles`' active owner target (saved default on older owners)" },
];

/**
 * The figures the canvas does **not** show, each with the reason. Kept as data
 * so the rule can be asserted rather than trusted: a test checks that nothing
 * here is rendered, and the list is what a later step edits when it builds a
 * source.
 */
export const UNMEASURED: readonly Measurable[] = [
  { name: "cost", source: "no price table exists; a provider's usage carries none" },
  { name: "context %", source: "the model contract carries no context-window figure, and discovery does not answer one" },
  { name: "tok/s", source: "generation-only duration is not recorded; elapsed includes tools and waiting" },
];
