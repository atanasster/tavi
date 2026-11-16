import { TaviError } from "@tavi/contracts";
import { PluginRegistry } from "../plugins/registry.js";
import type { PersistencePort } from "./internal-contracts.js";
import type { PluginRegistryOperations } from "./plugin-registry-protocol.js";

export function dispatchPluginRegistry(port: PersistencePort, operation: string, input: unknown): unknown {
  const payload = input as PluginRegistryOperations[keyof PluginRegistryOperations]["input"];
  const configuration = payload.configuration;
  const registry = new PluginRegistry({
    repository: port.repositories.plugins,
    mcp: port.repositories.mcp,
    directory: configuration.directory,
    builtins: configuration.builtins,
    now: () => configuration.timestamp,
  });
  switch (operation) {
    case "pluginRegistry.install":
      return registry.install(...(input as PluginRegistryOperations["pluginRegistry.install"]["input"]).args);
    case "pluginRegistry.decide":
      return registry.decide(...(input as PluginRegistryOperations["pluginRegistry.decide"]["input"]).args);
    case "pluginRegistry.enable":
      return registry.enable(...(input as PluginRegistryOperations["pluginRegistry.enable"]["input"]).args);
    case "pluginRegistry.disable":
      return registry.disable(...(input as PluginRegistryOperations["pluginRegistry.disable"]["input"]).args);
    case "pluginRegistry.configure":
      return registry.configure(...(input as PluginRegistryOperations["pluginRegistry.configure"]["input"]).args);
    case "pluginRegistry.remove":
      return registry.remove(...(input as PluginRegistryOperations["pluginRegistry.remove"]["input"]).args);
    case "pluginRegistry.disabledBuiltins":
      return registry.disabledBuiltins(...(input as PluginRegistryOperations["pluginRegistry.disabledBuiltins"]["input"]).args);
    case "pluginRegistry.resolveEnabled":
      return registry.resolveEnabled(...(input as PluginRegistryOperations["pluginRegistry.resolveEnabled"]["input"]).args);
    case "pluginRegistry.verifyMcp":
      return registry.verifyMcp(...(input as PluginRegistryOperations["pluginRegistry.verifyMcp"]["input"]).args);
    case "pluginRegistry.commitMcpStaged":
      return registry.commitMcpStaged(...(input as PluginRegistryOperations["pluginRegistry.commitMcpStaged"]["input"]).args);
    case "pluginRegistry.mcpTreeState":
      return registry.mcpTreeState(...(input as PluginRegistryOperations["pluginRegistry.mcpTreeState"]["input"]).args);
    case "pluginRegistry.list":
      return registry.list();
    default:
      throw new TaviError("INVALID_INPUT", "Unknown plugin registry operation");
  }
}
