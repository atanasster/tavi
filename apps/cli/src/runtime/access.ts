import { AsyncCheckpointSaver } from "@tavi/agent-host/checkpoint";
import { errorMessage } from "@tavi/contracts/util";
import { isLocalConnectionId } from "@tavi/contracts";
import { AccessPolicy, SkillService } from "@tavi/runtime";
import { workspacePrincipals } from "../features/memory/vectors.js";
import type { BrowserContext } from "./browser.js";

/** Skills, the access policy and the people each workspace serves, and the checkpoint saver. */
export async function composeAccess(composed: BrowserContext) {
  const { late, logger, options, persistencePort, store } = composed;
  const skills = new SkillService(persistencePort);
  const access = new AccessPolicy(options.workspaces);
  late.access = access;
  /** The workspaces whose memory the vectors serve: each one's principal and its people. */
  const vectorWorkspaces = () =>
    options.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      principalId: workspace.principalId,
      principalIds: workspacePrincipals(workspace.principalId, access.peopleOf(workspace.workspaceId)),
    }));
  /**
   * The people of each workspace, as Allowed people binds them: each acts with
   * the workspace's grant under a principal of their own. Read at start, before
   * each admission, and after every change made through the owner.
   */
  let peopleRead: Promise<void> = Promise.resolve();
  /** Tells the routine worker of a change in who is allowed: set once routines are first configured. */
  const peopleChanged: { current: () => Promise<void> } = { current: async () => undefined };
  /** The people the routine worker was last configured with, per workspace: what a change is measured against. */
  const workerPeople = new Map<string, string>();
  const peopleKey = (workspaceId: string): string => [...access.peopleOf(workspaceId)].sort().join("\u0000");
  const refreshPeople = (workspaceIds: readonly string[] = options.workspaces.map((grant) => grant.workspaceId)): Promise<void> => {
    // One read at a time, so an older read never lands after a newer one.
    const read = peopleRead
      .catch(() => undefined)
      .then(async () => {
        for (const workspaceId of workspaceIds) {
          const bindings = await persistencePort.repositories.messagingIdentityBindings.list(workspaceId);
          // The app's own connection binds whoever's task it opens, the task's own principal: never a grant of its own.
          access.setPeople(
            workspaceId,
            bindings.filter((binding) => !isLocalConnectionId(binding.connectionId)).map((binding) => binding.principalId),
          );
        }
        // Their routines run with bindings of their own, and stop once they are not allowed. Measured against what the
        // worker last took, so a configuration that failed is tried again on the next read rather than lost; and its
        // failure is logged, never the failure of the read (an allow or revoke that did happen).
        if (options.workspaces.some((grant) => workerPeople.get(grant.workspaceId) !== peopleKey(grant.workspaceId))) {
          await peopleChanged.current().catch((error: unknown) =>
            logger.warn("the routine worker could not take the change in Allowed people; it is tried again on the next change", {
              error: errorMessage(error),
            }),
          );
        }
      });
    peopleRead = read;
    return read;
  };
  await refreshPeople();

  // TAVI_CHECKPOINT_BLOBS=1 stores checkpoints per channel (docs/ASYNC-PERSISTENCE.md); off by default.
  const checkpointSaver = new AsyncCheckpointSaver(store.checkpoints, undefined, {
    channelBlobs: process.env["TAVI_CHECKPOINT_BLOBS"] === "1",
  });
  return { access, checkpointSaver, peopleChanged, peopleKey, refreshPeople, skills, vectorWorkspaces, workerPeople };
}

export type AccessContext = BrowserContext & Awaited<ReturnType<typeof composeAccess>>;
