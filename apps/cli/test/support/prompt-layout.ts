import type { PersistencePort, WorkspaceSettings } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";

/**
 * A workspace on the `v1` prompt layout: for a test that asserts what `v1`
 * sends (memory and the context in the system text, every tool listed), now
 * that `v2` is the default.
 */
export async function pinPromptLayoutV1(
  repositories: Pick<PersistencePort["repositories"], "workspaceSettings">,
  workspaceId = "default",
): Promise<void> {
  await pinSettings(repositories, workspaceId, { promptLayout: "v1" });
}

/**
 * A workspace whose attended chats list every built-in (`models.toolDeferral`
 * `off`): for a test where `tools.search` in the list means a routed turn.
 */
export async function pinToolDeferralOff(
  repositories: Pick<PersistencePort["repositories"], "workspaceSettings">,
  workspaceId = "default",
): Promise<void> {
  await pinSettings(repositories, workspaceId, { toolDeferral: "off" });
}

async function pinSettings(
  repositories: Pick<PersistencePort["repositories"], "workspaceSettings">,
  workspaceId: string,
  settings: Partial<WorkspaceSettings>,
): Promise<void> {
  const current = await repositories.workspaceSettings.get(workspaceId);
  await repositories.workspaceSettings.set({
    workspaceId,
    settings: { ...current.settings, ...settings },
    expectedRevision: current.revision,
    actor: "operator",
    now: nowTimestamp(),
  });
}
