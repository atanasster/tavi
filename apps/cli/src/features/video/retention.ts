import { videoKeepDays, type WorkspaceSettings } from "@tavi/contracts";

/**
 * Raw video's retention sweep: each workspace's videos taken from outside, past its
 * `video.keepDays`, pruned with their bodies. It runs with the owner's
 * retention sweep whatever `retentionSweepArtifacts` says: "kept 30 days" must
 * not mean forever. One workspace's failure never skips the rest.
 */
export async function sweepVideoRetention(deps: {
  readonly workspaceIds: readonly string[];
  readonly settingsOf: (workspaceId: string) => Promise<WorkspaceSettings>;
  readonly pruneVideo: (input: {
    readonly workspaceId: string;
    readonly olderThan: string;
  }) => Promise<{ readonly artifacts: number; readonly bytes: number }>;
  readonly now: () => string;
  readonly log: {
    info(message: string, fields: Record<string, unknown>): void;
    error(message: string, fields: Record<string, unknown>): void;
  };
}): Promise<void> {
  for (const workspaceId of deps.workspaceIds) {
    try {
      const days = videoKeepDays(await deps.settingsOf(workspaceId));
      const olderThan = new Date(Date.parse(deps.now()) - days * 24 * 60 * 60 * 1000).toISOString();
      const pruned = await deps.pruneVideo({ workspaceId, olderThan });
      if (pruned.artifacts > 0) deps.log.info("video retention sweep", { workspaceId, ...pruned, olderThan });
    } catch (error) {
      deps.log.error("video retention sweep failed", { workspaceId, error });
    }
  }
}
