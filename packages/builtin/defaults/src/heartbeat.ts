import { buildHeartbeatPrompt } from "@tavi/plugin-kit/heartbeat";
import type { HeartbeatProvider } from "@tavi/contracts";

/**
 * The built-in heartbeat provider, `tavi.heartbeatagent`: one unattended
 * turn on the `fast` role over the
 * stable-first, fenced prompt. The turn tells the host what is worth saying
 * through `heartbeat.report`, which the host answers and delivers; the
 * provider returns nothing of its own, so prose with no report is quiet.
 */
export function createBuiltinHeartbeatProvider(): HeartbeatProvider {
  return {
    async tick(request) {
      if (request.signal.aborted)
        throw request.signal.reason instanceof Error ? request.signal.reason : new Error("the heartbeat tick was stopped");
      await request.host.runTurn({ prompt: buildHeartbeatPrompt(request), model: "fast" });
      return { items: [] };
    },
    status: () => ({ ready: true }),
  };
}
