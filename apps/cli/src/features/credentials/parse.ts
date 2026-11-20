import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

/** Actions `tavi credentials` supports — operator-only, never model-reachable. */
const CREDENTIALS_ACTIONS = ["set", "list", "delete", "encrypt", "key"] as const;
type CredentialsAction = (typeof CREDENTIALS_ACTIONS)[number];

export const CREDENTIALS_USAGE = `tavi credentials <action> [options]

Manage the local credential store at <data-dir>/credentials, one 0600 file per
reference. No action here ever prints a credential's value, and none of it is
reachable from the agent: only you write credentials, from here.

Under a running \`tavi serve\`, every action runs there; set reads the file
here and sends the value once over the local socket.

Actions:
  set <ref> --file <path>    Store the value read from a 0600 file
  list                       List configured references (names only)
  delete <ref>               Remove a reference (alias: rm, remove)
  encrypt                    Encrypt every value at rest (AES-256-GCM), creating
                             the key if there is none: in the OS keychain where
                             available (<data-dir>/credentials.key then refers
                             to it), else in credentials.key (0600); idempotent.
                             Keep the key: without it the values cannot be
                             read, and it is never regenerated
  key                        Say where the key is kept: credentials.key, the
                             OS keychain it refers to, or a systemd credential
  key --to-file              Move the key out of the keychain into
                             credentials.key (0600): for a backup that restores
                             on another machine, or a system service, launchd
                             daemon or lingering user unit that cannot read the
                             keychain. The same key moves — nothing is
                             re-encrypted, and the key is never printed; the
                             keychain item is deleted once the file is written
  key --to-keychain          Move the key from credentials.key into the OS
                             keychain; credentials.key then refers to it
  key --export               Write the key (hex) to standard output, for
                             \`systemd-creds encrypt\` to take; refused when
                             standard output is a terminal
  key --to-systemd           On a headless Linux service: make the systemd
                             credential tavi-credential-key the key's home.
                             Encrypt the key into it first (--export piped to
                             systemd-creds encrypt), install the unit with
                             --credential-encrypted, start it, then run this:
                             the running service checks the credential holds
                             the same key before credentials.key refers to it.
                             --to-file moves it back, also through the service

Options:
  --file <path>          Source file for set (0600, not a symlink)
  --to-file              key: move the key into credentials.key
  --to-keychain          key: move the key into the OS keychain
  --to-systemd           key: move the key to the systemd credential
  --export               key: print the key for systemd-creds encrypt
  --format <text|json>   Output format for list, encrypt and key (default: text)
  --data-dir <path>      Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help             Show this help
`;

export interface CredentialsCommandOptions {
  readonly action: CredentialsAction;
  /** Required for set/delete. */
  readonly credentialRef?: string;
  /** Required for set. */
  readonly file?: string;
  /** For key: where to move the key; absent, `key` only says where it is. */
  readonly keyTo?: "file" | "keychain" | "systemd";
  /** For key: write the key itself to standard output (`--export`), for `systemd-creds encrypt`. */
  readonly keyExport?: boolean;
  readonly format: OutputFormat;
  readonly dataDirectory?: string;
}

export function parseCredentials(argv: readonly string[]): ParsedCommand {
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const action = removalAlias(typed, "delete");
  // Same split as `reports`: bare `tavi credentials` must not print the root help
  // and exit 0, so a missing action never looks like success.
  if (action === "-h" || action === "--help") return { command: "help", usage: CREDENTIALS_USAGE };
  if (action === undefined) {
    throw new UsageError(`credentials needs an action; expected one of ${CREDENTIALS_ACTIONS.join(", ")}`, CREDENTIALS_USAGE);
  }
  if (!(CREDENTIALS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `Unknown credentials action ${JSON.stringify(action)}; expected one of ${CREDENTIALS_ACTIONS.join(", ")}`,
      CREDENTIALS_USAGE,
    );
  }
  const resolvedAction = action as CredentialsAction;
  const allowedFlags: Readonly<Record<CredentialsAction, readonly string[]>> = {
    set: ["--data-dir", "--file", "--format"],
    list: ["--data-dir", "--format"],
    delete: ["--data-dir", "--format"],
    encrypt: ["--data-dir", "--format"],
    key: ["--data-dir", "--format"],
  };
  const args = parseFlags(rest, {
    usage: CREDENTIALS_USAGE,
    valued: allowedFlags[resolvedAction],
    switches: resolvedAction === "key" ? ["--to-file", "--to-keychain", "--to-systemd", "--export"] : [],
    unknown: (name) => `credentials ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: CREDENTIALS_USAGE };
  const { flags, positionals } = args;

  const credentialRef = positionals[0];
  if (positionals.length > 1) {
    throw new UsageError(`credentials ${action} takes at most one credential reference`, CREDENTIALS_USAGE);
  }
  // `encrypt` acts on the whole store: a reference is a mistyped command, not a narrowing.
  if (resolvedAction === "encrypt" && credentialRef !== undefined) {
    throw new UsageError("credentials encrypt takes no credential reference: it encrypts every one", CREDENTIALS_USAGE);
  }
  if (resolvedAction === "key" && credentialRef !== undefined) {
    throw new UsageError("credentials key takes no credential reference: it acts on the store's key", CREDENTIALS_USAGE);
  }
  const keyFlags = (["--to-file", "--to-keychain", "--to-systemd", "--export"] as const).filter((flag) => args.switches.has(flag));
  if (keyFlags.length > 1) throw new UsageError(`credentials key takes one of ${keyFlags.join(", ")}, not both`, CREDENTIALS_USAGE);
  const keyExport = keyFlags[0] === "--export";
  const keyTo = keyFlags[0] === undefined || keyExport ? undefined : (keyFlags[0].slice("--to-".length) as "file" | "keychain" | "systemd");
  if (resolvedAction !== "list" && resolvedAction !== "encrypt" && resolvedAction !== "key" && credentialRef === undefined) {
    throw new UsageError(`credentials ${resolvedAction} needs a credential reference`, CREDENTIALS_USAGE);
  }
  const file = flags.get("--file");
  if (resolvedAction === "set" && file === undefined) {
    throw new UsageError("credentials set needs --file", CREDENTIALS_USAGE);
  }
  if (resolvedAction !== "set" && file !== undefined) {
    throw new UsageError(`credentials ${action} does not accept --file`, CREDENTIALS_USAGE);
  }
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, CREDENTIALS_USAGE);
  }

  return {
    command: "credentials",
    credentials: {
      action: resolvedAction,
      ...(credentialRef === undefined ? {} : { credentialRef }),
      ...(file === undefined ? {} : { file }),
      ...(keyTo === undefined ? {} : { keyTo }),
      ...(keyExport ? { keyExport } : {}),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}
