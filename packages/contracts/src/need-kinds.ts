/**
 * What a task can wait on a person for, named once. Every list of need
 * kinds — the session list's `needs`, the needs
 * queue, the decision history — is this one or the decided subset below.
 *
 * `handoff`: the task waits for a person to act in its browser.
 * `connect`: it waits for an app's account to be signed in again.
 */
export const TASK_NEEDS = ["approval", "review", "question", "handoff", "connect"] as const;
export type TaskNeedKind = (typeof TASK_NEEDS)[number];

/**
 * The kinds a person decides through the needs queue and that decision history
 * records. A browser handoff is not one: it is settled only from the live view
 * or by its deadline, never decided as an item. A connect need is
 * decided by connecting or by *Not now*, and history records which.
 */
export const DECIDED_NEED_KINDS = ["approval", "review", "question", "connect"] as const satisfies readonly TaskNeedKind[];
