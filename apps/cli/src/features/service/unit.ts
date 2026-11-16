import { TaviError } from "@tavi/contracts";

/**
 * Service units for `tavi serve`: what keeps it running when no one started it.
 *
 * A launchd/systemd unit is part of the unattended story, and its absence is
 * not cosmetic: the whole scheduler lives inside `tavi serve` (`serve` owns
 * the data directory exclusively), and the missed-run policy
 * can only catch a fire up if *something starts the process*. A reboot with no
 * unit means the 07:00 brief silently does not happen, and the catch-up logic
 * never runs to say so.
 *
 * Generated as text rather than installed. Writing to `/Library/LaunchDaemons`
 * or `/etc/systemd/system` needs root, and a coding agent that silently escalates
 * to install a background service on someone's machine is doing something the
 * operator did not ask for. `--out` writes the file to a path the operator can
 * review and place themselves; without it the unit is printed.
 */

export const SERVICE_UNIT_KINDS = ["launchd", "systemd", "task"] as const;
export type ServiceUnitKind = (typeof SERVICE_UNIT_KINDS)[number];

/** Default launchd label; also the plist filename stem. */
export const DEFAULT_SERVICE_LABEL = "dev.tavi.serve";

export interface RenderServiceUnitInput {
  readonly kind: ServiceUnitKind;
  /** Absolute path to the `node` binary to run. */
  readonly nodePath: string;
  /** Absolute path to `dist/executable.mjs` (or whatever wrapper the operator uses). */
  readonly executablePath: string;
  /** Absolute data directory, passed through as `--data-dir`. */
  readonly dataDirectory: string;
  /** launchd label / systemd unit name stem. */
  readonly label: string;
  /**
   * Optional absolute log directory. A service's stdout and stderr are its only
   * diagnostic channel — an unattended run that fails at 07:00 leaves its reason
   * here and nowhere else — so both formats point them at real files rather than
   * discarding them.
   *
   * The caller must have created it: systemd fails a service whose `append:`
   * target directory is missing, and launchd fails to open the path, so a unit
   * pointed at a directory that does not exist dies at start.
   */
  readonly logDirectory?: string;
  /**
   * Flags to append to `serve`, exactly as the operator would type them.
   *
   * Without these the unit starts `serve --data-dir <dir>` and **nothing else**,
   * which is not the command the operator ran interactively: an empty `messagingAllowedDestinations`
   * means `messaging.send_to` refuses every destination — so the brief fires,
   * collects, renders, and is never delivered.
   *
   * A pass-through rather than a parallel vocabulary of `--api-key-file`
   * and friends: the operator already has the command line that works, and a
   * second spelling of every `serve` flag is a second thing to keep in sync.
   */
  readonly serveArgs?: readonly string[];
  /** systemd only: who runs it, where, and what it may write. */
  readonly systemd?: SystemdServiceOptions;
  /** task only: the account (`DOMAIN\\user`) whose logon starts it, and whose it runs as. */
  readonly windowsUser?: string;
}

export const SYSTEMD_SCOPES = ["system", "user"] as const;
export type SystemdScope = (typeof SYSTEMD_SCOPES)[number];

export interface SystemdServiceOptions {
  /** `system` (the default): a system unit with `User=`; `user`: a `systemctl --user` unit, which needs `loginctl enable-linger`. */
  readonly scope?: SystemdScope;
  /** The account `serve` runs as, for a system unit; `root` is refused unless `allowRoot`. */
  readonly user?: string;
  readonly group?: string;
  /** Render a root unit anyway, with a warning header. */
  readonly allowRoot?: boolean;
  /** What the owner writes besides its data directory: every `--fs-root` (`ProtectSystem=strict` makes the rest read-only). */
  readonly writablePaths?: readonly string[];
  /**
   * `LoadCredential=<name>:<path>` lines: secrets systemd hands the unit as
   * files at `/run/credentials/<unit>/<name>`, where a `serve` flag that takes
   * a file (`--api-key-file`, …) reads them; the
   * header names each path. System units only.
   */
  readonly credentials?: readonly { readonly name: string; readonly path: string }[];
  /** Whether the account was named for this unit to create: the header says how. */
  readonly createUser?: boolean;
}

/**
 * The hardening tested compatible with bubblewrap and V8, and what is
 * left out, each with why. Directives inherited by every
 * child, so they cover `sandbox.run`, MCP servers, the PDF children, workers
 * and the browser at once.
 */
const SYSTEMD_NEVER = [
  "# Left out on purpose:",
  "#   RestrictNamespaces=      bubblewrap needs user, mount, PID and network namespaces",
  "#   PrivateUsers=            a user namespace of its own leaves bubblewrap none to make",
  "#   MemoryDenyWriteExecute=  PR_SET_MDWE is inherited and breaks V8 in Node",
  "#   ProtectControlGroups=yes a read-only /sys/fs/cgroup defeats Delegate= (resource limits)",
  "#   SystemCallFilter=        it is easy to exclude what bubblewrap needs, and ~@aio without an errno kills Node",
  "#   ProtectKernelTunables= ProtectKernelLogs= ProtectProc= ProcSubset=  may stop bubblewrap mounting /proc (unproven)",
] as const;

/**
 * Render the unit text.
 *
 * Every path is quoted and passed as a discrete argument rather than through a
 * shell, because both formats exec the binary directly: `--data-dir` with a space
 * in it would otherwise split into two arguments, and the operator would be
 * debugging a service that reads the wrong directory.
 *
 * `KeepAlive`/`Restart=always` is deliberate. This process *is* the scheduler, so
 * a crash means no brief until someone notices — and the failure alert lives
 * inside the same process, so it cannot report its own death. Restarting is the
 * only mechanism that survives the failure mode it would otherwise have to
 * announce.
 */
/**
 * Whether a value can break the *structure* of a generated unit.
 *
 * A systemd unit is line-oriented, so a newline in any interpolated field ends
 * the directive and starts a new one — arranged with balanced quoting, the
 * injected line is a valid directive such as `ExecStartPre=`. In plist XML a
 * newline is legal content, but the rest of the C0 range is not, and `xmlEscape`
 * emits it verbatim, producing a plist that strict parsers reject. Neither format
 * survives any of these, so the one predicate covers both.
 *
 * Exported because the parser applies the same rule to the operator-facing flags
 * (so the failure is a usage error, not a rendered-but-broken unit) and must not
 * drift from this one.
 */
export function hasUnsafeUnitChar(value: string): boolean {
  return value === "" || /[\u0000-\u001f\u007f]/.test(value);
}

/** The files a unit with a log directory sends serve's stdout and stderr to, in that order. */
export const SERVICE_LOG_FILES = ["tavi-serve.log", "tavi-serve.err"] as const;

export function renderServiceUnit(input: RenderServiceUnitInput): string {
  const extra = input.serveArgs ?? [];
  // Every field this function interpolates, not just the newest one: the guard
  // first covered `serveArgs` only, so a newline in `--data-dir` still injected a
  // `ExecStartPre` line into a unit the operator installs as root.
  const rendered: readonly (readonly [string, string])[] = [
    ["nodePath", input.nodePath],
    ["executablePath", input.executablePath],
    ["dataDirectory", input.dataDirectory],
    ["label", input.label],
    ...(input.logDirectory === undefined ? [] : ([["logDirectory", input.logDirectory]] as const)),
    ...extra.map((arg, index) => [`serveArgs[${index}]`, arg] as const),
  ];
  for (const [field, value] of rendered) {
    if (hasUnsafeUnitChar(value)) {
      throw new TaviError("INVALID_INPUT", `Refusing to render a unit containing an unsafe ${field}: ${JSON.stringify(value)}`);
    }
  }
  // An owner a service restarts unattended runs only approved plugins: `serve` refuses `--dev-plugin` under `TAVI_SERVICE=1`.
  if (extra.some((arg) => arg === "--dev-plugin" || arg.startsWith("--dev-plugin=")))
    throw new TaviError("INVALID_INPUT", "a service runs only approved plugins: --dev-plugin is for tavi serve in a terminal");
  const args = ["serve", "--data-dir", input.dataDirectory, ...extra];
  const logs = input.logDirectory;
  if (input.kind === "task") return renderLogonTask(input, args);
  if (input.kind === "launchd") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by \`tavi service unit\`. Review before installing, then:
     cp ${input.label}.plist ~/Library/LaunchAgents/${input.label}.plist
     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${input.label}.plist
     # ...and to remove it: launchctl bootout gui/$(id -u)/${input.label}

     Put it in ~/Library/LaunchAgents, not ~/Library/LaunchDaemons: launchd
     never loads a file from the second one, and nothing says so. It starts
     Tavi when you log in; for a computer that restarts with nobody logged
     in, install it as a LaunchDaemon in /Library/LaunchDaemons (as root)
     and bootstrap it into system/ instead. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(input.nodePath)}</string>
    <string>${xmlEscape(input.executablePath)}</string>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TAVI_SERVICE</key>
    <string>1</string>
  </dict>${
    logs === undefined
      ? ""
      : `
  <key>StandardOutPath</key>
  <string>${xmlEscape(logs)}/${SERVICE_LOG_FILES[0]}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logs)}/${SERVICE_LOG_FILES[1]}</string>`
  }
</dict>
</plist>
`;
  }
  return renderSystemdUnit(input, args, logs);
}

/**
 * The Windows logon task: started when the account logs on, as that account
 * with its least privilege (never elevated), no time limit, restarted after a
 * failure to start. Windows gives a console program a window, so the task
 * starts `serve --windowless`, which runs the owner again with none and
 * restarts it after an error exit (`windowless.ts`). A Windows
 * service is not used: it would run in session 0, with no logon session's
 * Credential Manager to hold the credential key.
 */
function renderLogonTask(input: RenderServiceUnitInput, args: readonly string[]): string {
  if (input.logDirectory !== undefined)
    throw new TaviError(
      "INVALID_INPUT",
      "a Windows task has no output to send to --log-dir: the owner logs to its own log file (tavi logs)",
    );
  // The label is named in the header, an XML comment, which "--" would end early.
  if (input.label.includes("--")) throw new TaviError("INVALID_INPUT", `Refusing to render a task labelled ${JSON.stringify(input.label)}`);
  const user = input.windowsUser;
  if (user === undefined || hasUnsafeUnitChar(user))
    throw new TaviError("INVALID_INPUT", `Refusing to render a task for the account ${JSON.stringify(user ?? "")}`);
  const file = serviceUnitFilename("task", input.label);
  return `<?xml version="1.0" encoding="UTF-16"?>
<!-- Generated by \`tavi service unit\`. Review before installing, then:
     schtasks /Create /TN "${xmlEscape(input.label)}" /XML "${xmlEscape(file)}"
     # ...and to remove it: schtasks /Delete /TN "${xmlEscape(input.label)}" /F

     Saved by tavi service unit's out option, the file is UTF-16, as
     schtasks reads it (an XML comment cannot name the option itself). Where
     a policy forbids your account to create tasks, put a shortcut to the
     same command in shell:startup instead (the Startup folder): it starts at
     logon too, but is not restarted after a failure. -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Tavi agent runtime (serve, with its scheduler)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <AllowStartOnDemand>true</AllowStartOnDemand>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(input.nodePath)}</Command>
      <Arguments>${xmlEscape(windowsCommandLine([input.executablePath, ...args, "--windowless"]))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Arguments as one Windows command line, each read back whole by the C
 * runtime's parsing (\`CommandLineToArgvW\`): quoted when it holds a space, a
 * tab or a quote, with a quote, and the backslashes before one, escaped.
 */
export function windowsCommandLine(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg !== "" && !/[\s"]/.test(arg)) return arg;
      const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
      return `"${escaped}"`;
    })
    .join(" ");
}

/** A value a systemd directive takes whole: no whitespace or control character, so it cannot split or inject. */
function systemdWord(field: string, value: string): string {
  if (!/^[^\s\u0000-\u001f\u007f]+$/.test(value))
    throw new TaviError("INVALID_INPUT", `Refusing to render a unit with ${field} ${JSON.stringify(value)}: it must be one word`);
  return value;
}

/**
 * The systemd unit: non-root by default and hardened. A root
 * account is refused unless `allowRoot`, which says so in a header; a user
 * unit runs under the operator's own manager. `Restart=always` for the same
 * reason as `KeepAlive` above; `WantedBy=multi-user.target` (system) so a
 * reboot starts it without a login.
 */
function renderSystemdUnit(input: RenderServiceUnitInput, args: readonly string[], logs: string | undefined): string {
  const options = input.systemd ?? {};
  const scope = options.scope ?? "system";
  const user = options.user === undefined ? undefined : systemdWord("User=", options.user);
  const group = options.group === undefined ? undefined : systemdWord("Group=", options.group);
  const root = scope === "system" && (user === undefined || user === "root" || user === "0");
  if (root && options.allowRoot !== true) {
    throw new TaviError(
      "INVALID_INPUT",
      "a root service is refused: srt as root needs CAP_SETFCAP and is weaker. Pass --user <name> (the account serve runs as), or --scope user for a systemctl --user unit; --allow-root renders it anyway",
    );
  }
  // A system unit's filesystem is read-only but for these (`ProtectSystem=strict`): its log directory among them.
  const writable = [input.dataDirectory, ...(options.writablePaths ?? []), ...(scope === "system" && logs !== undefined ? [logs] : [])];
  // One word each: a space-separated list cannot carry a path with whitespace unambiguously.
  for (const path of writable)
    if (hasUnsafeUnitChar(path) || /\s/.test(path))
      throw new TaviError(
        "INVALID_INPUT",
        `Refusing to render a unit whose writable path ${JSON.stringify(path)} holds whitespace or a control character; move it to a path without`,
      );
  if (scope === "user" && (options.credentials ?? []).length > 0)
    throw new TaviError("INVALID_INPUT", "--credential is for a system unit; a user unit reads its secrets as the operator does");
  const underHome = writable.some((path) => path === "/home" || path.startsWith("/home/") || path === "/root" || path.startsWith("/root/"));
  const credentials = (options.credentials ?? []).map(
    (credential) =>
      `LoadCredential=${systemdWord("a credential name", credential.name)}:${systemdPathEscape(systemdWord("a credential path", credential.path))}`,
  );
  const header =
    scope === "user"
      ? `# Generated by \`tavi service unit --scope user\`. Review before installing:
#   mkdir -p ~/.config/systemd/user && cp ${input.label}.service ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now ${input.label}
#   loginctl enable-linger "$USER"   # so it runs without a login, and after a reboot`
      : `# Generated by \`tavi service unit\`. Review before installing:
#   sudo cp ${input.label}.service /etc/systemd/system/${input.label}.service
#   sudo systemctl daemon-reload && sudo systemctl enable --now ${input.label}${
          options.createUser === true && user !== undefined
            ? `
# It runs as ${user}, an account to create first, with its home where the unit may write it:
#   sudo useradd --system --home-dir /var/lib/${user} --create-home --shell /usr/sbin/nologin ${user}`
            : ""
        }${
          user !== undefined && !root
            ? `
# Its data directory must be ${user}'s:
#   sudo install -d -o ${user} -m 0700 ${input.dataDirectory}`
            : ""
        }${(options.credentials ?? [])
          .map(
            (credential) => `
# Credential ${credential.name} reaches serve as /run/credentials/${input.label}.service/${credential.name} (pass that path to the flag that reads it)`,
          )
          .join("")}${
          root
            ? `
# WARNING: this unit runs serve as root (--allow-root). srt as root needs CAP_SETFCAP and is
# weaker, and Tavi warns at every start; --user <name> is the supported way.`
            : ""
        }`;
  // In a user manager the mount and privilege directives need a user namespace of their own, which bubblewrap must not lose.
  const hardening =
    scope === "user"
      ? [
          "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
          "NoNewPrivileges=yes",
          "LockPersonality=yes",
          "SystemCallArchitectures=native",
        ]
      : [
          // Every descendant inherits it: AF_ALG, AF_PACKET, AF_VSOCK and the rest are closed to every sandbox.
          "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
          "NoNewPrivileges=yes",
          "PrivateTmp=yes",
          "ProtectSystem=strict",
          // The created account's home is writable for its caches; `-` because it may not exist yet.
          `ReadWritePaths=${[...writable, ...(options.createUser === true && user !== undefined ? [`-/var/lib/${user}`] : [])].map(systemdPathEscape).join(" ")}`,
          ...(underHome ? ["# ProtectHome= is left out: a folder serve writes is under /home"] : ["ProtectHome=read-only"]),
          "ProtectKernelModules=yes",
          "RestrictSUIDSGID=yes",
          "LockPersonality=yes",
          "SystemCallArchitectures=native",
          // Resource limits: the unit's cgroup handed to serve, which keeps itself in owner/ and every sandbox under sbx/.
          "Delegate=memory pids cpu",
          // systemd 254+; older systemd ignores it with a warning, and serve moves itself into owner/.
          "DelegateSubgroup=owner",
          // The srt host processes' sockets live here, outside the denied temporary directory.
          "RuntimeDirectory=tavi",
          "RuntimeDirectoryMode=0700",
        ];
  return `${header}
[Unit]
Description=Tavi agent runtime (serve, with its scheduler)
After=network-online.target

[Service]
Type=simple
${scope === "system" && user !== undefined && !root ? `User=${user}\n` : ""}${scope === "system" && group !== undefined ? `Group=${group}\n` : ""}ExecStart=${systemdEscape([input.nodePath, input.executablePath, ...args])}
Environment=TAVI_SERVICE=1
Restart=always
RestartSec=5${
    logs === undefined
      ? ""
      : `
StandardOutput=append:${systemdPathEscape(`${logs}/${SERVICE_LOG_FILES[0]}`)}
StandardError=append:${systemdPathEscape(`${logs}/${SERVICE_LOG_FILES[1]}`)}`
  }
${[...hardening, ...credentials].join("\n")}
${SYSTEMD_NEVER.join("\n")}

[Install]
WantedBy=${scope === "user" ? "default.target" : "multi-user.target"}
`;
}

/** The filename an operator should save the unit under. */
export function serviceUnitFilename(kind: ServiceUnitKind, label: string): string {
  return kind === "launchd" ? `${label}.plist` : kind === "task" ? `${label}.xml` : `${label}.service`;
}

/**
 * The steps a rendered unit's own header gives for installing it, one command
 * a line: what follows "then install it:" when the unit is printed, so the
 * two never say different things.
 */
export function installStepsOf(unit: string): readonly string[] {
  const steps: string[] = [];
  for (const line of unit.split("\n")) {
    // systemd: `#   <command>`; launchd: the indented commands in the opening comment, up to its first blank line.
    const command = /^#\s{3}(\S.*)$/.exec(line)?.[1] ?? /^\s{5}(\S.*)$/.exec(line)?.[1];
    // A comment within it (how to remove it) is not a step.
    if (command !== undefined && !command.startsWith("#")) steps.push(command);
    else if (command !== undefined) continue;
    else if (steps.length > 0) break;
  }
  return steps;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * systemd's `ExecStart` is a command *line*, not an argv array, so each argument
 * is quoted and internal quotes escaped per systemd's own rules — which are not
 * shell rules, and are stricter about what may be unquoted.
 */
function systemdEscape(args: readonly string[]): string {
  return args.map((arg) => `"${systemdCommandEscape(arg)}"`).join(" ");
}

/**
 * Escape a *command line* value: quoting, plus the two substitutions systemd
 * performs on `ExecStart` — specifiers (`%%`) and environment variables (`$$`).
 */
function systemdCommandEscape(value: string): string {
  return systemdValueEscape(value);
}

/**
 * Escape a *file path* value (`StandardOutput=append:…`).
 *
 * Only specifiers are expanded there — `config_parse_exec_output` runs the value
 * through `unit_path_printf` and nothing else — so `$` is literal and doubling it
 * would name a directory that does not exist. A single escaper for both contexts
 * silently broke `--log-dir` for any path containing `$`, which is the exact
 * "named a directory nothing created" failure this command was just fixed for.
 */
function systemdPathEscape(value: string): string {
  return value.replace(/%/g, "%%");
}

/**
 * Escape a value for a context where systemd itself does substitution, not just
 * a shell.
 *
 * Quoting handles whitespace; it does **not** handle systemd's own two
 * expansions. `%` begins a specifier (`%y` and friends) and an unrecognized one
 * makes the unit fail to load — "Failed to resolve unit specifiers" — while
 * `$VAR` in `ExecStart` is expanded by systemd, so a data directory containing
 * `$HOME` silently becomes a *different* directory. Both are doubled to escape,
 * exactly as systemd's own documentation specifies. Quoting alone looked
 * sufficient and was not: the operator's path is arbitrary text.
 */
function systemdValueEscape(value: string): string {
  // `$$` in a `replace` *replacement* is itself an escape for a literal `$`, so
  // emitting two dollars needs four — writing `"$$"` produced one, which is
  // exactly the unescaped state the doubling exists to avoid. (Caught by the
  // test, not by reading it.)
  return (
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      // Only `$$` is special in a replacement string; `%%` is not, so the two
      // characters need different spellings to both end up doubled.
      .replace(/%/g, "%%")
      .replace(/\$/g, "$$$$")
  );
}
