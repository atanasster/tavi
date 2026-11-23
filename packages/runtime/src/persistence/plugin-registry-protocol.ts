import type { Locale } from "@tavi/contracts/i18n";
import type { PluginRegistry, PluginRegistryOptions } from "../plugins/registry.js";

export type PluginRegistryConfiguration = Omit<PluginRegistryOptions, "repository" | "now"> & { readonly timestamp: string };
type Methods =
  | "install"
  | "decide"
  | "enable"
  | "disable"
  | "configure"
  | "remove"
  | "disabledBuiltins"
  | "resolveEnabled"
  | "verifyMcp"
  | "commitMcpStaged"
  | "mcpTreeState";
export type PluginRegistryOperations = {
  [K in Methods as `pluginRegistry.${K}`]: {
    input: { readonly configuration: PluginRegistryConfiguration; readonly args: Parameters<PluginRegistry[K]> };
    output: ReturnType<PluginRegistry[K]>;
  };
} & {
  "pluginRegistry.list": {
    input: { readonly configuration: PluginRegistryConfiguration; readonly locale?: Locale };
    output: ReturnType<PluginRegistry["list"]>;
  };
};
