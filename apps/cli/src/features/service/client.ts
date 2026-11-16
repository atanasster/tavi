import { EXIT, reportCommandFailure } from "../../cli/exit.js";
import { TaviError } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { renderServiceUnit, SERVICE_LOG_FILES, installStepsOf, serviceUnitFilename, type SystemdServiceOptions } from "./unit.js";
import { chmodSync, closeSync, fchmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { ServiceCommandOptions } from "./parse.js";
import type { CliIo } from "../../cli/io.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";
import { credentialKeyItemOf } from "../credentials/store.js";
import { openNoFollowSync, WSL1_UNSUPPORTED, WSL_KEEP_RUNNING, wslVersion, type WslVersion } from "@tavi/node-kit";
import { assertLocalFilesystem } from "@tavi/runtime";

/**
 * Say so when the unit has no way to deliver the brief.
 *
 * A unit whose `serve` invocation names no destination starts, fires the
 * schedule, collects, renders — and then cannot send anything, silently, because
 * `messagingAllowedDestinations` defaults to empty. (Channels themselves are the
 * ones saved in Settings → Channels; this command does not open the database to
 * look.) Printing the unit without a word about it is
 * how an operator ends up with a service that looks armed and never delivers.
 */
function noteUndeliverableUnit(serveArgs: readonly string[], io: CliIo): void {
  const hasDestination = hasFlag(serveArgs, "--messaging-allow-destination");
  // Not needed for connector traffic, but every `http.request` is denied without
  // it, so a collector pipeline that uses HTTP tools collects nothing.
  const hasHttpEgress = hasFlag(serveArgs, "--http-allow-host");
  // The model credential has no durable fallback and the unit sets no environment,
  // so a deployment whose interactive `serve` works because TAVI_API_KEY_FILE is
  // exported in the shell produces a unit that cannot reach a model at all.
  const hasModelKey = hasFlag(serveArgs, "--api-key-file");
  const missing = [
    hasDestination ? undefined : "`messaging.send_to` destinations (--messaging-allow-destination)",
    hasHttpEgress ? undefined : "any allowed HTTP host (--http-allow-host)",
    hasModelKey ? undefined : "an explicit model credential (--api-key-file)",
  ].filter((entry): entry is string => entry !== undefined);
  if (missing.length === 0) return;
  io.stderr(
    `\nwarning: this unit starts serve without ${missing.join(", ")}. ` +
      "A scheduled run will fire and render, then fail to deliver or collect nothing, and the failure alert cannot be sent either. " +
      "Pass them with --serve-arg (see `tavi service unit --help`). " +
      "A service inherits no shell environment: TAVI_* fallbacks such as TAVI_API_KEY_FILE are not read by the unit.\n",
  );
}

/**
 * Say so when the credential key is kept in the OS keychain, which the unit
 * may not reach. A system unit, and a launchd daemon, have no login session:
 * no Secret Service on a session bus, no login keychain — and a user unit
 * left running by `enable-linger` finds the keyring locked until someone logs
 * in, past the few seconds a keychain lookup is given. Encrypted credentials
 * would then be unreadable with UNAVAILABLE, so the warning names the command
 * that moves the key into `credentials.key`.
 */
async function noteKeychainKey(options: ResolvedDataDirectory<ServiceCommandOptions>, io: CliIo): Promise<void> {
  // A logon task runs in the account's own logon session, where Credential Manager holds the key.
  if (options.kind === "task") return;
  const item = await credentialKeyItemOf(options.dataDirectory);
  if (item === undefined) return;
  const where =
    options.kind === "systemd" && options.scope !== "user"
      ? "A system unit has no login session, so it cannot read it"
      : options.kind === "systemd"
        ? "A user unit kept running with loginctl enable-linger finds the keyring locked until you log in, and cannot read it then"
        : "A LaunchAgent reads it once you are logged in; a LaunchDaemon, or an agent running before login, cannot";
  io.stderr(
    `\nwarning: the credential key for ${options.dataDirectory} is kept in the OS keychain (credentials.key only refers to it). ` +
      `${where}, and every encrypted credential fails as UNAVAILABLE. ` +
      `Move the key into the 0600 file first, as the account that owns the keychain item: tavi credentials key --to-file --data-dir ${shellWord(options.dataDirectory)}\n`,
  );
}

/** What the host the command runs on says of a unit; tests replace both. */
export interface ServiceHost {
  readonly wsl?: WslVersion;
  /** Throws when `serve` would refuse the data directory's filesystem (`assertLocalFilesystem`). */
  readonly localFilesystem?: (dataDirectory: string) => void;
  /** The account a Windows logon task is for (`DOMAIN\\user`): this one. */
  readonly windowsUser?: string;
}

function thisHost(): ServiceHost {
  const wsl = wslVersion();
  const user = process.env["USERNAME"] ?? userInfo().username;
  return {
    ...(wsl === undefined ? {} : { wsl }),
    windowsUser: `${process.env["USERDOMAIN"] ?? hostname()}\\${user}`,
  };
}

/**
 * Say what the host needs of a unit. A data directory on a 9p mount (on WSL,
 * a Windows drive) is refused by `serve`, so the unit would only restart in a
 * loop. A systemd unit made on WSL: WSL1 cannot confine Tavi's tools at all,
 * and WSL2 stops the distribution, the unit with it, once nothing uses it.
 */
function noteHost(options: ResolvedDataDirectory<ServiceCommandOptions>, host: ServiceHost, io: CliIo): void {
  if (options.kind === "systemd" && host.wsl !== undefined)
    io.stderr(`\nwarning: ${host.wsl === 1 ? WSL1_UNSUPPORTED : WSL_KEEP_RUNNING}\n`);
  try {
    (host.localFilesystem ?? assertLocalFilesystem)(resolve(options.dataDirectory));
  } catch (error) {
    io.stderr(`\nwarning: ${errorMessage(error)}\n`);
  }
}

/** `word` as one shell word, for a command the operator copies. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_./~:@%+=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The values a `serve` argument list gives `flag`, in either the spaced or `=` form. */
function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
    else if (arg === flag && args[index + 1] !== undefined) values.push(args[index + 1] as string);
  });
  return values;
}

/**
 * Who a systemd unit runs as: `--user`, else the
 * account that ran `sudo`, else a `tavi` system account the unit says how to
 * create — never root unless `--allow-root`. Every `--fs-root` the unit's
 * `serve` is given is a path it writes.
 */
function systemdOptionsOf(options: ServiceCommandOptions): SystemdServiceOptions {
  const sudoUser = process.env["SUDO_USER"];
  const user = options.user ?? (sudoUser !== undefined && sudoUser !== "" && sudoUser !== "root" ? sudoUser : undefined);
  return {
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.scope === "user"
      ? {}
      : {
          user: user ?? (options.allowRoot === true ? "root" : "tavi"),
          ...(user === undefined && options.allowRoot !== true ? { createUser: true } : {}),
        }),
    ...(options.group === undefined ? {} : { group: options.group }),
    ...(options.allowRoot === true ? { allowRoot: true } : {}),
    writablePaths: flagValues(options.serveArgs ?? [], "--fs-root").map((path) => resolve(path)),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  };
}

/** Whether a `serve` argument list names `flag`, in either the spaced or `=` form. */
function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * `tavi service unit`.
 *
 * Prints the unit; writes it only when `--out` says where. Installing needs root
 * and is the operator's decision — a CLI that quietly added a background service
 * would be doing something nobody asked it to do.
 */
export async function serviceCommand(
  options: ResolvedDataDirectory<ServiceCommandOptions>,
  io: CliIo,
  host: ServiceHost = thisHost(),
): Promise<number> {
  try {
    // `process.argv[1]` is the entry point the operator actually ran, which is
    // what a service must re-run; falling back to it rather than to a hardcoded
    // path keeps a globally-installed `tavi` working.
    const executablePath = options.executablePath === "" ? (process.argv[1] ?? "") : options.executablePath;
    if (executablePath === "") {
      io.stderr("could not determine tavi's executable path; pass --executable <path>\n");
      return EXIT.usage;
    }
    if (options.kind === "task" && options.logDirectory !== undefined) {
      io.stderr("a Windows task has no output to send to --log-dir: the owner logs to its own log file (tavi logs)\n");
      return EXIT.usage;
    }
    const logDirectory = options.logDirectory === undefined ? undefined : resolve(options.logDirectory);
    if (logDirectory !== undefined) {
      // The unit points stdout/stderr at `<log-dir>/…`; nothing else creates it, and
      // systemd fails a service whose `append:` directory is missing while launchd
      // fails to open the path. Checking it here — before rendering, and after the
      // write below — is what makes the unit start at all.
      const existing = statSync(logDirectory, { throwIfNoEntry: false });
      if (existing !== undefined && !existing.isDirectory()) {
        throw new TaviError("INVALID_INPUT", `--log-dir ${logDirectory} exists and is not a directory`);
      }
      try {
        mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
      } catch (error) {
        // A path the operator cannot create is their input, not an internal
        // failure: exit 70 would send them looking for a broken tool.
        throw new TaviError("INVALID_INPUT", `could not create --log-dir ${logDirectory}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      // `mkdirSync` ignores `mode` for a directory that already exists, so the
      // 0o700 intent is applied explicitly — but only to one this run created,
      // since tightening someone else's directory is not this command's business.
      if (existing === undefined) chmodSync(logDirectory, 0o700);
      // systemd and launchd create a missing log file with the umask (often
      // 0644); made here first, it is the owner's alone in any directory. A
      // file an earlier unit left readable is tightened too: it is Tavi's own log.
      for (const name of SERVICE_LOG_FILES) {
        const path = join(logDirectory, name);
        try {
          // Never through a link another account planted in a shared directory.
          const descriptor = openNoFollowSync(path, "append", { mode: 0o600 });
          try {
            fchmodSync(descriptor, 0o600);
          } finally {
            closeSync(descriptor);
          }
        } catch (error) {
          throw new TaviError("INVALID_INPUT", `could not create the log file ${path}: ${(error as Error).message}`, { cause: error });
        }
      }
    }

    const unit = renderServiceUnit({
      kind: options.kind,
      // Resolved like `executablePath`: both are exec targets and both formats
      // require an absolute path, so `--node node` must not reach the unit.
      nodePath: resolve(options.nodePath),
      executablePath: resolve(executablePath),
      dataDirectory: resolve(options.dataDirectory),
      label: options.label,
      ...(logDirectory === undefined ? {} : { logDirectory }),
      ...(options.serveArgs === undefined ? {} : { serveArgs: options.serveArgs }),
      ...(options.kind === "systemd" ? { systemd: systemdOptionsOf(options) } : {}),
      ...(options.kind === "task" && host.windowsUser !== undefined ? { windowsUser: host.windowsUser } : {}),
    });
    if (options.out === undefined) {
      io.stdout(unit);
      noteUndeliverableUnit(options.serveArgs ?? [], io);
      await noteKeychainKey(options, io);
      noteHost(options, host, io);
      // Last, so it is what the terminal ends on: the operator still has to place
      // the unit, so say exactly how rather than leaving the platform's directory to guess.
      const commands = installStepsOf(unit);
      // schtasks reads a task as UTF-16: a copy of the printed text saved by hand would be UTF-8, and refused.
      const save =
        options.kind === "task"
          ? `write it as UTF-16 with --out ${serviceUnitFilename(options.kind, options.label)}`
          : `save it as ${serviceUnitFilename(options.kind, options.label)}`;
      io.stderr(
        `\nReview the unit above, ${save}, then install it:\n` +
          `${commands.map((command) => `  ${command}`).join("\n")}\n` +
          `Adjust the paths first if \`tavi\` is not where this unit says it is.\n`,
      );
      return EXIT.ok;
    }
    // schtasks reads a task's XML as UTF-16, as it writes one; a byte order mark says which.
    if (options.kind === "task") writeFileSync(options.out, `\ufeff${unit}`, { encoding: "utf16le", mode: 0o644 });
    else writeFileSync(options.out, unit, { mode: 0o644 });
    io.stdout(`${options.out}\n`);
    noteUndeliverableUnit(options.serveArgs ?? [], io);
    await noteKeychainKey(options, io);
    noteHost(options, host, io);
    return EXIT.ok;
  } catch (error) {
    return reportCommandFailure(error, io, "service command failed");
  }
}
