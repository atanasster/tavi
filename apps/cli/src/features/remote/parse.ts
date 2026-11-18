import { UsageError, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

export const REMOTE_USAGE = `tavi remote connect <ssh-target> [options]

Use a \`tavi serve\` running on another computer from this one, over SSH.

\`connect\` signs in to <ssh-target> with your own \`ssh\` (its config, keys
and agent; a password is asked here), forwards the owner's local socket to
this computer, and keeps a copy of the owner's token in a mirror directory
here, renewed whenever the owner restarts. While it runs, every client on this
computer reaches that owner through the mirror:

  tavi chat --data-dir ~/.tavi-remote/<host>
  TAVI_DATA_DIR=~/.tavi-remote/<host> tavi ui

The mirror holds no data of its own: no command opens it offline, and
\`tavi serve\` refuses it. Ctrl-C disconnects. The owner's computer must be
macOS or Linux, and the SSH user must be the one that runs \`tavi serve\`
there. Anyone who can act as your user on this computer can use the owner
while the connection is up, as anyone who can act as that user there can.

Options:
  --data-dir <path>          The mirror directory here (default:
                             ~/.tavi-remote/<host>); no spaces or colons, and
                             empty or an earlier mirror of the same target
  --remote-data-dir <path>   The owner's data directory there (default: its
                             user data directory: ~/Library/Application
                             Support/tavi on macOS, $XDG_DATA_HOME/tavi or
                             ~/.local/share/tavi on Linux); ~ is that user's home
  --ssh-option <opt>         Pass \`-o <opt>\` to ssh (repeatable), e.g.
                             --ssh-option Port=2222
  -h, --help                 Show this help

Examples:
  tavi remote connect brook@mini.lan
  tavi remote connect mini --remote-data-dir /srv/tavi
`;

export interface RemoteCommandOptions {
  readonly action: "connect";
  readonly target: string;
  /** Raw `--data-dir`: the mirror. Never `TAVI_DATA_DIR`, which names this computer's own data. */
  readonly mirrorDirectory?: string;
  readonly remoteDataDirectory?: string;
  readonly sshOptions: readonly string[];
}

/** Parse `tavi remote`. */
export function parseRemote(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: REMOTE_USAGE,
    valued: ["--data-dir", "--remote-data-dir", "--ssh-option"],
    lists: ["--ssh-option"],
    unknown: (name) => `remote does not accept ${name}`,
    positional: (token, taken) => (taken.length >= 2 ? `remote takes an action and an SSH target; got ${token} too` : undefined),
  });
  if (args === "help") return { command: "help", usage: REMOTE_USAGE };
  const [action, target] = args.positionals;
  if (action === undefined) throw new UsageError("remote needs an action: connect", REMOTE_USAGE);
  if (action !== "connect") throw new UsageError(`remote has no action ${action}; use connect`, REMOTE_USAGE);
  if (target === undefined || target.trim() === "")
    throw new UsageError("remote connect needs an SSH target (user@host or a Host alias)", REMOTE_USAGE);
  // Never an option of ssh's own, nor anything a shell or ssh's command line would read as more than a name.
  if (target.startsWith("-") || !/^[A-Za-z0-9._@%:[\]-]+$/.test(target))
    throw new UsageError(`${target} is not an SSH target: give user@host or a Host alias`, REMOTE_USAGE);
  const sshOptions = args.lists.get("--ssh-option") ?? [];
  for (const option of sshOptions) {
    if (!/^[A-Za-z][A-Za-z0-9]*[ =]\S/.test(option))
      throw new UsageError(`--ssh-option takes Name=value, as ssh's -o does; got ${option}`, REMOTE_USAGE);
  }
  const mirrorDirectory = args.flags.get("--data-dir");
  const remoteDataDirectory = args.flags.get("--remote-data-dir");
  return {
    command: "remote",
    remote: {
      action: "connect",
      target,
      sshOptions,
      ...(mirrorDirectory === undefined ? {} : { mirrorDirectory }),
      ...(remoteDataDirectory === undefined ? {} : { remoteDataDirectory }),
    },
  };
}
