/**
 * A task's recorded state, as an attached front end reads it: shared with the
 * web canvas, so it lives in `@tavi/client` (`records.ts`) and is re-exported
 * here for the CLI's own modules.
 */
export {
  conversationOfRecorded,
  endingOfOutcome,
  recordedStateOf,
  taintOfRecorded,
  type Ending,
  type RecordedState,
  type RecordedTask,
} from "@tavi/client";
