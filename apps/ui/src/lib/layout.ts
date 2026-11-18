/**
 * The layout's numbers the script computes with: panel widths, popover
 * spacing, gesture thresholds and caps on computed sizes. Each is a constant
 * rather than a computed custom property read at run time, because most are
 * read where no stylesheet is applied yet (a module-level panel's bounds, the
 * first layout effect) and the test DOM computes no custom properties, so a
 * run-time read would only ever take its fallback there. Where a number is a
 * spacing token in `styles/tokens.css`, `test/lib/layout.test.ts` holds it to
 * that token instead.
 */

/** The sessions sidebar's width before the reader resizes it, in CSS px. */
export const DEFAULT_SIDEBAR_WIDTH = 272;
/** The narrowest the reader can drag the sessions sidebar, in CSS px. */
export const MIN_SIDEBAR_WIDTH = 180;
/** The widest the reader can drag the sessions sidebar, in CSS px. */
export const MAX_SIDEBAR_WIDTH = 560;
/** What the window keeps beside the sessions sidebar as it is dragged, in CSS px. */
export const SIDEBAR_RESERVE_WIDTH = 300;

/** The chat panel's width before the reader resizes it, in CSS px. */
export const DEFAULT_CHAT_PANEL_WIDTH = 340;
/** The narrowest the reader can drag the chat panel, in CSS px. */
export const MIN_CHAT_PANEL_WIDTH = 280;
/** The widest the reader can drag the chat panel, in CSS px. */
export const MAX_CHAT_PANEL_WIDTH = 640;
/** Dragged narrower than this, the chat panel collapses to its rail, in CSS px. */
export const CHAT_PANEL_SNAP_COLLAPSE_WIDTH = 200;
/** What the transcript keeps beside the chat panel, in CSS px. */
export const TRANSCRIPT_MIN_WIDTH = 480;

/**
 * The phone sheet's heights, in percent of the page's: the lowest a drag can
 * leave it at (dragged lower, it closes), where it opens and where a tap
 * moves it, the highest, and how far one arrow key moves it. From
 * `SHEET.fullFrom` up it counts as full height.
 */
export const SHEET = { min: 25, half: 45, full: 90, fullFrom: 60, step: 10 } as const;

/** The keyboard's step on the chat panel's top slot's height handle, in CSS px. */
export const TOP_SLOT_HEIGHT_STEP = 16;

/** How far (CSS px) a finger moves on a taken-over browser before a tap becomes a scroll. */
export const TOUCH_SLOP_PX = 8;

/** A popover's gap from its anchor, and from the window's foot when clamped; `--space-2`. */
export const POPOVER_GAP_PX = 8;
/** The least room a popover keeps from the window's left and right edges by default; `--space-2`. */
export const POPOVER_EDGE_PX = 8;
/** The model picker's room from the window's edges, wider for its long rows; `--space-3`. */
export const MODEL_PICKER_EDGE_PX = 12;
/** The room a popover needs beyond its own height to fit on a side (its gap and as much again); `--space-4`. */
export const POPOVER_FIT_PX = 16;

/** The shortest bar in the Activity strip, as a percentage of its column, so a day with any task shows. */
export const ACTIVITY_BAR_MIN_PERCENT = 4;

/** The deepest indent, in `em`, a worker row in the agent tree takes. */
export const AGENT_TREE_MAX_INDENT_EM = 8;
