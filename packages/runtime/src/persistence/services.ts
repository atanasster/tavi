import type { PersistenceServiceOptions, PersistenceServicesPort } from "@tavi/contracts";
import type { DatabaseClient } from "./client.js";
import { SERVICE_METHODS, type ServiceOperations } from "./service-protocol.js";
import { rpcClient } from "./rpc.js";

/** Every persistence service method as a worker request, carrying the options `options` captures for it. */
export function createAsyncServices(
  client: DatabaseClient,
  options?: (args: readonly unknown[], operation: string) => PersistenceServiceOptions,
): PersistenceServicesPort {
  return rpcClient<PersistenceServicesPort>("service", SERVICE_METHODS, (operation, args) =>
    client.call(
      operation as keyof ServiceOperations,
      args as ServiceOperations[keyof ServiceOperations]["input"],
      undefined,
      options?.(args, operation),
    ),
  );
}
