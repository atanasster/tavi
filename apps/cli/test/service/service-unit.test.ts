import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import {
  DEFAULT_SERVICE_LABEL,
  installStepsOf,
  renderServiceUnit,
  serviceUnitFilename,
  windowsCommandLine,
} from "../../src/features/service/unit.js";
import { WINDOWLESS_FINAL, WINDOWLESS_RESTART_MS, runWindowless } from "../../src/server/windowless.js";
import { serviceCommand } from "../../src/features/service/client.js";
import { planningReferences } from "../support/planning-reference.js";

/**
 * Service units.
 *
 * A launchd/systemd unit is the one piece
 * of the unattended story whose absence is invisible until it matters: the whole
 * scheduler lives inside `tavi serve`, so a reboot with no unit means the 07:00
 * brief silently does not happen and the missed-run catch-up has nothing to run
 * in. Generated rather than installed — placing it needs root, and a CLI that
 * quietly added a background service would be doing something nobody asked for.
 */

const directories = temporaryDirectories({ prefix: "tavi-service-" });

afterEach(() => directories.cleanup());

const BASE = {
  nodePath: "/usr/local/bin/node",
  executablePath: "/opt/tavi/dist/executable.mjs",
  dataDirectory: "/Users/operator/.tavi",
  label: DEFAULT_SERVICE_LABEL,
  // A system unit runs as an ordinary account.
  systemd: { user: "tavi" },
} as const;

describe("renderServiceUnit", () => {
  it("renders a launchd unit that runs serve with the data directory and restarts on death", () => {
    const unit = renderServiceUnit({ ...BASE, kind: "launchd" });
    expect(unit).toContain("<key>Label</key>");
    expect(unit).toContain(DEFAULT_SERVICE_LABEL);
    // The arguments are discrete array entries, not one shell string: a
    // `--data-dir` with a space in it would otherwise split into two.
    expect(unit).toContain("<string>serve</string>");
    expect(unit).toContain("<string>--data-dir</string>");
    expect(unit).toContain(`<string>${BASE.dataDirectory}</string>`);
    // The process *is* the scheduler and the failure alert lives inside it, so
    // it cannot announce its own death — restarting is the only mechanism that
    // survives the failure it would otherwise have to report.
    expect(unit).toContain("<key>KeepAlive</key>");
    expect(unit).toContain("<key>RunAtLoad</key>");
    expect(unit).toContain("<!DOCTYPE plist");
  });

  it("renders a systemd unit that starts on boot and restarts on death", () => {
    const unit = renderServiceUnit({ ...BASE, kind: "systemd" });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain(`ExecStart="${BASE.nodePath}" "${BASE.executablePath}" "serve" "--data-dir" "${BASE.dataDirectory}"`);
  });

  it("escapes what each format treats specially", () => {
    // A data directory is operator-supplied and may contain a space, an
    // ampersand or a quote; each format has its own escaping rules and neither
    // is the shell's.
    const hostile = "/Users/op/My Data & <stuff>";
    const plist = renderServiceUnit({ ...BASE, kind: "launchd", dataDirectory: hostile });
    expect(plist).toContain("/Users/op/My Data &amp; &lt;stuff&gt;");
    expect(plist).not.toContain("& <stuff>");

    const systemd = renderServiceUnit({ ...BASE, kind: "systemd", dataDirectory: '/Users/op/a"b' });
    expect(systemd).toContain('"/Users/op/a\\"b"');
  });

  it("points stdout and stderr at real files when a log directory is given", () => {
    // A service's output is its only diagnostic channel: an unattended run that
    // fails at 07:00 leaves its reason there and nowhere else.
    const plist = renderServiceUnit({ ...BASE, kind: "launchd", logDirectory: "/var/log/tavi" });
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain("/var/log/tavi/tavi-serve.err");
    const systemd = renderServiceUnit({ ...BASE, kind: "systemd", logDirectory: "/var/log/tavi" });
    expect(systemd).toContain("StandardError=append:/var/log/tavi/tavi-serve.err");
    // And nothing invents a log path when none was asked for.
    expect(renderServiceUnit({ ...BASE, kind: "systemd" })).not.toContain("StandardError=");
  });

  it("points launchd at a directory launchd actually reads, and says it starts at login", () => {
    // The first version printed `~/Library/LaunchDaemons`, which is not a launchd
    // directory (man 5 launchd.plist lists LaunchAgents in $HOME and
    // LaunchDaemons under /Library) — so following the instructions produced a
    // unit launchd never loaded, silently: exactly the missed brief this file
    // exists to prevent. `/Users/<user>/Library/LaunchDaemons` does not even
    // exist on a stock macOS install.
    const plist = renderServiceUnit({ ...BASE, kind: "launchd" });
    // The *install command* must name a real directory (the surrounding prose
    // names the wrong one deliberately, to explain why it is wrong).
    expect(plist).toContain("cp dev.tavi.serve.plist ~/Library/LaunchAgents/");
    expect(plist).not.toContain("cp dev.tavi.serve.plist ~/Library/LaunchDaemons/");
    // `launchctl load` is deprecated; the modern verb is named instead.
    expect(plist).toContain("launchctl bootstrap gui/$(id -u)");
    // And the limitation is stated rather than left for the operator to discover
    // when a reboot with nobody logged in produces no brief.
    expect(plist).toMatch(/It starts\s+Tavi when you log in/);
    expect(plist).toContain("/Library/LaunchDaemons (as root)");
  });

  it("escapes the systemd-special characters that quoting does not cover", () => {
    // systemd applies its own substitution, so quoting alone is not escaping: an
    // unrecognized `%` specifier makes the unit fail to load, and `$VAR` expands
    // silently to a different path.
    const unit = renderServiceUnit({
      ...BASE,
      kind: "systemd",
      dataDirectory: "/srv/tavi/%y",
      logDirectory: "/var/log/tavi",
    });
    expect(unit).toContain('"--data-dir" "/srv/tavi/%%y"');
    expect(unit).not.toContain('"/srv/tavi/%y"');
    const dollar = renderServiceUnit({ ...BASE, kind: "systemd", dataDirectory: "/srv/$HOME/tavi" });
    expect(dollar).toContain('"/srv/$$HOME/tavi"');
    expect(dollar).not.toContain('"/srv/$HOME/tavi"');
  });

  it("names the file the platform expects", () => {
    expect(serviceUnitFilename("launchd", "dev.tavi.serve")).toBe("dev.tavi.serve.plist");
    expect(serviceUnitFilename("systemd", "dev.tavi.serve")).toBe("dev.tavi.serve.service");
  });
});

describe("tavi service unit", () => {
  it("prints a unit for the host's init system and says how to install it", async () => {
    const printed = capture();
    expect(await main(["service", "unit", "--data-dir", "/tmp/tavi-service-unit"], { io: printed.io })).toBe(EXIT.ok);
    expect(printed.stdout()).toContain('<plist version="1.0">');
    expect(printed.stdout()).toContain("/tmp/tavi-service-unit");
    // Nothing is installed: the operator is told what to do with it instead.
    // Last, the commands that install it: what the terminal ends on.
    expect(printed.stderr()).toMatch(
      /Review the unit above, save it as dev\.tavi\.serve\.plist, then install it:\n {2}cp dev\.tavi\.serve\.plist ~\/Library\/LaunchAgents\/dev\.tavi\.serve\.plist\n {2}launchctl bootstrap gui\/\$\(id -u\) ~\/Library\/LaunchAgents\/dev\.tavi\.serve\.plist\nAdjust the paths first/,
    );
    expect(printed.stderr().trimEnd().endsWith("Adjust the paths first if `tavi` is not where this unit says it is.")).toBe(true);
  });

  it("on WSL warns that WSL1 is unsupported, or what keeps WSL2 running; elsewhere says nothing of it", async () => {
    const options = {
      action: "unit" as const,
      kind: "systemd" as const,
      dataDirectory: directories.create("tavi-service-wsl-"),
      executablePath: "/opt/tavi/main.js",
      nodePath: "/usr/bin/node",
      label: DEFAULT_SERVICE_LABEL,
    };
    const local = (): void => undefined;
    const wsl2 = capture();
    expect(await serviceCommand(options, wsl2.io, { wsl: 2, localFilesystem: local })).toBe(EXIT.ok);
    expect(wsl2.stderr()).toContain("vmIdleTimeout=-1");
    const wsl1 = capture();
    expect(await serviceCommand(options, wsl1.io, { wsl: 1, localFilesystem: local })).toBe(EXIT.ok);
    expect(wsl1.stderr()).toContain("WSL1 is not supported");
    const plain = capture();
    expect(await serviceCommand(options, plain.io, { localFilesystem: local })).toBe(EXIT.ok);
    expect(plain.stderr()).not.toMatch(/WSL/);
    // A launchd unit made on WSL for another machine carries no WSL advice.
    const launchd = capture();
    expect(await serviceCommand({ ...options, kind: "launchd" }, launchd.io, { wsl: 2, localFilesystem: local })).toBe(EXIT.ok);
    expect(launchd.stderr()).not.toMatch(/WSL/);
  });

  it("warns, before it is installed, when serve would refuse the data directory's filesystem", async () => {
    const refused = capture();
    const ninePee = (): void => {
      throw new Error("Data directory /mnt/c/tavi is on a Windows drive or another 9p mount");
    };
    const options = {
      action: "unit" as const,
      kind: "systemd" as const,
      dataDirectory: "/mnt/c/tavi",
      executablePath: "/opt/tavi/main.js",
      nodePath: "/usr/bin/node",
      label: DEFAULT_SERVICE_LABEL,
    };
    expect(await serviceCommand(options, refused.io, { localFilesystem: ninePee })).toBe(EXIT.ok);
    expect(refused.stderr()).toContain("warning: Data directory /mnt/c/tavi is on a Windows drive or another 9p mount");
  });

  it("honours an explicit --kind, so a unit can be generated for another machine", async () => {
    const printed = capture();
    expect(await main(["service", "unit", "--kind", "systemd", "--data-dir", "/tmp/x"], { io: printed.io })).toBe(EXIT.ok);
    expect(printed.stdout()).toContain("[Service]");
    expect(printed.stderr()).toContain("dev.tavi.serve.service");
  });

  it("writes the unit to --out instead of printing it", async () => {
    const directory = directories.create("tavi-service-");
    const out = join(directory, "dev.tavi.serve.plist");
    const result = capture();
    expect(await main(["service", "unit", "--data-dir", "/tmp/x", "--out", out], { io: result.io })).toBe(EXIT.ok);
    expect(result.stdout().trim()).toBe(out);
    expect(readFileSync(out, "utf8")).toContain("<key>Label</key>");
  });

  it("rejects a label that would inject directives into the generated unit", async () => {
    const injected = capture();
    expect(await main(["service", "unit", "--label", "a\n[Unit]\nDescription=injected", "--data-dir", "/tmp/x"], { io: injected.io })).toBe(
      EXIT.usage,
    );
    expect(injected.stderr()).toMatch(/--label must match/);
    expect(injected.stdout()).not.toContain("Description=injected");
  });

  it("rejects an unknown kind and an unknown action as usage errors", async () => {
    const badKind = capture();
    expect(await main(["service", "unit", "--kind", "upstart"], { io: badKind.io })).toBe(EXIT.usage);
    expect(badKind.stderr()).toMatch(/--kind must be one of/);
    const badAction = capture();
    expect(await main(["service", "install"], { io: badAction.io })).toBe(EXIT.usage);
    expect(badAction.stderr()).toMatch(/Unknown service action/);
  });

  it("documents its own flags on --help", async () => {
    const shown = capture();
    expect(await main(["service", "--help"], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toContain("Generate the launchd/systemd unit");
    expect(shown.stdout()).toMatch(/--log-dir <path>/);
    expect(shown.stdout()).toMatch(/--serve-arg <arg>/);
  });

  it("carries the serve flags the unit needs to deliver, in both formats", () => {
    // Without these the unit runs `serve --data-dir <dir>` and nothing else: no
    // connector is opened and `messaging.send_to` refuses every destination, so
    // the brief fires, renders and is never delivered.
    const serveArgs = ["--api-key-file", "/etc/tavi/model.key", "--messaging-allow-destination", "8346819670"];
    const launchd = renderServiceUnit({ ...BASE, kind: "launchd", serveArgs });
    for (const arg of serveArgs) expect(launchd).toContain(`<string>${arg}</string>`);
    const systemd = renderServiceUnit({ ...BASE, kind: "systemd", serveArgs });
    expect(systemd).toContain("--api-key-file");
    expect(systemd).toContain("/etc/tavi/model.key");
    expect(systemd).toContain("8346819670");
  });

  it("refuses a serve argument that would break out of the unit's own syntax", () => {
    // A newline injects a plist key or a systemd directive; the parser refuses it
    // too, but the renderer is the boundary that must hold.
    expect(() => renderServiceUnit({ ...BASE, kind: "systemd", serveArgs: ["ok", "bad\nUser=root"] })).toThrow(/unsafe serveArgs/);
    expect(() => renderServiceUnit({ ...BASE, kind: "launchd", serveArgs: [""] })).toThrow(/unsafe serveArgs/);
    // And the fields the first version of the guard missed: a newline in
    // `--data-dir` injected a valid `ExecStartPre` line into a unit the operator
    // installs as root.
    expect(() => renderServiceUnit({ ...BASE, kind: "systemd", dataDirectory: '/tmp/x"\nExecStartPre=/bin/sh -c "echo pwned' })).toThrow(
      /unsafe dataDirectory/,
    );
    expect(() => renderServiceUnit({ ...BASE, kind: "launchd", logDirectory: "/tmp/\u0001" })).toThrow(/unsafe logDirectory/);
  });

  it("escapes specifiers but not `$` in the log path, where systemd does not expand it", () => {
    // `StandardOutput=append:` runs through `unit_path_printf` only, so `$$` stays
    // two characters there — a `$` in `--log-dir` named a directory that did not
    // exist, which is the "unit cannot start" failure this command was just fixed
    // for. On the command line, `$$` is the correct escape.
    const systemd = renderServiceUnit({ ...BASE, kind: "systemd", logDirectory: "/tmp/l$/x", serveArgs: ["--data-dir", "/tmp/$HOME"] });
    expect(systemd).toContain("StandardOutput=append:/tmp/l$/x/tavi-serve.log");
    expect(systemd).toContain("$$HOME");
  });

  it("creates the log directory it names, and says when the unit cannot deliver", async () => {
    const directory = directories.create();
    const logs = join(directory, "logs");
    const written = capture();
    const code = await main(
      ["service", "unit", "--kind", "systemd", "--data-dir", directory, "--log-dir", logs, "--out", join(directory, "unit.service")],
      { io: written.io },
    );
    expect(code, written.stderr()).toBe(EXIT.ok);
    // The unit names <logs>/tavi-serve.log; nothing else creates it, and systemd
    // fails a service whose `append:` directory is missing.
    expect(readFileSync(join(directory, "unit.service"), "utf8")).toContain(`${logs}/tavi-serve.err`);
    expect(statSync(logs).isDirectory()).toBe(true);
    // Its log files too, readable by their owner alone whatever the umask.
    for (const name of ["tavi-serve.log", "tavi-serve.err"]) expect(statSync(join(logs, name)).mode & 0o777).toBe(0o600);
    // A unit with no destination is reported, not shipped quietly.
    expect(written.stderr()).toMatch(/without `messaging.send_to` destinations/);
  });

  it("tightens a log file an earlier unit left readable in an existing --log-dir, and keeps what it holds", async () => {
    const directory = directories.create();
    const logs = join(directory, "logs");
    mkdirSync(logs, { mode: 0o755 });
    writeFileSync(join(logs, "tavi-serve.log"), "earlier\n", { mode: 0o644 });
    chmodSync(join(logs, "tavi-serve.log"), 0o644);
    const printed = capture();
    expect(await main(["service", "unit", "--kind", "systemd", "--data-dir", directory, "--log-dir", logs], { io: printed.io })).toBe(
      EXIT.ok,
    );
    expect(statSync(join(logs, "tavi-serve.log")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(logs, "tavi-serve.log"), "utf8")).toBe("earlier\n");
    expect(statSync(join(logs, "tavi-serve.err")).mode & 0o777).toBe(0o600);
    // Someone else's directory is left as it was.
    expect(statSync(logs).mode & 0o777).toBe(0o755);
  });

  it("refuses a log file that is a link, and leaves the file it points at alone", async () => {
    const directory = directories.create();
    const logs = join(directory, "logs");
    mkdirSync(logs, { mode: 0o755 });
    const target = join(directory, "elsewhere.txt");
    writeFileSync(target, "kept\n");
    chmodSync(target, 0o644);
    symlinkSync(target, join(logs, "tavi-serve.log"));
    const printed = capture();
    expect(await main(["service", "unit", "--kind", "systemd", "--data-dir", directory, "--log-dir", logs], { io: printed.io })).not.toBe(
      EXIT.ok,
    );
    expect(printed.stderr()).toMatch(/could not create the log file/);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(readFileSync(target, "utf8")).toBe("kept\n");
  });

  it("accepts a flag-shaped --serve-arg in the space form the help documents", async () => {
    const directory = directories.create();
    const written = capture();
    // `flagValue`'s ambiguity guard rejected any value starting with `--`, and
    // every argument an operator needs here is flag-shaped — so the documented
    // form was the one form that did not work.
    const code = await main(
      [
        "service",
        "unit",
        "--kind",
        "systemd",
        "--data-dir",
        directory,
        "--serve-arg",
        "--api-key-file",
        "--serve-arg",
        "/etc/tavi/model.key",
        "--out",
        join(directory, "unit.service"),
      ],
      { io: written.io },
    );
    expect(code, written.stderr()).toBe(EXIT.ok);
    expect(readFileSync(join(directory, "unit.service"), "utf8")).toContain("/etc/tavi/model.key");
  });

  it("treats an unusable --log-dir as a usage error, not as an internal failure", async () => {
    const directory = directories.create();
    const blocked = join(directory, "a-file");
    writeFileSync(blocked, "not a directory", { mode: 0o600 });
    const failed = capture();
    // Exit 70 would say "the tool is broken" and send the operator to the wrong
    // place; the path they typed is the problem.
    expect(await main(["service", "unit", "--data-dir", directory, "--log-dir", blocked], { io: failed.io })).toBe(EXIT.usage);
    expect(failed.stderr()).toMatch(/exists and is not a directory/);
  });

  it("resolves a relative --node, because both exec targets must be absolute", async () => {
    const directory = directories.create();
    const written = capture();
    const code = await main(
      ["service", "unit", "--kind", "systemd", "--node", "node", "--data-dir", directory, "--out", join(directory, "unit.service")],
      { io: written.io },
    );
    expect(code, written.stderr()).toBe(EXIT.ok);
    const unit = readFileSync(join(directory, "unit.service"), "utf8");
    expect(unit).not.toContain('"node"');
    expect(unit).toMatch(/ExecStart="\/[^"]*node"/);
  });

  it("stays quiet when the unit carries a destination, an HTTP host and a model credential", async () => {
    const directory = directories.create();
    const done = capture();
    const code = await main(
      [
        "service",
        "unit",
        "--kind",
        "systemd",
        "--data-dir",
        directory,
        "--serve-arg=--api-key-file",
        "--serve-arg=/etc/tavi/model.key",
        "--serve-arg=--http-allow-host",
        "--serve-arg=api.example.com",
        "--serve-arg=--messaging-allow-destination",
        "--serve-arg=8346819670",
        "--out",
        join(directory, "unit.service"),
      ],
      { io: done.io },
    );
    expect(code, done.stderr()).toBe(EXIT.ok);
    expect(done.stderr()).not.toMatch(/warning:/);
    const unit = readFileSync(join(directory, "unit.service"), "utf8");
    expect(unit).toContain("/etc/tavi/model.key");
    expect(unit).toContain("8346819670");
  });
});

describe("the systemd unit's account and hardening", () => {
  it("runs as an ordinary account, with the hardening every sandbox inherits, and says why each risky directive is absent", () => {
    const unit = renderServiceUnit({
      ...BASE,
      kind: "systemd",
      dataDirectory: "/var/lib/tavi",
      systemd: {
        user: "tavi",
        group: "tavi",
        writablePaths: ["/srv/projects"],
        credentials: [{ name: "model-key", path: "/etc/tavi/model.key" }],
      },
    });
    for (const line of [
      "User=tavi",
      "Group=tavi",
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
      "NoNewPrivileges=yes",
      "PrivateTmp=yes",
      "ProtectSystem=strict",
      "ReadWritePaths=/var/lib/tavi /srv/projects",
      "ProtectHome=read-only",
      "ProtectKernelModules=yes",
      "RestrictSUIDSGID=yes",
      "LockPersonality=yes",
      "SystemCallArchitectures=native",
      "RuntimeDirectory=tavi",
      "RuntimeDirectoryMode=0700",
      "Delegate=memory pids cpu",
      "DelegateSubgroup=owner",
      "LoadCredential=model-key:/etc/tavi/model.key",
    ]) {
      expect(unit).toContain(`${line}\n`);
    }
    // Never set, and each named with its reason in a comment.
    for (const directive of [
      "RestrictNamespaces=",
      "PrivateUsers=",
      "MemoryDenyWriteExecute=",
      "ProtectControlGroups=yes",
      "SystemCallFilter=",
    ]) {
      expect(unit).not.toMatch(new RegExp(`^${directive}`, "m"));
      expect(unit).toMatch(new RegExp(`^#\\s+${directive.replace(/[=]/g, "=")}`, "m"));
    }
  });

  it("cites no internal planning record in a system, a user or a root unit", () => {
    for (const systemd of [{ user: "tavi" }, { scope: "user" as const }, { user: "root", allowRoot: true }]) {
      expect(planningReferences(renderServiceUnit({ ...BASE, kind: "systemd", systemd }))).toEqual([]);
    }
    expect(planningReferences(renderServiceUnit({ ...BASE, kind: "launchd" }))).toEqual([]);
  });

  it("lets a system unit write its log directory, and leaves the umask to the account", () => {
    const system = renderServiceUnit({
      ...BASE,
      kind: "systemd",
      dataDirectory: "/var/lib/tavi",
      logDirectory: "/var/log/tavi",
      systemd: { user: "tavi" },
    });
    expect(system).toContain("ReadWritePaths=/var/lib/tavi /var/log/tavi\n");
    const user = renderServiceUnit({ ...BASE, kind: "systemd", logDirectory: "/home/op/logs", systemd: { scope: "user" } });
    // A process-wide umask would make every file the agent writes in an --fs-root folder private too.
    expect(system).not.toMatch(/^UMask=/m);
    expect(user).not.toMatch(/^UMask=/m);
    expect(user).not.toMatch(/^ReadWritePaths=/m);
  });

  it("leaves ProtectHome out when serve writes under /home", () => {
    const unit = renderServiceUnit({ ...BASE, kind: "systemd", dataDirectory: "/home/op/.tavi", systemd: { user: "op" } });
    expect(unit).not.toMatch(/^ProtectHome=/m);
    expect(unit).toContain("ReadWritePaths=/home/op/.tavi");
  });

  it("refuses a root unit unless asked, and then says so in its header", () => {
    expect(() => renderServiceUnit({ ...BASE, kind: "systemd", systemd: { user: "root" } })).toThrow(/root service is refused/);
    expect(() => renderServiceUnit({ ...BASE, kind: "systemd", systemd: {} })).toThrow(/root service is refused/);
    const root = renderServiceUnit({ ...BASE, kind: "systemd", systemd: { user: "root", allowRoot: true } });
    expect(root).toContain("WARNING: this unit runs serve as root");
    expect(root).not.toMatch(/^User=/m);
  });

  it("renders a user unit for systemctl --user, with linger named", () => {
    const unit = renderServiceUnit({ ...BASE, kind: "systemd", systemd: { scope: "user" } });
    expect(unit).toContain("loginctl enable-linger");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/^ProtectSystem=/m);
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK");
  });

  it("refuses an account name that would split a directive", () => {
    expect(() => renderServiceUnit({ ...BASE, kind: "systemd", systemd: { user: "tavi\nExecStartPre=/bin/sh" } })).toThrow(/one word/);
  });

  it("resolves the account from the command line: --user, the sudo user, else a tavi account to create; --fs-root is writable", async () => {
    const printed = capture();
    const previous = process.env["SUDO_USER"];
    delete process.env["SUDO_USER"];
    try {
      expect(
        await main(
          ["service", "unit", "--kind", "systemd", "--data-dir", "/var/lib/tavi", "--serve-arg=--fs-root", "--serve-arg=/srv/projects"],
          { io: printed.io },
        ),
      ).toBe(EXIT.ok);
      expect(printed.stdout()).toContain("User=tavi");
      expect(printed.stdout()).toContain("sudo useradd --system");
      expect(printed.stdout()).toContain("ReadWritePaths=/var/lib/tavi /srv/projects");
      process.env["SUDO_USER"] = "operator";
      const again = capture();
      expect(await main(["service", "unit", "--kind", "systemd", "--data-dir", "/var/lib/tavi"], { io: again.io })).toBe(EXIT.ok);
      expect(again.stdout()).toContain("User=operator");
      const refused = capture();
      expect(
        await main(["service", "unit", "--kind", "systemd", "--data-dir", "/var/lib/tavi", "--user", "root"], { io: refused.io }),
      ).not.toBe(EXIT.ok);
      expect(refused.stderr()).toMatch(/root service is refused/);
    } finally {
      if (previous === undefined) delete process.env["SUDO_USER"];
      else process.env["SUDO_USER"] = previous;
    }
  });
});

describe("tavi service unit and a credential key kept in the keychain", () => {
  /** A data directory whose credentials.key only refers to a keychain item. */
  function keychainKeyed(): string {
    const directory = directories.create("tavi-service-key-");
    writeFileSync(join(directory, "credentials.key"), `tavi-keychain:v1:libsecret:${"a".repeat(32)}\n`, { mode: 0o600 });
    return directory;
  }

  it("warns a system unit cannot read the key, naming the command that moves it to a file", async () => {
    const directory = keychainKeyed();
    const printed = capture();
    expect(
      await main(["service", "unit", "--kind", "systemd", "--scope", "system", "--user", "tavi", "--data-dir", directory], {
        io: printed.io,
      }),
    ).toBe(EXIT.ok);
    expect(printed.stderr()).toMatch(/warning: the credential key .* is kept in the OS keychain/);
    expect(printed.stderr()).toMatch(/system unit has no login session/);
    expect(printed.stderr()).toContain(`tavi credentials key --to-file --data-dir ${directory}`);
  });

  it("warns a lingering user unit, and a launchd unit, too", async () => {
    const directory = keychainKeyed();
    const user = capture();
    expect(await main(["service", "unit", "--kind", "systemd", "--scope", "user", "--data-dir", directory], { io: user.io })).toBe(EXIT.ok);
    expect(user.stderr()).toMatch(/enable-linger finds the keyring locked/);
    const launchd = capture();
    expect(await main(["service", "unit", "--kind", "launchd", "--data-dir", directory], { io: launchd.io })).toBe(EXIT.ok);
    expect(launchd.stderr()).toMatch(/LaunchDaemon/);
  });

  it("says nothing when the key is its own file, or there is none", async () => {
    const plain = directories.create("tavi-service-key-");
    writeFileSync(join(plain, "credentials.key"), `${"b".repeat(64)}\n`, { mode: 0o600 });
    for (const directory of [plain, directories.create("tavi-service-key-")]) {
      const printed = capture();
      expect(await main(["service", "unit", "--kind", "systemd", "--user", "tavi", "--data-dir", directory], { io: printed.io })).toBe(
        EXIT.ok,
      );
      expect(printed.stderr()).not.toContain("credentials key --to-file");
    }
  });
});

describe("the Windows logon task", () => {
  const TASK = {
    kind: "task",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    executablePath: "C:\\Users\\Ana\\AppData\\Roaming\\npm\\node_modules\\tavi\\dist\\executable.mjs",
    dataDirectory: "C:\\Users\\Ana\\AppData\\Local\\tavi",
    label: DEFAULT_SERVICE_LABEL,
    windowsUser: "PC\\Ana",
  } as const;

  it("starts at the account's logon, as it with least privilege, restarted after a failure, with no window", () => {
    const task = renderServiceUnit({ ...TASK, serveArgs: ["--api-key-file", "C:\\keys\\model key.txt"] });
    expect(task).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\Ana<\/UserId>/);
    expect(task).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(task).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(task).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(task).toMatch(/<RestartOnFailure>/);
    expect(task).toContain("<Command>C:\\Program Files\\nodejs\\node.exe</Command>");
    expect(task).toContain(
      `<Arguments>${TASK.executablePath} serve --data-dir ${TASK.dataDirectory} --api-key-file &quot;C:\\keys\\model key.txt&quot; --windowless</Arguments>`,
    );
    // The header's comment holds no "--", which would end it early, and says how to install and remove it.
    const comment = /<!--([\s\S]*?)-->/.exec(task)?.[1] ?? "";
    expect(comment).not.toContain("--");
    expect(installStepsOf(task)).toEqual([`schtasks /Create /TN "${DEFAULT_SERVICE_LABEL}" /XML "${DEFAULT_SERVICE_LABEL}.xml"`]);
    expect(serviceUnitFilename("task", DEFAULT_SERVICE_LABEL)).toBe(`${DEFAULT_SERVICE_LABEL}.xml`);
  });

  it("quotes each argument as Windows reads a command line back", () => {
    expect(windowsCommandLine(["a", "b c", "", 'say "hi"', "C:\\dir with space\\", 'tail\\"q'])).toBe(
      'a "b c" "" "say \\"hi\\"" "C:\\dir with space\\\\" "tail\\\\\\"q"',
    );
  });

  it("refuses a log directory, a label that would end its comment, and no account", () => {
    expect(() => renderServiceUnit({ ...TASK, logDirectory: "C:\\logs" })).toThrow(/tavi logs/);
    expect(() => renderServiceUnit({ ...TASK, label: "a--b" })).toThrow(/labelled/);
    const { windowsUser: _user, ...noUser } = TASK;
    expect(() => renderServiceUnit(noUser)).toThrow(/account/);
  });

  it("is written to --out as UTF-16, as schtasks reads it", async () => {
    const out = join(directories.create("tavi-service-"), "dev.tavi.serve.xml");
    const result = capture();
    const options = {
      action: "unit",
      kind: "task",
      label: DEFAULT_SERVICE_LABEL,
      nodePath: "/usr/local/bin/node",
      executablePath: "/opt/tavi/dist/executable.mjs",
      out,
      dataDirectory: "/tmp/x",
    } as const;
    expect(await serviceCommand(options, result.io, { windowsUser: "PC\\Ana" })).toBe(EXIT.ok);
    const bytes = readFileSync(out);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.toString("utf16le")).toContain("<UserId>PC\\Ana</UserId>");
  });

  // Never on Windows: there it would let go of the test runner's console and start an owner.
  it.runIf(process.platform !== "win32")("is for Windows: serve --windowless is refused elsewhere", async () => {
    const result = capture();
    expect(await main(["serve", "--windowless", "--data-dir", directories.create("tavi-service-")], { io: result.io })).toBe(EXIT.usage);
    expect(result.stderr()).toMatch(/Windows logon task/);
  });

  it("lets go of the console, starts the owner without --windowless, and starts it again after an error exit", async () => {
    const steps: string[] = [];
    const codes = [70, 70, 0];
    const exit = await runWindowless({
      argv: ["/x/executable.mjs", "serve", "--windowless", "--data-dir", "D"],
      detach: () => steps.push("detach"),
      pause: async (ms) => steps.push(`pause ${ms}`),
      start: (args) => {
        steps.push(args.join(" "));
        const code = codes.shift() ?? 0;
        return {
          once: (event: string, listener: (code: number | null) => void) => {
            if (event === "exit") setImmediate(() => listener(code));
          },
        };
      },
    });
    expect(exit).toBe(0);
    const started = "/x/executable.mjs serve --data-dir D";
    expect(steps).toEqual(["detach", started, `pause ${WINDOWLESS_RESTART_MS}`, started, `pause ${WINDOWLESS_RESTART_MS}`, started]);
    // A caller that says not to: the error is the task's.
    expect(
      await runWindowless({
        argv: [],
        detach: () => undefined,
        again: () => false,
        start: () => ({
          once: (event: string, listener: (code: number | null) => void) => {
            if (event === "exit") setImmediate(() => listener(4));
          },
        }),
      }),
    ).toBe(4);
  });

  it("does not start the owner again after a refusal, as serve's on Windows until the pipe is proven", async () => {
    for (const refused of WINDOWLESS_FINAL) {
      let starts = 0;
      const exit = await runWindowless({
        argv: [],
        detach: () => undefined,
        pause: async () => undefined,
        start: () => {
          starts += 1;
          return {
            once: (event: string, listener: (code: number | null) => void) => {
              if (event === "exit") setImmediate(() => listener(refused));
            },
          };
        },
      });
      expect([exit, starts]).toEqual([refused, 1]);
    }
    expect(WINDOWLESS_FINAL.has(EXIT.unavailable)).toBe(true);
  });
});
