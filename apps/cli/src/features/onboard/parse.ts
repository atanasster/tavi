import { ONBOARDING_STEP_KINDS, type OnboardingStepKind } from "@tavi/contracts";
import { UsageError, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

// ------------------------------------------------------------------ onboard and setup

const ONBOARD_ACTIONS = ["status", "provider", "reset", "import"] as const;

/** `--channel-secret <channel>:<field>=<file>`: one secret of a channel, read from a file, never from an argument. */
export interface ChannelSecretFile {
  readonly channel: string;
  readonly field: string;
  readonly file: string;
}

const CHANNEL_SECRET = /^([a-z][a-z0-9-]{0,47}):([a-zA-Z][a-zA-Z0-9_]{0,47})=(.+)$/u;

/** The flag's shape only: which channels and fields exist is the running owner's catalog's to say. */
function channelSecrets(values: readonly string[], usage: string): readonly ChannelSecretFile[] {
  const seen = new Set<string>();
  return values.map((value) => {
    const match = CHANNEL_SECRET.exec(value);
    if (match === null)
      throw new UsageError(
        `--channel-secret takes <channel>:<field>=<file> (telegram:token=bot.token), not ${JSON.stringify(value)}`,
        usage,
      );
    const [, channel = "", field = "", file = ""] = match;
    if (seen.has(`${channel}:${field}`)) throw new UsageError(`--channel-secret ${channel}:${field} may be given only once`, usage);
    // Setup adds the one channel it records as its own (a rerun saves on it): a second is `tavi channels add`'s.
    const other = [...seen].map((key) => key.slice(0, key.indexOf(":"))).find((named) => named !== channel);
    if (other !== undefined) throw new UsageError(`--channel-secret names one channel; ${other} and ${channel} are two`, usage);
    seen.add(`${channel}:${field}`);
    return { channel, field, file };
  });
}

export interface OnboardCommandOptions {
  /** `onboard` walks the open steps; `setup` every step (or one); `status`, `provider`, `reset` are `onboard`'s subcommands. */
  readonly action: "onboard" | "setup" | (typeof ONBOARD_ACTIONS)[number];
  readonly workspaceId: string;
  readonly dataDirectory?: string;
  /** `tavi setup <step>`. */
  readonly step?: OnboardingStepKind;
  /** `tavi onboard provider <id>`. */
  readonly provider?: string;
  /** `tavi onboard import`: one agent's install only, a dry run, and consent to copy its keys. */
  readonly importFrom?: "openclaw" | "hermes";
  readonly dryRun?: boolean;
  readonly withSecrets?: boolean;
  readonly nonInteractive?: boolean;
  readonly preset?: string;
  readonly keyFile?: string;
  readonly keyStdin?: boolean;
  readonly model?: string;
  readonly fastModel?: string;
  /** Headless about you, search and channels: a secret only as a file's path. */
  readonly name?: string;
  readonly timezone?: string;
  readonly activeHours?: string;
  readonly search?: string;
  readonly searchKeyFile?: string;
  readonly searchUrl?: string;
  readonly channelSecrets?: readonly ChannelSecretFile[];
  /** `--preset custom`'s endpoint, headless. */
  readonly baseUrl?: string;
  /** The plain line renderer, whatever the terminal. */
  readonly plain?: boolean;
  /** Sign in with OpenRouter over SSH: paste back the address the browser landed on. */
  readonly paste?: boolean;
  readonly format: "text" | "json";
}

/** @public Read through the module namespace by test/cli/usage-text.test.ts, which checks every command's usage. */
export const ONBOARD_USAGE = `tavi onboard [status|provider|reset|import] [options]

Walks the setup steps that are still open, in order: a model first (the only
one Tavi needs), then about you, where you keep tasks, channels, voice
messages, keeping it running and a first idea.
Each step can be done or skipped; nothing is asked about a step that is done.

  tavi onboard                 walk the open steps
  tavi onboard status [--json] the checklist; exits 0 when no required step is
                               open, 3 when one is
  tavi onboard provider [<id>] which onboarding flow runs
  tavi onboard reset           forget skips and the dismissed checklist (keeps
                               every model, key, connection and verification)
  tavi onboard import          bring in an OpenClaw (~/.openclaw) or Hermes
                               (~/.hermes) install's model connections and
                               Telegram bot; asks before copying any key
    --from openclaw|hermes     only that one
    --dry-run                  say what would be imported, change nothing
    --with-secrets             copy keys and the bot token without asking

Options:
  --workspace <id>   The workspace (default: default)
  --data-dir <path>  The data directory
  --plain            One line per prompt, no live region (also TERM=dumb or
                     TAVI_SCREEN_READER=1)
  --paste            Sign in with OpenRouter from another computer: paste back
                     the address the browser landed on (over SSH)
  --json             Answer as JSON (status, provider, reset, import); the
                     same as --format json

Exit codes: 0 no required step open, 3 one open, 4 an owner is needed,
130 cancelled with Ctrl-C (progress is kept). See also: tavi setup.
`;

/** @public Read through the module namespace by test/cli/usage-text.test.ts, which checks every command's usage. */
export const SETUP_USAGE = `tavi setup [<step>] [options]

Goes through every setup step (or one: model, about, search, apps, tasks,
channels, voice, service, ideas), showing what is set now and keeping it on Enter. The only
command that changes a step that is done. See also: tavi onboard.

Headless (no prompt at all):
  tavi setup --non-interactive --preset <id> [--base-url <url>]
             (--key-file <path> | --key-stdin)
             [--model <id>] [--fast-model <id>] [--name <text>]
             [--timezone <iana>] [--active-hours 08:00-22:00]
             [--search <kind> [--search-key-file <path> | --search-url <url>]]
             [--channel-secret <channel>:<field>=<path>]... [--json]

  Each flag sets its step; a step without its flags is left as it is.
  --channel-secret adds and tests a channel with that secret field read from
  the file (telegram:token=bot.token), repeated for each of that one
  channel's fields (\`tavi channels add\` adds others); pairing needs
  a person, so the answer names \`tavi channels pair <channel>\` as next.

  --base-url goes with --preset custom: its OpenAI-compatible endpoint.
  A key is read only from a file or standard input, never from an argument.
  A required step that stays open exits 3, naming the flag it needs.

Options:
  --workspace <id>   The workspace (default: default)
  --data-dir <path>  The data directory
  --plain            One line per prompt, no live region
  --paste            Sign in with OpenRouter over SSH: paste back the address
                     the browser landed on
  --json             Answer as JSON (with --non-interactive); the same as
                     --format json
`;

/** `--json`, or the global `--format <text|json>` every other command takes; the two must not disagree. */
function outputFormat(
  parsed: { readonly flags: ReadonlyMap<string, string>; readonly switches: ReadonlySet<string> },
  usage: string,
): "text" | "json" {
  const format = parsed.flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") throw new UsageError("--format is text or json", usage);
  if (format === "text" && parsed.switches.has("--json")) throw new UsageError("--json and --format text disagree: pass one", usage);
  return format === "json" || parsed.switches.has("--json") ? "json" : "text";
}

export function parseOnboard(argv: readonly string[]): ParsedCommand {
  const usage = ONBOARD_USAGE;
  const parsed = parseFlags(argv, {
    usage,
    valued: ["--workspace", "--data-dir", "--from", "--format"],
    switches: ["--plain", "--json", "--paste", "--dry-run", "--with-secrets"],
  });
  if (parsed === "help") return { command: "help", usage };
  const [action, ...extra] = parsed.positionals;
  if (action !== undefined && !(ONBOARD_ACTIONS as readonly string[]).includes(action))
    throw new UsageError(`Unknown onboard action ${JSON.stringify(action)}; expected one of ${ONBOARD_ACTIONS.join(", ")}`, usage);
  if (action === "provider" ? extra.length > 1 : extra.length > 0)
    throw new UsageError(
      `onboard ${action ?? ""} takes ${action === "provider" ? "at most one provider id" : "no argument"}`.replace("  ", " "),
      usage,
    );
  const from = parsed.flags.get("--from");
  if (action !== "import" && (from !== undefined || parsed.switches.has("--dry-run") || parsed.switches.has("--with-secrets")))
    throw new UsageError(
      `${from !== undefined ? "--from" : parsed.switches.has("--dry-run") ? "--dry-run" : "--with-secrets"} goes with onboard import`,
      usage,
    );
  if (from !== undefined && from !== "openclaw" && from !== "hermes") throw new UsageError("--from is openclaw or hermes", usage);
  if (parsed.switches.has("--dry-run") && parsed.switches.has("--with-secrets"))
    throw new UsageError("--dry-run copies nothing: drop --with-secrets", usage);
  return {
    command: "onboard",
    usage,
    onboard: {
      action: (action ?? "onboard") as OnboardCommandOptions["action"],
      workspaceId: parsed.flags.get("--workspace") ?? "default",
      ...(parsed.flags.get("--data-dir") === undefined ? {} : { dataDirectory: parsed.flags.get("--data-dir") as string }),
      ...(action === "provider" && extra[0] !== undefined ? { provider: extra[0] } : {}),
      ...(from === undefined ? {} : { importFrom: from as "openclaw" | "hermes" }),
      ...(parsed.switches.has("--dry-run") ? { dryRun: true } : {}),
      ...(parsed.switches.has("--with-secrets") ? { withSecrets: true } : {}),
      ...(parsed.switches.has("--plain") ? { plain: true } : {}),
      ...(parsed.switches.has("--paste") ? { paste: true } : {}),
      format: outputFormat(parsed, usage),
    },
  };
}

export function parseSetup(argv: readonly string[]): ParsedCommand {
  const usage = SETUP_USAGE;
  const parsed = parseFlags(argv, {
    usage,
    valued: [
      "--workspace",
      "--data-dir",
      "--preset",
      "--base-url",
      "--key-file",
      "--model",
      "--fast-model",
      "--name",
      "--timezone",
      "--active-hours",
      "--search",
      "--search-key-file",
      "--search-url",
      "--channel-secret",
      "--format",
    ],
    lists: ["--channel-secret"],
    switches: ["--plain", "--json", "--non-interactive", "--key-stdin", "--paste"],
  });
  if (parsed === "help") return { command: "help", usage };
  const [step, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError("setup takes at most one step", usage);
  if (step !== undefined && (step === "info" || !(ONBOARDING_STEP_KINDS as readonly string[]).includes(step)))
    throw new UsageError(
      `Unknown setup step ${JSON.stringify(step)}; expected one of ${ONBOARDING_STEP_KINDS.filter((kind) => kind !== "info").join(", ")}`,
      usage,
    );
  const nonInteractive = parsed.switches.has("--non-interactive");
  const headlessOnly = [
    "--preset",
    "--base-url",
    "--key-file",
    "--model",
    "--fast-model",
    "--name",
    "--timezone",
    "--active-hours",
    "--search",
    "--search-key-file",
    "--search-url",
  ].filter((flag) => parsed.flags.has(flag));
  const secretFiles = parsed.lists.get("--channel-secret") ?? [];
  if (secretFiles.length > 0) headlessOnly.push("--channel-secret");
  if (!nonInteractive && (headlessOnly.length > 0 || parsed.switches.has("--key-stdin")))
    throw new UsageError(`${headlessOnly[0] ?? "--key-stdin"} goes with --non-interactive`, usage);
  if (parsed.flags.has("--key-file") && parsed.switches.has("--key-stdin"))
    throw new UsageError("--key-file and --key-stdin are two ways to give one key: pass one", usage);
  return {
    command: "setup",
    usage,
    onboard: {
      action: "setup",
      workspaceId: parsed.flags.get("--workspace") ?? "default",
      ...(parsed.flags.get("--data-dir") === undefined ? {} : { dataDirectory: parsed.flags.get("--data-dir") as string }),
      ...(step === undefined ? {} : { step: step as OnboardingStepKind }),
      ...(nonInteractive ? { nonInteractive: true } : {}),
      ...(parsed.flags.get("--preset") === undefined ? {} : { preset: parsed.flags.get("--preset") as string }),
      ...(parsed.flags.get("--base-url") === undefined ? {} : { baseUrl: parsed.flags.get("--base-url") as string }),
      ...(parsed.flags.get("--key-file") === undefined ? {} : { keyFile: parsed.flags.get("--key-file") as string }),
      ...(parsed.switches.has("--key-stdin") ? { keyStdin: true } : {}),
      ...(parsed.flags.get("--model") === undefined ? {} : { model: parsed.flags.get("--model") as string }),
      ...(parsed.flags.get("--fast-model") === undefined ? {} : { fastModel: parsed.flags.get("--fast-model") as string }),
      ...(parsed.flags.get("--name") === undefined ? {} : { name: parsed.flags.get("--name") as string }),
      ...(parsed.flags.get("--timezone") === undefined ? {} : { timezone: parsed.flags.get("--timezone") as string }),
      ...(parsed.flags.get("--active-hours") === undefined ? {} : { activeHours: parsed.flags.get("--active-hours") as string }),
      ...(parsed.flags.get("--search") === undefined ? {} : { search: parsed.flags.get("--search") as string }),
      ...(parsed.flags.get("--search-key-file") === undefined ? {} : { searchKeyFile: parsed.flags.get("--search-key-file") as string }),
      ...(parsed.flags.get("--search-url") === undefined ? {} : { searchUrl: parsed.flags.get("--search-url") as string }),
      ...(secretFiles.length === 0 ? {} : { channelSecrets: channelSecrets(secretFiles, usage) }),
      ...(parsed.switches.has("--plain") ? { plain: true } : {}),
      ...(parsed.switches.has("--paste") ? { paste: true } : {}),
      format: outputFormat(parsed, usage),
    },
  };
}
