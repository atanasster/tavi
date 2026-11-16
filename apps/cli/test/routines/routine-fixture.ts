import { afterEach } from "vitest";
import {
  DatabaseClient,
  RoutineService,
  RoutineExecutionService,
  type RoutineWorkerConfiguration,
  type RoutineExecutionOptions,
} from "@tavi/runtime";
const clients: DatabaseClient[] = [];
const configurations = new WeakMap<DatabaseClient, RoutineWorkerConfiguration>();
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
export async function routineFixture(
  store: DatabaseClient,
  options: { now?: () => string; executionAvailable?: boolean; deliveryAuthorization?: "available" | "unavailable" | "denied" } = {},
): Promise<RoutineService> {
  const client = await DatabaseClient.open({ databasePath: store.databasePath, artifactsDirectory: await store.resolveArtifactPath(".") });
  clients.push(client);
  const config: RoutineWorkerConfiguration = {
    ownerEpoch: "fixture",
    workspaces: [{ workspaceId: "default", principalId: "operator", permissions: [] }],
    toolPermissions: { web_search: [], "http.request": [], web_fetch: [] },
    destinations:
      options.deliveryAuthorization === "available"
        ? [
            { workspaceId: "default", connectionId: "tg", chatId: "123" },
            { workspaceId: "default", connectionId: "tg", chatId: "456" },
            { workspaceId: "default", connectionId: "fixture-telegram", chatId: "123" },
          ]
        : [],
    deliveryAuthorizationAvailable: options.deliveryAuthorization !== undefined && options.deliveryAuthorization !== "unavailable",
    providerConnectionIds: [],
    modelOverride: true,
    executionAvailable: options.executionAvailable ?? false,
    allowedHosts: ["example.com"],
  };
  configurations.set(client, config);
  await client.call("routine.configure", config);
  return new RoutineService(client, options.now === undefined ? {} : { now: options.now });
}
export async function executionFixture(routines: RoutineService, options: RoutineExecutionOptions): Promise<RoutineExecutionService> {
  const config = configurations.get(routines.store);
  if (config === undefined) throw new Error("Routine fixture configuration missing");
  const updated = { ...config, ownerEpoch: options.ownerEpoch };
  configurations.set(routines.store, updated);
  await routines.store.call("routine.configure", updated);
  return new RoutineExecutionService(routines, options);
}
