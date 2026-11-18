/**
 * The figures a chat shows, and the ones it does not. Each reply's footer says
 * its own working time, the model that answered and its tool calls; the chat
 * panel's Details tab shows provider usage (token totals), which arrives as
 * optional metrics on terminal events. Unknown usage stays explicitly partial;
 * old records are not estimated.
 */

/** A figure the canvas could show, and whether anything can answer it today. */
export interface Measurable {
  readonly name: string;
  /** Where the number comes from, or why there is none. */
  readonly source: string;
}

/** The figures a reply's footer shows (`replyFacts`), in the order it shows them. */
export const MEASURED: readonly Measurable[] = [
  {
    name: "time",
    source:
      "the turn's working time on the owner's own `at` stamps: the gaps between its events while it ran, or its executions' summed spans; waits on a person are not in it",
  },
  {
    name: "model",
    source: "the models the turn's execution reported, else those its tool calls name, else the chat's when it used one model only",
  },
  { name: "tool calls", source: "the turn's tool cards, shown only when there were some" },
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
