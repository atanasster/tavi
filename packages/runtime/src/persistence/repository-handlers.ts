import type { AdmitRequest, PersistencePort } from "./internal-contracts.js";
import { TaviError, type ArtifactRecord, type AsyncPersistenceRepositories, type SerializableAdmitRequest } from "@tavi/contracts";
import { REPOSITORY_METHODS } from "./repository-protocol.js";
import { rpcHandlers } from "./rpc.js";
import { selectWorkerPrompt } from "./prompt-selection.js";
import { workerClock } from "./worker-clock.js";

/** An admission's request as the worker's repository takes it: its ids and clock as functions, its prompt selected here. */
const admitRequest = (repositories: PersistencePort["repositories"], request: SerializableAdmitRequest): AdmitRequest => ({
  ...request,
  newTaskId: () => request.newTaskId,
  newAdmissionId: () => request.newAdmissionId,
  newThreadId: () => request.newThreadId,
  now: () => request.now,
  initializeSnapshot: (task) =>
    selectWorkerPrompt(
      task,
      request.prompt,
      request.now,
      request.prompt.explicitPrompt === undefined ? repositories.systemPrompts.get(task.workspaceId) : undefined,
    ),
});

/** Serves a repository operation against the worker's synchronous repositories, inside the caller's transaction. */
export const dispatchRepository = rpcHandlers<"repository", AsyncPersistenceRepositories, PersistencePort["repositories"]>(
  "repository",
  REPOSITORY_METHODS,
  {
    "repository.tasks.admit": (repositories, args) => repositories.tasks.admit(admitRequest(repositories, args[0])),
    "repository.tasks.openHome": (repositories, args) => repositories.tasks.openHome(admitRequest(repositories, args[0])),
    "repository.executions.acquire": (repositories, args) => repositories.executions.acquire({ ...args[0], now: workerClock(args[0].now) }),
    "repository.executions.heartbeat": (repositories, args) =>
      repositories.executions.heartbeat({ ...args[0], now: workerClock(args[0].now) }),
    "repository.executions.release": (repositories, args) => repositories.executions.release({ ...args[0], now: workerClock(args[0].now) }),
    "repository.executions.terminate": (repositories, args) =>
      repositories.executions.terminate({ ...args[0], now: workerClock(args[0].now) }),
    "repository.effects.begin": (repositories, args) => repositories.effects.begin({ ...args[0], now: workerClock(args[0].now) }),
    "repository.effects.resolve": (repositories, args) => repositories.effects.resolve({ ...args[0], now: workerClock(args[0].now) }),
    "repository.approvals.request": (repositories, args) => repositories.approvals.request({ ...args[0], now: workerClock(args[0].now) }),
    "repository.approvals.decide": (repositories, args) => repositories.approvals.decide({ ...args[0], now: workerClock(args[0].now) }),
    "repository.approvals.cancelPendingForTask": (repositories, args) =>
      repositories.approvals.cancelPendingForTask(args[0], workerClock(args[1])),
    "repository.cancellations.request": (repositories, args) =>
      repositories.cancellations.request({ ...args[0], now: workerClock(args[0].now) }),
    "repository.receipts.record": (repositories, args) => repositories.receipts.record({ ...args[0], now: workerClock(args[0].now) }),
    "repository.artifacts.claimUploadForRun": (repositories, args) => repositories.artifacts.claimUploadForRun?.(...args),
    "repository.artifacts.putStagedArtifact": (repositories, args) => {
      const put = repositories.artifacts.putStagedArtifact;
      if (put === undefined) throw new TaviError("UNSUPPORTED", "This store takes no staged artifacts");
      // The worker's store is the SQLite one, whose put is synchronous.
      return put.call(repositories.artifacts, ...args) as ArtifactRecord;
    },
    "repository.messagingInbox.record": (repositories, args) =>
      repositories.messagingInbox.record({ ...args[0], now: workerClock(args[0].now) }),
    "repository.messagingOutbox.begin": (repositories, args) =>
      repositories.messagingOutbox.begin({ ...args[0], now: workerClock(args[0].now) }),
    "repository.messagingOutbox.resolve": (repositories, args) =>
      repositories.messagingOutbox.resolve({ ...args[0], now: workerClock(args[0].now) }),
  },
  { tuple: "Repository arguments must be a tuple", unknown: "Unknown repository operation" },
);
