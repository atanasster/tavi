import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

export interface UiCommandParsed {
  readonly printUrl: boolean;
  readonly port?: number;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export const UI_USAGE = `tavi ui [options]

Serve the web canvas on a loopback port and bridge it to a live \`tavi serve\`
(exit 4 without one). The browser opens a one-time link: its token, in the
URL's fragment, is exchanged once, within a minute, for a session cookie and a
secret the tab keeps — neither alone reaches the owner. A reload keeps the
session and the page's last task; press Enter for another link (a new tab
needs its own); Ctrl-C stops.

The page reaches what a browser needs — runs, their streams, approvals,
reviews, replies, aborts, cancellations, tasks, agents and the configuration
families — and never \`shutdown\`, \`recover\` or \`doctor\`. What a run shows is
sent to the page as it is, tool input and output included: a browser extension
with access to 127.0.0.1 reads it too.

Options:
  --print-url           Print the link instead of opening a browser
  --port <n>            Listen on this port (default: the port saved for a
                        channel's OAuth app, else any free one)
  --data-dir <path>     Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help            Show this help
`;

/** Parse `tavi ui`, the web canvas's bridge to a live owner. */
export function parseUi(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: UI_USAGE,
    valued: ["--port", "--data-dir"],
    switches: ["--print-url"],
    unknown: (name) => `ui does not accept ${name}`,
    switchValue: (name) => `${name} takes no value`,
    positional: (token) => `ui takes no arguments; got ${token}`,
  });
  if (args === "help") return { command: "help", usage: UI_USAGE };
  const { flags } = args;
  const printUrl = args.switches.has("--print-url");
  const port = flags.get("--port");
  if (port !== undefined && !/^\d{1,5}$/.test(port)) throw new UsageError("--port must be a port number", UI_USAGE);
  const portNumber = port === undefined ? undefined : Number(port);
  if (portNumber !== undefined && portNumber > 65_535) throw new UsageError("--port must be a port number", UI_USAGE);
  return {
    command: "ui",
    ui: { printUrl, ...(portNumber === undefined ? {} : { port: portNumber }), ...dataDirectoryFlag(flags) },
  };
}
