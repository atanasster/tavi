import {
  hostTimeZone,
  SCHEDULED_BUDGET_NOTICE_PERCENT,
  scheduledMonthWindow,
  scheduledWorkText,
  type PersistencePort,
} from "@tavi/contracts";

import { scheduledWorkThisMonth } from "./actions.js";

/**
 * Tells each workspace with a `scheduled.monthlyTokenBudget` once a month, in
 * its person's Home, when its scheduled work reaches
 * `SCHEDULED_BUDGET_NOTICE_PERCENT` of it. Nothing is stopped.
 *
 * Summed only for a budgeted workspace not yet told this month, so a workspace
 * without a budget costs one settings read; the notice's key is the workspace's
 * month, so an owner restarted within it does not tell it again.
 */
export function scheduledBudgetNotices(deps: {
  readonly repositories: Pick<PersistencePort["repositories"], "schedules" | "workspaceSettings">;
  readonly workspaceIds: () => readonly string[];
  readonly principalOf: (workspaceId: string) => string | undefined;
  /** `ChatNotices.postAlert`: once per `sourceKey`; false with no Home. */
  readonly postAlert: (input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sourceKey: string;
    readonly title: string;
    readonly summary: string;
  }) => Promise<boolean>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
}): (nowIso: string) => Promise<void> {
  const told = new Set<string>();
  return async (nowIso) => {
    const now = new Date(nowIso);
    for (const workspaceId of deps.workspaceIds()) {
      // One workspace's failure is logged and leaves the others to be checked.
      try {
        const settings = (await deps.repositories.workspaceSettings.get(workspaceId)).settings;
        if (settings.scheduledMonthlyTokenBudget === undefined) continue;
        const key = `${workspaceId}:${scheduledMonthWindow(now, settings.timezone ?? hostTimeZone()).month}`;
        if (told.has(key)) continue;
        const principalId = deps.principalOf(workspaceId);
        if (principalId === undefined) continue;
        const usage = await scheduledWorkThisMonth(deps.repositories, workspaceId, now, settings);
        if (usage.budget === undefined || (usage.percent ?? 0) < SCHEDULED_BUDGET_NOTICE_PERCENT) continue;
        const posted = await deps.postAlert({
          workspaceId,
          principalId,
          sourceKey: `scheduled-budget:${workspaceId}:${usage.month}`,
          title: "Scheduled work",
          summary:
            `Your schedules and routines have used ${scheduledWorkText(usage)} for ${usage.month}. Nothing is stopped. ` +
            "Change the budget with `tavi config set scheduled.monthlyTokenBudget <tokens>`, or give a schedule its own ceiling with `tavi schedules update <name> --max-tokens <n>`.",
        });
        told.add(key);
        if (!posted)
          deps.log("scheduled work reached its monthly budget's notice with no Home to tell", { workspaceId, month: usage.month });
      } catch (error) {
        deps.warn("scheduled work's monthly budget could not be checked", { workspaceId, error });
      }
    }
  };
}
