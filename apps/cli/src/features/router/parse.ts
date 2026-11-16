import { RouterFeatureSchema, RouterModeSchema } from "@tavi/contracts";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

export interface RouterCommandOptions {
  readonly action: "status" | "configure" | "set-mode" | "set-provider" | "explain" | "evaluate";
  readonly dataDirectory?: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly file?: string;
  readonly taskId?: string;
  readonly providerId?: string;
  readonly feature?: "model" | "memory" | "tools" | "skills";
  readonly mode?: "off" | "shadow" | "active";
  readonly expectedRevision?: number;
}
export const ROUTER_USAGE = `tavi router <action> [options]
  status                         Show modes, budgets, key presence and price readiness
  configure --file <json>         Replace settings and optionally install dated priceSheets
  set-mode <feature> <mode>       Set model/memory/tools/skills to off/shadow/active
  set-provider <plugin-id>        Select the routing provider (default tavi.router, the Jev provider)
  explain <task-id>               Show saved route, decisions, exposure and incomplete costs
  evaluate [--file <json>]        Analyze recorded paired evidence; no live provider calls

Options: --data-dir <path> --workspace <id> --principal <id>
Writes require --revision <current-revision> from status. Output is JSON.
Configuration JSON: { "settings": { ... }, "priceSheets": [ ... ] }. Jev's endpoint, model
and credentialRef go under settings.providerSettings["tavi.router"]; top-level ones are still read.
Secrets use tavi credentials; configuration accepts credential references only.
Global disable: configure with settings.enabled=false. Saved task routes remain.
`;
export function parseRouter(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h") return { command: "help", usage: ROUTER_USAGE };
  if (
    action !== "status" &&
    action !== "configure" &&
    action !== "set-mode" &&
    action !== "set-provider" &&
    action !== "explain" &&
    action !== "evaluate"
  )
    throw new UsageError("router requires status, configure, set-mode, set-provider, explain or evaluate", ROUTER_USAGE);
  const parsed = parseFlags(rest, {
    usage: ROUTER_USAGE,
    valued: [
      "--data-dir",
      "--workspace",
      "--principal",
      ...(action === "configure"
        ? ["--file", "--revision"]
        : action === "set-mode" || action === "set-provider"
          ? ["--revision"]
          : action === "evaluate"
            ? ["--file"]
            : []),
    ],
    unknown: () => "Unsupported or repeated router option",
    repeated: () => "Unsupported or repeated router option",
    repeatedFirst: true,
  });
  if (parsed === "help") return { command: "help", usage: ROUTER_USAGE };
  const { flags, positionals: args } = parsed;
  if (args.length !== (action === "set-mode" ? 2 : action === "explain" || action === "set-provider" ? 1 : 0))
    throw new UsageError("Wrong number of router arguments", ROUTER_USAGE);
  const write = action === "configure" || action === "set-mode" || action === "set-provider";
  const revision = flags.get("--revision");
  if (write && (revision === undefined || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))))
    throw new UsageError("Writes require --revision from status", ROUTER_USAGE);
  if (action === "configure" && !flags.has("--file")) throw new UsageError("configure requires --file", ROUTER_USAGE);
  const feature = action === "set-mode" ? RouterFeatureSchema.safeParse(args[0]) : undefined;
  const mode = action === "set-mode" ? RouterModeSchema.safeParse(args[1]) : undefined;
  if (feature?.success === false || mode?.success === false) throw new UsageError("Invalid router feature or mode", ROUTER_USAGE);
  const file = flags.get("--file");
  // Present for explain and set-provider: the count was checked above.
  const [first] = args;
  return {
    command: "router",
    router: {
      action,
      workspaceId: flags.get("--workspace") ?? "default",
      principalId: flags.get("--principal") ?? "operator",
      ...dataDirectoryFlag(flags),
      ...(file === undefined ? {} : { file }),
      ...(action === "explain" && first !== undefined ? { taskId: first } : {}),
      ...(action === "set-provider" && first !== undefined ? { providerId: first } : {}),
      ...(write ? { expectedRevision: Number(revision) } : {}),
      ...(feature?.success ? { feature: feature.data } : {}),
      ...(mode?.success ? { mode: mode.data } : {}),
    },
  };
}
