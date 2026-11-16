import type { AsyncPersistenceRepositories } from "@tavi/contracts";
import type { DatabaseClient } from "./client.js";
import type { DatabaseOperations } from "./protocol.js";
import { REPOSITORY_METHODS, type RepositoryOperations } from "./repository-protocol.js";
import { rpcClient } from "./rpc.js";

/** Every repository method as a worker request; artifact stores pass the client's write check first. */
export function createAsyncRepositories(client: DatabaseClient): AsyncPersistenceRepositories {
  const repositories = rpcClient<AsyncPersistenceRepositories>("repository", REPOSITORY_METHODS, (operation, args) =>
    client.call(operation as keyof RepositoryOperations, args as DatabaseOperations[keyof RepositoryOperations]["input"]),
  );
  return {
    ...repositories,
    artifacts: {
      ...repositories.artifacts,
      putArtifact: (...args) => client.putArtifact(...args),
      putStagedArtifact: (...args) => client.putStagedArtifact(...args),
    },
    approvalLinks: {
      ...repositories.approvalLinks,
      release: (...args) => client.call("repository.approvalLinks.release", args, { control: true }),
    },
  };
}
