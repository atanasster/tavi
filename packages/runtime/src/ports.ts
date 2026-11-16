import { createServiceToken } from "@tavi/contracts";
import type {
  AccessPolicyPort,
  ClockPort,
  LoggerPort,
  ModelPort,
  LanguageModelProvider,
  PersistencePort,
  SecretReaderPort,
  ToolRegistryPort,
  WorkflowPort,
} from "@tavi/contracts";

/**
 * Service tokens.
 *
 * Exported from `runtime` (each token is an ordinary object) while the
 * interfaces live in `contracts`, so a plugin can be typed without importing a
 * runtime class. The objects themselves are created in
 * one module and re-exported, so a duplicate Zod/token identity can never be
 * bundled twice.
 */
export const PersistenceService = createServiceToken<PersistencePort>("tavi.persistence");
export const ToolRegistryService = createServiceToken<ToolRegistryPort>("tavi.tools");
export const SecretReaderService = createServiceToken<SecretReaderPort>("tavi.secrets");
export const AccessPolicyService = createServiceToken<AccessPolicyPort>("tavi.access");
export const LoggerService = createServiceToken<LoggerPort>("tavi.logger");
export const ClockService = createServiceToken<ClockPort>("tavi.clock");
export const ModelService = createServiceToken<ModelPort>("tavi.models");
export const WorkflowService = createServiceToken<WorkflowPort>("tavi.workflow");

import type { ProviderFactories } from "@tavi/contracts/plugin-sdk";
import type { WebFetchProvider } from "@tavi/contracts";
import type { WebSearchProvider } from "@tavi/contracts";

export const SearchFactoriesService = createServiceToken<ProviderFactories<WebSearchProvider>>("tavi.providers.search");
export const FetchFactoriesService = createServiceToken<ProviderFactories<WebFetchProvider>>("tavi.providers.fetch");
export const ModelFactoriesService = createServiceToken<ProviderFactories<LanguageModelProvider>>("tavi.providers.model");
