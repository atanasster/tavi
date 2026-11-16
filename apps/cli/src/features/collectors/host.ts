import { registerCollectorTools, registerReportTools, type CollectorToolOptions, type ReportToolOptions } from "@tavi/plugin-collectors";

export { COLLECTORS_PLUGIN_ID } from "@tavi/plugin-collectors";

/**
 * Where the owner puts the daily brief's tools together: `@tavi/plugin-collectors`'
 * collectors and report tools on the owner's registry. This module alone names
 * the package.
 */
export function registerOwnerCollectorTools(
  registry: Parameters<typeof registerCollectorTools>[0],
  collectors: CollectorToolOptions,
  reports: ReportToolOptions,
): void {
  registerCollectorTools(registry, collectors);
  registerReportTools(registry, reports);
}
