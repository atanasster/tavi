import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

import type { SandboxPolicy, SandboxPort, SandboxRunResult } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canApplySeatbeltProfile } from "@tavi/test-support/sandbox";
import { createSandboxHost } from "../src/host.js";
import { createRuntimeSandbox } from "../src/runtime.js";

/**
 * The escape cases (E1–E21, and F-N1, F-N2 for what must still work) against
 * the real srt: on macOS always (Seatbelt), and on Linux when
 * the sandbox matrix names a case that confines (`TAVI_SANDBOX_MATRIX=srt` or
 * `nested`; bubblewrap). Each attempt must fail and leave the host unchanged.
 * Under `nested`, E3 and E10 are expected to fail by design (srt binds the
 * host `/proc`), so they are skipped there and the tier says so.
 */

const MODE = process.env["TAVI_SANDBOX_MATRIX"] ?? (process.platform === "darwin" && canApplySeatbeltProfile() ? "srt" : undefined);
const RUNS = MODE === "srt" || MODE === "nested";
const LINUX = process.platform === "linux";
const NESTED = MODE === "nested";

const SECRET = "TAVI-ESCAPE-SECRET";
/** What a run may write and where it starts: a host folder, so every `.git` is protected (HOST_FOLDER_PROTECTED). */
const PROTECTED = [
  ".git",
  ".git/hooks",
  ".git/config",
  ".git/commondir",
  ".git/info/attributes",
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".zshrc",
  ".profile",
  ".envrc",
  ".vscode",
  ".idea",
  ".claude/settings.json",
];

let root = "";
let home = "";
let data = "";
let work = "";
let ownerTemporary = "";
let staging = "";
let sandbox: SandboxPort;

const policy = (): SandboxPolicy => ({
  filesystem: {
    allowRead: [work],
    allowWrite: [work],
    denyRead: [home, data, tmpdir()],
    protectedNames: [{ root: work, names: PROTECTED, rootNames: ["HEAD"] }],
  },
  network: { allow: false },
  resources: { timeoutMs: 30_000, maxOutputBytes: 65_536 },
});

/** One shell line in the sandbox, in the working folder, from an environment of its own. */
async function sh(line: string, options: { readonly inheritEnv?: boolean } = {}): Promise<SandboxRunResult> {
  return await sandbox.run(policy(), {
    command: "/bin/sh",
    // The marker proves the sandbox started: a case passes because the attempt was refused, never because nothing ran.
    args: ["-c", `echo ${RAN}; ${line}`],
    cwd: work,
    // A home inside the folder, as a chat's `.home/`: the protected names at the root are placeholders git or a shell would fail to read.
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: join(work, ".home"), TMPDIR: join(work, ".tmp"), LANG: "C" },
    ...(options.inheritEnv === true ? {} : { inheritEnv: false }),
    denyEnv: ["OPENAI_API_KEY"],
  });
}

const RAN = "TAVI-ESCAPE-RAN";
/** The sandbox ran the line, and the line's last command failed. */
const refused = (result: SandboxRunResult): boolean => result.stdout.includes(RAN) && result.exitCode !== 0;
/** Refused, and nothing secret came out. */
const failed = (result: SandboxRunResult): boolean => refused(result) && !result.stdout.includes(SECRET);
const have = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
/** A Node script as one shell word, free of the shell's quoting. */
const nodeLine = (code: string): string => `node -e "eval(Buffer.from('${Buffer.from(code).toString("base64")}','base64').toString())"`;
/** A Python script as one shell word (`-I`: nothing from the working folder is imported). */
const pythonLine = (code: string): string =>
  `python3 -I -c "exec(__import__('base64').b64decode('${Buffer.from(code).toString("base64")}'))"`;
/** Prints `reached` and exits 0 when `attempt` (a promise of true for a way out) found one; exits 3 otherwise. */
const reaches = (attempt: string): string =>
  nodeLine(
    `(${attempt})().then((out) => { console.log(out ? "reached" : "refused"); process.exit(out ? 0 : 3); }, () => process.exit(3));`,
  );

describe.skipIf(!RUNS)(`escape cases (${MODE ?? "skipped"}, ${process.platform})`, () => {
  const temp = temporaryDirectories();
  beforeAll(async () => {
    root = temp.create("tavi-escape-");
    home = join(root, "home");
    data = join(root, "data");
    work = join(root, "work");
    for (const directory of [
      join(home, ".ssh"),
      data,
      join(work, ".tmp"),
      join(work, ".home"),
      join(work, "parent"),
      join(work, ".git", "hooks"),
      join(work, "sub", "repo"),
    ])
      mkdirSync(directory, { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), `${SECRET}-ssh\n`);
    writeFileSync(join(data, "tavi.sqlite"), `${SECRET}-db\n`);
    mkdirSync(join(data, "credentials"), { recursive: true });
    writeFileSync(join(data, "credentials", "openai.json"), `${SECRET}-credentials\n`);
    mkdirSync(join(data, "chats", "ws", "other-chat"), { recursive: true });
    writeFileSync(join(data, "chats", "ws", "other-chat", "notes.md"), `${SECRET}-other-chat\n`);
    writeFileSync(join(work, ".git", "config"), "[core]\n");
    writeFileSync(join(work, ".git", "HEAD"), "ref: refs/heads/main\n");
    symlinkSync(join(home, ".ssh", "id_ed25519"), join(work, "planted-link"));
    // A repository planted before the run, and a worktree whose .git is a gitfile.
    execFileSync("git", ["init", "-q", join(work, "sub", "repo")]);
    execFileSync("git", ["init", "-q", join(work, "parent", "repo")]);
    execFileSync("git", ["init", "-q", join(work, "main")]);
    execFileSync("git", [
      "-C",
      join(work, "main"),
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    ]);
    execFileSync("git", ["-C", join(work, "main"), "worktree", "add", "-q", join(work, "wt")]);
    ownerTemporary = join(tmpdir(), `tavi-escape-owner-${String(process.pid)}.txt`);
    writeFileSync(ownerTemporary, `${SECRET}-tmp\n`);
    staging = temp.create("tavi-escape-staging-");
    sandbox = createRuntimeSandbox({
      host: createSandboxHost({ dataDirectory: data, ...(NESTED ? { nested: true } : {}) }),
      ...(NESTED ? { nested: true } : {}),
    });
  }, 60_000);

  afterAll(async () => {
    await sandbox.close?.();
    temp.cleanup();
    rmSync(ownerTemporary, { force: true });
  });

  it("runs at the expected tier", async () => {
    const result = await sh("true");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.tier).toBe(NESTED ? "nested" : "full");
  }, 60_000);

  it("E1, E2: never reads the person's keys, Tavi's database or credentials, or another chat's folder, directly or through a planted link", async () => {
    const other = join(data, "chats", "ws", "other-chat");
    for (const line of [
      `cat ${join(home, ".ssh", "id_ed25519")}`,
      `cat ${join(data, "tavi.sqlite")}`,
      `cat ${join(data, "credentials", "openai.json")}`,
      `cat ${join(other, "notes.md")}`,
      `ls ${other} | grep notes`,
      "cat planted-link",
    ]) {
      expect(failed(await sh(line)), line).toBe(true);
    }
  }, 60_000);

  it.skipIf(!LINUX || NESTED)(
    "E3: sees neither the owner's /proc, its memory, nor the host's root through it or pid 1's",
    async () => {
      const key = join(home, ".ssh", "id_ed25519");
      for (const line of [
        `cat /proc/${String(process.pid)}/environ`,
        `cat /proc/${String(process.pid)}/root${key}`,
        `cat /proc/1/root${key}`,
        `head -c 64 /proc/${String(process.pid)}/mem`,
      ]) {
        expect(failed(await sh(line)), line).toBe(true);
      }
    },
    60_000,
  );

  it("E4: cannot hard-link a denied file in, nor write a protected one through a link of it", async () => {
    expect(failed(await sh(`ln ${join(data, "tavi.sqlite")} hard-link && cat hard-link`))).toBe(true);
    expect(existsSync(join(work, "hard-link"))).toBe(false);
    // A protected file it can see: a second name must not make it writable.
    expect(refused(await sh("ln .git/config config-link && echo '[alias]' >> config-link"))).toBe(true);
    expect(readFileSync(join(work, ".git", "config"), "utf8")).toBe("[core]\n");
  }, 60_000);

  it("E5: writes no hook, config, profile or editor setting, at the root or in a planted repository, and leaves no placeholder", async () => {
    const targets = [
      ".git/hooks/pre-commit",
      ".git/config",
      ".git/info/attributes",
      "sub/repo/.git/hooks/x",
      ".bashrc",
      ".vscode/settings.json",
      ".envrc",
      "HEAD",
      ".claude/settings.json",
    ];
    for (const target of targets) {
      const result = await sh(`mkdir -p "$(dirname ${target})" 2>/dev/null; echo pwned > ${target}`);
      expect(refused(result), `${target}: ${result.stderr}`).toBe(true);
    }
    expect(readFileSync(join(work, ".git", "config"), "utf8")).toBe("[core]\n");
    expect(existsSync(join(work, ".git", "hooks", "pre-commit"))).toBe(false);
    // Nothing bubblewrap mounted over an absent name is left on the host once the run is over.
    for (const absent of [".bashrc", ".envrc", "HEAD", ".vscode", ".idea", ".zshrc"])
      expect(existsSync(join(work, absent)), absent).toBe(false);
  }, 120_000);

  it("E6: cannot move a protected folder, or its parent, away and plant hooks in its place", async () => {
    expect((await sh("mv .git .git-moved; rm -rf sub/repo/.git")).stdout).toContain(RAN);
    expect(existsSync(join(work, ".git", "config"))).toBe(true);
    expect(existsSync(join(work, "sub", "repo", ".git", "HEAD"))).toBe(true);
    // The parent moved, where that is allowed at all (bubblewrap pins it on Linux): the repository it carried keeps its protection.
    const moved = await sh("mv parent parent-moved && echo moved; echo pwned > parent-moved/repo/.git/hooks/post-commit");
    if (moved.stdout.includes("moved")) expect(existsSync(join(work, "parent-moved", "repo", ".git", "hooks", "post-commit"))).toBe(false);
    else expect(existsSync(join(work, "parent", "repo", ".git", "HEAD"))).toBe(true);
    // A .git made in a new folder during the run is a known residual on Linux (literals cover what existed); it is not asserted here.
  }, 60_000);

  it("E7: reaches no network: TCP, UDP DNS, the metadata address, IPv6", async () => {
    const result = await sh(
      `node -e "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:3000});s.on('connect',()=>{console.log('connected');process.exit(0)});s.on('error',()=>process.exit(3));s.on('timeout',()=>process.exit(4))"`,
    );
    expect(result.stdout).not.toContain("connected");
    expect(refused(result), result.stderr).toBe(true);
    const tcp = (host: string, port: number): string =>
      `() => new Promise((resolve) => { const s = require("net").connect({ host: ${JSON.stringify(host)}, port: ${String(port)}, timeout: 3000 }); s.on("connect", () => resolve(true)); s.on("error", () => resolve(false)); s.on("timeout", () => resolve(false)); })`;
    // A DNS query for example.com straight to 8.8.8.8: any answer is a way out.
    const udp = `() => new Promise((resolve) => { let s; try { s = require("dgram").createSocket("udp4"); } catch { resolve(false); return; } const t = setTimeout(() => resolve(false), 3000); s.on("message", () => { clearTimeout(t); resolve(true); }); s.on("error", () => { clearTimeout(t); resolve(false); }); s.send(Buffer.from("abcd01000001000000000000076578616d706c6503636f6d0000010001", "hex"), 53, "8.8.8.8"); })`;
    for (const [name, attempt] of [
      ["UDP DNS to 8.8.8.8", udp],
      ["the metadata address", tcp("169.254.169.254", 80)],
      ["IPv6", tcp("2606:4700:4700::1111", 443)],
    ] as const) {
      const other = await sh(reaches(attempt));
      expect(other.stdout, name).not.toContain("reached");
      expect(refused(other), `${name}: ${other.stderr}`).toBe(true);
    }
  }, 60_000);

  it.skipIf(!LINUX)(
    "E8: cannot create a unix socket",
    async () => {
      const result = await sh(
        `node -e "require('net').createServer().on('error',()=>process.exit(3)).listen('e8.sock',()=>{console.log('listening');process.exit(0)})"`,
      );
      expect(result.stdout).not.toContain("listening");
      expect(refused(result), result.stderr).toBe(true);
    },
    60_000,
  );

  it("E8: cannot connect to the system bus, Docker, or the owner's socket", async () => {
    // An owner socket listening in the folder the sandbox may write: the strongest place, since nothing hides it there.
    const owner = createServer((socket) => socket.end("owner\n"));
    const ownerSocket = join(work, "owner.sock");
    await new Promise<void>((resolve) => owner.listen(ownerSocket, resolve));
    try {
      for (const path of ["/run/dbus/system_bus_socket", "/var/run/docker.sock", ownerSocket]) {
        const connect = await sh(
          reaches(
            `() => new Promise((resolve) => { const s = require("net").connect(${JSON.stringify(path)}); s.on("connect", () => resolve(true)); s.on("error", () => resolve(false)); })`,
          ),
        );
        expect(connect.stdout, path).not.toContain("reached");
        expect(refused(connect), `${path}: ${connect.stderr}`).toBe(true);
      }
    } finally {
      await new Promise((resolve) => owner.close(resolve));
    }
  }, 60_000);

  it.skipIf(!LINUX || !have("python3"))(
    "E8: io_uring_setup is refused",
    async () => {
      // io_uring_setup is syscall 425 on x86_64 and arm64 alike; a descriptor back means the ring opened.
      const result = await sh(
        pythonLine(
          "import ctypes, sys\nlibc = ctypes.CDLL(None, use_errno=True)\nfd = libc.syscall(425, 1, ctypes.create_string_buffer(120))\nprint('opened' if fd >= 0 else 'errno %d' % ctypes.get_errno())\nsys.exit(0 if fd >= 0 else 3)",
        ),
      );
      expect(result.stdout, result.stderr).not.toContain("opened");
      expect(refused(result)).toBe(true);
    },
    60_000,
  );

  it.skipIf(!LINUX || NESTED)(
    "E10: cannot signal or trace the owner",
    async () => {
      expect(refused(await sh(`kill -0 ${String(process.pid)}`))).toBe(true);
      if (have("python3")) {
        // PTRACE_ATTACH (16): the owner is not in the sandbox's PID namespace.
        const traced = await sh(
          pythonLine(
            `import ctypes, sys\nlibc = ctypes.CDLL(None, use_errno=True)\nr = libc.ptrace(16, ${String(process.pid)}, None, None)\nprint('attached' if r == 0 else 'errno %d' % ctypes.get_errno())\nsys.exit(0 if r == 0 else 3)`,
          ),
        );
        expect(traced.stdout, traced.stderr).not.toContain("attached");
        expect(refused(traced)).toBe(true);
      }
    },
    60_000,
  );

  it("E11: never sees a TAVI_* variable the owner has, from the environment the owner builds", async () => {
    process.env["TAVI_ESCAPE_TOKEN"] = `${SECRET}-tavi`;
    try {
      const result = await sh('echo "tavi=${TAVI_ESCAPE_TOKEN:-unset}"');
      expect(result.stdout, result.stderr).toContain("tavi=unset");
    } finally {
      delete process.env["TAVI_ESCAPE_TOKEN"];
    }
  }, 60_000);

  it("E11: never sees a provider key the owner has, even inheriting the environment", async () => {
    const previous = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = `${SECRET}-key`;
    try {
      const result = await sh('echo "key=${OPENAI_API_KEY:-unset}"', { inheritEnv: true });
      expect(result.stdout, result.stderr).toContain("key=unset");
    } finally {
      if (previous === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = previous;
    }
  }, 60_000);

  it.skipIf(!LINUX || !have("setsid"))(
    "E12: leaves nothing running after the run",
    async () => {
      const marker = `tavi-e12-${String(process.pid)}`;
      // `; :` keeps the shell, and so the marker in its argv, alive: bash would exec a lone command.
      expect((await sh(`setsid sh -c 'sleep 600; :' ${marker} >/dev/null 2>&1 & echo started`)).stdout).toContain("started");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(spawnSync("pgrep", ["-f", marker]).status).not.toBe(0);
    },
    60_000,
  );

  it.skipIf(LINUX || !have("python3"))(
    "E12 (macOS): leaves nothing running after the run, even a process that forked away into a session of its own",
    async () => {
      const marker = `tavi-e12-mac-${String(process.pid)}`;
      // Fork, let the parent exit, start a new session: the group the run's ladder signals no longer holds it.
      const daemon = `python3 -c "import os,time; os.fork() and os._exit(0); os.setsid(); os.fork() and os._exit(0); time.sleep(600)" ${marker} >/dev/null 2>&1 & echo started`;
      expect((await sh(daemon)).stdout).toContain("started");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(spawnSync("pgrep", ["-f", marker]).status).not.toBe(0);
    },
    60_000,
  );

  it.skipIf(LINUX)(
    "E12 (macOS): leaves nothing running after the run, even an Apple binary that forked away with its environment cleared",
    async () => {
      const marker = `tavi-e12-perl-${String(process.pid)}`;
      // macOS shows no environment for its own binaries, and `env -i` drops the run's tag: the marker descriptor finds it.
      const daemon = `env -i /usr/bin/perl -MPOSIX -e 'fork and exit; setsid; fork and exit; sleep 600' ${marker} >/dev/null 2>&1 & echo started`;
      expect((await sh(daemon)).stdout).toContain("started");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(spawnSync("pgrep", ["-f", marker]).status).not.toBe(0);
    },
    60_000,
  );

  it("E13: keeps nothing in /tmp between runs", async () => {
    const name = `/tmp/tavi-e13-${String(process.pid)}`;
    expect((await sh(`echo kept > ${name}`)).stdout).toContain(RAN);
    const read = await sh(`cat ${name}`);
    expect(read.stdout).toContain(RAN);
    expect(read.stdout).not.toContain("kept");
    expect(existsSync(name)).toBe(false);
  }, 60_000);

  it.skipIf(!LINUX)(
    "E14: cannot mount or chroot; a nested user namespace stays inside the sandbox",
    async () => {
      for (const line of ["mkdir -p m && mount -t tmpfs none m", "chroot / true"]) expect(refused(await sh(line)), line).toBe(true);
      // srt 0.0.79 leaves user namespaces open inside (kernel attack surface): one is made…
      expect((await sh("unshare -r id -u")).stdout).toBe(`${RAN}\n0\n`);
      // …and gains nothing the sandbox denies.
      for (const line of [`unshare -r cat ${join(home, ".ssh", "id_ed25519")}`, "unshare -r sh -c 'mount -t tmpfs none /mnt'"])
        expect(failed(await sh(line)), line).toBe(true);
    },
    60_000,
  );

  it("E15: cannot read an owner spool made while it runs", async () => {
    const spool = join(staging, "spool.bin");
    const pending = sh(`sleep 1; cat ${spool}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(spool, `${SECRET}-spool\n`);
    expect(failed(await pending)).toBe(true);
  }, 60_000);

  it("E16: cannot read an owner file in the temporary directory", async () => {
    expect(failed(await sh(`cat ${ownerTemporary}`))).toBe(true);
  }, 60_000);

  it.skipIf(!LINUX || !have("python3"))(
    "E17: AF_PACKET and AF_VSOCK sockets are refused under the unit, and logged outside it",
    async () => {
      // AF_PACKET (17) raw, AF_VSOCK (40) stream.
      for (const [name, family, type] of [
        ["AF_PACKET", 17, 3],
        ["AF_VSOCK", 40, 1],
      ] as const) {
        const result = await sh(
          pythonLine(
            `import socket\ntry:\n socket.socket(${String(family)}, ${String(type)}, 0); print('open')\nexcept OSError: print('closed')`,
          ),
        );
        expect(result.stdout, result.stderr).toContain(RAN);
        console.info(
          `E17: ${name} ${result.stdout.includes("open") ? "open" : "closed"} (${process.env["TAVI_UNDER_UNIT"] === "1" ? "under the unit" : "no unit"})`,
        );
        if (process.env["TAVI_UNDER_UNIT"] === "1") expect(result.stdout, name).toContain("closed");
      }
    },
    60_000,
  );

  it.skipIf(!LINUX || !have("python3"))(
    "E17: an AF_ALG socket is refused under the unit, and reported outside it",
    async () => {
      const result = await sh(
        `python3 -I -c "import socket\ntry:\n socket.socket(38, 5, 0); print('open')\nexcept OSError: print('closed')"`,
      );
      expect(result.stdout, result.stderr).toContain(RAN);
      console.info(
        `E17: AF_ALG ${result.stdout.includes("open") ? "open" : "closed"} (${process.env["TAVI_UNDER_UNIT"] === "1" ? "under the unit" : "no unit"})`,
      );
      // Under the generated unit it must be refused; outside it, an open family is reported as a warning naming CVE-2026-31431.
      if (process.env["TAVI_UNDER_UNIT"] === "1") expect(result.stdout).toContain("closed");
      else if (result.stdout.includes("open")) {
        const checks = sandbox.capabilities().checks ?? [];
        expect(checks.some((check) => /AF_ALG|socket families/.test(check.name) && check.severity === "warning")).toBe(true);
      } else {
        expect(result.stdout).toContain("closed");
      }
    },
    60_000,
  );

  it("E19: cannot repoint a worktree's gitfile or write its gitdir's hooks and config", async () => {
    const before = readFileSync(join(work, "wt", ".git"), "utf8");
    const gitdir = /gitdir:\s*(.+)/.exec(before)?.[1]?.trim() ?? "";
    for (const line of [
      "echo 'gitdir: ../evil' > wt/.git",
      `mkdir -p ${gitdir}/hooks; echo pwned > ${gitdir}/hooks/post-checkout`,
      `echo '[core]' > ${gitdir}/config.worktree`,
      "echo pwned > main/.git/hooks/pre-commit",
      "echo '[core]' >> main/.git/config",
    ]) {
      expect(refused(await sh(line)), line).toBe(true);
    }
    expect(readFileSync(join(work, "wt", ".git"), "utf8")).toBe(before);
    expect(existsSync(join(gitdir, "hooks", "post-checkout"))).toBe(false);
  }, 120_000);

  it("E21: cannot replace a symlinked .git with a real one; Linux refuses the folder, which bubblewrap cannot protect", async () => {
    // A folder of its own: on Linux the link refuses every run in it. On macOS the link cannot be removed;
    // a write through it into its gitdir is the next case's.
    const linked = join(root, "linked");
    mkdirSync(join(linked, "gitdirs"), { recursive: true });
    mkdirSync(join(linked, "repo"));
    execFileSync("git", ["init", "-q", "--separate-git-dir", join(linked, "gitdirs", "one"), join(linked, "repo")]);
    rmSync(join(linked, "repo", ".git"));
    symlinkSync(join(linked, "gitdirs", "one"), join(linked, "repo", ".git"));
    const run = sandbox.run(
      {
        ...policy(),
        filesystem: {
          ...policy().filesystem,
          allowRead: [linked],
          allowWrite: [linked],
          protectedNames: [{ root: linked, names: PROTECTED, rootNames: ["HEAD"] }],
        },
      },
      {
        command: "/bin/sh",
        args: ["-c", `echo ${RAN}; rm repo/.git && mkdir -p repo/.git/hooks && echo pwned > repo/.git/hooks/post-checkout`],
        cwd: linked,
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: linked, LANG: "C" },
        inheritEnv: false,
      },
    );
    if (LINUX) {
      await expect(run).rejects.toMatchObject({
        code: "UNAVAILABLE",
        details: { reason: "protected-symlink", path: join(linked, "repo", ".git") },
      });
    } else {
      expect(refused(await run)).toBe(true);
    }
    expect(lstatSync(join(linked, "repo", ".git")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(linked, "gitdirs", "one", "hooks", "post-checkout"))).toBe(false);
  }, 60_000);

  it("E21: cannot write through a symlinked .git or a gitfile into a gitdir not named .git", async () => {
    // Seatbelt matches the resolved path, which names no .git: the compiler denies the gitdir's own entries.
    const through = join(root, "through");
    mkdirSync(join(through, "gitdirs"), { recursive: true });
    mkdirSync(join(through, "linked"));
    execFileSync("git", ["init", "-q", "--separate-git-dir", join(through, "gitdirs", "one"), join(through, "linked")]);
    rmSync(join(through, "linked", ".git"));
    symlinkSync(join(through, "gitdirs", "one"), join(through, "linked", ".git"));
    // A gitfile repository: `.git` is a file naming its gitdir.
    execFileSync("git", ["init", "-q", "--separate-git-dir", join(through, "gitdirs", "two"), join(through, "filed")]);
    const run = (line: string) =>
      sandbox.run(
        {
          ...policy(),
          filesystem: {
            ...policy().filesystem,
            allowRead: [through],
            allowWrite: [through],
            protectedNames: [{ root: through, names: PROTECTED, rootNames: ["HEAD"] }],
          },
        },
        {
          command: "/bin/sh",
          args: ["-c", `echo ${RAN}; ${line}`],
          cwd: through,
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: through, LANG: "C" },
          inheritEnv: false,
        },
      );
    const gitfileLines = [
      "mkdir -p gitdirs/two/hooks; echo pwned > gitdirs/two/hooks/post-checkout",
      "echo '[core]' >> gitdirs/two/config",
      "echo '[core]' > gitdirs/two/config.worktree",
      "echo pwned > gitdirs/two/HOOKS/pre-push",
    ];
    if (LINUX) {
      // Linux refuses the folder holding the link before srt runs (E21 above); the gitfile's gitdir is anchored literally.
      await expect(run("true")).rejects.toMatchObject({ code: "UNAVAILABLE", details: { reason: "protected-symlink" } });
      return;
    }
    for (const line of [
      "mkdir -p linked/.git/hooks; echo pwned > linked/.git/hooks/post-checkout",
      "echo '[core]' >> linked/.git/config",
      "mkdir -p gitdirs/one/hooks; echo pwned > gitdirs/one/hooks/post-checkout",
      ...gitfileLines,
    ]) {
      expect(refused(await run(line)), line).toBe(true);
    }
    expect(existsSync(join(through, "gitdirs", "one", "hooks", "post-checkout"))).toBe(false);
    expect(existsSync(join(through, "gitdirs", "two", "hooks", "post-checkout"))).toBe(false);
    expect(existsSync(join(through, "gitdirs", "two", "hooks", "pre-push"))).toBe(false);
    expect(readFileSync(join(through, "gitdirs", "one", "config"), "utf8")).not.toContain("[core]\n[core]");
  }, 120_000);

  it.skipIf(!LINUX)(
    "E20: cannot write its own or any cgroup's limits from inside",
    async () => {
      const own = (await sh("sed -n 's/^0:://p' /proc/self/cgroup")).stdout.split("\n")[1]?.trim() ?? "/";
      for (const target of [
        `/sys/fs/cgroup${own}/cgroup.procs`,
        `/sys/fs/cgroup${own}/memory.max`,
        "/sys/fs/cgroup/cgroup.subtree_control",
      ]) {
        expect(refused(await sh(`echo max > ${target}`)), target).toBe(true);
      }
    },
    60_000,
  );

  it("F-N1: Node does file, timer and child I/O inside; python, git status and pipelines run", async () => {
    const node = await sh(
      `node -e "const fs=require('fs');fs.writeFileSync('fn1.txt','ok');setTimeout(()=>{const r=require('child_process').spawnSync(process.execPath,['-e','process.stdout.write(require(\\'fs\\').readFileSync(\\'fn1.txt\\',\\'utf8\\'))']);console.log('node:'+r.stdout)},20)"`,
    );
    expect(node.stdout, node.stderr).toContain("node:ok");
    expect((await sh("echo abc | tr b x")).stdout).toBe(`${RAN}\naxc\n`);
    expect((await sh("git -C sub/repo status --short; echo git:$?")).stdout).toContain("git:0");
    if (have("python3")) expect((await sh("python3 -c 'print(6*7)'")).stdout).toBe(`${RAN}\n42\n`);
  }, 60_000);

  it.skipIf(!LINUX)(
    "F-N2: holds no descriptor beyond its stdio",
    async () => {
      // `ls` lists its own: 0-2 (Node's stdio pipes, socketpairs on Linux, which carry bytes only) and the directory it reads.
      const result = await sh("ls -l /proc/self/fd");
      const descriptors = result.stdout.split("\n").flatMap((line) => {
        const match = /\s(\d+)\s->\s(.+)$/.exec(line);
        return match === null ? [] : [{ fd: Number(match[1]), target: match[2] ?? "" }];
      });
      expect(descriptors.filter((entry) => entry.fd <= 2)).toHaveLength(3);
      expect(descriptors.filter((entry) => entry.fd > 2 && !entry.target.startsWith("/proc/"))).toEqual([]);
    },
    60_000,
  );

  it("keeps the folders it planted", () => {
    expect(readdirSync(work).sort()).toEqual(expect.arrayContaining([".git", "main", "sub", "wt"]));
  });
});
