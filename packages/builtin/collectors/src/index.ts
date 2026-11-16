/**
 * `@tavi/plugin-collectors` (`tavi.collectors`): the daily brief's
 * deterministic collectors and its report tools, on contracts and the node
 * kit alone. The owner names it in `apps/cli/src/features/collectors/host.ts`.
 */

/** The built-in plugin these tools are: `tavi plugins disable tavi.collectors` leaves them out of composition. */
export const COLLECTORS_PLUGIN_ID = "tavi.collectors";

export {
  collectDaily,
  loadProjects,
  MAX_TOOL_RESULT_BYTES,
  registerCollectorTools,
  type CollectorToolOptions,
  type DailyBrief,
  type ProjectsFile,
} from "./collectors.js";
export { registerReportTools, renderBriefHtml, type ReportToolOptions } from "./reports.js";
