import { DEFAULT_WORKSPACE_ID } from "@tavi/contracts";
import { ModelConfigService } from "@tavi/runtime";
import { prefixedId } from "@tavi/node-kit";
import { EXIT, reportRefusal } from "../../cli/exit.js";
import type { CliIo } from "../../cli/io.js";
import { emitJson } from "../../cli/output.js";
import { CONFIG_TIMEOUT_MS, configOnOwner } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStore } from "../../cli/store.js";
import type { ModelsCommandOptions } from "./parse.js";
import {
  RESOLVER_KEY_HINT,
  machineLimits,
  resolverKeyOf,
  suggestModels,
  type SuggestConnection,
  type SuggestDependencies,
} from "./resolver-suggest.js";

/**
 * `tavi models suggest`: the model resolver's suggestions for this machine and
 * these connections, printed and never applied. With no `RHUMB_KEY` it
 * prints a hint and touches nothing, not even the data directory.
 */
export async function modelsSuggestCommand(
  options: ResolvedDataDirectory<ModelsCommandOptions>,
  io: CliIo,
  deps: SuggestDependencies = {},
): Promise<number> {
  if (resolverKeyOf(deps.env ?? process.env) === undefined) {
    io.stderr(`${RESOLVER_KEY_HINT}\n`);
    return EXIT.ok;
  }
  const machine = deps.machine ?? machineLimits(options.dataDirectory);
  const print = async (connections: readonly SuggestConnection[]): Promise<number> => {
    emitJson(io, await suggestModels(connections, machine, deps));
    return EXIT.ok;
  };
  try {
    // Under a live owner the connections are read from it: `list`, then `show` for each one's catalog.
    const onOwner = await configOnOwner(options.dataDirectory, "models", io, {
      label: "tavi models suggest",
      mutates: false,
      build: () => ({ action: "list", workspaceId: DEFAULT_WORKSPACE_ID }),
      render: async (result, client) => {
        const summaries = result as readonly {
          readonly connectionId: string;
          readonly baseUrl: string;
          readonly defaultModel: string | null;
        }[];
        const connections = await Promise.all(
          summaries.map(async (summary): Promise<SuggestConnection> => {
            const shown = await client.request(
              "models",
              { action: "show", workspaceId: DEFAULT_WORKSPACE_ID, connectionId: summary.connectionId },
              prefixedId("models"),
              {
                timeoutMs: CONFIG_TIMEOUT_MS,
              },
            );
            // An unread catalog is said, not hidden: only the connection's default model is then asked about.
            if (!shown.ok)
              io.stderr(`note: could not read the catalog of ${summary.connectionId}; only its default model is asked about\n`);
            const catalog = shown.ok
              ? ((shown.result as { readonly catalog?: readonly { readonly modelId: string }[] }).catalog ?? [])
              : [];
            return suggestConnectionOf(summary, catalog);
          }),
        );
        return print(connections);
      },
    });
    if (onOwner !== undefined) return onOwner;
    const connections = await withStore(options.dataDirectory, async (store) => {
      const service = new ModelConfigService(store.asPort());
      return Promise.all(
        (await service.listConnections()).map(async (connection) =>
          suggestConnectionOf(
            { ...connection, defaultModel: connection.defaultModel ?? null },
            await service.listCatalog(connection.connectionId),
          ),
        ),
      );
    });
    return await print(connections);
  } catch (error) {
    return reportRefusal(error, io, "models suggest failed", { usage: ["INVALID_INPUT"], unavailable: ["NOT_FOUND"] });
  }
}

function suggestConnectionOf(
  connection: { readonly connectionId: string; readonly baseUrl: string; readonly defaultModel: string | null },
  catalog: readonly { readonly modelId: string }[],
): SuggestConnection {
  return {
    connectionId: connection.connectionId,
    baseUrl: connection.baseUrl,
    models: [...(connection.defaultModel === null ? [] : [connection.defaultModel]), ...catalog.map((entry) => entry.modelId)],
  };
}
