import { WEB_SEARCH_KINDS } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

/**
 * `tavi search`: the web search
 * providers available to `web_search`.
 */
const SEARCH_ACTIONS = ["add", "list", "test", "remove", "enable", "disable"] as const;
type SearchAction = (typeof SEARCH_ACTIONS)[number];

export const SEARCH_USAGE = `tavi search <action> [options]

Configure providers for web_search. With several available, select a provider
or explicit fallback chain in web-providers.json. web_search runs without
asking by the seeded allow rule seeded-web-search (tavi permissions rm
seeded-web-search to be asked each time); a query that looks like a key or
token asks first in any chat. An unattended schedule reaches it only with
--allow web_search. Adding, enabling, disabling or
removing a provider applies to new calls without a restart.
A running \`tavi serve\` offers web_search once a provider is enabled, and
these actions run there; otherwise on the data directory.

Actions:
  add <id>                   Add a provider
  list                       List configured providers in insertion order
  test <id>                  Run one search through a provider, and print what it answered
  remove <id>                Delete a provider (alias: rm, delete)
  enable|disable <id>        Let web_search ask it, or not

Options:
  --kind <kind>              tavily, brave, serper or searxng (required for add)
  --credential <ref>         The provider's API key, by credential reference
                             (tavi credentials set); tavily without one runs
                             keyless; brave and serper need one
  --base-url <url>           A searxng instance, e.g. http://127.0.0.1:8888 —
                             searxng only, which takes no key (enable json in
                             its search.formats)
  --query <text>             What test searches for (default: "tavi")
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export interface SearchCommandOptions {
  readonly action: SearchAction;
  readonly providerId?: string;
  readonly kind?: string;
  readonly credentialRef?: string;
  readonly baseUrl?: string;
  readonly query?: string;
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

export function parseSearch(argv: readonly string[]): ParsedCommand {
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const action = removalAlias(typed, "remove");
  if (action === "-h" || action === "--help") return { command: "help", usage: SEARCH_USAGE };
  if (action === undefined) throw new UsageError(`search needs an action; expected one of ${SEARCH_ACTIONS.join(", ")}`, SEARCH_USAGE);
  if (!(SEARCH_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown search action ${JSON.stringify(action)}; expected one of ${SEARCH_ACTIONS.join(", ")}`, SEARCH_USAGE);
  }
  const resolvedAction = action as SearchAction;
  const common = ["--data-dir", "--format"];
  const allowedFlags: Readonly<Record<SearchAction, readonly string[]>> = {
    add: ["--kind", "--credential", "--base-url", ...common],
    list: common,
    test: ["--query", ...common],
    remove: common,
    enable: common,
    disable: common,
  };
  const args = parseFlags(rest, {
    usage: SEARCH_USAGE,
    valued: allowedFlags[resolvedAction],
    unknown: (name) => `search ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: SEARCH_USAGE };
  const { flags, positionals } = args;
  if (positionals.length > (resolvedAction === "list" ? 0 : 1)) {
    throw new UsageError(
      resolvedAction === "list" ? "search list takes no provider id" : `search ${action} takes at most one provider id`,
      SEARCH_USAGE,
    );
  }
  const providerId = positionals[0];
  if (resolvedAction !== "list" && providerId === undefined) throw new UsageError(`search ${action} needs a provider id`, SEARCH_USAGE);
  if (resolvedAction === "add") {
    const given = flags.get("--kind");
    if (given === undefined) throw new UsageError("search add needs --kind", SEARCH_USAGE);
    if (!(WEB_SEARCH_KINDS as readonly string[]).includes(given))
      throw new UsageError(`--kind must be one of ${WEB_SEARCH_KINDS.join(", ")}`, SEARCH_USAGE);
  }
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, SEARCH_USAGE);
  const kind = flags.get("--kind");
  const credentialRef = flags.get("--credential");
  const baseUrl = flags.get("--base-url");
  const query = flags.get("--query");
  return {
    command: "search",
    search: {
      action: resolvedAction,
      ...definedOnly({
        providerId,
        kind,
        credentialRef,
        baseUrl,
        query,
      }),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}
