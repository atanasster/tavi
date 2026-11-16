import { MAX_STREAM_TIMEOUT_SECONDS, MODEL_ROLES, PDF_ENGINES, PDF_INPUTS, type PdfEngine, type PdfInput } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

const MODEL_ROLE_NAMES: readonly string[] = MODEL_ROLES;

/** Actions `tavi models` supports; configuration only, no model calls except discover/test (and `suggest`, which asks the model resolver). */
const MODELS_ACTIONS = [
  "list",
  "show",
  "add",
  "remove",
  "rebind",
  "discover",
  "test",
  "probe",
  "roles",
  "set-default",
  "clear-default",
  "set-role",
  "clear-role",
  "video",
  "suggest",
] as const;
type ModelsAction = (typeof MODELS_ACTIONS)[number];

export interface ModelsCommandOptions {
  readonly action: ModelsAction;
  readonly connectionId?: string;
  readonly label?: string;
  readonly baseUrl?: string;
  readonly credentialRef?: string;
  readonly model?: string;
  readonly localOnly?: boolean;
  /** `add`: PDF input: `none`, or `openai-file` where the endpoint's preset takes PDFs. */
  readonly pdfInput?: PdfInput;
  /** `add`: OpenRouter's file-parser engine; `default` clears it. */
  readonly pdfEngine?: PdfEngine | "default";
  /** `add`: the stream deadlines in seconds (`--first-byte-timeout`, `--idle-timeout`); `default` clears one. */
  readonly streamFirstByteSeconds?: number | "default";
  readonly streamIdleSeconds?: number | "default";
  /** `key=value` pairs; credential headers are refused by the service. */
  readonly headers?: readonly string[];
  readonly role?: string;
  readonly fallback?: readonly string[];
  /** Explicit credential file for a discover/test call; never an ambient key. */
  readonly credentialFile?: string;
  /** `probe`: what is probed, `--pdf` or `--video`. */
  readonly probe?: "pdf" | "video";
  /** `video`: the model to turn native video on or off for, and whether its disclosure is confirmed (`--yes`). */
  readonly videoEnable?: string;
  readonly videoDisable?: string;
  readonly yes?: boolean;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export const MODELS_USAGE = `tavi models <action> [options]

Inspect and edit model connections, roles and the default. These commands
are configuration, not tasks: with no \`tavi serve\` running they change the
data directory directly; under a running one they run there, and
--credential-file is refused (it tests connections with its own credentials).

Actions:
  list                              List configured connections
  show <connection-id>              Show one connection and its catalog
  add <connection-id>               Add or update a connection
  remove <connection-id>            Delete an unused connection (alias: rm, delete)
  rebind <connection-id>            Move a connection to another credential
  discover <connection-id>          List the models the connection reports
  test <connection-id>              Run one bounded synthetic generation
  probe <connection-id> --pdf       Send the model a one-page PDF holding a code;
                                    when it quotes the code back, PDF input is
                                    turned on for the connection
  probe <connection-id> --video     Send the model a 4-second clip of four
                                    digits; when it reads them back in order,
                                    it qualifies for tavi models video
  video <connection-id> --enable <model> --yes
                                    Send that model whole videos a chat views
                                    (its catalog or a video probe must say it
                                    reads video);
                                    prints the disclosure, and turns it on
                                    only with --yes
  video <connection-id> --disable <model>
                                    Back to frames for that model
  roles                             Show workspace defaults and role bindings
  set-default --connection <id>     Set the workspace default target
  clear-default                     Remove the workspace default
  set-role <role> --connection <id> Set a role override
  clear-role <role>                 Remove a role override
  suggest                           With RESOLVER_KEY set, ask the model resolver
                                    for the best local model that fits this
                                    machine and price sheets for the cloud
                                    connections; prints them, changes nothing

Options:
  --label <text>           Operator-facing connection name
  --base-url <url>         Explicit endpoint (no ambient default)
  --credential <ref>       Opaque credential reference, e.g. openai.apiKey; a local
                           connection may leave it out and gets a placeholder of its own
  --model <id>             Default model for the connection or target
  --local-only             Declare operator-controlled local infrastructure
  --header <key=value>     Non-credential header (repeatable)
  --pdf-input <mode>       none or openai-file: whether a PDF a tool hands the
                           model is sent as a file. On by default for the
                           OpenAI and OpenRouter endpoints; elsewhere only
                           after a passed PDF probe
  --pdf-engine <engine>    OpenRouter's file parser for those PDFs: pdf-text,
                           mistral-ocr, native, or default
  --first-byte-timeout <s> Seconds a call waits for the provider's first
                           output before it fails over (default 60, 180 for
                           a reasoning call), or default
  --idle-timeout <s>       Seconds a reply may go quiet between chunks before
                           it fails over (default 90), or default
  --fallback <conn/model>  Ordered fallback target (repeatable, max 3)
  --credential-file <path> Credential file for discover/test (0600, explicit)
  --data-dir <path>        Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help               Show this help

Roles: ${MODEL_ROLES.join(", ")}`;

/** Parse `tavi models <action>`, the configuration surface. */
export function parseModels(argv: readonly string[]): ParsedCommand {
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const action = removalAlias(typed, "remove");
  // `--help` is a request for this page; a missing action is not success
  if (action === "-h" || action === "--help") return { command: "help", usage: MODELS_USAGE };
  if (action === undefined) {
    throw new UsageError(`models needs an action; expected one of ${MODELS_ACTIONS.join(", ")}`, MODELS_USAGE);
  }
  if (!(MODELS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown models action ${JSON.stringify(action)}; expected one of ${MODELS_ACTIONS.join(", ")}`, MODELS_USAGE);
  }

  // Each action accepts a specific set of flags. Silently ignoring an irrelevant
  // one (`--local-only` on `show`, `--fallback` on `set-default`) hides a typo
  // that the operator will otherwise discover from behaviour much later.
  const allowedFlags: Readonly<Record<ModelsAction, readonly string[]>> = {
    list: ["--data-dir"],
    show: ["--data-dir"],
    add: [
      "--data-dir",
      "--label",
      "--base-url",
      "--credential",
      "--model",
      "--local-only",
      "--header",
      "--pdf-input",
      "--pdf-engine",
      "--first-byte-timeout",
      "--idle-timeout",
    ],
    remove: ["--data-dir"],
    rebind: ["--data-dir", "--credential"],
    discover: ["--data-dir", "--credential-file"],
    test: ["--data-dir", "--model", "--credential-file"],
    probe: ["--data-dir", "--model", "--credential-file", "--pdf", "--video"],
    roles: ["--data-dir"],
    "set-default": ["--data-dir", "--connection", "--model"],
    "clear-default": ["--data-dir"],
    "set-role": ["--data-dir", "--connection", "--model", "--fallback"],
    "clear-role": ["--data-dir"],
    video: ["--data-dir", "--enable", "--disable", "--yes"],
    suggest: ["--data-dir"],
  };
  const allowed = allowedFlags[action as ModelsAction];

  const args = parseFlags(rest, {
    usage: MODELS_USAGE,
    valued: allowed,
    // `--local-only` has always been taken by every action; the others only where they apply.
    switches: ["--local-only", ...["--yes", "--pdf", "--video"].filter((name) => allowed.includes(name))],
    switchesInFlags: true,
    lists: ["--header", "--fallback"],
    unknown: (name) => `models ${action} does not accept ${name}`,
    positional: (_token, taken) => (taken.length > 0 ? `models ${action} accepts at most one argument` : undefined),
  });
  if (args === "help") return { command: "help", usage: MODELS_USAGE };
  const { flags } = args;
  const headers = args.lists.get("--header") ?? [];
  const fallback = args.lists.get("--fallback") ?? [];
  const positional = args.positionals[0];

  // The role actions take the role as their positional argument and the
  // connection from `--connection`; every other action takes the connection id
  // positionally.
  const roleAction = action === "set-role" || action === "clear-role";
  const connectionId = roleAction ? flags.get("--connection") : (positional ?? flags.get("--connection"));
  const needsConnection = ["show", "add", "remove", "rebind", "discover", "test", "probe", "set-default", "set-role", "video"].includes(
    action,
  );
  if (action === "video" && (flags.get("--enable") === undefined) === (flags.get("--disable") === undefined))
    throw new UsageError("models video needs one of --enable <model> or --disable <model>", MODELS_USAGE);
  // A probe is named, --pdf or --video: one of them, so a probe of one thing is never run for another.
  if (action === "probe" && (flags.get("--pdf") === undefined) === (flags.get("--video") === undefined))
    throw new UsageError("models probe needs one of --pdf or --video", MODELS_USAGE);
  if (needsConnection && connectionId === undefined) {
    throw new UsageError(`models ${action} needs a connection id`, MODELS_USAGE);
  }
  if (!needsConnection && !roleAction && positional !== undefined) {
    throw new UsageError(`models ${action} does not take a positional argument`, MODELS_USAGE);
  }

  const role = roleAction ? positional : flags.get("--role");
  if (roleAction && role === undefined) {
    throw new UsageError(`models ${action} needs a role`, MODELS_USAGE);
  }
  if (role !== undefined && !MODEL_ROLE_NAMES.includes(role)) {
    throw new UsageError(`Unknown role ${JSON.stringify(role)}; expected one of ${MODEL_ROLE_NAMES.join(", ")}`, MODELS_USAGE);
  }

  const label = flags.get("--label");
  const baseUrl = flags.get("--base-url");
  const credentialRef = flags.get("--credential");
  const model = flags.get("--model");
  const credentialFile = flags.get("--credential-file");
  const pdfInputFlag = flags.get("--pdf-input");
  const pdfInput = PDF_INPUTS.find((mode) => mode === pdfInputFlag);
  if (pdfInputFlag !== undefined && pdfInput === undefined)
    throw new UsageError(`--pdf-input takes ${PDF_INPUTS.join(" or ")}, not ${JSON.stringify(pdfInputFlag)}`, MODELS_USAGE);
  const pdfEngineFlag = flags.get("--pdf-engine");
  const pdfEngine = [...PDF_ENGINES, "default" as const].find((engine) => engine === pdfEngineFlag);
  if (pdfEngineFlag !== undefined && pdfEngine === undefined)
    throw new UsageError(
      `--pdf-engine takes ${[...PDF_ENGINES, "default"].join(", ")}, not ${JSON.stringify(pdfEngineFlag)}`,
      MODELS_USAGE,
    );
  const streamFirstByteSeconds = timeoutFlag(flags.get("--first-byte-timeout"), "--first-byte-timeout");
  const streamIdleSeconds = timeoutFlag(flags.get("--idle-timeout"), "--idle-timeout");
  const parsed: ModelsCommandOptions = {
    action: action as ModelsAction,
    ...definedOnly({
      connectionId,
      label,
      baseUrl,
      credentialRef,
      model,
    }),
    ...(flags.get("--local-only") === undefined ? {} : { localOnly: true }),
    ...(pdfInput === undefined ? {} : { pdfInput }),
    ...(pdfEngine === undefined ? {} : { pdfEngine }),
    ...definedOnly({ streamFirstByteSeconds, streamIdleSeconds }),
    ...(headers.length === 0 ? {} : { headers }),
    ...(role === undefined ? {} : { role }),
    ...(fallback.length === 0 ? {} : { fallback }),
    ...(credentialFile === undefined ? {} : { credentialFile }),
    ...(flags.get("--enable") === undefined ? {} : { videoEnable: flags.get("--enable") as string }),
    ...(flags.get("--disable") === undefined ? {} : { videoDisable: flags.get("--disable") as string }),
    ...(flags.get("--yes") === undefined ? {} : { yes: true }),
    ...(action === "probe" ? { probe: flags.get("--video") === undefined ? ("pdf" as const) : ("video" as const) } : {}),
    ...dataDirectoryFlag(flags),
  };
  return { command: "models", models: parsed };
}

/** A stream deadline flag: whole seconds within the stored bound, or `default`. */
function timeoutFlag(value: string | undefined, flag: string): number | "default" | undefined {
  if (value === undefined || value === "default") return value;
  const seconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(seconds >= 1 && seconds <= MAX_STREAM_TIMEOUT_SECONDS))
    throw new UsageError(
      `${flag} takes whole seconds from 1 to ${MAX_STREAM_TIMEOUT_SECONDS}, or default, not ${JSON.stringify(value)}`,
      MODELS_USAGE,
    );
  return seconds;
}
