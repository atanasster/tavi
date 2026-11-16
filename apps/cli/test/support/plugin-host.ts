import type { PluginDefinition } from "@tavi/contracts";
import {
  FetchFactoriesService,
  LoggerService,
  ModelFactoriesService,
  ProviderFactoryRegistry,
  SearchFactoriesService,
} from "@tavi/runtime";

import type { ExternalPluginLog } from "../../src/features/plugins/external.js";

/** A plugin log that drops everything. */
export const silentLog: ExternalPluginLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * The `test.foundation` plugin a test's `PluginHost` starts external plugins on: `log` as the logger service and
 * the empty search, fetch and model factory registries the real composition provides. Pass it first, then the
 * loaded plugins' definitions.
 */
export function foundationPlugin(log: ExternalPluginLog = silentLog): PluginDefinition {
  return {
    id: "test.foundation",
    version: "1.0.0",
    provides: [LoggerService, SearchFactoriesService, FetchFactoriesService, ModelFactoriesService],
    requires: [],
    start: () => ({
      [LoggerService.id]: log,
      [SearchFactoriesService.id]: new ProviderFactoryRegistry(),
      [FetchFactoriesService.id]: new ProviderFactoryRegistry(),
      [ModelFactoriesService.id]: new ProviderFactoryRegistry(),
    }),
  };
}
