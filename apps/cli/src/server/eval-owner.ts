/**
 * What `serve --eval` turns off: nothing reaches anyone but the model — no
 * reminder, heartbeat, schedule, memory tick or channel — and no model call is
 * made that the eval did not ask for: a finished task gets no generated
 * summary, whatever the workspace's `activitySummaries` says, so the spend an
 * eval measures is its turns' and its memory jobs' alone.
 */
export const EVAL_OWNER_OFF = {
  reminderSweepEnabled: false,
  heartbeatEnabled: false,
  scheduleSweepEnabled: false,
  scheduleWatchersEnabled: false,
  memoryTickEnabled: false,
  openSavedChannels: false,
  taskSummariesEnabled: false,
} as const;
